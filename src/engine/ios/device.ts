import { normalizeInterfaceName } from '../interfaces';
import { complete, help, resolve } from '../resolver';
import type { DeviceState, ExecResult, InterfaceState, Neighbor, VlanState } from '../types';
import { defsForMode, INVALID_INPUT, isConfigMode, PRIV_EXEC, WORD_HELP } from './commands';

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
      return state.currentInterfaces && state.currentInterfaces.length > 1 ? `${h}(config-if-range)#` : `${h}(config-if)#`;
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

/**
 * Execute one line typed at the device. Returns the new state and the output lines.
 * The input state is never mutated.
 */
export function execute(prev: DeviceState, rawLine: string): ExecResult {
  const state = structuredClone(prev);
  const line = rawLine.trim();
  const promptBefore = prompt(state);

  if (state.pendingInput) {
    return { state, output: handlePendingInput(state, rawLine) };
  }
  if (line === '') return { state, output: [] };

  state.commandHistory.push(line);

  // Context-sensitive help.
  if (line.endsWith('?')) {
    const body = line.slice(0, -1);
    const partial = body.length > 0 && !/\s$/.test(body);
    const tokens = body.trim() === '' ? [] : body.trim().split(/\s+/);
    let defs = defsForMode(state.mode);
    let scoped = tokens;
    if (isConfigMode(state.mode) && tokens[0]?.toLowerCase() === 'do' && tokens.length > 1) {
      defs = PRIV_EXEC;
      scoped = tokens.slice(1);
    }
    const entries = help(defs, scoped, partial, WORD_HELP);
    state.canonicalHistory.push('?');
    if (entries.length === 0) return { state, output: ['% Unrecognized command'] };
    const width = Math.max(...entries.map((e) => e.word.length), 10) + 2;
    return { state, output: entries.map((e) => (e.word === '<cr>' ? '  <cr>' : `  ${e.word.padEnd(width)}${e.help}`)) };
  }

  let tokens = line.split(/\s+/);
  let defs = defsForMode(state.mode);
  let canonicalPrefix = '';

  if (isConfigMode(state.mode) && tokens[0].toLowerCase() === 'do') {
    if (tokens.length === 1) {
      state.errorsSeen.push('incomplete');
      return { state, output: ['% Incomplete command.', ''] };
    }
    tokens = tokens.slice(1);
    defs = PRIV_EXEC;
    canonicalPrefix = 'do ';
  }

  const res = resolve(defs, tokens);
  switch (res.kind) {
    case 'ok': {
      state.canonicalHistory.push(canonicalPrefix + res.canonical);
      const output = res.def.run({ state }, res.args) ?? [];
      noteMode(state);
      return { state, output: output.length ? [...output, ''] : [] };
    }
    case 'ambiguous':
      state.errorsSeen.push('ambiguous');
      return { state, output: [`% Ambiguous command:  "${line}"`, ''] };
    case 'incomplete':
      state.errorsSeen.push('incomplete');
      return { state, output: ['% Incomplete command.', ''] };
    case 'invalid': {
      state.errorsSeen.push('invalid');
      if (!isConfigMode(state.mode) && res.index === 0 && !canonicalPrefix) {
        return { state, output: [`Translating "${tokens[0]}"...domain server (255.255.255.255)`, '% Unknown command or computer name, or unable to find computer address', ''] };
      }
      const tokenIndex = res.index + (canonicalPrefix ? 1 : 0);
      const caret = ' '.repeat(promptBefore.length + tokenOffset(line, tokenIndex)) + '^';
      return { state, output: [caret, INVALID_INPUT, ''] };
    }
  }
}

/** Tab completion for the current mode. Returns the completed line or null. */
export function tabComplete(state: DeviceState, line: string): string | null {
  if (state.pendingInput || /\s$/.test(line) || line.trim() === '') return null;
  let tokens = line.trim().split(/\s+/);
  let defs = defsForMode(state.mode);
  let prefix = '';
  if (isConfigMode(state.mode) && tokens[0].toLowerCase() === 'do' && tokens.length > 1) {
    defs = PRIV_EXEC;
    prefix = tokens[0] + ' ';
    tokens = tokens.slice(1);
  }
  const word = complete(defs, tokens);
  if (!word) return null;
  return prefix + [...tokens.slice(0, -1), word].join(' ') + ' ';
}

// ---------------------------------------------------------------------------
// factory

export interface NeighborSpec {
  port: string;
  name: string;
  ip?: string;
  mask?: string;
  kind?: Neighbor['kind'];
}

export interface SwitchOptions {
  hostname?: string;
  /** Number of GigabitEthernet0/N ports. */
  ports?: number;
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

export function createSwitch(options: SwitchOptions = {}): DeviceState {
  const ports = options.ports ?? 8;
  const interfaces: Record<string, InterfaceState> = {};
  for (let n = 1; n <= ports; n++) {
    const name = `GigabitEthernet0/${n}`;
    interfaces[name] = { name, shutdown: false, connected: false, mode: 'dynamic', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };
  }
  interfaces['Vlan1'] = { name: 'Vlan1', shutdown: true, connected: true, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1 };

  const vlans = defaultVlans();
  for (const v of options.vlans ?? []) vlans[v.id] = { id: v.id, name: v.name ?? `VLAN${String(v.id).padStart(4, '0')}` };

  const neighbors: Neighbor[] = [];
  (options.neighbors ?? []).forEach((n, idx) => {
    const full = normalize(n.port);
    if (!interfaces[full]) throw new Error(`Unknown port ${n.port} in neighbor ${n.name}`);
    interfaces[full].connected = true;
    neighbors.push({ interface: full, name: n.name, ip: n.ip, mask: n.mask, kind: n.kind ?? 'pc', mac: `0011.22aa.${String(idx + 1).padStart(4, '0')}` });
  });

  for (const [key, patch] of Object.entries(options.interfaces ?? {})) {
    const full = normalize(key);
    if (!interfaces[full]) throw new Error(`Unknown interface ${key}`);
    Object.assign(interfaces[full], patch);
    if (patch.accessVlan && !vlans[patch.accessVlan]) vlans[patch.accessVlan] = { id: patch.accessVlan, name: `VLAN${String(patch.accessVlan).padStart(4, '0')}` };
  }

  return {
    hostname: options.hostname ?? 'Switch',
    mode: 'user',
    vlans,
    interfaces,
    neighbors,
    users: [],
    lines: { con: { login: false }, vty: { login: false } },
    servicePasswordEncryption: false,
    startupConfig: null,
    commandHistory: [],
    canonicalHistory: [],
    modesVisited: ['user'],
    errorsSeen: [],
    pings: [],
    ...options.overrides,
  };
}

function normalize(name: string): string {
  const full = normalizeInterfaceName(name);
  if (!full) throw new Error(`Bad interface name ${name}`);
  return full;
}
