/**
 * Multi-device network model and packet forwarding simulation.
 *
 * A NetworkState holds CLI devices (switches, routers), simple hosts (PCs, servers)
 * and the cables between them. ping() walks a packet from a node to a destination
 * IP the way real gear would: hosts pick direct delivery or their gateway, switches
 * flood inside a VLAN (honouring access/trunk/native/allowed settings and router
 * subinterface tags), routers do longest-prefix lookups and decrement TTL. A ping
 * only succeeds when the reply can find its way back as well.
 */
import type { DeviceState, InterfaceState, PingRecord } from './types';
import { isSvi, normalizeInterfaceName, sviVlanId } from './interfaces';
import { ipToInt, isValidIp, networkAddress, prefixLength, sameSubnet } from './ios/net';

export interface HostState {
  kind: 'host';
  id: string;
  name: string;
  /** How the topology should draw it. */
  deviceKind: 'pc' | 'server' | 'switch' | 'router';
  ip?: string;
  mask?: string;
  gateway?: string;
  mac: string;
  commandHistory: string[];
  pings: PingRecord[];
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
    hosts[h.id] = { kind: 'host', id: h.id, name: h.name ?? h.id, deviceKind: h.kind ?? 'pc', ip: h.ip, mask: h.mask, gateway: h.gateway, mac: `0011.22bb.${String(idx + 1).padStart(4, '0')}`, commandHistory: [], pings: [] };
  });
  const net: NetworkState = { primary: spec.primary ?? spec.devices[0].id, devices, hosts, links: [] };
  for (const [a, b] of spec.links) net.links.push({ a: parseEnd(net, a), b: parseEnd(net, b) });
  syncLinkState(net);
  return net;
}

// ---------------------------------------------------------------------------
// routing table

export interface RouteEntry {
  destination: string;
  mask: string;
  prefix: number;
  source: 'connected' | 'local' | 'static';
  nextHop?: string;
  exitInterface: string;
  adminDistance: number;
  metric: number;
  candidateDefault: boolean;
}

function inSubnet(ip: string, network: string, mask: string): boolean {
  return sameSubnet(ip, network, mask);
}

export function routingTable(net: NetworkState, deviceId: string): RouteEntry[] {
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
// forwarding

type Frame = { node: string; iface: string; tag: number | null } | { sw: string; vlan: number };

interface Decision {
  frame: Frame;
  /** IP we are looking for at layer 2 (the destination or the next hop). */
  target: string;
  srcIp: string;
}

function ownsIp(net: NetworkState, node: string, ip: string): boolean {
  const h = net.hosts[node];
  if (h) return h.ip === ip;
  const dev = net.devices[node];
  return Object.values(dev.interfaces).some((i) => i.ipAddress === ip && ifaceUp(net, node, i.name));
}

function decide(net: NetworkState, node: string, dst: string): Decision | { error: string } {
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
  const physical = isSubinterface(exit.name) ? parentInterface(exit.name) : exit.name;
  const tag = exit.encapsulation && !exit.encapsulation.native ? exit.encapsulation.vlan : null;
  return { frame: { node, iface: physical, tag }, target: entry.nextHop ?? dst, srcIp: exit.ipAddress! };
}

function allowsVlan(i: InterfaceState, vlan: number): boolean {
  return i.trunkAllowed === 'all' || i.trunkAllowed.includes(vlan);
}

/** Flood a frame through the layer-2 domain and return the node/interface that owns `target`. */
function findEndpoint(net: NetworkState, start: Frame, target: string): Endpoint | null {
  const queue: Frame[] = [start];
  const visited = new Set<string>();
  while (queue.length) {
    const f = queue.shift()!;
    if ('sw' in f) {
      const key = `${f.sw}:${f.vlan}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const sw = net.devices[f.sw];
      const svi = sw.interfaces[`Vlan${f.vlan}`];
      if (svi && svi.ipAddress === target && ifaceUp(net, f.sw, svi.name)) return { node: f.sw, iface: svi.name };
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
    const host = net.hosts[p.node];
    if (host) {
      if (f.tag === null && host.ip === target) return { node: p.node, iface: HOST_IFACE };
      continue;
    }
    const dev = net.devices[p.node];
    const ifc = dev.interfaces[p.iface];
    if (!ifc || !ifaceUp(net, p.node, p.iface)) continue;
    if (dev.deviceType === 'router') {
      const subs = Object.values(dev.interfaces).filter((s) => isSubinterface(s.name) && parentInterface(s.name) === ifc.name && ifaceUp(net, p.node, s.name));
      // The interface that would receive this frame, given its tag.
      const receiver = f.tag === null ? [ifc, ...subs.filter((s) => s.encapsulation?.native)] : subs.filter((s) => s.encapsulation && !s.encapsulation.native && s.encapsulation.vlan === f.tag);
      const owner = receiver.find((r) => r.ipAddress === target);
      if (owner) return { node: p.node, iface: owner.name };
      // Proxy ARP: a router answers for addresses it can route toward through another interface.
      if (dev.ipRouting && receiver.length) {
        const via = lookupRoute(routingTable(net, p.node), target);
        if (via && !receiver.some((r) => r.name === via.exitInterface)) return { node: p.node, iface: receiver[0].name };
      }
      continue;
    }
    // Switch ingress: classify the frame into a VLAN.
    let vlan: number | null = null;
    if (ifc.mode === 'trunk') vlan = f.tag === null ? ifc.nativeVlan : allowsVlan(ifc, f.tag) ? f.tag : null;
    else if (f.tag === null || f.tag === ifc.accessVlan) vlan = ifc.accessVlan;
    if (vlan !== null) queue.push({ sw: p.node, vlan });
  }
  return null;
}

export interface Hop {
  node: string;
  ip?: string;
}

export interface ForwardResult {
  reached: boolean;
  hops: Hop[];
  srcIp?: string;
  reason?: string;
}

/** Walk a packet from `from` toward `dst`, one layer-3 hop at a time. */
export function forward(net: NetworkState, from: string, dst: string): ForwardResult {
  if (!isValidIp(dst)) return { reached: false, hops: [], reason: 'bad address' };
  let cur = from;
  const hops: Hop[] = [];
  let srcIp: string | undefined;
  for (let ttl = 0; ttl < 32; ttl++) {
    if (ownsIp(net, cur, dst)) return { reached: true, hops, srcIp: srcIp ?? dst };
    const d = decide(net, cur, dst);
    if ('error' in d) return { reached: false, hops, srcIp, reason: d.error };
    srcIp ??= d.srcIp;
    const ep = findEndpoint(net, d.frame, d.target);
    if (!ep) return { reached: false, hops, srcIp, reason: 'unreachable' };
    if (net.hosts[ep.node]) {
      const h = net.hosts[ep.node];
      if (h.ip === dst) return { reached: true, hops: [...hops, { node: ep.node, ip: h.ip }], srcIp };
      return { reached: false, hops, srcIp, reason: 'host does not forward' };
    }
    const dev = net.devices[ep.node];
    if (ownsIp(net, ep.node, dst)) return { reached: true, hops: [...hops, { node: ep.node, ip: dst }], srcIp };
    hops.push({ node: ep.node, ip: dev.interfaces[ep.iface]?.ipAddress });
    if (dev.deviceType !== 'router' || !dev.ipRouting) return { reached: false, hops, srcIp, reason: 'not a router' };
    cur = ep.node;
  }
  return { reached: false, hops, srcIp, reason: 'ttl exceeded' };
}

export interface PingResult {
  success: boolean;
  /** Layer-3 hops on the way out (routers plus the final destination). */
  hops: Hop[];
  reason?: string;
}

export function ping(net: NetworkState, from: string, dst: string): PingResult {
  const out = forward(net, from, dst);
  if (!out.reached) return { success: false, hops: out.hops, reason: out.reason };
  const dstNode = out.hops[out.hops.length - 1]?.node ?? from;
  if (dstNode === from) return { success: true, hops: out.hops };
  const back = forward(net, dstNode, out.srcIp!);
  return back.reached ? { success: true, hops: out.hops } : { success: false, hops: out.hops, reason: `no return path (${back.reason})` };
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
