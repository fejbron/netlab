/**
 * A minimal PC terminal: ipconfig (with /all, /renew and /release), ping and tracert
 * with Windows-style output.
 */
import { applyAclHits, dhcpRelease, dhcpRequest, forward, hostLinkLocal, ifaceUp, ping, type HostState, type NetworkState, nodeName } from './network';
import { isValidIp } from './ios/net';
import { isIpv6, normalizeIpv6 } from './ipv6';
import { restconfRequest, statusText, type ApiMethod } from './restconf';

function isAddress(text: string): boolean {
  return isValidIp(text) || isIpv6(text);
}

function canon(text: string): string {
  return isIpv6(text) ? normalizeIpv6(text)! : text;
}

export interface HostExecResult {
  network: NetworkState;
  output: string[];
}

export function hostPrompt(host: HostState): string {
  return `${host.name}> `;
}

function macText(h: HostState): string {
  return h.mac.replace(/\./g, '').match(/.{2}/g)!.join('-').toUpperCase();
}

function ipconfig(h: HostState, all: boolean): string[] {
  const out = ['Windows IP Configuration', ''];
  if (all) out.push(`   Host Name . . . . . . . . . . . . : ${h.name}`, '   Node Type . . . . . . . . . . . . : Hybrid', '   IP Routing Enabled. . . . . . . . : No', '');
  out.push('Ethernet adapter Ethernet0:', '', '   Connection-specific DNS Suffix  . :');
  if (all) {
    out.push('   Description . . . . . . . . . . . : Simulated Gigabit Ethernet', `   Physical Address. . . . . . . . . : ${macText(h)}`, `   DHCP Enabled. . . . . . . . . . . : ${h.dhcp ? 'Yes' : 'No'}`, '   Autoconfiguration Enabled . . . . : Yes');
  }
  if (h.ip6) out.push(`   IPv6 Address. . . . . . . . . . . : ${h.ip6}`);
  out.push(`   Link-local IPv6 Address . . . . . : ${hostLinkLocal(h)}%3`);
  out.push(`   IPv4 Address. . . . . . . . . . . : ${h.ip ?? '(none)'}`, `   Subnet Mask . . . . . . . . . . . : ${h.mask ?? '(none)'}`);
  out.push(`   Default Gateway . . . . . . . . . : ${h.gateway6 ?? h.gateway ?? ''}`);
  if (h.gateway6 && h.gateway) out.push(`                                       ${h.gateway}`);
  if (all) {
    if (h.dhcp && h.dhcpServer) out.push(`   DHCP Server . . . . . . . . . . . : ${h.dhcpServer}`);
    out.push(`   DNS Servers . . . . . . . . . . . : ${h.dns ?? ''}`);
  }
  return out;
}

function renew(network: NetworkState, h: HostState): string[] {
  if (!h.dhcp) return ['Windows IP Configuration', '', 'An error occurred while renewing interface Ethernet0 : DHCP is not enabled on this adapter.'];
  const r = dhcpRequest(network, h.id);
  if (!r.ok) return ['Windows IP Configuration', '', 'An error occurred while renewing interface Ethernet0 : unable to contact your DHCP server. Request has timed out.'];
  return ipconfig(h, false);
}

function release(network: NetworkState, h: HostState): string[] {
  if (!h.dhcp) return ['Windows IP Configuration', '', 'The operation failed as no adapter is in the state permissible for this operation.'];
  dhcpRelease(network, h.id);
  return ipconfig(h, false);
}

function pingOut(network: NetworkState, h: HostState, rawTarget: string): string[] {
  if (!isAddress(rawTarget)) return [`Ping request could not find host ${rawTarget}. Please check the name and try again.`];
  const target = canon(rawTarget);
  const r = ping(network, h.id, target);
  applyAclHits(network, r.hits);
  h.pings.push({ target, success: r.success, ...(r.denied ? { denied: true } : {}) });
  if (!r.success && (r.reason === 'no ip address' || r.reason === 'no gateway')) return ['PING: transmit failed. General failure.'];
  const routerHops = Math.max(0, r.hops.length - 1);
  const ttl = 128 - routerHops;
  const v6 = isIpv6(target);
  const reply = r.success ? (v6 ? `Reply from ${target}: time<1ms` : `Reply from ${target}: bytes=32 time<1ms TTL=${ttl}`) : r.denied ? `Reply from ${r.denied.ip ?? 'router'}: Destination net unreachable.` : 'Request timed out.';
  const received = r.success ? 4 : 0;
  const lost = r.success ? 0 : r.denied ? 0 : 4;
  return [
    `Pinging ${target} with 32 bytes of data:`,
    reply, reply, reply, reply,
    '',
    `Ping statistics for ${target}:`,
    `    Packets: Sent = 4, Received = ${r.denied ? 4 : received}, Lost = ${lost} (${lost === 0 ? 0 : 100}% loss),`,
    ...(r.success ? ['Approximate round trip times in milli-seconds:', '    Minimum = 0ms, Maximum = 1ms, Average = 0ms'] : []),
  ];
}

function tracert(network: NetworkState, h: HostState, rawTarget: string): string[] {
  if (!isAddress(rawTarget)) return [`Unable to resolve target system name ${rawTarget}.`];
  const target = canon(rawTarget);
  const r = ping(network, h.id, target);
  const out = [`Tracing route to ${target} over a maximum of 30 hops`, ''];
  r.hops.forEach((hop, i) => out.push(`  ${String(i + 1).padStart(2)}    <1 ms    <1 ms    <1 ms  ${hop.ip ?? nodeName(network, hop.node)}`));
  if (!r.success) out.push(r.denied ? `  ${String(r.hops.length + 1).padStart(2)}  ${r.denied.ip ?? 'router'}  reports: Destination net unreachable.` : `  ${String(r.hops.length + 1).padStart(2)}     *        *        *     Request timed out.`);
  out.push('', 'Trace complete.');
  return out;
}

const HELP = [
  'Available commands:',
  "  ipconfig          Show this PC's IP address, mask and gateway",
  '  ipconfig /all     Show DHCP and DNS details as well',
  '  ipconfig /renew   Request an address from a DHCP server',
  '  ipconfig /release Give the DHCP address back',
  '  ping <ip>         Send 4 echo requests to an address',
  '  tracert <ip>      Trace the routers on the path to an address',
  '  curl [options] <url>',
  '                    Call a RESTCONF API: -k (accept a self-signed certificate),',
  "                    -u user:pass, -X GET|PATCH|PUT, -H 'Header: value',",
  "                    -d '<json body>', -i (show the response headers)",
  '  cls               Clear the screen',
  '  help              Show this list',
];

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

function curl(network: NetworkState, h: HostState, args: string[]): string[] {
  const o = parseCurl(args);
  if (typeof o === 'string') return [o, "curl: try 'curl --help' for more information"];
  const m = o.url!.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i);
  if (!m) return [`curl: (3) URL rejected: ${o.url}`];
  const scheme = m[1].toLowerCase() as 'http' | 'https';
  const target = m[2];
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  const path = m[4] ?? '/';
  if (!isValidIp(target)) return [`curl: (6) Could not resolve host: ${target}`];
  const r = forward(network, h.id, target, { protocol: 'tcp', dstPort: port }, { record: false });
  if (!r.reached) return [`curl: (28) Failed to connect to ${target} port ${port} after 21003 ms: Timeout was reached`];
  const dev = Object.values(network.devices).find((d) => Object.values(d.interfaces).some((i) => i.ipAddress === target && ifaceUp(network, d.id, i.name)));
  const listening = dev && (scheme === 'https' ? dev.httpSecureServer && port === 443 : dev.httpServer && port === 80);
  if (!dev || !listening) return [`curl: (7) Failed to connect to ${target} port ${port} after 2 ms: Connection refused`];
  if (scheme === 'https' && !o.insecure) return ['curl: (60) SSL certificate problem: self-signed certificate', 'More details here: https://curl.se/docs/sslcerts.html', '', 'curl failed to verify the legitimacy of the server and therefore could not', 'establish a secure connection to it. To learn more about this situation and', 'how to fix it, please visit the webpage mentioned above.'];
  const res = restconfRequest(network, dev.id, { method: o.method, path, body: o.body, user: o.user, password: o.password });
  const out: string[] = [];
  if (o.include) {
    out.push(`HTTP/1.1 ${res.status} ${statusText(res.status)}`, 'Server: nginx', 'Date: Thu, 11 Sep 2026 09:00:00 GMT');
    if (res.body !== undefined) out.push(`Content-Type: ${typeof res.body === 'string' ? 'text/html' : 'application/yang-data+json'}`);
    if (res.status === 401) out.push('WWW-Authenticate: Basic realm="level_15_access"');
    out.push('');
  }
  out.push(...pretty(res.body));
  return out;
}

/** Execute one line typed at a host. Returns a new network; the input is never mutated. */
export function executeHost(prev: NetworkState, hostId: string, rawLine: string): HostExecResult {
  const network = structuredClone(prev);
  const h = network.hosts[hostId];
  if (!h) throw new Error(`No host "${hostId}" in network`);
  const line = rawLine.trim();
  if (!line) return { network, output: [] };
  h.commandHistory.push(line);
  const [cmd, ...args] = splitArgs(line);
  const c = cmd.toLowerCase();
  const opt = args[0]?.toLowerCase();
  let output: string[];
  if (c === 'ipconfig') {
    if (!opt) output = ipconfig(h, false);
    else if (opt === '/all') output = ipconfig(h, true);
    else if (opt === '/renew') output = renew(network, h);
    else if (opt === '/release') output = release(network, h);
    else output = [`Error: unrecognized or incomplete command line.`, '', 'USAGE: ipconfig [/all | /renew | /release]'];
  } else if (c === 'ping') output = args[0] ? pingOut(network, h, args[args.length - 1]) : ['Usage: ping <ip>'];
  else if (c === 'tracert' || c === 'traceroute') output = args[0] ? tracert(network, h, args[args.length - 1]) : ['Usage: tracert <ip>'];
  else if (c === 'curl') output = curl(network, h, args);
  else if (c === 'help' || c === '?') output = HELP;
  else if (c === 'cls' || c === 'clear') output = [];
  else output = [`'${cmd}' is not recognized as an internal or external command,`, 'operable program or batch file.'];
  return { network, output: output.length ? [...output, ''] : [] };
}
