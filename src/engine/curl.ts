/**
 * `curl` for the simulated PCs and Linux hosts: talks to a router's RESTCONF API over
 * the forwarding simulation with realistic failures (timeout, refused, certificate,
 * 401, 404, 400, 204).
 */
import { forward, ifaceUp, type HostState, type NetworkState } from './network';
import { isValidIp } from './ios/net';
import { restconfRequest, statusText, type ApiMethod } from './restconf';

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
  method: ApiMethod;
  user?: string;
  password?: string;
  body?: string;
  headers: string[];
  url?: string;
}

function parseCurl(args: string[]): CurlOptions | string {
  const o: CurlOptions = { insecure: false, include: false, method: 'GET', headers: [] };
  let explicitMethod = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    const next = () => {
      if (n + 1 >= args.length) return null;
      return args[++n];
    };
    if (a === '-k' || a === '--insecure') o.insecure = true;
    else if (a === '-i' || a === '--include') o.include = true;
    else if (a === '-s' || a === '--silent' || a === '-v' || a === '--verbose' || a === '-L') continue;
    else if (a === '-u' || a === '--user') {
      const v = next();
      if (v === null) return 'curl: option -u: requires parameter';
      const idx = v.indexOf(':');
      o.user = idx === -1 ? v : v.slice(0, idx);
      o.password = idx === -1 ? undefined : v.slice(idx + 1);
    } else if (a === '-X' || a === '--request') {
      const v = next();
      if (v === null) return 'curl: option -X: requires parameter';
      const m = v.toUpperCase();
      if (!['GET', 'PATCH', 'PUT', 'DELETE', 'POST'].includes(m)) return `curl: unsupported method ${v}`;
      o.method = m as ApiMethod;
      explicitMethod = true;
    } else if (a === '-H' || a === '--header') {
      const v = next();
      if (v === null) return 'curl: option -H: requires parameter';
      o.headers.push(v);
    } else if (a === '-d' || a === '--data' || a === '--data-raw') {
      const v = next();
      if (v === null) return 'curl: option -d: requires parameter';
      o.body = v;
      if (!explicitMethod) o.method = 'POST';
    } else if (a.startsWith('-')) return `curl: option ${a}: is unknown`;
    else o.url = a;
  }
  if (!o.url) return 'curl: no URL specified!';
  return o;
}

function pretty(body: unknown): string[] {
  if (body === undefined) return [];
  if (typeof body === 'string') return body.split('\n');
  return JSON.stringify(body, null, 2).split('\n');
}

/** Run curl from a host. Returns the output lines and the exit code. */
export function curl(network: NetworkState, h: HostState, args: string[]): { output: string[]; code: number } {
  const o = parseCurl(args);
  if (typeof o === 'string') return { output: [o, "curl: try 'curl --help' for more information"], code: 2 };
  const m = o.url!.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i);
  if (!m) return { output: [`curl: (3) URL rejected: ${o.url}`], code: 3 };
  const scheme = m[1].toLowerCase() as 'http' | 'https';
  const target = m[2];
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  const path = m[4] ?? '/';
  if (!isValidIp(target)) return { output: [`curl: (6) Could not resolve host: ${target}`], code: 6 };
  const r = forward(network, h.id, target, { protocol: 'tcp', dstPort: port }, { record: false });
  if (!r.reached) return { output: [`curl: (28) Failed to connect to ${target} port ${port} after 21003 ms: Timeout was reached`], code: 28 };
  const dev = Object.values(network.devices).find((d) => Object.values(d.interfaces).some((i) => i.ipAddress === target && ifaceUp(network, d.id, i.name)));
  if (!dev) {
    // A Linux host with a web server answers plain HTTP with its index page.
    const other = Object.values(network.hosts).find((x) => x.ip === target);
    const web = other?.linux && Object.values(other.linux.services).find((s) => s.active && s.port === port);
    if (other?.linux && web && scheme === 'http') {
      const index = other.linux.fs['/var/www/html/index.html'] ?? other.linux.fs['/var/www/html/index.nginx-debian.html'];
      const out: string[] = [];
      if (o.include) out.push('HTTP/1.1 200 OK', `Server: ${web.name}`, 'Content-Type: text/html', '');
      out.push(...(index?.content ?? '<h1>It works!</h1>\n').replace(/\n$/, '').split('\n'));
      return { output: out, code: 0 };
    }
    return { output: [`curl: (7) Failed to connect to ${target} port ${port} after 2 ms: Connection refused`], code: 7 };
  }
  const listening = scheme === 'https' ? dev.httpSecureServer && port === 443 : dev.httpServer && port === 80;
  if (!listening) return { output: [`curl: (7) Failed to connect to ${target} port ${port} after 2 ms: Connection refused`], code: 7 };
  if (scheme === 'https' && !o.insecure) return { output: ['curl: (60) SSL certificate problem: self-signed certificate', 'More details here: https://curl.se/docs/sslcerts.html', '', 'curl failed to verify the legitimacy of the server and therefore could not', 'establish a secure connection to it. To learn more about this situation and', 'how to fix it, please visit the webpage mentioned above.'], code: 60 };
  const res = restconfRequest(network, dev.id, { method: o.method, path, body: o.body, user: o.user, password: o.password });
  const out: string[] = [];
  if (o.include) {
    out.push(`HTTP/1.1 ${res.status} ${statusText(res.status)}`, 'Server: nginx', 'Date: Thu, 11 Sep 2026 09:00:00 GMT');
    if (res.body !== undefined) out.push(`Content-Type: ${typeof res.body === 'string' ? 'text/html' : 'application/yang-data+json'}`);
    if (res.status === 401) out.push('WWW-Authenticate: Basic realm="level_15_access"');
    out.push('');
  }
  out.push(...pretty(res.body));
  return { output: out, code: 0 };
}
