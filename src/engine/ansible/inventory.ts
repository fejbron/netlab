/**
 * Inventories: the INI and YAML formats, host and group variables (inline, in
 * group_vars and host_vars directories), the implicit groups (all, ungrouped), and the
 * host patterns a play or --limit selects with.
 */
import { getNode, listDir, normalizePath, readFile, type LinuxState } from '../linux/fs';
import type { JValue } from './jinja';
import { parseYaml, YamlError, type YamlValue } from './yaml';

export interface InventoryGroup {
  name: string;
  hosts: string[];
  children: string[];
  vars: Record<string, JValue>;
}

export interface Inventory {
  hosts: Record<string, { name: string; vars: Record<string, JValue> }>;
  groups: Record<string, InventoryGroup>;
  /** Where it came from, for messages and for finding group_vars. */
  source: string;
}

export class InventoryError extends Error {}

function group(inv: Inventory, name: string): InventoryGroup {
  return (inv.groups[name] ??= { name, hosts: [], children: [], vars: {} });
}

function addHost(inv: Inventory, name: string, groupName: string, vars: Record<string, JValue> = {}) {
  const host = (inv.hosts[name] ??= { name, vars: {} });
  Object.assign(host.vars, vars);
  const g = group(inv, groupName);
  if (!g.hosts.includes(name)) g.hosts.push(name);
}

/** "web1 ansible_host=10.0.0.5 http_port=8080" */
function parseHostLine(line: string): { name: string; vars: Record<string, JValue> } {
  const parts = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const name = parts.shift() ?? '';
  const vars: Record<string, JValue> = {};
  for (const p of parts) {
    const at = p.indexOf('=');
    if (at <= 0) continue;
    const key = p.slice(0, at);
    const raw = p.slice(at + 1).replace(/^['"]|['"]$/g, '');
    vars[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' || raw === 'false' ? raw === 'true' : raw;
  }
  return { name, vars };
}

export function parseIniInventory(text: string, source: string): Inventory {
  const inv: Inventory = { hosts: {}, groups: {}, source };
  group(inv, 'all');
  let current = 'ungrouped';
  let section: 'hosts' | 'vars' | 'children' = 'hosts';
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) return;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const [name, kind] = header[1].split(':');
      current = name.trim();
      section = kind === 'vars' ? 'vars' : kind === 'children' ? 'children' : 'hosts';
      group(inv, current);
      return;
    }
    if (section === 'vars') {
      const at = line.indexOf('=');
      if (at < 0) throw new InventoryError(`${source}:${idx + 1}: expected key=value in [${current}:vars]`);
      const raw2 = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
      group(inv, current).vars[line.slice(0, at).trim()] = /^-?\d+$/.test(raw2) ? Number(raw2) : raw2 === 'true' || raw2 === 'false' ? raw2 === 'true' : raw2;
      return;
    }
    if (section === 'children') {
      const child = line.split(/\s+/)[0];
      group(inv, current).children.push(child);
      group(inv, child);
      return;
    }
    const { name, vars } = parseHostLine(line);
    if (name) addHost(inv, name, current, vars);
  });
  return inv;
}

export function parseYamlInventory(doc: YamlValue, source: string): Inventory {
  const inv: Inventory = { hosts: {}, groups: {}, source };
  group(inv, 'all');
  const walk = (name: string, body: YamlValue) => {
    const g = group(inv, name);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    const b = body as Record<string, YamlValue>;
    for (const [hostName, hostVars] of Object.entries((b.hosts as Record<string, YamlValue>) ?? {})) {
      addHost(inv, hostName, name, (hostVars as Record<string, JValue>) ?? {});
    }
    Object.assign(g.vars, (b.vars as Record<string, JValue>) ?? {});
    for (const [childName, childBody] of Object.entries((b.children as Record<string, YamlValue>) ?? {})) {
      g.children.push(childName);
      walk(childName, childBody);
    }
  };
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [name, body] of Object.entries(doc as Record<string, YamlValue>)) walk(name, body);
  }
  return inv;
}

/** Load an inventory file (or a directory of them) plus its group_vars and host_vars. */
export function loadInventory(lx: LinuxState, path: string, cwd: string): Inventory {
  const abs = normalizePath(cwd, path, `/home/${lx.user}`);
  const node = getNode(lx, abs);
  if (!node) throw new InventoryError(`Unable to parse ${path} as an inventory source: the path does not exist`);
  const files = node.type === 'dir' ? listDir(lx, abs).filter((n) => !n.startsWith('.') && n !== 'group_vars' && n !== 'host_vars').map((n) => `${abs}/${n}`) : [abs];
  const merged: Inventory = { hosts: {}, groups: {}, source: abs };
  group(merged, 'all');
  for (const file of files) {
    const r = readFile(lx, file);
    if ('error' in r) continue;
    let inv: Inventory;
    if (/\.(ya?ml)$/.test(file) || /^\s*(all|ungrouped):/m.test(r.content)) {
      let doc: YamlValue;
      try {
        doc = parseYaml(r.content);
      } catch (e) {
        if (e instanceof YamlError) throw new InventoryError(`Unable to parse ${path} as an inventory source: ${e.message} at line ${e.line}`);
        throw e;
      }
      inv = parseYamlInventory(doc, file);
    } else inv = parseIniInventory(r.content, file);
    for (const [name, h] of Object.entries(inv.hosts)) {
      merged.hosts[name] ??= { name, vars: {} };
      Object.assign(merged.hosts[name].vars, h.vars);
    }
    for (const [name, g] of Object.entries(inv.groups)) {
      const target = group(merged, name);
      target.hosts = [...new Set([...target.hosts, ...g.hosts])];
      target.children = [...new Set([...target.children, ...g.children])];
      Object.assign(target.vars, g.vars);
    }
  }
  // group_vars and host_vars live beside the inventory.
  const dir = node.type === 'dir' ? abs : abs.slice(0, abs.lastIndexOf('/')) || '/';
  applyVarDirs(lx, dir, merged);
  return merged;
}

function readVarsFile(lx: LinuxState, path: string): Record<string, JValue> {
  const r = readFile(lx, path);
  if ('error' in r) return {};
  try {
    const doc = parseYaml(r.content);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, JValue>) : {};
  } catch {
    return {};
  }
}

/** group_vars/<name>[.yml] and host_vars/<name>[.yml], as files or directories. */
export function applyVarDirs(lx: LinuxState, dir: string, inv: Inventory) {
  const collect = (base: string, name: string): Record<string, JValue> => {
    const out: Record<string, JValue> = {};
    for (const candidate of [`${base}/${name}`, `${base}/${name}.yml`, `${base}/${name}.yaml`]) {
      const node = getNode(lx, candidate);
      if (!node) continue;
      if (node.type === 'dir') for (const f of listDir(lx, candidate)) Object.assign(out, readVarsFile(lx, `${candidate}/${f}`));
      else Object.assign(out, readVarsFile(lx, candidate));
    }
    return out;
  };
  for (const name of Object.keys(inv.groups)) Object.assign(group(inv, name).vars, collect(`${dir}/group_vars`, name));
  for (const name of Object.keys(inv.hosts)) Object.assign(inv.hosts[name].vars, collect(`${dir}/host_vars`, name));
}

/** Every group a host belongs to, parents included, with "all" last. */
export function groupsOf(inv: Inventory, host: string): string[] {
  const direct = Object.values(inv.groups).filter((g) => g.hosts.includes(host)).map((g) => g.name);
  const out = new Set<string>(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of Object.values(inv.groups)) {
      if (g.children.some((c) => out.has(c)) && !out.has(g.name)) {
        out.add(g.name);
        grew = true;
      }
    }
  }
  out.delete('all');
  return [...out, 'all'];
}

/** Hosts in a group, following children. */
export function hostsIn(inv: Inventory, name: string): string[] {
  if (name === 'all' || name === '*') return Object.keys(inv.hosts);
  const g = inv.groups[name];
  if (!g) return [];
  const out = new Set(g.hosts);
  for (const child of g.children) for (const h of hostsIn(inv, child)) out.add(h);
  return [...out];
}

/**
 * Resolve a host pattern: names, groups, wildcards, several separated by commas or
 * colons, "&" to intersect and "!" to exclude.
 */
export function selectHosts(inv: Inventory, pattern: string): string[] {
  const all = Object.keys(inv.hosts);
  const terms = pattern.split(/[,:]/).map((t) => t.trim()).filter(Boolean);
  let selected: string[] = [];
  for (const term of terms) {
    const mode = term.startsWith('!') ? 'exclude' : term.startsWith('&') ? 'intersect' : 'add';
    const name = term.replace(/^[!&]/, '');
    const matched = new Set<string>();
    if (name === 'all' || name === '*') all.forEach((h) => matched.add(h));
    else if (inv.groups[name]) hostsIn(inv, name).forEach((h) => matched.add(h));
    else if (inv.hosts[name]) matched.add(name);
    else if (/[*?]/.test(name)) {
      const re = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      all.filter((h) => re.test(h)).forEach((h) => matched.add(h));
      Object.keys(inv.groups).filter((g) => re.test(g)).forEach((g) => hostsIn(inv, g).forEach((h) => matched.add(h)));
    }
    if (mode === 'add') selected = [...new Set([...selected, ...matched])];
    else if (mode === 'exclude') selected = selected.filter((h) => !matched.has(h));
    else selected = selected.filter((h) => matched.has(h));
  }
  // Keep inventory order, which is the order Ansible reports hosts in.
  return all.filter((h) => selected.includes(h));
}

/** Inventory variables for a host: group vars (parents first), then the host's own. */
export function inventoryVars(inv: Inventory, host: string): Record<string, JValue> {
  const out: Record<string, JValue> = {};
  const groups = groupsOf(inv, host).reverse();
  for (const g of groups) Object.assign(out, inv.groups[g]?.vars ?? {});
  Object.assign(out, inv.hosts[host]?.vars ?? {});
  return out;
}

/** The shape `ansible-inventory --list` prints. */
export function inventoryJson(inv: Inventory): Record<string, JValue> {
  const out: Record<string, JValue> = { _meta: { hostvars: Object.fromEntries(Object.entries(inv.hosts).map(([n, h]) => [n, h.vars])) } };
  for (const g of Object.values(inv.groups)) {
    if (g.name === 'all') {
      out.all = { children: [...new Set([...g.children, ...Object.keys(inv.groups).filter((n) => n !== 'all' && !Object.values(inv.groups).some((x) => x.children.includes(n)))])].sort() };
      continue;
    }
    const entry: Record<string, JValue> = {};
    if (g.hosts.length) entry.hosts = [...g.hosts].sort();
    if (g.children.length) entry.children = [...g.children].sort();
    if (Object.keys(g.vars).length) entry.vars = g.vars;
    out[g.name] = entry;
  }
  return out;
}
