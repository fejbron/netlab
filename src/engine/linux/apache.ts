/**
 * Apache HTTP Server (the Debian/Ubuntu apache2 layout): a configuration parser and
 * validator with real module gating, translated into the shared web model so the same
 * request pipeline serves nginx and Apache.
 *
 * The lessons this reproduces: directives only exist when their module is enabled
 * (a2enmod), sites only load when enabled (a2ensite), `apache2ctl configtest` names the
 * file and line, and a port already taken by another server refuses to bind.
 */
import { baseName, getNode, listDir, normalizePath, parentPath, readFile, type LinuxState } from './fs';
import type { Directive, LoadResult, NginxModel, ServerBlock, Upstream } from './web';
import { certificateProblem, runtime, snapshot, snapshotFiles, snapshotState } from './web';

export class ApacheError extends Error {}

// ---------------------------------------------------------------------------
// packaged files

/** Modules a2enmod knows about; the ones marked default are enabled by a fresh install. */
export const APACHE_MODULES: Record<string, { default?: boolean; conf?: string; description: string }> = {
  access_compat: { default: true, description: 'Group authorizations based on host (legacy)' },
  alias: { default: true, conf: 'Alias /icons/ "/usr/share/apache2/icons/"\n', description: 'Mapping URLs to filesystem locations (Alias, Redirect)' },
  auth_basic: { default: true, description: 'Basic HTTP authentication' },
  authn_core: { default: true, description: 'Core authentication' },
  authn_file: { default: true, description: 'User authentication using text files' },
  authz_core: { default: true, description: 'Core authorization (Require)' },
  authz_host: { default: true, description: 'Group authorizations based on host' },
  authz_user: { default: true, description: 'User authorization' },
  autoindex: { default: true, description: 'Generates directory indexes' },
  deflate: { default: true, description: 'Compress content before delivery' },
  dir: { default: true, conf: '<IfModule mod_dir.c>\n    DirectoryIndex index.html index.cgi index.pl index.php index.xhtml index.htm\n</IfModule>\n', description: 'Serves directory index files (DirectoryIndex)' },
  env: { default: true, description: 'Modifies the environment passed to CGI scripts' },
  filter: { default: true, description: 'Context-sensitive smart filter configuration' },
  mime: { default: true, description: 'Associates the requested filename with its media type' },
  mpm_event: { default: true, description: 'Event-driven processing model' },
  negotiation: { default: true, description: 'Content negotiation' },
  reqtimeout: { default: true, description: 'Sets timeout and minimum data rate for receiving requests' },
  setenvif: { default: true, description: 'Sets environment variables based on the request' },
  status: { default: true, description: 'Provides information on server activity' },
  headers: { description: 'Customization of HTTP request and response headers (Header)' },
  rewrite: { description: 'Rule-based rewriting engine (RewriteEngine, RewriteRule)' },
  proxy: { conf: '<IfModule mod_proxy.c>\n    ProxyRequests Off\n</IfModule>\n', description: 'Multi-protocol proxy/gateway (ProxyPass)' },
  proxy_http: { description: 'HTTP support for mod_proxy' },
  proxy_balancer: { description: 'Load balancing for mod_proxy (BalancerMember)' },
  lbmethod_byrequests: { description: 'Request-counting load balancing method' },
  lbmethod_bytraffic: { description: 'Weighted traffic counting load balancing method' },
  ssl: { conf: '<IfModule mod_ssl.c>\n    SSLRandomSeed startup builtin\n    SSLProtocol all -SSLv3\n    SSLCipherSuite HIGH:!aNULL\n</IfModule>\n', description: 'SSL/TLS support (SSLEngine)' },
  socache_shmcb: { description: 'Shared object cache provider, needed by mod_ssl' },
  http2: { description: 'HTTP/2 support' },
  userdir: { description: 'User-specific directories' },
};

const APACHE2_CONF = `# This is the main Apache server configuration file.
ServerRoot "/etc/apache2"

DefaultRuntimeDir \${APACHE_RUN_DIR}
PidFile \${APACHE_PID_FILE}
Timeout 300
KeepAlive On
MaxKeepAliveRequests 100
KeepAliveTimeout 5

User \${APACHE_RUN_USER}
Group \${APACHE_RUN_GROUP}

HostnameLookups Off
ErrorLog \${APACHE_LOG_DIR}/error.log
LogLevel warn

# Include module configuration:
IncludeOptional mods-enabled/*.load
IncludeOptional mods-enabled/*.conf

# Include list of ports to listen on
Include ports.conf

<Directory />
    Options FollowSymLinks
    AllowOverride None
    Require all denied
</Directory>

<Directory /var/www/>
    Options Indexes FollowSymLinks
    AllowOverride None
    Require all granted
</Directory>

AccessFileName .htaccess

LogFormat "%h %l %u %t \\"%r\\" %>s %O" common

# Include generic snippets of statements
IncludeOptional conf-enabled/*.conf

# Include the virtual host configurations:
IncludeOptional sites-enabled/*.conf
`;

const PORTS_CONF = `# If you just change the port or add more ports here, you will likely also
# have to change the VirtualHost statement in
# /etc/apache2/sites-enabled/000-default.conf

Listen 80

<IfModule ssl_module>
    Listen 443
</IfModule>

<IfModule mod_gnutls.c>
    Listen 443
</IfModule>
`;

const DEFAULT_SITE = `<VirtualHost *:80>
    # The ServerName directive sets the request scheme, hostname and port that
    # the server uses to identify itself.
    #ServerName www.example.com

    ServerAdmin webmaster@localhost
    DocumentRoot /var/www/html

    ErrorLog \${APACHE_LOG_DIR}/error.log
    CustomLog \${APACHE_LOG_DIR}/access.log combined
</VirtualHost>
`;

const DEFAULT_SSL_SITE = `<IfModule mod_ssl.c>
    <VirtualHost _default_:443>
        ServerAdmin webmaster@localhost
        DocumentRoot /var/www/html

        ErrorLog \${APACHE_LOG_DIR}/error.log
        CustomLog \${APACHE_LOG_DIR}/access.log combined

        SSLEngine on
        SSLCertificateFile /etc/ssl/certs/ssl-cert-snakeoil.pem
        SSLCertificateKeyFile /etc/ssl/private/ssl-cert-snakeoil.key
    </VirtualHost>
</IfModule>
`;

/** Files the apache2 package ships with. Idempotent. */
export function installApacheFiles(state: LinuxState): void {
  const d = (p: string, mode = 0o755) => (state.fs[p] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode, mtime: 0 });
  const f = (p: string, content: string, mode = 0o644) => (state.fs[p] ??= { type: 'file', content, owner: 'root', group: 'root', mode, mtime: 0 });
  const link = (p: string, target: string) => (state.fs[p] ??= { type: 'link', content: '', target, owner: 'root', group: 'root', mode: 0o777, mtime: 0 });
  d('/etc/apache2');
  for (const sub of ['mods-available', 'mods-enabled', 'sites-available', 'sites-enabled', 'conf-available', 'conf-enabled']) d(`/etc/apache2/${sub}`);
  f('/etc/apache2/apache2.conf', APACHE2_CONF);
  f('/etc/apache2/ports.conf', PORTS_CONF);
  f('/etc/apache2/envvars', 'export APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=www-data\nexport APACHE_PID_FILE=/var/run/apache2/apache2.pid\nexport APACHE_RUN_DIR=/var/run/apache2\nexport APACHE_LOG_DIR=/var/log/apache2\n');
  f('/etc/apache2/sites-available/000-default.conf', DEFAULT_SITE);
  f('/etc/apache2/sites-available/default-ssl.conf', DEFAULT_SSL_SITE);
  link('/etc/apache2/sites-enabled/000-default.conf', '/etc/apache2/sites-available/000-default.conf');
  f('/etc/apache2/conf-available/security.conf', 'ServerTokens OS\nServerSignature On\nTraceEnable Off\n');
  link('/etc/apache2/conf-enabled/security.conf', '/etc/apache2/conf-available/security.conf');
  for (const [name, mod] of Object.entries(APACHE_MODULES)) {
    f(`/etc/apache2/mods-available/${name}.load`, `LoadModule ${name}_module /usr/lib/apache2/modules/mod_${name}.so\n`);
    if (mod.conf) f(`/etc/apache2/mods-available/${name}.conf`, mod.conf);
    if (mod.default) {
      link(`/etc/apache2/mods-enabled/${name}.load`, `/etc/apache2/mods-available/${name}.load`);
      if (mod.conf) link(`/etc/apache2/mods-enabled/${name}.conf`, `/etc/apache2/mods-available/${name}.conf`);
    }
  }
  d('/var/log/apache2');
  f('/var/log/apache2/access.log', '');
  f('/var/log/apache2/error.log', '');
  d('/var/www/html');
  f('/var/www/html/index.html', '<!DOCTYPE html>\n<html>\n<head><title>Apache2 Ubuntu Default Page</title></head>\n<body>\n<h1>Apache2 Ubuntu Default Page</h1>\n<p>It works!</p>\n</body>\n</html>\n');
}

/** Modules that are enabled right now (a symlink in mods-enabled). */
export function enabledModules(state: LinuxState): string[] {
  return listDir(state, '/etc/apache2/mods-enabled')
    .filter((n) => n.endsWith('.load'))
    .map((n) => n.slice(0, -5))
    .sort();
}

export function enabledSites(state: LinuxState): string[] {
  return listDir(state, '/etc/apache2/sites-enabled').sort();
}

// ---------------------------------------------------------------------------
// parsing

interface ApNode {
  name: string;
  args: string[];
  children?: ApNode[];
  file: string;
  line: number;
}

function splitApacheArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function syntaxError(file: string, line: number, message: string): ApacheError {
  return new ApacheError(`AH00526: Syntax error on line ${line} of ${file}:\n${message}`);
}

function parseApache(text: string, file: string): ApNode[] {
  const lines = text.split('\n');
  const root: ApNode[] = [];
  const stack: ApNode[][] = [root];
  const open: ApNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    const lineNo = i + 1;
    while (raw.trimEnd().endsWith('\\') && i + 1 < lines.length) raw = raw.trimEnd().slice(0, -1) + lines[++i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('</')) {
      const name = line.slice(2).replace(/>$/, '').trim();
      const o = open.pop();
      if (!o) throw syntaxError(file, lineNo, `</${name}> without matching <${name}> section`);
      if (o.name.toLowerCase() !== name.toLowerCase()) throw syntaxError(file, lineNo, `Expected </${o.name}> but saw </${name}>`);
      stack.pop();
      continue;
    }
    if (line.startsWith('<')) {
      const m = line.match(/^<(\w+)\s*([^>]*)>$/);
      if (!m) throw syntaxError(file, lineNo, `Invalid section opening "${line}"`);
      const node: ApNode = { name: m[1], args: splitApacheArgs(m[2]), children: [], file, line: lineNo };
      stack[stack.length - 1].push(node);
      stack.push(node.children!);
      open.push(node);
      continue;
    }
    const parts = splitApacheArgs(line);
    stack[stack.length - 1].push({ name: parts[0], args: parts.slice(1), file, line: lineNo });
  }
  const unclosed = open.pop();
  if (unclosed) throw syntaxError(unclosed.file, lines.length, `<${unclosed.name}> was not closed.`);
  return root;
}

/** Expand the value of ${APACHE_LOG_DIR} and friends the way envvars does. */
function expandVars(text: string): string {
  const vars: Record<string, string> = { APACHE_LOG_DIR: '/var/log/apache2', APACHE_RUN_DIR: '/var/run/apache2', APACHE_PID_FILE: '/var/run/apache2/apache2.pid', APACHE_RUN_USER: 'www-data', APACHE_RUN_GROUP: 'www-data' };
  return text.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

function includePaths(state: LinuxState, pattern: string): string[] {
  const abs = normalizePath('/etc/apache2', pattern);
  if (!/[*?]/.test(abs)) return getNode(state, abs)?.type === 'file' ? [abs] : [];
  const dir = parentPath(abs);
  const re = new RegExp('^' + baseName(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return listDir(state, dir)
    .filter((n) => re.test(n))
    .map((n) => normalizePath(dir, n))
    .filter((p) => getNode(state, p)?.type === 'file')
    .sort();
}

/** Every file Apache reads, in order, following Include and IncludeOptional. */
export function apacheConfigFiles(state: LinuxState): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const seen = new Set<string>();
  const visit = (path: string, optional: boolean, depth: number) => {
    if (depth > 8 || seen.has(path)) return;
    const r = readFile({ ...state, user: 'root' }, path, 'apache2');
    if ('error' in r) {
      if (optional) return;
      throw new ApacheError(`AH00526: Syntax error on line 1 of ${path}:\nCould not open configuration file ${path}: No such file or directory`);
    }
    seen.add(path);
    out.push({ path, text: r.content });
    let nodes: ApNode[];
    try {
      nodes = parseApache(expandVars(r.content), path);
    } catch {
      return;
    }
    const walk = (list: ApNode[]) => {
      for (const n of list) {
        if (/^include(optional)?$/i.test(n.name)) for (const p of includePaths(state, n.args[0] ?? '')) visit(p, /optional/i.test(n.name), depth + 1);
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
  };
  visit('/etc/apache2/apache2.conf', false, 0);
  return out;
}

/** Directives each module provides; anything not listed is core. */
const MODULE_OF: Record<string, string> = {
  sslengine: 'ssl',
  sslcertificatefile: 'ssl',
  sslcertificatekeyfile: 'ssl',
  sslcertificatechainfile: 'ssl',
  sslprotocol: 'ssl',
  sslciphersuite: 'ssl',
  sslrandomseed: 'ssl',
  proxypass: 'proxy',
  proxypassreverse: 'proxy',
  proxypreservehost: 'proxy',
  proxyrequests: 'proxy',
  proxytimeout: 'proxy',
  proxyset: 'proxy',
  proxy: 'proxy',
  balancermember: 'proxy_balancer',
  header: 'headers',
  requestheader: 'headers',
  rewriteengine: 'rewrite',
  rewritecond: 'rewrite',
  rewriterule: 'rewrite',
  alias: 'alias',
  redirect: 'alias',
  redirectmatch: 'alias',
  directoryindex: 'dir',
};

const CORE_DIRECTIVES = new Set(['serverroot', 'defaultruntimedir', 'pidfile', 'timeout', 'keepalive', 'maxkeepaliverequests', 'keepalivetimeout', 'user', 'group', 'hostnamelookups', 'errorlog', 'loglevel', 'include', 'includeoptional', 'listen', 'directory', 'directorymatch', 'location', 'locationmatch', 'files', 'filesmatch', 'virtualhost', 'ifmodule', 'ifdefine', 'options', 'allowoverride', 'require', 'accessfilename', 'logformat', 'customlog', 'servername', 'serveralias', 'serveradmin', 'documentroot', 'servertokens', 'serversignature', 'traceenable', 'loadmodule', 'addtype', 'adddefaultcharset', 'errordocument', 'setenv', 'setenvif', 'satisfy', 'order', 'allow', 'deny', 'indexoptions', 'defaulttype', 'mutex', 'maxrequestworkers', 'startservers', 'protocols']);

// ---------------------------------------------------------------------------
// model

function dir(name: string, args: string[], file: string, line: number): Directive {
  return { name, args, file, line };
}

interface ApacheBuild {
  model: NginxModel;
  errors: string[];
}

function buildApacheModel(state: LinuxState, files: Array<{ path: string; text: string }>): ApacheBuild {
  const errors: string[] = [];
  const model: NginxModel = { servers: [], upstreams: {} };
  const modules = new Set(enabledModules(state));
  const listens = new Set<number>();
  const vhosts: ApNode[] = [];
  const balancers: Record<string, Upstream> = {};

  const check = (n: ApNode) => {
    const key = n.name.toLowerCase();
    const needs = MODULE_OF[key];
    if (needs && !modules.has(needs)) {
      errors.push(`AH00526: Syntax error on line ${n.line} of ${n.file}:\nInvalid command '${n.name}', perhaps misspelled or defined by a module not included in the server configuration`);
      return false;
    }
    if (!needs && !CORE_DIRECTIVES.has(key) && !modules.has(key)) {
      errors.push(`AH00526: Syntax error on line ${n.line} of ${n.file}:\nInvalid command '${n.name}', perhaps misspelled or defined by a module not included in the server configuration`);
      return false;
    }
    return true;
  };

  const isBalancerBlock = (n: ApNode) => n.name.toLowerCase() === 'proxy' && (n.args[0] ?? '').startsWith('balancer://');
  /** Register a <Proxy balancer://name> block; it may sit at the top level or inside a virtual host. */
  const collectBalancer = (n: ApNode) => {
    const name = n.args[0].slice('balancer://'.length);
    const up: Upstream = { name, servers: [], method: 'round_robin' };
    for (const c of n.children ?? []) {
      if (!check(c)) continue;
      if (c.name.toLowerCase() !== 'balancermember') continue;
      const m = (c.args[0] ?? '').match(/^https?:\/\/([^/:]+)(?::(\d+))?/);
      if (!m) {
        errors.push(`AH00526: Syntax error on line ${c.line} of ${c.file}:\nBalancerMember: invalid worker URL "${c.args[0] ?? ''}"`);
        continue;
      }
      const server = { host: m[1], port: m[2] ? Number(m[2]) : 80, weight: 1, backup: false, down: false };
      for (const a of c.args.slice(1)) {
        const [k, v] = a.split('=');
        if (k === 'loadfactor') server.weight = Math.max(1, Number(v) || 1);
        else if (k === 'status' && /[HD]/.test(v ?? '')) server.backup = (v ?? '').includes('H');
      }
      up.servers.push(server);
    }
    if (!up.servers.length) errors.push(`AH00526: Syntax error on line ${n.line} of ${n.file}:\nbalancer://${name} has no BalancerMember`);
    balancers[name] = up;
  };

  const walk = (list: ApNode[], insideVhost: boolean) => {
    for (const n of list) {
      const key = n.name.toLowerCase();
      if (key === 'ifmodule') {
        const want = (n.args[0] ?? '').replace(/^mod_/, '').replace(/\.c$/, '').replace(/_module$/, '');
        const negated = want.startsWith('!');
        const name = negated ? want.slice(1) : want;
        if (modules.has(name) !== negated) walk(n.children ?? [], insideVhost);
        continue;
      }
      if (key === 'ifdefine') continue;
      if (!check(n)) continue;
      if (key === 'listen') {
        const p = Number((n.args[0] ?? '').replace(/^.*:/, ''));
        if (!Number.isFinite(p) || p <= 0) errors.push(`AH00526: Syntax error on line ${n.line} of ${n.file}:\nListen must have a port number`);
        else listens.add(p);
        continue;
      }
      if (key === 'virtualhost') {
        vhosts.push(n);
        walkForErrors(n.children ?? []);
        continue;
      }
      if (isBalancerBlock(n)) {
        collectBalancer(n);
        continue;
      }
      if (n.children) walk(n.children, insideVhost);
    }
  };
  const walkForErrors = (list: ApNode[]) => {
    for (const n of list) {
      const key = n.name.toLowerCase();
      if (key === 'ifmodule') {
        const want = (n.args[0] ?? '').replace(/^mod_/, '').replace(/\.c$/, '').replace(/_module$/, '');
        if (modules.has(want)) walkForErrors(n.children ?? []);
        continue;
      }
      if (!check(n)) continue;
      if (isBalancerBlock(n)) {
        collectBalancer(n);
        continue;
      }
      if (n.children) walkForErrors(n.children);
    }
  };

  let nodes: ApNode[];
  try {
    nodes = parseApache(expandVars(files[0]?.text ?? ''), files[0]?.path ?? '/etc/apache2/apache2.conf');
  } catch (e) {
    return { model, errors: [(e as ApacheError).message] };
  }
  // Inline includes so file and line stay accurate.
  const inline = (list: ApNode[]): ApNode[] =>
    list.flatMap((n) => {
      if (/^include(optional)?$/i.test(n.name)) {
        return includePaths(state, n.args[0] ?? '').flatMap((p) => {
          const f = files.find((x) => x.path === p);
          if (!f) return [];
          try {
            return inline(parseApache(expandVars(f.text), p));
          } catch (e) {
            errors.push((e as ApacheError).message);
            return [];
          }
        });
      }
      return [n.children ? { ...n, children: inline(n.children) } : n];
    });
  const all = inline(nodes);
  walk(all, false);
  if (errors.length) return { model, errors };

  for (const vh of vhosts) {
    const ports = vh.args.map((a) => Number(a.replace(/^.*:/, ''))).filter((p) => Number.isFinite(p) && p > 0);
    if (!ports.length) {
      errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\n<VirtualHost> needs an address and port, for example <VirtualHost *:80>`);
      continue;
    }
    const s: ServerBlock = { listens: [], names: [], index: ['index.html'], locations: [], headers: [], directives: [], file: vh.file, line: vh.line };
    let cert: string | undefined;
    let key: string | undefined;
    let sslOn = false;
    const proxies: Array<{ path: string; target: string }> = [];
    const readBody = (list: ApNode[]) => {
      for (const n of list) {
        const k = n.name.toLowerCase();
        if (k === 'ifmodule') {
          const want = (n.args[0] ?? '').replace(/^mod_/, '').replace(/\.c$/, '').replace(/_module$/, '');
          if (modules.has(want)) readBody(n.children ?? []);
          continue;
        }
        switch (k) {
          case 'servername':
            s.names.unshift((n.args[0] ?? '').replace(/:\d+$/, ''));
            break;
          case 'serveralias':
            s.names.push(...n.args);
            break;
          case 'documentroot':
            s.root = n.args[0];
            break;
          case 'directoryindex':
            s.index = n.args;
            break;
          case 'header':
            if (n.args[0]?.toLowerCase() === 'always' || n.args[0]?.toLowerCase() === 'set') {
              const rest = n.args[0].toLowerCase() === 'always' ? n.args.slice(1) : n.args;
              if (rest[0]?.toLowerCase() === 'set' && rest[1]) s.headers.push([rest[1], rest.slice(2).join(' ')]);
            }
            break;
          case 'redirect': {
            const code = n.args[0] === 'permanent' ? 301 : n.args[0] === 'temp' ? 302 : /^\d+$/.test(n.args[0] ?? '') ? Number(n.args[0]) : 302;
            const rest = /^(permanent|temp|seeother|gone|\d+)$/.test(n.args[0] ?? '') ? n.args.slice(1) : n.args;
            if (rest[0] === '/' || rest[0] === undefined) s.ret = { code, url: rest[1] ? `${rest[1].replace(/\/$/, '')}$request_uri` : undefined };
            else s.locations.push({ modifier: '', path: rest[0], directives: [dir('return', [String(code), `${(rest[1] ?? '').replace(/\/$/, '')}$request_uri`], n.file, n.line)] });
            break;
          }
          case 'rewriterule': {
            // The common "everything to https" rule.
            const target = n.args[1] ?? '';
            if (/^https?:\/\//.test(target)) {
              const url = target.replace(/%\{HTTP_HOST\}/gi, '$host').replace(/%\{REQUEST_URI\}/gi, '$request_uri').replace(/\$1$/, '$request_uri');
              const code = /R=301/i.test(n.args[2] ?? '') ? 301 : /R=302|\[R[,\]]/i.test(n.args[2] ?? '') ? 302 : 0;
              if (code) s.ret = { code, url };
            }
            break;
          }
          case 'sslengine':
            sslOn = /on/i.test(n.args[0] ?? '');
            break;
          case 'sslcertificatefile':
            cert = n.args[0];
            break;
          case 'sslcertificatekeyfile':
            key = n.args[0];
            break;
          case 'proxypass':
            if (n.args.length >= 2) proxies.push({ path: n.args[0], target: n.args[1] });
            break;
          default:
            if (n.children) readBody(n.children);
        }
      }
    };
    readBody(vh.children ?? []);
    for (const p of ports) s.listens.push({ port: p, ssl: sslOn, defaultServer: false });
    if (sslOn) {
      if (!cert) errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\nSSLEngine is on but no SSLCertificateFile is set`);
      else {
        const problem = certificateProblem(state, cert, key);
        if (problem) errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\n${problem}`);
        else s.ssl = { cert, key: key! };
      }
    }
    for (const p of proxies) {
      const m = p.target.match(/^(https?|balancer):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
      if (!m) {
        errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\nProxyPass: invalid target "${p.target}"`);
        continue;
      }
      if (m[1] === 'balancer') {
        const up = balancers[m[2]];
        if (!up) {
          errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\nBalancerMember: no <Proxy balancer://${m[2]}> defined`);
          continue;
        }
        if (!modules.has('proxy_balancer')) {
          errors.push(`AH00526: Syntax error on line ${vh.line} of ${vh.file}:\nProxyPass: balancer:// needs the proxy_balancer module (a2enmod proxy_balancer)`);
          continue;
        }
        if (!modules.has('lbmethod_byrequests') && !modules.has('lbmethod_bytraffic')) {
          errors.push(`AH01179: Cannot find 'byrequests' lb method for balancer://${m[2]} (a2enmod lbmethod_byrequests)`);
          continue;
        }
        model.upstreams[m[2]] = up;
      }
      const target = m[1] === 'balancer' ? `http://${m[2]}${m[4] ?? '/'}` : p.target;
      s.locations.push({ modifier: '', path: p.path, directives: [dir('proxy_pass', [target], vh.file, vh.line)] });
    }
    model.servers.push(s);
  }
  // Apache uses the first virtual host on a port as that port's default.
  const firstForPort = new Map<number, ServerBlock>();
  for (const s of model.servers) for (const l of s.listens) if (!firstForPort.has(l.port)) firstForPort.set(l.port, s);
  for (const [port, s] of firstForPort) for (const l of s.listens) if (l.port === port) l.defaultServer = true;
  // A virtual host on a port nobody listens on never receives requests.
  for (const s of model.servers) s.listens = s.listens.filter((l) => listens.has(l.port));
  return { model, errors };
}

// ---------------------------------------------------------------------------
// public API

/** apache2ctl configtest. */
export function testApache(state: LinuxState): LoadResult {
  const asRoot = { ...state, user: 'root' };
  const warnings = ["AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 127.0.1.1. Set the 'ServerName' directive globally to suppress this message"];
  try {
    const files = apacheConfigFiles(asRoot);
    const { errors } = buildApacheModel(asRoot, files);
    return { ok: errors.length === 0, errors: errors.slice(0, 1), warnings };
  } catch (e) {
    if (e instanceof ApacheError) return { ok: false, errors: [e.message], warnings };
    throw e;
  }
}

export function apacheModelFromDisk(state: LinuxState): NginxModel | null {
  try {
    const asRoot = { ...state, user: 'root' };
    const { model, errors } = buildApacheModel(asRoot, apacheConfigFiles(asRoot));
    return errors.length ? null : model;
  } catch {
    return null;
  }
}

/** Ports the configuration on disk asks Apache to listen on. */
export function apacheConfiguredPorts(state: LinuxState): number[] {
  const model = apacheModelFromDisk(state);
  if (!model) return [80];
  return [...new Set(model.servers.flatMap((s) => s.listens.map((l) => l.port)))].sort((a, b) => a - b);
}

/** Load (start/reload): validate, then snapshot what Apache serves from. */
export function loadApache(state: LinuxState): LoadResult {
  const rt = runtime(state, 'apache');
  const r = testApache(state);
  if (!r.ok) {
    rt.lastError = r.errors[0];
    return r;
  }
  const asRoot = { ...state, user: 'root' };
  rt.loaded = snapshot(apacheConfigFiles(asRoot));
  rt.lastError = undefined;
  rt.listens = apacheConfiguredPorts(state);
  const svc = state.services.apache2;
  if (svc) svc.ports = rt.listens;
  return r;
}

/** Rebuild the model from the snapshot taken at the last successful start or reload. */
export function apacheModelFromSnapshot(state: LinuxState, text: string): NginxModel | null {
  const files = snapshotFiles(text);
  if (!files.length) return null;
  try {
    const { model, errors } = buildApacheModel(snapshotState(state, files), files);
    return errors.length ? null : model;
  } catch {
    return null;
  }
}

/** mod_proxy can only speak http:// when mod_proxy_http is loaded; without it a request fails. */
export function proxyHandlerMissing(state: LinuxState): boolean {
  const modules = new Set(enabledModules(state));
  return modules.has('proxy') && !modules.has('proxy_http');
}
