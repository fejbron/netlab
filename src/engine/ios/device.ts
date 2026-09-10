import { normalizeInterfaceName } from '../interfaces';
import { fromSwitch, isSubinterface, syncLinkState, type NetworkState } from '../network';
import { complete, help, resolve } from '../resolver';
import type { DeviceState, ExecResult, InterfaceState, Neighbor, StaticRoute, VlanState } from '../types';
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

export function createSwitch(options: SwitchOptions = {}): DeviceState {
  const hostname = options.hostname ?? 'Switch';
  const dev = baseDevice(options.id ?? hostname, hostname, 'switch');
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
    if (!dev.interfaces[full]) throw new Error(`Unknown interface ${key}`);
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
  return { ...dev, ...options.overrides };
}
