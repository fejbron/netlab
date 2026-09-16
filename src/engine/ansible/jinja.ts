/**
 * The Jinja2 subset Ansible leans on: {{ expressions }}, {% if %}, {% for %} and
 * {% set %}, the filters and tests playbooks actually use, and Python-flavoured
 * expressions (and/or/not, in, comparisons, arithmetic, the inline conditional).
 *
 * Undefined variables behave the way they do in Ansible: harmless until something asks
 * for their value, at which point the error names the variable, unless default() or an
 * "is defined" test caught it first. A string that is exactly one expression keeps the
 * type it evaluated to, so a loop over "{{ my_list }}" iterates a list, not its text.
 */

export type JValue = unknown;

export class TemplateError extends Error {}

export class Undefined {
  constructor(public name: string) {}
}

export function isUndefined(v: unknown): v is Undefined {
  return v instanceof Undefined;
}

export interface Ctx {
  vars: Record<string, JValue>;
  /** lookup('file', path) and friends; absent in contexts that cannot reach a filesystem. */
  lookup?: (kind: string, arg: string, options: Record<string, JValue>) => JValue;
}

// ---------------------------------------------------------------------------
// expression parsing

type Tok = { t: 'name' | 'num' | 'str' | 'op'; v: string; pos: number };

const OPS = ['//', '**', '==', '!=', '>=', '<=', '{{', '}}', '|', '~', '+', '-', '*', '/', '%', '(', ')', '[', ']', '{', '}', ',', ':', '.', '<', '>', '='];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          const n = src[++i];
          s += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[n] ?? n;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new TemplateError('unexpected end of template, expected a closing quote');
      i++;
      out.push({ t: 'str', v: s, pos: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TemplateError(`unexpected character ${JSON.stringify(c)}`);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  return out;
}

type Node =
  | { k: 'lit'; v: JValue }
  | { k: 'name'; name: string }
  | { k: 'attr'; obj: Node; name: string }
  | { k: 'index'; obj: Node; index: Node }
  | { k: 'call'; fn: Node; args: Node[]; kwargs: Record<string, Node> }
  | { k: 'filter'; value: Node; name: string; args: Node[]; kwargs: Record<string, Node> }
  | { k: 'test'; value: Node; name: string; args: Node[]; negate: boolean }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'binary'; op: string; l: Node; r: Node }
  | { k: 'cond'; body: Node; test: Node; other?: Node }
  | { k: 'list'; items: Node[] }
  | { k: 'dict'; items: Array<[Node, Node]> };

class ExprParser {
  i = 0;

  constructor(private toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }

  at(v: string): boolean {
    const t = this.peek();
    return Boolean(t && ((t.t === 'op' && t.v === v) || (t.t === 'name' && t.v === v)));
  }

  eat(v: string): boolean {
    if (!this.at(v)) return false;
    this.i++;
    return true;
  }

  expect(v: string): void {
    if (!this.eat(v)) throw new TemplateError(`expected ${JSON.stringify(v)}`);
  }

  parse(): Node {
    const e = this.ternary();
    if (this.i < this.toks.length) throw new TemplateError(`unexpected ${JSON.stringify(this.toks[this.i].v)}`);
    return e;
  }

  ternary(): Node {
    const body = this.or();
    if (this.eat('if')) {
      const test = this.or();
      const other = this.eat('else') ? this.ternary() : undefined;
      return { k: 'cond', body, test, other };
    }
    return body;
  }

  or(): Node {
    let l = this.and();
    while (this.eat('or')) l = { k: 'binary', op: 'or', l, r: this.and() };
    return l;
  }

  and(): Node {
    let l = this.not();
    while (this.eat('and')) l = { k: 'binary', op: 'and', l, r: this.not() };
    return l;
  }

  not(): Node {
    if (this.eat('not')) return { k: 'unary', op: 'not', e: this.not() };
    return this.comparison();
  }

  comparison(): Node {
    let l = this.concat();
    while (true) {
      const t = this.peek();
      if (t && t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        this.i++;
        l = { k: 'binary', op: t.v, l, r: this.concat() };
        continue;
      }
      if (this.at('in')) {
        this.i++;
        l = { k: 'binary', op: 'in', l, r: this.concat() };
        continue;
      }
      if (t && t.t === 'name' && t.v === 'not' && this.toks[this.i + 1]?.v === 'in') {
        this.i += 2;
        l = { k: 'unary', op: 'not', e: { k: 'binary', op: 'in', l, r: this.concat() } };
        continue;
      }
      if (this.at('is')) {
        this.i++;
        const negate = this.eat('not');
        const name = this.peek();
        if (!name || name.t !== 'name') throw new TemplateError('expected a test name after "is"');
        this.i++;
        const args: Node[] = [];
        if (this.at('(')) {
          this.i++;
          while (!this.eat(')')) {
            args.push(this.ternary());
            this.eat(',');
          }
        } else if (['equalto', 'match', 'search', 'version', 'in'].includes(name.v)) {
          args.push(this.concat());
        }
        l = { k: 'test', value: l, name: name.v, args, negate };
        continue;
      }
      return l;
    }
  }

  concat(): Node {
    let l = this.additive();
    while (this.at('~')) {
      this.i++;
      l = { k: 'binary', op: '~', l, r: this.additive() };
    }
    return l;
  }

  additive(): Node {
    let l = this.multiplicative();
    while (true) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.i++;
        l = { k: 'binary', op: t.v, l, r: this.multiplicative() };
      } else return l;
    }
  }

  multiplicative(): Node {
    let l = this.unary();
    while (true) {
      const t = this.peek();
      if (t && t.t === 'op' && ['*', '/', '//', '%', '**'].includes(t.v)) {
        this.i++;
        l = { k: 'binary', op: t.v, l, r: this.unary() };
      } else return l;
    }
  }

  unary(): Node {
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '-') {
      this.i++;
      return { k: 'unary', op: '-', e: this.unary() };
    }
    return this.filtered();
  }

  filtered(): Node {
    let value = this.postfix(this.primary());
    while (this.at('|')) {
      this.i++;
      const name = this.peek();
      if (!name || name.t !== 'name') throw new TemplateError('expected a filter name after |');
      this.i++;
      const { args, kwargs } = this.arguments();
      value = this.postfix({ k: 'filter', value, name: name.v, args, kwargs });
    }
    return value;
  }

  arguments(): { args: Node[]; kwargs: Record<string, Node> } {
    const args: Node[] = [];
    const kwargs: Record<string, Node> = {};
    if (!this.at('(')) return { args, kwargs };
    this.i++;
    while (!this.eat(')')) {
      const t = this.peek();
      if (t && t.t === 'name' && this.toks[this.i + 1]?.v === '=' && this.toks[this.i + 1]?.t === 'op') {
        this.i += 2;
        kwargs[t.v] = this.ternary();
      } else args.push(this.ternary());
      this.eat(',');
    }
    return { args, kwargs };
  }

  postfix(node: Node): Node {
    while (true) {
      if (this.at('.')) {
        this.i++;
        const name = this.peek();
        if (!name) throw new TemplateError('expected an attribute name');
        this.i++;
        node = { k: 'attr', obj: node, name: name.v };
        continue;
      }
      if (this.at('[')) {
        this.i++;
        const index = this.ternary();
        this.expect(']');
        node = { k: 'index', obj: node, index };
        continue;
      }
      if (this.at('(')) {
        const { args, kwargs } = this.arguments();
        node = { k: 'call', fn: node, args, kwargs };
        continue;
      }
      return node;
    }
  }

  primary(): Node {
    const t = this.peek();
    if (!t) throw new TemplateError('unexpected end of expression');
    if (t.t === 'num') {
      this.i++;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.t === 'str') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'name') {
      this.i++;
      if (['true', 'True'].includes(t.v)) return { k: 'lit', v: true };
      if (['false', 'False'].includes(t.v)) return { k: 'lit', v: false };
      if (['none', 'None'].includes(t.v)) return { k: 'lit', v: null };
      return { k: 'name', name: t.v };
    }
    if (t.v === '(') {
      this.i++;
      const e = this.ternary();
      this.expect(')');
      return e;
    }
    if (t.v === '[') {
      this.i++;
      const items: Node[] = [];
      while (!this.eat(']')) {
        items.push(this.ternary());
        this.eat(',');
      }
      return { k: 'list', items };
    }
    if (t.v === '{') {
      this.i++;
      const items: Array<[Node, Node]> = [];
      while (!this.eat('}')) {
        const key = this.ternary();
        this.expect(':');
        items.push([key, this.ternary()]);
        this.eat(',');
      }
      return { k: 'dict', items };
    }
    throw new TemplateError(`unexpected ${JSON.stringify(t.v)}`);
  }
}

export function parseExpression(src: string): Node {
  return new ExprParser(lex(src)).parse();
}

// ---------------------------------------------------------------------------
// evaluation

function truthy(v: JValue): boolean {
  if (isUndefined(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

export function toText(v: JValue): string {
  if (isUndefined(v)) throw new TemplateError(`'${v.name}' is undefined`);
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'object') return JSON.stringify(v).replace(/"/g, "'").replace(/:/g, ': ').replace(/,/g, ', ');
  return String(v);
}

function num(v: JValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TemplateError(`expected a number, got ${JSON.stringify(v)}`);
}

function equal(a: JValue, b: JValue): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

class Evaluator {
  constructor(private ctx: Ctx) {}

  eval(n: Node): JValue {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'name': {
        if (n.name in this.ctx.vars) return this.ctx.vars[n.name];
        return new Undefined(n.name);
      }
      case 'attr': {
        const obj = this.eval(n.obj);
        return this.member(obj, n.name, describe(n));
      }
      case 'index': {
        const obj = this.eval(n.obj);
        const key = this.eval(n.index);
        if (Array.isArray(obj) && typeof key === 'number') {
          const at = key < 0 ? obj.length + key : key;
          return at in obj ? obj[at] : new Undefined(describe(n));
        }
        return this.member(obj, String(toText(key)), describe(n));
      }
      case 'list':
        return n.items.map((i) => this.eval(i));
      case 'dict':
        return Object.fromEntries(n.items.map(([k, v]) => [toText(this.eval(k)), this.eval(v)]));
      case 'unary': {
        if (n.op === 'not') return !truthy(this.eval(n.e));
        return -num(this.eval(n.e));
      }
      case 'binary':
        return this.binary(n);
      case 'cond': {
        if (truthy(this.eval(n.test))) return this.eval(n.body);
        return n.other ? this.eval(n.other) : new Undefined('conditional');
      }
      case 'filter':
        return this.filter(n);
      case 'test':
        return this.test(n);
      case 'call':
        return this.call(n);
    }
  }

  member(obj: JValue, name: string, path: string): JValue {
    if (isUndefined(obj)) return new Undefined(path);
    if (obj === null || obj === undefined) return new Undefined(path);
    if (Array.isArray(obj)) {
      if (name === 'length') return obj.length;
      return new Undefined(path);
    }
    if (typeof obj === 'object') {
      const rec = obj as Record<string, JValue>;
      return name in rec ? rec[name] : new Undefined(path);
    }
    if (typeof obj === 'string') {
      if (name === 'split') return (...args: JValue[]) => (args.length ? obj.split(String(args[0])) : obj.split(/\s+/).filter(Boolean));
      if (name === 'strip') return () => obj.trim();
      if (name === 'upper') return () => obj.toUpperCase();
      if (name === 'lower') return () => obj.toLowerCase();
      if (name === 'startswith') return (...args: JValue[]) => obj.startsWith(String(args[0]));
      if (name === 'endswith') return (...args: JValue[]) => obj.endsWith(String(args[0]));
    }
    return new Undefined(path);
  }

  binary(n: Extract<Node, { k: 'binary' }>): JValue {
    if (n.op === 'and') return truthy(this.eval(n.l)) ? this.eval(n.r) : this.eval(n.l);
    if (n.op === 'or') {
      const l = this.eval(n.l);
      return truthy(l) ? l : this.eval(n.r);
    }
    const l = this.eval(n.l);
    const r = this.eval(n.r);
    switch (n.op) {
      case '==':
        return equal(l, r);
      case '!=':
        return !equal(l, r);
      case '~':
        return toText(l) + toText(r);
      case 'in':
        if (Array.isArray(r)) return r.some((x) => equal(x, l));
        if (typeof r === 'string') return r.includes(toText(l));
        if (r && typeof r === 'object') return toText(l) in (r as Record<string, JValue>);
        return false;
      case '+':
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        if (typeof l === 'string' || typeof r === 'string') return toText(l) + toText(r);
        return num(l) + num(r);
      case '-':
        return num(l) - num(r);
      case '*':
        if (typeof l === 'string') return l.repeat(num(r));
        return num(l) * num(r);
      case '/':
        return num(l) / num(r);
      case '//':
        return Math.floor(num(l) / num(r));
      case '%':
        return num(l) % num(r);
      case '**':
        return Math.pow(num(l), num(r));
      case '<':
        return typeof l === 'string' && typeof r === 'string' ? l < r : num(l) < num(r);
      case '>':
        return typeof l === 'string' && typeof r === 'string' ? l > r : num(l) > num(r);
      case '<=':
        return typeof l === 'string' && typeof r === 'string' ? l <= r : num(l) <= num(r);
      case '>=':
        return typeof l === 'string' && typeof r === 'string' ? l >= r : num(l) >= num(r);
    }
    throw new TemplateError(`unsupported operator ${n.op}`);
  }

  call(n: Extract<Node, { k: 'call' }>): JValue {
    if (n.fn.k === 'name') {
      const args = n.args.map((a) => this.eval(a));
      switch (n.fn.name) {
        case 'range': {
          const [a, b, step] = args.map((x) => (x === undefined ? undefined : num(x)));
          const start = b === undefined ? 0 : a!;
          const end = b === undefined ? a! : b;
          const by = step ?? 1;
          const out: number[] = [];
          for (let i = start; by > 0 ? i < end : i > end; i += by) out.push(i);
          return out;
        }
        case 'lookup':
        case 'query':
        case 'q': {
          if (!this.ctx.lookup) throw new TemplateError('lookups are not available here');
          const kwargs = Object.fromEntries(Object.entries(n.kwargs).map(([k, v]) => [k, this.eval(v)]));
          return this.ctx.lookup(String(args[0]), toText(args[1]), kwargs);
        }
        case 'dict':
          return Object.fromEntries(Object.entries(n.kwargs).map(([k, v]) => [k, this.eval(v)]));
      }
    }
    const fn = this.eval(n.fn);
    if (typeof fn === 'function') return (fn as (...a: JValue[]) => JValue)(...n.args.map((a) => this.eval(a)));
    throw new TemplateError(`${describe(n.fn)} is not callable`);
  }

  filter(n: Extract<Node, { k: 'filter' }>): JValue {
    const args = n.args.map((a) => this.eval(a));
    const kwargs = Object.fromEntries(Object.entries(n.kwargs).map(([k, v]) => [k, this.eval(v)]));
    // default() and friends must see the undefined value rather than fail on it.
    const value = this.eval(n.value);
    const fn = FILTERS[n.name];
    if (!fn) throw new TemplateError(`no filter named '${n.name}'`);
    if (!['default', 'd', 'mandatory', 'ternary', 'bool', 'type_debug'].includes(n.name) && isUndefined(value)) {
      throw new TemplateError(`'${value.name}' is undefined`);
    }
    return fn(value, args, kwargs, this.ctx);
  }

  test(n: Extract<Node, { k: 'test' }>): JValue {
    const value = this.eval(n.value);
    const args = n.args.map((a) => this.eval(a));
    const result = runTest(n.name, value, args);
    return n.negate ? !result : result;
  }
}

function describe(n: Node): string {
  switch (n.k) {
    case 'name':
      return n.name;
    case 'attr':
      return `${describe(n.obj)}.${n.name}`;
    case 'index':
      return `${describe(n.obj)}[...]`;
    default:
      return 'expression';
  }
}

function runTest(name: string, value: JValue, args: JValue[]): boolean {
  switch (name) {
    case 'defined':
      return !isUndefined(value);
    case 'undefined':
      return isUndefined(value);
    case 'none':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'mapping':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'sequence':
    case 'iterable':
      return Array.isArray(value) || typeof value === 'string';
    case 'truthy':
      return truthy(value);
    case 'falsy':
      return !truthy(value);
    case 'equalto':
    case 'eq':
      return equal(value, args[0]);
    case 'ne':
      return !equal(value, args[0]);
    case 'in':
      return Array.isArray(args[0]) ? args[0].some((x) => equal(x, value)) : typeof args[0] === 'string' ? args[0].includes(toText(value)) : false;
    case 'match':
      return new RegExp(`^${toText(args[0])}`).test(toText(value));
    case 'search':
      return new RegExp(toText(args[0])).test(toText(value));
    // Ansible's result tests, used as "when: result is changed".
    case 'changed':
      return Boolean(asResult(value).changed);
    case 'failed':
    case 'failure':
      return Boolean(asResult(value).failed);
    case 'succeeded':
    case 'success':
    case 'successful':
      return !asResult(value).failed && !asResult(value).skipped;
    case 'skipped':
      return Boolean(asResult(value).skipped);
    default:
      throw new TemplateError(`no test named '${name}'`);
  }
}

function asResult(v: JValue): { changed?: boolean; failed?: boolean; skipped?: boolean } {
  return (v && typeof v === 'object' ? v : {}) as { changed?: boolean; failed?: boolean; skipped?: boolean };
}

type Filter = (value: JValue, args: JValue[], kwargs: Record<string, JValue>, ctx: Ctx) => JValue;

function asList(v: JValue): JValue[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v);
  if (typeof v === 'string') return [...v];
  throw new TemplateError(`expected a list, got ${JSON.stringify(v)}`);
}

function attrOf(item: JValue, attr: string): JValue {
  const parts = attr.split('.');
  let cur: JValue = item;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, JValue>)) cur = (cur as Record<string, JValue>)[p];
    else return new Undefined(attr);
  }
  return cur;
}

const FILTERS: Record<string, Filter> = {
  default: (v, a, k) => (isUndefined(v) || (truthy(k.boolean) && !truthy(v)) ? a[0] : v),
  d: (v, a, k) => FILTERS.default(v, a, k, { vars: {} }),
  mandatory: (v) => {
    if (isUndefined(v)) throw new TemplateError('Mandatory variable not defined.');
    return v;
  },
  upper: (v) => toText(v).toUpperCase(),
  lower: (v) => toText(v).toLowerCase(),
  capitalize: (v) => toText(v).charAt(0).toUpperCase() + toText(v).slice(1).toLowerCase(),
  title: (v) => toText(v).replace(/\b\w/g, (c) => c.toUpperCase()),
  trim: (v) => toText(v).trim(),
  string: (v) => toText(v),
  int: (v, a) => {
    const n = Number(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    return Number.isNaN(n) ? (a.length ? Number(a[0]) : 0) : Math.trunc(n);
  },
  float: (v, a) => {
    const n = Number(v);
    return Number.isNaN(n) ? (a.length ? Number(a[0]) : 0) : n;
  },
  abs: (v) => Math.abs(num(v)),
  round: (v, a) => {
    const p = a.length ? num(a[0]) : 0;
    const f = Math.pow(10, p);
    return Math.round(num(v) * f) / f;
  },
  bool: (v) => (isUndefined(v) ? false : typeof v === 'string' ? ['true', 'yes', 'on', '1'].includes(v.toLowerCase()) : truthy(v)),
  length: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  count: (v, a, k, c) => FILTERS.length(v, a, k, c),
  first: (v) => (asList(v).length ? asList(v)[0] : new Undefined('first')),
  last: (v) => {
    const l = asList(v);
    return l.length ? l[l.length - 1] : new Undefined('last');
  },
  list: (v) => asList(v),
  unique: (v) => {
    const seen = new Set<string>();
    return asList(v).filter((x) => {
      const key = JSON.stringify(x);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  sort: (v, _a, k) => {
    const attr = k.attribute ? String(k.attribute) : null;
    const items = [...asList(v)];
    items.sort((a, b) => {
      const x = attr ? attrOf(a, attr) : a;
      const y = attr ? attrOf(b, attr) : b;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return toText(x).localeCompare(toText(y));
    });
    return truthy(k.reverse) ? items.reverse() : items;
  },
  reverse: (v) => (typeof v === 'string' ? [...v].reverse().join('') : [...asList(v)].reverse()),
  min: (v) => asList(v).reduce((m, x) => (num(x) < num(m) ? x : m)),
  max: (v) => asList(v).reduce((m, x) => (num(x) > num(m) ? x : m)),
  sum: (v, _a, k) => asList(v).reduce((t: number, x) => t + num(k.attribute ? attrOf(x, String(k.attribute)) : x), 0),
  join: (v, a) => asList(v).map(toText).join(a.length ? toText(a[0]) : ''),
  split: (v, a) => (a.length ? toText(v).split(toText(a[0])) : toText(v).split(/\s+/).filter(Boolean)),
  replace: (v, a) => toText(v).split(toText(a[0])).join(toText(a[1])),
  regex_replace: (v, a) => toText(v).replace(new RegExp(toText(a[0]), 'g'), toText(a[1]).replace(/\\(\d)/g, '$$$1')),
  regex_search: (v, a) => {
    const m = new RegExp(toText(a[0])).exec(toText(v));
    return m ? m[0] : null;
  },
  regex_findall: (v, a) => [...toText(v).matchAll(new RegExp(toText(a[0]), 'g'))].map((m) => m[0]),
  regex_escape: (v) => toText(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  basename: (v) => toText(v).split('/').filter(Boolean).pop() ?? '',
  dirname: (v) => {
    const parts = toText(v).split('/');
    parts.pop();
    return parts.join('/') || '/';
  },
  quote: (v) => `'${toText(v).replace(/'/g, `'\\''`)}'`,
  b64encode: (v) => btoa(unescape(encodeURIComponent(toText(v)))),
  b64decode: (v) => decodeURIComponent(escape(atob(toText(v)))),
  to_json: (v) => JSON.stringify(v),
  to_nice_json: (v, _a, k) => JSON.stringify(v, null, k.indent ? num(k.indent) : 4),
  from_json: (v) => JSON.parse(toText(v)),
  to_yaml: (v) => JSON.stringify(v),
  ternary: (v, a) => (truthy(v) ? a[0] : a[1]),
  type_debug: (v) => (isUndefined(v) ? 'AnsibleUndefined' : Array.isArray(v) ? 'list' : v === null ? 'NoneType' : typeof v === 'object' ? 'dict' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v === 'boolean' ? 'bool' : 'str'),
  combine: (v, a, k) => {
    const deep = truthy(k.recursive);
    const merge = (x: JValue, y: JValue): JValue => {
      if (!deep || !x || !y || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) || Array.isArray(y)) return y;
      const out: Record<string, JValue> = { ...(x as Record<string, JValue>) };
      for (const [key, val] of Object.entries(y as Record<string, JValue>)) out[key] = key in out ? merge(out[key], val) : val;
      return out;
    };
    return a.reduce((acc: JValue, item) => (deep ? merge(acc, item) : { ...(acc as Record<string, JValue>), ...(item as Record<string, JValue>) }), v);
  },
  dict2items: (v) => Object.entries(v as Record<string, JValue>).map(([key, value]) => ({ key, value })),
  items2dict: (v) => Object.fromEntries(asList(v).map((i) => [toText(attrOf(i, 'key')), attrOf(i, 'value')])),
  map: (v, a, k) => {
    if (k.attribute !== undefined) return asList(v).map((i) => attrOf(i, String(k.attribute)));
    const name = toText(a[0]);
    const f = FILTERS[name];
    if (!f) throw new TemplateError(`no filter named '${name}'`);
    return asList(v).map((i) => f(i, a.slice(1), {}, { vars: {} }));
  },
  select: (v, a) => asList(v).filter((i) => (a.length ? runTest(toText(a[0]), i, a.slice(1)) : truthy(i))),
  reject: (v, a) => asList(v).filter((i) => !(a.length ? runTest(toText(a[0]), i, a.slice(1)) : truthy(i))),
  selectattr: (v, a) => asList(v).filter((i) => (a.length > 1 ? runTest(toText(a[1]), attrOf(i, toText(a[0])), a.slice(2)) : truthy(attrOf(i, toText(a[0]))))),
  rejectattr: (v, a) => asList(v).filter((i) => !(a.length > 1 ? runTest(toText(a[1]), attrOf(i, toText(a[0])), a.slice(2)) : truthy(attrOf(i, toText(a[0]))))),
  flatten: (v) => {
    const flat = (items: JValue[]): JValue[] => items.flatMap((i) => (Array.isArray(i) ? flat(i) : [i]));
    return flat(asList(v));
  },
  difference: (v, a) => asList(v).filter((x) => !asList(a[0]).some((y) => equal(x, y))),
  intersect: (v, a) => asList(v).filter((x) => asList(a[0]).some((y) => equal(x, y))),
  union: (v, a) => FILTERS.unique([...asList(v), ...asList(a[0])], [], {}, { vars: {} }),
  zip: (v, a) => asList(v).map((x, i) => [x, asList(a[0])[i]]),
  indent: (v, a) => toText(v).split('\n').map((l, i) => (i === 0 ? l : ' '.repeat(a.length ? num(a[0]) : 4) + l)).join('\n'),
  // Deterministic stand-ins: a real hash would be no more instructive here.
  password_hash: (v, a) => `$${a.length && toText(a[0]) === 'sha512' ? '6' : '5'}$netlab$${hashText(toText(v))}`,
  hash: (v) => hashText(toText(v)),
  md5: (v) => hashText(toText(v)).slice(0, 32),
  urlsplit: (v, a) => {
    const m = /^(\w+):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(toText(v));
    const parts: Record<string, JValue> = { scheme: m?.[1] ?? '', hostname: m?.[2] ?? '', port: m?.[3] ? Number(m[3]) : null, path: m?.[4] ?? '' };
    return a.length ? parts[toText(a[0])] : parts;
  },
};

function hashText(text: string): string {
  let h = 0x811c9dc5;
  let out = '';
  while (out.length < 43) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ out.length, 0x01000193) >>> 0;
    out += h.toString(36);
  }
  return out.slice(0, 43);
}

export function evaluateExpression(src: string, ctx: Ctx): JValue {
  return new Evaluator(ctx).eval(parseExpression(src));
}

// ---------------------------------------------------------------------------
// templates

interface Chunk {
  kind: 'text' | 'expr' | 'tag';
  text: string;
}

function chunks(src: string): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  let text = '';
  while (i < src.length) {
    const open = src.slice(i, i + 2);
    if (open === '{{' || open === '{%' || open === '{#') {
      const close = open === '{{' ? '}}' : open === '{%' ? '%}' : '#}';
      let end = src.indexOf(close, i + 2);
      if (end === -1) throw new TemplateError(`unexpected end of template, expected '${close}'`);
      let body = src.slice(i + 2, end);
      let trimBefore = false;
      let trimAfter = false;
      if (body.startsWith('-')) {
        trimBefore = true;
        body = body.slice(1);
      }
      if (body.endsWith('-')) {
        trimAfter = true;
        body = body.slice(0, -1);
      }
      if (trimBefore) text = text.replace(/\s+$/, '');
      if (text) out.push({ kind: 'text', text });
      text = '';
      if (open !== '{#') out.push({ kind: open === '{{' ? 'expr' : 'tag', text: body.trim() });
      i = end + 2;
      if (trimAfter) {
        while (i < src.length && /\s/.test(src[i])) i++;
      } else if (open === '{%' && src[i] === '\n') {
        // A tag alone on its line does not leave a blank line behind.
        const lineStart = src.lastIndexOf('\n', Math.max(0, i - (end - i))) + 1;
        void lineStart;
        i++;
      }
      continue;
    }
    text += src[i++];
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}

/** Render a template. Statements ({% if %}, {% for %}, {% set %}) are supported. */
export function renderTemplate(src: string, ctx: Ctx): string {
  const items = chunks(src);
  const ev = new Evaluator(ctx);
  let i = 0;

  const block = (stop: string[]): { text: string; ended: string } => {
    let out = '';
    while (i < items.length) {
      const c = items[i];
      if (c.kind === 'text') {
        out += c.text;
        i++;
        continue;
      }
      if (c.kind === 'expr') {
        out += toText(ev.eval(parseExpression(c.text)));
        i++;
        continue;
      }
      const word = c.text.split(/\s+/)[0];
      if (stop.includes(word)) return { text: out, ended: word };
      i++;
      if (word === 'if') {
        out += ifBlock(c.text.slice(2));
        continue;
      }
      if (word === 'for') {
        out += forBlock(c.text.slice(3));
        continue;
      }
      if (word === 'set') {
        const m = /^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(c.text);
        if (!m) throw new TemplateError('malformed {% set %}');
        ctx.vars[m[1]] = ev.eval(parseExpression(m[2]));
        continue;
      }
      throw new TemplateError(`unknown tag '${word}'`);
    }
    return { text: out, ended: '' };
  };

  const ifBlock = (condition: string): string => {
    let taken: string | null = null;
    let cond = condition;
    while (true) {
      const r = block(['elif', 'else', 'endif']);
      if (taken === null && truthy(ev.eval(parseExpression(cond)))) taken = r.text;
      if (r.ended === 'endif' || r.ended === '') {
        i++;
        return taken ?? '';
      }
      const next = items[i];
      i++;
      if (next.text.startsWith('elif')) cond = next.text.slice(4);
      else cond = 'true';
      if (taken !== null) cond = 'false';
    }
  };

  const forBlock = (header: string): string => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)?)\s+in\s+(.+?)(?:\s+if\s+(.+))?$/.exec(header);
    if (!m) throw new TemplateError('malformed {% for %}');
    const names = m[1].split(',').map((s) => s.trim());
    const collection = ev.eval(parseExpression(m[2]));
    const filter = m[3];
    const start = i;
    let out = '';
    const list = Array.isArray(collection) ? collection.map((v, idx) => [idx, v] as [JValue, JValue]) : collection && typeof collection === 'object' ? Object.entries(collection as Record<string, JValue>) : [];
    const kept = list.filter(([k, v]) => {
      if (!filter) return true;
      const saved = { ...ctx.vars };
      bind(names, k, v);
      const keep = truthy(ev.eval(parseExpression(filter)));
      ctx.vars = saved;
      return keep;
    });
    let ended = '';
    if (kept.length === 0) {
      i = start;
      const r = block(['else', 'endfor']);
      if (r.ended === 'else') {
        i++;
        const e = block(['endfor']);
        out += e.text;
      }
      i++;
      return out;
    }
    kept.forEach(([k, v], idx) => {
      i = start;
      const saved = { ...ctx.vars };
      bind(names, k, v);
      ctx.vars.loop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === kept.length - 1, length: kept.length };
      const r = block(['else', 'endfor']);
      out += r.text;
      ended = r.ended;
      ctx.vars = saved;
    });
    // Skip past any {% else %} branch and the {% endfor %}.
    if (ended === 'else') {
      i++;
      block(['endfor']);
    }
    i++;
    return out;
  };

  const bind = (names: string[], key: JValue, value: JValue) => {
    if (names.length === 1) ctx.vars[names[0]] = Array.isArray(value) || typeof key !== 'number' ? (typeof key === 'number' ? value : key) : value;
    else {
      ctx.vars[names[0]] = key;
      ctx.vars[names[1]] = value;
    }
    if (names.length === 1 && typeof key === 'number') ctx.vars[names[0]] = value;
  };

  return block([]).text;
}

/**
 * Template one value. A string that is exactly one expression keeps its type, so
 * "{{ my_list }}" is a list; anything else is rendered as text. Lists and dictionaries
 * are templated element by element.
 */
export function template(value: JValue, ctx: Ctx): JValue {
  if (Array.isArray(value)) return value.map((v) => template(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, JValue>).map(([k, v]) => [k, template(v, ctx)]));
  if (typeof value !== 'string') return value;
  if (!value.includes('{{') && !value.includes('{%')) return value;
  // A value that is nothing but one expression keeps its native type. Anything around it,
  // even a trailing newline, makes the result a string, exactly as Ansible does.
  const whole = /^\{\{(.*)\}\}$/s.exec(value);
  if (whole && !whole[1].includes('{{') && !whole[1].includes('}}')) {
    const v = new Evaluator(ctx).eval(parseExpression(whole[1].replace(/^-|-$/g, '')));
    if (isUndefined(v)) throw new TemplateError(`'${v.name}' is undefined`);
    // Templating a value that is itself a template (a variable holding "{{ other }}")
    // resolves all the way down, as Ansible does.
    return typeof v === 'string' && (v.includes('{{') || v.includes('{%')) ? template(v, ctx) : v;
  }
  const rendered = renderTemplate(value, ctx);
  return rendered.includes('{{') ? renderTemplate(rendered, ctx) : rendered;
}

/** Evaluate a when: expression (or any condition), which is a bare expression, not a template. */
export function condition(expr: JValue, ctx: Ctx): boolean {
  if (typeof expr === 'boolean') return expr;
  if (Array.isArray(expr)) return expr.every((e) => condition(e, ctx));
  const text = String(expr).trim();
  const bare = /^\s*\{\{(.*)\}\}\s*$/s.exec(text);
  return truthy(new Evaluator(ctx).eval(parseExpression(bare ? bare[1] : text)));
}
