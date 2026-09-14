/**
 * Expression evaluation. A Scope answers references (var.x, local.y, resource
 * attributes); everything else — operators, templates, for expressions, splats and the
 * built-in functions — is worked out here.
 *
 * Unknown values flow through: an operator or function given one returns unknown, so a
 * plan can show "(known after apply)" wherever a value depends on something not yet
 * created. Sensitivity and ephemerality are tracked per evaluation in `marks`.
 */
import { diag, DiagError, parseTemplate, type Expr, type Pos } from './hcl';
import {
  canonical,
  ConvertError,
  convert,
  equal,
  hasUnknown,
  isMap,
  isObj,
  isSet,
  isUnknown,
  makeMap,
  makeSet,
  plain,
  toBool,
  toNumber,
  toStr,
  typeName,
  UNKNOWN,
  type TypeSpec,
  type Val,
  type ValObject,
} from './values';

export interface Marks {
  sensitive: boolean;
  ephemeral: boolean;
}

/** Objects whose named attributes are sensitive (random_password.x.result). */
export const SENSITIVE_ATTRS = new WeakMap<object, Set<string>>();
/** Values that came from somewhere sensitive as a whole (a sensitive variable or output). */
export const SENSITIVE_VALUES = new WeakSet<object>();
/** Objects that only exist during one run (ephemeral resources). */
export const EPHEMERAL = new WeakSet<object>();

export interface Scope {
  /** Resolve `root.a.b` for a reference root; `names` holds as many attribute names as the root takes. */
  lookup(root: string, names: string[], pos: Pos, marks: Marks): Val;
  /** How many attribute names follow this root before a value is reached (var: 1, data: 2, a resource type: 1). */
  arity(root: string): number;
  /** Read a file for file() and templatefile(), relative to the working directory. */
  readFile(path: string): string | undefined;
  /** Names bound by an enclosing for expression or dynamic block. */
  locals?: Record<string, Val>;
}

const ROOTS: Record<string, number> = { var: 1, local: 1, module: 1, data: 2, ephemeral: 2, path: 1, terraform: 1, count: 1, each: 1 };

export function rootArity(name: string): number {
  return ROOTS[name] ?? 1;
}

function fail(summary: string, detail: string, pos: Pos): never {
  throw new DiagError([diag(summary, detail, pos)]);
}

export function evaluate(expr: Expr, scope: Scope, marks: Marks = { sensitive: false, ephemeral: false }): Val {
  return new Evaluator(scope, marks).eval(expr);
}

/** Every reference an expression makes, as "var.x", "netcloud_network.main", "data.a.b", "module.m". */
export function references(expr: Expr, bound: Set<string> = new Set()): Array<{ ref: string; pos: Pos; parts: string[] }> {
  const out: Array<{ ref: string; pos: Pos; parts: string[] }> = [];
  const walk = (e: Expr, b: Set<string>) => {
    switch (e.k) {
      case 'lit':
        return;
      case 'tpl':
        for (const p of e.parts) if (typeof p !== 'string') walk(p, b);
        return;
      case 'tuple':
        e.items.forEach((x) => walk(x, b));
        return;
      case 'object':
        e.items.forEach((x) => {
          walk(x.key, b);
          walk(x.value, b);
        });
        return;
      case 'var':
      case 'attr':
      case 'index': {
        const chain = staticChain(e);
        if (chain) {
          if (b.has(chain.root)) {
            // walk any index expressions inside the chain
            collectIndexes(e, b);
            return;
          }
          const n = ROOTS[chain.root] ?? 1;
          const parts = [chain.root, ...chain.names.slice(0, n)];
          if (chain.root === 'self') {
            collectIndexes(e, b);
            return;
          }
          out.push({ ref: parts.join('.'), pos: e.pos, parts: [chain.root, ...chain.names] });
          collectIndexes(e, b);
          return;
        }
        if (e.k === 'attr') walk(e.obj, b);
        else if (e.k === 'index') {
          walk(e.obj, b);
          walk(e.index, b);
        }
        return;
      }
      case 'splat':
        walk(e.obj, b);
        e.each.forEach((s) => 'index' in s && walk(s.index, b));
        return;
      case 'call':
        e.args.forEach((x) => walk(x, b));
        return;
      case 'unary':
        walk(e.e, b);
        return;
      case 'binary':
        walk(e.l, b);
        walk(e.r, b);
        return;
      case 'cond':
        walk(e.c, b);
        walk(e.t, b);
        walk(e.f, b);
        return;
      case 'paren':
        walk(e.e, b);
        return;
      case 'for': {
        walk(e.coll, b);
        const inner = new Set(b);
        inner.add(e.valVar);
        if (e.keyVar) inner.add(e.keyVar);
        if (e.keyExpr) walk(e.keyExpr, inner);
        walk(e.valExpr, inner);
        if (e.cond) walk(e.cond, inner);
      }
    }
  };
  const collectIndexes = (e: Expr, b: Set<string>) => {
    if (e.k === 'index') {
      walk(e.index, b);
      collectIndexes(e.obj, b);
    } else if (e.k === 'attr') collectIndexes(e.obj, b);
  };
  walk(expr, bound);
  return out;
}

/** root.name.name with any [index] steps skipped, when the expression is a plain traversal. */
function staticChain(e: Expr): { root: string; names: string[] } | null {
  const names: string[] = [];
  let cur: Expr = e;
  while (true) {
    if (cur.k === 'var') return { root: cur.name, names: names.reverse() };
    if (cur.k === 'attr') {
      names.push(cur.name);
      cur = cur.obj;
    } else if (cur.k === 'index') {
      cur = cur.obj;
    } else return null;
  }
}

/** When `e` is exactly `root.a[.b]` with the root's arity of names and no indexes. */
function exactRef(e: Expr, scope: Scope): { root: string; names: string[] } | null {
  const names: string[] = [];
  let cur: Expr = e;
  while (cur.k === 'attr') {
    names.unshift(cur.name);
    cur = cur.obj;
  }
  if (cur.k !== 'var') return null;
  if (scope.locals && cur.name in scope.locals) return null;
  if (cur.name === 'self') return null;
  const n = scope.arity(cur.name);
  return names.length === n ? { root: cur.name, names } : null;
}

class Evaluator {
  constructor(
    private scope: Scope,
    private marks: Marks,
  ) {}

  child(locals: Record<string, Val>): Evaluator {
    return new Evaluator({ ...this.scope, lookup: this.scope.lookup, arity: this.scope.arity, readFile: this.scope.readFile, locals: { ...(this.scope.locals ?? {}), ...locals } }, this.marks);
  }

  touch(v: Val) {
    if (typeof v === 'object' && v !== null) {
      if (SENSITIVE_VALUES.has(v)) this.marks.sensitive = true;
      if (EPHEMERAL.has(v)) this.marks.ephemeral = true;
    }
  }

  eval(e: Expr): Val {
    switch (e.k) {
      case 'lit':
        return e.v;
      case 'paren':
        return this.eval(e.e);
      case 'tpl': {
        let s = '';
        for (const p of e.parts) {
          if (typeof p === 'string') s += p;
          else {
            const v = this.eval(p);
            if (hasUnknown(v)) return UNKNOWN;
            s += toStr(v, p.pos);
          }
        }
        return s;
      }
      case 'tuple':
        return e.items.map((x) => this.eval(x));
      case 'object': {
        const o: ValObject = {};
        for (const it of e.items) {
          const k = it.key.k === 'var' ? it.key.name : this.eval(it.key);
          if (isUnknown(k)) return UNKNOWN;
          if (typeof k !== 'string' && typeof k !== 'number' && typeof k !== 'boolean') fail('Invalid object key', 'Object keys must be strings.', it.key.pos);
          o[String(k)] = this.eval(it.value);
        }
        return o;
      }
      case 'var': {
        if (this.scope.locals && e.name in this.scope.locals) return this.scope.locals[e.name];
        if (e.name === 'self') return this.scope.lookup('self', [], e.pos, this.marks);
        const n = this.scope.arity(e.name);
        if (e.name in ROOTS) fail('Invalid reference', `The "${e.name}" object cannot be accessed directly. Instead, access ${n === 2 ? 'a resource type and name' : 'one of its attributes'}.`, e.pos);
        fail('Invalid reference', 'A reference to a resource type must be followed by at least one attribute access, specifying the resource name.', e.pos);
        break;
      }
      case 'attr': {
        const ref = exactRef(e, this.scope);
        if (ref) {
          const v = this.scope.lookup(ref.root, ref.names, e.pos, this.marks);
          this.touch(v);
          return v;
        }
        const obj = this.eval(e.obj);
        return this.getAttr(obj, e.name, e.pos);
      }
      case 'index': {
        const obj = this.eval(e.obj);
        const idx = this.eval(e.index);
        return this.getIndex(obj, idx, e.pos);
      }
      case 'splat': {
        const obj = this.eval(e.obj);
        if (isUnknown(obj)) return UNKNOWN;
        const list = obj === null ? [] : Array.isArray(obj) ? obj : [obj];
        return list.map((item) => {
          let v = item;
          for (const step of e.each) v = 'attr' in step ? this.getAttr(v, step.attr, e.pos) : this.getIndex(v, this.eval(step.index), e.pos);
          return v;
        });
      }
      case 'unary': {
        const v = this.eval(e.e);
        if (isUnknown(v)) return UNKNOWN;
        if (e.op === '!') return !toBool(v, e.pos, 'operand');
        return -toNumber(v, e.pos);
      }
      case 'binary':
        return this.binary(e.op, e.l, e.r, e.pos);
      case 'cond': {
        const c = this.eval(e.c);
        if (isUnknown(c)) return UNKNOWN;
        return toBool(c, e.c.pos, 'condition') ? this.eval(e.t) : this.eval(e.f);
      }
      case 'for':
        return this.forExpr(e);
      case 'call':
        return this.call(e);
    }
    return null;
  }

  getAttr(obj: Val, name: string, pos: Pos): Val {
    if (isUnknown(obj)) return UNKNOWN;
    if (obj === null) fail('Attempt to get attribute from null value', 'This value is null, so it does not have any attributes.', pos);
    if (Array.isArray(obj)) {
      fail('Unsupported attribute', `Can't access attributes on a list of objects. Did you mean to access attribute "${name}" for a specific element of the list, or across all elements of the list?`, pos);
    }
    if (!isObj(obj)) fail('Unsupported attribute', `Can't access attributes on a primitive-typed value (${typeName(obj)}).`, pos);
    if (!(name in obj)) {
      if (isMap(obj)) fail('Missing map element', `This map does not have an element with the key "${name}".`, pos);
      fail('Unsupported attribute', `This object does not have an attribute named "${name}".`, pos);
    }
    if (SENSITIVE_ATTRS.get(obj)?.has(name)) this.marks.sensitive = true;
    const v = obj[name];
    this.touch(v);
    return v;
  }

  getIndex(obj: Val, idx: Val, pos: Pos): Val {
    if (isUnknown(obj) || isUnknown(idx)) return UNKNOWN;
    if (obj === null) fail('Invalid index', 'This value is null, so it does not have any indices.', pos);
    if (Array.isArray(obj)) {
      if (isSet(obj)) fail('Invalid index', 'Elements of a set are identified only by their value and don\'t have any separate index or key to select with, so it\'s only possible to perform operations across all elements of the set.', pos);
      const i = toNumber(idx, pos, 'index');
      if (!Number.isInteger(i) || i < 0 || i >= obj.length) fail('Invalid index', `The given key does not identify an element in this collection value${i >= obj.length ? ': the given index is greater than or equal to the length of the collection' : ''}.`, pos);
      const v = obj[i];
      this.touch(v);
      return v;
    }
    if (isObj(obj)) {
      const k = toStr(idx, pos);
      if (!(k in obj)) fail('Invalid index', 'The given key does not identify an element in this collection value.', pos);
      if (SENSITIVE_ATTRS.get(obj)?.has(k)) this.marks.sensitive = true;
      const v = obj[k];
      this.touch(v);
      return v;
    }
    fail('Invalid index', `This value does not have any indices.`, pos);
  }

  binary(op: string, le: Expr, re: Expr, _pos: Pos): Val {
    if (op === '&&' || op === '||') {
      const l = this.eval(le);
      if (isUnknown(l)) return UNKNOWN;
      const lb = toBool(l, le.pos, 'operand');
      if (op === '&&' && !lb) return false;
      if (op === '||' && lb) return true;
      const r = this.eval(re);
      if (isUnknown(r)) return UNKNOWN;
      return toBool(r, re.pos, 'operand');
    }
    const l = this.eval(le);
    const r = this.eval(re);
    if (op === '==' || op === '!=') {
      if (hasUnknown(l) || hasUnknown(r)) return UNKNOWN;
      const same = equal(l, r);
      return op === '==' ? same : !same;
    }
    if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
    const a = toNumber(l, le.pos);
    const b = toNumber(r, re.pos);
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) fail('Invalid right-hand operand', 'Can\'t divide by zero.', re.pos);
        return a / b;
      case '%':
        return a % b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '<=':
        return a <= b;
      case '>=':
        return a >= b;
    }
    return null;
  }

  forExpr(e: Extract<Expr, { k: 'for' }>): Val {
    const coll = this.eval(e.coll);
    if (isUnknown(coll)) return UNKNOWN;
    if (coll === null) fail('Iteration over null value', 'A null value cannot be used as the collection in a \'for\' expression.', e.coll.pos);
    let entries: Array<[Val, Val]>;
    if (Array.isArray(coll)) entries = coll.map((v, i) => [isSet(coll) ? v : i, v]);
    else if (isObj(coll)) entries = Object.entries(coll);
    else fail('Iteration over non-iterable value', `A value of type ${typeName(coll)} cannot be used as the collection in a 'for' expression.`, e.coll.pos);
    if (e.object) {
      const out: Record<string, Val> = {};
      const groups: Record<string, Val[]> = {};
      for (const [k, v] of entries) {
        const ev = this.child({ [e.valVar]: v, ...(e.keyVar ? { [e.keyVar]: k } : {}) });
        if (e.cond) {
          const c = ev.eval(e.cond);
          if (isUnknown(c)) return UNKNOWN;
          if (!toBool(c, e.cond.pos)) continue;
        }
        const key = ev.eval(e.keyExpr!);
        if (isUnknown(key)) return UNKNOWN;
        const ks = toStr(key, e.keyExpr!.pos);
        const val = ev.eval(e.valExpr);
        if (e.group) (groups[ks] ??= []).push(val);
        else {
          if (ks in out) fail('Duplicate object key', `Two different items produced the key "${ks}" in this 'for' expression. If duplicates are expected, use the ellipsis (...) after the value expression to enable grouping by key.`, e.keyExpr!.pos);
          out[ks] = val;
        }
      }
      return e.group ? groups : out;
    }
    const out: Val[] = [];
    for (const [k, v] of entries) {
      const ev = this.child({ [e.valVar]: v, ...(e.keyVar ? { [e.keyVar]: k } : {}) });
      if (e.cond) {
        const c = ev.eval(e.cond);
        if (isUnknown(c)) return UNKNOWN;
        if (!toBool(c, e.cond.pos)) continue;
      }
      out.push(ev.eval(e.valExpr));
    }
    return out;
  }

  call(e: Extract<Expr, { k: 'call' }>): Val {
    const fn = FUNCTIONS[e.name];
    if (!fn) {
      const near = Object.keys(FUNCTIONS).find((n) => n.toLowerCase() === e.name.toLowerCase().replace(/_/g, ''));
      fail('Call to unknown function', `There is no function named "${e.name}".${near ? ` Did you mean "${near}"?` : ''}`, e.pos);
    }
    if (e.name === 'try' || e.name === 'can') {
      for (const a of e.args) {
        try {
          const v = this.eval(a);
          if (e.name === 'can') return hasUnknown(v) ? UNKNOWN : true;
          return v;
        } catch (err) {
          if (!(err instanceof DiagError)) throw err;
          if (e.name === 'can') return false;
        }
      }
      if (e.name === 'can') return false;
      fail('Error in function call', 'Call to function "try" failed: no expression succeeded.', e.pos);
    }
    if (e.name === 'nonsensitive' || e.name === 'sensitive') {
      const inner = { sensitive: false, ephemeral: this.marks.ephemeral };
      const v = new Evaluator(this.scope, inner).eval(e.args[0]);
      if (e.name === 'sensitive') this.marks.sensitive = true;
      else this.marks.ephemeral = inner.ephemeral;
      return v;
    }
    let args = e.args.map((a) => this.eval(a));
    if (e.expand) {
      const last = args.pop();
      if (isUnknown(last)) return UNKNOWN;
      if (!Array.isArray(last)) fail('Invalid expanding argument value', 'The expanding argument (indicated by ...) must be of a tuple, list, or set type.', e.args[e.args.length - 1].pos);
      args = [...args, ...last];
    }
    const [min, max] = fn.arity;
    if (args.length < min) fail('Not enough function arguments', `Function "${e.name}" expects ${min} argument(s). Missing value for "${fn.params[args.length] ?? 'value'}".`, e.pos);
    if (max >= 0 && args.length > max) fail('Too many function arguments', `Function "${e.name}" expects only ${max} argument(s).`, e.pos);
    if (!fn.acceptsUnknown && args.some(hasUnknown)) return UNKNOWN;
    try {
      return fn.run(args, { pos: e.pos, scope: this.scope, argPos: e.args.map((a) => a.pos), evaluator: this });
    } catch (err) {
      if (err instanceof FnError) fail('Invalid function argument', `Invalid value for "${fn.params[err.arg] ?? 'value'}" parameter: ${err.message}.`, e.args[err.arg]?.pos ?? e.pos);
      if (err instanceof ConvertError) fail('Invalid function argument', `Invalid value for "${fn.params[0] ?? 'value'}" parameter: ${err.message}.`, e.pos);
      if (err instanceof DiagError) throw err;
      fail('Error in function call', `Call to function "${e.name}" failed: ${err instanceof Error ? err.message : String(err)}.`, e.pos);
    }
  }
}

// ---------------------------------------------------------------------------
// functions

class FnError extends Error {
  constructor(
    public arg: number,
    message: string,
  ) {
    super(message);
  }
}

interface FnCtx {
  pos: Pos;
  scope: Scope;
  argPos: Pos[];
  evaluator: Evaluator;
}

interface Fn {
  params: string[];
  arity: [number, number];
  acceptsUnknown?: boolean;
  run: (args: Val[], ctx: FnCtx) => Val;
}

const str = (v: Val, i: number): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new FnError(i, 'string required');
};
const num = (v: Val, i: number): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw new FnError(i, 'a number is required');
};
const list = (v: Val, i: number): Val[] => {
  if (Array.isArray(v)) return v;
  throw new FnError(i, 'list of any single type required');
};
const obj = (v: Val, i: number): ValObject => {
  if (isObj(v)) return v;
  throw new FnError(i, 'map of any single type required');
};

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`invalid IP address "${ip}"`);
  return parts.reduce((n, o) => (n * 256 + o) >>> 0, 0);
}
function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
export function parseCidr(cidr: string): { base: number; bits: number } {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr);
  if (!m || Number(m[2]) > 32) throw new Error(`invalid CIDR address: ${cidr}`);
  const bits = Number(m[2]);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipToInt(m[1]) & mask) >>> 0, bits };
}
export function cidrText(base: number, bits: number): string {
  return `${intToIp(base)}/${bits}`;
}

const FUNCTIONS: Record<string, Fn> = {
  // strings
  upper: { params: ['str'], arity: [1, 1], run: ([s]) => str(s, 0).toUpperCase() },
  lower: { params: ['str'], arity: [1, 1], run: ([s]) => str(s, 0).toLowerCase() },
  title: { params: ['str'], arity: [1, 1], run: ([s]) => str(s, 0).replace(/\b\w/g, (c) => c.toUpperCase()) },
  trimspace: { params: ['str'], arity: [1, 1], run: ([s]) => str(s, 0).trim() },
  chomp: { params: ['str'], arity: [1, 1], run: ([s]) => str(s, 0).replace(/(\r?\n)+$/, '') },
  trim: { params: ['str', 'cutset'], arity: [2, 2], run: ([s, c]) => { const set = str(c, 1); let x = str(s, 0); while (x && set.includes(x[0])) x = x.slice(1); while (x && set.includes(x[x.length - 1])) x = x.slice(0, -1); return x; } },
  trimprefix: { params: ['str', 'prefix'], arity: [2, 2], run: ([s, p]) => (str(s, 0).startsWith(str(p, 1)) ? str(s, 0).slice(str(p, 1).length) : str(s, 0)) },
  trimsuffix: { params: ['str', 'suffix'], arity: [2, 2], run: ([s, p]) => (str(s, 0).endsWith(str(p, 1)) ? str(s, 0).slice(0, -str(p, 1).length || undefined) : str(s, 0)) },
  strrev: { params: ['str'], arity: [1, 1], run: ([s]) => [...str(s, 0)].reverse().join('') },
  startswith: { params: ['str', 'prefix'], arity: [2, 2], run: ([s, p]) => str(s, 0).startsWith(str(p, 1)) },
  endswith: { params: ['str', 'suffix'], arity: [2, 2], run: ([s, p]) => str(s, 0).endsWith(str(p, 1)) },
  strcontains: { params: ['str', 'substr'], arity: [2, 2], run: ([s, p]) => str(s, 0).includes(str(p, 1)) },
  substr: { params: ['str', 'offset', 'length'], arity: [3, 3], run: ([s, o, l]) => { const x = str(s, 0); let off = num(o, 1); if (off < 0) off = x.length + off; const len = num(l, 2); return len < 0 ? x.slice(off) : x.slice(off, off + len); } },
  replace: {
    params: ['str', 'substr', 'replace'],
    arity: [3, 3],
    run: ([s, f, r]) => {
      const find = str(f, 1);
      const m = /^\/(.*)\/$/.exec(find);
      if (m) return str(s, 0).replace(new RegExp(m[1], 'g'), str(r, 2).replace(/\$\{?(\d+)\}?/g, '$$$1'));
      return str(s, 0).split(find).join(str(r, 2));
    },
  },
  split: { params: ['separator', 'str'], arity: [2, 2], run: ([sep, s]) => (str(s, 1) === '' ? [''] : str(s, 1).split(str(sep, 0))) },
  join: { params: ['separator', 'lists'], arity: [2, -1], run: ([sep, ...ls]) => ls.flatMap((l, i) => list(l, i + 1)).map((v) => { if (v === null) throw new FnError(1, 'element is null'); return str(v, 1); }).join(str(sep, 0)) },
  format: {
    params: ['format', 'args'],
    arity: [1, -1],
    run: ([f, ...args]) => {
      let i = 0;
      return str(f, 0).replace(/%(%|[-0-9.]*[sdvqft])/g, (m, spec: string) => {
        if (spec === '%') return '%';
        if (i >= args.length) throw new FnError(0, `not enough arguments for ${m}`);
        const a = args[i++];
        const verb = spec[spec.length - 1];
        const width = /^-?\d+/.exec(spec)?.[0];
        const prec = /\.(\d+)/.exec(spec)?.[1];
        let out: string;
        if (verb === 'd') out = String(Math.trunc(num(a, i)));
        else if (verb === 'f') out = num(a, i).toFixed(prec ? Number(prec) : 6);
        else if (verb === 'q') out = JSON.stringify(str(a, i));
        else if (verb === 'v') out = typeof a === 'string' ? a : JSON.stringify(plain(a));
        else if (verb === 't') out = String(toBool(a, { file: '', line: 0, col: 0 }));
        else out = str(a, i);
        if (width) {
          const w = Math.abs(Number(width));
          out = width.startsWith('-') ? out.padEnd(w) : out.padStart(w, width.startsWith('0') && verb === 'd' ? '0' : ' ');
        }
        return out;
      });
    },
  },
  formatlist: {
    params: ['format', 'args'],
    arity: [1, -1],
    run: (args, ctx) => {
      const lists = args.slice(1).filter(Array.isArray) as Val[][];
      const n = lists.length ? lists[0].length : 1;
      return Array.from({ length: n }, (_, i) => FUNCTIONS.format.run([args[0], ...args.slice(1).map((a) => (Array.isArray(a) ? a[i] : a))], ctx));
    },
  },
  indent: { params: ['spaces', 'str'], arity: [2, 2], run: ([n, s]) => str(s, 1).split('\n').map((l, i) => (i === 0 ? l : ' '.repeat(num(n, 0)) + l)).join('\n') },
  regex: {
    params: ['pattern', 'string'],
    arity: [2, 2],
    run: ([p, s]) => {
      const m = new RegExp(str(p, 0)).exec(str(s, 1));
      if (!m) throw new FnError(1, 'pattern did not match any part of the given string');
      if (m.groups) return { ...m.groups };
      return m.length > 1 ? m.slice(1).map((x) => x ?? null) : m[0];
    },
  },
  // numbers
  abs: { params: ['num'], arity: [1, 1], run: ([n]) => Math.abs(num(n, 0)) },
  ceil: { params: ['num'], arity: [1, 1], run: ([n]) => Math.ceil(num(n, 0)) },
  floor: { params: ['num'], arity: [1, 1], run: ([n]) => Math.floor(num(n, 0)) },
  max: { params: ['numbers'], arity: [1, -1], run: (ns) => Math.max(...ns.map(num)) },
  min: { params: ['numbers'], arity: [1, -1], run: (ns) => Math.min(...ns.map(num)) },
  pow: { params: ['num', 'power'], arity: [2, 2], run: ([a, b]) => Math.pow(num(a, 0), num(b, 1)) },
  signum: { params: ['num'], arity: [1, 1], run: ([n]) => Math.sign(num(n, 0)) },
  parseint: { params: ['number', 'base'], arity: [2, 2], run: ([n, b]) => { const r = parseInt(str(n, 0), num(b, 1)); if (Number.isNaN(r)) throw new FnError(0, `cannot parse "${str(n, 0)}" as a base ${num(b, 1)} integer`); return r; } },
  tonumber: { params: ['v'], arity: [1, 1], run: ([v]) => (v === null ? null : num(v, 0)) },
  tostring: { params: ['v'], arity: [1, 1], run: ([v]) => (v === null ? null : str(v, 0)) },
  tobool: { params: ['v'], arity: [1, 1], run: ([v]) => { if (v === null) return null; if (typeof v === 'boolean') return v; if (v === 'true' || v === 'false') return v === 'true'; throw new FnError(0, 'a bool is required'); } },
  // collections
  length: {
    params: ['value'],
    arity: [1, 1],
    acceptsUnknown: true,
    run: ([v]) => {
      if (isUnknown(v)) return UNKNOWN;
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (isObj(v)) return Object.keys(v).length;
      throw new FnError(0, 'argument must be a string, a collection type, or a structural type');
    },
  },
  concat: { params: ['seqs'], arity: [1, -1], run: (ls) => ls.flatMap((l, i) => list(l, i)) },
  merge: { params: ['maps'], arity: [0, -1], run: (ms) => Object.assign({}, ...ms.filter((m) => m !== null).map((m, i) => obj(m, i))) },
  lookup: {
    params: ['inputMap', 'key', 'default'],
    arity: [2, 3],
    run: ([m, k, d]) => {
      const o = obj(m, 0);
      const key = str(k, 1);
      if (key in o) return o[key];
      if (d === undefined) throw new FnError(1, `the given key "${key}" does not exist in the map`);
      return d;
    },
  },
  element: { params: ['list', 'index'], arity: [2, 2], run: ([l, i]) => { const xs = list(l, 0); if (xs.length === 0) throw new FnError(0, 'cannot use element function with an empty list'); const n = Math.floor(num(i, 1)); if (n < 0) throw new FnError(1, 'cannot use element function with a negative index'); return xs[n % xs.length]; } },
  index: { params: ['list', 'value'], arity: [2, 2], run: ([l, v]) => { const i = list(l, 0).findIndex((x) => equal(x, v)); if (i < 0) throw new FnError(1, 'item not found'); return i; } },
  contains: { params: ['list', 'value'], arity: [2, 2], run: ([l, v]) => list(l, 0).some((x) => equal(x, v)) },
  keys: { params: ['inputMap'], arity: [1, 1], run: ([m]) => Object.keys(obj(m, 0)).sort() },
  values: { params: ['mapping'], arity: [1, 1], run: ([m]) => { const o = obj(m, 0); return Object.keys(o).sort().map((k) => o[k]); } },
  distinct: { params: ['list'], arity: [1, 1], run: ([l]) => { const seen = new Set<string>(); return list(l, 0).filter((x) => { const k = canonical(x); if (seen.has(k)) return false; seen.add(k); return true; }); } },
  flatten: { params: ['list'], arity: [1, 1], run: ([l]) => { const flat = (xs: Val[]): Val[] => xs.flatMap((x) => (Array.isArray(x) ? flat(x) : [x])); return flat(list(l, 0)); } },
  compact: { params: ['list'], arity: [1, 1], run: ([l]) => list(l, 0).filter((x) => x !== null && x !== '') },
  reverse: { params: ['list'], arity: [1, 1], run: ([l]) => [...list(l, 0)].reverse() },
  sort: { params: ['list'], arity: [1, 1], run: ([l]) => list(l, 0).map((x, i) => str(x, i)).sort() },
  slice: { params: ['list', 'start_index', 'end_index'], arity: [3, 3], run: ([l, s, e]) => { const xs = list(l, 0); const a = num(s, 1); const b = num(e, 2); if (b > xs.length) throw new FnError(2, 'end index must not be greater than the length of the list'); if (a > b) throw new FnError(1, 'start index must not be greater than end index'); return xs.slice(a, b); } },
  range: {
    params: ['params'],
    arity: [1, 3],
    run: (ps) => {
      const [a, b, s] = ps.length === 1 ? [0, num(ps[0], 0), 1] : [num(ps[0], 0), num(ps[1], 1), ps.length === 3 ? num(ps[2], 2) : 1];
      const out: number[] = [];
      if (s === 0) throw new FnError(2, 'step must not be zero');
      for (let i = a; s > 0 ? i < b : i > b; i += s) out.push(i);
      return out;
    },
  },
  zipmap: { params: ['keys', 'values'], arity: [2, 2], run: ([k, v]) => { const ks = list(k, 0); const vs = list(v, 1); if (ks.length !== vs.length) throw new FnError(1, 'number of keys and values must be equal'); return Object.fromEntries(ks.map((x, i) => [str(x, 0), vs[i]])); } },
  sum: { params: ['list'], arity: [1, 1], run: ([l]) => { const xs = list(l, 0); if (!xs.length) throw new FnError(0, 'cannot sum an empty list'); return xs.reduce((n: number, x) => n + num(x, 0), 0); } },
  one: { params: ['list'], arity: [1, 1], run: ([l]) => { const xs = list(l, 0); if (xs.length > 1) throw new FnError(0, 'must be a list, set, or tuple value with either zero or one elements'); return xs.length ? xs[0] : null; } },
  alltrue: { params: ['list'], arity: [1, 1], run: ([l]) => list(l, 0).every((x) => x === true || x === 'true') },
  anytrue: { params: ['list'], arity: [1, 1], run: ([l]) => list(l, 0).some((x) => x === true || x === 'true') },
  coalesce: { params: ['vals'], arity: [1, -1], run: (vs) => { const v = vs.find((x) => x !== null && x !== ''); if (v === undefined) throw new FnError(0, 'no non-null, non-empty-string arguments'); return v; } },
  coalescelist: { params: ['vals'], arity: [1, -1], run: (vs) => vs.find((x) => Array.isArray(x) && x.length > 0) ?? [] },
  setunion: { params: ['sets'], arity: [1, -1], run: (ss) => makeSet(ss.flatMap((s, i) => list(s, i))) },
  setintersection: { params: ['sets'], arity: [1, -1], run: (ss) => makeSet(list(ss[0], 0).filter((x) => ss.slice(1).every((s, i) => list(s, i + 1).some((y) => equal(x, y))))) },
  setsubtract: { params: ['a', 'b'], arity: [2, 2], run: ([a, b]) => makeSet(list(a, 0).filter((x) => !list(b, 1).some((y) => equal(x, y)))) },
  chunklist: { params: ['list', 'size'], arity: [2, 2], run: ([l, n]) => { const xs = list(l, 0); const size = num(n, 1); const out: Val[] = []; for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size)); return out; } },
  transpose: { params: ['values'], arity: [1, 1], run: ([m]) => { const out: Record<string, Val[]> = {}; for (const [k, vs] of Object.entries(obj(m, 0))) for (const v of list(vs, 0)) (out[str(v, 0)] ??= []).push(k); return out; } },
  // type conversion
  toset: { params: ['v'], arity: [1, 1], run: ([v]) => makeSet(list(v, 0)) },
  tolist: { params: ['v'], arity: [1, 1], run: ([v]) => [...list(v, 0)] },
  tomap: { params: ['v'], arity: [1, 1], run: ([v]) => makeMap(obj(v, 0)) },
  type: { params: ['value'], arity: [1, 1], acceptsUnknown: true, run: ([v]) => typeName(v) },
  // encoding
  jsonencode: { params: ['val'], arity: [1, 1], run: ([v]) => JSON.stringify(plain(v)) },
  jsondecode: { params: ['str'], arity: [1, 1], run: ([s]) => { try { return JSON.parse(str(s, 0)); } catch { throw new FnError(0, 'invalid JSON'); } } },
  yamlencode: { params: ['val'], arity: [1, 1], run: ([v]) => JSON.stringify(plain(v), null, 2) + '\n' },
  base64encode: { params: ['str'], arity: [1, 1], run: ([s]) => btoa(unescape(encodeURIComponent(str(s, 0)))) },
  base64decode: { params: ['str'], arity: [1, 1], run: ([s]) => { try { return decodeURIComponent(escape(atob(str(s, 0)))); } catch { throw new FnError(0, 'failed to decode base64 data'); } } },
  urlencode: { params: ['str'], arity: [1, 1], run: ([s]) => encodeURIComponent(str(s, 0)) },
  md5: { params: ['str'], arity: [1, 1], run: ([s]) => fakeHash(str(s, 0), 32) },
  sha256: { params: ['str'], arity: [1, 1], run: ([s]) => fakeHash(str(s, 0), 64) },
  uuid: { params: [], arity: [0, 0], run: () => UNKNOWN },
  timestamp: { params: [], arity: [0, 0], run: () => UNKNOWN },
  // filesystem
  file: {
    params: ['path'],
    arity: [1, 1],
    run: ([p], ctx) => {
      const content = ctx.scope.readFile(str(p, 0));
      if (content === undefined) throw new FnError(0, `no file exists at "${str(p, 0)}"; this function works only with files that are distributed as part of the configuration source code, so if this file will be created by a resource in this configuration you must instead obtain this result from an attribute of that resource`);
      return content;
    },
  },
  fileexists: { params: ['path'], arity: [1, 1], run: ([p], ctx) => ctx.scope.readFile(str(p, 0)) !== undefined },
  templatefile: {
    params: ['path', 'vars'],
    arity: [2, 2],
    run: ([p, vars], ctx) => {
      const content = ctx.scope.readFile(str(p, 0));
      if (content === undefined) throw new FnError(0, `no file exists at "${str(p, 0)}"`);
      const parts = parseTemplate(content, str(p, 0));
      const bound = obj(vars, 1);
      const ev = new Evaluator({ lookup: (root, _n, pos) => fail('Invalid template reference', `Templates can only refer to the variables passed to templatefile, not to "${root}".`, pos), arity: () => 0, readFile: ctx.scope.readFile, locals: bound }, { sensitive: false, ephemeral: false });
      let out = '';
      for (const part of parts) {
        if (typeof part === 'string') out += part;
        else {
          if (part.k === 'var' && !(part.name in bound)) fail('Invalid function argument', `Invalid value for "vars" parameter: vars map does not contain key "${part.name}", referenced at ${part.pos.file}:${part.pos.line},${part.pos.col}.`, ctx.pos);
          const v = ev.eval(part);
          if (hasUnknown(v)) return UNKNOWN;
          out += toStr(v, part.pos);
        }
      }
      return out;
    },
  },
  abspath: { params: ['path'], arity: [1, 1], run: ([p]) => str(p, 0) },
  basename: { params: ['path'], arity: [1, 1], run: ([p]) => str(p, 0).split('/').filter(Boolean).pop() ?? '' },
  dirname: { params: ['path'], arity: [1, 1], run: ([p]) => { const parts = str(p, 0).split('/'); parts.pop(); return parts.join('/') || '.'; } },
  pathexpand: { params: ['path'], arity: [1, 1], run: ([p]) => str(p, 0).replace(/^~/, '/home/student') },
  // networking
  cidrsubnet: {
    params: ['prefix', 'newbits', 'netnum'],
    arity: [3, 3],
    run: ([p, nb, nn]) => {
      let base: { base: number; bits: number };
      try {
        base = parseCidr(str(p, 0));
      } catch (e) {
        throw new FnError(0, (e as Error).message);
      }
      const newbits = num(nb, 1);
      const netnum = num(nn, 2);
      const bits = base.bits + newbits;
      if (bits > 32) throw new FnError(1, `would extend prefix to ${bits} bits, which is too long for an IPv4 address`);
      if (netnum >= Math.pow(2, newbits) || netnum < 0) throw new FnError(2, `prefix extension of ${newbits} does not accommodate a subnet numbered ${netnum}`);
      return cidrText((base.base + netnum * Math.pow(2, 32 - bits)) >>> 0, bits);
    },
  },
  cidrhost: {
    params: ['prefix', 'hostnum'],
    arity: [2, 2],
    run: ([p, h]) => {
      let base: { base: number; bits: number };
      try {
        base = parseCidr(str(p, 0));
      } catch (e) {
        throw new FnError(0, (e as Error).message);
      }
      const n = num(h, 1);
      const size = Math.pow(2, 32 - base.bits);
      if (Math.abs(n) >= size) throw new FnError(1, `prefix of ${base.bits} does not accommodate a host numbered ${n}`);
      return intToIp((base.base + (n < 0 ? size + n : n)) >>> 0);
    },
  },
  cidrnetmask: { params: ['prefix'], arity: [1, 1], run: ([p]) => { try { const { bits } = parseCidr(str(p, 0)); return intToIp(bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0); } catch (e) { throw new FnError(0, (e as Error).message); } } },
  cidrsubnets: {
    params: ['prefix', 'newbits'],
    arity: [2, -1],
    run: ([p, ...nbs], ctx) => {
      const base = parseCidr(str(p, 0));
      let next = base.base;
      return nbs.map((nb, i) => {
        const bits = base.bits + num(nb, i + 1);
        const size = Math.pow(2, 32 - bits);
        next = Math.ceil(next / size) * size;
        const out = cidrText(next >>> 0, bits);
        next += size;
        void ctx;
        return out;
      });
    },
  },
  // sensitivity (handled specially in call(); listed so arity checks and "unknown function" work)
  sensitive: { params: ['value'], arity: [1, 1], run: ([v]) => v },
  nonsensitive: { params: ['value'], arity: [1, 1], run: ([v]) => v },
  try: { params: ['expressions'], arity: [1, -1], run: ([v]) => v },
  can: { params: ['expression'], arity: [1, 1], run: () => true },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

function fakeHash(text: string, len: number): string {
  let out = '';
  let h = 0x811c9dc5;
  while (out.length < len) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ out.length, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

/** Convert with a Terraform-style diagnostic on failure. */
export function convertOrFail(v: Val, t: TypeSpec, summary: string, detailPrefix: string, pos: Pos): Val {
  try {
    return convert(v, t);
  } catch (e) {
    if (e instanceof ConvertError) fail(summary, `${detailPrefix}: ${e.message}.`, pos);
    throw e;
  }
}
