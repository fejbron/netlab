/**
 * Configuration: reading a directory of .tf files into a module tree, decoding every
 * block Terraform knows, and the static checks `terraform validate` performs (block
 * types, arguments against provider schemas, references to things that do not exist).
 */
import { diag, DiagError, parseHcl, type Attribute, type Block, type Body, type Diag, type Expr, type Pos } from './hcl';
import { references } from './eval';
import { normalizeSource, providerFor, validConstraint, type BlockDef, type ResourceDef } from './providers';
import { T, type TypeSpec, type Val } from './values';

/** Where configuration text comes from: the host's filesystem, or a saved plan's snapshot. */
export interface Source {
  /** Names of the entries in a directory (files only matter here). */
  list(dir: string): string[];
  read(path: string): string | undefined;
}

export interface VariableConfig {
  name: string;
  type?: TypeSpec;
  default?: Expr;
  description?: string;
  sensitive: boolean;
  ephemeral: boolean;
  nullable: boolean;
  validations: Array<{ condition: Expr; message: Expr; pos: Pos }>;
  pos: Pos;
}

export interface Condition {
  condition: Expr;
  message: Expr;
  pos: Pos;
}

export interface OutputConfig {
  name: string;
  value?: Expr;
  sensitive: boolean;
  ephemeral: boolean;
  description?: string;
  dependsOn: Array<{ ref: string; pos: Pos }>;
  preconditions: Condition[];
  pos: Pos;
}

export interface ResourceConfig {
  mode: 'managed' | 'data' | 'ephemeral';
  type: string;
  name: string;
  /** Local provider name and alias, from the type prefix or the provider argument. */
  provider: { name: string; alias?: string; explicit: boolean };
  body: Body;
  count?: Attribute;
  forEach?: Attribute;
  dependsOn: Array<{ ref: string; pos: Pos }>;
  lifecycle: {
    createBeforeDestroy: boolean;
    preventDestroy: boolean;
    ignoreChanges: string[] | 'all';
    replaceTriggeredBy: Expr[];
    preconditions: Condition[];
    postconditions: Condition[];
  };
  pos: Pos;
  file: string;
}

export interface ModuleCallConfig {
  name: string;
  source: string;
  version?: string;
  inputs: Record<string, Attribute>;
  dependsOn: Array<{ ref: string; pos: Pos }>;
  pos: Pos;
}

export interface BackendConfig {
  type: string;
  body: Body;
  pos: Pos;
}

export interface CloudBlockConfig {
  body: Body;
  pos: Pos;
}

export interface ModuleConfig {
  /** Absolute directory on the host. */
  dir: string;
  /** Directory relative to the root module, "." for the root. */
  rel: string;
  requiredVersion?: { constraint: string; pos: Pos };
  requiredProviders: Record<string, { source: string; version?: string; pos: Pos }>;
  backend?: BackendConfig;
  cloud?: CloudBlockConfig;
  providers: Array<{ name: string; alias?: string; body: Body; pos: Pos }>;
  variables: Record<string, VariableConfig>;
  locals: Record<string, { expr: Expr; pos: Pos }>;
  outputs: Record<string, OutputConfig>;
  resources: Record<string, ResourceConfig>;
  modules: Record<string, ModuleCallConfig>;
  imports: Array<{ to: string; id: Expr; pos: Pos }>;
  moved: Array<{ from: string; to: string; pos: Pos }>;
  removed: Array<{ from: string; destroy: boolean; pos: Pos }>;
  checks: Array<{ name: string; asserts: Condition[]; pos: Pos }>;
  /** Raw file text by display name, for diagnostics. */
  files: Record<string, string>;
  /** Warnings found while decoding. */
  warnings: Diag[];
}

export interface ModuleTree {
  /** "" for the root, "module.network" or "module.app.module.db" below it. */
  key: string;
  config: ModuleConfig;
  call?: ModuleCallConfig;
  children: Record<string, ModuleTree>;
}

const TOP_BLOCKS = ['terraform', 'provider', 'variable', 'locals', 'output', 'resource', 'data', 'ephemeral', 'module', 'import', 'moved', 'removed', 'check'];

export function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 4)) ? best : undefined;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function literalString(attr: Attribute | undefined, what: string, errors: Diag[]): string | undefined {
  if (!attr) return undefined;
  if (attr.expr.k === 'lit' && typeof attr.expr.v === 'string') return attr.expr.v;
  errors.push(diag('Invalid ' + what, `The ${what} must be a literal string; variables and expressions are not allowed here.`, attr.pos));
  return undefined;
}

function literalBool(attr: Attribute | undefined, fallback: boolean, errors: Diag[]): boolean {
  if (!attr) return fallback;
  if (attr.expr.k === 'lit' && typeof attr.expr.v === 'boolean') return attr.expr.v;
  errors.push(diag('Unsuitable value type', 'Unsuitable value: a bool is required', attr.pos));
  return fallback;
}

/** "netcloud_network.main" from a traversal expression, or null. */
export function exprAddress(e: Expr): string | null {
  const parts: string[] = [];
  let cur: Expr = e;
  while (true) {
    if (cur.k === 'var') return cur.name + parts.reverse().join('');
    if (cur.k === 'attr') {
      parts.push('.' + cur.name);
      cur = cur.obj;
    } else if (cur.k === 'index') {
      const idx = cur.index;
      if (idx.k !== 'lit') return null;
      parts.push(typeof idx.v === 'number' ? `[${idx.v}]` : `[${JSON.stringify(idx.v)}]`);
      cur = cur.obj;
    } else return null;
  }
}

function fixAddress(addr: string): string {
  return addr;
}

function traversalList(attr: Attribute | undefined, what: string, errors: Diag[]): Array<{ ref: string; pos: Pos }> {
  if (!attr) return [];
  if (attr.expr.k !== 'tuple') {
    errors.push(diag(`Invalid expression`, `A static list expression is required.`, attr.pos));
    return [];
  }
  return attr.expr.items.flatMap((item) => {
    const a = exprAddress(item);
    if (!a) {
      errors.push(diag(`Invalid ${what}`, `A single static variable reference is required: only attribute access and indexing with constant keys. No calculations, function calls, template expressions, etc are allowed here.`, item.pos));
      return [];
    }
    return [{ ref: fixAddress(a), pos: item.pos }];
  });
}

/** Parse a type constraint expression: string, list(string), object({ a = optional(number, 1) }). */
export function parseType(e: Expr, errors: Diag[]): TypeSpec {
  const bad = (): TypeSpec => {
    errors.push(diag('Invalid type specification', 'A type specification is either a primitive type keyword (bool, number, string) or a complex type constructor call, like list(string).', e.pos));
    return T.any;
  };
  if (e.k === 'var') {
    if (['string', 'number', 'bool', 'any'].includes(e.name)) return { t: e.name as 'string' };
    if (['list', 'set', 'map'].includes(e.name)) {
      errors.push(diag('Invalid type specification', `The ${e.name} type constructor requires one argument specifying the element type.`, e.pos));
      return T.any;
    }
    return bad();
  }
  if (e.k === 'call') {
    if (['list', 'set', 'map'].includes(e.name) && e.args.length === 1) return { t: e.name as 'list', of: parseType(e.args[0], errors) };
    if (e.name === 'tuple' && e.args.length === 1 && e.args[0].k === 'tuple') return { t: 'tuple', items: e.args[0].items.map((x) => parseType(x, errors)) };
    if (e.name === 'object' && e.args.length === 1 && e.args[0].k === 'object') {
      const attrs: Record<string, { type: TypeSpec; optional?: boolean; default?: Val }> = {};
      for (const it of e.args[0].items) {
        const name = it.key.k === 'lit' ? String(it.key.v) : it.key.k === 'var' ? it.key.name : '';
        const v = it.value;
        if (v.k === 'call' && v.name === 'optional') {
          const def = v.args[1];
          attrs[name] = { type: parseType(v.args[0], errors), optional: true, default: def && def.k === 'lit' ? def.v : def && (def.k === 'tuple' || def.k === 'object') ? literalValue(def) : undefined };
        } else attrs[name] = { type: parseType(v, errors) };
      }
      return { t: 'object', attrs };
    }
  }
  return bad();
}

function literalValue(e: Expr): Val {
  if (e.k === 'lit') return e.v;
  if (e.k === 'tuple') return e.items.map(literalValue);
  if (e.k === 'object') return Object.fromEntries(e.items.map((it) => [it.key.k === 'lit' ? String(it.key.v) : it.key.k === 'var' ? it.key.name : '', literalValue(it.value)]));
  return null;
}

function conditions(blocks: Block[], type: string, errors: Diag[]): Condition[] {
  return blocks
    .filter((b) => b.type === type)
    .flatMap((b) => {
      const c = b.body.attrs.condition;
      const m = b.body.attrs.error_message;
      if (!c) {
        errors.push(diag('Missing required argument', 'The argument "condition" is required, but no definition was found.', b.pos));
        return [];
      }
      if (!m) {
        errors.push(diag('Missing required argument', 'The argument "error_message" is required, but no definition was found.', b.pos));
        return [];
      }
      return [{ condition: c.expr, message: m.expr, pos: b.pos }];
    });
}

function onlyAttrs(body: Body, allowed: string[], context: string, errors: Diag[]) {
  for (const [name, a] of Object.entries(body.attrs)) {
    if (!allowed.includes(name)) {
      const near = closest(name, allowed);
      errors.push(diag('Unsupported argument', `An argument named "${name}" is not expected here.${near ? ` Did you mean "${near}"?` : ''}`, a.pos, { context }));
    }
  }
}

/** Read and decode every .tf file in one directory. */
export function loadModuleDir(src: Source, dir: string, rel: string): { config: ModuleConfig; errors: Diag[] } {
  const errors: Diag[] = [];
  const config: ModuleConfig = {
    dir,
    rel,
    requiredProviders: {},
    providers: [],
    variables: {},
    locals: {},
    outputs: {},
    resources: {},
    modules: {},
    imports: [],
    moved: [],
    removed: [],
    checks: [],
    files: {},
    warnings: [],
  };
  const names = src.list(dir).filter((n) => n.endsWith('.tf') && !n.startsWith('.')).sort();
  for (const name of names) {
    const text = src.read(`${dir}/${name}`) ?? '';
    const display = rel === '.' ? name : `${rel}/${name}`;
    config.files[display] = text;
    let body: Body;
    try {
      body = parseHcl(text, display);
    } catch (e) {
      if (e instanceof DiagError) {
        errors.push(...e.diags);
        continue;
      }
      throw e;
    }
    decodeFile(config, body, display, errors);
  }
  return { config, errors };
}

function decodeFile(c: ModuleConfig, file: Body, display: string, errors: Diag[]) {
  for (const [, a] of Object.entries(file.attrs)) {
    errors.push(diag('Unsupported argument', `An argument named "${a.name}" is not expected here.`, a.pos));
  }
  for (const b of file.blocks) {
    const labels = (n: number, what: string, names: string): boolean => {
      if (b.labels.length !== n) {
        errors.push(diag(`Missing ${n === 1 ? 'name' : 'name'} for ${what}`, `All ${what} blocks must have ${n} label${n === 1 ? '' : 's'} (${names}).`, b.pos));
        return false;
      }
      return true;
    };
    switch (b.type) {
      case 'terraform': {
        const rv = literalString(b.body.attrs.required_version, 'required_version', errors);
        if (rv !== undefined) c.requiredVersion = { constraint: rv, pos: b.body.attrs.required_version.pos };
        for (const inner of b.body.blocks) {
          if (inner.type === 'required_providers') {
            for (const [name, a] of Object.entries(inner.body.attrs)) {
              if (a.expr.k === 'lit' && typeof a.expr.v === 'string') {
                c.requiredProviders[name] = { source: `hashicorp/${name}`, version: a.expr.v, pos: a.pos };
                c.warnings.push({ severity: 'warning', summary: 'Version constraints inside provider configuration blocks are deprecated', detail: 'Terraform 0.13 and earlier allowed provider version constraints inside the provider configuration block, but that is now deprecated. Use the object form with source and version instead.', pos: a.pos });
              } else if (a.expr.k === 'object') {
                const fields: Record<string, string> = {};
                for (const it of a.expr.items) {
                  const k = it.key.k === 'lit' ? String(it.key.v) : it.key.k === 'var' ? it.key.name : '';
                  if (it.value.k === 'lit' && typeof it.value.v === 'string') fields[k] = it.value.v;
                  else if (k === 'configuration_aliases') continue;
                  else errors.push(diag('Invalid required_providers object', `${k} must be a string.`, it.value.pos));
                }
                if (fields.version && !validConstraint(fields.version)) {
                  errors.push(diag('Invalid version constraint', `This string does not use correct version constraint syntax.`, a.pos));
                }
                c.requiredProviders[name] = { source: fields.source ? normalizeSource(fields.source) : `hashicorp/${name}`, version: fields.version, pos: a.pos };
              } else errors.push(diag('Invalid required_providers object', 'required_providers entries must be objects with source and version.', a.pos));
            }
          } else if (inner.type === 'backend') {
            if (inner.labels.length !== 1) errors.push(diag('Invalid backend block', 'A backend block must have one label: the backend type.', inner.pos));
            else if (c.backend) errors.push(diag('Duplicate backend configuration', `A module may have only one backend configuration. The backend was previously configured at ${c.backend.pos.file}:${c.backend.pos.line}.`, inner.pos));
            else c.backend = { type: inner.labels[0], body: inner.body, pos: inner.pos };
          } else if (inner.type === 'cloud') {
            c.cloud = { body: inner.body, pos: inner.pos };
          } else {
            errors.push(diag('Unsupported block type', `Blocks of type "${inner.type}" are not expected here.`, inner.pos, { context: 'terraform' }));
          }
        }
        if (c.backend && c.cloud) errors.push(diag('Both a backend and HCP Terraform configuration are present', 'A module may declare either one \'cloud\' block or one \'backend\' block configuring a state backend. Remove one of them.', c.cloud.pos));
        break;
      }
      case 'provider': {
        if (!labels(1, 'provider', 'name')) break;
        const alias = literalString(b.body.attrs.alias, 'provider alias', errors);
        if (c.providers.some((p) => p.name === b.labels[0] && p.alias === alias)) {
          errors.push(diag('Duplicate provider configuration', `A default (non-aliased) provider configuration for "${b.labels[0]}" was already given. Each provider can have at most one default configuration; use alias to give the others a name.`, b.pos));
        }
        c.providers.push({ name: b.labels[0], alias, body: b.body, pos: b.pos });
        break;
      }
      case 'variable': {
        if (!labels(1, 'variable', 'name')) break;
        const name = b.labels[0];
        if (['count', 'for_each', 'source', 'version', 'providers', 'locals', 'depends_on', 'lifecycle'].includes(name)) {
          errors.push(diag('Invalid variable name', `The variable name "${name}" is reserved due to its special meaning inside module blocks.`, b.pos));
          break;
        }
        if (c.variables[name]) {
          errors.push(diag('Duplicate variable declaration', `A variable named "${name}" was already declared at ${c.variables[name].pos.file}:${c.variables[name].pos.line}. Variable names must be unique within a module.`, b.pos));
          break;
        }
        onlyAttrs(b.body, ['type', 'default', 'description', 'sensitive', 'ephemeral', 'nullable'], `variable "${name}"`, errors);
        c.variables[name] = {
          name,
          type: b.body.attrs.type ? parseType(b.body.attrs.type.expr, errors) : undefined,
          default: b.body.attrs.default?.expr,
          description: literalString(b.body.attrs.description, 'description', errors),
          sensitive: literalBool(b.body.attrs.sensitive, false, errors),
          ephemeral: literalBool(b.body.attrs.ephemeral, false, errors),
          nullable: literalBool(b.body.attrs.nullable, true, errors),
          validations: conditions(b.body.blocks, 'validation', errors),
          pos: b.pos,
        };
        for (const inner of b.body.blocks) if (inner.type !== 'validation') errors.push(diag('Unsupported block type', `Blocks of type "${inner.type}" are not expected here.`, inner.pos));
        break;
      }
      case 'locals':
        for (const [name, a] of Object.entries(b.body.attrs)) {
          if (c.locals[name]) errors.push(diag('Duplicate local value definition', `A local value named "${name}" was already defined at ${c.locals[name].pos.file}:${c.locals[name].pos.line}. Local value names must be unique within a module.`, a.pos));
          else c.locals[name] = { expr: a.expr, pos: a.pos };
        }
        break;
      case 'output': {
        if (!labels(1, 'output', 'name')) break;
        const name = b.labels[0];
        onlyAttrs(b.body, ['value', 'description', 'sensitive', 'ephemeral', 'depends_on'], `output "${name}"`, errors);
        if (!b.body.attrs.value) errors.push(diag('Missing required argument', 'The argument "value" is required, but no definition was found.', b.pos, { context: `output "${name}"` }));
        if (c.outputs[name]) errors.push(diag('Duplicate output definition', `An output named "${name}" was already defined at ${c.outputs[name].pos.file}:${c.outputs[name].pos.line}. Output names must be unique within a module.`, b.pos));
        c.outputs[name] = {
          name,
          value: b.body.attrs.value?.expr,
          sensitive: literalBool(b.body.attrs.sensitive, false, errors),
          ephemeral: literalBool(b.body.attrs.ephemeral, false, errors),
          description: literalString(b.body.attrs.description, 'description', errors),
          dependsOn: traversalList(b.body.attrs.depends_on, 'depends_on reference', errors),
          preconditions: conditions(b.body.blocks, 'precondition', errors),
          pos: b.pos,
        };
        break;
      }
      case 'resource':
      case 'data':
      case 'ephemeral': {
        const what = b.type === 'resource' ? 'resource' : b.type === 'data' ? 'data' : 'ephemeral';
        if (!labels(2, what, 'type, name')) break;
        const [type, name] = b.labels;
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
          errors.push(diag(`Invalid ${what} name`, 'A name must start with a letter or underscore and may contain only letters, digits, underscores, and dashes.', b.pos));
          break;
        }
        const mode = b.type === 'resource' ? 'managed' : b.type === 'data' ? 'data' : 'ephemeral';
        const key = mode === 'managed' ? `${type}.${name}` : `${b.type}.${type}.${name}`;
        if (c.resources[key]) {
          const prev = c.resources[key];
          errors.push(diag(`Duplicate ${what} "${type}" configuration`, `A ${type} ${what === 'data' ? 'data resource' : 'resource'} named "${name}" was already declared at ${prev.pos.file}:${prev.pos.line}. Resource names must be unique per type in each module.`, b.pos));
          break;
        }
        if (b.body.attrs.count && b.body.attrs.for_each) {
          errors.push(diag('Invalid combination of "count" and "for_each"', 'The "count" and "for_each" meta-arguments are mutually-exclusive, only one should be used to be explicit about the number of resources to be created.', b.body.attrs.for_each.pos));
        }
        let provider = { name: type.split('_')[0], alias: undefined as string | undefined, explicit: false };
        const pa = b.body.attrs.provider;
        if (pa) {
          const addr = exprAddress(pa.expr);
          if (!addr) errors.push(diag('Invalid provider reference', 'Provider argument requires a provider name followed by an optional alias, like "netcloud.us_east".', pa.pos));
          else {
            const [pn, alias] = addr.split('.');
            provider = { name: pn, alias, explicit: true };
          }
        }
        const lc = b.body.blocks.filter((x) => x.type === 'lifecycle');
        const life: ResourceConfig['lifecycle'] = { createBeforeDestroy: false, preventDestroy: false, ignoreChanges: [], replaceTriggeredBy: [], preconditions: [], postconditions: [] };
        for (const l of lc) {
          onlyAttrs(l.body, ['create_before_destroy', 'prevent_destroy', 'ignore_changes', 'replace_triggered_by'], 'lifecycle', errors);
          life.createBeforeDestroy = literalBool(l.body.attrs.create_before_destroy, life.createBeforeDestroy, errors);
          life.preventDestroy = literalBool(l.body.attrs.prevent_destroy, life.preventDestroy, errors);
          const ic = l.body.attrs.ignore_changes;
          if (ic) {
            if (ic.expr.k === 'var' && ic.expr.name === 'all') life.ignoreChanges = 'all';
            else if (ic.expr.k === 'tuple') life.ignoreChanges = ic.expr.items.map((x) => exprAddress(x) ?? '').filter(Boolean);
            else errors.push(diag('Invalid ignore_changes', 'Expected a list of attribute names, or the keyword "all".', ic.pos));
          }
          if (l.body.attrs.replace_triggered_by) {
            const e = l.body.attrs.replace_triggered_by.expr;
            life.replaceTriggeredBy = e.k === 'tuple' ? e.items : [e];
          }
          life.preconditions.push(...conditions(l.body.blocks, 'precondition', errors));
          life.postconditions.push(...conditions(l.body.blocks, 'postcondition', errors));
        }
        for (const inner of b.body.blocks) {
          if (inner.type === 'provisioner' || inner.type === 'connection') {
            c.warnings.push({ severity: 'warning', summary: 'Provisioners are not simulated', detail: 'NetLab ignores provisioner and connection blocks. HashiCorp recommends them only as a last resort.', pos: inner.pos });
          }
        }
        c.resources[key] = {
          mode,
          type,
          name,
          provider,
          body: b.body,
          count: b.body.attrs.count,
          forEach: b.body.attrs.for_each,
          dependsOn: traversalList(b.body.attrs.depends_on, 'depends_on reference', errors),
          lifecycle: life,
          pos: b.pos,
          file: display,
        };
        break;
      }
      case 'module': {
        if (!labels(1, 'module', 'name')) break;
        const name = b.labels[0];
        const source = literalString(b.body.attrs.source, 'module source', errors);
        if (!b.body.attrs.source) errors.push(diag('Missing required argument', 'The argument "source" is required, but no definition was found.', b.pos, { context: `module "${name}"` }));
        if (b.body.attrs.count || b.body.attrs.for_each) {
          errors.push(diag('Module repetition is not simulated', 'NetLab does not simulate count or for_each on module blocks. Declare one module block per instance.', (b.body.attrs.count ?? b.body.attrs.for_each).pos));
        }
        const inputs: Record<string, Attribute> = {};
        for (const [k, a] of Object.entries(b.body.attrs)) if (!['source', 'version', 'providers', 'count', 'for_each', 'depends_on'].includes(k)) inputs[k] = a;
        if (c.modules[name]) errors.push(diag('Duplicate module call', `A module call named "${name}" was already defined at ${c.modules[name].pos.file}:${c.modules[name].pos.line}. Module calls must have unique names within a module.`, b.pos));
        c.modules[name] = { name, source: source ?? '', version: literalString(b.body.attrs.version, 'module version', errors), inputs, dependsOn: traversalList(b.body.attrs.depends_on, 'depends_on reference', errors), pos: b.pos };
        break;
      }
      case 'import': {
        const to = b.body.attrs.to;
        const id = b.body.attrs.id;
        if (!to || !id) {
          errors.push(diag('Missing required argument', `The argument "${!to ? 'to' : 'id'}" is required, but no definition was found.`, b.pos, { context: 'import' }));
          break;
        }
        const addr = exprAddress(to.expr);
        if (!addr) errors.push(diag('Invalid import address', 'The "to" argument must be a resource address, like netcloud_instance.web.', to.pos));
        else c.imports.push({ to: fixAddress(addr), id: id.expr, pos: b.pos });
        break;
      }
      case 'moved': {
        const from = b.body.attrs.from && exprAddress(b.body.attrs.from.expr);
        const to = b.body.attrs.to && exprAddress(b.body.attrs.to.expr);
        if (!from || !to) errors.push(diag('Invalid "moved" block', 'A moved block needs "from" and "to", each a resource or module address.', b.pos));
        else c.moved.push({ from: fixAddress(from), to: fixAddress(to), pos: b.pos });
        break;
      }
      case 'removed': {
        const from = b.body.attrs.from && exprAddress(b.body.attrs.from.expr);
        if (!from) {
          errors.push(diag('Invalid "removed" block', 'A removed block needs "from", a resource or module address.', b.pos));
          break;
        }
        const lc = b.body.blocks.find((x) => x.type === 'lifecycle');
        c.removed.push({ from: fixAddress(from), destroy: literalBool(lc?.body.attrs.destroy, true, errors), pos: b.pos });
        break;
      }
      case 'check': {
        if (!labels(1, 'check', 'name')) break;
        c.checks.push({ name: b.labels[0], asserts: conditions(b.body.blocks, 'assert', errors), pos: b.pos });
        break;
      }
      default: {
        const near = closest(b.type, TOP_BLOCKS);
        errors.push(diag('Unsupported block type', `Blocks of type "${b.type}" are not expected here.${near ? ` Did you mean "${near}"?` : ''}`, b.pos));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// schema validation

export function providerSourceFor(c: ModuleConfig, root: ModuleConfig, localName: string): string {
  if (localName === 'terraform') return 'terraform.io/builtin/terraform';
  return c.requiredProviders[localName]?.source ?? root.requiredProviders[localName]?.source ?? `hashicorp/${localName}`;
}

/** Check one resource block's arguments and nested blocks against its schema. */
export function validateResourceBody(r: ResourceConfig, def: ResourceDef | { attrs: ResourceDef['attrs']; blocks?: Record<string, BlockDef> }, errors: Diag[]) {
  const context = `${r.mode === 'managed' ? 'resource' : r.mode === 'data' ? 'data' : 'ephemeral'} "${r.type}" "${r.name}"`;
  const meta = ['count', 'for_each', 'provider', 'depends_on'];
  const settable = Object.entries(def.attrs).filter(([, a]) => a.required || a.optional).map(([k]) => k);
  for (const [name, a] of Object.entries(r.body.attrs)) {
    if (meta.includes(name)) continue;
    const d = def.attrs[name];
    if (!d) {
      if (def.blocks?.[name]) {
        errors.push(diag('Unsupported argument', `An argument named "${name}" is not expected here. Did you mean to define a block of type "${name}"?`, a.pos, { context }));
        continue;
      }
      const near = closest(name, settable);
      errors.push(diag('Unsupported argument', `An argument named "${name}" is not expected here.${near ? ` Did you mean "${near}"?` : ''}`, a.pos, { context }));
    } else if (d.computed && !d.optional && !d.required) {
      errors.push(diag('Invalid or unknown key', `Can't configure a value for "${name}": its value will be decided automatically based on the result of applying this configuration.`, a.pos, { context }));
    }
  }
  for (const [name, d] of Object.entries(def.attrs)) {
    if (d.required && !r.body.attrs[name]) {
      errors.push(diag('Missing required argument', `The argument "${name}" is required, but no definition was found.`, r.body.pos, { context }));
    }
  }
  const allowedBlocks = ['lifecycle', 'provisioner', 'connection', 'dynamic', ...Object.keys(def.blocks ?? {})];
  for (const b of r.body.blocks) {
    if (!allowedBlocks.includes(b.type)) {
      const near = closest(b.type, Object.keys(def.blocks ?? {}));
      errors.push(diag('Unsupported block type', `Blocks of type "${b.type}" are not expected here.${near ? ` Did you mean "${near}"?` : ''}`, b.pos, { context }));
      continue;
    }
    const bd = def.blocks?.[b.type === 'dynamic' ? b.labels[0] : b.type];
    if (b.type === 'dynamic') {
      if (!bd) {
        errors.push(diag('Unsupported block type', `Blocks of type "${b.labels[0]}" are not expected here.`, b.pos, { context }));
        continue;
      }
      if (!b.body.attrs.for_each) errors.push(diag('Missing required argument', 'The argument "for_each" is required, but no definition was found.', b.pos, { context: `dynamic "${b.labels[0]}"` }));
      const content = b.body.blocks.find((x) => x.type === 'content');
      if (!content) errors.push(diag('Missing content block', 'A dynamic block must have a nested block of type "content" to describe the body of each generated block.', b.pos));
      else checkBlockBody(content.body, bd, `dynamic "${b.labels[0]}"`, errors);
      continue;
    }
    if (bd) checkBlockBody(b.body, bd, b.type, errors);
  }
}

function checkBlockBody(body: Body, bd: BlockDef, context: string, errors: Diag[]) {
  for (const [name, a] of Object.entries(body.attrs)) {
    if (!bd.attrs[name]) {
      const near = closest(name, Object.keys(bd.attrs));
      errors.push(diag('Unsupported argument', `An argument named "${name}" is not expected here.${near ? ` Did you mean "${near}"?` : ''}`, a.pos, { context }));
    }
  }
  for (const [name, d] of Object.entries(bd.attrs)) {
    if (d.required && !body.attrs[name]) errors.push(diag('Missing required argument', `The argument "${name}" is required, but no definition was found.`, body.pos, { context }));
  }
}

/** Every expression in a module, for reference checking. */
export function moduleExpressions(c: ModuleConfig): Array<{ expr: Expr; where: string; bound?: Set<string>; resource?: ResourceConfig }> {
  const out: Array<{ expr: Expr; where: string; bound?: Set<string>; resource?: ResourceConfig }> = [];
  const body = (b: Body, where: string, resource?: ResourceConfig, bound?: Set<string>) => {
    for (const [name, a] of Object.entries(b.attrs)) if (name !== 'provider' && name !== 'depends_on') out.push({ expr: a.expr, where, resource, bound });
    for (const inner of b.blocks) {
      if (inner.type === 'lifecycle') {
        for (const cond of inner.body.blocks) for (const a of Object.values(cond.body.attrs)) out.push({ expr: a.expr, where, resource, bound });
        continue;
      }
      if (inner.type === 'dynamic') {
        const it = inner.body.attrs.iterator?.expr;
        const name = it && it.k === 'var' ? it.name : inner.labels[0];
        if (inner.body.attrs.for_each) out.push({ expr: inner.body.attrs.for_each.expr, where, resource, bound });
        const nb = new Set(bound ?? []);
        nb.add(name);
        for (const content of inner.body.blocks) body(content.body, where, resource, nb);
        continue;
      }
      body(inner.body, where, resource, bound);
    }
  };
  for (const v of Object.values(c.variables)) for (const val of v.validations) out.push({ expr: val.condition, where: `variable "${v.name}"` });
  for (const [, l] of Object.entries(c.locals)) out.push({ expr: l.expr, where: 'locals' });
  for (const o of Object.values(c.outputs)) {
    if (o.value) out.push({ expr: o.value, where: `output "${o.name}"` });
    for (const p of o.preconditions) out.push({ expr: p.condition, where: `output "${o.name}"` }, { expr: p.message, where: `output "${o.name}"` });
  }
  for (const r of Object.values(c.resources)) body(r.body, `${r.mode === 'managed' ? 'resource' : r.mode} "${r.type}" "${r.name}"`, r);
  for (const m of Object.values(c.modules)) for (const a of Object.values(m.inputs)) out.push({ expr: a.expr, where: `module "${m.name}"` });
  for (const p of c.providers) for (const a of Object.values(p.body.attrs)) out.push({ expr: a.expr, where: `provider "${p.name}"` });
  for (const ch of c.checks) for (const a of ch.asserts) out.push({ expr: a.condition, where: `check "${ch.name}"` });
  return out;
}

/** Undeclared references: var.x, local.y, a resource or module that is not in this module. */
export function checkReferences(tree: ModuleTree, schemaOf: (r: ResourceConfig) => ResourceDef | { attrs: ResourceDef['attrs']; blocks?: Record<string, BlockDef> } | undefined, errors: Diag[]) {
  const c = tree.config;
  const where = tree.key ? `module.${tree.key.split('module.').pop()!.replace(/\.$/, '')}` : 'the root module';
  for (const { expr, where: context, bound, resource } of moduleExpressions(c)) {
    const b = new Set(bound ?? []);
    for (const ref of references(expr, b)) {
      const [root, ...names] = ref.parts;
      const at = { context };
      switch (root) {
        case 'var':
          if (!c.variables[names[0]]) errors.push(diag('Reference to undeclared input variable', `An input variable with the name "${names[0]}" has not been declared. This variable can be declared with a variable "${names[0]}" {} block.`, ref.pos, at));
          break;
        case 'local':
          if (!(names[0] in c.locals)) errors.push(diag('Reference to undeclared local value', `A local value with the name "${names[0]}" has not been declared.`, ref.pos, at));
          break;
        case 'module': {
          const child = tree.children[names[0]];
          if (!c.modules[names[0]]) errors.push(diag('Reference to undeclared module', `No module call named "${names[0]}" is declared in ${where}.`, ref.pos, at));
          else if (child && names[1] && !child.config.outputs[names[1]]) errors.push(diag('Unsupported attribute', `This object does not have an attribute named "${names[1]}".`, ref.pos, at));
          break;
        }
        case 'count':
          if (names[0] !== 'index') errors.push(diag('Invalid "count" attribute', `The "count" object does not have an attribute named "${names[0]}". The only supported attribute is count.index, which is the index of each instance of a resource block that has the "count" argument set.`, ref.pos, at));
          else if (!resource?.count) errors.push(diag('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.', ref.pos, at));
          break;
        case 'each':
          if (!['key', 'value'].includes(names[0])) errors.push(diag('Invalid "each" attribute', `The "each" object does not have an attribute named "${names[0]}". The supported attributes are each.key and each.value, the current key and value pair of the "for_each" attribute set.`, ref.pos, at));
          else if (!resource?.forEach) errors.push(diag('Reference to "each" in context without for_each', 'The "each" object can be used only in "module" or "resource" blocks, and only when the "for_each" argument is set.', ref.pos, at));
          break;
        case 'path':
          if (!['module', 'root', 'cwd'].includes(names[0])) errors.push(diag('Invalid "path" attribute', `The "path" object does not have an attribute named "${names[0]}". The supported attributes are path.cwd, path.module, and path.root.`, ref.pos, at));
          break;
        case 'terraform':
          if (names[0] !== 'workspace') errors.push(diag('Invalid "terraform" attribute', `The "terraform" object does not have an attribute named "${names[0]}". The only supported attribute is terraform.workspace, the name of the currently-selected workspace.`, ref.pos, at));
          break;
        case 'data':
        case 'ephemeral': {
          const key = `${root}.${names[0]}.${names[1]}`;
          const target = c.resources[key];
          if (!target) {
            errors.push(diag(`Reference to undeclared resource`, `A ${root === 'data' ? 'data resource' : 'ephemeral resource'} "${names[0]}" "${names[1]}" has not been declared in ${where}.`, ref.pos, at));
          } else if (names[2]) checkAttr(target, names[2], ref.pos, context);
          break;
        }
        default: {
          const key = `${root}.${names[0]}`;
          const target = c.resources[key];
          if (!target) {
            errors.push(diag('Reference to undeclared resource', `A managed resource "${root}" "${names[0]}" has not been declared in ${where}.`, ref.pos, at));
          } else if (names[1]) checkAttr(target, names[1], ref.pos, context);
        }
      }
    }
  }
  function checkAttr(target: ResourceConfig, attr: string, pos: Pos, context: string) {
    const def = schemaOf(target);
    if (!def) return;
    if (def.attrs[attr] || def.blocks?.[attr]) return;
    const near = closest(attr, Object.keys(def.attrs));
    errors.push(diag('Unsupported attribute', `This object has no argument, nested block, or exported attribute named "${attr}".${near ? ` Did you mean "${near}"?` : ''}`, pos, { context }));
  }
  for (const r of Object.values(c.resources)) {
    for (const d of r.dependsOn) {
      const parts = d.ref.replace(/\[.*?\]/g, '').split('.');
      const key = parts[0] === 'data' ? parts.slice(0, 3).join('.') : parts[0] === 'module' ? '' : parts.slice(0, 2).join('.');
      if (parts[0] === 'module' ? !c.modules[parts[1]] : !c.resources[key]) {
        errors.push(diag('Reference to undeclared resource', `A managed resource "${parts[0]}" "${parts[1] ?? ''}" has not been declared in ${where}.`, d.pos, { context: `resource "${r.type}" "${r.name}"` }));
      }
    }
  }
  for (const m of Object.values(c.modules)) {
    const child = tree.children[m.name];
    if (!child) continue;
    for (const [name, a] of Object.entries(m.inputs)) {
      if (!child.config.variables[name]) {
        const near = closest(name, Object.keys(child.config.variables));
        errors.push(diag('Unsupported argument', `An argument named "${name}" is not expected here.${near ? ` Did you mean "${near}"?` : ''}`, a.pos, { context: `module "${m.name}"` }));
      }
    }
    for (const v of Object.values(child.config.variables)) {
      if (!v.default && !m.inputs[v.name]) errors.push(diag('Missing required argument', `The argument "${v.name}" is required, but no definition was found.`, m.pos, { context: `module "${m.name}"` }));
    }
  }
}

export { providerFor };
