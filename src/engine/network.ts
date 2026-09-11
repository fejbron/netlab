/**
 * Multi-device network model and packet forwarding simulation.
 *
 * A NetworkState holds CLI devices (switches, routers), simple hosts (PCs, servers)
 * and the cables between them. ping() walks a packet from a node to a destination
 * IP the way real gear would: hosts pick direct delivery or their gateway, switches
 * flood inside a VLAN (honouring access/trunk/native/allowed settings and router
 * subinterface tags), routers do longest-prefix lookups and decrement TTL. A ping
 * only succeeds when the reply can find its way back as well.
 *
 * Routing tables combine connected, local and static routes with routes learned by
 * the OSPF simulation (neighbours on shared segments, SPF over the router graph).
 */
import type { ChannelMode, DeviceState, InterfaceState, PingRecord } from './types';
import { isPortChannel, isSvi, normalizeInterfaceName, sviVlanId } from './interfaces';
import { intToIp, ipToInt, isValidIp, networkAddress, prefixLength, sameSubnet } from './ios/net';
import { evaluateAcl, type Packet } from './acl';
import { isIpv6, isLinkLocal6, linkLocalFromMac, networkAddress6, normalizeIpv6, parseIpv6, prefixMask6, sameSubnet6 } from './ipv6';
import { natOwnsAddress, translateDestination, translateSource } from './nat';
import { createLinuxState, type LinuxSpec, type LinuxState } from './linux/fs';

export interface HostState {
  kind: 'host';
  id: string;
  name: string;
  /** How the topology should draw it. */
  deviceKind: 'pc' | 'server' | 'switch' | 'router';
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  /** Obtains its address with DHCP ("ipconfig /renew") instead of static settings. */
  dhcp?: boolean;
  dhcpServer?: string;
  /** Static IPv6 settings. The link-local address is always derived from the MAC. */
  ip6?: string;
  prefix6?: number;
  gateway6?: string;
  mac: string;
  commandHistory: string[];
  pings: PingRecord[];
  /** A Linux server with a shell instead of the Windows-style PC terminal. */
  os?: 'linux';
  linux?: LinuxState;
}

export function hostLinkLocal(h: HostState): string {
  return linkLocalFromMac(h.mac);
}

export interface Endpoint {
  node: string;
  iface: string;
}

export interface Link {
  a: Endpoint;
  b: Endpoint;
}

export interface NetworkState {
  /** The device shown first in the UI and used by checks that name no device. */
  primary: string;
  devices: Record<string, DeviceState>;
  hosts: Record<string, HostState>;
  links: Link[];
}

export function isNetworkState(x: unknown): x is NetworkState {
  return typeof x === 'object' && x !== null && 'devices' in x && 'links' in x && 'hosts' in x;
}

export const HOST_IFACE = 'eth0';

export function isLoopback(name: string): boolean {
  return name.startsWith('Loopback');
}

export function isSubinterface(name: string): boolean {
  return name.includes('.');
}

export function parentInterface(name: string): string {
  return name.split('.')[0];
}

export function peerOf(net: NetworkState, node: string, iface: string): Endpoint | null {
  for (const l of net.links) {
    if (l.a.node === node && l.a.iface === iface) return l.b;
    if (l.b.node === node && l.b.iface === iface) return l.a;
  }
  return null;
}

/** Operational state of a device interface: admin up and, for physical ports, a live peer. */
export function ifaceUp(net: NetworkState, node: string, ifaceName: string): boolean {
  const dev = net.devices[node];
  const i = dev?.interfaces[ifaceName];
  if (!i || i.shutdown || i.errDisabled) return false;
  if (isSvi(i.name) || isLoopback(i.name)) return true;
  if (isSubinterface(i.name)) return ifaceUp(net, node, parentInterface(i.name));
  if (isPortChannel(i.name)) return channelMembers(dev, i.name).some((m) => ifaceUp(net, node, m.name));
  return i.connected;
}

export function portChannelId(name: string): number | null {
  const m = name.match(/^Port-channel(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Physical ports configured into a Port-channel. */
export function channelMembers(dev: DeviceState, poName: string): InterfaceState[] {
  const id = portChannelId(poName);
  if (id === null) return [];
  return Object.values(dev.interfaces).filter((i) => i.channelGroup?.id === id && !isPortChannel(i.name));
}

export type ChannelProtocol = 'LACP' | 'PAgP' | '-';

export interface ChannelStatus {
  id: number;
  name: string;
  protocol: ChannelProtocol;
  /** P bundled, I stand-alone (peer incompatible), D down, s suspended (config mismatch). */
  members: Array<{ name: string; flag: 'P' | 'I' | 'D' | 's' }>;
  bundled: boolean;
}

function channelProtocol(mode: ChannelMode): ChannelProtocol {
  return mode === 'on' ? '-' : mode === 'active' || mode === 'passive' ? 'LACP' : 'PAgP';
}

function modesCompatible(a: ChannelMode, b: ChannelMode): boolean {
  if (a === 'on' || b === 'on') return a === b;
  if (a === 'active') return b === 'active' || b === 'passive';
  if (a === 'passive') return b === 'active';
  if (a === 'desirable') return b === 'desirable' || b === 'auto';
  return b === 'desirable'; // auto
}

function sameL2Config(a: InterfaceState, b: InterfaceState): boolean {
  const list = (x: InterfaceState) => (x.trunkAllowed === 'all' ? 'all' : x.trunkAllowed.join(','));
  return a.mode === b.mode && a.accessVlan === b.accessVlan && a.nativeVlan === b.nativeVlan && list(a) === list(b);
}

/** EtherChannel state of every group on a switch, computed from both ends of each member link. */
export function channelStatus(net: NetworkState, swId: string): ChannelStatus[] {
  const dev = net.devices[swId];
  const groups = new Map<number, InterfaceState[]>();
  for (const i of Object.values(dev.interfaces)) {
    if (i.channelGroup && !isPortChannel(i.name)) groups.set(i.channelGroup.id, [...(groups.get(i.channelGroup.id) ?? []), i]);
  }
  const out: ChannelStatus[] = [];
  for (const [id, members] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const po = dev.interfaces[`Port-channel${id}`];
    let peerSwitch: string | null = null;
    let peerGroup: number | null = null;
    const flagged = members
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((m) => {
        if (!ifaceUp(net, swId, m.name) || (po && po.shutdown)) return { name: m.name, flag: 'D' as const };
        const p = peerOf(net, swId, m.name);
        const peer = p ? net.devices[p.node]?.interfaces[p.iface] : undefined;
        if (!p || !peer?.channelGroup || net.devices[p.node].deviceType !== 'switch' || !modesCompatible(m.channelGroup!.mode, peer.channelGroup.mode)) return { name: m.name, flag: 'I' as const };
        if (po && !sameL2Config(po, m)) return { name: m.name, flag: 's' as const };
        if (peerSwitch === null) {
          peerSwitch = p.node;
          peerGroup = peer.channelGroup.id;
        } else if (peerSwitch !== p.node || peerGroup !== peer.channelGroup.id) return { name: m.name, flag: 's' as const };
        return { name: m.name, flag: 'P' as const };
      });
    out.push({ id, name: `Port-channel${id}`, protocol: channelProtocol(members[0].channelGroup!.mode), members: flagged, bundled: flagged.some((f) => f.flag === 'P') });
  }
  return out;
}

/**
 * Port security on the switch port a host is cabled to. Learns addresses (sticky or
 * dynamic) up to the maximum and applies the violation mode when exceeded.
 */
function portSecurityIngress(net: NetworkState, hostId: string, record: boolean): { ok: boolean; reason?: string } {
  const h = net.hosts[hostId];
  const p = peerOf(net, hostId, HOST_IFACE);
  if (!h || !p) return { ok: true };
  const sw = net.devices[p.node];
  const port = sw?.interfaces[p.iface];
  const ps = port?.portSecurity;
  if (!sw || !port || !ps?.enabled) return { ok: true };
  if (port.errDisabled) return { ok: false, reason: 'port err-disabled' };
  const allowed = [...ps.staticMacs, ...ps.stickyMacs, ...ps.learnedMacs];
  if (allowed.includes(h.mac)) return { ok: true };
  if (allowed.length < ps.maximum) {
    if (record) (ps.sticky ? ps.stickyMacs : ps.learnedMacs).push(h.mac);
    return { ok: true };
  }
  if (record) {
    ps.violations += 1;
    ps.lastViolationMac = h.mac;
    if (ps.violation === 'shutdown') port.errDisabled = true;
  }
  return { ok: false, reason: 'port security violation' };
}

/**
 * Recompute every physical interface's `connected` flag from the cabling and the
 * peer's admin state. Called after every command so show output stays truthful.
 */
export function syncLinkState(net: NetworkState): void {
  for (const dev of Object.values(net.devices)) {
    for (const i of Object.values(dev.interfaces)) {
      if (isSvi(i.name) || isLoopback(i.name)) i.connected = true;
      else if (!isSubinterface(i.name)) {
        const p = peerOf(net, dev.id, i.name);
        if (!p) i.connected = false;
        else if (net.hosts[p.node]) i.connected = true;
        else {
          const pi = net.devices[p.node]?.interfaces[p.iface];
          i.connected = Boolean(pi && !pi.shutdown);
        }
      }
    }
    for (const i of Object.values(dev.interfaces)) {
      if (isSubinterface(i.name)) i.connected = dev.interfaces[parentInterface(i.name)]?.connected ?? false;
      else if (isPortChannel(i.name)) i.connected = channelMembers(dev, i.name).some((m) => m.connected && !m.shutdown && !m.errDisabled);
    }
    // BPDU guard: a switch on a guarded port puts it into err-disabled.
    for (const i of Object.values(dev.interfaces)) {
      if (!i.bpduGuard || i.shutdown || !i.connected) continue;
      const p = peerOf(net, dev.id, i.name);
      if (p && net.devices[p.node]?.deviceType === 'switch') i.errDisabled = true;
    }
  }
}

// ---------------------------------------------------------------------------
// spanning tree (per-VLAN)

export interface StpPort {
  name: string;
  role: 'Root' | 'Desg' | 'Altn';
  state: 'FWD' | 'BLK';
  cost: number;
  portId: string;
  edge: boolean;
}

export interface StpVlanInfo {
  vlan: number;
  protocol: 'ieee' | 'rstp';
  rootPriority: number;
  rootMac: string;
  bridgePriority: number;
  bridgeMac: string;
  isRoot: boolean;
  rootCost: number;
  rootPort?: string;
  ports: StpPort[];
}

interface StpNode {
  cost: number;
  rootPort?: string;
  /** Port name -> role/state for every participating port. */
  ports: Map<string, StpPort>;
}

function bridgePriority(dev: DeviceState, vlan: number): number {
  return (dev.stpPriority[vlan] ?? 32768) + vlan;
}

function compareBridge(a: { pri: number; mac: string }, b: { pri: number; mac: string }): number {
  return a.pri - b.pri || a.mac.localeCompare(b.mac);
}

function portNumber(name: string): number {
  const id = portChannelId(name);
  if (id !== null) return 64 + id;
  const m = name.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function stpPortId(i: InterfaceState): string {
  return `128.${portNumber(i.name)}`;
}

function portCarriesVlan(i: InterfaceState, vlan: number): boolean {
  return i.mode === 'trunk' ? allowsVlan(i, vlan) : i.accessVlan === vlan;
}

/** The logical STP port for a physical port: its Port-channel when bundled, otherwise itself. */
function logicalPort(net: NetworkState, dev: DeviceState, i: InterfaceState): InterfaceState {
  if (!i.channelGroup) return i;
  const status = channelStatus(net, dev.id).find((c) => c.id === i.channelGroup!.id);
  const bundled = status?.members.find((m) => m.name === i.name)?.flag === 'P';
  return bundled ? (dev.interfaces[`Port-channel${i.channelGroup.id}`] ?? i) : i;
}

function stpCostOf(i: InterfaceState, dev: DeviceState): number {
  if (i.stpCost !== undefined) return i.stpCost;
  if (isPortChannel(i.name)) return channelMembers(dev, i.name).length >= 2 ? 3 : 4;
  return 4;
}

/** Run the spanning-tree algorithm for one VLAN across every switch that has it. */
function stpCompute(net: NetworkState, vlan: number): Map<string, StpNode> {
  const switches = Object.values(net.devices).filter((d) => d.deviceType === 'switch' && d.vlans[vlan]);
  const result = new Map<string, StpNode>();
  if (switches.length === 0) return result;
  const bid = new Map(switches.map((s) => [s.id, { pri: bridgePriority(s, vlan), mac: s.mac }]));

  // Logical ports that participate in this VLAN, with their peers.
  interface Edge {
    a: string;
    ap: InterfaceState;
    b: string;
    bp: InterfaceState;
  }
  const edges: Edge[] = [];
  const participating = new Map<string, Map<string, InterfaceState>>();
  const seenPair = new Set<string>();
  for (const sw of switches) {
    const ports = new Map<string, InterfaceState>();
    for (const i of Object.values(sw.interfaces)) {
      if (isSvi(i.name) || isPortChannel(i.name) || !ifaceUp(net, sw.id, i.name) || !portCarriesVlan(i, vlan)) continue;
      const lp = logicalPort(net, sw, i);
      ports.set(lp.name, lp);
      const p = peerOf(net, sw.id, i.name);
      if (!p) continue;
      const peerDev = net.devices[p.node];
      if (!peerDev || peerDev.deviceType !== 'switch' || !peerDev.vlans[vlan]) continue;
      const peerPort = peerDev.interfaces[p.iface];
      if (!peerPort || !ifaceUp(net, p.node, p.iface) || !portCarriesVlan(peerPort, vlan)) continue;
      const peerLp = logicalPort(net, peerDev, peerPort);
      const key = [`${sw.id}:${lp.name}`, `${p.node}:${peerLp.name}`].sort().join('|');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      edges.push({ a: sw.id, ap: lp, b: p.node, bp: peerLp });
    }
    participating.set(sw.id, ports);
  }

  const root = switches.reduce((best, s) => (compareBridge(bid.get(s.id)!, bid.get(best.id)!) < 0 ? s : best));
  // Dijkstra from the root; root path cost adds the cost of the receiving port.
  const dist = new Map<string, { cost: number; viaBridge: { pri: number; mac: string }; viaPort: string; ownPort?: string }>();
  dist.set(root.id, { cost: 0, viaBridge: bid.get(root.id)!, viaPort: '' });
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    for (const [n, d] of dist) if (!done.has(n) && (cur === null || d.cost < dist.get(cur)!.cost)) cur = n;
    if (cur === null) break;
    done.add(cur);
    for (const e of edges) {
      const [u, v, up, vp] = e.a === cur ? [e.a, e.b, e.ap, e.bp] : e.b === cur ? [e.b, e.a, e.bp, e.ap] : [null, null, null, null];
      if (!u || !v || !up || !vp) continue;
      const cand = { cost: dist.get(u)!.cost + stpCostOf(vp, net.devices[v]), viaBridge: bid.get(u)!, viaPort: stpPortId(up), ownPort: vp.name };
      const existing = dist.get(v);
      const better = !existing || cand.cost < existing.cost || (cand.cost === existing.cost && (compareBridge(cand.viaBridge, existing.viaBridge) < 0 || (compareBridge(cand.viaBridge, existing.viaBridge) === 0 && cand.viaPort < existing.viaPort)));
      if (better) dist.set(v, cand);
    }
  }

  for (const sw of switches) {
    const d = dist.get(sw.id);
    const node: StpNode = { cost: d?.cost ?? 0, rootPort: d?.ownPort, ports: new Map() };
    for (const [name, lp] of participating.get(sw.id)!) {
      node.ports.set(name, { name, role: 'Desg', state: 'FWD', cost: stpCostOf(lp, sw), portId: stpPortId(lp), edge: Boolean(lp.portfast) });
    }
    result.set(sw.id, node);
  }
  for (const e of edges) {
    const da = dist.get(e.a);
    const db = dist.get(e.b);
    if (!da || !db) continue;
    const aKey = { cost: da.cost, bridge: bid.get(e.a)!, port: stpPortId(e.ap) };
    const bKey = { cost: db.cost, bridge: bid.get(e.b)!, port: stpPortId(e.bp) };
    const aDesignated = aKey.cost - bKey.cost || compareBridge(aKey.bridge, bKey.bridge) || aKey.port.localeCompare(bKey.port, undefined, { numeric: true });
    const loser = aDesignated <= 0 ? { sw: e.b, port: e.bp.name } : { sw: e.a, port: e.ap.name };
    const node = result.get(loser.sw)!;
    const port = node.ports.get(loser.port);
    if (!port) continue;
    if (node.rootPort === loser.port) {
      port.role = 'Root';
      port.state = 'FWD';
    } else {
      port.role = 'Altn';
      port.state = 'BLK';
    }
  }
  return result;
}

/** Ports (physical names) that spanning tree blocks on a switch for a VLAN. */
export function stpBlockedPorts(net: NetworkState, swId: string, vlan: number): Set<string> {
  const node = stpCompute(net, vlan).get(swId);
  const blocked = new Set<string>();
  if (!node) return blocked;
  const dev = net.devices[swId];
  for (const [name, p] of node.ports) {
    if (p.state !== 'BLK') continue;
    blocked.add(name);
    if (isPortChannel(name)) for (const m of channelMembers(dev, name)) blocked.add(m.name);
  }
  return blocked;
}

export function stpVlan(net: NetworkState, swId: string, vlan: number): StpVlanInfo | null {
  const dev = net.devices[swId];
  if (!dev || dev.deviceType !== 'switch' || !dev.vlans[vlan]) return null;
  const all = stpCompute(net, vlan);
  const node = all.get(swId);
  if (!node) return null;
  const switches = Object.values(net.devices).filter((d) => d.deviceType === 'switch' && d.vlans[vlan]);
  const root = switches.reduce((best, s) => (compareBridge({ pri: bridgePriority(s, vlan), mac: s.mac }, { pri: bridgePriority(best, vlan), mac: best.mac }) < 0 ? s : best));
  return {
    vlan,
    protocol: dev.stpMode === 'rapid-pvst' ? 'rstp' : 'ieee',
    rootPriority: bridgePriority(root, vlan),
    rootMac: root.mac,
    bridgePriority: bridgePriority(dev, vlan),
    bridgeMac: dev.mac,
    isRoot: root.id === swId,
    rootCost: node.cost,
    rootPort: node.rootPort,
    ports: [...node.ports.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  };
}

/** The switch elected root for a VLAN, or null when no switch carries it. */
export function stpRoot(net: NetworkState, vlan: number): string | null {
  const switches = Object.values(net.devices).filter((d) => d.deviceType === 'switch' && d.vlans[vlan]);
  if (!switches.length) return null;
  return switches.reduce((best, s) => (compareBridge({ pri: bridgePriority(s, vlan), mac: s.mac }, { pri: bridgePriority(best, vlan), mac: best.mac }) < 0 ? s : best)).id;
}

// ---------------------------------------------------------------------------
// construction

/** Wrap a single switch (with legacy `neighbors`) into a network. */
export function fromSwitch(sw: DeviceState): NetworkState {
  const hosts: Record<string, HostState> = {};
  const links: Link[] = [];
  for (const n of sw.neighbors) {
    hosts[n.name] = { kind: 'host', id: n.name, name: n.name, deviceKind: n.kind, ip: n.ip, mask: n.mask, mac: n.mac, commandHistory: [], pings: [] };
    links.push({ a: { node: sw.id, iface: n.interface }, b: { node: n.name, iface: HOST_IFACE } });
  }
  const net: NetworkState = { primary: sw.id, devices: { [sw.id]: sw }, hosts, links };
  syncLinkState(net);
  return net;
}

export interface HostSpec {
  id: string;
  name?: string;
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  dhcp?: boolean;
  /** "2001:DB8:1::10/64" */
  ip6?: string;
  gateway6?: string;
  kind?: HostState['deviceKind'];
  /** Make this host a Linux server (drawn as a server) with the given setup. */
  linux?: LinuxSpec | true;
}

export interface NetworkSpec {
  primary?: string;
  devices: DeviceState[];
  hosts?: HostSpec[];
  /** Cables as "R1:g0/0" to "SW1:g0/8"; hosts are named without an interface: "PC-A". */
  links: Array<[string, string]>;
}

function parseEnd(net: NetworkState, text: string): Endpoint {
  const [node, rawIface] = text.split(':');
  if (net.hosts[node]) return { node, iface: HOST_IFACE };
  const dev = net.devices[node];
  if (!dev) throw new Error(`Unknown node "${node}" in link "${text}"`);
  const iface = rawIface ? normalizeInterfaceName(rawIface) : null;
  if (!iface || !dev.interfaces[iface]) throw new Error(`Unknown interface in link "${text}"`);
  return { node, iface };
}

export function buildNetwork(spec: NetworkSpec): NetworkState {
  const devices: Record<string, DeviceState> = {};
  for (const d of spec.devices) devices[d.id] = d;
  const hosts: Record<string, HostState> = {};
  (spec.hosts ?? []).forEach((h, idx) => {
    const v6 = h.ip6 ? h.ip6.split('/') : undefined;
    hosts[h.id] = {
      kind: 'host', id: h.id, name: h.name ?? h.id, deviceKind: h.kind ?? (h.linux ? 'server' : 'pc'), ip: h.ip, mask: h.mask, gateway: h.gateway, dns: h.dns, dhcp: h.dhcp,
      ip6: v6 ? normalizeIpv6(v6[0]) ?? undefined : undefined, prefix6: v6 ? Number(v6[1] ?? 64) : undefined, gateway6: h.gateway6 ? normalizeIpv6(h.gateway6) ?? undefined : undefined,
      mac: `0011.22bb.${String(idx + 1).padStart(4, '0')}`, commandHistory: [], pings: [],
      ...(h.linux ? { os: 'linux' as const, linux: createLinuxState(h.linux === true ? {} : h.linux, h.name ?? h.id) } : {}),
    };
  });
  const net: NetworkState = { primary: spec.primary ?? spec.devices[0].id, devices, hosts, links: [] };
  for (const [a, b] of spec.links) net.links.push({ a: parseEnd(net, a), b: parseEnd(net, b) });
  syncLinkState(net);
  return net;
}

// ---------------------------------------------------------------------------
// layer 2 walk

/** One switch a frame crossed: the port it came in on, the port it left by, and the VLAN it travelled in. */
export interface SwitchHop {
  sw: string;
  inPort: string;
  outPort?: string;
  vlan: number;
}

type Frame = ({ node: string; iface: string; tag: number | null } | { sw: string; vlan: number }) & { path?: SwitchHop[] };

type Arrival = ({ kind: 'host'; node: string } | { kind: 'svi'; node: string; iface: string } | { kind: 'router'; node: string; receivers: InterfaceState[] }) & { path: SwitchHop[] };

function allowsVlan(i: InterfaceState, vlan: number): boolean {
  return i.trunkAllowed === 'all' || i.trunkAllowed.includes(vlan);
}

/** Flood a frame through the layer-2 domain and report every layer-3 endpoint it reaches. */
function l2Walk(net: NetworkState, start: Frame): Arrival[] {
  const arrivals: Arrival[] = [];
  const queue: Frame[] = [start];
  const visited = new Set<string>();
  const seen = new Set<string>();
  const blockedCache = new Map<string, Set<string>>();
  const blocked = (sw: string, vlan: number) => {
    const key = `${sw}:${vlan}`;
    if (!blockedCache.has(key)) blockedCache.set(key, stpBlockedPorts(net, sw, vlan));
    return blockedCache.get(key)!;
  };
  while (queue.length) {
    const f = queue.shift()!;
    const path = f.path ?? [];
    if ('sw' in f) {
      const key = `${f.sw}:${f.vlan}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const sw = net.devices[f.sw];
      const svi = sw.interfaces[`Vlan${f.vlan}`];
      if (svi && ifaceUp(net, f.sw, svi.name)) arrivals.push({ kind: 'svi', node: f.sw, iface: svi.name, path });
      const blk = blocked(f.sw, f.vlan);
      const last = path[path.length - 1];
      const leave = (q: InterfaceState): SwitchHop[] => (last && last.sw === f.sw ? [...path.slice(0, -1), { ...last, outPort: q.name }] : path);
      for (const q of Object.values(sw.interfaces)) {
        if (isSvi(q.name) || isPortChannel(q.name) || !ifaceUp(net, f.sw, q.name) || blk.has(q.name)) continue;
        if (q.mode === 'trunk') {
          if (allowsVlan(q, f.vlan)) queue.push({ node: f.sw, iface: q.name, tag: f.vlan === q.nativeVlan ? null : f.vlan, path: leave(q) });
        } else if (q.accessVlan === f.vlan) queue.push({ node: f.sw, iface: q.name, tag: null, path: leave(q) });
      }
      continue;
    }
    if (!net.hosts[f.node] && !ifaceUp(net, f.node, f.iface)) continue;
    const p = peerOf(net, f.node, f.iface);
    if (!p) continue;
    if (net.hosts[p.node]) {
      if (f.tag === null && !seen.has(p.node)) {
        seen.add(p.node);
        arrivals.push({ kind: 'host', node: p.node, path });
      }
      continue;
    }
    const dev = net.devices[p.node];
    const ifc = dev.interfaces[p.iface];
    if (!ifc || !ifaceUp(net, p.node, p.iface)) continue;
    if (dev.deviceType === 'router') {
      const subs = Object.values(dev.interfaces).filter((s) => isSubinterface(s.name) && parentInterface(s.name) === ifc.name && ifaceUp(net, p.node, s.name));
      const receivers = f.tag === null ? [ifc, ...subs.filter((s) => s.encapsulation?.native)] : subs.filter((s) => s.encapsulation && !s.encapsulation.native && s.encapsulation.vlan === f.tag);
      const key = `${p.node}:${receivers.map((r) => r.name).join(',')}`;
      if (receivers.length && !seen.has(key)) {
        seen.add(key);
        arrivals.push({ kind: 'router', node: p.node, receivers, path });
      }
      continue;
    }
    let vlan: number | null = null;
    if (ifc.mode === 'trunk') vlan = f.tag === null ? ifc.nativeVlan : allowsVlan(ifc, f.tag) ? f.tag : null;
    else if (f.tag === null || f.tag === ifc.accessVlan) vlan = ifc.accessVlan;
    if (vlan !== null && !blocked(p.node, vlan).has(ifc.name)) queue.push({ sw: p.node, vlan, path: [...path, { sw: p.node, inPort: ifc.name, vlan }] });
  }
  return arrivals;
}

/** True when a switch inspects DHCP or ARP in this VLAN. */
function snoopsVlan(sw: DeviceState, vlan: number): boolean {
  return Boolean(sw.dhcpSnooping?.enabled && sw.dhcpSnooping.vlans.includes(vlan));
}

/**
 * The first switch on the path that would drop a DHCP server reply: snooping is on for
 * the VLAN and the server-facing port is untrusted. Null when the reply gets through.
 */
export function dhcpSnoopingDrop(net: NetworkState, path: SwitchHop[]): SwitchHop | null {
  for (const hop of path) {
    const sw = net.devices[hop.sw];
    if (!snoopsVlan(sw, hop.vlan) || !hop.outPort) continue;
    if (!sw.interfaces[hop.outPort]?.dhcpSnoopingTrust) return hop;
  }
  return null;
}

/** DHCP snooping bindings a switch has learned: leases of hosts cabled to it in a snooped VLAN. */
export interface SnoopingBinding {
  mac: string;
  ip: string;
  vlan: number;
  interface: string;
  hostId: string;
}

export function dhcpSnoopingBindings(net: NetworkState, swId: string): SnoopingBinding[] {
  const sw = net.devices[swId];
  if (!sw?.dhcpSnooping?.enabled) return [];
  const out: SnoopingBinding[] = [];
  for (const h of Object.values(net.hosts)) {
    if (!h.dhcp || !h.dhcpServer || !h.ip) continue;
    const p = peerOf(net, h.id, HOST_IFACE);
    if (!p || p.node !== swId) continue;
    const port = sw.interfaces[p.iface];
    if (!port || port.mode === 'trunk' || !snoopsVlan(sw, port.accessVlan)) continue;
    out.push({ mac: h.mac, ip: h.ip, vlan: port.accessVlan, interface: port.name, hostId: h.id });
  }
  return out;
}

/**
 * Dynamic ARP inspection on the switch port a host is cabled to: in an inspected VLAN an
 * untrusted port only passes ARP whose sender matches a DHCP snooping binding, so a host
 * with a static address is silenced until its port is trusted (or an ARP ACL exists).
 */
function arpInspectionIngress(net: NetworkState, hostId: string): { ok: boolean; reason?: string } {
  const h = net.hosts[hostId];
  const p = peerOf(net, hostId, HOST_IFACE);
  if (!h || !p) return { ok: true };
  const sw = net.devices[p.node];
  const port = sw?.interfaces[p.iface];
  if (!sw || !port || sw.deviceType !== 'switch' || port.mode === 'trunk') return { ok: true };
  if (!sw.arpInspectionVlans.includes(port.accessVlan) || port.arpInspectionTrust) return { ok: true };
  const bound = dhcpSnoopingBindings(net, sw.id).some((b) => b.hostId === hostId && b.ip === h.ip);
  return bound ? { ok: true } : { ok: false, reason: 'arp inspection dropped the request' };
}

/** The frame a router interface (physical, subinterface or SVI-less) emits onto its segment. */
function egressFrame(dev: DeviceState, iface: InterfaceState): Frame {
  const physical = isSubinterface(iface.name) ? parentInterface(iface.name) : iface.name;
  const tag = iface.encapsulation && !iface.encapsulation.native ? iface.encapsulation.vlan : null;
  return { node: dev.id, iface: physical, tag };
}

// ---------------------------------------------------------------------------
// OSPF

export interface OspfInterfaceInfo {
  name: string;
  ip: string;
  mask: string;
  network: string;
  area: number;
  cost: number;
  priority: number;
  passive: boolean;
}

export interface OspfNeighbor {
  localIface: string;
  node: string;
  iface: string;
  ip: string;
  routerId: string;
  priority: number;
  area: number;
  /** IOS-style state such as "FULL/DR" or "2WAY/DROTHER". */
  state: string;
}

function wildcardMatch(ip: string, address: string, wildcard: string): boolean {
  const mask = (~(ipToInt(wildcard) ?? 0)) >>> 0;
  return (((ipToInt(ip) ?? 0) & mask) >>> 0) === (((ipToInt(address) ?? 0) & mask) >>> 0);
}

/** Highest loopback address, else highest active interface address, unless configured. */
export function ospfRouterId(net: NetworkState, id: string): string | null {
  const dev = net.devices[id];
  if (!dev?.ospf) return null;
  if (dev.ospf.routerId) return dev.ospf.routerId;
  const ips = (pred: (i: InterfaceState) => boolean) =>
    Object.values(dev.interfaces)
      .filter((i) => i.ipAddress && pred(i) && ifaceUp(net, id, i.name))
      .map((i) => i.ipAddress!)
      .sort((a, b) => (ipToInt(b) ?? 0) - (ipToInt(a) ?? 0));
  return ips((i) => isLoopback(i.name))[0] ?? ips((i) => !isLoopback(i.name))[0] ?? null;
}

/** Interfaces on which the OSPF process runs, with their area, cost and passive flag. */
export function ospfInterfaces(net: NetworkState, id: string): OspfInterfaceInfo[] {
  const dev = net.devices[id];
  if (!dev?.ospf || !dev.ipRouting) return [];
  const cfg = dev.ospf;
  const out: OspfInterfaceInfo[] = [];
  for (const i of Object.values(dev.interfaces)) {
    if (!i.ipAddress || !i.subnetMask || !ifaceUp(net, id, i.name)) continue;
    let area: number | undefined = i.ospfArea;
    if (area === undefined) {
      const stmt = cfg.networks.find((n) => wildcardMatch(i.ipAddress!, n.address, n.wildcard));
      area = stmt?.area;
    }
    if (area === undefined) continue;
    const passive = cfg.passiveDefault ? !cfg.activeInterfaces.includes(i.name) : cfg.passiveInterfaces.includes(i.name);
    out.push({ name: i.name, ip: i.ipAddress, mask: i.subnetMask, network: networkAddress(i.ipAddress, i.subnetMask), area, cost: i.ospfCost ?? 1, priority: i.ospfPriority ?? 1, passive: passive || isLoopback(i.name) });
  }
  return out;
}

interface SegmentMember {
  node: string;
  iface: string;
  ip: string;
  routerId: string;
  priority: number;
}

/** Every OSPF speaker (including `id` itself) on the segment behind one of its interfaces. */
function segmentMembers(net: NetworkState, id: string, info: OspfInterfaceInfo): SegmentMember[] {
  const dev = net.devices[id];
  const self: SegmentMember = { node: id, iface: info.name, ip: info.ip, routerId: ospfRouterId(net, id)!, priority: info.priority };
  if (info.passive || isLoopback(info.name)) return [self];
  const members: SegmentMember[] = [self];
  for (const a of l2Walk(net, egressFrame(dev, dev.interfaces[info.name]))) {
    if (a.kind !== 'router' || a.node === id) continue;
    const theirs = ospfInterfaces(net, a.node);
    for (const r of a.receivers) {
      const ri = theirs.find((t) => t.name === r.name);
      if (!ri || ri.passive || ri.area !== info.area || !sameSubnet(ri.ip, info.ip, info.mask)) continue;
      const rid = ospfRouterId(net, a.node);
      if (rid) members.push({ node: a.node, iface: ri.name, ip: ri.ip, routerId: rid, priority: ri.priority });
    }
  }
  return members;
}

function electDr(members: SegmentMember[]): { dr?: SegmentMember; bdr?: SegmentMember } {
  const ranked = [...members].sort((a, b) => b.priority - a.priority || (ipToInt(b.routerId) ?? 0) - (ipToInt(a.routerId) ?? 0));
  return { dr: ranked[0], bdr: ranked[1] };
}

/** Role of `id` on the segment behind `info`: DR, BDR or DROTHER. */
export function ospfInterfaceRole(net: NetworkState, id: string, info: OspfInterfaceInfo): { role: 'DR' | 'BDR' | 'DROTHER' | 'LOOP'; neighbors: number } {
  if (isLoopback(info.name)) return { role: 'LOOP', neighbors: 0 };
  const members = segmentMembers(net, id, info);
  const { dr, bdr } = electDr(members);
  const role = dr?.node === id && dr.iface === info.name ? 'DR' : bdr?.node === id && bdr.iface === info.name ? 'BDR' : 'DROTHER';
  return { role, neighbors: members.length - 1 };
}

export function ospfNeighbors(net: NetworkState, id: string): OspfNeighbor[] {
  const out: OspfNeighbor[] = [];
  for (const info of ospfInterfaces(net, id)) {
    if (info.passive) continue;
    const members = segmentMembers(net, id, info);
    const { dr, bdr } = electDr(members);
    const selfIsDrOrBdr = (dr?.node === id && dr.iface === info.name) || (bdr?.node === id && bdr.iface === info.name);
    for (const m of members) {
      if (m.node === id) continue;
      const isDr = dr?.node === m.node && dr.iface === m.iface;
      const isBdr = bdr?.node === m.node && bdr.iface === m.iface;
      const state = isDr ? 'FULL/DR' : isBdr ? 'FULL/BDR' : selfIsDrOrBdr ? 'FULL/DROTHER' : '2WAY/DROTHER';
      out.push({ localIface: info.name, node: m.node, iface: m.iface, ip: m.ip, routerId: m.routerId, priority: m.priority, area: info.area, state });
    }
  }
  return out.sort((a, b) => (ipToInt(a.routerId) ?? 0) - (ipToInt(b.routerId) ?? 0));
}

/**
 * Routes learned through OSPF with multi-area semantics:
 * - intra-area (O): SPF inside each area the router belongs to;
 * - inter-area (O IA): networks of other areas learned through area border routers that
 *   are attached to the backbone (an area with no path to area 0 stays isolated);
 * - external default (O*E2) from routers running default-information originate.
 * Intra-area routes are preferred over inter-area ones regardless of metric.
 */
export function ospfRoutes(net: NetworkState, id: string): RouteEntry[] {
  const dev = net.devices[id];
  if (!dev?.ospf || !dev.ipRouting) return [];
  const localInfos = ospfInterfaces(net, id);
  if (localInfos.length === 0) return [];

  const neighborCache = new Map<string, OspfNeighbor[]>();
  const infoCache = new Map<string, OspfInterfaceInfo[]>();
  const nbrs = (n: string) => {
    if (!neighborCache.has(n)) neighborCache.set(n, ospfNeighbors(net, n));
    return neighborCache.get(n)!;
  };
  const infos = (n: string) => {
    if (!infoCache.has(n)) infoCache.set(n, ospfInterfaces(net, n));
    return infoCache.get(n)!;
  };
  const areasOf = (n: string) => new Set(infos(n).map((i) => i.area));
  const isAbr = (n: string) => areasOf(n).size >= 2 && areasOf(n).has(0);

  interface Reach {
    dist: number;
    hop?: { nextHop: string; exitInterface: string };
  }
  const spfCache = new Map<string, Map<string, Reach>>();
  /** Dijkstra restricted to adjacencies inside one area (or all areas when `area` is null). */
  const spf = (area: number | null, source: string): Map<string, Reach> => {
    const key = `${area}:${source}`;
    if (spfCache.has(key)) return spfCache.get(key)!;
    const dist = new Map<string, Reach>([[source, { dist: 0 }]]);
    const done = new Set<string>();
    while (true) {
      let cur: string | null = null;
      for (const [n, d] of dist) if (!done.has(n) && (cur === null || d.dist < dist.get(cur)!.dist)) cur = n;
      if (cur === null) break;
      done.add(cur);
      for (const nb of nbrs(cur)) {
        if (area !== null && nb.area !== area) continue;
        const cost = infos(cur).find((i) => i.name === nb.localIface)?.cost ?? 1;
        const nd = dist.get(cur)!.dist + cost;
        if (nd < (dist.get(nb.node)?.dist ?? Infinity)) {
          dist.set(nb.node, { dist: nd, hop: cur === source ? { nextHop: nb.ip, exitInterface: nb.localIface } : dist.get(cur)!.hop });
        }
      }
    }
    spfCache.set(key, dist);
    return dist;
  };

  const best = new Map<string, RouteEntry>();
  const localNets = new Set(localInfos.map((i) => `${i.network}/${prefixLength(i.mask)}`));
  const consider = (info: OspfInterfaceInfo, metric: number, source: 'ospf' | 'ospf-ia', hop: Reach['hop']) => {
    if (!hop) return;
    const lo = isLoopback(info.name);
    const destination = lo ? info.ip : info.network;
    const mask = lo ? '255.255.255.255' : info.mask;
    const key = `${destination}/${prefixLength(mask)}`;
    if (localNets.has(key)) return;
    const existing = best.get(key);
    const rank = (s: string) => (s === 'ospf' ? 0 : 1);
    if (existing && (rank(existing.source) < rank(source) || (rank(existing.source) === rank(source) && existing.metric <= metric))) return;
    best.set(key, { destination, mask, prefix: prefixLength(mask), source, nextHop: hop.nextHop, exitInterface: hop.exitInterface, adminDistance: 110, metric, candidateDefault: false });
  };
  const netsIn = (router: string, area: number) => infos(router).filter((i) => i.area === area);

  for (const area of areasOf(id)) {
    const reach = spf(area, id);
    // Intra-area.
    for (const [r, d] of reach) {
      if (r === id) continue;
      for (const n of netsIn(r, area)) consider(n, d.dist + n.cost, 'ospf', d.hop);
    }
    // Inter-area through backbone-attached ABRs reachable inside this area.
    for (const [b, db] of reach) {
      if (b === id || !isAbr(b)) continue;
      if (area === 0) {
        for (const x of areasOf(b)) {
          if (x === 0) continue;
          for (const [r, dr] of spf(x, b)) for (const n of netsIn(r, x)) consider(n, db.dist + dr.dist + n.cost, 'ospf-ia', db.hop);
        }
      } else {
        const backbone = spf(0, b);
        for (const [r, dr] of backbone) for (const n of netsIn(r, 0)) consider(n, db.dist + dr.dist + n.cost, 'ospf-ia', db.hop);
        for (const [c, dc] of backbone) {
          if (c === b || !isAbr(c)) continue;
          for (const y of areasOf(c)) {
            if (y === 0 || y === area) continue;
            for (const [r, dr] of spf(y, c)) for (const n of netsIn(r, y)) consider(n, db.dist + dc.dist + dr.dist + n.cost, 'ospf-ia', db.hop);
          }
        }
      }
    }
  }

  // External default: any originating router reachable through the OSPF graph.
  const any = spf(null, id);
  for (const [r, d] of any) {
    if (r === id || !d.hop) continue;
    const rdev = net.devices[r];
    if (rdev.ospf?.defaultInformationOriginate && baseRoutingTable(net, r).some((e) => e.candidateDefault)) {
      const key = '0.0.0.0/0';
      const existing = best.get(key);
      if (!existing || d.dist < existing.metric) best.set(key, { destination: '0.0.0.0', mask: '0.0.0.0', prefix: 0, source: 'ospf-external', nextHop: d.hop.nextHop, exitInterface: d.hop.exitInterface, adminDistance: 110, metric: 1, candidateDefault: true });
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// routing table

export interface RouteEntry {
  destination: string;
  mask: string;
  prefix: number;
  source: 'connected' | 'local' | 'static' | 'ospf' | 'ospf-ia' | 'ospf-external';
  nextHop?: string;
  exitInterface: string;
  adminDistance: number;
  metric: number;
  candidateDefault: boolean;
}

function inSubnet(ip: string, network: string, mask: string): boolean {
  return sameSubnet(ip, network, mask);
}

/** Connected, local and static routes only (no dynamic protocols). */
export function baseRoutingTable(net: NetworkState, deviceId: string): RouteEntry[] {
  const dev = net.devices[deviceId];
  const entries: RouteEntry[] = [];
  for (const i of Object.values(dev.interfaces)) {
    if (!i.ipAddress || !i.subnetMask || !ifaceUp(net, deviceId, i.name)) continue;
    const prefix = prefixLength(i.subnetMask);
    entries.push({ destination: networkAddress(i.ipAddress, i.subnetMask), mask: i.subnetMask, prefix, source: 'connected', exitInterface: i.name, adminDistance: 0, metric: 0, candidateDefault: false });
    if (prefix < 32) entries.push({ destination: i.ipAddress, mask: '255.255.255.255', prefix: 32, source: 'local', exitInterface: i.name, adminDistance: 0, metric: 0, candidateDefault: false });
  }
  if (dev.ipRouting) {
    for (const r of dev.staticRoutes) {
      let exit = r.exitInterface;
      if (exit) {
        if (!ifaceUp(net, deviceId, exit)) continue;
      } else {
        const via = entries
          .filter((e) => e.source === 'connected' && inSubnet(r.nextHop!, e.destination, e.mask))
          .sort((a, b) => b.prefix - a.prefix)[0];
        if (!via) continue;
        exit = via.exitInterface;
      }
      entries.push({ destination: r.destination, mask: r.mask, prefix: prefixLength(r.mask), source: 'static', nextHop: r.nextHop, exitInterface: exit, adminDistance: r.adminDistance, metric: 0, candidateDefault: r.destination === '0.0.0.0' && r.mask === '0.0.0.0' });
    }
  }
  return entries;
}

export function routingTable(net: NetworkState, deviceId: string): RouteEntry[] {
  const entries = baseRoutingTable(net, deviceId);
  if (net.devices[deviceId]?.deviceType === 'router') {
    for (const o of ospfRoutes(net, deviceId)) {
      // A static or connected route to the same prefix wins by administrative distance.
      const better = entries.find((e) => e.destination === o.destination && e.mask === o.mask && e.adminDistance <= o.adminDistance);
      if (!better) entries.push(o);
    }
  }
  return entries.sort((a, b) => ipToInt(a.destination)! - ipToInt(b.destination)! || a.prefix - b.prefix);
}

export function lookupRoute(table: RouteEntry[], ip: string): RouteEntry | null {
  let best: RouteEntry | null = null;
  for (const e of table) {
    if (!inSubnet(ip, e.destination, e.mask)) continue;
    if (!best || e.prefix > best.prefix || (e.prefix === best.prefix && (e.adminDistance < best.adminDistance || (e.adminDistance === best.adminDistance && e.metric < best.metric)))) best = e;
  }
  return best;
}

// ---------------------------------------------------------------------------
// IPv6 addressing and routing

export interface Ipv6Addresses {
  global: Array<{ address: string; prefix: number }>;
  linkLocal?: string;
}

/** IPv6 addresses active on a device interface (empty when IPv6 is not enabled on it). */
export function ifaceIpv6(dev: DeviceState, iface: InterfaceState): Ipv6Addresses {
  const cfg = iface.ipv6;
  if (!cfg || (!cfg.enabled && cfg.addresses.length === 0)) return { global: [] };
  return { global: cfg.addresses.map((a) => ({ address: a.address, prefix: a.prefix })), linkLocal: cfg.linkLocal ?? linkLocalFromMac(routerMac(dev.id, iface.name)) };
}

export interface RouteEntry6 {
  prefix: string;
  length: number;
  source: 'connected' | 'local' | 'static';
  nextHop?: string;
  exitInterface: string;
  adminDistance: number;
}

function inPrefix6(ip: string, prefix: string, length: number): boolean {
  return sameSubnet6(ip, prefix, length);
}

export function routingTable6(net: NetworkState, deviceId: string): RouteEntry6[] {
  const dev = net.devices[deviceId];
  const entries: RouteEntry6[] = [];
  for (const i of Object.values(dev.interfaces)) {
    if (!ifaceUp(net, deviceId, i.name)) continue;
    for (const a of ifaceIpv6(dev, i).global) {
      entries.push({ prefix: networkAddress6(a.address, a.prefix), length: a.prefix, source: 'connected', exitInterface: i.name, adminDistance: 0 });
      entries.push({ prefix: a.address, length: 128, source: 'local', exitInterface: i.name, adminDistance: 0 });
    }
  }
  if (dev.ipv6UnicastRouting) {
    for (const r of dev.staticRoutes6) {
      let exit = r.exitInterface;
      if (exit) {
        if (!ifaceUp(net, deviceId, exit)) continue;
      } else {
        const via = entries.filter((e) => e.source === 'connected' && inPrefix6(r.nextHop!, e.prefix, e.length)).sort((a, b) => b.length - a.length)[0];
        if (!via) continue;
        exit = via.exitInterface;
      }
      entries.push({ prefix: r.prefix, length: r.length, source: 'static', nextHop: r.nextHop, exitInterface: exit, adminDistance: r.adminDistance });
    }
  }
  return entries.sort((a, b) => {
    const d = (parseIpv6(a.prefix) ?? 0n) - (parseIpv6(b.prefix) ?? 0n);
    return d < 0n ? -1 : d > 0n ? 1 : a.length - b.length;
  });
}

export function lookupRoute6(table: RouteEntry6[], ip: string): RouteEntry6 | null {
  let best: RouteEntry6 | null = null;
  for (const e of table) {
    if (!inPrefix6(ip, e.prefix, e.length)) continue;
    if (!best || e.length > best.length || (e.length === best.length && e.adminDistance < best.adminDistance)) best = e;
  }
  return best;
}

// ---------------------------------------------------------------------------
// forwarding

interface Decision {
  frame: Frame;
  /** IP we are looking for at layer 2 (the destination or the next hop). */
  target: string;
  srcIp: string;
  /** Logical exit interface on a router (subinterface when applicable). */
  exitInterface?: string;
}

function ownsIp(net: NetworkState, node: string, ip: string): boolean {
  const h = net.hosts[node];
  if (isIpv6(ip)) {
    const target = normalizeIpv6(ip)!;
    if (h) return h.ip6 === target || hostLinkLocal(h) === target;
    const dev = net.devices[node];
    return Object.values(dev.interfaces).some((i) => {
      if (!ifaceUp(net, node, i.name)) return false;
      const v6 = ifaceIpv6(dev, i);
      return v6.linkLocal === target || v6.global.some((a) => a.address === target);
    });
  }
  if (h) return h.ip === ip;
  const dev = net.devices[node];
  return Object.values(dev.interfaces).some((i) => i.ipAddress === ip && ifaceUp(net, node, i.name));
}

function decide6(net: NetworkState, node: string, dst: string): Decision | { error: string } {
  const h = net.hosts[node];
  if (h) {
    if (!h.ip6 || h.prefix6 === undefined) return { error: 'no ip address' };
    if (isLinkLocal6(dst) || sameSubnet6(dst, h.ip6, h.prefix6)) return { frame: { node, iface: HOST_IFACE, tag: null }, target: dst, srcIp: h.ip6 };
    if (!h.gateway6) return { error: 'no gateway' };
    return { frame: { node, iface: HOST_IFACE, tag: null }, target: h.gateway6, srcIp: h.ip6 };
  }
  const dev = net.devices[node];
  if (dev.deviceType !== 'router') return { error: 'no route' };
  if (isLinkLocal6(dst)) {
    // Link-local targets are per link: try every IPv6-enabled interface (IOS would ask which one).
    for (const i of Object.values(dev.interfaces)) {
      if (isLoopback(i.name) || !ifaceUp(net, node, i.name)) continue;
      const v6 = ifaceIpv6(dev, i);
      if (!v6.linkLocal) continue;
      const frame = egressFrame(dev, i);
      if (findEndpoint(net, frame, dst)) return { frame, target: dst, srcIp: v6.linkLocal, exitInterface: i.name };
    }
    return { error: 'no route' };
  }
  const entry = lookupRoute6(routingTable6(net, node), dst);
  if (!entry) return { error: 'no route' };
  const exit = dev.interfaces[entry.exitInterface];
  if (isLoopback(exit.name)) return { error: 'no route' };
  const v6 = ifaceIpv6(dev, exit);
  const srcIp = v6.global[0]?.address ?? v6.linkLocal;
  if (!srcIp) return { error: 'no route' };
  return { frame: egressFrame(dev, exit), target: entry.nextHop ?? dst, srcIp, exitInterface: exit.name };
}

function decide(net: NetworkState, node: string, dst: string): Decision | { error: string } {
  if (isIpv6(dst)) return decide6(net, node, normalizeIpv6(dst)!);
  const h = net.hosts[node];
  if (h) {
    if (!h.ip || !h.mask) return { error: 'no ip address' };
    if (sameSubnet(dst, h.ip, h.mask)) return { frame: { node, iface: HOST_IFACE, tag: null }, target: dst, srcIp: h.ip };
    if (!h.gateway || !sameSubnet(h.gateway, h.ip, h.mask)) return { error: 'no gateway' };
    return { frame: { node, iface: HOST_IFACE, tag: null }, target: h.gateway, srcIp: h.ip };
  }
  const dev = net.devices[node];
  if (dev.deviceType === 'switch') {
    const svis = Object.values(dev.interfaces).filter((i) => isSvi(i.name) && i.ipAddress && i.subnetMask && ifaceUp(net, node, i.name));
    const direct = svis.find((i) => sameSubnet(dst, i.ipAddress!, i.subnetMask!));
    if (direct) return { frame: { sw: node, vlan: sviVlanId(direct.name)! }, target: dst, srcIp: direct.ipAddress! };
    const gw = dev.ipDefaultGateway;
    const viaGw = gw ? svis.find((i) => sameSubnet(gw, i.ipAddress!, i.subnetMask!)) : undefined;
    if (!gw || !viaGw) return { error: 'no gateway' };
    return { frame: { sw: node, vlan: sviVlanId(viaGw.name)! }, target: gw, srcIp: viaGw.ipAddress! };
  }
  const entry = lookupRoute(routingTable(net, node), dst);
  if (!entry) return { error: 'no route' };
  const exit = dev.interfaces[entry.exitInterface];
  if (isLoopback(exit.name)) return { error: 'no route' };
  return { frame: egressFrame(dev, exit), target: entry.nextHop ?? dst, srcIp: exit.ipAddress!, exitInterface: exit.name };
}

/** Find the node/interface that answers ARP (or neighbour discovery) for `target` on the segment behind `start`. */
function findEndpoint(net: NetworkState, start: Frame, target: string): Endpoint | null {
  const arrivals = l2Walk(net, start);
  if (isIpv6(target)) {
    const t = normalizeIpv6(target)!;
    for (const a of arrivals) {
      if (a.kind === 'host') {
        const h = net.hosts[a.node];
        if (h.ip6 === t || hostLinkLocal(h) === t) return { node: a.node, iface: HOST_IFACE };
      }
      if (a.kind === 'router') {
        const dev = net.devices[a.node];
        const owner = a.receivers.find((r) => {
          const v6 = ifaceIpv6(dev, r);
          return v6.linkLocal === t || v6.global.some((g) => g.address === t);
        });
        if (owner) return { node: a.node, iface: owner.name };
      }
    }
    return null;
  }
  for (const a of arrivals) {
    if (a.kind === 'host' && net.hosts[a.node].ip === target) return { node: a.node, iface: HOST_IFACE };
    if (a.kind === 'svi' && net.devices[a.node].interfaces[a.iface].ipAddress === target) return { node: a.node, iface: a.iface };
    if (a.kind === 'router') {
      const owner = a.receivers.find((r) => r.ipAddress === target);
      if (owner) return { node: a.node, iface: owner.name };
    }
  }
  // NAT: the outside interface answers for static globals and pool addresses.
  for (const a of arrivals) {
    if (a.kind !== 'router') continue;
    const dev = net.devices[a.node];
    const nat = a.receivers.find((r) => natOwnsAddress(dev, r, target));
    if (nat) return { node: a.node, iface: nat.name };
  }
  // Proxy ARP: a router answers for addresses it can route toward through another interface.
  for (const a of arrivals) {
    if (a.kind !== 'router' || !net.devices[a.node].ipRouting) continue;
    const via = lookupRoute(routingTable(net, a.node), target);
    if (via && !a.receivers.some((r) => r.name === via.exitInterface)) return { node: a.node, iface: a.receivers[0].name };
  }
  return null;
}

export interface Hop {
  node: string;
  ip?: string;
}

export interface AclHit {
  node: string;
  acl: string;
  seq: number;
}

export interface AclDenial {
  node: string;
  /** Address of the router interface that sent the ICMP unreachable. */
  ip?: string;
  acl: string;
}

export interface ForwardResult {
  reached: boolean;
  hops: Hop[];
  /** Source address as the destination saw it (after any NAT). */
  srcIp?: string;
  /** Source port/identifier as the destination saw it (after any PAT). */
  srcPort?: number;
  reason?: string;
  denied?: AclDenial;
  hits: AclHit[];
}

export type PacketSpec = Omit<Packet, 'src' | 'dst'> & { src?: string };

export interface ForwardOptions {
  /** Create NAT translations while forwarding (off for reachability probes). */
  record?: boolean;
}

/** Deterministic ICMP identifier for a source address, used as the PAT "port". */
function icmpId(src: string): number {
  let h = 0;
  for (const c of src) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1 + (h % 60000);
}

/**
 * Evaluate an access list applied to a router interface. Returns the denial, or null
 * when permitted (or when no list is applied / the list does not exist).
 */
function checkAcl(net: NetworkState, node: string, ifaceName: string, direction: 'in' | 'out', packet: Packet, hits: AclHit[]): AclDenial | null {
  const dev = net.devices[node];
  const iface = dev.interfaces[ifaceName];
  const name = direction === 'in' ? iface?.aclIn : iface?.aclOut;
  if (!name) return null;
  const acl = dev.acls[name];
  if (!acl || acl.entries.length === 0) return null;
  const r = evaluateAcl(acl, packet);
  if (r.entry) hits.push({ node, acl: name, seq: r.entry.seq });
  return r.permit ? null : { node, ip: iface.ipAddress, acl: name };
}

/**
 * Walk a packet from `from` toward `dst`, one layer-3 hop at a time, applying ACLs and
 * NAT at each router. Works for IPv4 and IPv6 destinations (NAT and ACLs are IPv4 only).
 */
export function forward(net: NetworkState, from: string, dstArg: string, spec: PacketSpec = { protocol: 'icmp', icmpType: 'echo' }, opts: ForwardOptions = {}): ForwardResult {
  const hits: AclHit[] = [];
  const v6 = isIpv6(dstArg);
  if (!v6 && !isValidIp(dstArg)) return { reached: false, hops: [], reason: 'bad address', hits };
  const record = opts.record ?? true;
  let dst = v6 ? normalizeIpv6(dstArg)! : dstArg;
  let dstPort = spec.dstPort;
  let cur = from;
  const hops: Hop[] = [];
  let srcIp: string | undefined = spec.src;
  let srcPort: number | undefined = spec.srcPort;
  let inIface: string | undefined;
  if (net.hosts[from]) {
    const ps = portSecurityIngress(net, from, record);
    if (!ps.ok) return { reached: false, hops, reason: ps.reason, hits };
    if (!v6) {
      const dai = arpInspectionIngress(net, from);
      if (!dai.ok) return { reached: false, hops, reason: dai.reason, hits };
    }
  }
  for (let ttl = 0; ttl < 32; ttl++) {
    if (ownsIp(net, cur, dst)) return { reached: true, hops, srcIp: srcIp ?? dst, srcPort, hits };
    const d = decide(net, cur, dst);
    if ('error' in d) return { reached: false, hops, srcIp, srcPort, reason: d.error, hits };
    srcIp ??= d.srcIp;
    srcPort ??= icmpId(srcIp);
    const curDev = net.devices[cur];
    // NAT source translation when crossing from an inside to an outside interface.
    if (!v6 && curDev && cur !== from && d.exitInterface && inIface) {
      const exit = curDev.interfaces[d.exitInterface];
      const entry = curDev.interfaces[inIface];
      if (entry?.natRole === 'inside' && exit?.natRole === 'outside') {
        const t = translateSource(curDev, exit, spec.protocol, srcIp, srcPort, dst, record);
        if (!t) return { reached: false, hops, srcIp, srcPort, reason: 'nat pool exhausted', hits };
        srcIp = t.src;
        srcPort = t.port;
      }
    }
    const packet: Packet = { ...spec, src: srcIp, dst, srcPort, dstPort };
    // Outbound ACLs apply to transit traffic, never to packets the router itself created.
    if (!v6 && cur !== from && d.exitInterface) {
      const denial = checkAcl(net, cur, d.exitInterface, 'out', packet, hits);
      if (denial) return { reached: false, hops, srcIp, srcPort, reason: 'acl', denied: { ...denial, ip: hops[hops.length - 1]?.ip ?? denial.ip }, hits };
    }
    const ep = findEndpoint(net, d.frame, d.target);
    if (!ep) return { reached: false, hops, srcIp, srcPort, reason: 'unreachable', hits };
    if (net.hosts[ep.node]) {
      const h = net.hosts[ep.node];
      if (h.ip === dst || h.ip6 === dst || hostLinkLocal(h) === dst) return { reached: true, hops: [...hops, { node: ep.node, ip: dst }], srcIp, srcPort, hits };
      return { reached: false, hops, srcIp, srcPort, reason: 'host does not forward', hits };
    }
    const dev = net.devices[ep.node];
    if (dev.deviceType === 'router' && !v6) {
      const denial = checkAcl(net, ep.node, ep.iface, 'in', packet, hits);
      if (denial) return { reached: false, hops, srcIp, srcPort, reason: 'acl', denied: denial, hits };
      // Replies arriving on an outside interface are mapped back to the inside host.
      if (dev.interfaces[ep.iface]?.natRole === 'outside') {
        const back = translateDestination(dev, spec.protocol, dst, dstPort);
        if (back) {
          dst = back.dst;
          dstPort = back.port;
        }
      }
    }
    if (ownsIp(net, ep.node, dst)) return { reached: true, hops: [...hops, { node: ep.node, ip: dst }], srcIp, srcPort, hits };
    const arrived = dev.interfaces[ep.iface];
    hops.push({ node: ep.node, ip: v6 ? (ifaceIpv6(dev, arrived).global[0]?.address ?? ifaceIpv6(dev, arrived).linkLocal) : arrived?.ipAddress });
    if (dev.deviceType !== 'router' || (v6 ? !dev.ipv6UnicastRouting : !dev.ipRouting)) return { reached: false, hops, srcIp, srcPort, reason: 'not a router', hits };
    cur = ep.node;
    inIface = ep.iface;
  }
  return { reached: false, hops, srcIp, srcPort, reason: 'ttl exceeded', hits };
}

export interface PingResult {
  success: boolean;
  /** Layer-3 hops on the way out (routers plus the final destination). */
  hops: Hop[];
  reason?: string;
  /** Set when an ACL rejected the echo request on the way out. */
  denied?: AclDenial;
  hits: AclHit[];
}

/**
 * Ping semantics: the echo must reach the owner of `dst` and the echo-reply must find
 * its way back to whatever source address the destination saw (after NAT).
 * Note: NAT translations created by the echo are recorded on the routers in `net`.
 */
export function ping(net: NetworkState, from: string, dst: string): PingResult {
  const out = forward(net, from, dst, { protocol: 'icmp', icmpType: 'echo' });
  if (!out.reached) return { success: false, hops: out.hops, reason: out.reason, denied: out.denied, hits: out.hits };
  const dstNode = out.hops[out.hops.length - 1]?.node ?? from;
  if (dstNode === from) return { success: true, hops: out.hops, hits: out.hits };
  const replyDst = out.hops[out.hops.length - 1]?.ip ?? dst;
  const back = forward(net, dstNode, out.srcIp!, { protocol: 'icmp', icmpType: 'echo-reply', src: replyDst, dstPort: out.srcPort });
  const hits = [...out.hits, ...back.hits];
  if (back.reached) return { success: true, hops: out.hops, hits };
  return { success: false, hops: out.hops, reason: back.denied ? 'reply filtered by acl' : `no return path (${back.reason})`, hits };
}

/** Increment "(N matches)" counters for every ACL entry a packet walk touched. */
export function applyAclHits(net: NetworkState, hits: AclHit[]): void {
  for (const h of hits) {
    const entry = net.devices[h.node]?.acls[h.acl]?.entries.find((e) => e.seq === h.seq);
    if (entry) entry.matches += 1;
  }
}

// ---------------------------------------------------------------------------
// DHCP

export interface DhcpResult {
  ok: boolean;
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  server?: string;
  reason?: string;
}

function ownedIps(net: NetworkState, exceptHost: string): Set<string> {
  const used = new Set<string>();
  for (const d of Object.values(net.devices)) for (const i of Object.values(d.interfaces)) if (i.ipAddress) used.add(i.ipAddress);
  for (const h of Object.values(net.hosts)) if (h.id !== exceptHost && h.ip) used.add(h.ip);
  return used;
}

function excluded(dev: DeviceState, ip: string): boolean {
  const n = ipToInt(ip) ?? 0;
  return dev.dhcpExcluded.some((r) => n >= (ipToInt(r.from) ?? 0) && n <= (ipToInt(r.to) ?? 0));
}

function poolFor(server: DeviceState, subnetIp: string, subnetMask: string) {
  return Object.values(server.dhcpPools).find((p) => p.network && p.mask && sameSubnet(subnetIp, p.network, p.mask) && p.mask === subnetMask);
}

/**
 * Simulate a DHCP DISCOVER from a host: local servers on the segment answer first,
 * then relays (ip helper-address) forward to a reachable server that has a pool for
 * the relay interface's subnet. On success the host and the server's bindings are updated.
 */
export function dhcpRequest(net: NetworkState, hostId: string): DhcpResult {
  const host = net.hosts[hostId];
  if (!host) return { ok: false, reason: 'no such host' };
  type Offer = { server: DeviceState; pool: NonNullable<ReturnType<typeof poolFor>>; serverIp: string };
  let offer: Offer | null = null;
  let snooped = false;
  for (const a of l2Walk(net, { node: hostId, iface: HOST_IFACE, tag: null })) {
    if (a.kind !== 'router') continue;
    const dev = net.devices[a.node];
    for (const r of a.receivers) {
      if (!r.ipAddress || !r.subnetMask) continue;
      let found: Offer | null = null;
      const local = poolFor(dev, r.ipAddress, r.subnetMask);
      if (local) found = { server: dev, pool: local, serverIp: r.ipAddress };
      else if (r.helperAddress) {
        const server = Object.values(net.devices).find((d) => d.deviceType === 'router' && Object.values(d.interfaces).some((i) => i.ipAddress === r.helperAddress && ifaceUp(net, d.id, i.name)));
        if (!server) continue;
        if (!forward(net, dev.id, r.helperAddress, { protocol: 'udp', dstPort: 67, srcPort: 67 }, { record: false }).reached) continue;
        if (!forward(net, server.id, r.ipAddress, { protocol: 'udp', dstPort: 67, srcPort: 67 }, { record: false }).reached) continue;
        const pool = poolFor(server, r.ipAddress, r.subnetMask);
        if (pool) found = { server, pool, serverIp: r.helperAddress };
      }
      if (!found) continue;
      // The offer comes back along the same switches; DHCP snooping drops it on an untrusted port.
      if (dhcpSnoopingDrop(net, a.path)) {
        snooped = true;
        continue;
      }
      offer = found;
      break;
    }
    if (offer) break;
  }
  if (!offer) return { ok: false, reason: snooped ? 'DHCP snooping dropped the offer on an untrusted port' : 'no DHCP server answered' };
  const { server, pool, serverIp } = offer;
  const existing = server.dhcpBindings.find((b) => b.mac === host.mac && b.pool === pool.name);
  let ip = existing?.ip;
  if (!ip) {
    const used = ownedIps(net, hostId);
    for (const b of server.dhcpBindings) used.add(b.ip);
    const start = (ipToInt(pool.network!) ?? 0) + 1;
    const end = ((ipToInt(pool.network!) ?? 0) | (~(ipToInt(pool.mask!) ?? 0) >>> 0)) >>> 0;
    for (let n = start; n < end; n++) {
      const cand = intToIp(n);
      if (used.has(cand) || excluded(server, cand)) continue;
      ip = cand;
      break;
    }
    if (!ip) return { ok: false, reason: 'pool exhausted' };
    server.dhcpBindings.push({ ip, mac: host.mac, pool: pool.name, hostId });
  }
  host.ip = ip;
  host.mask = pool.mask;
  host.gateway = pool.defaultRouter;
  host.dns = pool.dnsServer;
  host.dhcpServer = serverIp;
  return { ok: true, ip, mask: pool.mask, gateway: pool.defaultRouter, dns: pool.dnsServer, server: serverIp };
}

/** Drop a host's lease and clear its DHCP-learned settings. */
export function dhcpRelease(net: NetworkState, hostId: string): void {
  const host = net.hosts[hostId];
  if (!host) return;
  for (const d of Object.values(net.devices)) d.dhcpBindings = d.dhcpBindings.filter((b) => b.mac !== host.mac);
  host.ip = undefined;
  host.mask = undefined;
  host.gateway = undefined;
  host.dns = undefined;
  host.dhcpServer = undefined;
}

export function traceroute(net: NetworkState, from: string, dst: string): PingResult {
  return ping(net, from, dst);
}

// ---------------------------------------------------------------------------
// misc helpers used by show commands

export interface MacEntry {
  vlan: number;
  mac: string;
  port: string;
}

/** Directly attached hosts and routers, as a switch's MAC table would learn them. */
export function macTable(net: NetworkState, switchId: string): MacEntry[] {
  const sw = net.devices[switchId];
  const out: MacEntry[] = [];
  for (const i of Object.values(sw.interfaces)) {
    if (isSvi(i.name) || !ifaceUp(net, switchId, i.name)) continue;
    const p = peerOf(net, switchId, i.name);
    if (!p) continue;
    const vlan = i.mode === 'trunk' ? i.nativeVlan : i.accessVlan;
    const host = net.hosts[p.node];
    if (host) out.push({ vlan, mac: host.mac, port: i.name });
    else if (net.devices[p.node]?.deviceType === 'router') out.push({ vlan, mac: routerMac(p.node, p.iface), port: i.name });
  }
  return out;
}

export function routerMac(node: string, iface: string): string {
  let h = 0;
  for (const c of `${node}/${iface}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return `0011.22cc.${hex.slice(0, 4)}`;
}

export function nodeName(net: NetworkState, id: string): string {
  return net.hosts[id]?.name ?? net.devices[id]?.hostname ?? id;
}

// Keep the IPv6 helpers reachable for callers that only import this module.
export { prefixMask6 };
