/**
 * IOS access-list grammar, matching and rendering.
 */
import type { Acl, AclAddr, AclEntry, AclProtocol } from './types';
import { ipToInt, isValidIp } from './ios/net';

export const PORT_NAMES: Record<string, number> = {
  'ftp-data': 20, ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, dns: 53, tftp: 69, www: 80, http: 80, pop3: 110, ntp: 123, snmp: 161, bootps: 67, bootpc: 68, https: 443, syslog: 514,
};

const PORT_LABEL: Record<number, string> = { 20: 'ftp-data', 21: 'ftp', 22: '22', 23: 'telnet', 25: 'smtp', 53: 'domain', 69: 'tftp', 80: 'www', 110: 'pop3', 123: 'ntp', 161: 'snmp', 67: 'bootps', 68: 'bootpc', 443: '443', 514: 'syslog' };

export function isStandardNumber(n: number): boolean {
  return (n >= 1 && n <= 99) || (n >= 1300 && n <= 1999);
}

export function isExtendedNumber(n: number): boolean {
  return (n >= 100 && n <= 199) || (n >= 2000 && n <= 2699);
}

export interface Packet {
  src: string;
  dst: string;
  protocol: 'icmp' | 'tcp' | 'udp';
  icmpType?: 'echo' | 'echo-reply';
  srcPort?: number;
  dstPort?: number;
}

/** Parse "any" | "host X" | "A W" | "A" (bare address = host, standard lists only). */
function parseAddr(tokens: string[], i: number, allowBare: boolean): { addr: AclAddr; next: number } | null {
  const t = tokens[i]?.toLowerCase();
  if (!t) return null;
  if (t === 'any') return { addr: { kind: 'any' }, next: i + 1 };
  if (t === 'host') {
    const ip = tokens[i + 1];
    return ip && isValidIp(ip) ? { addr: { kind: 'host', ip }, next: i + 2 } : null;
  }
  if (!isValidIp(t)) return null;
  const w = tokens[i + 1];
  if (w && isValidIp(w)) return { addr: { kind: 'wildcard', address: tokens[i], wildcard: w }, next: i + 2 };
  return allowBare ? { addr: { kind: 'host', ip: tokens[i] }, next: i + 1 } : null;
}

function parsePort(tokens: string[], i: number): { port: number; next: number } | null | undefined {
  if (tokens[i]?.toLowerCase() !== 'eq') return undefined;
  const p = tokens[i + 1];
  if (!p) return null;
  const n = /^\d+$/.test(p) ? Number(p) : PORT_NAMES[p.toLowerCase()];
  return n === undefined || n > 65535 ? null : { port: n, next: i + 2 };
}

/** "permit 192.168.1.0 0.0.0.255", "deny host 10.1.1.1", "permit any" */
export function parseStandardRule(action: 'permit' | 'deny', tokens: string[]): Omit<AclEntry, 'seq' | 'matches'> | null {
  const src = parseAddr(tokens, 0, true);
  if (!src) return null;
  let i = src.next;
  if (tokens[i]?.toLowerCase() === 'log') i++;
  if (i !== tokens.length) return null;
  return { action, src: src.addr };
}

/** "permit tcp 192.168.1.0 0.0.0.255 any eq 80", "deny icmp any host 10.0.0.1 echo", "permit ip any any" */
export function parseExtendedRule(action: 'permit' | 'deny', tokens: string[]): Omit<AclEntry, 'seq' | 'matches'> | null {
  const protocol = tokens[0]?.toLowerCase() as AclProtocol | undefined;
  if (!protocol || !['ip', 'icmp', 'tcp', 'udp'].includes(protocol)) return null;
  const src = parseAddr(tokens, 1, false);
  if (!src) return null;
  let i = src.next;
  let srcPort: number | undefined;
  if (protocol === 'tcp' || protocol === 'udp') {
    const p = parsePort(tokens, i);
    if (p === null) return null;
    if (p) {
      srcPort = p.port;
      i = p.next;
    }
  }
  const dst = parseAddr(tokens, i, false);
  if (!dst) return null;
  i = dst.next;
  let dstPort: number | undefined;
  let icmpType: AclEntry['icmpType'];
  let established = false;
  if (protocol === 'tcp' || protocol === 'udp') {
    const p = parsePort(tokens, i);
    if (p === null) return null;
    if (p) {
      dstPort = p.port;
      i = p.next;
    }
    if (protocol === 'tcp' && tokens[i]?.toLowerCase() === 'established') {
      established = true;
      i++;
    }
  } else if (protocol === 'icmp') {
    const t = tokens[i]?.toLowerCase();
    if (t === 'echo' || t === 'echo-reply') {
      icmpType = t;
      i++;
    }
  }
  if (tokens[i]?.toLowerCase() === 'log') i++;
  if (i !== tokens.length) return null;
  return { action, protocol, src: src.addr, dst: dst.addr, srcPort, dstPort, icmpType, established: established || undefined };
}

export function matchAddr(addr: AclAddr, ip: string): boolean {
  if (addr.kind === 'any') return true;
  if (addr.kind === 'host') return addr.ip === ip;
  const mask = (~(ipToInt(addr.wildcard) ?? 0)) >>> 0;
  return (((ipToInt(ip) ?? 0) & mask) >>> 0) === (((ipToInt(addr.address) ?? 0) & mask) >>> 0);
}

export function entryMatches(entry: AclEntry, kind: Acl['kind'], packet: Packet): boolean {
  if (entry.action === 'remark') return false;
  if (!matchAddr(entry.src, packet.src)) return false;
  if (kind === 'standard') return true;
  if (entry.protocol !== 'ip' && entry.protocol !== packet.protocol) return false;
  if (entry.dst && !matchAddr(entry.dst, packet.dst)) return false;
  if (entry.srcPort !== undefined && entry.srcPort !== packet.srcPort) return false;
  if (entry.dstPort !== undefined && entry.dstPort !== packet.dstPort) return false;
  if (entry.icmpType !== undefined && entry.icmpType !== packet.icmpType) return false;
  if (entry.established && packet.protocol === 'tcp') return false;
  return true;
}

/** First matching entry decides; nothing matching means the implicit deny. */
export function evaluateAcl(acl: Acl, packet: Packet): { permit: boolean; entry?: AclEntry } {
  for (const e of acl.entries) {
    if (entryMatches(e, acl.kind, packet)) return { permit: e.action === 'permit', entry: e };
  }
  return { permit: false };
}

function addrText(a: AclAddr, standardShow: boolean): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return standardShow ? `host ${a.ip}` : `host ${a.ip}`;
  return standardShow ? `${a.address}, wildcard bits ${a.wildcard}` : `${a.address} ${a.wildcard}`;
}

function portText(p: number): string {
  return PORT_LABEL[p] ?? String(p);
}

/** Rule text as it appears in the running config (after "permit"/"deny"). */
export function ruleText(entry: AclEntry, kind: Acl['kind'], forShow = false): string {
  if (entry.action === 'remark') return `remark ${entry.remark ?? ''}`;
  if (kind === 'standard') return `${entry.action}${forShow && entry.action === 'deny' ? '  ' : ''} ${addrText(entry.src, forShow)}`;
  const parts = [entry.action, entry.protocol ?? 'ip', addrText(entry.src, false)];
  if (entry.srcPort !== undefined) parts.push('eq', portText(entry.srcPort));
  parts.push(addrText(entry.dst ?? { kind: 'any' }, false));
  if (entry.dstPort !== undefined) parts.push('eq', portText(entry.dstPort));
  if (entry.icmpType) parts.push(entry.icmpType);
  if (entry.established) parts.push('established');
  return parts.join(' ');
}

export function nextSeq(acl: Acl): number {
  return acl.entries.length ? Math.max(...acl.entries.map((e) => e.seq)) + 10 : 10;
}
