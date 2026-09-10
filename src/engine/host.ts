/**
 * A minimal PC terminal: ipconfig, ping and tracert with Windows-style output.
 */
import { ping, type HostState, type NetworkState, nodeName } from './network';
import { isValidIp } from './ios/net';

export interface HostExecResult {
  network: NetworkState;
  output: string[];
}

export function hostPrompt(host: HostState): string {
  return `${host.name}> `;
}

function ipconfig(h: HostState): string[] {
  return [
    'Windows IP Configuration', '', 'Ethernet adapter Ethernet0:', '',
    '   Connection-specific DNS Suffix  . :',
    `   Physical Address. . . . . . . . . : ${h.mac.replace(/\./g, '').match(/.{2}/g)!.join('-').toUpperCase()}`,
    `   IPv4 Address. . . . . . . . . . . : ${h.ip ?? '(none)'}`,
    `   Subnet Mask . . . . . . . . . . . : ${h.mask ?? '(none)'}`,
    `   Default Gateway . . . . . . . . . : ${h.gateway ?? ''}`,
  ];
}

function pingOut(network: NetworkState, h: HostState, target: string): string[] {
  if (!isValidIp(target)) return [`Ping request could not find host ${target}. Please check the name and try again.`];
  const r = ping(network, h.id, target);
  h.pings.push({ target, success: r.success });
  if (!r.success && (r.reason === 'no ip address' || r.reason === 'no gateway')) return ['PING: transmit failed. General failure.'];
  const routerHops = Math.max(0, r.hops.length - 1);
  const ttl = 128 - routerHops;
  const reply = r.success ? `Reply from ${target}: bytes=32 time<1ms TTL=${ttl}` : 'Request timed out.';
  const received = r.success ? 4 : 0;
  return [
    `Pinging ${target} with 32 bytes of data:`,
    reply, reply, reply, reply,
    '',
    `Ping statistics for ${target}:`,
    `    Packets: Sent = 4, Received = ${received}, Lost = ${4 - received} (${r.success ? 0 : 100}% loss),`,
    ...(r.success ? ['Approximate round trip times in milli-seconds:', '    Minimum = 0ms, Maximum = 1ms, Average = 0ms'] : []),
  ];
}

function tracert(network: NetworkState, h: HostState, target: string): string[] {
  if (!isValidIp(target)) return [`Unable to resolve target system name ${target}.`];
  const r = ping(network, h.id, target);
  const out = [`Tracing route to ${target} over a maximum of 30 hops`, ''];
  r.hops.forEach((hop, i) => out.push(`  ${String(i + 1).padStart(2)}    <1 ms    <1 ms    <1 ms  ${hop.ip ?? nodeName(network, hop.node)}`));
  if (!r.success) out.push(`  ${String(r.hops.length + 1).padStart(2)}     *        *        *     Request timed out.`);
  out.push('', 'Trace complete.');
  return out;
}

const HELP = [
  'Available commands:',
  '  ipconfig          Show this PC\'s IP address, mask and gateway',
  '  ping <ip>         Send 4 echo requests to an address',
  '  tracert <ip>      Trace the routers on the path to an address',
  '  cls               Clear the screen',
  '  help              Show this list',
];

/** Execute one line typed at a host. Returns a new network; the input is never mutated. */
export function executeHost(prev: NetworkState, hostId: string, rawLine: string): HostExecResult {
  const network = structuredClone(prev);
  const h = network.hosts[hostId];
  if (!h) throw new Error(`No host "${hostId}" in network`);
  const line = rawLine.trim();
  if (!line) return { network, output: [] };
  h.commandHistory.push(line);
  const [cmd, ...args] = line.split(/\s+/);
  const c = cmd.toLowerCase();
  let output: string[];
  if (c === 'ipconfig') output = ipconfig(h);
  else if (c === 'ping') output = args[0] ? pingOut(network, h, args[args.length - 1]) : ['Usage: ping <ip>'];
  else if (c === 'tracert' || c === 'traceroute') output = args[0] ? tracert(network, h, args[args.length - 1]) : ['Usage: tracert <ip>'];
  else if (c === 'help' || c === '?') output = HELP;
  else if (c === 'cls' || c === 'clear') output = [];
  else output = [`'${cmd}' is not recognized as an internal or external command,`, 'operable program or batch file.'];
  return { network, output: output.length ? [...output, ''] : [] };
}
