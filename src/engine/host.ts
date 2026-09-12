/**
 * A minimal PC terminal: ipconfig (with /all, /renew and /release), ping and tracert
 * with Windows-style output.
 */
import { applyAclHits, dhcpRelease, dhcpRequest, hostLinkLocal, ping, type HostState, type NetworkState, nodeName } from './network';
import { isValidIp } from './ios/net';
import { isIpv6, normalizeIpv6 } from './ipv6';
import { curl, splitArgs } from './curl';
import { applyPythonResult, executeLinux, linuxMaskedInput, linuxPrompt, type LinuxExecResult, type PythonResult } from './linux';
import type { PendingPython } from './linux/shell';

function isAddress(text: string): boolean {
  return isValidIp(text) || isIpv6(text);
}

function canon(text: string): string {
  return isIpv6(text) ? normalizeIpv6(text)! : text;
}

export interface HostExecResult {
  network: NetworkState;
  output: string[];
  /** A Linux host wants python3 to run asynchronously; see applyPythonResult. */
  pending?: PendingPython;
}

export type { PythonResult, LinuxExecResult };
export { applyPythonResult };

export function hostPrompt(host: HostState): string {
  if (host.os === 'linux' && host.linux) return linuxPrompt(host);
  return `${host.name}> `;
}

/** True while the host expects a password rather than a command (terminal should mask input). */
export function hostMaskedInput(host: HostState): boolean {
  return host.os === 'linux' ? linuxMaskedInput(host) : false;
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

/** Execute one line typed at a host. Returns a new network; the input is never mutated. */
export function executeHost(prev: NetworkState, hostId: string, rawLine: string): HostExecResult {
  if (prev.hosts[hostId]?.os === 'linux') return executeLinux(prev, hostId, rawLine);
  const network = structuredClone(prev);
  const h = network.hosts[hostId];
  if (!h) throw new Error(`No host "${hostId}" in network`);
  const line = rawLine.trim();
  if (!line) return { network, output: [] };
  h.commandHistory.push(line);
  const [cmd, ...args] = splitArgs(line);
  /** Cleared by any branch that could not carry the command out. */
  let accepted = true;
  const c = cmd.toLowerCase();
  const opt = args[0]?.toLowerCase();
  let output: string[];
  if (c === 'ipconfig') {
    if (!opt) output = ipconfig(h, false);
    else if (opt === '/all') output = ipconfig(h, true);
    else if (opt === '/renew') output = renew(network, h);
    else if (opt === '/release') output = release(network, h);
    else {
      accepted = false;
      output = [`Error: unrecognized or incomplete command line.`, '', 'USAGE: ipconfig [/all | /renew | /release]'];
    }
  } else if (c === 'ping') {
    accepted = Boolean(args[0]);
    output = accepted ? pingOut(network, h, args[args.length - 1]) : ['Usage: ping <ip>'];
  } else if (c === 'tracert' || c === 'traceroute') {
    accepted = Boolean(args[0]);
    output = accepted ? tracert(network, h, args[args.length - 1]) : ['Usage: tracert <ip>'];
  }
  else if (c === 'curl') output = curl(network, h, args).output;
  else if (c === 'help' || c === '?') output = HELP;
  else if (c === 'cls' || c === 'clear') output = [];
  else {
    accepted = false;
    output = [`'${cmd}' is not recognized as an internal or external command,`, 'operable program or batch file.'];
  }
  if (accepted) (h.acceptedHistory ??= []).push(line);
  return { network, output: output.length ? [...output, ''] : [] };
}
