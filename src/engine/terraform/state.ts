/**
 * State: resource addresses, the version 4 state file Terraform writes, and the three
 * backends NetLab simulates. The local backend keeps terraform.tfstate on disk where a
 * learner can cat it (and see the secrets in it); the http backend keeps it in a state
 * service with locking; the cloud block keeps it in HCP Terraform workspaces.
 */
import { getNode, normalizePath, readFile, removeNode, writeFile, makeDir, parentPath, type LinuxState } from '../linux/fs';
import type { CloudAccount, HcpOrg, LockInfo } from './cloud';
import { plain, type Val, type ValObject } from './values';
import { hexHash } from './providers';

export const TF_VERSION = '1.12.2';

export type Mode = 'managed' | 'data';

export interface StateInstance {
  index_key?: number | string;
  status?: 'tainted';
  schema_version: number;
  attributes: ValObject;
  sensitive_attributes: unknown[];
  dependencies?: string[];
  create_before_destroy?: boolean;
}

export interface StateResource {
  module?: string;
  mode: Mode;
  type: string;
  name: string;
  provider: string;
  instances: StateInstance[];
}

export interface StateFile {
  version: 4;
  terraform_version: string;
  serial: number;
  lineage: string;
  outputs: Record<string, { value: Val; type: unknown; sensitive?: boolean }>;
  resources: StateResource[];
  check_results: null;
}

/** One resource instance, flattened out of the state file for easy lookup. */
export interface Inst {
  addr: string;
  module: string;
  mode: Mode;
  type: string;
  name: string;
  key?: number | string;
  provider: string;
  attrs: ValObject;
  status?: 'tainted';
  deps: string[];
  cbd?: boolean;
  sensitive: string[];
}

export function keyText(key: number | string | undefined): string {
  if (key === undefined) return '';
  return typeof key === 'number' ? `[${key}]` : `[${JSON.stringify(key)}]`;
}

/** The resource part of an address, without module path or key: "netcloud_subnet.web" or "data.x.y". */
export function resourcePart(mode: Mode, type: string, name: string): string {
  return mode === 'data' ? `data.${type}.${name}` : `${type}.${name}`;
}

export function instanceAddr(module: string, mode: Mode, type: string, name: string, key?: number | string): string {
  return (module ? module + '.' : '') + resourcePart(mode, type, name) + keyText(key);
}

export interface ParsedAddress {
  module: string;
  mode: Mode;
  type: string;
  name: string;
  key?: number | string;
  /** The address named a module only (module.x). */
  moduleOnly?: boolean;
}

/** Parse "module.a.netcloud_subnet.web[\"x\"]". Returns null for something that is not an address. */
export function parseAddress(text: string): ParsedAddress | null {
  let rest = text.trim();
  const mods: string[] = [];
  while (rest.startsWith('module.')) {
    const m = /^module\.([A-Za-z_][A-Za-z0-9_-]*)(\[[^\]]*\])?\.?/.exec(rest);
    if (!m) return null;
    mods.push(`module.${m[1]}`);
    rest = rest.slice(m[0].length);
  }
  if (rest === '') return mods.length ? { module: mods.join('.'), mode: 'managed', type: '', name: '', moduleOnly: true } : null;
  let mode: Mode = 'managed';
  if (rest.startsWith('data.')) {
    mode = 'data';
    rest = rest.slice(5);
  }
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)(\[(\d+|"(?:[^"\\]|\\.)*")\])?$/.exec(rest);
  if (!m) return null;
  let key: number | string | undefined;
  if (m[4] !== undefined) key = m[4].startsWith('"') ? JSON.parse(m[4]) : Number(m[4]);
  return { module: mods.join('.'), mode, type: m[1], name: m[2], key };
}

export function providerAddr(source: string): string {
  if (source === 'terraform.io/builtin/terraform') return 'provider["terraform.io/builtin/terraform"]';
  return `provider["registry.terraform.io/${source}"]`;
}

export function emptyState(lineageSeed: string): StateFile {
  const h = hexHash(lineageSeed, 32);
  return { version: 4, terraform_version: TF_VERSION, serial: 0, lineage: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`, outputs: {}, resources: [], check_results: null };
}

export function flatten(state: StateFile | null): Map<string, Inst> {
  const out = new Map<string, Inst>();
  for (const r of state?.resources ?? []) {
    for (const i of r.instances) {
      const addr = instanceAddr(r.module ?? '', r.mode, r.type, r.name, i.index_key);
      const sensitive = (i.sensitive_attributes ?? []).map((p) => (Array.isArray(p) && p[0] && typeof p[0] === 'object' ? String((p[0] as { value?: string }).value ?? '') : '')).filter(Boolean);
      out.set(addr, { addr, module: r.module ?? '', mode: r.mode, type: r.type, name: r.name, key: i.index_key, provider: r.provider, attrs: i.attributes, status: i.status, deps: i.dependencies ?? [], cbd: i.create_before_destroy, sensitive });
    }
  }
  return out;
}

function jsonType(v: Val): unknown {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return ['tuple', v.map(jsonType)];
  if (v && typeof v === 'object') return ['object', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonType(x as Val)]))];
  return 'dynamic';
}

export function buildState(base: StateFile, insts: Map<string, Inst>, outputs: Record<string, { value: Val; sensitive: boolean }>): StateFile {
  const groups = new Map<string, StateResource>();
  const sorted = [...insts.values()].sort((a, b) => (a.module + a.mode + a.type + a.name).localeCompare(b.module + b.mode + b.type + b.name) || String(a.key ?? '').localeCompare(String(b.key ?? ''), undefined, { numeric: true }));
  for (const i of sorted) {
    const gk = `${i.module}|${i.mode}|${i.type}|${i.name}`;
    let g = groups.get(gk);
    if (!g) {
      g = { ...(i.module ? { module: i.module } : {}), mode: i.mode, type: i.type, name: i.name, provider: i.provider, instances: [] };
      groups.set(gk, g);
    }
    const inst: StateInstance = { schema_version: 0, attributes: plain(i.attrs) as ValObject, sensitive_attributes: i.sensitive.map((s) => [{ type: 'get_attr', value: s }]) };
    if (i.key !== undefined) inst.index_key = i.key;
    if (i.status) inst.status = i.status;
    if (i.deps.length) inst.dependencies = [...i.deps].sort();
    if (i.cbd) inst.create_before_destroy = true;
    g.instances.push(inst);
  }
  const outs: StateFile['outputs'] = {};
  for (const [k, o] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) outs[k] = { value: plain(o.value), type: jsonType(o.value), ...(o.sensitive ? { sensitive: true } : {}) };
  return { ...base, terraform_version: TF_VERSION, outputs: outs, resources: [...groups.values()] };
}

export function stateJson(s: StateFile): string {
  return JSON.stringify(s, null, 2) + '\n';
}

export function parseState(text: string, where: string): StateFile | { error: string } {
  if (!text.trim()) return { error: '' };
  try {
    const s = JSON.parse(text);
    if (typeof s !== 'object' || s === null || typeof s.version !== 'number') return { error: `Failed to load state: ${where}: unsupported state file format: This state file does not have a "version" property.` };
    if (s.version !== 4) return { error: `Failed to load state: ${where}: unsupported state format version: expected "4"` };
    return { outputs: {}, resources: [], check_results: null, ...s };
  } catch (e) {
    return { error: `Failed to load state: ${where}: Unsupported state file format: The state file could not be parsed as JSON: syntax error.` };
  }
}

// ---------------------------------------------------------------------------
// backends

export interface BackendSettings {
  type: 'local' | 'http' | 'cloud';
  config: Record<string, Val>;
}

export interface Backend {
  type: BackendSettings['type'];
  supportsWorkspaces: boolean;
  /** Where state lives, for messages. */
  location(ws: string): string;
  read(ws: string): StateFile | null | { error: string };
  write(ws: string, state: StateFile): string | undefined;
  lock(ws: string, operation: string, who: string): { lock?: LockInfo; held?: LockInfo; error?: string };
  unlock(ws: string, id: string): 'ok' | 'mismatch' | 'none' | 'unsupported';
  workspaces(): string[];
  createWorkspace(name: string): string | undefined;
  deleteWorkspace(name: string): string | undefined;
}

export interface BackendEnv {
  lx: LinuxState;
  cloud?: CloudAccount;
  cwd: string;
  env: Record<string, string>;
}

function lockId(seed: string): string {
  const h = hexHash(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nowText(lx: LinuxState): string {
  const seconds = lx.clock;
  return `2026-09-14 ${String(9 + Math.floor(seconds / 3600) % 12).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String((seconds * 7919) % 1000000).padStart(6, '0')} +0000 UTC`;
}

function asRoot<T>(_lx: LinuxState, fn: () => T): T {
  // State files belong to whoever runs terraform, but the simulation writes them directly.
  return fn();
}

export function localBackend(benv: BackendEnv, config: Record<string, Val>): Backend {
  const { lx, cwd } = benv;
  const base = String(config.path ?? 'terraform.tfstate');
  const wsDir = String(config.workspace_dir ?? 'terraform.tfstate.d');
  const pathFor = (ws: string) => (ws === 'default' ? base : `${wsDir}/${ws}/terraform.tfstate`);
  const abs = (p: string) => normalizePath(cwd, p, `/home/${lx.user}`);
  return {
    type: 'local',
    supportsWorkspaces: true,
    location: pathFor,
    read(ws) {
      const r = readFile(lx, abs(pathFor(ws)));
      if ('error' in r) {
        if (/Permission denied/.test(r.error)) return { error: `Failed to load state: open ${pathFor(ws)}: permission denied` };
        return null;
      }
      const s = parseState(r.content, pathFor(ws));
      if ('error' in s) return s.error ? s : null;
      return s;
    },
    write(ws, state) {
      return asRoot(lx, () => {
        const p = abs(pathFor(ws));
        const dir = parentPath(p);
        if (!getNode(lx, dir)) {
          const e = makeDir(lx, dir, true);
          if (e) return e.error;
        }
        const old = readFile(lx, p);
        if (!('error' in old) && old.content.trim()) writeFile(lx, p + '.backup', old.content);
        const e = writeFile(lx, p, stateJson(state), false, 'terraform');
        return e ? `Failed to save state: ${e.error}` : undefined;
      });
    },
    lock: () => ({}),
    unlock: () => 'unsupported',
    workspaces() {
      const names = Object.keys(lx.fs)
        .map((k) => new RegExp(`^${abs(wsDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)$`).exec(k)?.[1])
        .filter((x): x is string => Boolean(x) && lx.fs[`${abs(wsDir)}/${x}`]?.type === 'dir');
      return ['default', ...names.sort()];
    },
    createWorkspace(name) {
      const e = makeDir(lx, `${abs(wsDir)}/${name}`, true);
      return e?.error;
    },
    deleteWorkspace(name) {
      const e = removeNode(lx, `${abs(wsDir)}/${name}`, true);
      return e?.error;
    },
  };
}

export function httpBackend(benv: BackendEnv, config: Record<string, Val>): Backend | { error: string } {
  const address = String(config.address ?? '');
  const cloud = benv.cloud;
  if (!address) return { error: 'address is required for the http backend' };
  const known = cloud && (address in cloud.stateService || /^https:\/\/state\.netlab\.cloud\//.test(address));
  const store = () => {
    if (!cloud) throw new Error('no cloud');
    return (cloud.stateService[address] ??= {});
  };
  const unreachable = `Get "${address}": dial tcp: lookup ${address.replace(/^https?:\/\//, '').split('/')[0]}: no such host`;
  const canLock = Boolean(config.lock_address);
  return {
    type: 'http',
    supportsWorkspaces: false,
    location: () => address,
    read() {
      if (!known) return { error: `Failed to load state: ${unreachable}` };
      const text = store().state;
      if (!text) return null;
      const s = parseState(text, address);
      return 'error' in s ? (s.error ? s : null) : s;
    },
    write(_ws, state) {
      if (!known) return `Failed to save state: ${unreachable}`;
      store().state = stateJson(state);
      return undefined;
    },
    lock(_ws, operation, who) {
      if (!known) return { error: unreachable };
      if (!canLock) return {};
      const s = store();
      if (s.lock) return { held: s.lock };
      s.lock = { ID: lockId(who + operation + benv.lx.clock), Operation: operation, Info: '', Who: who, Version: TF_VERSION, Created: nowText(benv.lx), Path: '' };
      return { lock: s.lock };
    },
    unlock(_ws, id) {
      if (!known || !canLock) return 'unsupported';
      const s = store();
      if (!s.lock) return 'none';
      if (s.lock.ID !== id) return 'mismatch';
      s.lock = undefined;
      return 'ok';
    },
    workspaces: () => ['default'],
    createWorkspace: () => 'workspaces not supported',
    deleteWorkspace: () => 'workspaces not supported',
  };
}

export function hcpToken(benv: BackendEnv, hostname: string): string | undefined {
  const envName = `TF_TOKEN_${hostname.replace(/\./g, '_').replace(/-/g, '__')}`;
  if (benv.env[envName]) return benv.env[envName];
  const r = readFile(benv.lx, `/home/${benv.lx.user}/.terraform.d/credentials.tfrc.json`);
  if ('error' in r) return undefined;
  try {
    return JSON.parse(r.content).credentials?.[hostname]?.token;
  } catch {
    return undefined;
  }
}

export interface CloudSettings {
  organization: string;
  hostname: string;
  name?: string;
  tags?: string[];
  project?: string;
}

export function cloudSettings(config: Record<string, Val>, env: Record<string, string>): CloudSettings {
  const ws = (config.workspaces ?? {}) as Record<string, Val>;
  return {
    organization: String(config.organization ?? env.TF_CLOUD_ORGANIZATION ?? ''),
    hostname: String(config.hostname ?? env.TF_CLOUD_HOSTNAME ?? 'app.terraform.io'),
    name: (ws.name as string | undefined) ?? env.TF_WORKSPACE,
    tags: (ws.tags as string[] | undefined) ?? undefined,
    project: (ws.project as string | undefined) ?? env.TF_CLOUD_PROJECT,
  };
}

export function hcpOrg(benv: BackendEnv, s: CloudSettings): HcpOrg | { error: string } {
  const org = benv.cloud?.hcp;
  if (!s.organization) return { error: 'Invalid or missing required argument: "organization" must be set in the cloud configuration or as an environment variable: TF_CLOUD_ORGANIZATION.' };
  const token = hcpToken(benv, s.hostname);
  if (!token) {
    return { error: `Required token could not be found\n\nRun the following command to generate a token for ${s.hostname}:\n    terraform login` };
  }
  if (!org || org.hostname !== s.hostname) return { error: `Failed to request discovery document: Get "https://${s.hostname}/.well-known/terraform.json": dial tcp: lookup ${s.hostname}: no such host` };
  if (token !== org.token) return { error: 'Failed to read organization: unauthorized\n\nThe token was rejected. Check that it has not expired, or run terraform login again.' };
  if (org.organization !== s.organization) return { error: `Failed to read organization "${s.organization}" at host ${s.hostname}\n\nThe "remote" backend encountered an unexpected error while reading the organization settings: resource not found` };
  return org;
}

export function cloudBackend(benv: BackendEnv, config: Record<string, Val>): Backend | { error: string } {
  const s = cloudSettings(config, benv.env);
  const org = hcpOrg(benv, s);
  if ('error' in org) return org;
  const matches = () => Object.values(org.workspaces).filter((w) => (s.name ? w.name === s.name : (s.tags ?? []).every((t) => w.tags.includes(t))) && (!s.project || w.project === s.project));
  const wsName = (ws: string) => (s.name ? s.name : ws);
  return {
    type: 'cloud',
    supportsWorkspaces: !s.name,
    location: (ws) => `${s.organization}/${wsName(ws)}`,
    read(ws) {
      const w = org.workspaces[wsName(ws)];
      if (!w?.state) return null;
      const st = parseState(w.state, 'remote');
      return 'error' in st ? (st.error ? st : null) : st;
    },
    write(ws, state) {
      const name = wsName(ws);
      org.workspaces[name] ??= { name, project: s.project ?? 'Default Project', tags: s.tags ?? [], vars: {}, runs: 0 };
      org.workspaces[name].state = stateJson(state);
      return undefined;
    },
    lock(ws, operation, who) {
      const w = org.workspaces[wsName(ws)];
      if (w?.locked) return { held: { ID: `ws-${hexHash(w.name, 16)}`, Operation: operation, Info: '', Who: 'HCP Terraform', Version: TF_VERSION, Created: nowText(benv.lx), Path: '' } };
      void who;
      return {};
    },
    unlock: () => 'unsupported',
    workspaces: () => (s.name ? [s.name] : matches().map((w) => w.name).sort()),
    createWorkspace(name) {
      if (s.name) return 'workspaces not supported';
      if (org.workspaces[name]) return `Workspace "${name}" already exists`;
      org.workspaces[name] = { name, project: s.project ?? 'Default Project', tags: s.tags ?? [], vars: {}, runs: 0 };
      return undefined;
    },
    deleteWorkspace(name) {
      if (!org.workspaces[name]) return `Workspace "${name}" doesn't exist.`;
      delete org.workspaces[name];
      return undefined;
    },
  };
}
