/**
 * IPv4 NAT rules applied by the forwarding simulation.
 */
import type { DeviceState, InterfaceState } from './types';
import { evaluateAcl } from './acl';
import { intToIp, ipToInt } from './ios/net';

export type NatProto = 'icmp' | 'tcp' | 'udp';

/** All addresses a router's outside interface should answer ARP for on behalf of NAT. */
export function natOwnsAddress(dev: DeviceState, iface: InterfaceState, target: string): boolean {
  if (iface.natRole !== 'outside') return false;
  if (dev.natStatic.some((s) => s.insideGlobal === target)) return true;
  const n = ipToInt(target) ?? -1;
  return Object.values(dev.natPools).some((p) => n >= (ipToInt(p.start) ?? 0) && n <= (ipToInt(p.end) ?? 0));
}

function poolAddresses(dev: DeviceState, poolName: string): string[] {
  const p = dev.natPools[poolName];
  if (!p) return [];
  const out: string[] = [];
  const start = ipToInt(p.start) ?? 0;
  const end = ipToInt(p.end) ?? 0;
  for (let n = start; n <= end && out.length < 1024; n++) out.push(intToIp(n));
  return out;
}

/**
 * Translate the source of a packet leaving an outside interface. Returns the new
 * source, or null when NAT applies but no translation can be created (pool exhausted).
 * Returns the original source when no rule matches.
 */
export function translateSource(
  dev: DeviceState,
  exit: InterfaceState,
  proto: NatProto,
  src: string,
  srcPort: number,
  dst: string,
  record: boolean,
): { src: string; port: number } | null {
  const staticRule = dev.natStatic.find((s) => s.insideLocal === src);
  if (staticRule) {
    // The static mapping itself is always listed by "show ip nat translations"; record the flow only.
    if (record && !dev.natTranslations.some((t) => t.insideLocal === src && t.insideLocalPort === srcPort && t.proto === proto && t.outsideGlobal === dst)) {
      dev.natTranslations.push({ proto, insideLocal: src, insideLocalPort: srcPort, insideGlobal: staticRule.insideGlobal, insideGlobalPort: srcPort, outsideGlobal: dst, outsidePort: srcPort, static: true });
    }
    return { src: staticRule.insideGlobal, port: srcPort };
  }
  const rule = dev.natDynamic;
  if (!rule) return { src, port: srcPort };
  const acl = dev.acls[rule.acl];
  if (!acl || !evaluateAcl(acl, { src, dst, protocol: proto }).permit) return { src, port: srcPort };

  const existing = dev.natTranslations.find((t) => !t.static && t.insideLocal === src && t.insideLocalPort === srcPort && t.proto === proto && t.outsideGlobal === dst);
  if (existing) return { src: existing.insideGlobal, port: existing.insideGlobalPort ?? srcPort };

  if (rule.overload) {
    const global = rule.interface ? exit.ipAddress! : pickPoolAddress(dev, rule.pool!, true);
    if (!global) return null;
    const usedPorts = new Set(dev.natTranslations.filter((t) => t.insideGlobal === global && t.insideGlobalPort !== undefined).map((t) => t.insideGlobalPort!));
    let port = 1024;
    while (usedPorts.has(port)) port++;
    if (record) dev.natTranslations.push({ proto, insideLocal: src, insideLocalPort: srcPort, insideGlobal: global, insideGlobalPort: port, outsideGlobal: dst, outsidePort: srcPort, static: false });
    return { src: global, port };
  }

  // Dynamic NAT without overload: one global address per inside host.
  const hostMapping = dev.natTranslations.find((t) => !t.static && t.insideLocal === src && t.insideLocalPort === undefined);
  let global = hostMapping?.insideGlobal;
  if (!global) {
    global = pickPoolAddress(dev, rule.pool!, false) ?? undefined;
    if (!global) return null;
    if (record) dev.natTranslations.push({ proto: '---', insideLocal: src, insideGlobal: global, static: false });
  }
  if (record) dev.natTranslations.push({ proto, insideLocal: src, insideLocalPort: srcPort, insideGlobal: global, insideGlobalPort: srcPort, outsideGlobal: dst, outsidePort: srcPort, static: false });
  return { src: global, port: srcPort };
}

function pickPoolAddress(dev: DeviceState, poolName: string, shared: boolean): string | null {
  const addresses = poolAddresses(dev, poolName);
  if (addresses.length === 0) return null;
  if (shared) return addresses[0];
  const taken = new Set(dev.natTranslations.filter((t) => !t.static && t.insideLocalPort === undefined).map((t) => t.insideGlobal));
  return addresses.find((a) => !taken.has(a)) ?? null;
}

/** Map a packet arriving on an outside interface back to the inside host it belongs to. */
export function translateDestination(dev: DeviceState, proto: NatProto, dst: string, dstPort: number | undefined): { dst: string; port?: number } | null {
  const staticRule = dev.natStatic.find((s) => s.insideGlobal === dst);
  if (staticRule) return { dst: staticRule.insideLocal, port: dstPort };
  const t = dev.natTranslations.find((x) => !x.static && x.insideGlobal === dst && x.insideGlobalPort !== undefined && x.insideGlobalPort === dstPort && x.proto === proto);
  if (t) return { dst: t.insideLocal, port: t.insideLocalPort };
  return null;
}

/** Drop dynamic translations ("clear ip nat translation *"). Static mappings stay. */
export function clearTranslations(dev: DeviceState): number {
  const before = dev.natTranslations.length;
  dev.natTranslations = dev.natTranslations.filter((t) => t.static);
  return before - dev.natTranslations.length;
}

export function natEnabled(dev: DeviceState): boolean {
  return dev.natStatic.length > 0 || dev.natDynamic !== undefined;
}
