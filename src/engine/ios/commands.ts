import type { CommandDef } from '../resolver';
import type { DeviceState, InterfaceState, Mode } from '../types';
import { isSvi, normalizeInterfaceName, sviVlanId } from '../interfaces';
import { isValidIp, isValidMask, parseVlanList, sameSubnet } from './net';
import {
  defaultVlanName,
  renderConfigBody,
  showHistory,
  showInterfaceSwitchport,
  showInterfacesStatus,
  showInterfacesTrunk,
  showIpInterfaceBrief,
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
}

export type Def = CommandDef<Ctx>;

export const INVALID_INPUT = "% Invalid input detected at '^' marker.";

/** Help shown next to top-level words when the learner types "?". */
export const WORD_HELP: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the EXEC',
  end: 'Exit from configure mode',
  logout: 'Exit from the EXEC',
  show: 'Show running system information',
  ping: 'Send echo messages',
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
  vlan: 'Vlan commands',
  ip: 'Global IP configuration subcommands',
  crypto: 'Encryption module',
  service: 'Modify use of network based services',
  'spanning-tree': 'Spanning Tree Subsystem',
  no: 'Negate a command or set its defaults',
  do: 'To run exec commands in config mode',
  description: 'Interface specific description',
  shutdown: 'Shutdown the selected interface',
  switchport: 'Set switching mode characteristics',
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
};

// ---------------------------------------------------------------------------
// helpers

function currentInterface(state: DeviceState): InterfaceState {
  return state.interfaces[state.currentInterface!];
}

function ensureVlan(state: DeviceState, id: number) {
  if (!state.vlans[id]) state.vlans[id] = { id, name: defaultVlanName(id) };
}

function linkChange(iface: InterfaceState, up: boolean): string[] {
  const ts = '*Mar  1 00:14:22.104';
  const proto = up ? 'up' : 'down';
  return up
    ? [`${ts}: %LINK-3-UPDOWN: Interface ${iface.name}, changed state to up`, `${ts}: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to ${proto}`]
    : [`${ts}: %LINK-5-CHANGED: Interface ${iface.name}, changed state to administratively down`, `${ts}: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to down`];
}

function findInterface(state: DeviceState, text: string): InterfaceState | null {
  const name = normalizeInterfaceName(text);
  if (!name) return null;
  return state.interfaces[name] ?? null;
}

function enterInterface(state: DeviceState, text: string): string[] | void {
  const name = normalizeInterfaceName(text);
  if (!name) return [INVALID_INPUT];
  if (!state.interfaces[name]) {
    if (!isSvi(name)) return [INVALID_INPUT];
    const vid = sviVlanId(name)!;
    if (vid < 1 || vid > 4094) return [INVALID_INPUT];
    state.interfaces[name] = { name, shutdown: false, connected: true, mode: 'access', accessVlan: vid, trunkAllowed: 'all', nativeVlan: 1 };
  }
  state.mode = 'interface';
  state.currentInterface = name;
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
  state.currentLine = undefined;
}

function enterLine(state: DeviceState, line: 'con' | 'vty') {
  state.mode = 'line';
  state.currentLine = line;
  state.currentInterface = undefined;
  state.currentVlan = undefined;
}

function ping(state: DeviceState, target: string): string[] {
  if (!isValidIp(target)) return ['% Unrecognized host or address, or protocol not running.'];
  const svis = Object.values(state.interfaces).filter((i) => isSvi(i.name) && !i.shutdown && i.ipAddress && i.subnetMask);
  let success = false;
  for (const svi of svis) {
    if (!sameSubnet(svi.ipAddress!, target, svi.subnetMask!)) continue;
    const vid = sviVlanId(svi.name)!;
    const host = state.neighbors.find((n) => n.ip === target);
    if (!host) continue;
    const port = state.interfaces[host.interface];
    if (port && !port.shutdown && port.connected && (port.mode === 'trunk' || port.accessVlan === vid)) success = true;
  }
  state.pings.push({ target, success });
  return [
    'Type escape sequence to abort.',
    `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
    success ? '!!!!!' : '.....',
    success ? 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms' : 'Success rate is 0 percent (0/5)',
  ];
}

const HELP_TEXT = [
  'Help may be requested at any point in a command by entering',
  "a question mark '?'.  If nothing matches, the help list will",
  'be empty and you must backup until entering a \'?\' shows the',
  'available options.',
  'Two styles of help are provided:',
  '1. Full help is available when you are ready to enter a',
  '   command argument (e.g. \'show ?\') and describes each possible',
  '   argument.',
  '2. Partial help is provided when an abbreviated argument is entered',
  "   and you want to know what arguments match the input",
  "   (e.g. 'show pr?'.)",
];

// ---------------------------------------------------------------------------
// exec mode commands

const SHOW_USER: Def[] = [
  { pattern: 'show version', help: 'System hardware and software status', run: ({ state }) => showVersion(state) },
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
  { pattern: 'show ip interface brief', help: 'Brief summary of IP status and configuration', run: ({ state }) => showIpInterfaceBrief(state) },
  { pattern: 'show mac address-table', help: 'MAC forwarding table', run: ({ state }) => showMacAddressTable(state) },
  { pattern: 'show history', help: 'Display the session command history', run: ({ state }) => showHistory(state) },
  { pattern: 'show spanning-tree', help: 'Spanning tree topology', run: ({ state }) => showSpanningTree(state) },
  { pattern: 'show users', help: 'Display information about terminal lines', run: () => ['    Line       User       Host(s)              Idle       Location', '*  0 con 0                idle                 00:00:00'] },
];

const SHOW_PRIV: Def[] = [
  ...SHOW_USER,
  { pattern: 'show running-config', help: 'Current operating configuration', run: ({ state }) => showRunningConfig(state) },
  { pattern: 'show startup-config', help: 'Contents of startup configuration', run: ({ state }) => showStartupConfig(state) },
  { pattern: 'show ip ssh', help: 'Information on SSH', run: ({ state }) => showIpSsh(state) },
];

export const USER_EXEC: Def[] = [
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
  { pattern: 'ping <target>', help: 'Send echo messages', run: ({ state }, a) => ping(state, a.target) },
  { pattern: 'terminal length <lines>', help: 'Set number of lines on a screen', run: () => undefined },
  ...SHOW_USER,
];

function saveConfig(state: DeviceState): string[] {
  state.startupConfig = renderConfigBody(state).join('\n');
  return ['Building configuration...', '[OK]'];
}

export const PRIV_EXEC: Def[] = [
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
  { pattern: 'ping <target>', help: 'Send echo messages', run: ({ state }, a) => ping(state, a.target) },
  ...SHOW_PRIV,
];

// ---------------------------------------------------------------------------
// config modes

const EXIT_CONFIG: Def[] = [
  { pattern: 'end', help: 'Exit from configure mode', run: ({ state }) => leaveConfig(state) },
];

function leaveConfig(state: DeviceState) {
  state.mode = 'privileged';
  state.currentInterface = undefined;
  state.currentVlan = undefined;
  state.currentLine = undefined;
}

/** Commands that IOS lets you type from any config submode (it silently changes context). */
const GLOBAL_JUMPS: Def[] = [
  { pattern: 'interface <interface...>', help: 'Select an interface to configure', run: ({ state }, a) => enterInterface(state, a.interface.replace(/\s+/g, '')) },
  { pattern: 'vlan <id>', help: 'Vlan commands', run: ({ state }, a) => enterVlan(state, a.id) },
  { pattern: 'line console <number>', help: 'Primary terminal line', run: ({ state }) => enterLine(state, 'con') },
  { pattern: 'line vty <first> <last>', help: 'Virtual terminal', run: ({ state }) => enterLine(state, 'vty') },
  { pattern: 'line vty <first>', help: 'Virtual terminal', run: ({ state }) => enterLine(state, 'vty') },
  { pattern: 'hostname <name>', help: "Set system's network name", run: ({ state }, a) => { if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(a.name)) return [INVALID_INPUT]; state.hostname = a.name; } },
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

export const GLOBAL_CONFIG: Def[] = [
  ...GLOBAL_JUMPS,
  { pattern: 'no hostname', help: 'Reset the hostname', run: ({ state }) => void (state.hostname = 'Switch') },
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
  { pattern: 'no vlan <id>', help: 'Delete a VLAN', run: ({ state }, a) => { const id = Number(a.id); if (id === 1 || (id >= 1002 && id <= 1005)) return [`% Default VLAN ${id} may not be deleted.`]; delete state.vlans[id]; } },
  { pattern: 'ip default-gateway <address>', help: 'Specify default gateway (if not routing IP)', run: ({ state }, a) => { if (!isValidIp(a.address)) return [INVALID_INPUT]; state.ipDefaultGateway = a.address; } },
  { pattern: 'no ip default-gateway', help: 'Remove default gateway', run: ({ state }) => void (state.ipDefaultGateway = undefined) },
  { pattern: 'ip domain-name <name>', help: 'Define the default domain name', run: ({ state }, a) => void (state.ipDomainName = a.name) },
  { pattern: 'no ip domain-name', help: 'Remove the default domain name', run: ({ state }) => void (state.ipDomainName = undefined) },
  { pattern: 'ip ssh version <version>', help: 'Specify protocol version to be supported', run: ({ state }, a) => { if (a.version !== '1' && a.version !== '2') return [INVALID_INPUT]; state.sshVersion = Number(a.version) as 1 | 2; } },
  { pattern: 'crypto key generate rsa', help: 'Generate RSA keys', run: ({ state }) => generateRsa(state, 1024) },
  { pattern: 'crypto key generate rsa modulus <bits>', help: 'Provide number of modulus bits on the command line', run: ({ state }, a) => generateRsa(state, Number(a.bits)) },
  { pattern: 'crypto key generate rsa general-keys modulus <bits>', help: 'Generate a general purpose RSA key pair', run: ({ state }, a) => generateRsa(state, Number(a.bits)) },
  { pattern: 'crypto key zeroize rsa', help: 'Remove RSA keys', run: ({ state }) => void (state.rsaKeyBits = undefined) },
  { pattern: 'service password-encryption', help: 'Encrypt system passwords', run: ({ state }) => void (state.servicePasswordEncryption = true) },
  { pattern: 'no service password-encryption', help: 'Stop encrypting system passwords', run: ({ state }) => void (state.servicePasswordEncryption = false) },
  { pattern: 'spanning-tree mode <mode>', help: 'Spanning tree operating mode', run: () => undefined },
  { pattern: 'exit', help: 'Exit from configure mode', run: ({ state }) => leaveConfig(state) },
  ...EXIT_CONFIG,
];

function generateRsa(state: DeviceState, bits: number): string[] {
  if (!state.ipDomainName) return ['% Please define a domain-name first.'];
  if (![360, 512, 768, 1024, 2048, 4096].includes(bits)) return ['% Modulus size must be one of 360, 512, 768, 1024, 2048 or 4096.'];
  state.rsaKeyBits = bits;
  return [`The name for the keys will be: ${state.hostname}.${state.ipDomainName}`, `% The key modulus size is ${bits} bits`, `% Generating ${bits} bit RSA keys, keys will be non-exportable...`, '[OK] (elapsed time was 2 seconds)'];
}

export const INTERFACE_CONFIG: Def[] = [
  { pattern: 'description <text...>', help: 'Interface specific description', run: ({ state }, a) => void (currentInterface(state).description = a.text) },
  { pattern: 'no description', help: 'Remove the description', run: ({ state }) => void (currentInterface(state).description = undefined) },
  { pattern: 'shutdown', help: 'Shutdown the selected interface', run: ({ state }) => { const i = currentInterface(state); if (i.shutdown) return; i.shutdown = true; return linkChange(i, false); } },
  { pattern: 'no shutdown', help: 'Bring the interface up', run: ({ state }) => { const i = currentInterface(state); if (!i.shutdown) return; i.shutdown = false; return i.connected || isSvi(i.name) ? linkChange(i, true) : undefined; } },
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
  { pattern: 'speed <speed>', help: 'Configure speed operation.', run: () => undefined },
  { pattern: 'duplex <duplex>', help: 'Configure duplex operation.', run: () => undefined },
  { pattern: 'ip address <address> <mask>', help: 'Set the IP address of an interface', run: ({ state }, a) => { const i = currentInterface(state); if (!isSvi(i.name)) return ['% IP addresses may not be configured on L2 links.']; if (!isValidIp(a.address) || !isValidMask(a.mask)) return ['% Invalid address/mask']; i.ipAddress = a.address; i.subnetMask = a.mask; } },
  { pattern: 'no ip address', help: 'Remove the IP address', run: ({ state }) => { const i = currentInterface(state); i.ipAddress = undefined; i.subnetMask = undefined; } },
  { pattern: 'exit', help: 'Exit from interface configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentInterface = undefined; } },
  ...EXIT_CONFIG,
  ...GLOBAL_JUMPS,
];

function l2(state: DeviceState, fn: (i: InterfaceState) => string[] | void): string[] | void {
  const i = currentInterface(state);
  if (isSvi(i.name)) return [INVALID_INPUT];
  return fn(i);
}

export const VLAN_CONFIG: Def[] = [
  { pattern: 'name <name...>', help: 'Ascii name of the VLAN', run: ({ state }, a) => void (state.vlans[state.currentVlan!].name = a.name.slice(0, 32)) },
  { pattern: 'no name', help: 'Reset the VLAN name', run: ({ state }) => void (state.vlans[state.currentVlan!].name = defaultVlanName(state.currentVlan!)) },
  { pattern: 'exit', help: 'Apply changes, bump revision number, and exit mode', run: ({ state }) => { state.mode = 'config'; state.currentVlan = undefined; } },
  ...EXIT_CONFIG,
  ...GLOBAL_JUMPS,
];

function currentLine(state: DeviceState) {
  return state.lines[state.currentLine!];
}

export const LINE_CONFIG: Def[] = [
  { pattern: 'password <password...>', help: 'Set a password', run: ({ state }, a) => void (currentLine(state).password = a.password) },
  { pattern: 'no password', help: 'Remove the password', run: ({ state }) => void (currentLine(state).password = undefined) },
  { pattern: 'login', help: 'Enable password checking', run: ({ state }) => { const l = currentLine(state); if (!l.password) return ['% Login disabled on line, until \'password\' is set']; l.login = true; } },
  { pattern: 'login local', help: 'Local password checking', run: ({ state }) => void (currentLine(state).login = 'local') },
  { pattern: 'no login', help: 'Disable password checking', run: ({ state }) => void (currentLine(state).login = false) },
  { pattern: 'transport input <protocol>', help: 'Define which protocols to use to connect to a specific line', run: ({ state }, a) => { const p = a.protocol.toLowerCase(); if (!['all', 'ssh', 'telnet', 'none'].includes(p)) return [INVALID_INPUT]; currentLine(state).transportInput = p as 'all' | 'ssh' | 'telnet' | 'none'; } },
  { pattern: 'exec-timeout <minutes> <seconds>', help: 'Set the EXEC timeout', run: () => undefined },
  { pattern: 'exec-timeout <minutes>', help: 'Set the EXEC timeout', run: () => undefined },
  { pattern: 'logging synchronous', help: 'Synchronized message output', run: () => undefined },
  { pattern: 'exit', help: 'Exit from line configuration mode', run: ({ state }) => { state.mode = 'config'; state.currentLine = undefined; } },
  ...EXIT_CONFIG,
  ...GLOBAL_JUMPS,
];

export function defsForMode(mode: Mode): Def[] {
  switch (mode) {
    case 'user':
      return USER_EXEC;
    case 'privileged':
      return PRIV_EXEC;
    case 'config':
      return GLOBAL_CONFIG;
    case 'interface':
      return INTERFACE_CONFIG;
    case 'vlan':
      return VLAN_CONFIG;
    case 'line':
      return LINE_CONFIG;
  }
}

export function isConfigMode(mode: Mode): boolean {
  return mode !== 'user' && mode !== 'privileged';
}
