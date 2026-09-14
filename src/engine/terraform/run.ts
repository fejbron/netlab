/**
 * The plan and apply engine.
 *
 * A run loads the configuration tree, checks it against the provider schemas and the
 * lock file, evaluates input variables, reads state, applies moved blocks, refreshes
 * every managed object against the real infrastructure, and then walks a dependency
 * graph of variables, locals, resources, module outputs and outputs in order.
 *
 * In the plan phase each resource instance is compared with its prior state and given an
 * action. In the apply phase the same walk runs again with the actions carried out, so
 * values that were "(known after apply)" become known for whatever depends on them.
 * Destroys happen first, in reverse dependency order; create_before_destroy replacements
 * delete their old object last.
 */
import type { LinuxState } from '../linux/fs';
import { normalizePath, readFile as fsReadFile, writeFile as fsWriteFile } from '../linux/fs';
import type { CloudAccount, HcpVariable } from './cloud';
import {
  checkReferences,
  exprAddress,
  loadModuleDir,
  providerSourceFor,
  validateResourceBody,
  type Condition,
  type ModuleTree,
  type ResourceConfig,
  type Source,
} from './config';
import { EPHEMERAL, evaluate, references, SENSITIVE_ATTRS, SENSITIVE_VALUES, type Marks, type Scope } from './eval';
import { diag, DiagError, parseExpression, parseHcl, type Body, type Diag, type Expr, type Pos } from './hcl';
import { isLocalSource, isProviderInstalled, readLock, readModules, REGISTRY_MODULES, type LockEntry } from './project';
import { cmpVersion, hexHash, PROVIDERS, ProviderError, providerFor, satisfies, type BlockDef, type DataDef, type ProviderCtx, type ProviderDef, type ResourceDef } from './providers';
import { buildState, emptyState, flatten, instanceAddr, keyText, parseAddress, providerAddr, TF_VERSION, type Inst, type StateFile } from './state';
import { canonical, ConvertError, convert, equal, hasUnknown, isObj, isSet, isUnknown, plain, typeName, UNKNOWN, type Val, type ValObject } from './values';

export type Action = 'create' | 'update' | 'replace' | 'delete' | 'noop' | 'read' | 'forget';

export interface Change {
  addr: string;
  module: string;
  mode: 'managed' | 'data' | 'ephemeral';
  type: string;
  name: string;
  key?: number | string;
  action: Action;
  cbd: boolean;
  before: ValObject | null;
  after: ValObject | null;
  forceNew: string[];
  reason?: 'tainted' | 'requested' | 'triggered' | 'not-in-config' | 'count-index' | 'each-key' | 'module-gone' | 'deferred-read' | 'removed';
  importId?: string;
  movedFrom?: string;
  sensitive: string[];
  writeOnly: string[];
  providerSource: string;
  deps: string[];
}

export interface Drift {
  addr: string;
  type: string;
  name: string;
  before: ValObject;
  after: ValObject | null;
  sensitive: string[];
}

export interface OutputChange {
  name: string;
  before: Val | undefined;
  after: Val | undefined;
  sensitive: boolean;
}

export interface RunEnv {
  lx: LinuxState;
  cloud?: CloudAccount;
  cwd: string;
  env: Record<string, string>;
  src: Source;
  workspace: string;
  /** Streamed progress lines (Reading..., Creating...). */
  out: (line: string) => void;
  /** TF_LOG lines. */
  log: (level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', line: string) => void;
}

export interface RunOptions {
  mode: 'normal' | 'destroy' | 'refresh-only';
  refresh: boolean;
  targets: string[];
  replace: string[];
  cliVars: Array<{ name: string; value: string }>;
  varFiles: string[];
  input: boolean;
  ask?: (lines: string[]) => string;
  generateConfigOut?: string;
  /** HCP Terraform workspace variables, used instead of local variable sources. */
  remoteVars?: Record<string, HcpVariable>;
  /** Only validate: stop after the static checks. */
  validateOnly?: boolean;
}

export class NeedInput extends Error {}

interface ModVals {
  vars: Record<string, Val>;
  locals: Record<string, Val>;
  outputs: Record<string, Val>;
  sensitiveOutputs: Set<string>;
  resources: Record<string, Val>;
}

interface Node {
  id: string;
  kind: 'var' | 'local' | 'output' | 'resource' | 'provider';
  tree: ModuleTree;
  name: string;
  deps: Set<string>;
  order: number;
  resource?: ResourceConfig;
}

export interface Run {
  env: RunEnv;
  opts: RunOptions;
  tree: ModuleTree;
  sources: Record<string, string>;
  diags: Diag[];
  warnings: Diag[];
  lock: Record<string, LockEntry>;
  prior: StateFile;
  /** Working state: prior + moves + refresh, mutated during apply. */
  insts: Map<string, Inst>;
  /** State as read, before refresh (for drift and saved-plan staleness). */
  priorInsts: Map<string, Inst>;
  changes: Map<string, Change>;
  drift: Drift[];
  moved: Array<{ from: string; to: string }>;
  outputs: OutputChange[];
  vals: Map<string, ModVals>;
  nodes: Map<string, Node>;
  orderIds: string[];
  providers: Map<string, { ctx?: ProviderCtx; error?: ProviderError; def: ProviderDef; source: string; pos?: Pos }>;
  phase: 'plan' | 'apply';
  failed: Set<string>;
  applied: { added: number; changed: number; destroyed: number; imported: number };
  rootVars: Record<string, { value: Val; sensitive: boolean; ephemeral: boolean }>;
  generated?: { file: string; text: string };
  checkWarnings: Diag[];
}

const NO_MARKS = (): Marks => ({ sensitive: false, ephemeral: false });

function err(summary: string, detail: string, pos?: Pos, extra: Partial<Diag> = {}): Diag {
  return diag(summary, detail, pos, extra);
}

function resourceContext(r: ResourceConfig): string {
  return `${r.mode === 'managed' ? 'resource' : r.mode === 'data' ? 'data' : 'ephemeral'} "${r.type}" "${r.name}"`;
}

// ---------------------------------------------------------------------------
// loading

export function loadTree(env: RunEnv): { tree?: ModuleTree; diags: Diag[]; sources: Record<string, string> } {
  const diags: Diag[] = [];
  const sources: Record<string, string> = {};
  const root = loadModuleDir(env.src, env.cwd, '.');
  diags.push(...root.errors);
  Object.assign(sources, root.config.files);
  if (Object.keys(root.config.files).length === 0) {
    return { diags: [err('No configuration files', 'Plan requires configuration to be present. Planning without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run plan with the -destroy option. Otherwise, create a Terraform configuration file (.tf file) and try again.')], sources };
  }
  const records = readModules(env.lx, env.cwd);
  const tree: ModuleTree = { key: '', config: root.config, children: {} };
  const load = (t: ModuleTree, depth: number) => {
    if (depth > 6) return;
    for (const call of Object.values(t.config.modules)) {
      const key = t.key ? `${t.key.replace(/module\./g, '')}.${call.name}` : call.name;
      const rec = records.find((r) => r.Key === key);
      if (!call.source) continue;
      if (!rec) {
        diags.push(err('Module not installed', 'This module is not yet installed. Run "terraform init" to install all modules required by this configuration.', call.pos, { context: `module "${call.name}"` }));
        continue;
      }
      if (rec.Source !== call.source && !(isLocalSource(call.source) && rec.Source === call.source)) {
        diags.push(err('Module source has changed', 'The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.', call.pos, { context: `module "${call.name}"` }));
        continue;
      }
      if (call.version && rec.Version && !satisfies(rec.Version, call.version)) {
        diags.push(err('Module version requirements have changed', `The version requirements have changed since this module was installed and the installed version (${rec.Version}) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.`, call.pos, { context: `module "${call.name}"` }));
        continue;
      }
      if (!isLocalSource(call.source) && call.version === undefined && REGISTRY_MODULES[call.source]) {
        // Allowed, but worth pinning; init already chose the newest.
      }
      const dir = normalizePath(env.cwd, rec.Dir, '/');
      const rel = rec.Dir.replace(/^\.\//, '');
      const loaded = loadModuleDir(env.src, dir, rel);
      diags.push(...loaded.errors);
      Object.assign(sources, loaded.config.files);
      if (Object.keys(loaded.config.files).length === 0) {
        diags.push(err('Unreadable module directory', `The directory ${rel} does not contain any configuration files.`, call.pos, { context: `module "${call.name}"` }));
        continue;
      }
      const childKey = t.key ? `${t.key}.module.${call.name}` : `module.${call.name}`;
      const child: ModuleTree = { key: childKey, config: loaded.config, call, children: {} };
      t.children[call.name] = child;
      load(child, depth + 1);
    }
  };
  load(tree, 0);
  return { tree, diags, sources };
}

export function allTrees(tree: ModuleTree): ModuleTree[] {
  return [tree, ...Object.values(tree.children).flatMap(allTrees)];
}

/** Provider sources this configuration needs, with every version constraint that applies. */
export function requiredProviders(tree: ModuleTree): Record<string, { constraints: string[]; pos?: Pos }> {
  const out: Record<string, { constraints: string[]; pos?: Pos }> = {};
  for (const t of allTrees(tree)) {
    for (const [, rp] of Object.entries(t.config.requiredProviders)) {
      const e = (out[rp.source] ??= { constraints: [], pos: rp.pos });
      if (rp.version) e.constraints.push(rp.version);
    }
    for (const r of Object.values(t.config.resources)) {
      const src = providerSourceFor(t.config, tree.config, r.provider.name);
      if (src === 'terraform.io/builtin/terraform') continue;
      out[src] ??= { constraints: [] };
    }
    for (const p of t.config.providers) {
      const src = providerSourceFor(t.config, tree.config, p.name);
      out[src] ??= { constraints: [] };
    }
  }
  return out;
}

function providerDef(source: string): ProviderDef | undefined {
  return PROVIDERS[source] ?? providerFor(source);
}

export function schemaFor(r: ResourceConfig, def: ProviderDef, version: string): ResourceDef | DataDef | undefined {
  if (r.mode === 'managed') return def.resources(version)[r.type];
  if (r.mode === 'data') return def.data(version)[r.type];
  return def.ephemeral?.(version)[r.type];
}

/**
 * Static checks that need the lock file and installed providers: versions, schemas and
 * references. Returns the lock entries when everything needed is present.
 */
export function checkConfiguration(env: RunEnv, tree: ModuleTree, diags: Diag[]): Record<string, LockEntry> {
  const rootCfg = tree.config;
  if (rootCfg.requiredVersion && !satisfies(TF_VERSION, rootCfg.requiredVersion.constraint)) {
    diags.push(err('Unsupported Terraform Core version', `This configuration does not support Terraform version ${TF_VERSION}. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.`, rootCfg.requiredVersion.pos, { context: 'terraform' }));
    return {};
  }
  const lockRead = readLock(env.lx, env.cwd);
  if ('error' in lockRead) {
    diags.push(err('Failed to read dependency lock file', String(lockRead.error)));
    return {};
  }
  const lock = lockRead as Record<string, LockEntry>;
  const needed = requiredProviders(tree);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const notInstalled: string[] = [];
  for (const [source, req] of Object.entries(needed)) {
    const entry = lock[source];
    if (!entry) {
      missing.push(source);
      continue;
    }
    if (!req.constraints.every((c) => satisfies(entry.version, c))) mismatched.push(`  - provider registry.terraform.io/${source}: locked version selection ${entry.version} doesn't match the updated version constraints "${req.constraints.join(', ')}"`);
    else if (!isProviderInstalled(env.lx, env.cwd, source, entry.version)) notInstalled.push(`  - registry.terraform.io/${source}: there is no package for registry.terraform.io/${source} ${entry.version} cached in .terraform/providers`);
  }
  if (missing.length || mismatched.length) {
    const lines = [...missing.map((s) => `  - provider registry.terraform.io/${s}: required by this configuration but no version is selected`), ...mismatched];
    diags.push(
      err(
        'Inconsistent dependency lock file',
        `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${lines.join('\n')}\n\nTo ${missing.length && !mismatched.length ? 'make the initial dependency selections that will initialize the dependency lock file' : 'update the locked dependency selections to match a changed configuration'}, run:\n  terraform init${mismatched.length ? ' -upgrade' : ''}`,
      ),
    );
    return lock;
  }
  if (notInstalled.length) {
    diags.push(err('Required plugins are not installed', `The installed provider plugins are not consistent with the packages selected in the dependency lock file:\n${notInstalled.join('\n')}\n\nTerraform uses external plugins to integrate with a variety of different infrastructure services. To download the plugins required for this configuration, run:\n  terraform init`));
    return lock;
  }
  for (const t of allTrees(tree)) {
    for (const r of Object.values(t.config.resources)) {
      const source = providerSourceFor(t.config, rootCfg, r.provider.name);
      const def = providerDef(source);
      if (!def) continue;
      const version = def.builtin ? TF_VERSION : lock[source]?.version ?? def.versions[def.versions.length - 1];
      const schema = schemaFor(r, def, version);
      if (!schema) {
        const all = r.mode === 'managed' ? Object.keys(def.resources(version)) : r.mode === 'data' ? Object.keys(def.data(version)) : Object.keys(def.ephemeral?.(version) ?? {});
        const near = all.find((x) => x.replace(/s$/, '') === r.type.replace(/s$/, '')) ?? all.find((x) => x.startsWith(r.type.slice(0, -2)));
        const kind = r.mode === 'managed' ? 'resource type' : r.mode === 'data' ? 'data source' : 'ephemeral resource type';
        diags.push(err(`Invalid ${kind}`, `The provider ${source} does not support ${kind} "${r.type}".${near ? `\n\nDid you mean "${near}"?` : ''}`, r.pos, { context: resourceContext(r) }));
        continue;
      }
      validateResourceBody(r, schema as ResourceDef, diags);
    }
    for (const v of Object.values(t.config.variables)) {
      if (v.type && v.default && v.default.k !== 'var') {
        try {
          const dv = evaluate(v.default, { lookup: () => null, arity: () => 1, readFile: () => undefined });
          convert(dv, v.type);
        } catch (e) {
          if (e instanceof ConvertError) diags.push(err('Invalid default value for variable', `This default value is not compatible with the variable's type constraint: ${e.message}.`, v.default.pos, { context: `variable "${v.name}"` }));
        }
      }
    }
  }
  for (const t of allTrees(tree)) {
    checkReferences(
      t,
      (r) => {
        const def = providerDef(providerSourceFor(t.config, rootCfg, r.provider.name));
        if (!def) return undefined;
        const schema = schemaFor(r, def, def.builtin ? TF_VERSION : lock[providerSourceFor(t.config, rootCfg, r.provider.name)]?.version ?? '0.0.0');
        return schema as ResourceDef | undefined;
      },
      diags,
    );
  }
  return lock;
}

// ---------------------------------------------------------------------------
// variables

function varSourcesFromFile(env: RunEnv, path: string, display: string, diags: Diag[], sources: Record<string, string>): Record<string, { expr: Expr; pos: Pos; file: string }> {
  const r = fsReadFile(env.lx, normalizePath(env.cwd, path, `/home/${env.lx.user}`));
  if ('error' in r) {
    diags.push(err('Failed to read variables file', `Given variables file ${display} does not exist.`));
    return {};
  }
  sources[display] = r.content;
  try {
    const body = parseHcl(r.content, display);
    const out: Record<string, { expr: Expr; pos: Pos; file: string }> = {};
    for (const [k, a] of Object.entries(body.attrs)) out[k] = { expr: a.expr, pos: a.pos, file: display };
    for (const b of body.blocks) diags.push(err('Unexpected block', `Blocks are not allowed in a variable definitions file. Did you mean to put this in a .tf file instead?`, b.pos));
    return out;
  } catch (e) {
    if (e instanceof DiagError) {
      diags.push(...e.diags);
      return {};
    }
    throw e;
  }
}

function evaluateRootVariables(run: Run) {
  const { env, opts, tree } = run;
  const vars = tree.config.variables;
  type Raw = { expr?: Expr; text?: string; pos?: Pos; origin: string; file?: string };
  const raw: Record<string, Raw> = {};
  const undeclared = (name: string, where: string, pos: Pos | undefined, isError: boolean) => {
    if (isError) run.diags.push(err('Value for undeclared variable', `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.`));
    else run.warnings.push({ severity: 'warning', summary: 'Value for undeclared variable', detail: `The root module does not declare a variable named "${name}" but a value was found in file "${where}". If you meant to use this value, add a "variable" block to the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.`, pos });
  };
  if (opts.remoteVars) {
    for (const [name, v] of Object.entries(opts.remoteVars)) {
      if (v.category !== 'terraform') continue;
      if (vars[name]) raw[name] = v.hcl ? { expr: parseExpression(v.value), origin: 'workspace' } : { text: v.value, origin: 'workspace' };
    }
  } else {
    for (const [k, v] of Object.entries(env.env)) {
      if (!k.startsWith('TF_VAR_')) continue;
      const name = k.slice(7);
      if (vars[name]) raw[name] = { text: v, origin: 'env' };
    }
  }
  const files: string[] = [];
  const names = env.src.list(env.cwd);
  if (names.includes('terraform.tfvars')) files.push('terraform.tfvars');
  files.push(...names.filter((n) => n.endsWith('.auto.tfvars')).sort());
  const fileSets = [...files.map((f) => ({ path: f, display: f })), ...(opts.remoteVars ? [] : opts.varFiles.map((f) => ({ path: f, display: f })))];
  for (const f of fileSets) {
    const vals = varSourcesFromFile(env, f.path, f.display, run.diags, run.sources);
    for (const [name, v] of Object.entries(vals)) {
      if (!vars[name]) undeclared(name, f.display, v.pos, false);
      else raw[name] = { expr: v.expr, pos: v.pos, origin: f.display, file: f.display };
    }
  }
  if (!opts.remoteVars) {
    for (const cv of opts.cliVars) {
      if (!vars[cv.name]) {
        undeclared(cv.name, '', undefined, true);
        continue;
      }
      raw[cv.name] = { text: cv.value, origin: 'cli' };
    }
  }
  const vals = run.vals.get('')!;
  for (const v of Object.values(vars)) {
    let value: Val;
    let pos = v.pos;
    const r = raw[v.name];
    try {
      if (r?.expr) {
        value = evaluate(r.expr, { lookup: (_root, _n, p) => { throw new DiagError([err('Variables not allowed', 'Variables may not be used here.', p)]); }, arity: () => 1, readFile: () => undefined });
        pos = r.pos ?? pos;
      } else if (r?.text !== undefined) {
        const simple = !v.type || ['string', 'number', 'bool', 'any'].includes(v.type.t);
        value = simple ? r.text : evaluate(parseExpression(r.text, `<value for var.${v.name}>`), { lookup: () => null, arity: () => 1, readFile: () => undefined });
      } else if (v.default) {
        value = evaluate(v.default, { lookup: () => null, arity: () => 1, readFile: () => undefined });
      } else if (opts.input && opts.ask) {
        const answer = opts.ask([`var.${v.name}`, ...(v.description ? [`  ${v.description}`] : []), '']);
        const simple = !v.type || ['string', 'number', 'bool', 'any'].includes(v.type.t);
        value = simple ? answer : evaluate(parseExpression(answer), { lookup: () => null, arity: () => 1, readFile: () => undefined });
      } else {
        run.diags.push(err('No value for required variable', `The root module input variable "${v.name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, v.pos, { context: `variable "${v.name}"` }));
        continue;
      }
    } catch (e) {
      if (e instanceof DiagError) {
        run.diags.push(...e.diags);
        continue;
      }
      if (e instanceof NeedInput) throw e;
      throw e;
    }
    if (value === null && !v.nullable) {
      run.diags.push(err('Required variable not set', `Unsuitable value for var.${v.name} set from outside of the configuration: required variable may not be set to null.`, pos));
      continue;
    }
    if (v.type) {
      try {
        value = convert(value, v.type);
      } catch (e) {
        if (e instanceof ConvertError) {
          run.diags.push(err('Invalid value for input variable', `The given value is not suitable for var.${v.name} declared at ${v.pos.file}:${v.pos.line},${v.pos.col}: ${e.message}.`, r?.expr ? pos : undefined));
          continue;
        }
        throw e;
      }
    }
    vals.vars[v.name] = value;
    if (value && typeof value === 'object' && v.sensitive) SENSITIVE_VALUES.add(value);
    run.rootVars[v.name] = { value, sensitive: v.sensitive, ephemeral: v.ephemeral };
  }
}

function validateVariables(run: Run, tree: ModuleTree) {
  const vals = run.vals.get(tree.key)!;
  for (const v of Object.values(tree.config.variables)) {
    if (!(v.name in vals.vars)) continue;
    for (const rule of v.validations) {
      const scope = scopeFor(run, tree, {});
      try {
        const ok = evaluate(rule.condition, scope);
        if (isUnknown(ok)) continue;
        if (ok !== true) {
          const msg = evaluate(rule.message, scope);
          run.diags.push(err('Invalid value for variable', `${String(msg)}\n\nThis was checked by the validation rule at ${rule.pos.file}:${rule.pos.line},${rule.pos.col}.`, v.pos, { context: `variable "${v.name}"` }));
        }
      } catch (e) {
        if (e instanceof DiagError) run.diags.push(...e.diags.map((d) => ({ ...d, context: d.context ?? `variable "${v.name}"` })));
        else throw e;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// scope

interface InstCtx {
  countIndex?: number;
  each?: { key: string; value: Val };
  self?: ValObject;
}

class Skip extends Error {}

function childKeyOf(tree: ModuleTree, name: string): string {
  return tree.key ? `${tree.key}.module.${name}` : `module.${name}`;
}

export function scopeFor(run: Run, tree: ModuleTree, inst: InstCtx): Scope {
  const vals = run.vals.get(tree.key)!;
  const cfg = tree.config;
  return {
    arity: (root) => (root === 'data' || root === 'ephemeral' ? 2 : 1),
    readFile: (p) => {
      const r = fsReadFile(run.env.lx, normalizePath(run.env.cwd, p, `/home/${run.env.lx.user}`));
      return 'error' in r ? undefined : r.content;
    },
    lookup: (root, names, pos, marks) => {
      const name = names[0];
      switch (root) {
        case 'var': {
          if (!cfg.variables[name]) throw new DiagError([err('Reference to undeclared input variable', `An input variable with the name "${name}" has not been declared. This variable can be declared with a variable "${name}" {} block.`, pos)]);
          if (!(name in vals.vars)) throw new Skip();
          if (cfg.variables[name].sensitive) marks.sensitive = true;
          if (cfg.variables[name].ephemeral) marks.ephemeral = true;
          return vals.vars[name];
        }
        case 'local':
          if (!(name in cfg.locals)) throw new DiagError([err('Reference to undeclared local value', `A local value with the name "${name}" has not been declared.`, pos)]);
          if (!(name in vals.locals)) throw new Skip();
          return vals.locals[name];
        case 'module': {
          const child = run.vals.get(childKeyOf(tree, name));
          if (!cfg.modules[name]) throw new DiagError([err('Reference to undeclared module', `No module call named "${name}" is declared in ${tree.key ? tree.key : 'the root module'}.`, pos)]);
          if (!child) throw new Skip();
          const obj: ValObject = { ...child.outputs };
          SENSITIVE_ATTRS.set(obj, new Set(child.sensitiveOutputs));
          return obj;
        }
        case 'count':
          if (inst.countIndex === undefined) throw new DiagError([err('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.', pos)]);
          return inst.countIndex;
        case 'each':
          if (!inst.each) throw new DiagError([err('Reference to "each" in context without for_each', 'The "each" object can be used only in "module" or "resource" blocks, and only when the "for_each" argument is set.', pos)]);
          return name === 'key' ? inst.each.key : inst.each.value;
        case 'path':
          return name === 'module' ? cfg.rel : name === 'root' ? '.' : run.env.cwd;
        case 'terraform':
          return run.env.workspace;
        case 'self':
          if (!inst.self) throw new DiagError([err('Invalid "self" reference', 'The "self" object is not available in this context. This object can be used only in resource provisioner, connection, and postcondition blocks.', pos)]);
          return inst.self;
        case 'data':
        case 'ephemeral': {
          const key = `${root}.${names[0]}.${names[1]}`;
          if (!cfg.resources[key]) throw new DiagError([err('Reference to undeclared resource', `A ${root === 'data' ? 'data resource' : 'ephemeral resource'} "${names[0]}" "${names[1]}" has not been declared in ${tree.key || 'the root module'}.`, pos)]);
          if (!(key in vals.resources)) throw new Skip();
          if (root === 'ephemeral') marks.ephemeral = true;
          return vals.resources[key];
        }
        default: {
          const key = `${root}.${name}`;
          if (!cfg.resources[key]) throw new DiagError([err('Reference to undeclared resource', `A managed resource "${root}" "${name}" has not been declared in ${tree.key || 'the root module'}.`, pos)]);
          if (!(key in vals.resources)) throw new Skip();
          return vals.resources[key];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// graph

function nodeRefs(tree: ModuleTree, expr: Expr, bound?: Set<string>): string[] {
  const ids: string[] = [];
  for (const ref of references(expr, bound)) {
    const [root, ...names] = ref.parts;
    const k = tree.key;
    switch (root) {
      case 'var':
        ids.push(`${k}|var.${names[0]}`);
        break;
      case 'local':
        ids.push(`${k}|local.${names[0]}`);
        break;
      case 'module': {
        const child = tree.children[names[0]];
        if (!child) break;
        if (names[1]) ids.push(`${child.key}|output.${names[1]}`);
        else for (const o of Object.keys(child.config.outputs)) ids.push(`${child.key}|output.${o}`);
        break;
      }
      case 'count':
      case 'each':
      case 'path':
      case 'terraform':
      case 'self':
        break;
      case 'data':
      case 'ephemeral':
        ids.push(`${k}|res.${root}.${names[0]}.${names[1]}`);
        break;
      default:
        ids.push(`${k}|res.${root}.${names[0]}`);
    }
  }
  return ids;
}

function bodyExprs(body: Body, bound: Set<string>, out: Array<{ expr: Expr; bound: Set<string> }>) {
  for (const [name, a] of Object.entries(body.attrs)) if (name !== 'provider' && name !== 'depends_on') out.push({ expr: a.expr, bound });
  for (const b of body.blocks) {
    if (b.type === 'dynamic') {
      const it = b.body.attrs.iterator?.expr;
      const iter = it && it.k === 'var' ? it.name : b.labels[0];
      if (b.body.attrs.for_each) out.push({ expr: b.body.attrs.for_each.expr, bound });
      const nb = new Set(bound);
      nb.add(iter);
      for (const c of b.body.blocks) bodyExprs(c.body, nb, out);
    } else if (b.type === 'lifecycle') {
      if (b.body.attrs.replace_triggered_by) out.push({ expr: b.body.attrs.replace_triggered_by.expr, bound });
      for (const cond of b.body.blocks) for (const a of Object.values(cond.body.attrs)) out.push({ expr: a.expr, bound: new Set([...bound, 'self']) });
    } else bodyExprs(b.body, bound, out);
  }
}

function buildGraph(run: Run) {
  let order = 0;
  const add = (n: Omit<Node, 'order'>) => run.nodes.set(n.id, { ...n, order: order++ });
  const root = run.tree;
  for (const t of allTrees(root)) {
    const k = t.key;
    run.vals.set(k, run.vals.get(k) ?? { vars: {}, locals: {}, outputs: {}, sensitiveOutputs: new Set(), resources: {} });
    for (const p of t.config.providers) {
      const deps = new Set<string>();
      for (const a of Object.values(p.body.attrs)) for (const id of nodeRefs(t, a.expr)) deps.add(id);
      add({ id: `${k}|provider.${p.name}${p.alias ? '.' + p.alias : ''}`, kind: 'provider', tree: t, name: p.name, deps });
    }
    for (const v of Object.values(t.config.variables)) {
      const deps = new Set<string>();
      if (t.call && t.call.inputs[v.name]) {
        const parent = findParent(root, t)!;
        for (const id of nodeRefs(parent, t.call.inputs[v.name].expr)) deps.add(id);
        for (const d of t.call.dependsOn) for (const id of refIds(parent, d.ref)) deps.add(id);
      }
      add({ id: `${k}|var.${v.name}`, kind: 'var', tree: t, name: v.name, deps });
    }
    for (const [name, l] of Object.entries(t.config.locals)) add({ id: `${k}|local.${name}`, kind: 'local', tree: t, name, deps: new Set(nodeRefs(t, l.expr)) });
    for (const [key, r] of Object.entries(t.config.resources)) {
      const exprs: Array<{ expr: Expr; bound: Set<string> }> = [];
      bodyExprs(r.body, new Set(), exprs);
      if (r.count) exprs.push({ expr: r.count.expr, bound: new Set() });
      if (r.forEach) exprs.push({ expr: r.forEach.expr, bound: new Set() });
      const deps = new Set<string>();
      for (const e of exprs) for (const id of nodeRefs(t, e.expr, e.bound)) deps.add(id);
      for (const d of r.dependsOn) for (const id of refIds(t, d.ref)) deps.add(id);
      const pkey = `${r.provider.name}${r.provider.alias ? '.' + r.provider.alias : ''}`;
      if (run.nodes.has(`${k}|provider.${pkey}`)) deps.add(`${k}|provider.${pkey}`);
      else if (run.nodes.has(`|provider.${pkey}`) || root.config.providers.some((p) => `${p.name}${p.alias ? '.' + p.alias : ''}` === pkey)) deps.add(`|provider.${pkey}`);
      add({ id: `${k}|res.${key}`, kind: 'resource', tree: t, name: key, deps, resource: r });
    }
    for (const o of Object.values(t.config.outputs)) {
      const deps = new Set<string>();
      if (o.value) for (const id of nodeRefs(t, o.value)) deps.add(id);
      for (const p of o.preconditions) for (const id of nodeRefs(t, p.condition)) deps.add(id);
      for (const d of o.dependsOn) for (const id of refIds(t, d.ref)) deps.add(id);
      add({ id: `${k}|output.${o.name}`, kind: 'output', tree: t, name: o.name, deps });
    }
  }
  // Providers in the root are declared before the resources that use them, but a module
  // may be walked first; the dependency edges take care of ordering either way.
  const ids = [...run.nodes.keys()];
  const indeg = new Map<string, number>();
  const users = new Map<string, string[]>();
  for (const id of ids) {
    const n = run.nodes.get(id)!;
    n.deps = new Set([...n.deps].filter((d) => run.nodes.has(d) && d !== id));
    indeg.set(id, n.deps.size);
    for (const d of n.deps) users.set(d, [...(users.get(d) ?? []), id]);
  }
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const out: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => run.nodes.get(a)!.order - run.nodes.get(b)!.order);
    const id = ready.shift()!;
    out.push(id);
    for (const u of users.get(id) ?? []) {
      indeg.set(u, indeg.get(u)! - 1);
      if (indeg.get(u) === 0) ready.push(u);
    }
  }
  if (out.length < ids.length) {
    const stuck = ids.filter((id) => !out.includes(id)).map((id) => displayNode(id));
    run.diags.push(err('Cycle', `${stuck.join(', ')}`));
  }
  run.orderIds = out;
}

function displayNode(id: string): string {
  const [k, rest] = id.split('|');
  const name = rest.startsWith('res.') ? rest.slice(4) : rest.startsWith('provider.') ? `provider["${rest.slice(9)}"]` : rest;
  return `${k ? k + '.' : ''}${name} (expand)`;
}

function refIds(tree: ModuleTree, ref: string): string[] {
  const parts = ref.replace(/\[[^\]]*\]/g, '').split('.');
  if (parts[0] === 'module') {
    const child = tree.children[parts[1]];
    return child ? Object.keys(child.config.outputs).map((o) => `${child.key}|output.${o}`) : [];
  }
  if (parts[0] === 'data') return [`${tree.key}|res.data.${parts[1]}.${parts[2]}`];
  return [`${tree.key}|res.${parts[0]}.${parts[1]}`];
}

function findParent(root: ModuleTree, child: ModuleTree): ModuleTree | undefined {
  for (const t of allTrees(root)) if (Object.values(t.children).includes(child)) return t;
  return undefined;
}

/** Resource addresses (module-prefixed, no instance keys) a node depends on, through locals and variables. */
function resourceDeps(run: Run, id: string, memo = new Map<string, Set<string>>()): Set<string> {
  const cached = memo.get(id);
  if (cached) return cached;
  const out = new Set<string>();
  memo.set(id, out);
  for (const d of run.nodes.get(id)?.deps ?? []) {
    const n = run.nodes.get(d)!;
    if (n.kind === 'resource' && n.resource!.mode !== 'ephemeral') {
      out.add((n.tree.key ? n.tree.key + '.' : '') + (n.resource!.mode === 'data' ? `data.${n.resource!.type}.${n.resource!.name}` : `${n.resource!.type}.${n.resource!.name}`));
    } else for (const x of resourceDeps(run, d, memo)) out.add(x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// providers


export function getProvider(run: Run, tree: ModuleTree, r: ResourceConfig, address: string): ProviderCtx {
  const source = providerSourceFor(tree.config, run.tree.config, r.provider.name);
  const key = `${source}|${r.provider.alias ?? ''}`;
  let entry = run.providers.get(key);
  if (!entry) {
    const def = providerDef(source)!;
    const version = def.builtin ? TF_VERSION : run.lock[source]?.version ?? def.versions[def.versions.length - 1];
    const block = [...allTrees(run.tree)].flatMap((t) => t.config.providers.map((p) => ({ p, t }))).find(({ p }) => p.name === r.provider.name && p.alias === r.provider.alias);
    if (r.provider.alias && !block) {
      throw new DiagError([err('Provider configuration not present', `To work with ${address} its original provider configuration at provider["registry.terraform.io/${source}"].${r.provider.alias} is required, but it has been removed. This occurs when a provider configuration is removed while objects created by that provider still exist in the state. Re-add the provider configuration to destroy ${address}, after which you can remove the provider configuration again.`, r.pos)]);
    }
    const config: ValObject = {};
    if (block) {
      const scope = scopeFor(run, block.t, {});
      for (const [name, a] of Object.entries(block.p.body.attrs)) {
        if (name === 'alias') continue;
        if (!def.config[name]) {
          throw new DiagError([err('Unsupported argument', `An argument named "${name}" is not expected here.`, a.pos, { context: `provider "${block.p.name}"` })]);
        }
        let v: Val;
        try {
          v = evaluate(a.expr, scope);
        } catch (e) {
          if (!(e instanceof Skip)) throw e;
          v = UNKNOWN;
        }
        if (hasUnknown(v)) throw new DiagError([err('Invalid provider configuration', `The configuration for provider["registry.terraform.io/${source}"] depends on values that cannot be determined until apply.`, a.pos)]);
        config[name] = v;
      }
    }
    if (source === 'netlab/netcloud') {
      config.region ??= run.env.env.NETCLOUD_REGION ?? null;
      config.token ??= run.env.env.NETCLOUD_TOKEN ?? null;
    }
    const ctx: ProviderCtx = {
      lx: run.env.lx,
      cloud: run.env.cloud,
      config,
      version,
      cwd: run.env.cwd,
      address,
      seed: '',
      log: (line) => {
        const m = /^\[(\w+)\]\s*(.*)$/.exec(line);
        run.env.log((m?.[1] ?? 'DEBUG') as 'DEBUG', m ? m[2] : line);
      },
    };
    entry = { ctx, def, source, pos: block?.p.pos };
    run.env.log('DEBUG', `provider: starting plugin: path=.terraform/providers/registry.terraform.io/${source}/${version}/linux_amd64/terraform-provider-${def.type}_v${version}_x5`);
    try {
      def.configure?.(ctx);
    } catch (e) {
      if (e instanceof ProviderError) entry.error = e;
      else throw e;
    }
    run.providers.set(key, entry);
  }
  if (entry.error) {
    throw new DiagError([err(entry.error.summary, entry.error.detail, entry.pos, { subject: entry.pos ? undefined : `provider["registry.terraform.io/${source}"]`, context: entry.pos ? `provider "${r.provider.name}"` : undefined })]);
  }
  return { ...entry.ctx!, address };
}

function seedFor(run: Run, addr: string): string {
  return `${run.prior.lineage}|${run.prior.serial}|${addr}|${run.env.lx.clock}`;
}

// ---------------------------------------------------------------------------
// decoding resource bodies

function decodeBody(run: Run, body: Body, def: { attrs: ResourceDef['attrs']; blocks?: Record<string, BlockDef> }, scope: Scope, context: string): { cfg: ValObject; sensitive: Set<string> } {
  const cfg: ValObject = {};
  const sensitive = new Set<string>();
  const failures: Diag[] = [];
  for (const [name, ad] of Object.entries(def.attrs)) {
    const a = body.attrs[name];
    if (!a || !(ad.required || ad.optional)) {
      cfg[name] = null;
      if (ad.sensitive) sensitive.add(name);
      continue;
    }
    const marks = NO_MARKS();
    let v: Val;
    try {
      v = evaluate(a.expr, scope, marks);
    } catch (e) {
      if (e instanceof DiagError) {
        failures.push(...e.diags.map((d) => ({ ...d, context: d.context ?? context })));
        continue;
      }
      throw e;
    }
    try {
      v = convert(v, ad.type);
    } catch (e) {
      if (e instanceof ConvertError) {
        failures.push(err('Incorrect attribute value type', `Inappropriate value for attribute "${name}": ${e.message}.`, a.pos, { context }));
        continue;
      }
      throw e;
    }
    if (marks.ephemeral && !ad.writeOnly) {
      failures.push(err('Invalid use of ephemeral value', `Ephemeral values are not valid for "${name}", because it is not a write-only attribute and must be persisted to state.`, a.pos, { context }));
      continue;
    }
    if (marks.sensitive || ad.sensitive) sensitive.add(name);
    cfg[name] = v;
  }
  for (const [bname, bd] of Object.entries(def.blocks ?? {})) {
    const items: Val[] = [];
    let unknown = false;
    for (const b of body.blocks) {
      if (b.type === bname) {
        const r = decodeBody(run, b.body, { attrs: bd.attrs }, scope, bname);
        items.push(r.cfg);
      } else if (b.type === 'dynamic' && b.labels[0] === bname) {
        const fe = b.body.attrs.for_each;
        const content = b.body.blocks.find((x) => x.type === 'content');
        if (!fe || !content) continue;
        const it = b.body.attrs.iterator?.expr;
        const iter = it && it.k === 'var' ? it.name : bname;
        let coll: Val;
        try {
          coll = evaluate(fe.expr, scope);
        } catch (e) {
          if (e instanceof DiagError) {
            failures.push(...e.diags);
            continue;
          }
          throw e;
        }
        if (isUnknown(coll)) {
          unknown = true;
          continue;
        }
        const entries: Array<[Val, Val]> = Array.isArray(coll) ? coll.map((v, i) => [isSet(coll) ? v : i, v]) : isObj(coll) ? Object.entries(coll) : [];
        if (!Array.isArray(coll) && !isObj(coll)) failures.push(err('Invalid dynamic for_each value', `Cannot use a ${typeName(coll)} value in for_each. An iterable collection is required.`, fe.pos));
        for (const [key, value] of entries) {
          const inner: Scope = { ...scope, locals: { ...(scope.locals ?? {}), [iter]: { key, value } } };
          const r = decodeBody(run, content.body, { attrs: bd.attrs }, inner, `dynamic "${bname}"`);
          items.push(r.cfg);
        }
      }
    }
    for (const item of items) for (const [k, d] of Object.entries(bd.attrs)) if (isObj(item) && item[k] === null && d.default !== undefined) item[k] = d.default;
    cfg[bname] = unknown ? UNKNOWN : bd.nesting === 'single' ? items[0] ?? null : items;
  }
  if (failures.length) throw new DiagError(failures);
  return { cfg, sensitive };
}

function withDefaults(def: ResourceDef | DataDef, cfg: ValObject): ValObject {
  const out = { ...cfg };
  for (const [k, d] of Object.entries(def.attrs)) if ((out[k] === null || out[k] === undefined) && d.default !== undefined) out[k] = d.default;
  return out;
}

function registerSensitive(obj: ValObject, names: Iterable<string>): ValObject {
  const set = new Set(names);
  if (set.size) SENSITIVE_ATTRS.set(obj, set);
  return obj;
}

// ---------------------------------------------------------------------------
// expansion

type Expansion = Array<{ key?: number | string; inst: InstCtx }>;

function expand(run: Run, tree: ModuleTree, r: ResourceConfig): Expansion {
  const scope = scopeFor(run, tree, {});
  const context = resourceContext(r);
  if (r.count) {
    const v = evaluate(r.count.expr, scope);
    if (isUnknown(v)) throw new DiagError([err('Invalid count argument', 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.', r.count.pos, { context })]);
    const n = typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new DiagError([err('Invalid count argument', 'The given "count" argument value is unsuitable: must be a whole number, greater than or equal to zero.', r.count.pos, { context })]);
    return Array.from({ length: n }, (_, i) => ({ key: i, inst: { countIndex: i } }));
  }
  if (r.forEach) {
    const marks = NO_MARKS();
    const v = evaluate(r.forEach.expr, scope, marks);
    if (hasUnknown(v)) throw new DiagError([err('Invalid for_each argument', 'The "for_each" map includes keys or set values that cannot be determined until apply, so Terraform cannot determine the full set of instances that will be created. To work around this, use the -target argument to first apply only the resources that the for_each value depends on.', r.forEach.pos, { context })]);
    if (marks.sensitive) throw new DiagError([err('Invalid for_each argument', 'Sensitive values, or values derived from sensitive values, cannot be used as for_each arguments. If used, the sensitive value could be exposed as a resource instance key.', r.forEach.pos, { context })]);
    if (v === null) throw new DiagError([err('Invalid for_each argument', 'The given "for_each" argument value is unsuitable: the given "for_each" argument value is null. A map, or set of strings is allowed.', r.forEach.pos, { context })]);
    if (Array.isArray(v)) {
      if (!isSet(v)) {
        const desc = typeName(v) === 'list' && v.every((x) => typeof x === 'string') ? 'list of string' : typeName(v);
        throw new DiagError([err('Invalid for_each argument', `The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${desc}.`, r.forEach.pos, { context })]);
      }
      if (!v.every((x) => typeof x === 'string')) throw new DiagError([err('Invalid for_each set argument', 'The given "for_each" argument value is unsuitable: "for_each" supports sets of strings, but you have provided a set containing other types.', r.forEach.pos, { context })]);
      return (v as string[]).map((k) => ({ key: k, inst: { each: { key: k, value: k } } }));
    }
    if (isObj(v)) return Object.keys(v).sort().map((k) => ({ key: k, inst: { each: { key: k, value: v[k] } } }));
    throw new DiagError([err('Invalid for_each argument', `The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${typeName(v)}.`, r.forEach.pos, { context })]);
  }
  return [{ inst: {} }];
}

// ---------------------------------------------------------------------------
// the walk

function evalConditions(run: Run, tree: ModuleTree, conds: Condition[], inst: InstCtx, summary: string, context: string, subject?: string): boolean {
  let ok = true;
  for (const c of conds) {
    const scope = scopeFor(run, tree, inst);
    const v = evaluate(c.condition, scope);
    if (isUnknown(v)) continue;
    if (v !== true) {
      const msg = evaluate(c.message, scope);
      run.diags.push(err(summary, `${isUnknown(msg) ? 'The error message is not yet known.' : String(msg)}\n\nThis was checked by the ${summary.includes('post') ? 'postcondition' : 'precondition'} at ${c.pos.file}:${c.pos.line},${c.pos.col}.`, c.condition.pos, { context, subject }));
      ok = false;
    }
  }
  return ok;
}

function nodeFailed(run: Run, n: Node): boolean {
  return [...n.deps].some((d) => run.failed.has(d));
}

function walk(run: Run) {
  for (const id of run.orderIds) {
    const n = run.nodes.get(id)!;
    if (nodeFailed(run, n)) {
      run.failed.add(id);
      continue;
    }
    try {
      switch (n.kind) {
        case 'provider':
          break;
        case 'var':
          evalModuleVariable(run, n);
          break;
        case 'local': {
          const v = evaluate(n.tree.config.locals[n.name].expr, scopeFor(run, n.tree, {}));
          run.vals.get(n.tree.key)!.locals[n.name] = v;
          break;
        }
        case 'resource':
          walkResource(run, n);
          break;
        case 'output':
          walkOutput(run, n);
          break;
      }
    } catch (e) {
      run.failed.add(id);
      // A destroy plan evaluates what it can; values of things about to go may not exist.
      if (run.opts.mode === 'destroy' && n.kind !== 'provider' && n.kind !== 'var') continue;
      if (e instanceof DiagError) run.diags.push(...e.diags);
      else if (!(e instanceof Skip)) throw e;
    }
  }
}

function evalModuleVariable(run: Run, n: Node) {
  const t = n.tree;
  const vals = run.vals.get(t.key)!;
  if (!t.call) {
    if (!(n.name in vals.vars)) throw new Skip();
    return;
  }
  const v = t.config.variables[n.name];
  const parent = findParent(run.tree, t)!;
  const input = t.call.inputs[n.name];
  let value: Val = null;
  const marks = NO_MARKS();
  if (input) value = evaluate(input.expr, scopeFor(run, parent, {}), marks);
  else if (v.default) value = evaluate(v.default, scopeFor(run, t, {}));
  if (v.type) {
    try {
      value = convert(value, v.type);
    } catch (e) {
      if (e instanceof ConvertError) throw new DiagError([err('Invalid value for input variable', `The given value is not suitable for module.${t.call.name}.var.${v.name} declared at ${v.pos.file}:${v.pos.line},${v.pos.col}: ${e.message}.`, input?.pos ?? t.call.pos, { context: `module "${t.call.name}"` })]);
      throw e;
    }
  }
  if (value && typeof value === 'object' && (marks.sensitive || v.sensitive)) SENSITIVE_VALUES.add(value);
  vals.vars[n.name] = value;
  validateVariables(run, { ...t, config: { ...t.config, variables: { [v.name]: v } } });
}

function walkOutput(run: Run, n: Node) {
  const t = n.tree;
  const o = t.config.outputs[n.name];
  const vals = run.vals.get(t.key)!;
  const context = `output "${o.name}"`;
  if (!evalConditions(run, t, o.preconditions, {}, 'Module output value precondition failed', context)) throw new Skip();
  if (!o.value) return;
  const marks = NO_MARKS();
  let v = evaluate(o.value, scopeFor(run, t, {}), marks);
  if (run.opts.mode === 'destroy' && run.phase === 'apply') v = null;
  if (!t.key) {
    if (marks.sensitive && !o.sensitive) {
      throw new DiagError([err('Output refers to sensitive values', 'To reduce the risk of accidentally exporting sensitive data that was intended to be only internal, Terraform requires that any root module output containing sensitive data be explicitly marked as sensitive, to confirm your intent.\n\nIf you do intend to export this data, annotate the output value as sensitive by adding the following argument:\n    sensitive = true', o.pos, { context })]);
    }
    if (marks.ephemeral && !o.ephemeral) {
      throw new DiagError([err('Ephemeral value not allowed', 'This output value is not declared as returning an ephemeral value, so it cannot be set to a result derived from an ephemeral value.', o.value.pos, { context })]);
    }
  }
  vals.outputs[o.name] = v;
  if (marks.sensitive || o.sensitive) vals.sensitiveOutputs.add(o.name);
}

function targeted(run: Run, addr: string, nodeId: string): boolean {
  if (!run.opts.targets.length) return true;
  return run.opts.targets.some((t) => addr === t || addr.startsWith(t + '[') || addr.startsWith(t + '.') || targetClosure(run).has(nodeId));
}

let closureCache: WeakMap<Run, Set<string>> = new WeakMap();
function targetClosure(run: Run): Set<string> {
  let s = closureCache.get(run);
  if (s) return s;
  s = new Set();
  const visit = (id: string) => {
    if (s!.has(id)) return;
    s!.add(id);
    for (const d of run.nodes.get(id)?.deps ?? []) visit(d);
  };
  for (const t of run.opts.targets) {
    const p = parseAddress(t);
    if (!p) continue;
    const id = `${p.module}|res.${p.mode === 'data' ? 'data.' : ''}${p.type}.${p.name}`;
    visit(id);
  }
  closureCache.set(run, s);
  return s;
}

function changedAttrs(def: ResourceDef, prior: ValObject, next: ValObject, ignore: string[] | 'all'): { changed: string[]; forceNew: string[] } {
  const changed: string[] = [];
  const forceNew: string[] = [];
  const names = [...Object.keys(def.attrs), ...Object.keys(def.blocks ?? {})];
  for (const name of names) {
    const ad = def.attrs[name];
    const bd = def.blocks?.[name];
    if (ad && !(ad.required || ad.optional)) continue;
    if (ad?.writeOnly) continue;
    if (ignore === 'all' || ignore.includes(name)) continue;
    const a = prior[name] ?? null;
    const b = next[name] ?? null;
    if (!equal(a, b) || isUnknown(b)) {
      changed.push(name);
      if (ad?.forceNew || bd?.forceNew) forceNew.push(name);
    }
  }
  return { changed, forceNew };
}

function walkResource(run: Run, n: Node) {
  const t = n.tree;
  const r = n.resource!;
  const vals = run.vals.get(t.key)!;
  const source = providerSourceFor(t.config, run.tree.config, r.provider.name);
  const def = providerDef(source)!;
  const version = def.builtin ? TF_VERSION : run.lock[source]?.version ?? def.versions[def.versions.length - 1];
  const schema = schemaFor(r, def, version)!;
  const context = resourceContext(r);
  const resKey = r.mode === 'managed' ? `${r.type}.${r.name}` : `${r.mode === 'data' ? 'data' : 'ephemeral'}.${r.type}.${r.name}`;
  const base = (t.key ? t.key + '.' : '') + (r.mode === 'managed' ? `${r.type}.${r.name}` : `data.${r.type}.${r.name}`);

  // A destroy run only needs what the providers need; resources become null.
  const expansion = expand(run, t, r);
  const valuesByKey: Array<{ key?: number | string; value: Val }> = [];
  const deps = [...resourceDeps(run, n.id)].sort();
  const wanted = new Set<string>();

  for (const { key, inst } of expansion) {
    const addr = r.mode === 'ephemeral' ? `ephemeral.${r.type}.${r.name}${keyText(key)}` : base + keyText(key);
    wanted.add(addr);
    const scope = scopeFor(run, t, inst);

    if (r.mode === 'ephemeral') {
      const { cfg } = decodeBody(run, r.body, schema, scope, context);
      const ctx = getProvider(run, t, r, addr);
      if (hasUnknown(cfg)) {
        valuesByKey.push({ key, value: UNKNOWN });
        continue;
      }
      run.env.out(`${addr}: Opening...`);
      const opened = (schema as DataDef).read(withDefaults(schema as DataDef, cfg), { ...ctx, seed: seedFor(run, addr) + run.phase });
      run.env.out(`${addr}: Opening complete after 0s`);
      run.env.out(`${addr}: Closing...`);
      run.env.out(`${addr}: Closing complete after 0s`);
      const obj = registerSensitive({ ...opened }, Object.entries(schema.attrs).filter(([, d]) => d.sensitive).map(([k]) => k));
      EPHEMERAL.add(obj);
      valuesByKey.push({ key, value: obj });
      continue;
    }

    if (r.mode === 'data') {
      const { cfg, sensitive } = decodeBody(run, r.body, schema, scope, context);
      if (!evalConditions(run, t, r.lifecycle.preconditions, inst, 'Resource precondition failed', context)) throw new Skip();
      const already = run.insts.get(addr);
      if (run.phase === 'apply' && !run.changes.has(addr) && already) {
        valuesByKey.push({ key, value: registerSensitive({ ...already.attrs }, sensitive) });
        continue;
      }
      if (hasUnknown(cfg)) {
        const planned: ValObject = {};
        for (const [k, d] of Object.entries(schema.attrs)) planned[k] = cfg[k] !== null && cfg[k] !== undefined ? cfg[k] : d.computed ? UNKNOWN : null;
        run.changes.set(addr, { addr, module: t.key, mode: 'data', type: r.type, name: r.name, key, action: 'read', cbd: false, before: null, after: planned, forceNew: [], reason: 'deferred-read', sensitive: [...sensitive], writeOnly: [], providerSource: source, deps });
        valuesByKey.push({ key, value: registerSensitive(planned, sensitive) });
        continue;
      }
      const ctx = getProvider(run, t, r, addr);
      run.env.out(`${addr}: Reading...`);
      let read: ValObject;
      try {
        read = (schema as DataDef).read(withDefaults(schema as DataDef, cfg), ctx);
      } catch (e) {
        if (e instanceof ProviderError) throw new DiagError([err(e.summary, e.detail, r.pos, { context, subject: addr })]);
        throw e;
      }
      run.env.out(`${addr}: Read complete after 0s${read.id !== undefined && read.id !== null ? ` [id=${read.id}]` : ''}`);
      run.insts.set(addr, { addr, module: t.key, mode: 'data', type: r.type, name: r.name, key, provider: providerAddr(source), attrs: read, deps: [], sensitive: [...sensitive] });
      valuesByKey.push({ key, value: registerSensitive({ ...read }, sensitive) });
      continue;
    }

    // managed resource
    const rdef = schema as ResourceDef;
    const writeOnly = Object.entries(rdef.attrs).filter(([, d]) => d.writeOnly).map(([k]) => k);
    const prior = run.insts.get(addr) ?? null;

    if (run.phase === 'plan') {
      if (run.opts.mode === 'refresh-only') {
        valuesByKey.push({ key, value: prior ? registerSensitive({ ...prior.attrs }, prior.sensitive) : UNKNOWN });
        continue;
      }
      if (run.opts.mode === 'destroy') {
        valuesByKey.push({ key, value: prior ? registerSensitive({ ...prior.attrs }, prior.sensitive) : null });
        continue;
      }
      if (!targeted(run, addr, n.id)) {
        if (prior) valuesByKey.push({ key, value: registerSensitive({ ...prior.attrs }, prior.sensitive) });
        continue;
      }
      const decoded = decodeBody(run, r.body, rdef, scope, context);
      const cfg = withDefaults(rdef, decoded.cfg);
      const sensitive = new Set([...decoded.sensitive, ...Object.entries(rdef.attrs).filter(([, d]) => d.sensitive).map(([k]) => k)]);
      evalConditions(run, t, r.lifecycle.preconditions, inst, 'Resource precondition failed', context, addr);

      // Import blocks: adopt an existing object before comparing.
      let before = prior?.attrs ?? null;
      let importId: string | undefined;
      const imp = !t.key ? run.tree.config.imports.find((i) => i.to === addr) : undefined;
      if (imp && !prior) {
        const idv = evaluate(imp.id, scopeFor(run, run.tree, {}));
        if (typeof idv !== 'string') throw new DiagError([err('Invalid import id argument', 'The import ID must be a known string.', imp.pos, { context: 'import' })]);
        if (!rdef.importable || !rdef.import) throw new DiagError([err(`resource ${r.type} doesn't support import`, '', imp.pos, { context: 'import' })]);
        const ctx = getProvider(run, t, r, addr);
        run.env.out(`${addr}: Preparing import... [id=${idv}]`);
        run.env.out(`${addr}: Refreshing state... [id=${idv}]`);
        const got = rdef.import(idv, ctx);
        if (!got) {
          throw new DiagError([err('Cannot import non-existent remote object', `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`, imp.pos, { context: 'import' })]);
        }
        before = got;
        importId = idv;
      }

      let action: Action;
      let after: ValObject;
      let forceNew: string[] = [];
      let reason: Change['reason'];
      const planned = (): ValObject => {
        const out: ValObject = {};
        const known = rdef.planKnown?.(cfg, getProviderSafe(run, t, r, addr)) ?? {};
        for (const [k, d] of Object.entries(rdef.attrs)) {
          if (d.writeOnly) out[k] = null;
          else if (cfg[k] !== null && cfg[k] !== undefined) out[k] = cfg[k];
          else if (k in known && known[k] !== null) out[k] = known[k];
          else out[k] = d.computed ? UNKNOWN : null;
        }
        for (const b of Object.keys(rdef.blocks ?? {})) out[b] = cfg[b] ?? [];
        return out;
      };
      if (!before) {
        action = 'create';
        after = planned();
      } else {
        const next: ValObject = { ...cfg };
        // Optional+computed arguments left unset keep the value the provider chose.
        for (const [k, d] of Object.entries(rdef.attrs)) if ((next[k] === null || next[k] === undefined) && d.computed && d.optional) next[k] = before[k] ?? null;
        const ignore = r.lifecycle.ignoreChanges;
        const { changed, forceNew: fn } = changedAttrs(rdef, before, next, ignore);
        // A write-only argument is only sent again when its version attribute changes.
        const replaceRequested = run.opts.replace.includes(addr);
        const triggered = r.lifecycle.replaceTriggeredBy.some((e) => {
          const target = exprAddress(e);
          if (!target) return false;
          const p = parseAddress(target.split('.').slice(0, target.startsWith('data.') ? 3 : 2).join('.').replace(/\[.*$/, ''));
          if (!p) return false;
          const prefix = (t.key ? t.key + '.' : '') + `${p.type}.${p.name}`;
          return [...run.changes.values()].some((c) => (c.addr === prefix || c.addr.startsWith(prefix + '[')) && ['update', 'replace', 'create'].includes(c.action) && !(c.action === 'create' && !c.before));
        });
        if (prior?.status === 'tainted') {
          action = 'replace';
          reason = 'tainted';
        } else if (replaceRequested) {
          action = 'replace';
          reason = 'requested';
        } else if (triggered) {
          action = 'replace';
          reason = 'triggered';
        } else if (fn.length) {
          action = 'replace';
          forceNew = fn;
        } else if (changed.length) action = 'update';
        else action = 'noop';
        if (action === 'replace') {
          after = planned();
        } else {
          after = { ...before };
          for (const k of changed) after[k] = next[k];
          for (const k of writeOnly) after[k] = null;
          if (ignore !== 'all') for (const k of Object.keys(rdef.attrs)) if (ignore.includes(k)) after[k] = before[k];
        }
      }
      if (r.lifecycle.preventDestroy && (action === 'replace')) {
        throw new DiagError([err('Instance cannot be destroyed', `Resource ${addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, r.pos, { context })]);
      }
      run.changes.set(addr, { addr, module: t.key, mode: 'managed', type: r.type, name: r.name, key, action, cbd: r.lifecycle.createBeforeDestroy, before, after, forceNew, reason, importId, sensitive: [...sensitive], writeOnly, providerSource: source, deps });
      const obj = registerSensitive({ ...after }, sensitive);
      if (action === 'noop' || action === 'update') evalConditions(run, t, r.lifecycle.postconditions, { ...inst, self: obj }, 'Resource postcondition failed', context, addr);
      valuesByKey.push({ key, value: obj });
      continue;
    }

    // apply phase
    const change = run.changes.get(addr);
    const pendingImport = change?.importId !== undefined && !run.insts.has(addr);
    if (!pendingImport && (!change || change.action === 'noop' || change.action === 'delete' || run.opts.mode !== 'normal')) {
      const cur = run.insts.get(addr);
      if (cur) {
        const obj = registerSensitive({ ...cur.attrs }, cur.sensitive);
        if (change?.action === 'noop') evalConditions(run, t, r.lifecycle.postconditions, { ...inst, self: obj }, 'Resource postcondition failed', context, addr);
        valuesByKey.push({ key, value: obj });
      }
      continue;
    }
    const decoded = decodeBody(run, r.body, rdef, scope, context);
    const cfg = withDefaults(rdef, decoded.cfg);
    const sensitive = new Set([...decoded.sensitive, ...Object.entries(rdef.attrs).filter(([, d]) => d.sensitive).map(([k]) => k)]);
    const ctx = { ...getProvider(run, t, r, addr), seed: seedFor(run, addr) };
    let result: ValObject;
    const timing = durationFor(r.type);
    try {
      if (change.importId !== undefined && !run.insts.get(addr)) {
        run.env.out(`${addr}: Importing... [id=${change.importId}]`);
        const got = rdef.import!(change.importId, ctx);
        if (!got) throw new ProviderError('Cannot import non-existent remote object', `The object ${change.importId} no longer exists.`);
        run.env.out(`${addr}: Import complete [id=${change.importId}]`);
        run.insts.set(addr, { addr, module: t.key, mode: 'managed', type: r.type, name: r.name, key, provider: providerAddr(source), attrs: got, deps, sensitive: [...sensitive] });
        run.applied.imported++;
      }
      if (change.action === 'noop') {
        result = run.insts.get(addr)!.attrs;
      } else if (change.action === 'create' || change.action === 'replace') {
        run.env.out(`${addr}: Creating...`);
        for (const s of timing.still) run.env.out(`${addr}: Still creating... [${s} elapsed]`);
        result = rdef.create(cfg, ctx);
        run.env.out(`${addr}: Creation complete after ${timing.total}${result.id !== undefined && result.id !== null ? ` [id=${result.id}]` : ''}`);
        if (change.action === 'create') run.applied.added++;
        else run.applied.added++;
        if (change.action === 'replace' && change.cbd) {
          const old = run.insts.get(addr);
          if (old) deposed.push({ inst: old, def: rdef, ctx, change });
        }
      } else {
        const cur = run.insts.get(addr)!;
        run.env.out(`${addr}: Modifying... [id=${cur.attrs.id}]`);
        const next: ValObject = { ...cfg };
        for (const [k, d] of Object.entries(rdef.attrs)) if ((next[k] === null || next[k] === undefined) && (d.computed || (cur.attrs[k] ?? null) === null)) delete next[k];
        const ignore = r.lifecycle.ignoreChanges;
        if (ignore === 'all') for (const k of Object.keys(next)) delete next[k];
        else for (const k of ignore) delete next[k];
        result = rdef.update ? rdef.update(cur.attrs, next, ctx) : { ...cur.attrs, ...next };
        run.env.out(`${addr}: Modifications complete after ${timing.update} [id=${result.id}]`);
        run.applied.changed++;
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        throw new DiagError([err(e.summary, e.detail, r.pos, { context, subject: addr })]);
      }
      throw e;
    }
    run.insts.set(addr, { addr, module: t.key, mode: 'managed', type: r.type, name: r.name, key, provider: providerAddr(source), attrs: result, deps, cbd: r.lifecycle.createBeforeDestroy || undefined, sensitive: [...sensitive].filter((s) => s in result) });
    const obj = registerSensitive({ ...result }, sensitive);
    evalConditions(run, t, r.lifecycle.postconditions, { ...inst, self: obj }, 'Resource postcondition failed', context, addr);
    valuesByKey.push({ key, value: obj });
  }

  // Instances in state that this configuration no longer produces.
  if (r.mode === 'managed' && run.phase === 'plan' && run.opts.mode === 'normal') {
    for (const inst of run.insts.values()) {
      if (inst.mode !== 'managed' || inst.module !== t.key || inst.type !== r.type || inst.name !== r.name || wanted.has(inst.addr)) continue;
      if (!targeted(run, inst.addr, n.id)) continue;
      const reason: Change['reason'] = typeof inst.key === 'number' ? 'count-index' : inst.key !== undefined ? 'each-key' : r.count || r.forEach ? 'count-index' : 'not-in-config';
      if (r.lifecycle.preventDestroy) {
        run.diags.push(err('Instance cannot be destroyed', `Resource ${inst.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, r.pos, { context }));
      }
      run.changes.set(inst.addr, { addr: inst.addr, module: t.key, mode: 'managed', type: inst.type, name: inst.name, key: inst.key, action: 'delete', cbd: false, before: inst.attrs, after: null, forceNew: [], reason, sensitive: inst.sensitive, writeOnly: [], providerSource: source, deps: inst.deps });
    }
  }

  let value: Val;
  if (r.count) value = valuesByKey.map((x) => x.value);
  else if (r.forEach) value = Object.fromEntries(valuesByKey.map((x) => [String(x.key), x.value]));
  else value = valuesByKey[0]?.value ?? null;
  vals.resources[resKey] = value;
}

function getProviderSafe(run: Run, t: ModuleTree, r: ResourceConfig, addr: string): ProviderCtx {
  try {
    return getProvider(run, t, r, addr);
  } catch {
    return { lx: run.env.lx, cloud: run.env.cloud, config: { region: run.env.env.NETCLOUD_REGION ?? null }, version: '', cwd: run.env.cwd, address: addr, seed: '', log: () => undefined };
  }
}

const deposed: Array<{ inst: Inst; def: ResourceDef; ctx: ProviderCtx; change: Change }> = [];

function durationFor(type: string): { total: string; update: string; still: string[] } {
  switch (type) {
    case 'netcloud_instance':
      return { total: '12s', update: '8s', still: ['00m10s'] };
    case 'netcloud_database':
      return { total: '4m12s', update: '1m3s', still: ['00m10s', '00m20s', '00m30s'] };
    case 'netcloud_firewall':
      return { total: '2s', update: '1s', still: [] };
    case 'netcloud_network':
    case 'netcloud_subnet':
    case 'netcloud_bucket':
      return { total: '1s', update: '1s', still: [] };
    default:
      return { total: '0s', update: '0s', still: [] };
  }
}

// ---------------------------------------------------------------------------
// run lifecycle

export function newRun(env: RunEnv, opts: RunOptions, tree: ModuleTree, sources: Record<string, string>, prior: StateFile | null, lock: Record<string, LockEntry>): Run {
  const base = prior ?? emptyState(`${env.cwd}|${env.workspace}|${env.lx.hostname}|${env.lx.clock}`);
  const insts = flatten(prior);
  return {
    env,
    opts,
    tree,
    sources,
    diags: [],
    warnings: allTrees(tree).flatMap((t) => t.config.warnings),
    lock,
    prior: base,
    insts: new Map([...insts].map(([k, v]) => [k, { ...v, attrs: { ...v.attrs } }])),
    priorInsts: insts,
    changes: new Map(),
    drift: [],
    moved: [],
    outputs: [],
    vals: new Map([['', { vars: {}, locals: {}, outputs: {}, sensitiveOutputs: new Set(), resources: {} }]]),
    nodes: new Map(),
    orderIds: [],
    providers: new Map(),
    phase: 'plan',
    failed: new Set(),
    applied: { added: 0, changed: 0, destroyed: 0, imported: 0 },
    rootVars: {},
    checkWarnings: [],
  };
}

function applyMoves(run: Run) {
  for (const m of run.tree.config.moved) {
    const from = parseAddress(m.from);
    const to = parseAddress(m.to);
    if (!from || !to) continue;
    const moveOne = (fromAddr: string, toAddr: string) => {
      const inst = run.insts.get(fromAddr);
      if (!inst) return;
      if (run.insts.has(toAddr)) {
        run.warnings.push({ severity: 'warning', summary: 'Unresolved resource instance address changes', detail: `Terraform tried to adjust resource instance addresses in the prior state based on change information recorded in the configuration, but some adjustments did not succeed due to existing objects already at the intended addresses:\n  - ${fromAddr} could not move to ${toAddr}\n\nTerraform has planned to destroy these objects. If Terraform's proposed changes aren't appropriate, you must first resolve the conflicts using the "terraform state" subcommands and then create a new plan.`, pos: m.pos });
        return;
      }
      const p = parseAddress(toAddr)!;
      run.insts.delete(fromAddr);
      run.insts.set(toAddr, { ...inst, addr: toAddr, module: p.module, type: p.type, name: p.name, key: p.key });
      run.moved.push({ from: fromAddr, to: toAddr });
    };
    if (from.moduleOnly && to.moduleOnly) {
      for (const inst of [...run.insts.values()]) if (inst.module === from.module || inst.module.startsWith(from.module + '.')) moveOne(inst.addr, to.module + inst.addr.slice(from.module.length));
    } else if (from.key === undefined && to.key === undefined) {
      for (const inst of [...run.insts.values()]) {
        if (inst.module === from.module && inst.type === from.type && inst.name === from.name) moveOne(inst.addr, instanceAddr(to.module, to.mode, to.type, to.name, inst.key));
      }
    } else moveOne(instanceAddr(from.module, from.mode, from.type, from.name, from.key), instanceAddr(to.module, to.mode, to.type, to.name, to.key));
  }
}

function refresh(run: Run) {
  for (const inst of [...run.insts.values()]) {
    if (inst.mode !== 'managed') {
      continue;
    }
    const tree = allTrees(run.tree).find((t) => t.key === inst.module);
    const source = inst.provider.replace(/^provider\["(registry\.terraform\.io\/)?/, '').replace(/"\].*$/, '');
    const def = providerDef(source);
    if (!def) continue;
    const version = def.builtin ? TF_VERSION : run.lock[source]?.version ?? def.versions[def.versions.length - 1];
    const rdef = def.resources(version)[inst.type];
    if (!rdef) continue;
    const alias = /\]\.(\w+)$/.exec(inst.provider)?.[1];
    const rc: ResourceConfig = tree?.config.resources[`${inst.type}.${inst.name}`] ?? {
      mode: 'managed',
      type: inst.type,
      name: inst.name,
      provider: { name: def.type, alias, explicit: false },
      body: { attrs: {}, order: [], blocks: [], pos: { file: '', line: 0, col: 0 } },
      dependsOn: [],
      lifecycle: { createBeforeDestroy: false, preventDestroy: false, ignoreChanges: [], replaceTriggeredBy: [], preconditions: [], postconditions: [] },
      pos: { file: '', line: 0, col: 0 },
      file: '',
    };
    let ctx: ProviderCtx;
    try {
      ctx = getProvider(run, tree ?? run.tree, rc, inst.addr);
    } catch (e) {
      if (e instanceof DiagError) {
        run.diags.push(...e.diags);
        return;
      }
      throw e;
    }
    if (inst.attrs.id !== undefined && inst.attrs.id !== null) run.env.out(`${inst.addr}: Refreshing state... [id=${inst.attrs.id}]`);
    const got = rdef.read(inst.attrs, ctx);
    if (!got) {
      run.drift.push({ addr: inst.addr, type: inst.type, name: inst.name, before: inst.attrs, after: null, sensitive: inst.sensitive });
      run.insts.delete(inst.addr);
      continue;
    }
    if (canonical(plain(got)) !== canonical(plain(inst.attrs))) {
      run.drift.push({ addr: inst.addr, type: inst.type, name: inst.name, before: inst.attrs, after: got, sensitive: inst.sensitive });
      run.insts.set(inst.addr, { ...inst, attrs: got });
    }
  }
}

/** Resources in state whose configuration is gone entirely (or whose module is). */
function planOrphans(run: Run) {
  const trees = new Map(allTrees(run.tree).map((t) => [t.key, t]));
  for (const inst of run.insts.values()) {
    if (run.changes.has(inst.addr)) continue;
    const t = trees.get(inst.module);
    const key = inst.mode === 'managed' ? `${inst.type}.${inst.name}` : `data.${inst.type}.${inst.name}`;
    if (t?.config.resources[key]) continue;
    if (inst.mode === 'data') {
      run.insts.delete(inst.addr);
      continue;
    }
    const resAddr = (inst.module ? inst.module + '.' : '') + key;
    const removed = run.tree.config.removed.find((x) => x.from === resAddr || x.from === inst.addr || (inst.module && x.from === inst.module));
    if (run.opts.targets.length && !run.opts.targets.some((x) => inst.addr === x || inst.addr.startsWith(x + '[') || inst.addr.startsWith(x + '.'))) continue;
    run.changes.set(inst.addr, {
      addr: inst.addr,
      module: inst.module,
      mode: 'managed',
      type: inst.type,
      name: inst.name,
      key: inst.key,
      action: removed && !removed.destroy ? 'forget' : 'delete',
      cbd: false,
      before: inst.attrs,
      after: null,
      forceNew: [],
      reason: removed ? 'removed' : t ? 'not-in-config' : 'module-gone',
      sensitive: inst.sensitive,
      writeOnly: [],
      providerSource: inst.provider.replace(/^provider\["(registry\.terraform\.io\/)?/, '').replace(/"\].*$/, ''),
      deps: inst.deps,
    });
  }
  for (const rm of run.tree.config.removed) {
    const p = parseAddress(rm.from);
    if (!p) continue;
    const key = `${p.type}.${p.name}`;
    const t = trees.get(p.module);
    if (t?.config.resources[key]) run.diags.push(err('Removed resource block still exists', `This statement declares that ${rm.from} was removed, but it is still declared in configuration.`, rm.pos, { context: 'removed' }));
  }
}

function planDestroy(run: Run) {
  for (const inst of run.insts.values()) {
    if (inst.mode !== 'managed') continue;
    if (run.opts.targets.length && !run.opts.targets.some((x) => inst.addr === x || inst.addr.startsWith(x + '[') || inst.addr.startsWith(x + '.'))) continue;
    const t = allTrees(run.tree).find((x) => x.key === inst.module);
    const rc = t?.config.resources[`${inst.type}.${inst.name}`];
    if (rc?.lifecycle.preventDestroy) {
      run.diags.push(err('Instance cannot be destroyed', `Resource ${inst.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, rc.pos, { context: resourceContext(rc) }));
    }
    run.changes.set(inst.addr, { addr: inst.addr, module: inst.module, mode: 'managed', type: inst.type, name: inst.name, key: inst.key, action: 'delete', cbd: false, before: inst.attrs, after: null, forceNew: [], sensitive: inst.sensitive, writeOnly: [], providerSource: inst.provider, deps: inst.deps });
  }
}

function planOutputs(run: Run) {
  const vals = run.vals.get('')!;
  const priorOutputs = run.prior.outputs ?? {};
  const names = new Set([...Object.keys(priorOutputs), ...Object.keys(run.tree.config.outputs)]);
  for (const name of [...names].sort()) {
    const o = run.tree.config.outputs[name];
    const before = priorOutputs[name]?.value;
    let after: Val | undefined = o && name in vals.outputs ? vals.outputs[name] : undefined;
    if (run.opts.mode === 'destroy') after = undefined;
    run.outputs.push({ name, before, after, sensitive: Boolean(o?.sensitive || vals.sensitiveOutputs.has(name) || priorOutputs[name]?.sensitive) });
  }
}

function runChecks(run: Run) {
  for (const ch of run.tree.config.checks) {
    for (const a of ch.asserts) {
      try {
        const scope = scopeFor(run, run.tree, {});
        const v = evaluate(a.condition, scope);
        if (isUnknown(v)) continue;
        if (v !== true) {
          const msg = evaluate(a.message, scope);
          run.checkWarnings.push({ severity: 'warning', summary: 'Check block assertion failed', detail: String(msg), pos: a.condition.pos, context: `check "${ch.name}"` });
        }
      } catch (e) {
        if (e instanceof DiagError) run.checkWarnings.push(...e.diags.map((d) => ({ ...d, severity: 'warning' as const })));
        else if (!(e instanceof Skip)) throw e;
      }
    }
  }
}

/** Generate configuration for import targets that have none (terraform plan -generate-config-out). */
function generateImportConfig(run: Run): boolean {
  const missing = run.tree.config.imports.filter((i) => {
    const p = parseAddress(i.to);
    return p && !p.module && !run.tree.config.resources[`${p.type}.${p.name}`];
  });
  if (!missing.length) return false;
  if (!run.opts.generateConfigOut) {
    for (const i of missing) {
      const p = parseAddress(i.to)!;
      run.diags.push(err('Configuration for import target does not exist', `The configuration for the given import target ${i.to} does not exist. If you wish to automatically generate config for this resource, use the -generate-config-out option within terraform plan. Otherwise, make sure the target resource exists within your configuration. For example:\n\n  resource "${p.type}" "${p.name}" {\n    # (resource arguments)\n  }`, i.pos, { context: 'import' }));
    }
    return false;
  }
  const lines = ['# __generated__ by Terraform', '# Please review these resources and move them into your main configuration files.', ''];
  for (const i of missing) {
    const p = parseAddress(i.to)!;
    const source = providerSourceFor(run.tree.config, run.tree.config, p.type.split('_')[0]);
    const def = providerDef(source);
    const version = run.lock[source]?.version;
    const rdef = def && version ? def.resources(version)[p.type] : undefined;
    const idv = evaluate(i.id, scopeFor(run, run.tree, {}));
    if (!rdef || typeof idv !== 'string') continue;
    if (!rdef.import) {
      run.diags.push(err(`resource ${p.type} doesn't support import`, '', i.pos));
      continue;
    }
    const rc: ResourceConfig = { mode: 'managed', type: p.type, name: p.name, provider: { name: p.type.split('_')[0], explicit: false }, body: { attrs: {}, order: [], blocks: [], pos: i.pos }, dependsOn: [], lifecycle: { createBeforeDestroy: false, preventDestroy: false, ignoreChanges: [], replaceTriggeredBy: [], preconditions: [], postconditions: [] }, pos: i.pos, file: '' };
    let ctx: ProviderCtx;
    try {
      ctx = getProvider(run, run.tree, rc, i.to);
    } catch (e) {
      if (e instanceof DiagError) run.diags.push(...e.diags);
      return false;
    }
    const got = rdef.import(idv, ctx);
    if (!got) {
      run.diags.push(err('Cannot import non-existent remote object', `While attempting to import an existing object to "${i.to}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`, i.pos, { context: 'import' }));
      continue;
    }
    lines.push(`# __generated__ by Terraform from "${idv}"`, `resource "${p.type}" "${p.name}" {`);
    const settable = Object.entries(rdef.attrs).filter(([k, d]) => (d.required || d.optional) && !d.writeOnly && k !== 'region').map(([k]) => k).sort();
    const width = Math.max(...settable.map((k) => k.length));
    for (const k of settable) {
      const v = got[k];
      const text = v === null || v === undefined ? 'null' : JSON.stringify(plain(v)).replace(/":/g, '" = ').replace(/,"/g, ', "');
      lines.push(`  ${k.padEnd(width)} = ${Array.isArray(v) && v.length === 0 ? '[]' : isObj(v ?? null) ? hclObject(v as ValObject) : text}`);
    }
    for (const [b] of Object.entries(rdef.blocks ?? {})) {
      for (const item of (got[b] as ValObject[] | null) ?? []) {
        lines.push(`  ${b} {`);
        const keys = Object.keys(item).sort();
        const w = Math.max(...keys.map((k) => k.length));
        for (const k of keys) lines.push(`    ${k.padEnd(w)} = ${JSON.stringify(item[k])}`);
        lines.push('  }');
      }
    }
    lines.push('}', '');
  }
  const path = normalizePath(run.env.cwd, run.opts.generateConfigOut, `/home/${run.env.lx.user}`);
  if (!('error' in fsReadFile(run.env.lx, path))) {
    run.diags.push(err('Target generated file already exists', `Terraform can only write generated config into a new file. Either choose a different target location or move all existing configuration out of the target file, delete it, and try again.`));
    return false;
  }
  const text = lines.join('\n');
  const e = fsWriteFile(run.env.lx, path, text, false, 'terraform');
  if (e) {
    run.diags.push(err('Failed to write generated config', e.error));
    return false;
  }
  run.generated = { file: run.opts.generateConfigOut, text };
  return true;
}

function hclObject(v: ValObject): string {
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  const name = (k: string) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k));
  const w = Math.max(...keys.map((k) => name(k).length));
  return '{\n' + keys.map((k) => `    ${name(k).padEnd(w)} = ${JSON.stringify(v[k])}`).join('\n') + '\n  }';
}

export interface PlanOutcome {
  run?: Run;
  diags: Diag[];
  warnings: Diag[];
  sources: Record<string, string>;
  /** Configuration was generated and the plan should be run again against it. */
  regenerated?: boolean;
}

/**
 * Plan: everything up to and including the change set. No side effects on
 * infrastructure. Data sources are read, and a -generate-config-out file may be written.
 */
export function plan(env: RunEnv, opts: RunOptions, prior: StateFile | null): PlanOutcome {
  const loaded = loadTree(env);
  if (!loaded.tree || loaded.diags.length) return { diags: loaded.diags, warnings: [], sources: loaded.sources };
  const diags: Diag[] = [];
  const lock = checkConfiguration(env, loaded.tree, diags);
  if (diags.length) return { diags, warnings: [], sources: loaded.sources };
  if (opts.validateOnly) return { diags: [], warnings: allTrees(loaded.tree).flatMap((t) => t.config.warnings), sources: loaded.sources };
  deposed.length = 0;
  closureCache = new WeakMap();
  const run = newRun(env, opts, loaded.tree, loaded.sources, prior, lock);
  env.log('INFO', `backend/local: starting ${opts.mode === 'destroy' ? 'Plan (destroy)' : opts.mode === 'refresh-only' ? 'Plan (refresh-only)' : 'Plan'} operation`);
  buildGraph(run);
  if (run.diags.length) return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
  evaluateRootVariables(run);
  if (run.diags.length) return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
  validateVariables(run, run.tree);
  if (run.diags.length) return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
  if (generateImportConfig(run)) return { run, diags: [], warnings: run.warnings, sources: run.sources, regenerated: true };
  if (run.diags.length) return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
  applyMoves(run);
  if (opts.refresh) refresh(run);
  if (run.diags.length) return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
  if (opts.mode === 'destroy') planDestroy(run);
  walk(run);
  if (opts.mode === 'normal') planOrphans(run);
  const resOf = (c: Change) => (c.module ? c.module + '.' : '') + `${c.type}.${c.name}`;
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of run.changes.values()) {
      if (c.action === 'replace' && !c.cbd && [...run.changes.values()].some((d) => d.cbd && d.action === 'replace' && d.deps.includes(resOf(c)))) {
        c.cbd = true;
        grew = true;
      }
    }
  }
  if (!run.diags.length) {
    planOutputs(run);
    runChecks(run);
  }
  env.log('INFO', `backend/local: plan operation completed`);
  return { run, diags: run.diags, warnings: [...run.warnings, ...run.checkWarnings], sources: run.sources };
}

/** Everything a plan does before refreshing: for import, and for commands that need providers. */
export function prepareRun(env: RunEnv, opts: RunOptions, prior: StateFile | null): PlanOutcome {
  const loaded = loadTree(env);
  if (!loaded.tree || loaded.diags.length) return { diags: loaded.diags, warnings: [], sources: loaded.sources };
  const diags: Diag[] = [];
  const lock = checkConfiguration(env, loaded.tree, diags);
  if (diags.length) return { diags, warnings: [], sources: loaded.sources };
  const run = newRun(env, opts, loaded.tree, loaded.sources, prior, lock);
  buildGraph(run);
  if (!run.diags.length) evaluateRootVariables(run);
  if (!run.diags.length) validateVariables(run, run.tree);
  return { run, diags: run.diags, warnings: run.warnings, sources: run.sources };
}

export function hasChanges(run: Run): boolean {
  return [...run.changes.values()].some((c) => c.action !== 'noop') || run.outputs.some((o) => !equal(o.before ?? null, o.after ?? null) || (o.before === undefined) !== (o.after === undefined)) || run.moved.length > 0;
}

/** Order destroys so that anything depending on an object is destroyed before it. */
function destroyOrder(changes: Change[]): Change[] {
  const resOf = (c: Change) => (c.module ? c.module + '.' : '') + `${c.type}.${c.name}`;
  const remaining = [...changes];
  const out: Change[] = [];
  while (remaining.length) {
    const idx = remaining.findIndex((c) => !remaining.some((o) => o !== c && o.deps.includes(resOf(c))));
    const pick = idx === -1 ? 0 : idx;
    out.push(remaining.splice(pick, 1)[0]);
  }
  return out;
}

/** Carry out a plan. Returns the new state (also after a partial failure). */
export function apply(run: Run): StateFile {
  const env = run.env;
  run.phase = 'apply';
  env.log('INFO', 'backend/local: apply calling Apply');
  const all = [...run.changes.values()];
  const resOf = (c: Change) => (c.module ? c.module + '.' : '') + `${c.type}.${c.name}`;
  const destroyedFailed = new Set<string>();
  const destroyOne = (c: Change) => {
    const inst = run.insts.get(c.addr);
    if (!inst) return;
    const source = inst.provider.replace(/^provider\["(registry\.terraform\.io\/)?/, '').replace(/"\].*$/, '');
    const def = providerDef(source);
    const version = def?.builtin ? TF_VERSION : run.lock[source]?.version ?? def?.versions[def.versions.length - 1] ?? '';
    const rdef = def?.resources(version)[inst.type];
    if (!def || !rdef) return;
    const t = allTrees(run.tree).find((x) => x.key === inst.module) ?? run.tree;
    const rc = t.config.resources[`${inst.type}.${inst.name}`] ?? ({ mode: 'managed', type: inst.type, name: inst.name, provider: { name: def.type, alias: /\]\.(\w+)$/.exec(inst.provider)?.[1], explicit: false }, body: { attrs: {}, order: [], blocks: [], pos: { file: '', line: 0, col: 0 } }, dependsOn: [], lifecycle: { createBeforeDestroy: false, preventDestroy: false, ignoreChanges: [], replaceTriggeredBy: [], preconditions: [], postconditions: [] }, pos: { file: '', line: 0, col: 0 }, file: '' } as ResourceConfig);
    try {
      const ctx = getProvider(run, t, rc, c.addr);
      env.out(`${c.addr}: Destroying... [id=${inst.attrs.id}]`);
      const timing = durationFor(inst.type);
      if (timing.still.length) env.out(`${c.addr}: Still destroying... [id=${inst.attrs.id}, ${timing.still[0]} elapsed]`);
      rdef.delete(inst.attrs, ctx);
      env.out(`${c.addr}: Destruction complete after ${timing.total === '0s' ? '0s' : timing.update}`);
      run.insts.delete(c.addr);
      run.applied.destroyed++;
    } catch (e) {
      destroyedFailed.add(c.addr);
      if (e instanceof ProviderError) run.diags.push(err(e.summary, e.detail, undefined, { subject: c.addr }));
      else if (e instanceof DiagError) run.diags.push(...e.diags);
      else throw e;
    }
  };
  // Replacements that destroy first go before the walk, with anything that depends on them
  // and is being removed. Plain removals wait until dependents have stopped using them.
  const early = new Set(all.filter((c) => c.action === 'replace' && !c.cbd));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of all) {
      if (c.action === 'delete' && !early.has(c) && [...early].some((e) => c.deps.includes(resOf(e)))) {
        early.add(c);
        grew = true;
      }
    }
  }
  const pre = run.opts.mode === 'normal' ? destroyOrder([...early]) : destroyOrder(all.filter((c) => c.action === 'delete' || (c.action === 'replace' && !c.cbd)));
  const post = run.opts.mode === 'normal' ? destroyOrder(all.filter((c) => c.action === 'delete' && !early.has(c))) : [];
  for (const c of pre) destroyOne(c);
  for (const c of all) {
    if (c.action === 'forget') {
      run.insts.delete(c.addr);
    }
  }
  if (run.opts.mode === 'normal' && destroyedFailed.size === 0) {
    // Values for the apply walk: data sources and outputs are recomputed from scratch.
    for (const v of run.vals.values()) {
      v.locals = {};
      v.outputs = {};
      v.resources = {};
      v.sensitiveOutputs = new Set();
    }
    // Module variables are re-evaluated; root variables keep their values.
    for (const [k, v] of run.vals) if (k) v.vars = {};
    run.failed = new Set();
    walk(run);
    for (const d of [...deposed].reverse()) {
      env.out(`${d.change.addr} (deposed object): Destroying... [id=${d.inst.attrs.id}]`);
      try {
        d.def.delete(d.inst.attrs, d.ctx);
        env.out(`${d.change.addr} (deposed object): Destruction complete after 1s`);
        run.applied.destroyed++;
      } catch (e) {
        if (e instanceof ProviderError) run.diags.push(err(e.summary, e.detail, undefined, { subject: `${d.change.addr} (deposed object)` }));
        else throw e;
      }
    }
    deposed.length = 0;
    for (const c of post) destroyOne(c);
  } else if (run.opts.mode === 'normal') {
    run.failed = new Set();
  }
  const vals = run.vals.get('')!;
  const outputs: Record<string, { value: Val; sensitive: boolean }> = {};
  if (run.opts.mode !== 'destroy') {
    for (const [name, o] of Object.entries(run.tree.config.outputs)) {
      if (!(name in vals.outputs)) {
        if (run.opts.mode === 'refresh-only' || run.diags.length) {
          const prev = run.prior.outputs?.[name];
          if (prev) outputs[name] = { value: prev.value, sensitive: Boolean(prev.sensitive) };
        }
        continue;
      }
      const v = vals.outputs[name];
      if (hasUnknown(v)) continue;
      outputs[name] = { value: v, sensitive: o.sensitive || vals.sensitiveOutputs.has(name) };
    }
  }
  if (run.opts.mode === 'refresh-only') {
    for (const [name, o] of Object.entries(run.prior.outputs ?? {})) if (!outputs[name] && run.tree.config.outputs[name]) outputs[name] = { value: o.value, sensitive: Boolean(o.sensitive) };
  }
  const next = buildState({ ...run.prior, serial: run.prior.serial + 1 }, run.insts, outputs);
  env.log('INFO', 'backend/local: apply operation completed');
  return next;
}

/** For `terraform console` and `terraform output`: evaluate against the current state without planning. */
export function stateScope(env: RunEnv, prior: StateFile | null): { scope?: Scope; diags: Diag[]; run?: Run } {
  const loaded = loadTree(env);
  if (!loaded.tree) return { diags: loaded.diags };
  if (loaded.diags.length) return { diags: loaded.diags };
  const diags: Diag[] = [];
  const lockRead = readLock(env.lx, env.cwd);
  const lock = 'error' in lockRead ? {} : (lockRead as Record<string, LockEntry>);
  const run = newRun(env, { mode: 'refresh-only', refresh: false, targets: [], replace: [], cliVars: [], varFiles: [], input: false }, loaded.tree, loaded.sources, prior, lock);
  buildGraph(run);
  evaluateRootVariables(run);
  // Missing variables become unknown rather than errors in the console.
  for (const v of Object.values(run.tree.config.variables)) if (!(v.name in run.vals.get('')!.vars)) run.vals.get('')!.vars[v.name] = UNKNOWN;
  run.diags = run.diags.filter((d) => d.summary !== 'No value for required variable');
  diags.push(...run.diags);
  run.diags = [];
  walk(run);
  run.diags = [];
  return { scope: scopeFor(run, run.tree, {}), diags, run };
}

export { hexHash, cmpVersion };
