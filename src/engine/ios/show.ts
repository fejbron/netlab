import type { DeviceState, InterfaceState } from '../types';
import { compareInterfaceNames, isSvi, shortInterfaceName } from '../interfaces';

export const IOS_VERSION = '15.2(7)E8';

export function sortedInterfaces(state: DeviceState): InterfaceState[] {
  return Object.values(state.interfaces).sort((a, b) => compareInterfaceNames(a.name, b.name));
}

export function physicalInterfaces(state: DeviceState): InterfaceState[] {
  return sortedInterfaces(state).filter((i) => !isSvi(i.name));
}

/** Deterministic fake MD5-style hash so "enable secret 5 ..." looks right. */
export function fakeSecretHash(secret: string): string {
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < secret.length; i++) {
    h1 = Math.imul(h1 ^ secret.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + secret.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  let out = '';
  let seed = (h1 ^ h2) >>> 0;
  for (let i = 0; i < 22; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out += alphabet[seed % alphabet.length];
  }
  return `$1$mERr$${out}`;
}

/** Fake "type 7" reversible encoding used when service password-encryption is on. */
export function type7(password: string): string {
  const key = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
  let out = '08';
  for (let i = 0; i < password.length; i++) {
    const k = key.charCodeAt((i + 8) % key.length);
    out += (password.charCodeAt(i) ^ k).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function pw(state: DeviceState, password: string): string {
  return state.servicePasswordEncryption ? `7 ${type7(password)}` : password;
}

export function formatVlanList(vlans: 'all' | number[]): string {
  if (vlans === 'all') return '1-4094';
  const sorted = [...new Set(vlans)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i + 1 ? `${sorted[i]}-${sorted[j]}` : j === i + 1 ? `${sorted[i]},${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** The saveable body of the configuration, from the first "!" to "end". */
export function renderConfigBody(state: DeviceState): string[] {
  const out: string[] = [];
  const pushLine = (o: string[], l: DeviceState['lines']['con']) => {
    if (l.password) o.push(` password ${pw(state, l.password)}`);
    if (l.login === true) o.push(' login');
    if (l.login === 'local') o.push(' login local');
    if (l.transportInput && l.transportInput !== 'all') o.push(` transport input ${l.transportInput}`);
  };
  out.push('!', 'version 15.2', 'no service pad', 'service timestamps debug datetime msec', 'service timestamps log datetime msec');
  out.push(state.servicePasswordEncryption ? 'service password-encryption' : 'no service password-encryption');
  out.push('!', `hostname ${state.hostname}`, '!', 'boot-start-marker', 'boot-end-marker', '!');
  if (state.enableSecret) out.push(`enable secret 5 ${fakeSecretHash(state.enableSecret)}`);
  if (state.enablePassword) out.push(`enable password ${pw(state, state.enablePassword)}`);
  if (state.enableSecret || state.enablePassword) out.push('!');
  for (const u of state.users) {
    const priv = u.privilege !== 1 ? ` privilege ${u.privilege}` : '';
    out.push(u.secret ? `username ${u.username}${priv} secret 5 ${fakeSecretHash(u.password)}` : `username ${u.username}${priv} password ${pw(state, u.password)}`);
  }
  if (state.users.length) out.push('!');
  out.push('no aaa new-model', 'system mtu routing 1500', '!');
  if (state.ipDomainName) out.push(`ip domain-name ${state.ipDomainName}`, '!');
  if (state.sshVersion) out.push(`ip ssh version ${state.sshVersion}`, '!');
  out.push('spanning-tree mode pvst', 'spanning-tree extend system-id', '!', 'vlan internal allocation policy ascending', '!');
  const userVlans = Object.values(state.vlans)
    .filter((v) => v.id !== 1 && v.id < 1002)
    .sort((a, b) => a.id - b.id);
  for (const v of userVlans) {
    out.push(`vlan ${v.id}`);
    if (v.name !== defaultVlanName(v.id)) out.push(` name ${v.name}`);
    out.push('!');
  }
  for (const i of sortedInterfaces(state)) {
    out.push(`interface ${i.name}`);
    if (i.description) out.push(` description ${i.description}`);
    if (isSvi(i.name)) {
      out.push(i.ipAddress && i.subnetMask ? ` ip address ${i.ipAddress} ${i.subnetMask}` : ' no ip address');
    } else {
      if (i.accessVlan !== 1) out.push(` switchport access vlan ${i.accessVlan}`);
      if (i.trunkAllowed !== 'all') out.push(` switchport trunk allowed vlan ${formatVlanList(i.trunkAllowed)}`);
      if (i.nativeVlan !== 1) out.push(` switchport trunk native vlan ${i.nativeVlan}`);
      if (i.mode !== 'dynamic') out.push(` switchport mode ${i.mode}`);
    }
    if (i.shutdown) out.push(' shutdown');
    out.push('!');
  }
  if (state.ipDefaultGateway) out.push(`ip default-gateway ${state.ipDefaultGateway}`);
  out.push('ip http server', 'ip http secure-server', '!');
  if (state.bannerMotd) out.push(`banner motd ^C${state.bannerMotd}^C`, '!');
  out.push('line con 0');
  pushLine(out, state.lines.con);
  out.push('line vty 0 4');
  pushLine(out, state.lines.vty);
  out.push('line vty 5 15');
  pushLine(out, state.lines.vty);
  out.push('!', 'end');
  return out;
}

export function defaultVlanName(id: number): string {
  return `VLAN${String(id).padStart(4, '0')}`;
}

export function showRunningConfig(state: DeviceState): string[] {
  const body = renderConfigBody(state);
  const bytes = body.join('\n').length + 40;
  return ['Building configuration...', '', `Current configuration : ${bytes} bytes`, ...body];
}

export function showStartupConfig(state: DeviceState): string[] {
  if (state.startupConfig === null) return ['startup-config is not present'];
  const body = state.startupConfig.split('\n');
  return [`Using ${body.join('\n').length + 40} out of 65536 bytes`, ...body];
}

export function showVlanBrief(state: DeviceState): string[] {
  const out = [
    'VLAN Name                             Status    Ports',
    '---- -------------------------------- --------- -------------------------------',
  ];
  const vlans = Object.values(state.vlans).sort((a, b) => a.id - b.id);
  for (const v of vlans) {
    const ports = physicalInterfaces(state)
      .filter((i) => i.mode !== 'trunk' && i.accessVlan === v.id)
      .map((i) => shortInterfaceName(i.name));
    const status = v.id >= 1002 ? 'act/unsup' : 'active';
    const chunks: string[] = [];
    for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
    out.push(`${String(v.id).padEnd(5)}${v.name.slice(0, 32).padEnd(33)}${status.padEnd(10)}${chunks[0] ?? ''}`);
    for (const c of chunks.slice(1)) out.push(`${''.padEnd(48)}${c}`);
  }
  return out;
}

export function interfaceStatus(i: InterfaceState): 'connected' | 'notconnect' | 'disabled' {
  if (i.shutdown) return 'disabled';
  return i.connected ? 'connected' : 'notconnect';
}

export function showInterfacesStatus(state: DeviceState): string[] {
  const out = ['Port      Name               Status       Vlan       Duplex  Speed  Type'];
  for (const i of physicalInterfaces(state)) {
    const status = interfaceStatus(i);
    const vlan = i.mode === 'trunk' ? 'trunk' : String(i.accessVlan);
    const duplex = status === 'connected' ? 'a-full' : 'auto';
    const speed = status === 'connected' ? 'a-1000' : 'auto';
    out.push(
      `${shortInterfaceName(i.name).padEnd(10)}${(i.description ?? '').slice(0, 18).padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(7)}10/100/1000BaseTX`,
    );
  }
  return out;
}

export function showInterfacesTrunk(state: DeviceState): string[] {
  const trunks = physicalInterfaces(state).filter((i) => i.mode === 'trunk' && !i.shutdown);
  if (trunks.length === 0) return [];
  const existing = Object.keys(state.vlans).map(Number);
  const out = ['Port        Mode             Encapsulation  Status        Native vlan'];
  for (const t of trunks) out.push(`${shortInterfaceName(t.name).padEnd(12)}${'on'.padEnd(17)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${t.nativeVlan}`);
  out.push('', 'Port        Vlans allowed on trunk');
  for (const t of trunks) out.push(`${shortInterfaceName(t.name).padEnd(12)}${formatVlanList(t.trunkAllowed)}`);
  out.push('', 'Port        Vlans allowed and active in management domain');
  for (const t of trunks) {
    const active = existing.filter((v) => v < 1002 && (t.trunkAllowed === 'all' || t.trunkAllowed.includes(v)));
    out.push(`${shortInterfaceName(t.name).padEnd(12)}${formatVlanList(active)}`);
  }
  out.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  for (const t of trunks) {
    const active = existing.filter((v) => v < 1002 && (t.trunkAllowed === 'all' || t.trunkAllowed.includes(v)));
    out.push(`${shortInterfaceName(t.name).padEnd(12)}${formatVlanList(active)}`);
  }
  return out;
}

export function showIpInterfaceBrief(state: DeviceState): string[] {
  const out = ['Interface              IP-Address      OK? Method Status                Protocol'];
  for (const i of sortedInterfaces(state)) {
    const ip = i.ipAddress ?? 'unassigned';
    const method = i.ipAddress ? 'manual' : 'unset';
    let status: string;
    let protocol: string;
    if (i.shutdown) {
      status = 'administratively down';
      protocol = 'down';
    } else if (isSvi(i.name) || i.connected) {
      status = 'up';
      protocol = 'up';
    } else {
      status = 'down';
      protocol = 'down';
    }
    out.push(`${i.name.padEnd(23)}${ip.padEnd(16)}YES ${method.padEnd(7)}${status.padEnd(22)}${protocol}`);
  }
  return out;
}

export function showMacAddressTable(state: DeviceState): string[] {
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  let count = 0;
  for (const n of state.neighbors) {
    const i = state.interfaces[n.interface];
    if (!i || i.shutdown || !i.connected) continue;
    const vlan = i.mode === 'trunk' ? i.nativeVlan : i.accessVlan;
    out.push(`${String(vlan).padStart(4)}    ${n.mac}    DYNAMIC     ${shortInterfaceName(i.name)}`);
    count++;
  }
  out.push(`Total Mac Addresses for this criterion: ${count}`);
  return out;
}

export function showVersion(state: DeviceState): string[] {
  return [
    `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version ${IOS_VERSION}, RELEASE SOFTWARE (fc3)`,
    'Technical Support: http://www.cisco.com/techsupport',
    'Copyright (c) 1986-2023 by Cisco Systems, Inc.',
    '',
    `${state.hostname} uptime is 2 hours, 14 minutes`,
    'System returned to ROM by power-on',
    'System image file is "flash:/c2960-lanbasek9-mz.152-7.E8.bin"',
    '',
    'cisco WS-C2960-24TT-L (PowerPC405) processor (revision B0) with 65536K bytes of memory.',
    `${physicalInterfaces(state).length} Gigabit Ethernet interfaces`,
    '64K bytes of flash-simulated non-volatile configuration memory.',
    '',
    'Configuration register is 0xF',
  ];
}

export function showInterfaceSwitchport(state: DeviceState, i: InterfaceState): string[] {
  const adminMode = i.mode === 'dynamic' ? 'dynamic auto' : i.mode === 'trunk' ? 'trunk' : 'static access';
  const operMode = i.mode === 'trunk' ? 'trunk' : 'static access';
  const vlanName = state.vlans[i.accessVlan]?.name ?? 'unknown';
  return [
    `Name: ${shortInterfaceName(i.name)}`,
    'Switchport: Enabled',
    `Administrative Mode: ${adminMode}`,
    `Operational Mode: ${i.shutdown || !i.connected ? 'down' : operMode}`,
    'Administrative Trunking Encapsulation: dot1q',
    `Negotiation of Trunking: ${i.mode === 'dynamic' ? 'On' : 'Off'}`,
    `Access Mode VLAN: ${i.accessVlan} (${vlanName})`,
    `Trunking Native Mode VLAN: ${i.nativeVlan} (${state.vlans[i.nativeVlan]?.name ?? 'Inactive'})`,
    `Trunking VLANs Enabled: ${i.trunkAllowed === 'all' ? 'ALL' : formatVlanList(i.trunkAllowed)}`,
  ];
}

export function showSpanningTree(state: DeviceState): string[] {
  const out: string[] = [];
  const vlans = Object.values(state.vlans)
    .filter((v) => v.id < 1002)
    .sort((a, b) => a.id - b.id);
  for (const v of vlans) {
    const ports = physicalInterfaces(state).filter((i) => !i.shutdown && i.connected && (i.mode === 'trunk' || i.accessVlan === v.id));
    if (ports.length === 0) continue;
    out.push(`VLAN${String(v.id).padStart(4, '0')}`, '  Spanning tree enabled protocol ieee', `  Root ID    Priority    ${32768 + v.id}`, '             This bridge is the root', '');
    out.push('Interface           Role Sts Cost      Prio.Nbr Type', '------------------- ---- --- --------- -------- --------------------------------');
    for (const p of ports) out.push(`${shortInterfaceName(p.name).padEnd(20)}Desg FWD 4         128.${p.name.match(/\d+$/)?.[0] ?? '1'}    P2p`);
    out.push('');
  }
  return out.length ? out : ['No spanning tree instance exists.'];
}

export function showIpSsh(state: DeviceState): string[] {
  if (!state.rsaKeyBits) return ['SSH Disabled - version 1.99', '%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).', 'Authentication timeout: 120 secs; Authentication retries: 3'];
  return [`SSH Enabled - version ${state.sshVersion === 2 ? '2.0' : '1.99'}`, 'Authentication timeout: 120 secs; Authentication retries: 3', `Minimum expected Diffie Hellman key size : ${state.rsaKeyBits >= 2048 ? 2048 : 1024} bits`];
}

export function showHistory(state: DeviceState): string[] {
  return state.commandHistory.slice(-10).map((c) => `  ${c}`);
}
