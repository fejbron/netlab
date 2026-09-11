/**
 * The web side of a Linux host: an nginx configuration parser and validator
 * (virtual hosts, static files, redirects, reverse proxy, upstreams with
 * round-robin and failover, TLS listeners), the demo application server, and
 * self-signed certificates for openssl.
 */
import { forward, type NetworkState } from '../network';
import { baseName, getNode, listDir, normalizePath, parentPath, readFile, resolveLink, type LinuxState, type ServerRuntime } from './fs';
import { apacheModelFromSnapshot, loadApache, proxyHandlerMissing } from './apache';

export interface WebRequestRecord {
  scheme: 'http' | 'https';
  host: string;
  path: string;
  status: number;
  /** server_name of the block that answered (nginx) or "app" for the demo application. */
  server?: string;
  /** Host id of the backend a proxied request was sent to. */
  backend?: string;
}

export interface HttpRequest {
  scheme: 'http' | 'https';
  /** Host header (name or IP, without port). */
  host: string;
  port: number;
  path: string;
  method: string;
  clientIp?: string;
  /** Check reachability of the listener only: nothing is recorded and no backend is chosen. */
  probe?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export type HttpError = { error: 'refused' } | { error: 'tls-to-plain' } | { error: 'unreachable' };

const STATUS: Record<number, string> = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
const NGINX_VERSION = 'nginx/1.24.0 (Ubuntu)';

function errorPage(status: number): string {
  const text = `${status} ${STATUS[status] ?? ''}`.trim();
  return `<html>\r\n<head><title>${text}</title></head>\r\n<body>\r\n<center><h1>${text}</h1></center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>\r\n`;
}

// ---------------------------------------------------------------------------
// configuration parsing

export interface Directive {
  name: string;
  args: string[];
  block?: Directive[];
  file: string;
  line: number;
}

export class ConfigError extends Error {}

function tokenizeConf(text: string, file: string): Array<{ t: string; line: number }> {
  const toks: Array<{ t: string; line: number }> = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '{' || c === '}' || c === ';') {
      toks.push({ t: c, line });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new ConfigError(`unexpected end of file, expecting ${c === '"' ? '"' : "'"} in ${file}:${line}`);
      toks.push({ t: text.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    let w = '';
    while (i < text.length && !/[\s{};#]/.test(text[i])) w += text[i++];
    toks.push({ t: w, line });
  }
  return toks;
}

function parseConf(text: string, file: string): Directive[] {
  const toks = tokenizeConf(text, file);
  let i = 0;
  const parseBlock = (depth: number): Directive[] => {
    const out: Directive[] = [];
    while (i < toks.length) {
      const tok = toks[i];
      if (tok.t === '}') {
        if (depth === 0) throw new ConfigError(`unexpected "}" in ${file}:${tok.line}`);
        i++;
        return out;
      }
      if (tok.t === '{' || tok.t === ';') throw new ConfigError(`unexpected "${tok.t}" in ${file}:${tok.line}`);
      const name = tok.t;
      const line = tok.line;
      i++;
      const args: string[] = [];
      while (i < toks.length && toks[i].t !== ';' && toks[i].t !== '{' && toks[i].t !== '}') args.push(toks[i++].t);
      if (i >= toks.length) throw new ConfigError(`unexpected end of file, expecting ";" or "}" in ${file}:${toks[toks.length - 1]?.line ?? line}`);
      if (toks[i].t === '}') throw new ConfigError(`directive "${name}" is not terminated by ";" in ${file}:${toks[i].line}`);
      if (toks[i].t === '{') {
        i++;
        const block = parseBlock(depth + 1);
        out.push({ name, args, block, file, line });
        continue;
      }
      i++; // ;
      out.push({ name, args, file, line });
    }
    if (depth > 0) throw new ConfigError(`unexpected end of file, expecting "}" in ${file}:${toks[toks.length - 1]?.line ?? 1}`);
    return out;
  };
  return parseBlock(0);
}

const KNOWN_DIRECTIVES = new Set(['user', 'worker_processes', 'pid', 'events', 'worker_connections', 'http', 'include', 'default_type', 'sendfile', 'tcp_nopush', 'keepalive_timeout', 'gzip', 'types_hash_max_size', 'server_tokens', 'access_log', 'error_log', 'log_format', 'server', 'listen', 'server_name', 'root', 'index', 'location', 'return', 'proxy_pass', 'proxy_set_header', 'proxy_http_version', 'proxy_read_timeout', 'proxy_connect_timeout', 'proxy_next_upstream', 'upstream', 'least_conn', 'ip_hash', 'hash', 'keepalive', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols', 'ssl_ciphers', 'ssl_prefer_server_ciphers', 'ssl_session_cache', 'ssl_session_timeout', 'add_header', 'try_files', 'alias', 'error_page', 'client_max_body_size', 'charset', 'expires', 'autoindex', 'allow', 'deny', 'rewrite', 'types', 'map', 'limit_req_zone', 'limit_req', 'gzip_types', 'ssl_stapling', 'resolver', 'proxy_cache_path', 'proxy_cache']);

/** Every file that would be read when nginx starts, in include order. */
function configFiles(state: LinuxState): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const visit = (path: string, depth: number) => {
    if (depth > 6) return;
    const r = readFile({ ...state, user: 'root' }, path, 'nginx');
    if ('error' in r) throw new ConfigError(`open() "${path}" failed (2: No such file or directory)`);
    out.push({ path, text: r.content });
    // resolve includes (nginx does them at parse time; we do a textual pre-pass)
    let ds: Directive[];
    try {
      ds = parseConf(r.content, path);
    } catch {
      return; // syntax errors surface in the real parse below
    }
    const walk = (list: Directive[]) => {
      for (const d of list) {
        if (d.name === 'include') for (const p of expandInclude(state, d.args[0] ?? '')) visit(p, depth + 1);
        if (d.block) walk(d.block);
      }
    };
    walk(ds);
  };
  visit('/etc/nginx/nginx.conf', 0);
  return out;
}

function expandInclude(state: LinuxState, pattern: string): string[] {
  const abs = normalizePath('/etc/nginx', pattern);
  if (!/[*?]/.test(abs)) return getNode(state, abs) ? [abs] : abs.endsWith('mime.types') ? [] : [];
  const dir = parentPath(abs);
  const re = new RegExp('^' + baseName(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return listDir(state, dir)
    .filter((n) => re.test(n))
    .map((n) => normalizePath(dir, n))
    .filter((p) => getNode(state, p)?.type === 'file')
    .sort();
}

/** Parse and merge the whole configuration; throws ConfigError. */
function parseAll(state: LinuxState): Directive[] {
  const files = configFiles(state);
  const merged: Directive[] = [];
  const inline = (list: Directive[]): Directive[] =>
    list.flatMap((d) => {
      if (d.name === 'include') return expandInclude(state, d.args[0] ?? '').flatMap((p) => inline(parseConf(files.find((f) => f.path === p)?.text ?? '', p)));
      return [d.block ? { ...d, block: inline(d.block) } : d];
    });
  for (const f of files.slice(0, 1)) merged.push(...inline(parseConf(f.text, f.path)));
  return merged;
}

interface Listen {
  port: number;
  ssl: boolean;
  defaultServer: boolean;
}

export interface Location {
  modifier: '' | '=' | '~' | '^~';
  path: string;
  directives: Directive[];
}

export interface ServerBlock {
  listens: Listen[];
  names: string[];
  root?: string;
  index: string[];
  ret?: { code: number; url?: string };
  locations: Location[];
  headers: Array<[string, string]>;
  ssl?: { cert: string; key: string };
  directives: Directive[];
  file: string;
  line: number;
}

export interface UpstreamServer {
  host: string;
  port: number;
  weight: number;
  backup: boolean;
  down: boolean;
}

export interface Upstream {
  name: string;
  servers: UpstreamServer[];
  method: 'round_robin' | 'least_conn' | 'ip_hash';
}

export interface NginxModel {
  servers: ServerBlock[];
  upstreams: Record<string, Upstream>;
}

function hostPort(text: string, defaultPort: number): { host: string; port: number } {
  const m = text.match(/^(.*?)(?::(\d+))?$/)!;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

function buildModel(state: LinuxState, conf: Directive[]): { model: NginxModel; errors: string[] } {
  const errors: string[] = [];
  const model: NginxModel = { servers: [], upstreams: {} };
  const OPAQUE = new Set(['types', 'map']);
  const checkKnown = (list: Directive[]) => {
    for (const d of list) {
      if (!KNOWN_DIRECTIVES.has(d.name)) errors.push(`unknown directive "${d.name}" in ${d.file}:${d.line}`);
      if (d.block && !OPAQUE.has(d.name)) checkKnown(d.block);
    }
  };
  checkKnown(conf);
  const ARGS: Record<string, [number, number]> = { root: [1, 1], alias: [1, 1], server_name: [1, 99], listen: [1, 9], proxy_pass: [1, 1], ssl_certificate: [1, 1], ssl_certificate_key: [1, 1], index: [1, 99], return: [1, 2], add_header: [2, 3], upstream: [1, 1], proxy_set_header: [2, 2], try_files: [2, 99], user: [1, 2], worker_processes: [1, 1], include: [1, 1] };
  const checkArgs = (list: Directive[]) => {
    for (const d of list) {
      const range = ARGS[d.name];
      if (range && (d.args.length < range[0] || d.args.length > range[1])) errors.push(`invalid number of arguments in "${d.name}" directive in ${d.file}:${d.line}`);
      if (d.block && !OPAQUE.has(d.name)) checkArgs(d.block);
    }
  };
  checkArgs(conf);
  if (errors.length) return { model, errors };
  const http = conf.find((d) => d.name === 'http')?.block ?? [];
  for (const d of http) {
    if (d.name === 'upstream') {
      const name = d.args[0];
      const up: Upstream = { name, servers: [], method: 'round_robin' };
      for (const s of d.block ?? []) {
        if (s.name === 'server') {
          const { host, port } = hostPort(s.args[0] ?? '', 80);
          const server: UpstreamServer = { host, port, weight: 1, backup: false, down: false };
          for (const a of s.args.slice(1)) {
            if (a.startsWith('weight=')) server.weight = Math.max(1, Number(a.slice(7)) || 1);
            else if (a === 'backup') server.backup = true;
            else if (a === 'down') server.down = true;
            else if (!/^(max_fails|fail_timeout)=/.test(a)) errors.push(`invalid parameter "${a}" in ${s.file}:${s.line}`);
          }
          up.servers.push(server);
        } else if (s.name === 'least_conn') up.method = 'least_conn';
        else if (s.name === 'ip_hash' || s.name === 'hash') up.method = 'ip_hash';
      }
      if (!up.servers.length) errors.push(`no servers are inside upstream in ${d.file}:${d.line}`);
      model.upstreams[name] = up;
    }
  }
  const defaults: Record<number, string> = {};
  for (const d of http) {
    if (d.name !== 'server') continue;
    const s: ServerBlock = { listens: [], names: [], index: ['index.html', 'index.nginx-debian.html'], locations: [], headers: [], directives: d.block ?? [], file: d.file, line: d.line };
    let cert: string | undefined;
    let key: string | undefined;
    for (const x of d.block ?? []) {
      switch (x.name) {
        case 'listen': {
          const first = x.args[0] ?? '80';
          if (first.startsWith('[::]')) continue; // IPv6 listener: ignored, the IPv4 one carries it
          const m = first.match(/^(?:[\d.]+:|\*:)?(\d+)$/);
          if (!m) {
            errors.push(`host not found in "${first}" of the "listen" directive in ${x.file}:${x.line}`);
            continue;
          }
          const l: Listen = { port: Number(m[1]), ssl: x.args.includes('ssl'), defaultServer: x.args.includes('default_server') };
          if (l.defaultServer) {
            if (defaults[l.port]) errors.push(`a duplicate default server for 0.0.0.0:${l.port} in ${x.file}:${x.line}`);
            defaults[l.port] = `${x.file}:${x.line}`;
          }
          s.listens.push(l);
          break;
        }
        case 'server_name':
          s.names.push(...x.args);
          break;
        case 'root':
          s.root = x.args[0];
          break;
        case 'index':
          s.index = x.args;
          break;
        case 'return':
          s.ret = { code: /^\d+$/.test(x.args[0]) ? Number(x.args[0]) : 302, url: /^\d+$/.test(x.args[0]) ? x.args[1] : x.args[0] };
          break;
        case 'add_header':
          s.headers.push([x.args[0], x.args.slice(1).filter((a) => a !== 'always').join(' ')]);
          break;
        case 'ssl_certificate':
          cert = x.args[0];
          break;
        case 'ssl_certificate_key':
          key = x.args[0];
          break;
        case 'location': {
          const mod = x.args.length > 1 ? (x.args[0] as Location['modifier']) : '';
          s.locations.push({ modifier: mod, path: x.args[x.args.length - 1], directives: x.block ?? [] });
          break;
        }
      }
    }
    if (!s.listens.length) s.listens.push({ port: 80, ssl: false, defaultServer: false });
    if (s.listens.some((l) => l.ssl)) {
      const where = `${d.file}:${d.line}`;
      if (!cert) errors.push(`no "ssl_certificate" is defined for the "listen ... ssl" directive in ${where}`);
      else if (!key) errors.push(`no "ssl_certificate_key" is defined for certificate "${cert}"`);
      else {
        const problem = certificateProblem(state, cert, key);
        if (problem) errors.push(problem);
        else s.ssl = { cert, key };
      }
    }
    for (const loc of s.locations) {
      for (const x of loc.directives) {
        if (x.name === 'proxy_pass') {
          const m = (x.args[0] ?? '').match(/^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/);
          if (!m) errors.push(`invalid URL prefix in ${x.file}:${x.line}`);
          else if (!model.upstreams[m[1]] && !/^\d+\.\d+\.\d+\.\d+$/.test(m[1]) && !resolveName(state, m[1])) errors.push(`host not found in upstream "${m[1]}" in ${x.file}:${x.line}`);
        }
      }
    }
    model.servers.push(s);
  }
  return { model, errors };
}

/**
 * Why a certificate and key cannot be loaded, or null when they are usable. Shared by
 * nginx and Apache so both report a missing or malformed file the same way.
 */
export function certificateProblem(state: LinuxState, cert: string, key?: string): string | null {
  const certNode = getNode(state, cert);
  if (!certNode || certNode.type !== 'file') return `cannot load certificate "${cert}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling fopen(${cert}, r) error:10000080:BIO routines::no such file)`;
  if (!certNode.content.includes('BEGIN CERTIFICATE')) return `cannot load certificate "${cert}": PEM_read_bio_X509_AUX() failed (SSL: error:0480006C:PEM routines::no start line:Expecting: TRUSTED CERTIFICATE)`;
  if (!key) return 'no certificate key is configured';
  const keyNode = getNode(state, key);
  if (!keyNode || keyNode.type !== 'file') return `cannot load certificate key "${key}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling fopen(${key}, r) error:10000080:BIO routines::no such file)`;
  if (!keyNode.content.includes('PRIVATE KEY')) return `cannot load certificate key "${key}": PEM_read_bio_PrivateKey() failed (SSL: error:0480006C:PEM routines::no start line:Expecting: ANY PRIVATE KEY)`;
  return null;
}

/**
 * A configuration snapshot is stored as JSON, not as concatenated text: a real config
 * file can contain a line that looks like any text separator (ports.conf ships with a
 * comment naming another config file).
 */
export function snapshot(files: Array<{ path: string; text: string }>): string {
  return JSON.stringify(files);
}

export function snapshotFiles(text: string): Array<{ path: string; text: string }> {
  try {
    const parsed = JSON.parse(text) as Array<{ path: string; text: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A state whose filesystem is the snapshot, for re-parsing what a server actually loaded. */
export function snapshotState(state: LinuxState, files: Array<{ path: string; text: string }>): LinuxState {
  const fake: LinuxState = { ...state, user: 'root', fs: { ...state.fs } };
  for (const f of files) fake.fs[f.path] = { type: 'file', content: f.text, owner: 'root', group: 'root', mode: 0o644, mtime: 0 };
  return fake;
}

/** Per-server runtime, created on demand so sessions saved before Apache existed still load. */
export function runtime(state: LinuxState, kind: 'nginx' | 'apache'): ServerRuntime {
  const web = (state.web ??= { nginx: { listens: [] }, apache: { listens: [] }, rr: {}, requests: [] });
  web.rr ??= {};
  web.requests ??= [];
  return (web[kind] ??= { listens: [] });
}

/** Name lookup through the host's /etc/hosts (no DNS in the lab network). */
export function resolveName(state: LinuxState, name: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name;
  if (name === 'localhost') return '127.0.0.1';
  const hosts = state.fs['/etc/hosts']?.content ?? '';
  for (const line of hosts.split('\n')) {
    const parts = line.replace(/#.*/, '').trim().split(/\s+/);
    if (parts.length > 1 && parts.slice(1).includes(name) && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) return parts[0];
  }
  return null;
}

export interface LoadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** nginx -t: parse and validate the configuration on disk. */
export function testNginx(state: LinuxState): LoadResult {
  const warnings: string[] = [];
  if (state.user !== 'root') warnings.push('nginx: [warn] the "user" directive makes sense only if the master process runs with super-user privileges, ignored in /etc/nginx/nginx.conf:1');
  try {
    const conf = parseAll(state);
    const { errors } = buildModel(state, conf);
    return { ok: errors.length === 0, errors: errors.map((e) => `nginx: [emerg] ${e}`), warnings };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, errors: [`nginx: [emerg] ${e.message}`], warnings };
    throw e;
  }
}

/** The model the configuration on disk describes, or null when it does not load. */
function modelFromDisk(state: LinuxState): NginxModel | null {
  try {
    const { model, errors } = buildModel(state, parseAll(state));
    return errors.length ? null : model;
  } catch {
    return null;
  }
}

/** Ports the nginx configuration on disk asks for. */
export function nginxConfiguredPorts(state: LinuxState): number[] {
  const model = modelFromDisk({ ...state, user: 'root' });
  return model ? [...new Set(model.servers.flatMap((s) => s.listens.map((l) => l.port)))].sort((a, b) => a - b) : [80];
}

/** Load (start/reload): validate, then snapshot the configuration nginx serves from. */
export function loadNginx(state: LinuxState): LoadResult {
  const asRoot = { ...state, user: 'root' };
  const rt = runtime(state, 'nginx');
  const r = testNginx(asRoot);
  if (!r.ok) {
    rt.lastError = r.errors[0];
    return r;
  }
  rt.loaded = snapshot(configFiles(asRoot));
  rt.lastError = undefined;
  rt.listens = nginxConfiguredPorts(asRoot);
  const svc = state.services.nginx;
  if (svc) svc.ports = rt.listens;
  return r;
}

/** The model a running server is serving from (snapshotted at start/reload, loaded lazily for a preconfigured host). */
export function currentModel(state: LinuxState, kind: 'nginx' | 'apache' = 'nginx'): NginxModel | null {
  const service = kind === 'nginx' ? state.services.nginx : state.services.apache2;
  if (!service?.active) return null;
  const rt = runtime(state, kind);
  if (rt.loaded === undefined) {
    const r = kind === 'nginx' ? loadNginx(state) : loadApache(state);
    if (!r.ok) return null;
  }
  if (rt.loaded === undefined) return null;
  if (kind === 'apache') return apacheModelFromSnapshot(state, rt.loaded);
  const loaded = snapshotState(state, snapshotFiles(rt.loaded));
  try {
    return buildModel(loaded, parseAll(loaded)).model;
  } catch {
    return null;
  }
}

/** The server listening on a port right now, if any. */
export function serverOnPort(state: LinuxState, port: number): { kind: 'nginx' | 'apache'; model: NginxModel } | null {
  for (const kind of ['nginx', 'apache'] as const) {
    const model = currentModel(state, kind);
    if (model && model.servers.some((s) => s.listens.some((l) => l.port === port))) return { kind, model };
  }
  return null;
}

// ---------------------------------------------------------------------------
// serving

function matchServer(model: NginxModel, req: HttpRequest): { server: ServerBlock; listen: Listen } | null {
  const candidates = model.servers.flatMap((s) => s.listens.filter((l) => l.port === req.port).map((l) => ({ server: s, listen: l })));
  if (!candidates.length) return null;
  const host = req.host.toLowerCase();
  const exact = candidates.find((c) => c.server.names.some((n) => n.toLowerCase() === host));
  if (exact) return exact;
  const wildcard = candidates.find((c) => c.server.names.some((n) => n.startsWith('*.') && host.endsWith(n.slice(1).toLowerCase())));
  if (wildcard) return wildcard;
  return candidates.find((c) => c.listen.defaultServer) ?? candidates[0];
}

function matchLocation(server: ServerBlock, path: string): Location | null {
  const exact = server.locations.find((l) => l.modifier === '=' && l.path === path);
  if (exact) return exact;
  let best: Location | null = null;
  for (const l of server.locations) {
    if (l.modifier === '~') continue;
    if (path.startsWith(l.path) && (!best || l.path.length > best.path.length)) best = l;
  }
  if (best && best.modifier === '^~') return best;
  for (const l of server.locations) {
    if (l.modifier !== '~') continue;
    try {
      if (new RegExp(l.path).test(path)) return l;
    } catch {
      /* bad regex */
    }
  }
  return best;
}

function contentType(path: string): string {
  if (/\.html?$/.test(path)) return 'text/html';
  if (/\.json$/.test(path)) return 'application/json';
  if (/\.css$/.test(path)) return 'text/css';
  if (/\.js$/.test(path)) return 'application/javascript';
  return 'text/plain';
}

function vars(text: string, req: HttpRequest, server: ServerBlock): string {
  return text.replace(/\$host/g, req.host).replace(/\$request_uri/g, req.path).replace(/\$scheme/g, req.scheme).replace(/\$server_name/g, server.names[0] ?? '').replace(/\$uri/g, req.path.split('?')[0]).replace(/\$server_port/g, String(req.port));
}

function respond(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, statusText: STATUS[status] ?? '', headers: { Server: NGINX_VERSION, 'Content-Type': 'text/html', 'Content-Length': String(body.length), ...headers }, body };
}

function serveStatic(state: LinuxState, root: string, uriPath: string, index: string[]): HttpResponse {
  const clean = uriPath.split('?')[0];
  let path = normalizePath(root, '.' + clean);
  let node = getNode(state, path);
  if (node?.type === 'dir') {
    if (!clean.endsWith('/')) return respond(301, errorPage(301), { Location: clean + '/' });
    const found = index.map((i) => normalizePath(path, i)).find((p) => getNode(state, p)?.type === 'file');
    if (!found) return respond(403, errorPage(403));
    path = found;
    node = getNode(state, path);
  }
  if (!node || node.type !== 'file') return respond(404, errorPage(404));
  if (!(node.mode & 0o004) && node.owner !== 'www-data') return respond(403, errorPage(403));
  return respond(200, node.content, { 'Content-Type': contentType(path) });
}

/** The demo application ("app" service): answers with its hostname so load balancing is visible. */
function serveApp(state: LinuxState, req: HttpRequest): HttpResponse {
  runtime(state, 'nginx');
  const custom = state.fs['/opt/app/index.html'];
  const body = custom?.content ?? `Hello from ${state.hostname}\n`;
  const res: HttpResponse = { status: 200, statusText: 'OK', headers: { Server: 'netlab-app/1.0', 'Content-Type': custom ? 'text/html' : 'text/plain', 'Content-Length': String(body.length), 'X-Backend': state.hostname }, body: req.path.startsWith('/health') ? 'ok\n' : body };
  if (req.path.startsWith('/health')) res.headers['Content-Length'] = '3';
  state.web.requests.push({ scheme: req.scheme, host: req.host, path: req.path, status: 200, server: 'app', engine: 'app' });
  return res;
}

function pickBackend(state: LinuxState, up: Upstream, healthy: (s: UpstreamServer) => boolean, clientIp?: string): UpstreamServer | null {
  runtime(state, 'nginx');
  const primary = up.servers.filter((s) => !s.down && !s.backup);
  const backups = up.servers.filter((s) => !s.down && s.backup);
  const tryList = (list: UpstreamServer[]): UpstreamServer | null => {
    if (!list.length) return null;
    const ring = list.flatMap((s) => Array<UpstreamServer>(s.weight).fill(s));
    let start: number;
    if (up.method === 'ip_hash' && clientIp) start = clientIp.split('.').reduce((n, o) => n + Number(o), 0) % ring.length;
    else {
      start = (state.web.rr[up.name] ?? 0) % ring.length;
      state.web.rr[up.name] = start + 1;
    }
    for (let k = 0; k < ring.length; k++) {
      const s = ring[(start + k) % ring.length];
      if (healthy(s)) return s;
    }
    return null;
  };
  return tryList(primary) ?? tryList(backups);
}

/**
 * Answer an HTTP(S) request arriving at a Linux host. `hostId` is the target; the
 * caller has already found it by IP. Errors mean the TCP/TLS layer failed.
 */
export function serveHttp(net: NetworkState, hostId: string, req: HttpRequest, depth = 0): HttpResponse | HttpError {
  const host = net.hosts[hostId];
  const state = host?.linux;
  if (!state) return { error: 'refused' };
  if (depth > 4) return respond(502, errorPage(502));
  const app = state.services.app;
  if (app?.active && (app.port ?? 8080) === req.port) {
    if (req.scheme === 'https') return { error: 'tls-to-plain' };
    if (req.probe) return respond(200, '');
    return serveApp(state, req);
  }
  const picked = serverOnPort(state, req.port);
  if (!picked) return { error: 'refused' };
  const { kind, model } = picked;
  const hit = matchServer(model, req);
  if (!hit) return { error: 'refused' };
  const { server, listen } = hit;
  const record = (status: number, backend?: string) => {
    if (!req.probe) runtime(state, kind) && state.web.requests.push({ scheme: req.scheme, host: req.host, path: req.path, status, server: server.names[0] ?? '_', backend, engine: kind });
  };
  if (req.scheme === 'https' && !listen.ssl) return { error: 'tls-to-plain' };
  if (req.probe) return respond(200, '');
  if (req.scheme === 'http' && listen.ssl) {
    record(400);
    return respond(400, '<html>\r\n<head><title>400 The plain HTTP request was sent to HTTPS port</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>The plain HTTP request was sent to HTTPS port</center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>\r\n');
  }
  const extra: Record<string, string> = Object.fromEntries(server.headers);
  const finish = (res: HttpResponse, backend?: string): HttpResponse => {
    record(res.status, backend);
    return { ...res, headers: { ...res.headers, ...extra } };
  };
  if (server.ret) {
    const url = server.ret.url ? vars(server.ret.url, req, server) : undefined;
    return finish(respond(server.ret.code, url && server.ret.code >= 300 && server.ret.code < 400 ? errorPage(server.ret.code) : (url ?? '') + (url ? '\n' : ''), url && server.ret.code >= 300 && server.ret.code < 400 ? { Location: url } : { 'Content-Type': 'text/plain' }));
  }
  const loc = matchLocation(server, req.path.split('?')[0]);
  const directives = loc?.directives ?? [];
  const get = (name: string) => directives.find((d) => d.name === name);
  for (const h of directives.filter((d) => d.name === 'add_header')) extra[h.args[0]] = h.args.slice(1).filter((a) => a !== 'always').join(' ');
  const ret = get('return');
  if (ret) {
    const code = /^\d+$/.test(ret.args[0]) ? Number(ret.args[0]) : 302;
    const url = /^\d+$/.test(ret.args[0]) ? ret.args[1] : ret.args[0];
    const target = url ? vars(url, req, server) : undefined;
    if (target && code >= 300 && code < 400) return finish(respond(code, errorPage(code), { Location: target }));
    return finish(respond(code, target ? target + '\n' : errorPage(code), { 'Content-Type': 'text/plain' }));
  }
  const proxy = get('proxy_pass');
  if (proxy && kind === 'apache' && proxyHandlerMissing(state)) {
    // mod_proxy alone cannot speak http; Apache logs AH01144 and answers 500.
    return finish(respond(500, errorPage(500)));
  }
  if (proxy) {
    const m = (proxy.args[0] ?? '').match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/)!;
    const targetName = m[2];
    const up = model.upstreams[targetName];
    const path = m[4] && loc && loc.modifier !== '~' ? m[4].replace(/\/$/, '') + '/' + req.path.slice(loc.path.length).replace(/^\//, '') : req.path;
    const send = (ip: string, port: number): HttpResponse | HttpError => {
      const target = Object.values(net.hosts).find((h) => h.ip === ip);
      if (!target) return { error: 'unreachable' };
      if (target.id !== hostId && !forward(net, hostId, ip, { protocol: 'tcp', dstPort: port }, { record: false }).reached) return { error: 'unreachable' };
      return serveHttp(net, target.id, { scheme: 'http', host: req.host, port, path, method: req.method, clientIp: host.ip }, depth + 1);
    };
    if (up) {
      const healthy = (s: UpstreamServer) => {
        const ip = resolveName(state, s.host);
        if (!ip) return false;
        const t = Object.values(net.hosts).find((h) => h.ip === ip);
        if (!t?.linux) return false;
        const listening = Object.values(t.linux.services).some((svc) => svc.active && ((svc.ports ?? [svc.port]).includes(s.port)));
        return listening && (t.id === hostId || forward(net, hostId, ip, { protocol: 'tcp', dstPort: s.port }, { record: false }).reached);
      };
      const chosen = pickBackend(state, up, healthy, req.clientIp);
      if (!chosen) return finish(respond(502, errorPage(502)));
      const ip = resolveName(state, chosen.host)!;
      const r = send(ip, chosen.port);
      if ('error' in r) return finish(respond(502, errorPage(502)));
      return finish(r, Object.values(net.hosts).find((h) => h.ip === ip)?.id);
    }
    const ip = resolveName(state, targetName);
    if (!ip) return finish(respond(502, errorPage(502)));
    const r = send(ip, m[3] ? Number(m[3]) : 80);
    if ('error' in r) return finish(respond(502, errorPage(502)));
    return finish(r, Object.values(net.hosts).find((h) => h.ip === ip)?.id);
  }
  const alias = get('alias')?.args[0];
  const root = get('root')?.args[0] ?? server.root ?? '/var/www/html';
  const index = get('index')?.args ?? server.index;
  if (alias && loc) return finish(serveStatic(state, alias, req.path.slice(loc.path.length).replace(/^\/?/, '/'), index));
  return finish(serveStatic(state, root, req.path, index));
}

/** Ports nginx listens on (for ss). */
export function nginxPorts(state: LinuxState): number[] {
  const m = currentModel(state, 'nginx');
  if (m) return [...new Set(m.servers.flatMap((s) => s.listens.map((l) => l.port)))].sort((a, b) => a - b);
  const rt = runtime(state, 'nginx');
  return rt.listens.length ? rt.listens : [80];
}

/** Ports a running server actually listens on, for ss. */
export function servicePorts(state: LinuxState, service: string): number[] {
  if (service === 'nginx') return nginxPorts(state);
  if (service === 'apache2') {
    const m = currentModel(state, 'apache');
    if (m) return [...new Set(m.servers.flatMap((s) => s.listens.map((l) => l.port)))].sort((a, b) => a - b);
    const rt = runtime(state, 'apache');
    return rt.listens.length ? rt.listens : [80];
  }
  const s = state.services[service];
  return s?.ports ?? (s?.port ? [s.port] : []);
}

// ---------------------------------------------------------------------------
// certificates

export interface CertInfo {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  days: number;
  serial: string;
}

function fakeBase64(seed: string, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let h = 0x811c9dc5;
  let out = '';
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length), 0x01000193) >>> 0;
    out += alphabet[h % 64];
  }
  return out;
}

function wrap64(text: string): string {
  return text.match(/.{1,64}/g)!.join('\n');
}

/** A self-signed certificate: PEM-looking, with its metadata recoverable by openssl x509. */
export function makeCertificate(subject: string, days: number, issuer = subject): string {
  const meta = Buffer_encode(JSON.stringify({ subject, issuer, notBefore: '2026-09-11T09:00:00Z', notAfter: new Date(Date.UTC(2026, 8, 11, 9) + days * 86400000).toISOString().replace(/\.\d+Z$/, 'Z'), days, serial: fakeBase64(subject + days, 32).replace(/[^0-9a-f]/gi, '0').slice(0, 32).toLowerCase() }));
  const body = 'MIIDNETLAB' + meta + 'NETLAB' + fakeBase64(subject, 600 - meta.length);
  return `-----BEGIN CERTIFICATE-----\n${wrap64(body)}\n-----END CERTIFICATE-----\n`;
}

export function makePrivateKey(seed: string): string {
  return `-----BEGIN PRIVATE KEY-----\n${wrap64('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' + fakeBase64('key:' + seed, 1550))}\n-----END PRIVATE KEY-----\n`;
}

export function parseCertificate(text: string): CertInfo | null {
  const m = text.replace(/\s+/g, '').match(/MIIDNETLAB(.+?)NETLAB/);
  if (!m) return null;
  try {
    return JSON.parse(Buffer_decode(m[1])) as CertInfo;
  } catch {
    return null;
  }
}

function Buffer_encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

function Buffer_decode(b64: string): string {
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function opensslDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCFullYear()} GMT`;
}

export { resolveLink };
