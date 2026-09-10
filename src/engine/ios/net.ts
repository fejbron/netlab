/** Small IPv4 helpers. */

export function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function isValidIp(ip: string): boolean {
  return ipToInt(ip) !== null;
}

export function isValidMask(mask: string): boolean {
  const n = ipToInt(mask);
  if (n === null) return false;
  // A valid mask is a run of 1s followed by 0s.
  const inverted = (~n) >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

export function sameSubnet(a: string, b: string, mask: string): boolean {
  const ia = ipToInt(a);
  const ib = ipToInt(b);
  const im = ipToInt(mask);
  if (ia === null || ib === null || im === null) return false;
  return ((ia & im) >>> 0) === ((ib & im) >>> 0);
}

export function parseVlanList(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || a > b) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}
