/**
 * Grading checks for the Terraform labs. They look at what a learner actually produced:
 * the state Terraform recorded (through whichever backend is configured), the objects in
 * the cloud account, the lock file, the configuration on disk, and the terraform commands
 * that ran. The strongest check, tf-converged, runs a plan and asks whether configuration
 * and infrastructure now agree.
 */
import { getNode, listDir, readFile, type LinuxState } from '../linux/fs';
import type { CloudKind } from './cloud';
import type { Source } from './config';
import { DiagError, parseHcl } from './hcl';
import { formatHcl } from './fmt';
import { currentWorkspace, readBackendRecord, readLock, readModules } from './project';
import { hasChanges, plan, type RunEnv } from './run';
import { cloudBackend, flatten, httpBackend, localBackend, type Backend, type StateFile } from './state';
import { canonical, plain, type Val } from './values';

type Scalar = string | number | boolean | null;

export type TfCheck =
  /** A terraform command ran in the directory. `argsPattern` is a regex over the joined arguments. */
  | { type: 'tf-ran'; command: string; dir?: string; code?: number; argsPattern?: string; add?: number; change?: number; destroy?: number; imported?: number; changes?: boolean; remote?: boolean }
  /** A resource instance in state (for the current or named workspace), optionally with attribute values. */
  | { type: 'tf-resource'; address: string; dir?: string; workspace?: string; exists?: boolean; attrs?: Record<string, Scalar | Scalar[]>; tainted?: boolean }
  /** How many managed resource instances state holds. */
  | { type: 'tf-state-count'; dir?: string; workspace?: string; count: number }
  /** A root output in state. */
  | { type: 'tf-output'; name: string; dir?: string; workspace?: string; value?: Scalar; sensitive?: boolean; exists?: boolean }
  /** The dependency lock file selects this provider version. */
  | { type: 'tf-lock'; provider: string; dir?: string; version?: string; constraints?: string }
  /** init installed a module; `version` for registry modules. */
  | { type: 'tf-module'; key: string; dir?: string; version?: string }
  /** The backend init recorded. */
  | { type: 'tf-backend'; backend: 'local' | 'http' | 'cloud'; dir?: string }
  | { type: 'tf-workspace'; name: string; dir?: string; exists?: boolean; current?: boolean }
  /** Every .tf file parses (a cheap stand-in for validate that needs no init). */
  | { type: 'tf-parses'; dir?: string }
  /** Every .tf file is already in terraform fmt style. */
  | { type: 'tf-formatted'; dir?: string }
  /** A plan now would change nothing: configuration and infrastructure agree. */
  | { type: 'tf-converged'; dir?: string }
  /** A regex over the .tf files in a directory (joined); `absent` for text that must be gone. */
  | { type: 'tf-config'; pattern: string; dir?: string; absent?: boolean; label: string }
  /** Objects in the NetLab Cloud account. */
  | { type: 'cloud-object'; kind: CloudKind; name?: string; id?: string; region?: string; count?: number; attrs?: Record<string, Scalar>; exists?: boolean; ingressRules?: number }
  /** The http state service holds a lock at this address, or not. */
  | { type: 'tf-remote-lock'; address: string; locked: boolean }
  /** An HCP Terraform workspace, with state holding `resources` managed instances. */
  | { type: 'hcp-workspace'; name: string; exists?: boolean; resources?: number; project?: string; tag?: string };

export const TF_CHECKS = new Set(['tf-ran', 'tf-resource', 'tf-state-count', 'tf-output', 'tf-lock', 'tf-module', 'tf-backend', 'tf-workspace', 'tf-parses', 'tf-formatted', 'tf-converged', 'tf-config', 'cloud-object', 'tf-remote-lock', 'hcp-workspace']);

export const DEFAULT_DIR = '/home/student/infra';

function dirOf(check: { dir?: string }): string {
  return check.dir ?? DEFAULT_DIR;
}

export function describeTf(check: TfCheck, on: string): string {
  const where = (d?: string) => (d && d !== DEFAULT_DIR ? ` in ${d.replace('/home/student', '~')}` : '');
  switch (check.type) {
    case 'tf-ran': {
      const what = `terraform ${check.command}`;
      const outcome = check.code === undefined ? '' : check.code === 0 ? ' successfully' : ' and saw it fail';
      return `Ran ${what}${outcome}${where(check.dir)}${on}`;
    }
    case 'tf-resource':
      return check.exists === false ? `${check.address} is no longer in state${on}` : `${check.address} is in state${check.attrs ? ' with ' + Object.entries(check.attrs).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ') : ''}${check.workspace ? ` (workspace ${check.workspace})` : ''}${on}`;
    case 'tf-state-count':
      return `State tracks ${check.count} resource instance${check.count === 1 ? '' : 's'}${check.workspace ? ` in workspace ${check.workspace}` : ''}${on}`;
    case 'tf-output':
      return check.exists === false ? `Output ${check.name} is gone${on}` : `Output ${check.name}${check.value !== undefined ? ` is ${JSON.stringify(check.value)}` : ' is set'}${check.sensitive ? ' and marked sensitive' : ''}${on}`;
    case 'tf-lock':
      return `The lock file selects ${check.provider}${check.version ? ` ${check.version}` : ''}${check.constraints ? ` under "${check.constraints}"` : ''}${on}`;
    case 'tf-module':
      return `Module ${check.key} is installed${check.version ? ` at ${check.version}` : ''}${on}`;
    case 'tf-backend':
      return check.backend === 'cloud' ? `The working directory is connected to HCP Terraform${on}` : `State is kept in the ${check.backend} backend${on}`;
    case 'tf-workspace':
      return `Workspace ${check.name} ${check.exists === false ? 'is deleted' : check.current ? 'is selected' : 'exists'}${on}`;
    case 'tf-parses':
      return `Every configuration file parses${where(check.dir)}${on}`;
    case 'tf-formatted':
      return `The configuration is in terraform fmt style${where(check.dir)}${on}`;
    case 'tf-converged':
      return `A plan${where(check.dir)} shows no changes${on}`;
    case 'tf-config':
      return check.label;
    case 'cloud-object': {
      const noun = check.kind === 'instance' ? 'instance' : check.kind;
      if (check.exists === false) return `No ${noun}${check.name ? ` named ${check.name}` : check.id ? ` ${check.id}` : ''} remains in the cloud account`;
      const bits = Object.entries(check.attrs ?? {}).map(([k, v]) => `${k} ${JSON.stringify(v)}`);
      if (check.count !== undefined) return `The cloud account has ${check.count} ${noun}${check.count === 1 ? '' : 's'}${check.name ? ` named ${check.name}` : ''}${check.region ? ` in ${check.region}` : ''}`;
      return `A ${noun}${check.name ? ` named ${check.name}` : check.id ? ` ${check.id}` : ''} exists in the cloud${check.region ? ` in ${check.region}` : ''}${bits.length ? ` with ${bits.join(', ')}` : ''}${check.ingressRules !== undefined ? ` and ${check.ingressRules} ingress rules` : ''}`;
    }
    case 'tf-remote-lock':
      return check.locked ? 'The remote state is locked' : 'The remote state lock is released';
    case 'hcp-workspace':
      return check.exists === false ? `HCP Terraform workspace ${check.name} is gone` : `HCP Terraform workspace ${check.name} exists${check.project ? ` in project ${check.project}` : ''}${check.tag ? ` tagged ${check.tag}` : ''}${check.resources !== undefined ? ` and manages ${check.resources} resource instance${check.resources === 1 ? '' : 's'}` : ''}`;
  }
}

function fsSource(lx: LinuxState): Source {
  return {
    list: (dir) => listDir(lx, dir).filter((n) => lx.fs[`${dir}/${n}`]?.type === 'file'),
    read: (path) => {
      const r = readFile({ ...lx, user: 'root' }, path);
      return 'error' in r ? undefined : r.content;
    },
  };
}

function backendFor(lx: LinuxState, dir: string): Backend | null {
  const rec = readBackendRecord(lx, dir);
  const benv = { lx, cloud: lx.cloud, cwd: dir, env: lx.env };
  if (!rec || rec.type === 'local') return localBackend(benv, rec?.config ?? {});
  const b = rec.type === 'http' ? httpBackend(benv, rec.config) : rec.type === 'cloud' ? cloudBackend(benv, rec.config) : null;
  return b && !('error' in b) ? b : null;
}

function stateOf(lx: LinuxState, dir: string, workspace?: string): StateFile | null {
  const b = backendFor(lx, dir);
  if (!b) return null;
  const s = b.read(workspace ?? currentWorkspace(lx, dir, lx.env));
  return s && !('error' in s) ? s : null;
}

/** What the lab page shows about a working directory: where state is, and which cloud objects it manages. */
export function stateSummary(lx: LinuxState, dir: string = DEFAULT_DIR): { backend: string; workspace: string; managedIds: Set<string>; instances: number } {
  const rec = readBackendRecord(lx, dir);
  const workspace = currentWorkspace(lx, dir, lx.env);
  const insts = [...flatten(stateOf(lx, dir, workspace)).values()].filter((i) => i.mode === 'managed');
  return { backend: rec?.type ?? 'local', workspace, managedIds: new Set(insts.map((i) => String(i.attrs.id ?? ''))), instances: insts.length };
}

function tfText(lx: LinuxState, dir: string): string {
  return listDir(lx, dir)
    .filter((n) => n.endsWith('.tf'))
    .map((n) => {
      const r = readFile({ ...lx, user: 'root' }, `${dir}/${n}`);
      return 'error' in r ? '' : r.content;
    })
    .join('\n');
}

function sameValue(actual: Val | undefined, want: Scalar | Scalar[]): boolean {
  return canonical(plain(actual ?? null)) === canonical(want as Val);
}

/** Would a plan in `dir` change anything? Read-only: nothing is written. */
export function isConverged(lx: LinuxState, dir: string): boolean {
  const b = backendFor(lx, dir);
  if (!b) return false;
  const ws = currentWorkspace(lx, dir, lx.env);
  const prior = b.read(ws);
  if (prior && 'error' in prior) return false;
  let env = { ...lx.env };
  const rec = readBackendRecord(lx, dir);
  const remoteVars = rec?.type === 'cloud' ? lx.cloud?.hcp?.workspaces[String((rec.config.workspaces as Record<string, Val> | undefined)?.name ?? ws)]?.vars : undefined;
  if (remoteVars) env = Object.fromEntries(Object.entries(remoteVars).filter(([, v]) => v.category === 'env').map(([k, v]) => [k, v.value]));
  const runEnv: RunEnv = { lx, cloud: lx.cloud, cwd: dir, env, src: fsSource(lx), workspace: ws, out: () => undefined, log: () => undefined };
  try {
    const outcome = plan(runEnv, { mode: 'normal', refresh: true, targets: [], replace: [], cliVars: [], varFiles: [], input: false, remoteVars }, prior as StateFile | null);
    if (outcome.diags.length || !outcome.run) return false;
    return !hasChanges(outcome.run);
  } catch (e) {
    if (e instanceof DiagError) return false;
    throw e;
  }
}

export function evaluateTf(check: TfCheck, lx: LinuxState): boolean {
  switch (check.type) {
    case 'tf-ran': {
      const re = check.argsPattern ? new RegExp(check.argsPattern) : null;
      return (lx.terraformRuns ?? []).some(
        (r) =>
          r.command === check.command &&
          r.dir === dirOf(check) &&
          (check.code === undefined || r.code === check.code) &&
          (re === null || re.test(r.args.join(' '))) &&
          (check.add === undefined || r.add === check.add) &&
          (check.change === undefined || r.change === check.change) &&
          (check.destroy === undefined || r.destroy === check.destroy) &&
          (check.imported === undefined || r.imported === check.imported) &&
          (check.changes === undefined || Boolean(r.noChanges) !== check.changes) &&
          (check.remote === undefined || Boolean(r.remote) === check.remote),
      );
    }
    case 'tf-resource': {
      const inst = flatten(stateOf(lx, dirOf(check), check.workspace)).get(check.address);
      if (check.exists === false) return !inst;
      if (!inst) return false;
      if (check.tainted !== undefined && (inst.status === 'tainted') !== check.tainted) return false;
      return Object.entries(check.attrs ?? {}).every(([k, v]) => sameValue(inst.attrs[k], v));
    }
    case 'tf-state-count':
      return [...flatten(stateOf(lx, dirOf(check), check.workspace)).values()].filter((i) => i.mode === 'managed').length === check.count;
    case 'tf-output': {
      const o = stateOf(lx, dirOf(check), check.workspace)?.outputs?.[check.name];
      if (check.exists === false) return !o;
      if (!o) return false;
      if (check.sensitive !== undefined && Boolean(o.sensitive) !== check.sensitive) return false;
      return check.value === undefined || sameValue(o.value, check.value);
    }
    case 'tf-lock': {
      const lock = readLock({ ...lx, user: 'root' }, dirOf(check));
      if ('error' in lock) return false;
      const e = (lock as Record<string, { version: string; constraints?: string }>)[check.provider];
      return Boolean(e) && (check.version === undefined || e.version === check.version) && (check.constraints === undefined || e.constraints === check.constraints);
    }
    case 'tf-module': {
      const rec = readModules({ ...lx, user: 'root' }, dirOf(check)).find((m) => m.Key === check.key);
      return Boolean(rec) && (check.version === undefined || rec!.Version === check.version);
    }
    case 'tf-backend': {
      const rec = readBackendRecord(lx, dirOf(check));
      return (rec?.type ?? 'local') === check.backend;
    }
    case 'tf-workspace': {
      const b = backendFor(lx, dirOf(check));
      if (!b) return false;
      const exists = b.workspaces().includes(check.name);
      if (check.exists === false) return !exists;
      if (!exists) return false;
      return !check.current || currentWorkspace(lx, dirOf(check), lx.env) === check.name;
    }
    case 'tf-parses': {
      const dir = dirOf(check);
      const names = listDir(lx, dir).filter((n) => n.endsWith('.tf'));
      if (!names.length) return false;
      return names.every((n) => {
        const r = readFile({ ...lx, user: 'root' }, `${dir}/${n}`);
        if ('error' in r) return false;
        try {
          parseHcl(r.content, n);
          return true;
        } catch {
          return false;
        }
      });
    }
    case 'tf-formatted': {
      const dir = dirOf(check);
      const names = listDir(lx, dir).filter((n) => /\.(tf|tfvars)$/.test(n));
      return (
        names.length > 0 &&
        names.every((n) => {
          const r = readFile({ ...lx, user: 'root' }, `${dir}/${n}`);
          return !('error' in r) && formatHcl(r.content) === r.content;
        })
      );
    }
    case 'tf-converged':
      if (!getNode(lx, dirOf(check))) return false;
      return isConverged(lx, dirOf(check));
    case 'tf-config': {
      const found = new RegExp(check.pattern, 'm').test(tfText(lx, dirOf(check)));
      return check.absent ? !found : found;
    }
    case 'cloud-object': {
      const objs = Object.values(lx.cloud?.objects ?? {}).filter(
        (o) => o.kind === check.kind && (check.name === undefined || o.attrs.name === check.name) && (check.id === undefined || o.id === check.id) && (check.region === undefined || o.region === check.region) && Object.entries(check.attrs ?? {}).every(([k, v]) => sameValue(o.attrs[k], v)) && (check.ingressRules === undefined || ((o.attrs.ingress as unknown[] | null) ?? []).length === check.ingressRules),
      );
      if (check.exists === false) return objs.length === 0;
      if (check.count !== undefined) return objs.length === check.count;
      return objs.length > 0;
    }
    case 'tf-remote-lock':
      return Boolean(lx.cloud?.stateService[check.address]?.lock) === check.locked;
    case 'hcp-workspace': {
      const w = lx.cloud?.hcp?.workspaces[check.name];
      if (check.exists === false) return !w;
      if (!w) return false;
      if (check.project && w.project !== check.project) return false;
      if (check.tag && !w.tags.includes(check.tag)) return false;
      if (check.resources !== undefined) {
        const s = w.state ? (JSON.parse(w.state) as StateFile) : null;
        return [...flatten(s).values()].filter((i) => i.mode === 'managed').length === check.resources;
      }
      return true;
    }
  }
}
