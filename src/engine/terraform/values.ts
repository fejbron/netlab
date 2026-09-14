/**
 * Terraform values at evaluation time. Plain JSON-like data, plus two markers that
 * only exist while a command runs: UNKNOWN for a value that will be known after apply,
 * and a tag on arrays that are sets, because for_each cares about the difference.
 */
import { diag, DiagError, type Pos } from './hcl';

export class Unknown {
  readonly unknown = true;
}
export const UNKNOWN = new Unknown();

export type Val = null | boolean | number | string | Val[] | ValObject | Unknown;
export interface ValObject {
  [key: string]: Val;
}

const SET = Symbol('set');
const MAP = Symbol('map');
const LIST = Symbol('list');

export function makeList(items: Val[]): Val[] {
  Object.defineProperty(items, LIST, { value: true });
  return items;
}

export function isList(v: Val): boolean {
  return Array.isArray(v) && Boolean((v as unknown as Record<symbol, boolean>)[LIST]);
}

export function isUnknown(v: unknown): v is Unknown {
  return v instanceof Unknown;
}

export function isObj(v: Val | undefined): v is ValObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Unknown);
}

export function makeSet(items: Val[]): Val[] {
  const seen = new Set<string>();
  const out: Val[] = [];
  for (const v of items) {
    const key = JSON.stringify(v);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  if (out.every((v) => typeof v === 'string')) (out as string[]).sort();
  Object.defineProperty(out, SET, { value: true });
  return out;
}

export function isSet(v: Val): boolean {
  return Array.isArray(v) && Boolean((v as unknown as Record<symbol, boolean>)[SET]);
}

export function makeMap(o: ValObject): ValObject {
  const out: ValObject = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  Object.defineProperty(out, MAP, { value: true });
  return out;
}

export function isMap(v: Val): boolean {
  return isObj(v) && Boolean((v as unknown as Record<symbol, boolean>)[MAP]);
}

/** True when v or anything inside it is unknown. */
export function hasUnknown(v: Val): boolean {
  if (isUnknown(v)) return true;
  if (Array.isArray(v)) return v.some(hasUnknown);
  if (isObj(v)) return Object.values(v).some(hasUnknown);
  return false;
}

export function typeName(v: Val): string {
  if (v === null) return 'null';
  if (isUnknown(v)) return 'unknown';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return isSet(v) ? 'set' : isList(v) ? 'list' : 'tuple';
  return isMap(v) ? 'map' : 'object';
}

export function equal(a: Val, b: Val): boolean {
  return canonical(a) === canonical(b);
}

/** Stable JSON for comparisons: object keys sorted. */
export function canonical(v: Val): string {
  if (isUnknown(v)) return '<unknown>';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** Deep copy, dropping the set and map tags (for state and plan storage). */
export function plain(v: Val): Val {
  if (Array.isArray(v)) return v.map(plain);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

// ---------------------------------------------------------------------------
// HCL-style rendering, used by plan output, `terraform output` and the console

export function renderString(s: string): string {
  return JSON.stringify(s).replace(/\$\{/g, '$${');
}

export function renderInline(v: Val): string {
  if (isUnknown(v)) return '(known after apply)';
  if (v === null) return 'null';
  if (typeof v === 'string') return renderString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(renderInline).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => `${k} = ${renderInline(x)}`).join(', ') + '}';
}

/** Multi-line rendering, as `terraform output` and the console print it. */
export function renderValue(v: Val, indent = ''): string[] {
  if (isUnknown(v)) return ['(known after apply)'];
  if (Array.isArray(v)) {
    if (v.length === 0) return [isSet(v) ? 'toset([])' : '[]'];
    const lines = [isSet(v) ? 'toset([' : '['];
    for (const item of v) {
      const r = renderValue(item, indent + '  ');
      r[r.length - 1] += ',';
      lines.push(indent + '  ' + r[0], ...r.slice(1));
    }
    lines.push(indent + (isSet(v) ? '])' : ']'));
    return lines;
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return ['{}'];
    const needsQuote = (k: string) => isMap(v) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k);
    const width = Math.max(...keys.map((k) => (needsQuote(k) ? JSON.stringify(k) : k).length));
    const lines = [isMap(v) ? 'tomap({' : '{'];
    for (const k of keys) {
      const name = (needsQuote(k) ? JSON.stringify(k) : k).padEnd(width);
      const r = renderValue(v[k], indent + '  ');
      lines.push(`${indent}  ${name} = ${r[0]}`, ...r.slice(1));
    }
    lines.push(indent + (isMap(v) ? '})' : '}'));
    return lines;
  }
  return [renderInline(v)];
}

// ---------------------------------------------------------------------------
// type constraints

export type TypeSpec =
  | { t: 'string' | 'number' | 'bool' | 'any' }
  | { t: 'list' | 'set' | 'map'; of: TypeSpec }
  | { t: 'object'; attrs: Record<string, { type: TypeSpec; optional?: boolean; default?: Val }> }
  | { t: 'tuple'; items: TypeSpec[] };

export const T = {
  string: { t: 'string' } as TypeSpec,
  number: { t: 'number' } as TypeSpec,
  bool: { t: 'bool' } as TypeSpec,
  any: { t: 'any' } as TypeSpec,
  list: (of: TypeSpec): TypeSpec => ({ t: 'list', of }),
  set: (of: TypeSpec): TypeSpec => ({ t: 'set', of }),
  map: (of: TypeSpec): TypeSpec => ({ t: 'map', of }),
};

export function typeText(t: TypeSpec): string {
  switch (t.t) {
    case 'list':
    case 'set':
    case 'map':
      return `${t.t}(${typeText(t.of)})`;
    case 'object':
      return 'object({' + Object.entries(t.attrs).map(([k, a]) => `${k}=${a.optional ? `optional(${typeText(a.type)})` : typeText(a.type)}`).join(', ') + '})';
    case 'tuple':
      return 'tuple([' + t.items.map(typeText).join(', ') + '])';
    default:
      return t.t;
  }
}

export class ConvertError extends Error {}

function article(t: TypeSpec): string {
  switch (t.t) {
    case 'string':
      return 'string required';
    case 'number':
      return 'a number is required';
    case 'bool':
      return 'a bool is required';
    case 'list':
      return 'list of ' + typeText(t.of) + ' required';
    case 'set':
      return 'set of ' + typeText(t.of) + ' required';
    case 'map':
      return 'map of ' + typeText(t.of) + ' required';
    case 'object':
      return 'object required';
    case 'tuple':
      return 'tuple required';
    default:
      return 'value required';
  }
}

/** Convert a value to a type constraint, the way Terraform's automatic conversion does. */
export function convert(v: Val, t: TypeSpec, path = ''): Val {
  const at = path ? `${path}: ` : '';
  if (isUnknown(v) || t.t === 'any') return v;
  if (v === null) return null;
  switch (t.t) {
    case 'string':
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new ConvertError(at + 'string required');
    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      throw new ConvertError(at + article(t));
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw new ConvertError(at + article(t));
    case 'list':
    case 'set': {
      if (!Array.isArray(v)) throw new ConvertError(at + article(t));
      const items = v.map((x, i) => convert(x, t.of, `element ${i}`));
      return t.t === 'set' ? makeSet(items) : makeList(items);
    }
    case 'map': {
      if (!isObj(v)) throw new ConvertError(at + article(t));
      return makeMap(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x, t.of, `element ${JSON.stringify(k)}`)])));
    }
    case 'tuple': {
      if (!Array.isArray(v) || v.length !== t.items.length) throw new ConvertError(at + article(t));
      return v.map((x, i) => convert(x, t.items[i], `element ${i}`));
    }
    case 'object': {
      if (!isObj(v)) throw new ConvertError(at + 'object required');
      const out: ValObject = {};
      for (const [k, a] of Object.entries(t.attrs)) {
        if (k in v && v[k] !== null) out[k] = convert(v[k], a.type, `attribute ${JSON.stringify(k)}`);
        else if (a.optional) out[k] = a.default !== undefined ? convert(a.default, a.type) : null;
        else throw new ConvertError(`attribute ${JSON.stringify(k)} is required`);
      }
      return out;
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// numbers and strings

export function toNumber(v: Val, pos: Pos, what = 'operand'): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw new DiagError([diag('Invalid ' + what, `Unsuitable value for ${what}: a number is required.`, pos)]);
}

export function toStr(v: Val, pos: Pos): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) throw new DiagError([diag('Invalid template interpolation value', 'The expression result is null. Cannot include a null value in a string template.', pos)]);
  throw new DiagError([diag('Invalid template interpolation value', `Cannot include the given value in a string template: string required, but have ${typeName(v)}.`, pos)]);
}

export function toBool(v: Val, pos: Pos, what = 'condition'): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === null) throw new DiagError([diag(`Invalid ${what}`, `The ${what} value is null. Conditions must either be true or false.`, pos)]);
  throw new DiagError([diag(`Invalid ${what}`, `The ${what} expression must be a bool, but the given value is ${typeName(v)}.`, pos)]);
}
