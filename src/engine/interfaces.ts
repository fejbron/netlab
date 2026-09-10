const TYPES = [
  { full: 'GigabitEthernet', short: 'Gi' },
  { full: 'FastEthernet', short: 'Fa' },
  { full: 'Ethernet', short: 'Et' },
  { full: 'Loopback', short: 'Lo' },
  { full: 'Vlan', short: 'Vl' },
] as const;

/**
 * Turn any IOS interface spelling into the canonical full name.
 * "g0/1", "gi 0/1", "GigabitEthernet0/1" all become "GigabitEthernet0/1".
 * Returns null when the text does not look like an interface.
 */
export function normalizeInterfaceName(raw: string): string | null {
  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');
  const m = compact.match(/^([a-z]+)(\d[\d/.]*)$/);
  if (!m) return null;
  const [, prefix, number] = m;
  const type = TYPES.find((t) => t.full.toLowerCase().startsWith(prefix));
  if (!type) return null;
  return `${type.full}${number}`;
}

/** "GigabitEthernet0/1" -> "Gi0/1" */
export function shortInterfaceName(full: string): string {
  const m = full.match(/^([A-Za-z]+)(.*)$/);
  if (!m) return full;
  const type = TYPES.find((t) => t.full === m[1]);
  return `${type ? type.short : m[1]}${m[2]}`;
}

export function isSvi(full: string): boolean {
  return full.startsWith('Vlan');
}

export function sviVlanId(full: string): number | null {
  const m = full.match(/^Vlan(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Sort interfaces the way IOS lists them: physical ports first (by slot/port), then loopbacks, SVIs last. */
export function compareInterfaceNames(a: string, b: string): number {
  const rank = (n: string) => (isSvi(n) ? 2 : n.startsWith('Loopback') ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const nums = (n: string) => (n.match(/\d+/g) ?? []).map(Number);
  const na = nums(a);
  const nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}
