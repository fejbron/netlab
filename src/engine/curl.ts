/**
 * `curl` for the simulated PCs and Linux hosts. Talks to a router's RESTCONF API or to a
 * Linux host's nginx / demo application over the forwarding simulation, with realistic
 * failures (timeout, refused, certificate, wrong protocol) and the options learners use
 * to inspect web servers: -i, -I, -L, -H "Host: ...", -o, -w '%{http_code}'.
 */
import { forward, ifaceUp, type HostState, type NetworkState } from './network';
import { isValidIp } from './ios/net';
import { restconfRequest, statusText, type ApiMethod } from './restconf';
import { resolveName, serveHttp, type HttpResponse } from './linux/web';
import { writeFile } from './linux/fs';

/** Split a command line into words, honouring single and double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

interface CurlOptions {
  insecure: boolean;
  include: boolean;
  headOnly: boolean;
  follow: boolean;
  method: ApiMethod;
  user?: string;
  password?: string;
  body?: string;
  headers: Record<string, string>;
  output?: string;
  writeOut?: string;
  url?: string;
}

function parseCurl(args: string[]): CurlOptions | string {
  const o: CurlOptions = { insecure: false, include: false, headOnly: false, follow: false, method: 'GET', headers: {} };
  let explicitMethod = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    const next = () => {
      if (n + 1 >= args.length) return null;
      return args[++n];
    };
    if (a === '-k' || a === '--insecure') o.insecure = true;
    else if (a === '-i' || a === '--include') o.include = true;
    else if (a === '-I' || a === '--head') o.headOnly = true;
    else if (a === '-L' || a === '--location') o.follow = true;
    else if (a === '-s' || a === '--silent' || a === '-S' || a === '-v' || a === '--verbose' || a === '-f' || a === '-4' || a === '--compressed') continue;
    else if (/^-[kiILsSvf4]{2,}$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'k') o.insecure = true;
        if (ch === 'i') o.include = true;
        if (ch === 'I') o.headOnly = true;
        if (ch === 'L') o.follow = true;
      }
    } else if (a === '-u' || a === '--user') {
      const v = next();
      if (v === null) return 'curl: option -u: requires parameter';
      const idx = v.indexOf(':');
      o.user = idx === -1 ? v : v.slice(0, idx);
      o.password = idx === -1 ? undefined : v.slice(idx + 1);
    } else if (a === '-X' || a === '--request') {
      const v = next();
      if (v === null) return 'curl: option -X: requires parameter';
      const m = v.toUpperCase();
      if (!['GET', 'PATCH', 'PUT', 'DELETE', 'POST', 'HEAD'].includes(m)) return `curl: unsupported method ${v}`;
      if (m === 'HEAD') o.headOnly = true;
      else o.method = m as ApiMethod;
      explicitMethod = true;
    } else if (a === '-H' || a === '--header') {
      const v = next();
      if (v === null) return 'curl: option -H: requires parameter';
      const idx = v.indexOf(':');
      if (idx > 0) o.headers[v.slice(0, idx).trim().toLowerCase()] = v.slice(idx + 1).trim();
    } else if (a === '-d' || a === '--data' || a === '--data-raw') {
      const v = next();
      if (v === null) return 'curl: option -d: requires parameter';
      o.body = v;
      if (!explicitMethod) o.method = 'POST';
    } else if (a === '-o' || a === '--output') {
      const v = next();
      if (v === null) return 'curl: option -o: requires parameter';
      o.output = v;
    } else if (a === '-w' || a === '--write-out') {
      const v = next();
      if (v === null) return 'curl: option -w: requires parameter';
      o.writeOut = v;
    } else if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '--retry') next();
    else if (a.startsWith('-')) return `curl: option ${a}: is unknown`;
    else o.url = a;
  }
  if (!o.url) return 'curl: no URL specified!';
  return o;
}

function pretty(body: unknown): string[] {
  if (body === undefined) return [];
  if (typeof body === 'string') return body.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  return JSON.stringify(body, null, 2).split('\n');
}

const CERT_ERROR = ['curl: (60) SSL certificate problem: self-signed certificate', 'More details here: https://curl.se/docs/sslcerts.html', '', 'curl failed to verify the legitimacy of the server and therefore could not', 'establish a secure connection to it. To learn more about this situation and', 'how to fix it, please visit the webpage mentioned above.'];

function present(o: CurlOptions, h: HostState, res: HttpResponse): string[] {
  const out: string[] = [];
  const headerLines = [`HTTP/1.1 ${res.status} ${res.statusText}`.trimEnd(), ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`), 'Date: Thu, 11 Sep 2026 09:00:00 GMT'];
  if (o.headOnly) return [...headerLines, ''];
  if (o.include) out.push(...headerLines, '');
  if (o.output) {
    if (h.linux && o.output !== '/dev/null') {
      const path = o.output.startsWith('/') ? o.output : `${h.linux.cwd === '/' ? '' : h.linux.cwd}/${o.output}`;
      const e = writeFile(h.linux, path, res.body, false, 'curl', o.output);
      if (e) out.push(`Warning: Failed to open the file ${o.output}: ${e.error.split(': ').pop()}`);
    }
  } else out.push(...pretty(res.body));
  if (o.writeOut) out.push(...o.writeOut.replace(/\\n/g, '\n').replace(/%\{http_code\}/g, String(res.status)).replace(/%\{redirect_url\}/g, res.headers.Location ?? '').replace(/%\{content_type\}/g, res.headers['Content-Type'] ?? '').replace(/\n$/, '').split('\n'));
  return out;
}

/** Run curl from a host. Returns the output lines and the exit code. */
export function curl(network: NetworkState, h: HostState, args: string[]): { output: string[]; code: number } {
  const o = parseCurl(args);
  if (typeof o === 'string') return { output: [o, "curl: try 'curl --help' for more information"], code: 2 };
  let url = o.url!;
  const transcript: string[] = [];
  for (let hop = 0; hop < 6; hop++) {
    const m = url.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i);
    if (!m) return { output: [`curl: (3) URL rejected: ${url}`], code: 3 };
    const scheme = m[1].toLowerCase() as 'http' | 'https';
    const name = m[2];
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
    const path = m[4] ?? '/';
    const hostHeader = (o.headers.host ?? name).replace(/:\d+$/, '');
    // Name resolution: IPs always; names through the Linux host's /etc/hosts; PCs have no DNS.
    let target = isValidIp(name) ? name : h.linux ? resolveName(h.linux, name) : null;
    if (!target) return { output: [...transcript, `curl: (6) Could not resolve host: ${name}`], code: 6 };
    const self = target === '127.0.0.1' || target === h.ip;
    if (target === '127.0.0.1' && !h.linux) return { output: [...transcript, `curl: (7) Failed to connect to 127.0.0.1 port ${port} after 0 ms: Connection refused`], code: 7 };
    if (target === '127.0.0.1') target = h.ip ?? target;
    if (!self) {
      const r = forward(network, h.id, target, { protocol: 'tcp', dstPort: port }, { record: false });
      if (!r.reached) return { output: [...transcript, `curl: (28) Failed to connect to ${name} port ${port} after 21003 ms: Timeout was reached`], code: 28 };
    }
    const refused = { output: [...transcript, `curl: (7) Failed to connect to ${name} port ${port} after 2 ms: Connection refused`], code: 7 };

    // A router: RESTCONF.
    const dev = Object.values(network.devices).find((d) => Object.values(d.interfaces).some((i) => i.ipAddress === target && ifaceUp(network, d.id, i.name)));
    if (dev) {
      const listening = scheme === 'https' ? dev.httpSecureServer && port === 443 : dev.httpServer && port === 80;
      if (!listening) return refused;
      if (scheme === 'https' && !o.insecure) return { output: [...transcript, ...CERT_ERROR], code: 60 };
      const res = restconfRequest(network, dev.id, { method: o.method, path, body: o.body, user: o.user, password: o.password });
      const out = [...transcript];
      if (o.include || o.headOnly) {
        out.push(`HTTP/1.1 ${res.status} ${statusText(res.status)}`, 'Server: nginx', 'Date: Thu, 11 Sep 2026 09:00:00 GMT');
        if (res.body !== undefined) out.push(`Content-Type: ${typeof res.body === 'string' ? 'text/html' : 'application/yang-data+json'}`);
        if (res.status === 401) out.push('WWW-Authenticate: Basic realm="level_15_access"');
        out.push('');
      }
      if (!o.headOnly) out.push(...pretty(res.body));
      if (o.writeOut) out.push(o.writeOut.replace(/\\n/g, '').replace(/%\{http_code\}/g, String(res.status)));
      return { output: out, code: 0 };
    }

    // A Linux host: nginx or the demo application.
    const other = self ? h : Object.values(network.hosts).find((x) => x.ip === target);
    if (!other?.linux) return refused;
    const request = { scheme, host: hostHeader, port, path, method: o.headOnly ? 'HEAD' : o.method, clientIp: h.ip };
    const failed = (e: { error: string }) => {
      if (e.error === 'tls-to-plain') return { output: [...transcript, `curl: (35) OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number`], code: 35 };
      if (e.error === 'unreachable') return { output: [...transcript, `curl: (28) Failed to connect to ${name} port ${port} after 21003 ms: Timeout was reached`], code: 28 };
      return refused;
    };
    // The TLS handshake happens before any HTTP: a rejected certificate never reaches the server log.
    if (scheme === 'https') {
      const probe = serveHttp(network, other.id, { ...request, probe: true });
      if ('error' in probe) return failed(probe);
      if (!o.insecure) return { output: [...transcript, ...CERT_ERROR], code: 60 };
    }
    const res = serveHttp(network, other.id, request);
    if ('error' in res) return failed(res);
    if (o.follow && res.headers.Location && res.status >= 300 && res.status < 400) {
      if (o.include || o.headOnly) transcript.push(`HTTP/1.1 ${res.status} ${res.statusText}`, ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`), '');
      url = res.headers.Location.startsWith('/') ? `${scheme}://${name}${port === (scheme === 'https' ? 443 : 80) ? '' : ':' + port}${res.headers.Location}` : res.headers.Location;
      continue;
    }
    return { output: [...transcript, ...present(o, h, res)], code: 0 };
  }
  return { output: [...transcript, 'curl: (47) Maximum (5) redirects followed'], code: 47 };
}
