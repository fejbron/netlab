/**
 * Grading checks for the Ansible labs. They look at what the learner actually produced:
 * the runs ansible recorded, the inventory those runs would use, the files on the control
 * node, and the collections and roles that are installed. The state of a managed node is
 * graded with the ordinary Linux checks (`{ type: 'file', device: 'web1' }` and friends),
 * because a playbook that claims to have installed nginx has to have installed nginx.
 *
 * The strongest check is an-idempotent: it runs the playbook again, on a copy of the
 * network, and asks whether anything would change. A playbook that only works once does
 * not pass.
 */
import type { NetworkState } from '../network';
import { getNode, normalizePath, readFile, type LinuxState } from '../linux/fs';
import { runAnsible, type AnsibleRun } from './cli';
import { inventoryVars, loadInventory, selectHosts, InventoryError, type Inventory } from './inventory';
import { loadConfig } from './run';
import { isVaulted, vaultDecrypt, VaultError } from './vault';
import { parseYaml, YamlError } from './yaml';

type Scalar = string | number | boolean | null;

export type AnCheck =
  /** An ansible command ran. `playbook` matches the file (or "ad-hoc:<module>" for ad-hoc runs). */
  | { type: 'an-ran'; playbook?: string; module?: string; dir?: string; code?: number; check?: boolean; limit?: string; tags?: string[] }
  /** The recap of the most recent matching run, for one host. */
  | { type: 'an-stats'; host: string; playbook?: string; ok?: number; changed?: number; failed?: number; unreachable?: number; skipped?: number; rescued?: number }
  /** A task with this name reached this status on a host. */
  | { type: 'an-task'; task: string; host?: string; status?: 'ok' | 'changed' | 'failed' | 'skipped' | 'unreachable'; playbook?: string }
  /** Running the playbook again would change nothing: the play is idempotent, and it works. */
  | { type: 'an-idempotent'; playbook: string; dir?: string; limit?: string; hosts?: string[] }
  /** The inventory in effect puts a host in a group, or gives it a variable. */
  | { type: 'an-inventory'; host: string; group?: string; vars?: Record<string, Scalar>; absent?: boolean }
  /** A file on the control node is vault-encrypted (and optionally opens with this password). */
  | { type: 'an-vaulted'; path: string; password?: string; absent?: boolean }
  /** A collection is installed where Ansible would look for it. */
  | { type: 'an-collection'; name: string }
  /** A role directory exists on the control node, with the parts a role needs. */
  | { type: 'an-role'; name: string; dir?: string; files?: string[] }
  /** A regex over a file on the control node; `absent` for text that must be gone. */
  | { type: 'an-source'; path: string; pattern: string; absent?: boolean; label: string }
  /** A file on the control node is valid YAML (the cheap half of --syntax-check). */
  | { type: 'an-yaml'; path: string };

export const AN_CHECKS = new Set(['an-ran', 'an-stats', 'an-task', 'an-idempotent', 'an-inventory', 'an-vaulted', 'an-collection', 'an-role', 'an-source', 'an-yaml']);

export const DEFAULT_DIR = '/home/student/ansible';

function dirOf(check: { dir?: string }): string {
  return check.dir ?? DEFAULT_DIR;
}

function short(path: string): string {
  return path.replace('/home/student', '~');
}

export function describeAn(check: AnCheck, on: string): string {
  switch (check.type) {
    case 'an-ran': {
      const what = check.module ? `ansible with -m ${check.module}` : `ansible-playbook ${check.playbook ?? ''}`.trim();
      const how = [check.check ? 'in check mode' : '', check.limit ? `limited to ${check.limit}` : '', check.tags?.length ? `with --tags ${check.tags.join(',')}` : ''].filter(Boolean).join(' ');
      const outcome = check.code === undefined ? '' : check.code === 0 ? ' successfully' : ' and saw it fail';
      return `Ran ${what}${how ? ' ' + how : ''}${outcome}${on}`;
    }
    case 'an-stats': {
      const bits = (['ok', 'changed', 'failed', 'unreachable', 'skipped', 'rescued'] as const).filter((k) => check[k] !== undefined).map((k) => `${k}=${check[k]}`);
      return `The recap for ${check.host} shows ${bits.join(' ')}`;
    }
    case 'an-task':
      return `Task "${check.task}" reported ${check.status ?? 'a result'}${check.host ? ` on ${check.host}` : ''}`;
    case 'an-idempotent':
      return `Running ${check.playbook} again changes nothing`;
    case 'an-inventory':
      if (check.absent) return `${check.host} is not in the inventory${check.group ? ` group ${check.group}` : ''}`;
      if (check.vars) return `${check.host} has ${Object.entries(check.vars).map(([k, v]) => `${k}=${v}`).join(', ')} in the inventory`;
      return `${check.host} is in the inventory${check.group ? ` group ${check.group}` : ''}`;
    case 'an-vaulted':
      return check.absent ? `${short(check.path)} is not encrypted` : `${short(check.path)} is vault-encrypted${check.password ? ' and opens with the lab password' : ''}`;
    case 'an-collection':
      return `The ${check.name} collection is installed`;
    case 'an-role':
      return `Role ${check.name} exists${check.files?.length ? ` with ${check.files.join(', ')}` : ''}`;
    case 'an-source':
      return check.label;
    case 'an-yaml':
      return `${short(check.path)} is valid YAML`;
  }
}

function controlFile(lx: LinuxState, dir: string, path: string): string | null {
  const r = readFile({ ...lx, user: 'root' }, normalizePath(dir, path, '/home/student'));
  return 'error' in r ? null : r.content;
}

/** The inventory an ansible command run in `dir` would use, group_vars and host_vars included. */
export function gradingInventory(lx: LinuxState, dir: string = DEFAULT_DIR): Inventory | null {
  const config = loadConfig(lx, dir, lx.env);
  const path = lx.env.ANSIBLE_INVENTORY ?? config.inventory ?? '/etc/ansible/hosts';
  try {
    return loadInventory({ ...lx, user: 'root' }, path, dir);
  } catch (e) {
    if (e instanceof InventoryError) return null;
    throw e;
  }
}

function runsFor(lx: LinuxState, playbook?: string, dir?: string): AnsibleRun[] {
  return (lx.ansibleRuns ?? []).filter((r) => (playbook === undefined || r.playbook === playbook) && (dir === undefined || r.dir === dir));
}

/**
 * Run a playbook again on a copy of the network and report whether anything changed.
 * Nothing the learner can see is touched: the copy is thrown away.
 */
export function isIdempotent(net: NetworkState, node: string, check: { playbook: string; dir?: string; limit?: string; hosts?: string[] }): boolean {
  const copy = structuredClone(net);
  const lx = copy.hosts[node]?.linux;
  if (!lx) return false;
  const dir = dirOf(check);
  if (!getNode(lx, normalizePath(dir, check.playbook, '/home/student'))) return false;
  const args = [check.playbook, ...(check.limit ? ['--limit', check.limit] : [])];
  const r = runAnsible(lx, copy, node, 'ansible-playbook', args, { ...lx.env }, dir, []);
  if (r.pending || r.code !== 0) return false;
  const run = (lx.ansibleRuns ?? [])[(lx.ansibleRuns ?? []).length - 1];
  if (!run) return false;
  const hosts = check.hosts ?? Object.keys(run.stats);
  if (!hosts.length) return false;
  return hosts.every((h) => run.stats[h] && run.stats[h].changed === 0 && run.stats[h].failed === 0 && run.stats[h].unreachable === 0);
}

export function evaluateAn(check: AnCheck, lx: LinuxState, net: NetworkState, node: string): boolean {
  void node;
  switch (check.type) {
    case 'an-ran': {
      return runsFor(lx, undefined, check.dir ?? undefined).some((r) => {
        // An ad-hoc run is recorded as "ad-hoc:<module as typed>", which may be qualified.
        if (check.module !== undefined && (!r.playbook.startsWith('ad-hoc:') || r.playbook.slice('ad-hoc:'.length).split('.').pop() !== check.module)) return false;
        if (check.playbook !== undefined && r.playbook !== check.playbook) return false;
        if (check.code !== undefined && r.code !== check.code) return false;
        if (check.check !== undefined && r.check !== check.check) return false;
        if (check.limit !== undefined && r.limit !== check.limit) return false;
        if (check.tags && !check.tags.every((t) => r.tags.includes(t))) return false;
        return true;
      });
    }
    case 'an-stats': {
      const runs = runsFor(lx, check.playbook, undefined).filter((r) => r.stats[check.host]);
      const run = runs[runs.length - 1];
      if (!run) return false;
      const s = run.stats[check.host];
      return (['ok', 'changed', 'failed', 'unreachable', 'skipped', 'rescued'] as const).every((k) => check[k] === undefined || s[k] === check[k]);
    }
    case 'an-task':
      return runsFor(lx, check.playbook, undefined).some((r) =>
        r.tasks.some((t) => t.task === check.task && (check.host === undefined || t.host === check.host) && (check.status === undefined || t.status === check.status)),
      );
    case 'an-idempotent':
      return isIdempotent(net, node, check);
    case 'an-inventory': {
      const inv = gradingInventory(lx);
      if (!inv) return Boolean(check.absent);
      const inGroup = check.group ? selectHosts(inv, check.group).includes(check.host) : Boolean(inv.hosts[check.host]);
      if (check.absent) return !inGroup;
      if (!inGroup) return false;
      if (!check.vars) return true;
      const vars = inventoryVars(inv, check.host);
      return Object.entries(check.vars).every(([k, v]) => String(vars[k] ?? '') === String(v));
    }
    case 'an-vaulted': {
      const text = controlFile(lx, DEFAULT_DIR, check.path);
      if (text === null) return false;
      if (check.absent) return !isVaulted(text);
      if (!isVaulted(text)) return false;
      if (!check.password) return true;
      try {
        vaultDecrypt(text, [check.password]);
        return true;
      } catch (e) {
        if (e instanceof VaultError) return false;
        throw e;
      }
    }
    case 'an-collection': {
      const [ns, name] = check.name.split('.');
      const roots = [`/home/${lx.user}/.ansible/collections/ansible_collections`, '/usr/share/ansible/collections/ansible_collections', `${DEFAULT_DIR}/collections/ansible_collections`];
      return roots.some((root) => getNode(lx, `${root}/${ns}/${name}`));
    }
    case 'an-role': {
      const base = `${dirOf(check)}/roles/${check.name}`;
      if (!getNode(lx, base)) return false;
      return (check.files ?? ['tasks/main.yml']).every((f) => getNode(lx, `${base}/${f}`));
    }
    case 'an-source': {
      const text = controlFile(lx, DEFAULT_DIR, check.path);
      if (text === null) return Boolean(check.absent);
      const found = new RegExp(check.pattern, 'm').test(text);
      return check.absent ? !found : found;
    }
    case 'an-yaml': {
      const text = controlFile(lx, DEFAULT_DIR, check.path);
      if (text === null) return false;
      try {
        parseYaml(text);
        return true;
      } catch (e) {
        if (e instanceof YamlError) return false;
        throw e;
      }
    }
  }
}
