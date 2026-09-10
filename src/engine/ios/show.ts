import type { Acl, DeviceState, InterfaceState } from '../types';
import { compareInterfaceNames, isPortChannel, isSvi, shortInterfaceName } from '../interfaces';
import { ifaceIpv6, isLoopback, isSubinterface, type ChannelStatus, type MacEntry, type OspfInterfaceInfo, type OspfNeighbor, type RouteEntry, type RouteEntry6 } from '../network';
import { ruleText } from '../acl';
import { networkAddress6 } from '../ipv6';
import { classfulNetwork, ipToInt, prefixLength } from './net';

export const IOS_VERSION = '15.2(7)E8';

export function sortedInterfaces(state: DeviceState): InterfaceState[] {
  return Object.values(state.interfaces).sort((a, b) => compareInterfaceNames(a.name, b.name));
}

export function physicalInterfaces(state: DeviceState): InterfaceState[] {
  return sortedInterfaces(state).filter((i) => !isSvi(i.name) && !isLoopback(i.name) && !isSubinterface(i.name));
}

/** Interfaces that carry VLAN membership in show output: bundled members are represented by their Port-channel. */
function l2Interfaces(state: DeviceState): InterfaceState[] {
  return physicalInterfaces(state).filter((i) => !i.channelGroup || isPortChannel(i.name));
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
  return state.deviceType === 'router' ? renderRouterConfigBody(state) : renderSwitchConfigBody(state);
}

function pushLineConfig(state: DeviceState, o: string[], l: DeviceState['lines']['con']) {
  if (l.accessClass) o.push(` access-class ${l.accessClass} in`);
  if (l.password) o.push(` password ${pw(state, l.password)}`);
  if (l.login === true) o.push(' login');
  if (l.login === 'local') o.push(' login local');
  if (l.transportInput && l.transportInput !== 'all') o.push(` transport input ${l.transportInput}`);
}

function pushAclConfig(state: DeviceState, out: string[]) {
  for (const acl of Object.values(state.acls)) {
    if (/^\d+$/.test(acl.name)) {
      for (const e of acl.entries) out.push(`access-list ${acl.name} ${ruleText(e, acl.kind)}`);
    } else {
      out.push(`ip access-list ${acl.kind} ${acl.name}`);
      for (const e of acl.entries) out.push(` ${e.seq} ${ruleText(e, acl.kind)}`);
    }
    out.push('!');
  }
}

function pushSecurityConfig(state: DeviceState, out: string[]) {
  if (state.enableSecret) out.push(`enable secret 5 ${fakeSecretHash(state.enableSecret)}`);
  if (state.enablePassword) out.push(`enable password ${pw(state, state.enablePassword)}`);
  if (state.enableSecret || state.enablePassword) out.push('!');
  for (const u of state.users) {
    const priv = u.privilege !== 1 ? ` privilege ${u.privilege}` : '';
    out.push(u.secret ? `username ${u.username}${priv} secret 5 ${fakeSecretHash(u.password)}` : `username ${u.username}${priv} password ${pw(state, u.password)}`);
  }
  if (state.users.length) out.push('!');
}

function pushTail(state: DeviceState, out: string[]) {
  if (state.bannerMotd) out.push(`banner motd ^C${state.bannerMotd}^C`, '!');
  out.push('line con 0');
  pushLineConfig(state, out, state.lines.con);
  out.push('line vty 0 4');
  pushLineConfig(state, out, state.lines.vty);
  out.push('line vty 5 15');
  pushLineConfig(state, out, state.lines.vty);
  out.push('!', 'end');
}

function renderRouterConfigBody(state: DeviceState): string[] {
  const out: string[] = [];
  out.push('!', 'version 15.4', 'service timestamps debug datetime msec', 'service timestamps log datetime msec');
  out.push(state.servicePasswordEncryption ? 'service password-encryption' : 'no service password-encryption');
  out.push('!', `hostname ${state.hostname}`, '!', 'boot-start-marker', 'boot-end-marker', '!');
  pushSecurityConfig(state, out);
  out.push('no aaa new-model', '!');
  if (state.ipDomainName) out.push(`ip domain-name ${state.ipDomainName}`, '!');
  if (state.sshVersion) out.push(`ip ssh version ${state.sshVersion}`, '!');
  out.push('ip cef', state.ipv6UnicastRouting ? 'ipv6 unicast-routing' : 'no ipv6 cef', '!');
  if (!state.ipRouting) out.push('no ip routing', '!');
  for (const r of state.dhcpExcluded) out.push(`ip dhcp excluded-address ${r.from}${r.to !== r.from ? ` ${r.to}` : ''}`);
  if (state.dhcpExcluded.length) out.push('!');
  for (const p of Object.values(state.dhcpPools)) {
    out.push(`ip dhcp pool ${p.name}`);
    if (p.network && p.mask) out.push(` network ${p.network} ${p.mask}`);
    if (p.defaultRouter) out.push(` default-router ${p.defaultRouter}`);
    if (p.dnsServer) out.push(` dns-server ${p.dnsServer}`);
    if (p.domainName) out.push(` domain-name ${p.domainName}`);
    out.push('!');
  }
  for (const i of sortedInterfaces(state)) {
    out.push(`interface ${i.name}`);
    if (i.description) out.push(` description ${i.description}`);
    if (i.encapsulation) out.push(` encapsulation dot1Q ${i.encapsulation.vlan}${i.encapsulation.native ? ' native' : ''}`);
    out.push(i.ipAddress && i.subnetMask ? ` ip address ${i.ipAddress} ${i.subnetMask}` : ' no ip address');
    if (i.helperAddress) out.push(` ip helper-address ${i.helperAddress}`);
    if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
    if (i.aclOut) out.push(` ip access-group ${i.aclOut} out`);
    if (i.natRole) out.push(` ip nat ${i.natRole}`);
    if (i.ipv6) {
      if (i.ipv6.linkLocal) out.push(` ipv6 address ${i.ipv6.linkLocal} link-local`);
      for (const a of i.ipv6.addresses) out.push(a.eui64 ? ` ipv6 address ${networkAddress6(a.address, a.prefix)}/${a.prefix} eui-64` : ` ipv6 address ${a.address}/${a.prefix}`);
      if (i.ipv6.enabled && i.ipv6.addresses.length === 0 && !i.ipv6.linkLocal) out.push(' ipv6 enable');
    }
    if (i.ospfArea !== undefined && state.ospf) out.push(` ip ospf ${state.ospf.processId} area ${i.ospfArea}`);
    if (i.ospfCost !== undefined) out.push(` ip ospf cost ${i.ospfCost}`);
    if (i.ospfPriority !== undefined) out.push(` ip ospf priority ${i.ospfPriority}`);
    if (i.shutdown) out.push(' shutdown');
    if (!isSubinterface(i.name) && !isLoopback(i.name)) out.push(' duplex auto', ' speed auto');
    out.push('!');
  }
  if (state.ospf) {
    const o = state.ospf;
    out.push(`router ospf ${o.processId}`);
    if (o.routerId) out.push(` router-id ${o.routerId}`);
    if (o.passiveDefault) {
      out.push(' passive-interface default');
      for (const i of o.activeInterfaces) out.push(` no passive-interface ${i}`);
    } else for (const i of o.passiveInterfaces) out.push(` passive-interface ${i}`);
    for (const n of o.networks) out.push(` network ${n.address} ${n.wildcard} area ${n.area}`);
    if (o.defaultInformationOriginate) out.push(' default-information originate');
    out.push('!');
  }
  out.push('ip forward-protocol nd', '!');
  for (const r of state.staticRoutes) {
    const via = r.nextHop ?? r.exitInterface;
    out.push(`ip route ${r.destination} ${r.mask} ${via}${r.adminDistance !== 1 ? ` ${r.adminDistance}` : ''}`);
  }
  if (state.staticRoutes.length) out.push('!');
  for (const p of Object.values(state.natPools)) out.push(`ip nat pool ${p.name} ${p.start} ${p.end} netmask ${p.netmask}`);
  if (state.natDynamic) {
    const d = state.natDynamic;
    out.push(`ip nat inside source list ${d.acl} ${d.interface ? `interface ${d.interface}` : `pool ${d.pool}`}${d.overload ? ' overload' : ''}`);
  }
  for (const s of state.natStatic) out.push(`ip nat inside source static ${s.insideLocal} ${s.insideGlobal}`);
  if (Object.keys(state.natPools).length || state.natDynamic || state.natStatic.length) out.push('!');
  for (const r of state.staticRoutes6) out.push(`ipv6 route ${r.prefix}/${r.length} ${r.exitInterface ? `${r.exitInterface}${r.nextHop ? ` ${r.nextHop}` : ''}` : r.nextHop}`);
  if (state.staticRoutes6.length) out.push('!');
  pushAclConfig(state, out);
  pushTail(state, out);
  return out;
}

export function showEtherchannelSummary(groups: ChannelStatus[]): string[] {
  const out = [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '',
    '        M - not in use, minimum links not met',
    '        u - unsuitable for bundling',
    '        w - waiting to be aggregated',
    '        d - default port',
    '',
    '        A - formed by Auto LAG',
    '',
    '',
    `Number of channel-groups in use: ${groups.length}`,
    `Number of aggregators:           ${groups.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
  ];
  for (const g of groups) {
    const po = `Po${g.id}(${g.bundled ? 'SU' : 'SD'})`;
    const ports = g.members.map((m) => `${shortInterfaceName(m.name)}(${m.flag})`.padEnd(12)).join('').trimEnd();
    out.push(`${String(g.id).padEnd(7)}${po.padEnd(16)}${g.protocol.padEnd(10)}${ports}`);
  }
  return out;
}

export function showPortSecurity(state: DeviceState): string[] {
  const out = ['Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action', '                (Count)       (Count)          (Count)', '---------------------------------------------------------------------------'];
  let total = 0;
  for (const i of physicalInterfaces(state)) {
    const ps = i.portSecurity;
    if (!ps?.enabled) continue;
    const current = ps.staticMacs.length + ps.stickyMacs.length + ps.learnedMacs.length;
    total += current;
    out.push(`${shortInterfaceName(i.name).padEnd(15)}${String(ps.maximum).padEnd(15)}${String(current).padEnd(18)}${String(ps.violations).padEnd(14)}${ps.violation[0].toUpperCase()}${ps.violation.slice(1)}`);
  }
  out.push('---------------------------------------------------------------------------', `Total Addresses in System (excluding one mac per port)     : ${Math.max(0, total - out.length + 4)}`, 'Max Addresses limit in System (excluding one mac per port) : 8192');
  return out;
}

export function showPortSecurityInterface(i: InterfaceState): string[] {
  const ps = i.portSecurity ?? { enabled: false, maximum: 1, violation: 'shutdown', sticky: false, staticMacs: [], stickyMacs: [], learnedMacs: [], violations: 0 };
  const current = ps.staticMacs.length + ps.stickyMacs.length + ps.learnedMacs.length;
  const portStatus = i.errDisabled ? 'Secure-shutdown' : ps.enabled && (i.connected && !i.shutdown) ? 'Secure-up' : 'Secure-down';
  return [
    `Port Security              : ${ps.enabled ? 'Enabled' : 'Disabled'}`,
    `Port Status                : ${portStatus}`,
    `Violation Mode             : ${ps.violation[0].toUpperCase()}${ps.violation.slice(1)}`,
    'Aging Time                 : 0 mins',
    'Aging Type                 : Absolute',
    'SecureStatic Address Aging : Disabled',
    `Maximum MAC Addresses      : ${ps.maximum}`,
    `Total MAC Addresses        : ${current}`,
    `Configured MAC Addresses   : ${ps.staticMacs.length}`,
    `Sticky MAC Addresses       : ${ps.stickyMacs.length}`,
    `Last Source Address:Vlan   : ${ps.lastViolationMac ?? [...ps.stickyMacs, ...ps.learnedMacs, ...ps.staticMacs][0] ?? '0000.0000.0000'}:${i.accessVlan}`,
    `Security Violation Count   : ${ps.violations}`,
  ];
}

export function showPortSecurityAddress(state: DeviceState): string[] {
  const out = ['               Secure Mac Address Table', '-----------------------------------------------------------------------------', 'Vlan    Mac Address       Type                          Ports   Remaining Age', '                                                                   (mins)', '----    -----------       ----                          -----   -------------'];
  let count = 0;
  for (const i of physicalInterfaces(state)) {
    const ps = i.portSecurity;
    if (!ps?.enabled) continue;
    for (const m of ps.staticMacs) out.push(`${String(i.accessVlan).padStart(4)}    ${m}    SecureConfigured              ${shortInterfaceName(i.name).padEnd(8)}-`), count++;
    for (const m of ps.stickyMacs) out.push(`${String(i.accessVlan).padStart(4)}    ${m}    SecureSticky                  ${shortInterfaceName(i.name).padEnd(8)}-`), count++;
    for (const m of ps.learnedMacs) out.push(`${String(i.accessVlan).padStart(4)}    ${m}    SecureDynamic                 ${shortInterfaceName(i.name).padEnd(8)}-`), count++;
  }
  out.push('-----------------------------------------------------------------------------', `Total Addresses in System (excluding one mac per port)     : ${count}`, 'Max Addresses limit in System (excluding one mac per port) : 8192');
  return out;
}

export function showIpNatTranslations(state: DeviceState): string[] {
  const out = ['Pro  Inside global         Inside local          Outside local         Outside global'];
  const col = (s: string) => s.padEnd(22);
  for (const s of state.natStatic) out.push(`---  ${col(s.insideGlobal)}${col(s.insideLocal)}${col('---')}---`);
  for (const t of state.natTranslations) {
    if (t.proto === '---') {
      out.push(`---  ${col(t.insideGlobal)}${col(t.insideLocal)}${col('---')}---`);
      continue;
    }
    const ig = `${t.insideGlobal}:${t.insideGlobalPort ?? ''}`;
    const il = `${t.insideLocal}:${t.insideLocalPort ?? ''}`;
    const og = `${t.outsideGlobal ?? '---'}:${t.outsidePort ?? ''}`;
    out.push(`${t.proto.padEnd(5)}${col(ig)}${col(il)}${col(og)}${og}`);
  }
  return out.length === 1 ? [] : out;
}

export function showIpNatStatistics(state: DeviceState): string[] {
  const dynamic = state.natTranslations.filter((t) => !t.static).length;
  const extended = state.natTranslations.filter((t) => t.proto !== '---').length;
  const out = [`Total active translations: ${state.natStatic.length + state.natTranslations.length} (${state.natStatic.length} static, ${dynamic} dynamic; ${extended} extended)`];
  const outside = Object.values(state.interfaces).filter((i) => i.natRole === 'outside').map((i) => i.name);
  const inside = Object.values(state.interfaces).filter((i) => i.natRole === 'inside').map((i) => i.name);
  out.push('Outside interfaces:', ...(outside.length ? outside.map((n) => `  ${n}`) : ['  (none)']), 'Inside interfaces:', ...(inside.length ? inside.map((n) => `  ${n}`) : ['  (none)']));
  out.push(`Hits: ${state.natTranslations.length * 5}  Misses: 0`, 'Dynamic mappings:', '-- Inside Source');
  if (state.natDynamic) {
    const d = state.natDynamic;
    out.push(`[Id: 1] access-list ${d.acl} ${d.interface ? `interface ${d.interface}` : `pool ${d.pool}`} refcount ${dynamic}`);
    if (d.pool && state.natPools[d.pool]) {
      const p = state.natPools[d.pool];
      out.push(` pool ${p.name}: netmask ${p.netmask}`, `\tstart ${p.start} end ${p.end}`, `\ttype generic, total addresses ${(ipToInt(p.end) ?? 0) - (ipToInt(p.start) ?? 0) + 1}, allocated ${new Set(state.natTranslations.filter((t) => !t.static).map((t) => t.insideGlobal)).size}`);
    }
  }
  return out;
}

export function showIpv6InterfaceBrief(state: DeviceState): string[] {
  const out: string[] = [];
  for (const i of sortedInterfaces(state)) {
    if (isSvi(i.name)) continue;
    const status = i.shutdown ? 'administratively down/down' : i.connected ? 'up/up' : 'down/down';
    out.push(`${i.name.padEnd(23)}[${status}]`);
    const v6 = ifaceIpv6(state, i);
    if (!v6.linkLocal) {
      out.push('    unassigned');
      continue;
    }
    out.push(`    ${v6.linkLocal}`);
    for (const a of v6.global) out.push(`    ${a.address}`);
  }
  return out;
}

export function showIpv6Route(entries: RouteEntry6[]): string[] {
  const out = [
    `IPv6 Routing Table - default - ${entries.length + 1} entries`,
    'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
    '       B - BGP, R - RIP, H - NHRP, I1 - ISIS L1',
    '       I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary, D - EIGRP',
    '       EX - EIGRP external, ND - ND Default, NDp - ND Prefix, DCE - Destination',
    '       NDr - Redirect, O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1',
    '       OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
  ];
  const code = (e: RouteEntry6) => (e.source === 'connected' ? 'C' : e.source === 'local' ? 'L' : 'S');
  for (const e of entries) {
    out.push(`${code(e).padEnd(4)}${e.prefix}/${e.length} [${e.adminDistance}/0]`);
    if (e.source === 'connected') out.push(`     via ${e.exitInterface}, directly connected`);
    else if (e.source === 'local') out.push(`     via ${e.exitInterface}, receive`);
    else if (e.nextHop && e.exitInterface && e.nextHop.toUpperCase().startsWith('FE80')) out.push(`     via ${e.nextHop}, ${e.exitInterface}`);
    else if (e.nextHop) out.push(`     via ${e.nextHop}`);
    else out.push(`     via ${e.exitInterface}, directly connected`);
  }
  out.push('L   FF00::/8 [0/0]', '     via Null0, receive');
  return out;
}

export function showAccessLists(acls: Acl[]): string[] {
  const out: string[] = [];
  for (const acl of acls) {
    out.push(`${acl.kind === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`);
    for (const e of acl.entries) {
      if (e.action === 'remark') continue;
      out.push(`    ${e.seq} ${ruleText(e, acl.kind, true)}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''}`);
    }
  }
  return out;
}

export function showIpDhcpBinding(state: DeviceState): string[] {
  const out = ['Bindings from all pools not associated with VRF:', 'IP address      Client-ID/              Lease expiration        Type', '                Hardware address/', '                User name'];
  for (const b of state.dhcpBindings) {
    // IOS shows the client identifier as 01 (Ethernet) followed by the MAC, regrouped in fours.
    const clientId = `01${b.mac.replace(/\./g, '')}`.match(/.{1,4}/g)!.join('.');
    out.push(`${b.ip.padEnd(16)}${clientId.padEnd(24)}Sep 11 2026 03:04 PM    Automatic`);
  }
  return out;
}

export function showIpDhcpPool(state: DeviceState): string[] {
  const out: string[] = [];
  for (const p of Object.values(state.dhcpPools)) {
    const total = p.mask ? Math.max(0, 2 ** (32 - prefixLength(p.mask)) - 2) : 0;
    const leased = state.dhcpBindings.filter((b) => b.pool === p.name).length;
    const excludedCount = p.network && p.mask ? state.dhcpExcluded.reduce((n, r) => n + Math.max(0, (ipToInt(r.to) ?? 0) - (ipToInt(r.from) ?? 0) + 1), 0) : 0;
    out.push(`Pool ${p.name} :`, ' Utilization mark (high/low)    : 100 / 0', ' Subnet size (first/next)       : 0 / 0', ` Total addresses                : ${total}`, ` Leased addresses               : ${leased}`, ` Excluded addresses             : ${excludedCount}`, ' Pending event                  : none');
    if (p.network && p.mask) {
      const first = ((ipToInt(p.network) ?? 0) + 1) >>> 0;
      const last = (((ipToInt(p.network) ?? 0) | (~(ipToInt(p.mask) ?? 0) >>> 0)) >>> 0) - 1;
      out.push(' 1 subnet is currently in the pool :', ' Current index        IP address range                    Leased/Excluded/Total', ` ${ipText(first).padEnd(21)}${ipText(first).padEnd(17)}- ${ipText(last).padEnd(17)}${String(leased).padEnd(6)}/ ${String(excludedCount).padEnd(6)}/ ${total}`);
    } else out.push(' 0 subnets are currently in the pool');
  }
  return out.length ? out : ['%DHCP: No pools configured'];
}

function ipText(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function showIpInterface(i: InterfaceState): string[] {
  const line = i.shutdown ? 'administratively down, line protocol is down' : i.connected ? 'up, line protocol is up' : 'down, line protocol is down';
  return [
    `${i.name} is ${line}`,
    i.ipAddress && i.subnetMask ? `  Internet address is ${i.ipAddress}/${prefixLength(i.subnetMask)}` : '  Internet protocol processing disabled',
    '  Broadcast address is 255.255.255.255',
    '  Address determined by setup command',
    '  MTU is 1500 bytes',
    i.helperAddress ? `  Helper address is ${i.helperAddress}` : '  Helper address is not set',
    '  Directed broadcast forwarding is disabled',
    i.aclOut ? `  Outgoing access list is ${i.aclOut}` : '  Outgoing access list is not set',
    i.aclIn ? `  Inbound  access list is ${i.aclIn}` : '  Inbound  access list is not set',
    '  Proxy ARP is enabled',
    '  Local Proxy ARP is disabled',
    '  ICMP redirects are always sent',
    '  ICMP unreachables are always sent',
  ];
}

function renderSwitchConfigBody(state: DeviceState): string[] {
  const out: string[] = [];
  out.push('!', 'version 15.2', 'no service pad', 'service timestamps debug datetime msec', 'service timestamps log datetime msec');
  out.push(state.servicePasswordEncryption ? 'service password-encryption' : 'no service password-encryption');
  out.push('!', `hostname ${state.hostname}`, '!', 'boot-start-marker', 'boot-end-marker', '!');
  pushSecurityConfig(state, out);
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
      const ps = i.portSecurity;
      if (ps?.enabled) {
        out.push(' switchport port-security');
        if (ps.maximum !== 1) out.push(` switchport port-security maximum ${ps.maximum}`);
        if (ps.violation !== 'shutdown') out.push(` switchport port-security violation ${ps.violation}`);
        if (ps.sticky) out.push(' switchport port-security mac-address sticky');
        for (const m of ps.stickyMacs) out.push(` switchport port-security mac-address sticky ${m}`);
        for (const m of ps.staticMacs) out.push(` switchport port-security mac-address ${m}`);
      }
      if (i.channelGroup) out.push(` channel-group ${i.channelGroup.id} mode ${i.channelGroup.mode}`);
    }
    if (i.shutdown) out.push(' shutdown');
    out.push('!');
  }
  if (state.ipDefaultGateway) out.push(`ip default-gateway ${state.ipDefaultGateway}`);
  out.push('ip http server', 'ip http secure-server', '!');
  pushTail(state, out);
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
    const ports = l2Interfaces(state)
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

export function interfaceStatus(i: InterfaceState): 'connected' | 'notconnect' | 'disabled' | 'err-disabled' {
  if (i.errDisabled) return 'err-disabled';
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
  const trunks = l2Interfaces(state).filter((i) => i.mode === 'trunk' && !i.shutdown);
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

export function showMacAddressTable(entries: MacEntry[]): string[] {
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  for (const e of entries) out.push(`${String(e.vlan).padStart(4)}    ${e.mac}    DYNAMIC     ${shortInterfaceName(e.port)}`);
  out.push(`Total Mac Addresses for this criterion: ${entries.length}`);
  return out;
}

const ROUTE_CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       + - replicated route, % - next hop override',
  '',
];

function routeText(e: RouteEntry): string {
  const dest = `${e.destination}/${e.prefix}`;
  if (e.source === 'static') return e.nextHop ? `${dest} [${e.adminDistance}/${e.metric}] via ${e.nextHop}` : `${dest} is directly connected, ${e.exitInterface}`;
  if (e.source === 'ospf' || e.source === 'ospf-external') return `${dest} [${e.adminDistance}/${e.metric}] via ${e.nextHop}, 00:02:14, ${e.exitInterface}`;
  return `${dest} is directly connected, ${e.exitInterface}`;
}

function routeCode(e: RouteEntry): string {
  if (e.source === 'connected') return 'C';
  if (e.source === 'local') return 'L';
  if (e.source === 'ospf') return 'O';
  if (e.source === 'ospf-external') return e.candidateDefault ? 'O*E2' : 'O E2';
  return e.candidateDefault ? 'S*' : 'S';
}

/** IOS 15 style routing table, grouped by classful major network. */
export function showIpRoute(entries: RouteEntry[]): string[] {
  const out = [...ROUTE_CODES];
  const def = entries.find((e) => e.candidateDefault);
  out.push(def ? `Gateway of last resort is ${def.nextHop ?? def.exitInterface} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  if (def) out.push(`${routeCode(def).padEnd(6)}${routeText(def)}`);
  const groups = new Map<string, { network: string; prefix: number; entries: RouteEntry[] }>();
  for (const e of entries) {
    if (e.candidateDefault) continue;
    const major = classfulNetwork(e.destination);
    const key = `${major.network}/${major.prefix}`;
    if (!groups.has(key)) groups.set(key, { network: major.network, prefix: major.prefix, entries: [] });
    groups.get(key)!.entries.push(e);
  }
  const ordered = [...groups.values()].sort((a, b) => ipToInt(a.network)! - ipToInt(b.network)!);
  for (const g of ordered) {
    const single = g.entries.length === 1 && g.entries[0].prefix === g.prefix;
    if (single) {
      out.push(`${routeCode(g.entries[0]).padEnd(6)}${routeText(g.entries[0])}`);
      continue;
    }
    const masks = new Set(g.entries.map((e) => e.prefix)).size;
    const subnets = new Set(g.entries.map((e) => `${e.destination}/${e.prefix}`)).size;
    out.push(`      ${g.network}/${g.prefix} is ${masks > 1 ? 'variably subnetted' : 'subnetted'}, ${subnets} subnet${subnets === 1 ? '' : 's'}${masks > 1 ? `, ${masks} masks` : ''}`);
    for (const e of g.entries) out.push(`${routeCode(e).padEnd(9)}${routeText(e)}`);
  }
  return out;
}

export function showIpOspfNeighbor(nbrs: OspfNeighbor[]): string[] {
  const out = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const n of nbrs) out.push(`${n.routerId.padEnd(16)}${String(n.priority).padStart(3)}   ${n.state.padEnd(16)}00:00:3${(ipToInt(n.ip) ?? 0) % 10}    ${n.ip.padEnd(16)}${n.iface === n.localIface ? n.localIface : n.localIface}`);
  return out;
}

export function showIpOspfInterfaceBrief(pid: number, rows: Array<{ info: OspfInterfaceInfo; role: string; neighbors: number }>): string[] {
  const out = ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C'];
  for (const r of rows) {
    out.push(`${shortInterfaceName(r.info.name).padEnd(13)}${String(pid).padEnd(6)}${String(r.info.area).padEnd(16)}${`${r.info.ip}/${prefixLength(r.info.mask)}`.padEnd(19)}${String(r.info.cost).padEnd(6)}${r.role.padEnd(6)}${r.neighbors}/${r.neighbors}`);
  }
  return out;
}

export function showIpOspf(state: DeviceState, routerId: string | null, infos: OspfInterfaceInfo[], nbrs: OspfNeighbor[]): string[] {
  const areas = [...new Set(infos.map((i) => i.area))].sort((a, b) => a - b);
  const out = [` Routing Process "ospf ${state.ospf!.processId}" with ID ${routerId ?? '0.0.0.0'}`, ' Start time: 00:00:12.000, Time elapsed: 00:14:02.000', ' Supports only single TOS(TOS0) routes', ' Router is not originating router-LSAs with maximum metric', ' Initial SPF schedule delay 5000 msecs', ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`, ` Reference bandwidth unit is 100 mbps`];
  for (const a of areas) {
    const ifs = infos.filter((i) => i.area === a);
    out.push(a === 0 ? '    Area BACKBONE(0)' : `    Area ${a}`, `        Number of interfaces in this area is ${ifs.length}`, `        Area has no authentication`, `        SPF algorithm executed 4 times`, `        Number of LSA 3. Checksum Sum 0x01A2B3`);
  }
  out.push(` Number of neighbors: ${nbrs.length}`);
  return out;
}

export function showIpProtocols(state: DeviceState, routerId: string | null, infos: OspfInterfaceInfo[], nbrs: OspfNeighbor[]): string[] {
  if (!state.ospf) return ['*** IP Routing is NSF aware ***', '', 'No IP routing protocols are configured'];
  const o = state.ospf;
  const out = ['*** IP Routing is NSF aware ***', '', `Routing Protocol is "ospf ${o.processId}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set', `  Router ID ${routerId ?? '0.0.0.0'}`, `  Number of areas in this router is ${new Set(infos.map((i) => i.area)).size}. ${new Set(infos.map((i) => i.area)).size} normal 0 stub 0 nssa`, '  Maximum path: 4', '  Routing for Networks:'];
  for (const n of o.networks) out.push(`    ${n.address} ${n.wildcard} area ${n.area}`);
  const viaIface = infos.filter((i) => state.interfaces[i.name]?.ospfArea !== undefined);
  if (viaIface.length) {
    out.push('  Routing on Interfaces Configured Explicitly (Area ...):');
    for (const i of viaIface) out.push(`    ${i.name}`);
  }
  const passive = infos.filter((i) => i.passive && !isLoopback(i.name));
  if (passive.length || o.passiveDefault) {
    out.push('  Passive Interface(s):');
    for (const i of passive) out.push(`    ${i.name}`);
  }
  out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
  for (const n of nbrs) out.push(`    ${n.routerId.padEnd(16)}110      00:02:14`);
  out.push('  Distance: (default is 110)');
  return out;
}

export function showVersion(state: DeviceState): string[] {
  if (state.deviceType === 'router') {
    return [
      'Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.4(3)M6, RELEASE SOFTWARE (fc1)',
      'Technical Support: http://www.cisco.com/techsupport',
      'Copyright (c) 1986-2016 by Cisco Systems, Inc.',
      '',
      `${state.hostname} uptime is 1 hour, 3 minutes`,
      'System returned to ROM by power-on',
      'System image file is "flash0:c2900-universalk9-mz.SPA.154-3.M6.bin"',
      '',
      'Cisco CISCO2911/K9 (revision 1.0) with 483328K/40960K bytes of memory.',
      `${physicalInterfaces(state).length} Gigabit Ethernet interfaces`,
      '255K bytes of non-volatile configuration memory.',
      '',
      'Configuration register is 0x2102',
    ];
  }
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
