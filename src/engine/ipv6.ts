/**
 * IPv6 address parsing, formatting (RFC 5952, upper-case hex like IOS) and prefix math.
 */

const MAX128 = (1n << 128n) - 1n;

export function isIpv6(text: string): boolean {
  return parseIpv6(text) !== null;
}

export function parseIpv6(text: string): bigint | null {
  const t = text.trim().toLowerCase();
  if (!t || !/^[0-9a-f:]+$/.test(t)) return null;
  const parts = t.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if (parts.length === 1 && left.length !== 8) return null;
  if (parts.length === 2 && left.length + right.length > 7) return null;
  const groups = [...left, ...(parts.length === 2 ? Array<string>(8 - left.length - right.length).fill('0') : []), ...right];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function formatIpv6(n: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  // Longest run of zero groups (length >= 2) becomes "::".
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16).toUpperCase());
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

/** Canonical upper-case form of an address, or null when invalid. */
export function normalizeIpv6(text: string): string | null {
  const n = parseIpv6(text);
  return n === null ? null : formatIpv6(n);
}

export function prefixMask6(length: number): bigint {
  if (length <= 0) return 0n;
  if (length >= 128) return MAX128;
  return (MAX128 << BigInt(128 - length)) & MAX128;
}

export function networkAddress6(address: string, length: number): string {
  const n = parseIpv6(address) ?? 0n;
  return formatIpv6(n & prefixMask6(length));
}

export function sameSubnet6(a: string, b: string, length: number): boolean {
  const na = parseIpv6(a);
  const nb = parseIpv6(b);
  if (na === null || nb === null) return false;
  const m = prefixMask6(length);
  return (na & m) === (nb & m);
}

export function isLinkLocal6(address: string): boolean {
  const n = parseIpv6(address);
  return n !== null && (n >> 118n) === 0x3fan; // fe80::/10
}

/** "2001:DB8:1::/64" -> { address, length } */
export function parsePrefix6(text: string): { address: string; length: number } | null {
  const m = text.trim().match(/^([0-9a-fA-F:]+)\/(\d{1,3})$/);
  if (!m) return null;
  const length = Number(m[2]);
  const address = normalizeIpv6(m[1]);
  if (!address || length > 128) return null;
  return { address, length };
}

/** Modified EUI-64 interface identifier from a dotted MAC such as "0011.22cc.1a2b". */
export function eui64(mac: string): bigint {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`Bad MAC ${mac}`);
  const bytes = hex.match(/.{2}/g)!.map((b) => parseInt(b, 16));
  bytes[0] ^= 0x02; // flip the universal/local bit
  const full = [...bytes.slice(0, 3), 0xff, 0xfe, ...bytes.slice(3)];
  return full.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}

export function linkLocalFromMac(mac: string): string {
  return formatIpv6((0xfe80n << 112n) | eui64(mac));
}

export function eui64Address(prefix: string, length: number, mac: string): string {
  const net = (parseIpv6(prefix) ?? 0n) & prefixMask6(length);
  return formatIpv6(net | eui64(mac));
}

/** Convenience for lab authors: an interface IPv6 config from "addr/len" strings. */
export function ipv6Config(...addresses: string[]): { enabled: boolean; addresses: Array<{ address: string; prefix: number }>; linkLocal?: string } {
  const out: Array<{ address: string; prefix: number }> = [];
  let linkLocal: string | undefined;
  for (const a of addresses) {
    const p = parsePrefix6(a);
    if (!p) {
      const ll = normalizeIpv6(a);
      if (ll && isLinkLocal6(ll)) linkLocal = ll;
      else throw new Error(`Bad IPv6 address ${a}`);
      continue;
    }
    out.push({ address: p.address, prefix: p.length });
  }
  return { enabled: true, addresses: out, linkLocal };
}
