import type { CommandDef } from '../resolver';
import type { Acl, DeviceState, DeviceType, InterfaceState, Mode } from '../types';
import { isSvi, normalizeInterfaceName, shortInterfaceName, sviVlanId } from '../interfaces';
import { isExtendedNumber, isStandardNumber, nextSeq, parseExtendedRule, parseStandardRule } from '../acl';
import { applyAclHits, isLoopback, isSubinterface, macTable, nodeName, ospfInterfaceRole, ospfInterfaces, ospfNeighbors, ospfRouterId, parentInterface, ping as netPing, routingTable, type NetworkState } from '../network';
import { intToIp, ipToInt, isValidIp, isValidMask, networkAddress, parseVlanList } from './net';
import {
  defaultVlanName,
  renderConfigBody,
  showAccessLists,
  showHistory,
  showInterfaceSwitchport,
  showInterfacesStatus,
  showInterfacesTrunk,
  showIpDhcpBinding,
  showIpDhcpPool,
  showIpInterface,
  showIpInterfaceBrief,
  showIpOspf,
  showIpOspfInterfaceBrief,
  showIpOspfNeighbor,
  showIpProtocols,
  showIpRoute,
  showIpSsh,
  showMacAddressTable,
  showRunningConfig,
  showSpanningTree,
  showStartupConfig,
  showVersion,
  showVlanBrief,
} from './show';

export interface Ctx {
  state: DeviceState;
  network: NetworkState;
  nodeId: string;
}

export type Def = CommandDef<Ctx>;

export const INVALID_INPUT = "% Invalid input detected at '^' marker.";

/** Help shown next to keywords when the learner types "?". */
export const WORD_HELP: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the EXEC',
  end: 'Exit from configure mode',
  logout: 'Exit from the EXEC',
  show: 'Show running system information',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  help: 'Description of the interactive help system',
  configure: 'Enter configuration mode',
  copy: 'Copy from one file to another',
  write: 'Write running configuration to memory, network, or terminal',
  erase: 'Erase a filesystem',
  clear: 'Reset functions',
  terminal: 'Set terminal line parameters',
  reload: 'Halt and perform a cold restart',
  hostname: "Set system's network name",
  banner: 'Define a login banner',
  username: 'Establish User Name Authentication',
  line: 'Configure a terminal line',
  interface: 'Select an interface to configure',
  range: 'interface range command',
  vlan: 'Vlan commands',
  ip: 'Global IP configuration subcommands',
  crypto: 'Encryption module',
  service: 'Modify use of network based services',
  'spanning-tree': 'Spanning Tree Subsystem',
  'storm-control': 'Show packet storm control configuration',
  no: 'Negate a command or set its defaults',
  do: 'To run exec commands in config mode',
  description: 'Interface specific description',
  shutdown: 'Shutdown the selected interface',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  native: 'Set trunking native characteristics when interface is in trunking mode',
  encapsulation: 'Set the encapsulation type for an interface',
  dot1q: 'IEEE 802.1Q Virtual LAN',
  address: 'Set the IP address of an interface',
  route: 'Establish static routes',
  routing: 'Enable IP routing',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  'domain-name': 'Define the default domain name',
  ssh: 'Configure ssh options',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  secret: 'Assign the privileged level secret',
  privilege: 'Set user privilege level',
  motd: 'Set Message of the Day banner',
  memory: 'Write to NV memory',
  input: 'Define which protocols to use when connecting to the terminal server',
  brief: 'Brief summary of IP status and configuration',
  status: 'Show interface line status',
  local: 'Local password checking',
  speed: 'Configure speed operation.',
  duplex: 'Configure duplex operation.',
  name: 'Ascii name of the VLAN',
  password: 'Set a password',
  login: 'Enable password checking',
  transport: 'Define transport protocols for line',
  'exec-timeout': 'Set the EXEC timeout',
  logging: 'Modify message logging facilities',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  interfaces: 'Interface status and configuration',
  version: 'System hardware and software status',
  mac: 'MAC configuration',
  history: 'Display the session command history',
  users: 'Display information about terminal lines',
  static: 'Static routes',
  router: 'Enable a routing process',
  ospf: 'Open Shortest Path First (OSPF)',
  'router-id': 'router-id for this OSPF process',
  network: 'Enable routing on an IP network',
  area: 'Set the OSPF area ID',
  'passive-interface': 'Suppress routing updates on an interface',
  'default-information': 'Control distribution of default information',
  originate: 'Distribute a default route',
  cost: 'Interface cost',
  priority: 'Router priority',
  neighbor: 'Neighbor list',
  protocols: 'IP routing protocol process parameters and statistics',
  'access-list': 'Add an access list entry',
  'access-lists': 'List access lists',
  'access-group': 'Specify access control for packets',
  'access-class': 'Filter connections based on an IP access list',
  standard: 'Standard Access List',
  extended: 'Extended Access List',
  permit: 'Specify packets to forward',
  deny: 'Specify packets to reject',
  remark: 'Access list entry comment',
  in: 'inbound packets',
  out: 'outbound packets',
  dhcp: 'Configure DHCP server and relay parameters',
  pool: 'Configure DHCP address pools',
  'excluded-address': 'Prevent DHCP from assigning certain addresses',
  'default-router': 'Default routers',
  'dns-server': 'DNS servers',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  binding: 'DHCP address bindings',
  lease: 'Address lease time',
};

// ---------------------------------------------------------------------------
// helpers

function currentInterface(state: DeviceState): InterfaceState {
  return state.interfaces[state.currentInterface!];
}

/** All interfaces the current interface command applies to (one, or a range). */
function targetInterfaces(state: DeviceState): InterfaceState[] {
  const names = state.currentInterfaces?.length ? state.currentInterfaces : [state.currentInterface!];
  return names.map((n) => state.interfaces[n]);
}

/** Run an interface command against every targeted interface, concatenating output. */
function forEachTarget(state: DeviceState, fn: (i: InterfaceState) => string[] | void): string[] | void {
  const out: string[] = [];
  for (const i of targetInterfaces(state)) {
    const r = fn(i);
    if (r) out.push(...r);
  }
  return out.length ? out : undefined;
}

/**
 * Parse an "interface range" spec such as "g0/3 - 7", "g0/3-7", "gi0/3 - gi0/7" or "g0/1 , g0/3".
 * Returns canonical names, or null when any part is invalid or unknown.
 */
export function parseInterfaceRange(state: DeviceState, spec: string): string[] | null {
  const names: string[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\S+?)\s*-\s*(\S+)$/);
    if (!m) {
      const single = normalizeInterfaceName(part);
      if (!single || !state.interfaces[single]) return null;
      names.push(single);
      continue;
    }
    const start = normalizeInterfaceName(m[1]);
    if (!start) return null;
    const startMatch = start.match(/^(.*?)(\d+)$/);
    if (!startMatch) return null;
    const [, prefix, from] = startMatch;
    let to: number;
    if (/^\d+$/.test(m[2])) to = Number(m[2]);
    else {
      const end = normalizeInterfaceName(m[2]);
      const endMatch = end?.match(/^(.*?)(\d+)$/);
      if (!end || !endMatch || endMatch[1] !== prefix) return null;
      to = Number(endMatch[2]);
    }
    if (to < Number(from)) return null;
    for (let n = Number(from); n <= to; n++) {
      const name = `${prefix}${n}`;
      if (!state.interfaces[name]) return null;
      names.push(name);
    }
  }
  return names.length ? [...new Set(names)] : null;
}

function ensureVlan(state: DeviceState, id: number) {
  if (!state.vlans[id]) state.vlans[id] = { id, name: defaultVlanName(id) };
}

function linkChange(iface: InterfaceState, up: boolean): string[] {
  const ts = '*Mar  1 00:14:22.104';
  return up
    ? [`${ts}: %LINK-3-UPDOWN: Interface ${iface.name}, changed state to up`, `${ts}: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to up`]
    : [`${ts}: %LINK-5-CHANGED: Interface ${iface.name}, changed state to administratively down`, `${ts}: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to down`];
}

function findInterface(state: DeviceState, text: string): InterfaceState | null {
  const name = normalizeInterfaceName(text);
  if (!name) return null;
  return state.interfaces[name] ?? null;
}

function blankInterface(name: string, connected: boolean): InterfaceState {
  return { name, shutdown: false, connected, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
}

function selectInterface(state: DeviceState, name: string) {
  state.mode = 'interface';
  state.currentInterface = name;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

function enterInterface(state: DeviceState, text: string): string[] | void {
  const name = normalizeInterfaceName(text);
  if (!name) return [INVALID_INPUT];
  if (state.interfaces[name]) return selectInterface(state, name);

  if (state.deviceType === 'switch') {
    if (!isSvi(name)) return [INVALID_INPUT];
    const vid = sviVlanId(name)!;
    if (vid < 1 || vid > 4094) return [INVALID_INPUT];
    const svi = blankInterface(name, true);
    svi.accessVlan = vid;
    state.interfaces[name] = svi;
    return selectInterface(state, name);
  }

  // Routers can create loopbacks and dot1Q subinterfaces on the fly.
  if (isLoopback(name)) {
    state.interfaces[name] = blankInterface(name, true);
    return selectInterface(state, name);
  }
  if (isSubinterface(name)) {
    const parent = state.interfaces[parentInterface(name)];
    if (!parent || isLoopback(parent.name) || isSvi(parent.name)) return [INVALID_INPUT];
    state.interfaces[name] = blankInterface(name, parent.connected);
    return selectInterface(state, name);
  }
  return [INVALID_INPUT];
}

function enterInterfaceRange(state: DeviceState, spec: string): string[] | void {
  const names = parseInterfaceRange(state, spec);
  if (!names) return [INVALID_INPUT];
  state.mode = 'interface';
  state.currentInterface = names[0];
  state.currentInterfaces = names;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

function enterVlan(state: DeviceState, text: string): string[] | void {
  const id = Number(text);
  if (!/^\d+$/.test(text) || id < 1 || id > 4094) return ['% Bad VLAN list - character #1 is a non-numeric character.'];
  if (id >= 1002 && id <= 1005) return [`% Default VLAN ${id} may not be modified.`];
  ensureVlan(state, id);
  state.mode = 'vlan';
  state.currentVlan = id;
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentLine = undefined;
}

function enterLine(state: DeviceState, line: 'con' | 'vty') {
  state.mode = 'line';
  state.currentLine = line;
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
}

function pingCommand({ state, network, nodeId }: Ctx, target: string): string[] {
  if (!isValidIp(target)) return ['% Unrecognized host or address, or protocol not running.'];
  const result = netPing(network, nodeId, target);
  applyAclHits(network, result.hits);
  state.pings.push({ target, success: result.success, ...(result.denied ? { denied: true } : {}) });
  return [
    'Type escape sequence to abort.',
    `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
    result.success ? '!!!!!' : result.denied ? 'U.U.U' : '.....',
    result.success ? 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms' : 'Success rate is 0 percent (0/5)',
  ];
}

function tracerouteCommand({ network, nodeId }: Ctx, target: string): string[] {
  if (!isValidIp(target)) return ['% Unrecognized host or address, or protocol not running.'];
  const result = netPing(network, nodeId, target);
  const out = ['Type escape sequence to abort.', `Tracing the route to ${target}`, 'VRF info: (vrf in name/id, vrf out name/id)'];
  result.hops.forEach((h, i) => out.push(`  ${String(i + 1).padStart(2)} ${h.ip ?? nodeName(network, h.node)} 1 msec 1 msec 2 msec`));
  if (!result.success) out.push(result.denied ? `  ${String(result.hops.length + 1).padStart(2)} ${result.denied.ip ?? nodeName(network, result.denied.node)} !A  !A  !A` : `  ${String(result.hops.length + 1).padStart(2)}  *  *  *`);
  return out;
}

// ---------------------------------------------------------------------------
// access lists

function aclKindForNumber(n: number): Acl['kind'] | null {
  if (isStandardNumber(n)) return 'standard';
  if (isExtendedNumber(n)) return 'extended';
  return null;
}

function addAclRule(state: DeviceState, name: string, kind: Acl['kind'], action: 'permit' | 'deny', ruleText: string, seq?: number): string[] | void {
  const acl = (state.acls[name] ??= { name, kind, entries: [] });
  if (acl.kind !== kind) return ['% Access list type mismatch'];
  const tokens = ruleText.trim().split(/\s+/);
  const parsed = kind === 'standard' ? parseStandardRule(action, tokens) : parseExtendedRule(action, tokens);
  if (!parsed) return [INVALID_INPUT];
  const s = seq ?? nextSeq(acl);
  if (acl.entries.some((e) => e.seq === s)) return ['% Duplicate sequence number.'];
  acl.entries.push({ ...parsed, seq: s, matches: 0 });
  acl.entries.sort((a, b) => a.seq - b.seq);
}

function numberedAcl(state: DeviceState, numberText: string, action: 'permit' | 'deny' | 'remark', rest: string): string[] | void {
  const n = Number(numberText);
  const kind = /^\d+$/.test(numberText) ? aclKindForNumber(n) : null;
  if (!kind) return [INVALID_INPUT];
  if (action === 'remark') {
    const acl = (state.acls[numberText] ??= { name: numberText, kind, entries: [] });
    acl.entries.push({ seq: nextSeq(acl), action: 'remark', remark: rest, src: { kind: 'any' }, matches: 0 });
    return;
  }
  return addAclRule(state, numberText, kind, action, rest);
}

function enterNamedAcl(state: DeviceState, kind: Acl['kind'], name: string): string[] | void {
  if (/^\d+$/.test(name)) {
    const numberedKind = aclKindForNumber(Number(name));
    if (numberedKind !== kind) return [INVALID_INPUT];
  }
  const existing = state.acls[name];
  if (existing && existing.kind !== kind) return [`% Access list ${name} already exists as a ${existing.kind} list`];
  state.acls[name] ??= { name, kind, entries: [] };
  state.mode = kind === 'standard' ? 'acl-std' : 'acl-ext';
  state.currentAcl = name;
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

function aclModeDefs(kind: Acl['kind'], jumps: Def[]): Def[] {
  const acl = (state: DeviceState) => state.acls[state.currentAcl!];
  return [
    { pattern: 'permit <rule...>', help: 'Specify packets to forward', run: ({ state }, a) => addAclRule(state, state.currentAcl!, kind, 'permit', a.rule) },
    { pattern: 'deny <rule...>', help: 'Specify packets to reject', run: ({ state }, a) => addAclRule(state, state.currentAcl!, kind, 'deny', a.rule) },
    { pattern: '<sequence> permit <rule...>', help: 'Sequence Number', run: ({ state }, a) => (/^\d+$/.test(a.sequence) ? addAclRule(state, state.currentAcl!, kind, 'permit', a.rule, Number(a.sequence)) : [INVALID_INPUT]) },
    { pattern: '<sequence> deny <rule...>', help: 'Sequence Number', run: ({ state }, a) => (/^\d+$/.test(a.sequence) ? addAclRule(state, state.currentAcl!, kind, 'deny', a.rule, Number(a.sequence)) : [INVALID_INPUT]) },
    { pattern: 'remark <text...>', help: 'Access list entry comment', run: ({ state }, a) => void acl(state).entries.push({ seq: nextSeq(acl(state)), action: 'remark', remark: a.text, src: { kind: 'any' }, matches: 0 }) },
    { pattern: 'no <sequence>', help: 'Remove an entry by sequence number', run: ({ state }, a) => { const s = Number(a.sequence); const list = acl(state); const before = list.entries.length; list.entries = list.entries.filter((e) => e.seq !== s); if (list.entries.length === before) return ['% Sequence number not found']; } },
    { pattern: 'exit', help: 'Exit from access-list configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentAcl = undefined; } },
    ...EXIT_CONFIG,
    ...jumps,
  ];
}

function applyAccessGroup(state: DeviceState, name: string, direction: 'in' | 'out'): string[] | void {
  if (state.currentInterfaces && state.currentInterfaces.length > 1) return [INVALID_INPUT];
  const i = currentInterface(state);
  if (isLoopback(i.name)) return ['% Access lists cannot be applied to loopback interfaces in this simulator.'];
  if (direction === 'in') i.aclIn = name;
  else i.aclOut = name;
}

// ---------------------------------------------------------------------------
// dhcp

function enterDhcpPool(state: DeviceState, name: string) {
  state.dhcpPools[name] ??= { name };
  state.mode = 'dhcp';
  state.currentPool = name;
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

function maskFromArg(text: string): string | null {
  if (text.startsWith('/')) {
    const n = Number(text.slice(1));
    if (!/^\d+$/.test(text.slice(1)) || n < 0 || n > 32) return null;
    return intToIp(n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0);
  }
  return isValidMask(text) ? text : null;
}

const dhcpConfigBase = (): Def[] => [
  {
    pattern: 'network <address> <mask>',
    help: 'Network number and mask',
    run: ({ state }, a) => {
      const mask = maskFromArg(a.mask);
      if (!isValidIp(a.address) || !mask) return [INVALID_INPUT];
      const pool = state.dhcpPools[state.currentPool!];
      pool.network = networkAddress(a.address, mask);
      pool.mask = mask;
    },
  },
  { pattern: 'no network', help: 'Remove the network', run: ({ state }) => { const p = state.dhcpPools[state.currentPool!]; p.network = undefined; p.mask = undefined; } },
  { pattern: 'default-router <address>', help: 'Default routers', run: ({ state }, a) => { if (!isValidIp(a.address)) return [INVALID_INPUT]; state.dhcpPools[state.currentPool!].defaultRouter = a.address; } },
  { pattern: 'no default-router', help: 'Remove the default router', run: ({ state }) => void (state.dhcpPools[state.currentPool!].defaultRouter = undefined) },
  { pattern: 'dns-server <addresses...>', help: 'DNS servers', run: ({ state }, a) => { const first = a.addresses.split(/\s+/)[0]; if (!isValidIp(first)) return [INVALID_INPUT]; state.dhcpPools[state.currentPool!].dnsServer = first; } },
  { pattern: 'no dns-server', help: 'Remove DNS servers', run: ({ state }) => void (state.dhcpPools[state.currentPool!].dnsServer = undefined) },
  { pattern: 'domain-name <name>', help: 'Domain name', run: ({ state }, a) => void (state.dhcpPools[state.currentPool!].domainName = a.name) },
  { pattern: 'lease <days>', help: 'Address lease time', run: () => undefined },
  { pattern: 'lease <days> <hours>', help: 'Address lease time', run: () => undefined },
  { pattern: 'lease <days> <hours> <minutes>', help: 'Address lease time', run: () => undefined },
  { pattern: 'lease infinite', help: 'Infinite lease', run: () => undefined },
  { pattern: 'exit', help: 'Exit from DHCP pool configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentPool = undefined; } },
  ...EXIT_CONFIG,
];

function excludeRange(state: DeviceState, from: string, to?: string): string[] | void {
  const end = to ?? from;
  if (!isValidIp(from) || !isValidIp(end) || (ipToInt(from) ?? 0) > (ipToInt(end) ?? 0)) return [INVALID_INPUT];
  state.dhcpExcluded = state.dhcpExcluded.filter((r) => !(r.from === from && r.to === end));
  state.dhcpExcluded.push({ from, to: end });
}

function unexcludeRange(state: DeviceState, from: string, to?: string): string[] | void {
  const end = to ?? from;
  const before = state.dhcpExcluded.length;
  state.dhcpExcluded = state.dhcpExcluded.filter((r) => !(r.from === from && r.to === end));
  if (state.dhcpExcluded.length === before) return ['% No such excluded range'];
}

const HELP_TEXT = [
  'Help may be requested at any point in a command by entering',
  "a question mark '?'.  If nothing matches, the help list will",
  "be empty and you must backup until entering a '?' shows the",
  'available options.',
  'Two styles of help are provided:',
  '1. Full help is available when you are ready to enter a',
  "   command argument (e.g. 'show ?') and describes each possible",
  '   argument.',
  '2. Partial help is provided when an abbreviated argument is entered',
  '   and you want to know what arguments match the input',
  "   (e.g. 'show pr?'.)",
];

// ---------------------------------------------------------------------------
// exec mode commands

const SHOW_COMMON_USER: Def[] = [
  { pattern: 'show version', help: 'System hardware and software status', run: ({ state }) => showVersion(state) },
  { pattern: 'show ip interface brief', help: 'Brief summary of IP status and configuration', run: ({ state }) => showIpInterfaceBrief(state) },
  { pattern: 'show history', help: 'Display the session command history', run: ({ state }) => showHistory(state) },
  { pattern: 'show users', help: 'Display information about terminal lines', run: () => ['    Line       User       Host(s)              Idle       Location', '*  0 con 0                idle                 00:00:00'] },
];

const SHOW_SWITCH_USER: Def[] = [
  ...SHOW_COMMON_USER,
  { pattern: 'show vlan brief', help: 'VTP all VLAN status in brief', run: ({ state }) => showVlanBrief(state) },
  { pattern: 'show vlan', help: 'VTP VLAN status', run: ({ state }) => showVlanBrief(state) },
  { pattern: 'show interfaces status', help: 'Show interface line status', run: ({ state }) => showInterfacesStatus(state) },
  { pattern: 'show interfaces trunk', help: 'Show interface trunk information', run: ({ state }) => showInterfacesTrunk(state) },
  {
    pattern: 'show interfaces <interface> switchport',
    help: 'Show interface switchport information',
    run: ({ state }, a) => {
      const i = findInterface(state, a.interface);
      if (!i || isSvi(i.name)) return [INVALID_INPUT];
      return showInterfaceSwitchport(state, i);
    },
  },
  { pattern: 'show mac address-table', help: 'MAC forwarding table', run: ({ network, nodeId }) => showMacAddressTable(macTable(network, nodeId)) },
  { pattern: 'show spanning-tree', help: 'Spanning tree topology', run: ({ state }) => showSpanningTree(state) },
  { pattern: 'show storm-control', help: 'Show packet storm control configuration', run: () => ['Interface  Filter State   Upper        Lower        Current'] },
  {
    pattern: 'show ip route',
    help: 'IP routing table',
    run: ({ state }) => [`Default gateway is ${state.ipDefaultGateway ?? 'not set'}`, '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty'],
  },
];

function ospfBrief(ctx: Ctx): string[] {
  const { state, network, nodeId } = ctx;
  if (!state.ospf) return ['%OSPF: No router process configured'];
  const rows = ospfInterfaces(network, nodeId).map((info) => ({ info, ...ospfInterfaceRole(network, nodeId, info) }));
  return showIpOspfInterfaceBrief(state.ospf.processId, rows);
}

const SHOW_ROUTER_USER: Def[] = [
  ...SHOW_COMMON_USER,
  { pattern: 'show ip route', help: 'IP routing table', run: ({ network, nodeId }) => showIpRoute(routingTable(network, nodeId)) },
  { pattern: 'show ip route static', help: 'Static routes', run: ({ network, nodeId }) => showIpRoute(routingTable(network, nodeId).filter((e) => e.source === 'static')) },
  { pattern: 'show ip route ospf', help: 'Open Shortest Path First (OSPF)', run: ({ network, nodeId }) => showIpRoute(routingTable(network, nodeId).filter((e) => e.source === 'ospf' || e.source === 'ospf-external')) },
  { pattern: 'show ip ospf neighbor', help: 'Neighbor list', run: ({ state, network, nodeId }) => (state.ospf ? showIpOspfNeighbor(ospfNeighbors(network, nodeId)) : ['%OSPF: No router process configured']) },
  { pattern: 'show ip ospf interface brief', help: 'Brief summary of OSPF interfaces', run: (ctx) => ospfBrief(ctx) },
  { pattern: 'show ip ospf interface', help: 'Interface information', run: (ctx) => ospfBrief(ctx) },
  { pattern: 'show ip ospf', help: 'OSPF information', run: ({ state, network, nodeId }) => (state.ospf ? showIpOspf(state, ospfRouterId(network, nodeId), ospfInterfaces(network, nodeId), ospfNeighbors(network, nodeId)) : ['%OSPF: No router process configured']) },
  { pattern: 'show ip protocols', help: 'IP routing protocol process parameters and statistics', run: ({ state, network, nodeId }) => showIpProtocols(state, ospfRouterId(network, nodeId), ospfInterfaces(network, nodeId), ospfNeighbors(network, nodeId)) },
  { pattern: 'show access-lists', help: 'List access lists', run: ({ state }) => showAccessLists(Object.values(state.acls)) },
  { pattern: 'show access-lists <name>', help: 'Access list name or number', run: ({ state }, a) => (state.acls[a.name] ? showAccessLists([state.acls[a.name]]) : []) },
  { pattern: 'show ip access-lists', help: 'List IP access lists', run: ({ state }) => showAccessLists(Object.values(state.acls)) },
  { pattern: 'show ip access-lists <name>', help: 'Access list name or number', run: ({ state }, a) => (state.acls[a.name] ? showAccessLists([state.acls[a.name]]) : []) },
  { pattern: 'show ip dhcp binding', help: 'DHCP address bindings', run: ({ state }) => showIpDhcpBinding(state) },
  { pattern: 'show ip dhcp pool', help: 'DHCP pool information', run: ({ state }) => showIpDhcpPool(state) },
  {
    pattern: 'show ip interface <interface>',
    help: 'IP interface status and configuration',
    run: ({ state }, a) => {
      const i = findInterface(state, a.interface);
      return i ? showIpInterface(i) : [INVALID_INPUT];
    },
  },
  {
    pattern: 'show interfaces <interface>',
    help: 'Interface status and configuration',
    run: ({ state }, a) => {
      const i = findInterface(state, a.interface);
      if (!i) return [INVALID_INPUT];
      const line = i.shutdown ? 'administratively down, line protocol is down' : i.connected ? 'up, line protocol is up' : 'down, line protocol is down';
      return [`${i.name} is ${line}`, `  Hardware is iGbE, address is ${state.id.toLowerCase().padEnd(4, '0').slice(0, 4)}.0000.0001`, ...(i.description ? [`  Description: ${i.description}`] : []), `  Internet address is ${i.ipAddress && i.subnetMask ? `${i.ipAddress}/${prefixOf(i.subnetMask)}` : 'not set'}`, '  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,', '  Encapsulation ARPA, loopback not set'];
    },
  },
];

function prefixOf(mask: string): number {
  return mask.split('.').reduce((acc, o) => acc + Number(o).toString(2).replace(/0/g, '').length, 0);
}

const SHOW_PRIV_EXTRA: Def[] = [
  { pattern: 'show running-config', help: 'Current operating configuration', run: ({ state }) => showRunningConfig(state) },
  { pattern: 'show startup-config', help: 'Contents of startup configuration', run: ({ state }) => showStartupConfig(state) },
  { pattern: 'show ip ssh', help: 'Information on SSH', run: ({ state }) => showIpSsh(state) },
];

function userExec(show: Def[]): Def[] {
  return [
    {
      pattern: 'enable',
      help: 'Turn on privileged commands',
      run: ({ state }) => {
        if (state.enableSecret || state.enablePassword) {
          state.pendingInput = { kind: 'enable-password', attempts: 0 };
          return;
        }
        state.mode = 'privileged';
      },
    },
    { pattern: 'exit', help: 'Exit from the EXEC', run: () => undefined },
    { pattern: 'logout', help: 'Exit from the EXEC', run: () => undefined },
    { pattern: 'help', help: 'Description of the interactive help system', run: () => HELP_TEXT },
    { pattern: 'ping <target>', help: 'Send echo messages', run: (ctx, a) => pingCommand(ctx, a.target) },
    { pattern: 'traceroute <target>', help: 'Trace route to destination', run: (ctx, a) => tracerouteCommand(ctx, a.target) },
    { pattern: 'terminal length <lines>', help: 'Set number of lines on a screen', run: () => undefined },
    ...show,
  ];
}

function saveConfig(state: DeviceState): string[] {
  state.startupConfig = renderConfigBody(state).join('\n');
  return ['Building configuration...', '[OK]'];
}

function privExec(show: Def[]): Def[] {
  return [
    { pattern: 'disable', help: 'Turn off privileged commands', run: ({ state }) => void (state.mode = 'user') },
    { pattern: 'exit', help: 'Exit from the EXEC', run: ({ state }) => void (state.mode = 'user') },
    { pattern: 'logout', help: 'Exit from the EXEC', run: ({ state }) => void (state.mode = 'user') },
    { pattern: 'enable', help: 'Turn on privileged commands', run: () => undefined },
    { pattern: 'help', help: 'Description of the interactive help system', run: () => HELP_TEXT },
    { pattern: 'configure terminal', help: 'Configure from the terminal', run: ({ state }) => { state.mode = 'config'; return ['Enter configuration commands, one per line.  End with CNTL/Z.']; } },
    { pattern: 'write', help: 'Write running configuration to memory', run: ({ state }) => saveConfig(state) },
    { pattern: 'write memory', help: 'Write to NV memory', run: ({ state }) => saveConfig(state) },
    { pattern: 'copy running-config startup-config', help: 'Copy from current system configuration', run: ({ state }) => ['Destination filename [startup-config]? ', ...saveConfig(state)] },
    { pattern: 'erase startup-config', help: 'Erase contents of configuration memory', run: ({ state }) => { state.startupConfig = null; return ['Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', '[OK]', 'Erase of nvram: complete']; } },
    { pattern: 'clear mac address-table dynamic', help: 'dynamic entry type', run: () => undefined },
    { pattern: 'terminal length <lines>', help: 'Set number of lines on a screen', run: () => undefined },
    { pattern: 'ping <target>', help: 'Send echo messages', run: (ctx, a) => pingCommand(ctx, a.target) },
    { pattern: 'traceroute <target>', help: 'Trace route to destination', run: (ctx, a) => tracerouteCommand(ctx, a.target) },
    ...show,
    ...SHOW_PRIV_EXTRA,
  ];
}

export const USER_EXEC: Def[] = userExec(SHOW_SWITCH_USER);
export const PRIV_EXEC: Def[] = privExec(SHOW_SWITCH_USER);
export const USER_EXEC_ROUTER: Def[] = userExec(SHOW_ROUTER_USER);
export const PRIV_EXEC_ROUTER: Def[] = privExec(SHOW_ROUTER_USER);

// ---------------------------------------------------------------------------
// config modes

function leaveConfig(state: DeviceState) {
  state.mode = 'privileged';
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

const EXIT_CONFIG: Def[] = [{ pattern: 'end', help: 'Exit from configure mode', run: ({ state }) => leaveConfig(state) }];

/** Commands IOS lets you type from any config submode (it silently changes context). */
const COMMON_JUMPS: Def[] = [
  { pattern: 'interface range <spec...>', help: 'Select a range of interfaces to configure', run: ({ state }, a) => enterInterfaceRange(state, a.spec) },
  { pattern: 'interface <interface...>', help: 'Select an interface to configure', run: ({ state }, a) => enterInterface(state, a.interface.replace(/\s+/g, '')) },
  { pattern: 'line console <number>', help: 'Primary terminal line', run: ({ state }) => enterLine(state, 'con') },
  { pattern: 'line vty <first> <last>', help: 'Virtual terminal', run: ({ state }) => enterLine(state, 'vty') },
  { pattern: 'line vty <first>', help: 'Virtual terminal', run: ({ state }) => enterLine(state, 'vty') },
  { pattern: 'hostname <name>', help: "Set system's network name", run: ({ state }, a) => { if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(a.name)) return [INVALID_INPUT]; state.hostname = a.name; } },
];

const SWITCH_JUMPS: Def[] = [
  ...COMMON_JUMPS,
  { pattern: 'vlan <id>', help: 'Vlan commands', run: ({ state }, a) => enterVlan(state, a.id) },
  {
    pattern: 'no vlan <id>',
    help: 'Delete a VLAN',
    run: ({ state }, a) => {
      const id = Number(a.id);
      if (id === 1 || (id >= 1002 && id <= 1005)) return [`% Default VLAN ${id} may not be deleted.`];
      delete state.vlans[id];
      if (state.currentVlan === id) {
        state.mode = 'config';
        state.currentVlan = undefined;
      }
    },
  },
];

function setUser(state: DeviceState, username: string, password: string, secret: boolean, privilege: number) {
  const existing = state.users.find((u) => u.username === username);
  if (existing) Object.assign(existing, { password, secret, privilege });
  else state.users.push({ username, password, secret, privilege });
}

function parseBanner(text: string): string {
  const delim = text[0];
  const rest = text.slice(1);
  const end = rest.indexOf(delim);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function generateRsa(state: DeviceState, bits: number): string[] {
  if (!state.ipDomainName) return ['% Please define a domain-name first.'];
  if (![360, 512, 768, 1024, 2048, 4096].includes(bits)) return ['% Modulus size must be one of 360, 512, 768, 1024, 2048 or 4096.'];
  state.rsaKeyBits = bits;
  return [`The name for the keys will be: ${state.hostname}.${state.ipDomainName}`, `% The key modulus size is ${bits} bits`, `% Generating ${bits} bit RSA keys, keys will be non-exportable...`, '[OK] (elapsed time was 2 seconds)'];
}

const GLOBAL_COMMON: Def[] = [
  { pattern: 'no hostname', help: 'Reset the hostname', run: ({ state }) => void (state.hostname = state.deviceType === 'router' ? 'Router' : 'Switch') },
  { pattern: 'enable password <password...>', help: 'Assign the privileged level password', run: ({ state }, a) => void (state.enablePassword = a.password) },
  { pattern: 'enable secret <secret...>', help: 'Assign the privileged level secret', run: ({ state }, a) => void (state.enableSecret = a.secret) },
  { pattern: 'no enable password', help: 'Remove the privileged level password', run: ({ state }) => void (state.enablePassword = undefined) },
  { pattern: 'no enable secret', help: 'Remove the privileged level secret', run: ({ state }) => void (state.enableSecret = undefined) },
  { pattern: 'banner motd <text...>', help: 'Set Message of the Day banner', run: ({ state }, a) => void (state.bannerMotd = parseBanner(a.text)) },
  { pattern: 'no banner motd', help: 'Remove Message of the Day banner', run: ({ state }) => void (state.bannerMotd = undefined) },
  { pattern: 'username <name> password <password>', help: 'Specify the password for the user', run: ({ state }, a) => setUser(state, a.name, a.password, false, 1) },
  { pattern: 'username <name> secret <secret>', help: 'Specify the secret for the user', run: ({ state }, a) => setUser(state, a.name, a.secret, true, 1) },
  { pattern: 'username <name> privilege <level> password <password>', help: 'Set user privilege level', run: ({ state }, a) => setUser(state, a.name, a.password, false, Number(a.level)) },
  { pattern: 'username <name> privilege <level> secret <secret>', help: 'Set user privilege level', run: ({ state }, a) => setUser(state, a.name, a.secret, true, Number(a.level)) },
  { pattern: 'no username <name>', help: 'Remove a user', run: ({ state }, a) => void (state.users = state.users.filter((u) => u.username !== a.name)) },
  { pattern: 'ip domain-name <name>', help: 'Define the default domain name', run: ({ state }, a) => void (state.ipDomainName = a.name) },
  { pattern: 'no ip domain-name', help: 'Remove the default domain name', run: ({ state }) => void (state.ipDomainName = undefined) },
  { pattern: 'ip ssh version <version>', help: 'Specify protocol version to be supported', run: ({ state }, a) => { if (a.version !== '1' && a.version !== '2') return [INVALID_INPUT]; state.sshVersion = Number(a.version) as 1 | 2; } },
  { pattern: 'crypto key generate rsa', help: 'Generate RSA keys', run: ({ state }) => generateRsa(state, 1024) },
  { pattern: 'crypto key generate rsa modulus <bits>', help: 'Provide number of modulus bits on the command line', run: ({ state }, a) => generateRsa(state, Number(a.bits)) },
  { pattern: 'crypto key generate rsa general-keys modulus <bits>', help: 'Generate a general purpose RSA key pair', run: ({ state }, a) => generateRsa(state, Number(a.bits)) },
  { pattern: 'crypto key zeroize rsa', help: 'Remove RSA keys', run: ({ state }) => void (state.rsaKeyBits = undefined) },
  { pattern: 'service password-encryption', help: 'Encrypt system passwords', run: ({ state }) => void (state.servicePasswordEncryption = true) },
  { pattern: 'no service password-encryption', help: 'Stop encrypting system passwords', run: ({ state }) => void (state.servicePasswordEncryption = false) },
  { pattern: 'exit', help: 'Exit from configure mode', run: ({ state }) => leaveConfig(state) },
  ...EXIT_CONFIG,
];

export const GLOBAL_CONFIG: Def[] = [
  ...SWITCH_JUMPS,
  ...GLOBAL_COMMON,
  { pattern: 'ip default-gateway <address>', help: 'Specify default gateway (if not routing IP)', run: ({ state }, a) => { if (!isValidIp(a.address)) return [INVALID_INPUT]; state.ipDefaultGateway = a.address; } },
  { pattern: 'no ip default-gateway', help: 'Remove default gateway', run: ({ state }) => void (state.ipDefaultGateway = undefined) },
  { pattern: 'spanning-tree mode <mode>', help: 'Spanning tree operating mode', run: () => undefined },
];

function addStaticRoute(state: DeviceState, dest: string, mask: string, via: string, ad?: string): string[] | void {
  if (!isValidIp(dest) || !isValidMask(mask)) return [INVALID_INPUT];
  if (networkAddress(dest, mask) !== dest) return ['%Inconsistent address and mask'];
  const distance = ad === undefined ? 1 : Number(ad);
  if (ad !== undefined && (!/^\d+$/.test(ad) || distance < 1 || distance > 255)) return [INVALID_INPUT];
  let route: DeviceState['staticRoutes'][number];
  if (isValidIp(via)) route = { destination: dest, mask, nextHop: via, adminDistance: distance };
  else {
    const iface = normalizeInterfaceName(via);
    if (!iface || !state.interfaces[iface]) return [INVALID_INPUT];
    route = { destination: dest, mask, exitInterface: iface, adminDistance: distance };
  }
  state.staticRoutes = state.staticRoutes.filter((r) => !(r.destination === dest && r.mask === mask && r.nextHop === route.nextHop && r.exitInterface === route.exitInterface));
  state.staticRoutes.push(route);
}

function removeStaticRoute(state: DeviceState, dest: string, mask: string, via?: string): string[] | void {
  const before = state.staticRoutes.length;
  const iface = via && !isValidIp(via) ? normalizeInterfaceName(via) : null;
  state.staticRoutes = state.staticRoutes.filter((r) => {
    if (r.destination !== dest || r.mask !== mask) return true;
    if (via === undefined) return false;
    return !(r.nextHop === via || (iface !== null && r.exitInterface === iface));
  });
  if (state.staticRoutes.length === before) return ['%No matching route to delete'];
}

function enterRouterOspf(state: DeviceState, pidText: string): string[] | void {
  const pid = Number(pidText);
  if (!/^\d+$/.test(pidText) || pid < 1 || pid > 65535) return [INVALID_INPUT];
  if (state.ospf && state.ospf.processId !== pid) return [`% OSPF process ${state.ospf.processId} already exists; this simulator supports one process per router.`];
  if (!state.ospf) state.ospf = { processId: pid, networks: [], passiveDefault: false, passiveInterfaces: [], activeInterfaces: [], defaultInformationOriginate: false };
  state.mode = 'router';
  state.currentInterface = undefined;
  state.currentInterfaces = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

/** Commands available from any config submode on a router. */
const ROUTER_JUMPS: Def[] = [
  ...COMMON_JUMPS,
  { pattern: 'router ospf <process>', help: 'Open Shortest Path First (OSPF)', run: ({ state }, a) => enterRouterOspf(state, a.process) },
  { pattern: 'ip access-list standard <name>', help: 'Standard Access List', run: ({ state }, a) => enterNamedAcl(state, 'standard', a.name) },
  { pattern: 'ip access-list extended <name>', help: 'Extended Access List', run: ({ state }, a) => enterNamedAcl(state, 'extended', a.name) },
  { pattern: 'ip dhcp pool <name>', help: 'Configure DHCP address pools', run: ({ state }, a) => enterDhcpPool(state, a.name) },
];

export const ACL_STD_CONFIG: Def[] = aclModeDefs('standard', ROUTER_JUMPS);
export const ACL_EXT_CONFIG: Def[] = aclModeDefs('extended', ROUTER_JUMPS);
export const DHCP_CONFIG: Def[] = [...dhcpConfigBase(), ...ROUTER_JUMPS];

function parseArea(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (isValidIp(text)) return (ipToIntSafe(text) ?? 0) >>> 0;
  return null;
}

function ipToIntSafe(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export const ROUTER_CONFIG: Def[] = [
  { pattern: 'router-id <id>', help: 'router-id for this OSPF process', run: ({ state }, a) => { if (!isValidIp(a.id)) return [INVALID_INPUT]; state.ospf!.routerId = a.id; return ['Reload or use "clear ip ospf process" command, for this to take effect']; } },
  { pattern: 'no router-id', help: 'Remove the configured router-id', run: ({ state }) => void (state.ospf!.routerId = undefined) },
  {
    pattern: 'network <address> <wildcard> area <area>',
    help: 'Enable routing on an IP network',
    run: ({ state }, a) => {
      const area = parseArea(a.area);
      if (!isValidIp(a.address) || !isValidIp(a.wildcard) || area === null) return [INVALID_INPUT];
      const cfg = state.ospf!;
      cfg.networks = cfg.networks.filter((n) => !(n.address === a.address && n.wildcard === a.wildcard));
      cfg.networks.push({ address: a.address, wildcard: a.wildcard, area });
    },
  },
  {
    pattern: 'no network <address> <wildcard> area <area>',
    help: 'Disable routing on an IP network',
    run: ({ state }, a) => {
      const area = parseArea(a.area);
      const cfg = state.ospf!;
      const before = cfg.networks.length;
      cfg.networks = cfg.networks.filter((n) => !(n.address === a.address && n.wildcard === a.wildcard && n.area === area));
      if (cfg.networks.length === before) return ['%OSPF: No such network statement'];
    },
  },
  { pattern: 'passive-interface default', help: 'Suppress routing updates on all interfaces', run: ({ state }) => { state.ospf!.passiveDefault = true; state.ospf!.activeInterfaces = []; } },
  { pattern: 'no passive-interface default', help: 'Send routing updates on all interfaces', run: ({ state }) => { state.ospf!.passiveDefault = false; state.ospf!.passiveInterfaces = []; } },
  {
    pattern: 'passive-interface <interface...>',
    help: 'Suppress routing updates on an interface',
    run: ({ state }, a) => {
      const name = normalizeInterfaceName(a.interface.replace(/\s+/g, ''));
      if (!name || !state.interfaces[name]) return [INVALID_INPUT];
      const cfg = state.ospf!;
      if (cfg.passiveDefault) cfg.activeInterfaces = cfg.activeInterfaces.filter((i) => i !== name);
      else if (!cfg.passiveInterfaces.includes(name)) cfg.passiveInterfaces.push(name);
    },
  },
  {
    pattern: 'no passive-interface <interface...>',
    help: 'Send routing updates on an interface',
    run: ({ state }, a) => {
      const name = normalizeInterfaceName(a.interface.replace(/\s+/g, ''));
      if (!name || !state.interfaces[name]) return [INVALID_INPUT];
      const cfg = state.ospf!;
      if (cfg.passiveDefault) {
        if (!cfg.activeInterfaces.includes(name)) cfg.activeInterfaces.push(name);
      } else cfg.passiveInterfaces = cfg.passiveInterfaces.filter((i) => i !== name);
    },
  },
  { pattern: 'default-information originate', help: 'Distribute a default route', run: ({ state }) => void (state.ospf!.defaultInformationOriginate = true) },
  { pattern: 'no default-information originate', help: 'Stop distributing a default route', run: ({ state }) => void (state.ospf!.defaultInformationOriginate = false) },
  { pattern: 'exit', help: 'Exit from routing protocol configuration mode', run: ({ state }) => void (state.mode = 'config') },
  ...EXIT_CONFIG,
  ...ROUTER_JUMPS,
];

export const GLOBAL_CONFIG_ROUTER: Def[] = [
  ...ROUTER_JUMPS,
  ...GLOBAL_COMMON,
  { pattern: 'no router ospf <process>', help: 'Remove the OSPF process', run: ({ state }, a) => { if (!state.ospf || state.ospf.processId !== Number(a.process)) return ['%OSPF: Process not found']; state.ospf = undefined; } },
  { pattern: 'ip route <destination> <mask> <via>', help: 'Establish static routes', run: ({ state }, a) => addStaticRoute(state, a.destination, a.mask, a.via) },
  { pattern: 'ip route <destination> <mask> <via> <distance>', help: 'Distance metric for this route', run: ({ state }, a) => addStaticRoute(state, a.destination, a.mask, a.via, a.distance) },
  { pattern: 'no ip route <destination> <mask> <via>', help: 'Remove a static route', run: ({ state }, a) => removeStaticRoute(state, a.destination, a.mask, a.via) },
  { pattern: 'no ip route <destination> <mask>', help: 'Remove static routes to a destination', run: ({ state }, a) => removeStaticRoute(state, a.destination, a.mask) },
  { pattern: 'ip routing', help: 'Enable IP routing', run: ({ state }) => void (state.ipRouting = true) },
  { pattern: 'no ip routing', help: 'Disable IP routing', run: ({ state }) => void (state.ipRouting = false) },
  { pattern: 'ip cef', help: 'Cisco Express Forwarding', run: () => undefined },
  { pattern: 'no ip domain-lookup', help: 'Disable DNS lookups', run: () => undefined },
  { pattern: 'access-list <number> permit <rule...>', help: 'Specify packets to forward', run: ({ state }, a) => numberedAcl(state, a.number, 'permit', a.rule) },
  { pattern: 'access-list <number> deny <rule...>', help: 'Specify packets to reject', run: ({ state }, a) => numberedAcl(state, a.number, 'deny', a.rule) },
  { pattern: 'access-list <number> remark <text...>', help: 'Access list entry comment', run: ({ state }, a) => numberedAcl(state, a.number, 'remark', a.text) },
  { pattern: 'no access-list <number>', help: 'Remove an access list', run: ({ state }, a) => { if (!state.acls[a.number]) return ['% Access list not found']; delete state.acls[a.number]; } },
  { pattern: 'no ip access-list standard <name>', help: 'Remove a standard access list', run: ({ state }, a) => void delete state.acls[a.name] },
  { pattern: 'no ip access-list extended <name>', help: 'Remove an extended access list', run: ({ state }, a) => void delete state.acls[a.name] },
  { pattern: 'ip dhcp excluded-address <from> <to>', help: 'Prevent DHCP from assigning certain addresses', run: ({ state }, a) => excludeRange(state, a.from, a.to) },
  { pattern: 'ip dhcp excluded-address <from>', help: 'Prevent DHCP from assigning certain addresses', run: ({ state }, a) => excludeRange(state, a.from) },
  { pattern: 'no ip dhcp excluded-address <from> <to>', help: 'Remove an excluded range', run: ({ state }, a) => unexcludeRange(state, a.from, a.to) },
  { pattern: 'no ip dhcp excluded-address <from>', help: 'Remove an excluded address', run: ({ state }, a) => unexcludeRange(state, a.from) },
  { pattern: 'no ip dhcp pool <name>', help: 'Remove a DHCP pool', run: ({ state }, a) => { if (!state.dhcpPools[a.name]) return ['% Pool not found']; delete state.dhcpPools[a.name]; state.dhcpBindings = state.dhcpBindings.filter((b) => b.pool !== a.name); } },
  { pattern: 'service dhcp', help: 'Enable DHCP server and relay agent', run: () => undefined },
  { pattern: 'no service dhcp', help: 'Disable DHCP server and relay agent', run: () => undefined },
];

const INTERFACE_COMMON: Def[] = [
  { pattern: 'description <text...>', help: 'Interface specific description', run: ({ state }, a) => forEachTarget(state, (i) => void (i.description = a.text)) },
  { pattern: 'no description', help: 'Remove the description', run: ({ state }) => forEachTarget(state, (i) => void (i.description = undefined)) },
  { pattern: 'shutdown', help: 'Shutdown the selected interface', run: ({ state }) => forEachTarget(state, (i) => { if (i.shutdown) return; i.shutdown = true; return linkChange(i, false); }) },
  { pattern: 'no shutdown', help: 'Bring the interface up', run: ({ state }) => forEachTarget(state, (i) => { if (!i.shutdown) return; i.shutdown = false; return i.connected || isSvi(i.name) || isLoopback(i.name) ? linkChange(i, true) : undefined; }) },
  { pattern: 'speed <speed>', help: 'Configure speed operation.', run: () => undefined },
  { pattern: 'duplex <duplex>', help: 'Configure duplex operation.', run: () => undefined },
  { pattern: 'no ip address', help: 'Remove the IP address', run: ({ state }) => forEachTarget(state, (i) => { i.ipAddress = undefined; i.subnetMask = undefined; }) },
  { pattern: 'exit', help: 'Exit from interface configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentInterface = undefined; state.currentInterfaces = undefined; } },
  ...EXIT_CONFIG,
];

function setIp(state: DeviceState, address: string, mask: string, allowed: (i: InterfaceState) => string[] | null): string[] | void {
  if (state.currentInterfaces && state.currentInterfaces.length > 1) return [INVALID_INPUT];
  const i = currentInterface(state);
  const problem = allowed(i);
  if (problem) return problem;
  if (!isValidIp(address) || !isValidMask(mask)) return ['% Invalid address/mask'];
  i.ipAddress = address;
  i.subnetMask = mask;
}

/** Layer 2 commands: rejected on SVIs, applied to every interface in a range. */
function l2(state: DeviceState, fn: (i: InterfaceState) => string[] | void): string[] | void {
  if (targetInterfaces(state).some((i) => isSvi(i.name))) return [INVALID_INPUT];
  return forEachTarget(state, fn);
}

export const INTERFACE_CONFIG: Def[] = [
  ...INTERFACE_COMMON,
  { pattern: 'ip address <address> <mask>', help: 'Set the IP address of an interface', run: ({ state }, a) => setIp(state, a.address, a.mask, (i) => (isSvi(i.name) ? null : ['% IP addresses may not be configured on L2 links.'])) },
  { pattern: 'switchport', help: 'Set switching mode characteristics', run: () => undefined },
  { pattern: 'switchport mode access', help: 'Set trunking mode to ACCESS unconditionally', run: ({ state }) => l2(state, (i) => void (i.mode = 'access')) },
  { pattern: 'switchport mode trunk', help: 'Set trunking mode to TRUNK unconditionally', run: ({ state }) => l2(state, (i) => void (i.mode = 'trunk')) },
  { pattern: 'switchport mode dynamic auto', help: 'Set trunking mode dynamic negotiation parameter', run: ({ state }) => l2(state, (i) => void (i.mode = 'dynamic')) },
  { pattern: 'no switchport mode', help: 'Reset trunking mode', run: ({ state }) => l2(state, (i) => void (i.mode = 'dynamic')) },
  { pattern: 'switchport access vlan <vlan>', help: 'VLAN ID of the VLAN when this port is in access mode', run: ({ state }, a) => l2(state, (i) => { const v = Number(a.vlan); if (!/^\d+$/.test(a.vlan) || v < 1 || v > 4094) return [INVALID_INPUT]; const created = !state.vlans[v]; ensureVlan(state, v); i.accessVlan = v; return created ? [`% Access VLAN does not exist. Creating vlan ${v}`] : undefined; }) },
  { pattern: 'no switchport access vlan', help: 'Reset access VLAN to default', run: ({ state }) => l2(state, (i) => void (i.accessVlan = 1)) },
  { pattern: 'switchport trunk encapsulation dot1q', help: 'Interface uses only 802.1q trunking encapsulation when trunking', run: () => undefined },
  { pattern: 'switchport trunk allowed vlan all', help: 'all VLANs', run: ({ state }) => l2(state, (i) => void (i.trunkAllowed = 'all')) },
  { pattern: 'switchport trunk allowed vlan none', help: 'no VLANs', run: ({ state }) => l2(state, (i) => void (i.trunkAllowed = [])) },
  { pattern: 'switchport trunk allowed vlan add <list>', help: 'add VLANs to the current list', run: ({ state }, a) => l2(state, (i) => { const list = parseVlanList(a.list); if (!list) return ['% Bad VLAN list']; if (i.trunkAllowed === 'all') return; i.trunkAllowed = [...new Set([...i.trunkAllowed, ...list])].sort((x, y) => x - y); }) },
  { pattern: 'switchport trunk allowed vlan remove <list>', help: 'remove VLANs from the current list', run: ({ state }, a) => l2(state, (i) => { const list = parseVlanList(a.list); if (!list) return ['% Bad VLAN list']; const current = i.trunkAllowed === 'all' ? parseVlanList('1-4094')! : i.trunkAllowed; i.trunkAllowed = current.filter((v) => !list.includes(v)); }) },
  { pattern: 'switchport trunk allowed vlan <list>', help: 'VLAN IDs of the allowed VLANs when this port is in trunking mode', run: ({ state }, a) => l2(state, (i) => { const list = parseVlanList(a.list); if (!list) return ['% Bad VLAN list']; i.trunkAllowed = list; }) },
  { pattern: 'no switchport trunk allowed vlan', help: 'Reset allowed VLANs to all', run: ({ state }) => l2(state, (i) => void (i.trunkAllowed = 'all')) },
  { pattern: 'switchport trunk native vlan <vlan>', help: 'Set native VLAN when interface is in trunking mode', run: ({ state }, a) => l2(state, (i) => { const v = Number(a.vlan); if (!/^\d+$/.test(a.vlan) || v < 1 || v > 4094) return [INVALID_INPUT]; i.nativeVlan = v; }) },
  { pattern: 'no switchport trunk native vlan', help: 'Reset native VLAN to default', run: ({ state }) => l2(state, (i) => void (i.nativeVlan = 1)) },
  ...SWITCH_JUMPS,
];

function setEncapsulation(state: DeviceState, vlanText: string, native: boolean): string[] | void {
  if (state.currentInterfaces && state.currentInterfaces.length > 1) return [INVALID_INPUT];
  const i = currentInterface(state);
  if (!isSubinterface(i.name)) return ['% Encapsulation is only supported on subinterfaces.'];
  const vlan = Number(vlanText);
  if (!/^\d+$/.test(vlanText) || vlan < 1 || vlan > 4094) return [INVALID_INPUT];
  i.encapsulation = { vlan, native };
}

export const INTERFACE_CONFIG_ROUTER: Def[] = [
  ...INTERFACE_COMMON,
  { pattern: 'ip address <address> <mask>', help: 'Set the IP address of an interface', run: ({ state }, a) => setIp(state, a.address, a.mask, (i) => (isSubinterface(i.name) && !i.encapsulation ? ['% Configuring IP routing on a LAN subinterface is only allowed if that', '  subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', '  or ISL vLAN.'] : null)) },
  { pattern: 'encapsulation dot1q <vlan>', help: 'IEEE 802.1Q Virtual LAN', run: ({ state }, a) => setEncapsulation(state, a.vlan, false) },
  { pattern: 'encapsulation dot1q <vlan> native', help: 'Make this as native vlan', run: ({ state }, a) => setEncapsulation(state, a.vlan, true) },
  { pattern: 'no encapsulation dot1q', help: 'Remove the encapsulation', run: ({ state }) => void (currentInterface(state).encapsulation = undefined) },
  { pattern: 'ip ospf cost <cost>', help: 'Interface cost', run: ({ state }, a) => { const c = Number(a.cost); if (!/^\d+$/.test(a.cost) || c < 1 || c > 65535) return [INVALID_INPUT]; return forEachTarget(state, (i) => void (i.ospfCost = c)); } },
  { pattern: 'no ip ospf cost', help: 'Reset interface cost', run: ({ state }) => forEachTarget(state, (i) => void (i.ospfCost = undefined)) },
  { pattern: 'ip ospf priority <priority>', help: 'Router priority', run: ({ state }, a) => { const p = Number(a.priority); if (!/^\d+$/.test(a.priority) || p > 255) return [INVALID_INPUT]; return forEachTarget(state, (i) => void (i.ospfPriority = p)); } },
  { pattern: 'ip ospf <process> area <area>', help: 'Set the OSPF area ID', run: ({ state }, a) => { const area = parseArea(a.area); if (!/^\d+$/.test(a.process) || area === null) return [INVALID_INPUT]; if (!state.ospf) state.ospf = { processId: Number(a.process), networks: [], passiveDefault: false, passiveInterfaces: [], activeInterfaces: [], defaultInformationOriginate: false }; return forEachTarget(state, (i) => void (i.ospfArea = area)); } },
  { pattern: 'no ip ospf <process> area <area>', help: 'Remove OSPF from the interface', run: ({ state }) => forEachTarget(state, (i) => void (i.ospfArea = undefined)) },
  { pattern: 'ip access-group <acl> in', help: 'inbound packets', run: ({ state }, a) => applyAccessGroup(state, a.acl, 'in') },
  { pattern: 'ip access-group <acl> out', help: 'outbound packets', run: ({ state }, a) => applyAccessGroup(state, a.acl, 'out') },
  { pattern: 'no ip access-group <acl> in', help: 'Remove the inbound access list', run: ({ state }) => forEachTarget(state, (i) => void (i.aclIn = undefined)) },
  { pattern: 'no ip access-group <acl> out', help: 'Remove the outbound access list', run: ({ state }) => forEachTarget(state, (i) => void (i.aclOut = undefined)) },
  { pattern: 'no ip access-group in', help: 'Remove the inbound access list', run: ({ state }) => forEachTarget(state, (i) => void (i.aclIn = undefined)) },
  { pattern: 'no ip access-group out', help: 'Remove the outbound access list', run: ({ state }) => forEachTarget(state, (i) => void (i.aclOut = undefined)) },
  { pattern: 'ip helper-address <address>', help: 'Specify a destination address for UDP broadcasts', run: ({ state }, a) => { if (!isValidIp(a.address)) return [INVALID_INPUT]; return forEachTarget(state, (i) => void (i.helperAddress = a.address)); } },
  { pattern: 'no ip helper-address', help: 'Remove the helper address', run: ({ state }) => forEachTarget(state, (i) => void (i.helperAddress = undefined)) },
  { pattern: 'no ip helper-address <address>', help: 'Remove the helper address', run: ({ state }) => forEachTarget(state, (i) => void (i.helperAddress = undefined)) },
  ...ROUTER_JUMPS,
];

export const VLAN_CONFIG: Def[] = [
  { pattern: 'name <name...>', help: 'Ascii name of the VLAN', run: ({ state }, a) => void (state.vlans[state.currentVlan!].name = a.name.slice(0, 32)) },
  { pattern: 'no name', help: 'Reset the VLAN name', run: ({ state }) => void (state.vlans[state.currentVlan!].name = defaultVlanName(state.currentVlan!)) },
  { pattern: 'exit', help: 'Apply changes, bump revision number, and exit mode', run: ({ state }) => { state.mode = 'config'; state.currentVlan = undefined; } },
  ...EXIT_CONFIG,
  ...SWITCH_JUMPS,
];

function currentLine(state: DeviceState) {
  return state.lines[state.currentLine!];
}

function lineConfig(jumps: Def[]): Def[] {
  return [
    { pattern: 'password <password...>', help: 'Set a password', run: ({ state }, a) => void (currentLine(state).password = a.password) },
    { pattern: 'no password', help: 'Remove the password', run: ({ state }) => void (currentLine(state).password = undefined) },
    { pattern: 'login', help: 'Enable password checking', run: ({ state }) => { const l = currentLine(state); if (!l.password) return ["% Login disabled on line, until 'password' is set"]; l.login = true; } },
    { pattern: 'login local', help: 'Local password checking', run: ({ state }) => void (currentLine(state).login = 'local') },
    { pattern: 'no login', help: 'Disable password checking', run: ({ state }) => void (currentLine(state).login = false) },
    { pattern: 'transport input <protocol>', help: 'Define which protocols to use to connect to a specific line', run: ({ state }, a) => { const p = a.protocol.toLowerCase(); if (!['all', 'ssh', 'telnet', 'none'].includes(p)) return [INVALID_INPUT]; currentLine(state).transportInput = p as 'all' | 'ssh' | 'telnet' | 'none'; } },
    { pattern: 'exec-timeout <minutes> <seconds>', help: 'Set the EXEC timeout', run: () => undefined },
    { pattern: 'exec-timeout <minutes>', help: 'Set the EXEC timeout', run: () => undefined },
    { pattern: 'logging synchronous', help: 'Synchronized message output', run: () => undefined },
    { pattern: 'access-class <acl> in', help: 'Filter connections based on an IP access list', run: ({ state }, a) => { if (state.currentLine !== 'vty') return ['% access-class is only supported on VTY lines.']; currentLine(state).accessClass = a.acl; } },
    { pattern: 'no access-class <acl> in', help: 'Remove the access class', run: ({ state }) => void (currentLine(state).accessClass = undefined) },
    { pattern: 'no access-class in', help: 'Remove the access class', run: ({ state }) => void (currentLine(state).accessClass = undefined) },
    { pattern: 'exit', help: 'Exit from line configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentLine = undefined; } },
    ...EXIT_CONFIG,
    ...jumps,
  ];
}

export const LINE_CONFIG: Def[] = lineConfig(SWITCH_JUMPS);
export const LINE_CONFIG_ROUTER: Def[] = lineConfig(ROUTER_JUMPS);

export function defsForMode(mode: Mode, deviceType: DeviceType = 'switch'): Def[] {
  const router = deviceType === 'router';
  switch (mode) {
    case 'user':
      return router ? USER_EXEC_ROUTER : USER_EXEC;
    case 'privileged':
      return router ? PRIV_EXEC_ROUTER : PRIV_EXEC;
    case 'config':
      return router ? GLOBAL_CONFIG_ROUTER : GLOBAL_CONFIG;
    case 'interface':
      return router ? INTERFACE_CONFIG_ROUTER : INTERFACE_CONFIG;
    case 'vlan':
      return VLAN_CONFIG;
    case 'line':
      return router ? LINE_CONFIG_ROUTER : LINE_CONFIG;
    case 'router':
      return ROUTER_CONFIG;
    case 'acl-std':
      return ACL_STD_CONFIG;
    case 'acl-ext':
      return ACL_EXT_CONFIG;
    case 'dhcp':
      return DHCP_CONFIG;
  }
}

export function privExecFor(deviceType: DeviceType): Def[] {
  return deviceType === 'router' ? PRIV_EXEC_ROUTER : PRIV_EXEC;
}

export function isConfigMode(mode: Mode): boolean {
  return mode !== 'user' && mode !== 'privileged';
}

export { shortInterfaceName };
