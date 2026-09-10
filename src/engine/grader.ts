import { normalizeInterfaceName } from './interfaces';
import { renderConfigBody } from './ios/show';
import { ospfInterfaces, ospfNeighbors, ospfRouterId, routingTable, type NetworkState, type RouteEntry } from './network';
import type { AclAddr, AclEntry, AclProtocol, CliErrorKind, DeviceState, LineState, Mode, PortMode } from './types';

interface Base {
  /** Device (or host, for ping) the check targets. Defaults to the network's primary device. */
  device?: string;
  label?: string;
}

/**
 * Declarative checks a lab author combines into objectives.
 * Every check has an optional `label` shown as a sub-objective in the UI.
 */
export type Check = Base &
  (
    | { type: 'command'; pattern: string }
    | { type: 'mode'; mode: Mode }
    | { type: 'hostname'; equals: string }
    | { type: 'vlan-exists'; id: number; name?: string }
    | { type: 'vlan-absent'; id: number }
    | {
        type: 'interface';
        name: string;
        mode?: PortMode;
        accessVlan?: number;
        shutdown?: boolean;
        description?: string;
        trunkAllowed?: 'all' | number[];
        nativeVlan?: number;
        ipAddress?: string;
        subnetMask?: string;
        encapsulation?: number;
      }
    | { type: 'enable-secret'; equals?: string }
    | { type: 'enable-password'; equals?: string }
    | { type: 'line'; line: 'con' | 'vty'; password?: string; login?: LineState['login']; transportInput?: LineState['transportInput'] }
    | { type: 'user'; username: string; privilege?: number; secret?: boolean }
    | { type: 'banner'; contains?: string }
    | { type: 'domain-name'; equals?: string }
    | { type: 'ssh-ready' }
    | { type: 'default-gateway'; equals: string }
    | { type: 'saved' }
    | { type: 'password-encryption' }
    | { type: 'error-seen'; error: CliErrorKind }
    | { type: 'ping'; target: string; success?: boolean; denied?: boolean }
    | { type: 'route'; destination: string; mask: string; via?: string }
    | { type: 'route-absent'; destination: string; mask: string }
    /** A prefix present in the live routing table, optionally from a given source. */
    | { type: 'learned-route'; destination: string; mask: string; source?: RouteEntry['source'] }
    | { type: 'ospf'; processId?: number; routerId?: string }
    | { type: 'ospf-network'; address: string; wildcard: string; area: number }
    | { type: 'ospf-network-absent'; address: string; wildcard: string; area?: number }
    | { type: 'ospf-neighbors'; min: number; routerId?: string }
    | { type: 'passive-interface'; name: string; passive?: boolean }
    | { type: 'default-information-originate' }
    /** Trunk allows at least these VLANs (explicit list or "all"). */
    | { type: 'trunk-allows'; name: string; vlans: number[] }
    | { type: 'acl-exists'; name: string; kind?: 'standard' | 'extended' }
    /**
     * An entry is present. Addresses are written as in IOS: "any", "host 10.1.1.1",
     * "192.168.1.0 0.0.0.255". `position` is the 1-based index among non-remark entries.
     */
    | { type: 'acl-entry'; name: string; action: 'permit' | 'deny'; protocol?: AclProtocol; src?: string; dst?: string; dstPort?: number; icmpType?: 'echo' | 'echo-reply'; position?: number }
    | { type: 'acl-applied'; interface: string; direction: 'in' | 'out'; name?: string }
    | { type: 'acl-not-applied'; interface: string; direction: 'in' | 'out' }
    | { type: 'access-class'; name?: string }
    | { type: 'dhcp-pool'; name: string; network?: string; mask?: string; defaultRouter?: string; dnsServer?: string }
    | { type: 'dhcp-excluded'; from: string; to?: string }
    | { type: 'dhcp-bindings'; min: number }
    | { type: 'helper-address'; interface: string; address: string }
    /** Host settings (device = host id). `viaDhcp` requires a live lease. */
    | { type: 'host-config'; ip?: string; mask?: string; gateway?: string; dns?: string; viaDhcp?: boolean; inSubnet?: { network: string; mask: string } }
  );

export interface Objective {
  id: string;
  label: string;
  checks: Check[];
}

export interface CheckResult {
  label: string;
  passed: boolean;
}

export interface ObjectiveResult {
  id: string;
  label: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface GradeResult {
  passed: boolean;
  /** 0-100, percentage of objectives fully passed. */
  score: number;
  objectives: ObjectiveResult[];
}

function describe(check: Check): string {
  if (check.label) return check.label;
  const on = check.device ? ` on ${check.device}` : '';
  switch (check.type) {
    case 'command':
      return `Run ${check.pattern.replace(/[\^$]/g, '')}${on}`;
    case 'mode':
      return `Reach ${check.mode} mode${on}`;
    case 'hostname':
      return `Hostname is ${check.equals}`;
    case 'vlan-exists':
      return check.name ? `VLAN ${check.id} exists and is named ${check.name}` : `VLAN ${check.id} exists`;
    case 'vlan-absent':
      return `VLAN ${check.id} is removed`;
    case 'interface':
      return `${check.name}${on} is configured correctly`;
    case 'enable-secret':
      return `Enable secret is set${on}`;
    case 'enable-password':
      return `Enable password is set${on}`;
    case 'line':
      return `${check.line === 'con' ? 'Console' : 'VTY'} line is configured${on}`;
    case 'user':
      return `User ${check.username} exists${on}`;
    case 'banner':
      return `MOTD banner is set${on}`;
    case 'domain-name':
      return `Domain name is set${on}`;
    case 'ssh-ready':
      return `RSA keys are generated${on}`;
    case 'default-gateway':
      return `Default gateway is ${check.equals}`;
    case 'saved':
      return `Configuration is saved${on}`;
    case 'password-encryption':
      return `Password encryption service is on${on}`;
    case 'error-seen':
      return `Triggered a ${check.error} command error`;
    case 'ping':
      return `Ping ${check.target}${check.device ? ` from ${check.device}` : ''}`;
    case 'route':
      return `Route to ${check.destination} ${check.mask}${check.via ? ` via ${check.via}` : ''}${on}`;
    case 'route-absent':
      return `No route to ${check.destination} ${check.mask}${on}`;
    case 'learned-route':
      return `${check.destination} ${check.mask} is in the routing table${check.source ? ` via ${check.source}` : ''}${on}`;
    case 'ospf':
      return `OSPF${check.processId ? ` process ${check.processId}` : ''} is running${check.routerId ? ` with router-id ${check.routerId}` : ''}${on}`;
    case 'ospf-network':
      return `network ${check.address} ${check.wildcard} area ${check.area}${on}`;
    case 'ospf-network-absent':
      return `network ${check.address} ${check.wildcard} is removed${on}`;
    case 'ospf-neighbors':
      return check.routerId ? `OSPF neighbor ${check.routerId} is up${on}` : `At least ${check.min} OSPF neighbor${check.min === 1 ? '' : 's'}${on}`;
    case 'passive-interface':
      return `${check.name} is ${check.passive === false ? 'not ' : ''}passive${on}`;
    case 'default-information-originate':
      return `default-information originate is configured${on}`;
    case 'trunk-allows':
      return `${check.name} allows VLANs ${check.vlans.join(',')}${on}`;
    case 'acl-exists':
      return `${check.kind ? `${check.kind[0].toUpperCase()}${check.kind.slice(1)} a` : 'A'}ccess list ${check.name} exists${on}`;
    case 'acl-entry':
      return `${check.name}: ${check.action}${check.protocol ? ` ${check.protocol}` : ''}${check.src ? ` ${check.src}` : ''}${check.dst ? ` ${check.dst}` : ''}${check.dstPort ? ` eq ${check.dstPort}` : ''}${check.icmpType ? ` ${check.icmpType}` : ''}${check.position ? ` (entry ${check.position})` : ''}${on}`;
    case 'acl-applied':
      return `${check.name ?? 'An access list'} is applied ${check.direction}bound on ${check.interface}${on}`;
    case 'acl-not-applied':
      return `No ${check.direction}bound access list on ${check.interface}${on}`;
    case 'access-class':
      return `VTY lines are protected with access-class${check.name ? ` ${check.name}` : ''}${on}`;
    case 'dhcp-pool':
      return `DHCP pool ${check.name}${check.network ? ` for ${check.network}` : ''}${check.defaultRouter ? ` with default-router ${check.defaultRouter}` : ''}${on}`;
    case 'dhcp-excluded':
      return `${check.from}${check.to ? ` to ${check.to}` : ''} excluded from DHCP${on}`;
    case 'dhcp-bindings':
      return `At least ${check.min} DHCP binding${check.min === 1 ? '' : 's'}${on}`;
    case 'helper-address':
      return `${check.interface} relays DHCP to ${check.address}${on}`;
    case 'host-config':
      return `${check.device ?? 'Host'} has ${check.viaDhcp ? 'a DHCP lease' : 'the expected IP settings'}${check.ip ? ` (${check.ip})` : ''}`;
  }
}

function addrText(a: AclAddr): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return `host ${a.ip}`;
  return `${a.address} ${a.wildcard}`;
}

function normalizeAddrText(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  // Bare address means host.
  return /^\d+\.\d+\.\d+\.\d+$/.test(t) ? `host ${t}` : t;
}

function entryMatchesCheck(e: AclEntry, check: Extract<Check, { type: 'acl-entry' }>): boolean {
  if (e.action !== check.action) return false;
  if (check.protocol !== undefined && e.protocol !== check.protocol) return false;
  if (check.src !== undefined && addrText(e.src) !== normalizeAddrText(check.src)) return false;
  if (check.dst !== undefined && addrText(e.dst ?? { kind: 'any' }) !== normalizeAddrText(check.dst)) return false;
  if (check.dstPort !== undefined && e.dstPort !== check.dstPort) return false;
  if (check.icmpType !== undefined && e.icmpType !== check.icmpType) return false;
  return true;
}

function sameList(a: 'all' | number[], b: 'all' | number[]): boolean {
  if (a === 'all' || b === 'all') return a === b;
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function deviceFor(check: Check, net: NetworkState): DeviceState | undefined {
  return net.devices[check.device ?? net.primary];
}

export function evaluateCheck(check: Check, net: NetworkState): boolean {
  if (check.type === 'ping') {
    const id = check.device ?? net.primary;
    const pings = net.devices[id]?.pings ?? net.hosts[id]?.pings ?? [];
    return pings.some((p) => p.target === check.target && (check.success === undefined || p.success === check.success) && (check.denied === undefined || Boolean(p.denied) === check.denied));
  }
  if (check.type === 'command' && check.device && net.hosts[check.device]) {
    const re = new RegExp(check.pattern, 'i');
    return net.hosts[check.device].commandHistory.some((c) => re.test(c));
  }
  if (check.type === 'host-config') {
    const h = net.hosts[check.device ?? ''];
    if (!h) return false;
    if (check.viaDhcp && !(h.dhcp && h.dhcpServer && h.ip)) return false;
    if (check.ip !== undefined && h.ip !== check.ip) return false;
    if (check.mask !== undefined && h.mask !== check.mask) return false;
    if (check.gateway !== undefined && h.gateway !== check.gateway) return false;
    if (check.dns !== undefined && h.dns !== check.dns) return false;
    if (check.inSubnet && !(h.ip && h.mask === check.inSubnet.mask && sameSubnetText(h.ip, check.inSubnet.network, check.inSubnet.mask))) return false;
    return true;
  }
  const state = deviceFor(check, net);
  if (!state) return false;
  switch (check.type) {
    case 'command': {
      const re = new RegExp(check.pattern, 'i');
      return state.canonicalHistory.some((c) => re.test(c)) || state.commandHistory.some((c) => re.test(c));
    }
    case 'mode':
      return state.modesVisited.includes(check.mode);
    case 'hostname':
      return state.hostname === check.equals;
    case 'vlan-exists': {
      const v = state.vlans[check.id];
      return Boolean(v) && (check.name === undefined || v.name === check.name);
    }
    case 'vlan-absent':
      return !state.vlans[check.id];
    case 'interface': {
      const name = normalizeInterfaceName(check.name);
      const i = name ? state.interfaces[name] : undefined;
      if (!i) return false;
      if (check.mode !== undefined && i.mode !== check.mode) return false;
      if (check.accessVlan !== undefined && i.accessVlan !== check.accessVlan) return false;
      if (check.shutdown !== undefined && i.shutdown !== check.shutdown) return false;
      if (check.description !== undefined && (i.description ?? '').toLowerCase() !== check.description.toLowerCase()) return false;
      if (check.trunkAllowed !== undefined && !sameList(i.trunkAllowed, check.trunkAllowed)) return false;
      if (check.nativeVlan !== undefined && i.nativeVlan !== check.nativeVlan) return false;
      if (check.ipAddress !== undefined && i.ipAddress !== check.ipAddress) return false;
      if (check.subnetMask !== undefined && i.subnetMask !== check.subnetMask) return false;
      if (check.encapsulation !== undefined && i.encapsulation?.vlan !== check.encapsulation) return false;
      return true;
    }
    case 'enable-secret':
      return state.enableSecret !== undefined && (check.equals === undefined || state.enableSecret === check.equals);
    case 'enable-password':
      return state.enablePassword !== undefined && (check.equals === undefined || state.enablePassword === check.equals);
    case 'line': {
      const l = state.lines[check.line];
      if (check.password !== undefined && l.password !== check.password) return false;
      if (check.login !== undefined && l.login !== check.login) return false;
      if (check.transportInput !== undefined && l.transportInput !== check.transportInput) return false;
      return true;
    }
    case 'user': {
      const u = state.users.find((x) => x.username === check.username);
      if (!u) return false;
      if (check.privilege !== undefined && u.privilege !== check.privilege) return false;
      if (check.secret !== undefined && u.secret !== check.secret) return false;
      return true;
    }
    case 'banner':
      return state.bannerMotd !== undefined && state.bannerMotd.length > 0 && (check.contains === undefined || state.bannerMotd.toLowerCase().includes(check.contains.toLowerCase()));
    case 'domain-name':
      return state.ipDomainName !== undefined && (check.equals === undefined || state.ipDomainName === check.equals);
    case 'ssh-ready':
      return state.rsaKeyBits !== undefined;
    case 'default-gateway':
      return state.ipDefaultGateway === check.equals;
    case 'saved':
      return state.startupConfig !== null && state.startupConfig === renderConfigBody(state).join('\n');
    case 'password-encryption':
      return state.servicePasswordEncryption;
    case 'error-seen':
      return state.errorsSeen.includes(check.error);
    case 'route': {
      const viaIface = check.via ? normalizeInterfaceName(check.via) : null;
      return state.staticRoutes.some((r) => r.destination === check.destination && r.mask === check.mask && (check.via === undefined || r.nextHop === check.via || (viaIface !== null && r.exitInterface === viaIface)));
    }
    case 'route-absent':
      return !state.staticRoutes.some((r) => r.destination === check.destination && r.mask === check.mask);
    case 'learned-route':
      return routingTable(net, state.id).some((e) => e.destination === check.destination && e.mask === check.mask && (check.source === undefined || e.source === check.source));
    case 'ospf': {
      if (!state.ospf) return false;
      if (check.processId !== undefined && state.ospf.processId !== check.processId) return false;
      if (check.routerId !== undefined && ospfRouterId(net, state.id) !== check.routerId) return false;
      return true;
    }
    case 'ospf-network':
      return Boolean(state.ospf?.networks.some((n) => n.address === check.address && n.wildcard === check.wildcard && n.area === check.area));
    case 'ospf-network-absent':
      return !state.ospf?.networks.some((n) => n.address === check.address && n.wildcard === check.wildcard && (check.area === undefined || n.area === check.area));
    case 'ospf-neighbors': {
      const nbrs = ospfNeighbors(net, state.id);
      if (check.routerId !== undefined) return nbrs.some((n) => n.routerId === check.routerId);
      return nbrs.length >= check.min;
    }
    case 'passive-interface': {
      const name = normalizeInterfaceName(check.name);
      const info = ospfInterfaces(net, state.id).find((i) => i.name === name);
      return Boolean(info) && info!.passive === (check.passive ?? true);
    }
    case 'default-information-originate':
      return Boolean(state.ospf?.defaultInformationOriginate);
    case 'trunk-allows': {
      const name = normalizeInterfaceName(check.name);
      const i = name ? state.interfaces[name] : undefined;
      if (!i || i.mode !== 'trunk') return false;
      return i.trunkAllowed === 'all' || check.vlans.every((v) => (i.trunkAllowed as number[]).includes(v));
    }
    case 'acl-exists': {
      const acl = state.acls[check.name];
      return Boolean(acl) && (check.kind === undefined || acl.kind === check.kind);
    }
    case 'acl-entry': {
      const acl = state.acls[check.name];
      if (!acl) return false;
      const rules = acl.entries.filter((e) => e.action !== 'remark');
      if (check.position !== undefined) {
        const e = rules[check.position - 1];
        return Boolean(e) && entryMatchesCheck(e, check);
      }
      return rules.some((e) => entryMatchesCheck(e, check));
    }
    case 'acl-applied': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      const applied = check.direction === 'in' ? i?.aclIn : i?.aclOut;
      return Boolean(applied) && (check.name === undefined || applied === check.name);
    }
    case 'acl-not-applied': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      return Boolean(i) && !(check.direction === 'in' ? i!.aclIn : i!.aclOut);
    }
    case 'access-class':
      return Boolean(state.lines.vty.accessClass) && (check.name === undefined || state.lines.vty.accessClass === check.name);
    case 'dhcp-pool': {
      const p = state.dhcpPools[check.name];
      if (!p) return false;
      if (check.network !== undefined && p.network !== check.network) return false;
      if (check.mask !== undefined && p.mask !== check.mask) return false;
      if (check.defaultRouter !== undefined && p.defaultRouter !== check.defaultRouter) return false;
      if (check.dnsServer !== undefined && p.dnsServer !== check.dnsServer) return false;
      return true;
    }
    case 'dhcp-excluded': {
      const to = check.to ?? check.from;
      return state.dhcpExcluded.some((r) => r.from === check.from && r.to === to);
    }
    case 'dhcp-bindings':
      return state.dhcpBindings.length >= check.min;
    case 'helper-address': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      return i?.helperAddress === check.address;
    }
  }
}

function sameSubnetText(ip: string, network: string, mask: string): boolean {
  const toInt = (s: string) => s.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
  return ((toInt(ip) & toInt(mask)) >>> 0) === ((toInt(network) & toInt(mask)) >>> 0);
}

export function grade(objectives: Objective[], net: NetworkState): GradeResult {
  const results: ObjectiveResult[] = objectives.map((o) => {
    const checks = o.checks.map((c) => ({ label: describe(c), passed: evaluateCheck(c, net) }));
    return { id: o.id, label: o.label, passed: checks.every((c) => c.passed), checks };
  });
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passed: results.length > 0 && passedCount === results.length,
    score: results.length === 0 ? 0 : Math.round((passedCount / results.length) * 100),
    objectives: results,
  };
}
