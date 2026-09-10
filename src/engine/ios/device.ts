import { isExtendedNumber, nextSeq, parseExtendedRule, parseStandardRule } from '../acl';
import { normalizeIpv6, parsePrefix6 } from '../ipv6';
import { normalizeInterfaceName } from '../interfaces';
import { fromSwitch, isSubinterface, syncLinkState, type NetworkState } from '../network';
import { complete, help, resolve } from '../resolver';
import type { Acl, DeviceState, ExecResult, InterfaceState, Neighbor, StaticRoute, VlanState } from '../types';
import { defsForMode, INVALID_INPUT, isConfigMode, privExecFor, WORD_HELP } from './commands';

export function prompt(state: DeviceState): string {
  if (state.pendingInput?.kind === 'enable-password') return 'Password: ';
  const h = state.hostname;
  switch (state.mode) {
    case 'user':
      return `${h}>`;
    case 'privileged':
      return `${h}#`;
    case 'config':
      return `${h}(config)#`;
    case 'interface':
      if (state.currentInterfaces && state.currentInterfaces.length > 1) return `${h}(config-if-range)#`;
      return state.currentInterface && isSubinterface(state.currentInterface) ? `${h}(config-subif)#` : `${h}(config-if)#`;
    case 'vlan':
      return `${h}(config-vlan)#`;
    case 'line':
      return `${h}(config-line)#`;
    case 'router':
      return `${h}(config-router)#`;
    case 'acl-std':
      return `${h}(config-std-nacl)#`;
    case 'acl-ext':
      return `${h}(config-ext-nacl)#`;
    case 'dhcp':
      return `${h}(dhcp-config)#`;
  }
}

/** True while the device expects a password rather than a command (terminal should mask input). */
export function isMaskedInput(state: DeviceState): boolean {
  return state.pendingInput !== undefined;
}

function tokenOffset(line: string, index: number): number {
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line)) !== null) {
    if (i === index) return m.index;
    i++;
  }
  return line.length;
}

function noteMode(state: DeviceState) {
  if (!state.modesVisited.includes(state.mode)) state.modesVisited.push(state.mode);
}

function handlePendingInput(state: DeviceState, line: string): string[] {
  const pending = state.pendingInput!;
  const expected = state.enableSecret ?? state.enablePassword;
  if (line === expected) {
    state.pendingInput = undefined;
    state.mode = 'privileged';
    noteMode(state);
    return [];
  }
  pending.attempts += 1;
  if (pending.attempts >= 3) {
    state.pendingInput = undefined;
    return ['% Bad secrets', ''];
  }
  return [];
}

export interface NetworkExecResult {
  network: NetworkState;
  output: string[];
}

/**
 * Execute one line typed at a CLI device inside a network. Returns the new network
 * (deep-cloned; the input is never mutated) and the output lines.
 */
export function executeOn(prev: NetworkState, nodeId: string, rawLine: string): NetworkExecResult {
  const network = structuredClone(prev);
  const state = network.devices[nodeId];
  if (!state) throw new Error(`No CLI device "${nodeId}" in network`);
  const output = run(state, network, nodeId, rawLine);
  syncLinkState(network);
  return { network, output };
}

/** Single-device convenience used by tests and legacy callers. */
export function execute(prev: DeviceState, rawLine: string): ExecResult {
  const net = fromSwitch(structuredClone(prev));
  const r = executeOn(net, net.primary, rawLine);
  return { state: r.network.devices[net.primary], output: r.output };
}

function run(state: DeviceState, network: NetworkState, nodeId: string, rawLine: string): string[] {
  const line = rawLine.trim();
  const promptBefore = prompt(state);

  if (state.pendingInput) return handlePendingInput(state, rawLine);
  if (line === '') return [];

  state.commandHistory.push(line);

  // Context-sensitive help.
  if (line.endsWith('?')) {
    const body = line.slice(0, -1);
    const partial = body.length > 0 && !/\s$/.test(body);
    const tokens = body.trim() === '' ? [] : body.trim().split(/\s+/);
    let defs = defsForMode(state.mode, state.deviceType);
    let scoped = tokens;
    if (isConfigMode(state.mode) && tokens[0]?.toLowerCase() === 'do' && tokens.length > 1) {
      defs = privExecFor(state.deviceType);
      scoped = tokens.slice(1);
    }
    const entries = help(defs, scoped, partial, WORD_HELP);
    state.canonicalHistory.push('?');
    if (entries.length === 0) return ['% Unrecognized command'];
    const width = Math.max(...entries.map((e) => e.word.length), 10) + 2;
    return entries.map((e) => (e.word === '<cr>' ? '  <cr>' : `  ${e.word.padEnd(width)}${e.help}`));
  }

  let tokens = line.split(/\s+/);
  let defs = defsForMode(state.mode, state.deviceType);
  let canonicalPrefix = '';

  if (isConfigMode(state.mode) && tokens[0].toLowerCase() === 'do') {
    if (tokens.length === 1) {
      state.errorsSeen.push('incomplete');
      return ['% Incomplete command.', ''];
    }
    tokens = tokens.slice(1);
    defs = privExecFor(state.deviceType);
    canonicalPrefix = 'do ';
  }

  const res = resolve(defs, tokens);
  switch (res.kind) {
    case 'ok': {
      state.canonicalHistory.push(canonicalPrefix + res.canonical);
      const output = res.def.run({ state, network, nodeId }, res.args) ?? [];
      noteMode(state);
      return output.length ? [...output, ''] : [];
    }
    case 'ambiguous':
      state.errorsSeen.push('ambiguous');
      return [`% Ambiguous command:  "${line}"`, ''];
    case 'incomplete':
      state.errorsSeen.push('incomplete');
      return ['% Incomplete command.', ''];
    case 'invalid': {
      state.errorsSeen.push('invalid');
      if (!isConfigMode(state.mode) && res.index === 0 && !canonicalPrefix) {
        return [`Translating "${tokens[0]}"...domain server (255.255.255.255)`, '% Unknown command or computer name, or unable to find computer address', ''];
      }
      const tokenIndex = res.index + (canonicalPrefix ? 1 : 0);
      const caret = ' '.repeat(promptBefore.length + tokenOffset(line, tokenIndex)) + '^';
      return [caret, INVALID_INPUT, ''];
    }
  }
}

/** Tab completion for the current mode. Returns the completed line or null. */
export function tabComplete(state: DeviceState, line: string): string | null {
  if (state.pendingInput || /\s$/.test(line) || line.trim() === '') return null;
  let tokens = line.trim().split(/\s+/);
  let defs = defsForMode(state.mode, state.deviceType);
  let prefix = '';
  if (isConfigMode(state.mode) && tokens[0].toLowerCase() === 'do' && tokens.length > 1) {
    defs = privExecFor(state.deviceType);
    prefix = tokens[0] + ' ';
    tokens = tokens.slice(1);
  }
  const word = complete(defs, tokens);
  if (!word) return null;
  return prefix + [...tokens.slice(0, -1), word].join(' ') + ' ';
}

// ---------------------------------------------------------------------------
// factories

export interface NeighborSpec {
  port: string;
  name: string;
  ip?: string;
  mask?: string;
  kind?: Neighbor['kind'];
}

export interface SwitchOptions {
  /** Node id inside a network; defaults to the hostname. */
  id?: string;
  hostname?: string;
  /** Bridge MAC address; lower wins spanning-tree ties. Derived from the id by default. */
  mac?: string;
  stpMode?: 'pvst' | 'rapid-pvst';
  /** Spanning-tree priority per VLAN, e.g. { 1: 4096 }. */
  stpPriority?: Record<number, number>;
  /** Number of GigabitEthernet0/N ports. */
  ports?: number;
  /** Legacy single-device topology; prefer buildNetwork() for multi-device labs. */
  neighbors?: NeighborSpec[];
  vlans?: Array<{ id: number; name?: string }>;
  /** Per-interface overrides keyed by any interface spelling ("g0/1"). */
  interfaces?: Record<string, Partial<InterfaceState>>;
  /** Extra device-level overrides applied last. */
  overrides?: Partial<DeviceState>;
}

function defaultVlans(): Record<number, VlanState> {
  return {
    1: { id: 1, name: 'default' },
    1002: { id: 1002, name: 'fddi-default' },
    1003: { id: 1003, name: 'token-ring-default' },
    1004: { id: 1004, name: 'fddinet-default' },
    1005: { id: 1005, name: 'trnet-default' },
  };
}

function baseDevice(id: string, hostname: string, deviceType: DeviceState['deviceType']): DeviceState {
  return {
    id,
    deviceType,
    hostname,
    mode: 'user',
    vlans: {},
    interfaces: {},
    neighbors: [],
    ipRouting: deviceType === 'router',
    staticRoutes: [],
    acls: {},
    dhcpPools: {},
    dhcpExcluded: [],
    dhcpBindings: [],
    natStatic: [],
    natPools: {},
    natTranslations: [],
    ipv6UnicastRouting: false,
    staticRoutes6: [],
    mac: deviceMac(id),
    stpMode: 'pvst',
    stpPriority: {},
    users: [],
    lines: { con: { login: false }, vty: { login: false } },
    servicePasswordEncryption: false,
    startupConfig: null,
    commandHistory: [],
    canonicalHistory: [],
    modesVisited: ['user'],
    errorsSeen: [],
    pings: [],
  };
}

function normalize(name: string): string {
  const full = normalizeInterfaceName(name);
  if (!full) throw new Error(`Bad interface name ${name}`);
  return full;
}

/** Deterministic base MAC for a device id, e.g. "0011.2233.1a2b". */
function deviceMac(id: string): string {
  let h = 5381;
  for (const c of id) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return `0011.2233.${h.toString(16).padStart(8, '0').slice(-4)}`;
}

export function createSwitch(options: SwitchOptions = {}): DeviceState {
  const hostname = options.hostname ?? 'Switch';
  const dev = baseDevice(options.id ?? hostname, hostname, 'switch');
  if (options.mac) dev.mac = options.mac;
  if (options.stpMode) dev.stpMode = options.stpMode;
  if (options.stpPriority) dev.stpPriority = { ...options.stpPriority };
  const ports = options.ports ?? 8;
  for (let n = 1; n <= ports; n++) {
    const name = `GigabitEthernet0/${n}`;
    dev.interfaces[name] = { name, shutdown: false, connected: false, mode: 'dynamic', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
  }
  dev.interfaces['Vlan1'] = { name: 'Vlan1', shutdown: true, connected: true, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };

  dev.vlans = defaultVlans();
  for (const v of options.vlans ?? []) dev.vlans[v.id] = { id: v.id, name: v.name ?? `VLAN${String(v.id).padStart(4, '0')}` };

  (options.neighbors ?? []).forEach((n, idx) => {
    const full = normalize(n.port);
    if (!dev.interfaces[full]) throw new Error(`Unknown port ${n.port} in neighbor ${n.name}`);
    dev.interfaces[full].connected = true;
    dev.neighbors.push({ interface: full, name: n.name, ip: n.ip, mask: n.mask, kind: n.kind ?? 'pc', mac: `0011.22aa.${String(idx + 1).padStart(4, '0')}` });
  });

  for (const [key, patch] of Object.entries(options.interfaces ?? {})) {
    const full = normalize(key);
    if (!dev.interfaces[full]) {
      if (!full.startsWith('Port-channel')) throw new Error(`Unknown interface ${key}`);
      dev.interfaces[full] = { name: full, shutdown: false, connected: false, mode: 'dynamic', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
    }
    Object.assign(dev.interfaces[full], patch);
    if (patch.accessVlan && !dev.vlans[patch.accessVlan]) dev.vlans[patch.accessVlan] = { id: patch.accessVlan, name: `VLAN${String(patch.accessVlan).padStart(4, '0')}` };
  }

  return { ...dev, ...options.overrides };
}

export interface RouterOptions {
  id?: string;
  hostname?: string;
  /** Number of GigabitEthernet0/N ports, numbered from 0. */
  ports?: number;
  /** Per-interface overrides; subinterfaces ("g0/0.10") and loopbacks are created on demand. */
  interfaces?: Record<string, Partial<InterfaceState>>;
  staticRoutes?: Array<{ destination: string; mask: string; nextHop?: string; exitInterface?: string; adminDistance?: number }>;
  /** Pre-configured OSPF process. Networks are [address, wildcard, area] triples. */
  ospf?: { processId?: number; routerId?: string; networks?: Array<[string, string, number]>; passiveInterfaces?: string[]; defaultInformationOriginate?: boolean };
  /** Pre-configured access lists as IOS rule lines, e.g. { '10': ['permit 192.168.1.0 0.0.0.255'] } or { 'BLOCK': ['deny icmp any any echo', 'permit ip any any'] }. */
  acls?: Record<string, { kind?: 'standard' | 'extended'; rules: string[] }>;
  /** Pre-configured DHCP pools and excluded ranges. */
  dhcp?: { pools?: Array<{ name: string; network: string; mask: string; defaultRouter?: string; dnsServer?: string; domainName?: string }>; excluded?: Array<[string, string?]> };
  /** Pre-configured NAT. */
  nat?: { static?: Array<[string, string]>; pools?: Array<{ name: string; start: string; end: string; netmask: string }>; dynamic?: { acl: string; pool?: string; interface?: string; overload?: boolean } };
  /** IPv6 static routes as "prefix/len via" where via is a next hop, an interface, or "iface nexthop". */
  ipv6?: { unicastRouting?: boolean; routes?: Array<[string, string]> };
  overrides?: Partial<DeviceState>;
}

/** A router whose physical ports start administratively down, like a real ISR out of the box. */
export function createRouter(options: RouterOptions = {}): DeviceState {
  const hostname = options.hostname ?? 'Router';
  const dev = baseDevice(options.id ?? hostname, hostname, 'router');
  const ports = options.ports ?? 2;
  for (let n = 0; n < ports; n++) {
    const name = `GigabitEthernet0/${n}`;
    dev.interfaces[name] = { name, shutdown: true, connected: false, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
  }
  for (const [key, patch] of Object.entries(options.interfaces ?? {})) {
    const full = normalize(key);
    if (!dev.interfaces[full]) {
      const isSub = isSubinterface(full);
      if (isSub && !dev.interfaces[full.split('.')[0]]) throw new Error(`Unknown parent interface for ${key}`);
      dev.interfaces[full] = { name: full, shutdown: false, connected: false, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
    }
    Object.assign(dev.interfaces[full], patch);
  }
  dev.staticRoutes = (options.staticRoutes ?? []).map(
    (r): StaticRoute => ({ destination: r.destination, mask: r.mask, nextHop: r.nextHop, exitInterface: r.exitInterface ? normalize(r.exitInterface) : undefined, adminDistance: r.adminDistance ?? 1 }),
  );
  if (options.ospf) {
    dev.ospf = {
      processId: options.ospf.processId ?? 1,
      routerId: options.ospf.routerId,
      networks: (options.ospf.networks ?? []).map(([address, wildcard, area]) => ({ address, wildcard, area })),
      passiveDefault: false,
      passiveInterfaces: (options.ospf.passiveInterfaces ?? []).map(normalize),
      activeInterfaces: [],
      defaultInformationOriginate: options.ospf.defaultInformationOriginate ?? false,
    };
  }
  for (const [name, spec] of Object.entries(options.acls ?? {})) {
    const numbered = /^\d+$/.test(name);
    const kind = spec.kind ?? (numbered ? (isExtendedNumber(Number(name)) ? 'extended' : 'standard') : 'extended');
    const acl: Acl = { name, kind, entries: [] };
    for (const rule of spec.rules) {
      const [action, ...rest] = rule.trim().split(/\s+/);
      if (action === 'remark') {
        acl.entries.push({ seq: nextSeq(acl), action: 'remark', remark: rest.join(' '), src: { kind: 'any' }, matches: 0 });
        continue;
      }
      if (action !== 'permit' && action !== 'deny') throw new Error(`Bad ACL rule "${rule}"`);
      const parsed = kind === 'standard' ? parseStandardRule(action, rest) : parseExtendedRule(action, rest);
      if (!parsed) throw new Error(`Bad ACL rule "${rule}"`);
      acl.entries.push({ ...parsed, seq: nextSeq(acl), matches: 0 });
    }
    dev.acls[name] = acl;
  }
  for (const p of options.dhcp?.pools ?? []) dev.dhcpPools[p.name] = { name: p.name, network: p.network, mask: p.mask, defaultRouter: p.defaultRouter, dnsServer: p.dnsServer, domainName: p.domainName };
  for (const [from, to] of options.dhcp?.excluded ?? []) dev.dhcpExcluded.push({ from, to: to ?? from });
  for (const [insideLocal, insideGlobal] of options.nat?.static ?? []) dev.natStatic.push({ insideLocal, insideGlobal });
  for (const p of options.nat?.pools ?? []) dev.natPools[p.name] = { ...p };
  if (options.nat?.dynamic) {
    const d = options.nat.dynamic;
    dev.natDynamic = { acl: d.acl, pool: d.pool, interface: d.interface ? normalize(d.interface) : undefined, overload: d.overload ?? false };
  }
  if (options.ipv6?.unicastRouting) dev.ipv6UnicastRouting = true;
  for (const [prefixText, via] of options.ipv6?.routes ?? []) {
    const p = parsePrefix6(prefixText);
    if (!p) throw new Error(`Bad IPv6 prefix ${prefixText}`);
    const parts = via.trim().split(/\s+/);
    const first = normalizeIpv6(parts[0]);
    if (first && parts.length === 1) dev.staticRoutes6.push({ prefix: p.address, length: p.length, nextHop: first, adminDistance: 1 });
    else dev.staticRoutes6.push({ prefix: p.address, length: p.length, exitInterface: normalize(parts[0]), nextHop: parts[1] ? normalizeIpv6(parts[1]) ?? undefined : undefined, adminDistance: 1 });
  }
  return { ...dev, ...options.overrides };
}
