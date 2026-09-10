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
import type { DeviceState, InterfaceState, PingRecord } from './types';
import { isSvi, normalizeInterfaceName, sviVlanId } from './interfaces';
import { intToIp, ipToInt, isValidIp, networkAddress, prefixLength, sameSubnet } from './ios/net';
import { evaluateAcl, type Packet } from './acl';
import { isIpv6, isLinkLocal6, linkLocalFromMac, networkAddress6, normalizeIpv6, parseIpv6, prefixMask6, sameSubnet6 } from './ipv6';
import { natOwnsAddress, translateDestination, translateSource } from './nat';

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
  if (!i || i.shutdown) return false;
  if (isSvi(i.name) || isLoopback(i.name)) return true;
  if (isSubinterface(i.name)) return ifaceUp(net, node, parentInterface(i.name));
  return i.connected;
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
    }
  }
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
      kind: 'host', id: h.id, name: h.name ?? h.id, deviceKind: h.kind ?? 'pc', ip: h.ip, mask: h.mask, gateway: h.gateway, dns: h.dns, dhcp: h.dhcp,
      ip6: v6 ? normalizeIpv6(v6[0]) ?? undefined : undefined, prefix6: v6 ? Number(v6[1] ?? 64) : undefined, gateway6: h.gateway6 ? normalizeIpv6(h.gateway6) ?? undefined : undefined,
      mac: `0011.22bb.${String(idx + 1).padStart(4, '0')}`, commandHistory: [], pings: [],
    };
  });
  const net: NetworkState = { primary: spec.primary ?? spec.devices[0].id, devices, hosts, links: [] };
  for (const [a, b] of spec.links) net.links.push({ a: parseEnd(net, a), b: parseEnd(net, b) });
  syncLinkState(net);
  return net;
}

// ---------------------------------------------------------------------------
// layer 2 walk

type Frame = { node: string; iface: string; tag: number | null } | { sw: string; vlan: number };

type Arrival = { kind: 'host'; node: string } | { kind: 'svi'; node: string; iface: string } | { kind: 'router'; node: string; receivers: InterfaceState[] };

function allowsVlan(i: InterfaceState, vlan: number): boolean {
  return i.trunkAllowed === 'all' || i.trunkAllowed.includes(vlan);
}

/** Flood a frame through the layer-2 domain and report every layer-3 endpoint it reaches. */
function l2Walk(net: NetworkState, start: Frame): Arrival[] {
  const arrivals: Arrival[] = [];
  const queue: Frame[] = [start];
  const visited = new Set<string>();
  const seen = new Set<string>();
  while (queue.length) {
    const f = queue.shift()!;
    if ('sw' in f) {
      const key = `${f.sw}:${f.vlan}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const sw = net.devices[f.sw];
      const svi = sw.interfaces[`Vlan${f.vlan}`];
      if (svi && ifaceUp(net, f.sw, svi.name)) arrivals.push({ kind: 'svi', node: f.sw, iface: svi.name });
      for (const q of Object.values(sw.interfaces)) {
        if (isSvi(q.name) || !ifaceUp(net, f.sw, q.name)) continue;
        if (q.mode === 'trunk') {
          if (allowsVlan(q, f.vlan)) queue.push({ node: f.sw, iface: q.name, tag: f.vlan === q.nativeVlan ? null : f.vlan });
        } else if (q.accessVlan === f.vlan) queue.push({ node: f.sw, iface: q.name, tag: null });
      }
      continue;
    }
    if (!net.hosts[f.node] && !ifaceUp(net, f.node, f.iface)) continue;
    const p = peerOf(net, f.node, f.iface);
    if (!p) continue;
    if (net.hosts[p.node]) {
      if (f.tag === null && !seen.has(p.node)) {
        seen.add(p.node);
        arrivals.push({ kind: 'host', node: p.node });
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
        arrivals.push({ kind: 'router', node: p.node, receivers });
      }
      continue;
    }
    let vlan: number | null = null;
    if (ifc.mode === 'trunk') vlan = f.tag === null ? ifc.nativeVlan : allowsVlan(ifc, f.tag) ? f.tag : null;
    else if (f.tag === null || f.tag === ifc.accessVlan) vlan = ifc.accessVlan;
    if (vlan !== null) queue.push({ sw: p.node, vlan });
  }
  return arrivals;
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

/** Routes learned through OSPF: SPF over the router graph, then every OSPF-enabled network of each reachable router. */
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

  // Dijkstra from the local router.
  const dist = new Map<string, number>([[id, 0]]);
  const firstHop = new Map<string, { nextHop: string; exitInterface: string }>();
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    for (const [n, d] of dist) if (!done.has(n) && (cur === null || d < dist.get(cur)!)) cur = n;
    if (cur === null) break;
    done.add(cur);
    for (const nb of nbrs(cur)) {
      const cost = infos(cur).find((i) => i.name === nb.localIface)?.cost ?? 1;
      const nd = dist.get(cur)! + cost;
      if (nd < (dist.get(nb.node) ?? Infinity)) {
        dist.set(nb.node, nd);
        firstHop.set(nb.node, cur === id ? { nextHop: nb.ip, exitInterface: nb.localIface } : firstHop.get(cur)!);
      }
    }
  }

  const best = new Map<string, RouteEntry>();
  const localNets = new Set(localInfos.map((i) => `${i.network}/${prefixLength(i.mask)}`));
  for (const [r, d] of dist) {
    if (r === id) continue;
    const hop = firstHop.get(r)!;
    for (const i of infos(r)) {
      const lo = isLoopback(i.name);
      const destination = lo ? i.ip : i.network;
      const mask = lo ? '255.255.255.255' : i.mask;
      const key = `${destination}/${prefixLength(mask)}`;
      if (localNets.has(key)) continue;
      const metric = d + i.cost;
      const existing = best.get(key);
      if (!existing || metric < existing.metric) {
        best.set(key, { destination, mask, prefix: prefixLength(mask), source: 'ospf', nextHop: hop.nextHop, exitInterface: hop.exitInterface, adminDistance: 110, metric, candidateDefault: false });
      }
    }
    const rdev = net.devices[r];
    if (rdev.ospf?.defaultInformationOriginate && baseRoutingTable(net, r).some((e) => e.candidateDefault)) {
      const key = '0.0.0.0/0';
      const existing = best.get(key);
      if (!existing || d < existing.metric) best.set(key, { destination: '0.0.0.0', mask: '0.0.0.0', prefix: 0, source: 'ospf-external', nextHop: hop.nextHop, exitInterface: hop.exitInterface, adminDistance: 110, metric: 1, candidateDefault: true });
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
  source: 'connected' | 'local' | 'static' | 'ospf' | 'ospf-external';
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
  let offer: { server: DeviceState; pool: NonNullable<ReturnType<typeof poolFor>>; serverIp: string } | null = null;
  for (const a of l2Walk(net, { node: hostId, iface: HOST_IFACE, tag: null })) {
    if (a.kind !== 'router') continue;
    const dev = net.devices[a.node];
    for (const r of a.receivers) {
      if (!r.ipAddress || !r.subnetMask) continue;
      const local = poolFor(dev, r.ipAddress, r.subnetMask);
      if (local) {
        offer = { server: dev, pool: local, serverIp: r.ipAddress };
        break;
      }
      if (r.helperAddress) {
        const server = Object.values(net.devices).find((d) => d.deviceType === 'router' && Object.values(d.interfaces).some((i) => i.ipAddress === r.helperAddress && ifaceUp(net, d.id, i.name)));
        if (!server) continue;
        if (!forward(net, dev.id, r.helperAddress, { protocol: 'udp', dstPort: 67, srcPort: 67 }, { record: false }).reached) continue;
        if (!forward(net, server.id, r.ipAddress, { protocol: 'udp', dstPort: 67, srcPort: 67 }, { record: false }).reached) continue;
        const pool = poolFor(server, r.ipAddress, r.subnetMask);
        if (pool) {
          offer = { server, pool, serverIp: r.helperAddress };
          break;
        }
      }
    }
    if (offer) break;
  }
  if (!offer) return { ok: false, reason: 'no DHCP server answered' };
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
