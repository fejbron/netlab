import { parseExpr, parseSelect, TODAY, type Expr, type FromItem, type Select, type Stmt } from './parser';
import { SqlError, type ColumnDef, type SqlDatabase, type SqlState, type SqlType, type SqlValue, type StatementResult, type TableDef } from './types';

/* ------------------------------------------------------------------ values */

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG']);

export function isNum(v: SqlValue): v is number {
  return typeof v === 'number';
}

/** SQL comparison. Returns null when either side is NULL, because the answer is unknown. */
function cmp(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = a === true ? 1 : 0;
    const y = b === true ? 1 : 0;
    return x - y;
  }
  if (isNum(a) && isNum(b)) return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ordering for ORDER BY, where NULL is not unknown but simply last. */
function orderCmp(a: SqlValue, b: SqlValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b) ?? 0;
}

function truthy(v: SqlValue): boolean {
  return v === true;
}

function num(v: SqlValue, what: string): number {
  if (v === null) return NaN;
  if (isNum(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new SqlError('invalid input syntax for type numeric: "' + v + '"', undefined, 'Used by ' + what + '.');
  return n;
}

/** Render a value the way psql prints it. NULL is an empty cell. */
export function display(v: SqlValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (isNum(v)) return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return v;
}

/** Coerce a value on its way into a column, or explain why it cannot go there. */
export function coerce(v: SqlValue, col: ColumnDef, table: string): SqlValue {
  if (v === null) return null;
  switch (col.type) {
    case 'integer':
    case 'bigint': {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      if (Number.isNaN(n)) throw new SqlError('invalid input syntax for type integer: "' + String(v) + '"');
      if (!Number.isInteger(n)) throw new SqlError('invalid input syntax for type integer: "' + String(v) + '"', undefined, 'Column "' + col.name + '" of table "' + table + '" holds whole numbers.');
      return n;
    }
    case 'numeric': {
      const n = Number(v);
      if (Number.isNaN(n)) throw new SqlError('invalid input syntax for type numeric: "' + String(v) + '"');
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      if (['t', 'true', 'yes', 'on', '1'].includes(s)) return true;
      if (['f', 'false', 'no', 'off', '0'].includes(s)) return false;
      throw new SqlError('invalid input syntax for type boolean: "' + String(v) + '"');
    }
    case 'date':
    case 'timestamp': {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
        throw new SqlError('invalid input syntax for type ' + col.type + ': "' + s + '"', undefined, 'Dates are written as \'YYYY-MM-DD\'.');
      }
      return col.type === 'date' ? s.slice(0, 10) : s;
    }
    default: {
      const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      if (col.length !== undefined && s.length > col.length) {
        throw new SqlError('value too long for type character varying(' + col.length + ')', undefined, 'Column "' + col.name + '" of table "' + table + '" holds at most ' + col.length + ' characters.');
      }
      return s;
    }
  }
}

function castTo(v: SqlValue, type: SqlType): SqlValue {
  return coerce(v, { name: 'cast', type }, 'cast');
}

/* ------------------------------------------------------------------ scopes */

interface ColRef {
  table?: string;
  name: string;
}

interface RowSet {
  cols: ColRef[];
  rows: SqlValue[][];
}

/** What an expression is evaluated against: one row, plus the group behind it for aggregates. */
interface Scope {
  cols: ColRef[];
  row: SqlValue[];
  group?: SqlValue[][];
  /** The enclosing query's scope, so a correlated subquery can see the outer row. */
  outer?: Scope;
}

function findColumn(scope: Scope, ref: { table?: string; name: string }): number {
  const hits: number[] = [];
  scope.cols.forEach((c, i) => {
    if (c.name !== ref.name) return;
    if (ref.table && c.table !== ref.table) return;
    hits.push(i);
  });
  if (hits.length > 1) throw new SqlError('column reference "' + ref.name + '" is ambiguous', undefined, 'Say which table it comes from, for example ' + (scope.cols[hits[0]].table ?? 't') + '.' + ref.name + '.');
  return hits[0] ?? -1;
}

/* -------------------------------------------------------------- evaluation */

export function evaluate(e: Expr, scope: Scope, db: SqlDatabase): SqlValue {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'star':
      throw new SqlError('syntax error at or near "*"');
    case 'col': {
      const i = findColumn(scope, e);
      if (i >= 0) return scope.row[i];
      for (let o = scope.outer; o; o = o.outer) {
        const j = findColumn(o, e);
        if (j >= 0) return o.row[j];
      }
      const qualified = e.table ? e.table + '.' + e.name : e.name;
      throw new SqlError('column "' + qualified + '" does not exist', undefined, columnHint(scope, e.name));
    }
    case 'not': {
      const v = evaluate(e.e, scope, db);
      return v === null ? null : !truthy(v);
    }
    case 'neg': {
      const v = evaluate(e.e, scope, db);
      return v === null ? null : -num(v, 'negation');
    }
    case 'cast':
      return castTo(evaluate(e.e, scope, db), e.type);
    case 'isnull': {
      const v = evaluate(e.e, scope, db);
      return e.not ? v !== null : v === null;
    }
    case 'between': {
      const v = evaluate(e.e, scope, db);
      const lo = cmp(v, evaluate(e.lo, scope, db));
      const hi = cmp(v, evaluate(e.hi, scope, db));
      if (lo === null || hi === null) return null;
      const inside = lo >= 0 && hi <= 0;
      return e.not ? !inside : inside;
    }
    case 'like': {
      const v = evaluate(e.e, scope, db);
      const p = evaluate(e.pat, scope, db);
      if (v === null || p === null) return null;
      const re = likeRegex(String(p), e.ci === true);
      const hit = re.test(String(v));
      return e.not ? !hit : hit;
    }
    case 'in': {
      const v = evaluate(e.e, scope, db);
      const values = e.list ? e.list.map((x) => evaluate(x, scope, db)) : runSelect(db, e.sub!, scope).rows.map((r) => r[0]);
      if (v === null) return null;
      let sawNull = false;
      for (const other of values) {
        if (other === null) {
          sawNull = true;
          continue;
        }
        if (cmp(v, other) === 0) return !e.not;
      }
      // NOT IN with a NULL in the list can never be true: the answer is unknown.
      return sawNull ? null : Boolean(e.not);
    }
    case 'exists': {
      const rows = runSelect(db, e.sub, scope).rows;
      return e.not ? rows.length === 0 : rows.length > 0;
    }
    case 'scalar': {
      const r = runSelect(db, e.sub, scope);
      if (r.rows.length > 1) throw new SqlError('more than one row returned by a subquery used as an expression');
      return r.rows.length === 0 ? null : r.rows[0][0];
    }
    case 'case': {
      const operand = e.operand ? evaluate(e.operand, scope, db) : undefined;
      for (const w of e.whens) {
        const hit = operand === undefined ? truthy(evaluate(w.when, scope, db)) : cmp(operand, evaluate(w.when, scope, db)) === 0;
        if (hit) return evaluate(w.then, scope, db);
      }
      return e.alt ? evaluate(e.alt, scope, db) : null;
    }
    case 'bin':
      return binary(e.op, e.l, e.r, scope, db);
    case 'fn':
      return callFunction(e, scope, db);
  }
}

function columnHint(scope: Scope, name: string): string | undefined {
  const near = scope.cols.find((c) => c.name.toLowerCase().startsWith(name.slice(0, 3).toLowerCase()) && c.name !== name);
  return near ? 'Perhaps you meant "' + near.name + '".' : undefined;
}

function likeRegex(pattern: string, ci: boolean): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}

function binary(op: string, le: Expr, re: Expr, scope: Scope, db: SqlDatabase): SqlValue {
  if (op === 'AND' || op === 'OR') {
    const l = evaluate(le, scope, db);
    // Short-circuit the cases three-valued logic settles from one side alone.
    if (op === 'AND' && l === false) return false;
    if (op === 'OR' && l === true) return true;
    const r = evaluate(re, scope, db);
    if (op === 'AND') return r === false ? false : l === null || r === null ? null : true;
    return r === true ? true : l === null || r === null ? null : false;
  }
  const l = evaluate(le, scope, db);
  const r = evaluate(re, scope, db);
  if (op === '||') return l === null || r === null ? null : display(l) + display(r);
  if (l === null || r === null) return null;
  switch (op) {
    case '=':
      return cmp(l, r) === 0;
    case '<>':
      return cmp(l, r) !== 0;
    case '<':
      return (cmp(l, r) ?? 0) < 0;
    case '>':
      return (cmp(l, r) ?? 0) > 0;
    case '<=':
      return (cmp(l, r) ?? 0) <= 0;
    case '>=':
      return (cmp(l, r) ?? 0) >= 0;
    case '+':
      return num(l, '+') + num(r, '+');
    case '-':
      return num(l, '-') - num(r, '-');
    case '*':
      return num(l, '*') * num(r, '*');
    case '/': {
      const d = num(r, '/');
      if (d === 0) throw new SqlError('division by zero');
      const a = num(l, '/');
      // Integer division truncates in SQL when both sides are whole numbers.
      return Number.isInteger(a) && Number.isInteger(d) ? Math.trunc(a / d) : a / d;
    }
    case '%': {
      const d = num(r, '%');
      if (d === 0) throw new SqlError('division by zero');
      return num(l, '%') % d;
    }
    default:
      throw new SqlError('operator does not exist: ' + op);
  }
}

function aggregateInputs(e: Expr, scope: Scope, db: SqlDatabase): SqlValue[] {
  const rows = scope.group ?? [scope.row];
  return rows.map((row) => evaluate(e, { ...scope, row, group: undefined }, db));
}

function callFunction(e: Extract<Expr, { k: 'fn' }>, scope: Scope, db: SqlDatabase): SqlValue {
  const name = e.name;
  if (AGGREGATES.has(name)) {
    if (name === 'COUNT') {
      const rows = scope.group ?? [scope.row];
      if (e.args.length === 0 || e.args[0].k === 'star') return rows.length;
      let vals: SqlValue[] = aggregateInputs(e.args[0], scope, db).filter((v) => v !== null);
      if (e.distinct) vals = [...new Set(vals.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s) as SqlValue);
      return vals.length;
    }
    let vals: SqlValue[] = aggregateInputs(e.args[0], scope, db).filter((v) => v !== null);
    if (e.distinct) vals = [...new Set(vals.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s) as SqlValue);
    if (vals.length === 0) return null;
    switch (name) {
      case 'SUM':
        return vals.reduce((n: number, v) => n + num(v, 'sum'), 0);
      case 'AVG': {
        const total = vals.reduce((n: number, v) => n + num(v, 'avg'), 0);
        return total / vals.length;
      }
      case 'MIN':
        return vals.reduce((a, b) => ((cmp(b, a) ?? 0) < 0 ? b : a));
      case 'MAX':
        return vals.reduce((a, b) => ((cmp(b, a) ?? 0) > 0 ? b : a));
      default: {
        const sep = e.args[1] ? String(evaluate(e.args[1], { ...scope, group: undefined }, db)) : ',';
        return vals.map((v) => display(v)).join(sep);
      }
    }
  }

  const args = e.args.map((a) => evaluate(a, scope, db));
  const one = args[0];
  switch (name) {
    case 'CURRENT_DATE':
      return TODAY;
    case 'CURRENT_TIMESTAMP':
    case 'NOW':
      return TODAY + ' 00:00:00';
    case 'UPPER':
      return one === null ? null : display(one).toUpperCase();
    case 'LOWER':
      return one === null ? null : display(one).toLowerCase();
    case 'LENGTH':
    case 'CHAR_LENGTH':
      return one === null ? null : display(one).length;
    case 'TRIM':
      return one === null ? null : display(one).trim();
    case 'LTRIM':
      return one === null ? null : display(one).replace(/^\s+/, '');
    case 'RTRIM':
      return one === null ? null : display(one).replace(/\s+$/, '');
    case 'INITCAP':
      return one === null ? null : display(one).replace(/\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'REPLACE':
      return one === null ? null : display(one).split(display(args[1])).join(display(args[2]));
    case 'SUBSTRING':
    case 'SUBSTR': {
      if (one === null) return null;
      const s = display(one);
      const from = Math.max(1, num(args[1], 'substring'));
      const len = args[2] === undefined ? undefined : num(args[2], 'substring');
      return len === undefined ? s.slice(from - 1) : s.slice(from - 1, from - 1 + len);
    }
    case 'POSITION':
    case 'STRPOS':
      return one === null ? null : display(one).indexOf(display(args[1])) + 1;
    case 'CONCAT':
      return args.filter((a) => a !== null).map((a) => display(a)).join('');
    case 'COALESCE':
      return args.find((a) => a !== null) ?? null;
    case 'NULLIF':
      return cmp(one, args[1]) === 0 ? null : one;
    case 'GREATEST':
      return args.filter((a) => a !== null).reduce((a, b) => ((cmp(b, a) ?? 0) > 0 ? b : a), null as SqlValue);
    case 'LEAST': {
      const vals = args.filter((a) => a !== null);
      return vals.length === 0 ? null : vals.reduce((a, b) => ((cmp(b, a) ?? 0) < 0 ? b : a));
    }
    case 'ABS':
      return one === null ? null : Math.abs(num(one, 'abs'));
    case 'ROUND': {
      if (one === null) return null;
      const places = args[1] === undefined ? 0 : num(args[1], 'round');
      const f = Math.pow(10, places);
      return Math.round(num(one, 'round') * f) / f;
    }
    case 'CEIL':
    case 'CEILING':
      return one === null ? null : Math.ceil(num(one, 'ceil'));
    case 'FLOOR':
      return one === null ? null : Math.floor(num(one, 'floor'));
    case 'MOD':
      return one === null ? null : num(one, 'mod') % num(args[1], 'mod');
    case 'EXTRACT':
      throw new SqlError('EXTRACT is not supported here', undefined, 'Compare the date directly, for example ordered_on >= \'2026-01-01\'.');
    case 'DEFAULT':
      throw new SqlError('DEFAULT is not allowed here');
    default:
      throw new SqlError('function ' + name.toLowerCase() + '(' + args.map(() => '...').join(', ') + ') does not exist');
  }
}

/** True when an expression contains an aggregate call, so the query must be grouped. */
function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate);
    case 'bin':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'not':
    case 'neg':
    case 'cast':
    case 'isnull':
      return hasAggregate(e.e);
    case 'between':
      return hasAggregate(e.e) || hasAggregate(e.lo) || hasAggregate(e.hi);
    case 'like':
      return hasAggregate(e.e) || hasAggregate(e.pat);
    case 'in':
      return hasAggregate(e.e) || (e.list ?? []).some(hasAggregate);
    case 'case':
      return Boolean(e.operand && hasAggregate(e.operand)) || e.whens.some((w) => hasAggregate(w.when) || hasAggregate(w.then)) || Boolean(e.alt && hasAggregate(e.alt));
    default:
      return false;
  }
}

/* --------------------------------------------------------------- resolving */

export function getTable(db: SqlDatabase, name: string): TableDef {
  const t = db.tables[name];
  if (t) return t;
  const near = Object.keys(db.tables).find((n) => n.startsWith(name.slice(0, 3)) || n === name + 's' || name === n + 's');
  throw new SqlError('relation "' + name + '" does not exist', undefined, near ? 'Perhaps you meant "' + near + '". \\dt lists every table.' : '\\dt lists the tables in this database.');
}

function sourceOf(db: SqlDatabase, item: FromItem, outer?: Scope): RowSet {
  if (item.k === 'sub') {
    const r = runSelect(db, item.sel, outer);
    return { cols: r.columns.map((name) => ({ table: item.alias, name })), rows: r.rows };
  }
  if (item.k === 'join') {
    const l = sourceOf(db, item.l, outer);
    const r = sourceOf(db, item.r, outer);
    return joinRows(db, item, l, r, outer);
  }
  const view = db.views[item.name];
  if (view && !db.tables[item.name]) {
    const r = runSelect(db, parseSelect(view.query), outer);
    const names = view.columns ?? r.columns;
    return { cols: names.map((name) => ({ table: item.alias ?? item.name, name })), rows: r.rows };
  }
  const t = getTable(db, item.name);
  const alias = item.alias ?? item.name;
  return { cols: t.columns.map((c) => ({ table: alias, name: c.name })), rows: t.rows.map((r) => [...r]) };
}

function joinRows(db: SqlDatabase, item: Extract<FromItem, { k: 'join' }>, l: RowSet, r: RowSet, outer?: Scope): RowSet {
  const cols = [...l.cols, ...r.cols];
  const out: SqlValue[][] = [];
  const nullsR = r.cols.map(() => null as SqlValue);
  const nullsL = l.cols.map(() => null as SqlValue);
  const matchedRight = new Set<number>();

  const matches = (a: SqlValue[], b: SqlValue[]): boolean => {
    if (item.type === 'cross') return true;
    if (item.using) {
      return item.using.every((name) => {
        const i = l.cols.findIndex((c) => c.name === name);
        const j = r.cols.findIndex((c) => c.name === name);
        if (i < 0 || j < 0) throw new SqlError('column "' + name + '" specified in USING clause does not exist in both tables');
        return cmp(a[i], b[j]) === 0;
      });
    }
    return truthy(evaluate(item.on!, { cols, row: [...a, ...b], outer }, db));
  };

  for (const a of l.rows) {
    let hit = false;
    r.rows.forEach((b, j) => {
      if (!matches(a, b)) return;
      hit = true;
      matchedRight.add(j);
      out.push([...a, ...b]);
    });
    if (!hit && (item.type === 'left' || item.type === 'full')) out.push([...a, ...nullsR]);
  }
  if (item.type === 'right' || item.type === 'full') {
    r.rows.forEach((b, j) => {
      if (!matchedRight.has(j)) out.push([...nullsL, ...b]);
    });
  }
  return { cols, rows: out };
}

/* ----------------------------------------------------------------- SELECT */

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

function outputName(item: { expr: Expr; alias?: string }, index: number): string {
  if (item.alias) return item.alias;
  if (item.expr.k === 'col') return item.expr.name;
  if (item.expr.k === 'fn') return item.expr.name.toLowerCase();
  if (item.expr.k === 'case') return 'case';
  return '?column?' + (index === 0 ? '' : '');
}

export function runSelect(db: SqlDatabase, sel: Select, outer?: Scope): QueryResult {
  const src: RowSet = sel.from ? sourceOf(db, sel.from, outer) : { cols: [], rows: [[]] };

  let rows = src.rows;
  if (sel.where) {
    if (hasAggregate(sel.where)) throw new SqlError('aggregate functions are not allowed in WHERE', undefined, 'Filter groups with HAVING instead.');
    rows = rows.filter((row) => truthy(evaluate(sel.where!, { cols: src.cols, row, outer }, db)));
  }

  // Expand "*" and "t.*" into real columns.
  const items: Array<{ expr: Expr; alias?: string }> = [];
  for (const item of sel.items) {
    if (item.expr.k === 'star') {
      const table = item.expr.table;
      const wanted = src.cols.filter((c) => !table || c.table === table);
      if (table && wanted.length === 0) throw new SqlError('missing FROM-clause entry for table "' + table + '"');
      for (const c of wanted) items.push({ expr: { k: 'col', table: c.table, name: c.name } });
      continue;
    }
    items.push(item);
  }

  const grouped = Boolean(sel.groupBy?.length) || items.some((i) => hasAggregate(i.expr)) || Boolean(sel.having && hasAggregate(sel.having));
  const columns = items.map(outputName);

  interface Out {
    values: SqlValue[];
    scope: Scope;
  }
  const produced: Out[] = [];

  if (!grouped) {
    for (const row of rows) {
      const scope: Scope = { cols: src.cols, row, outer };
      produced.push({ values: items.map((i) => evaluate(i.expr, scope, db)), scope });
    }
  } else {
    const keys = sel.groupBy ?? [];
    const groups = new Map<string, SqlValue[][]>();
    if (keys.length === 0) groups.set('', rows);
    else {
      for (const row of rows) {
        const scope: Scope = { cols: src.cols, row, outer };
        const key = JSON.stringify(keys.map((k) => evaluate(k, scope, db)));
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }
    }
    for (const group of groups.values()) {
      const scope: Scope = { cols: src.cols, row: group[0] ?? src.cols.map(() => null), group, outer };
      if (sel.having && !truthy(evaluate(sel.having, scope, db))) continue;
      for (const item of items) {
        if (!hasAggregate(item.expr) && !isGroupedBy(item.expr, keys)) {
          const shown = item.expr.k === 'col' ? item.expr.name : 'that expression';
          throw new SqlError(
            'column "' + shown + '" must appear in the GROUP BY clause or be used in an aggregate function',
            undefined,
            'Every selected column has to be either grouped or summarised.',
          );
        }
      }
      produced.push({ values: items.map((i) => evaluate(i.expr, scope, db)), scope });
    }
  }

  let out = produced;
  if (sel.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const key = JSON.stringify(r.values);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (sel.orderBy?.length) {
    const keyed = out.map((r) => ({
      r,
      keys: sel.orderBy!.map((o) => {
        if (o.expr.k === 'lit' && isNum(o.expr.v)) {
          const idx = o.expr.v - 1;
          if (idx < 0 || idx >= columns.length) throw new SqlError('ORDER BY position ' + o.expr.v + ' is not in select list');
          return r.values[idx];
        }
        if (o.expr.k === 'col' && !o.expr.table) {
          const idx = columns.indexOf(o.expr.name);
          if (idx >= 0 && (grouped || items[idx]?.alias)) return r.values[idx];
        }
        return evaluate(o.expr, r.scope, db);
      }),
    }));
    keyed.sort((a, b) => {
      for (let i = 0; i < a.keys.length; i++) {
        const d = orderCmp(a.keys[i], b.keys[i]);
        if (d !== 0) return sel.orderBy![i].desc ? -d : d;
      }
      return 0;
    });
    out = keyed.map((x) => x.r);
  }

  let values = out.map((r) => r.values);
  if (sel.offset) values = values.slice(sel.offset);
  if (sel.limit !== undefined) values = values.slice(0, sel.limit);

  let result: QueryResult = { columns, rows: values };
  if (sel.setOp) {
    const other = runSelect(db, sel.setOp.sel, outer);
    if (other.columns.length !== result.columns.length) {
      throw new SqlError('each ' + sel.setOp.op + ' query must have the same number of columns');
    }
    result = combine(sel.setOp.op, Boolean(sel.setOp.all), result, other);
  }
  return result;
}

function combine(op: 'UNION' | 'INTERSECT' | 'EXCEPT', all: boolean, a: QueryResult, b: QueryResult): QueryResult {
  const key = (r: SqlValue[]) => JSON.stringify(r);
  let rows: SqlValue[][];
  if (op === 'UNION') rows = [...a.rows, ...b.rows];
  else if (op === 'INTERSECT') {
    const keep = new Set(b.rows.map(key));
    rows = a.rows.filter((r) => keep.has(key(r)));
  } else {
    const drop = new Set(b.rows.map(key));
    rows = a.rows.filter((r) => !drop.has(key(r)));
  }
  if (!all) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = key(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { columns: a.columns, rows };
}

function isGroupedBy(e: Expr, keys: Expr[]): boolean {
  const same = JSON.stringify(e);
  return keys.some((k) => JSON.stringify(k) === same);
}

/* ------------------------------------------------------------ constraints */

function rowScope(t: TableDef, row: SqlValue[]): Scope {
  return { cols: t.columns.map((c) => ({ table: t.name, name: c.name })), row };
}

/** Apply every constraint on the table to one row that is about to be stored. */
function enforce(db: SqlDatabase, t: TableDef, row: SqlValue[], skipRow: number | null): void {
  t.columns.forEach((col, i) => {
    if (col.notNull && row[i] === null) {
      throw new SqlError('null value in column "' + col.name + '" of relation "' + t.name + '" violates not-null constraint', 'Failing row contains (' + row.map((v) => (v === null ? 'null' : display(v))).join(', ') + ').');
    }
    if ((col.primaryKey || col.unique) && row[i] !== null) {
      const clash = t.rows.findIndex((other, idx) => idx !== skipRow && cmp(other[i], row[i]) === 0);
      if (clash >= 0) {
        throw new SqlError(
          'duplicate key value violates unique constraint "' + t.name + '_' + col.name + '_key"',
          'Key (' + col.name + ')=(' + display(row[i]) + ') already exists.',
          col.primaryKey ? 'A primary key has to be unique across the whole table.' : undefined,
        );
      }
    }
    if (col.references && row[i] !== null) {
      const parent = db.tables[col.references.table];
      if (parent) {
        const pkIndex = col.references.column ? parent.columns.findIndex((c) => c.name === col.references!.column) : parent.columns.findIndex((c) => c.primaryKey);
        if (pkIndex >= 0 && !parent.rows.some((r) => cmp(r[pkIndex], row[i]) === 0)) {
          throw new SqlError(
            'insert or update on table "' + t.name + '" violates foreign key constraint "' + t.name + '_' + col.name + '_fkey"',
            'Key (' + col.name + ')=(' + display(row[i]) + ') is not present in table "' + parent.name + '".',
            'Add that row to "' + parent.name + '" first, or point at one that exists.',
          );
        }
      }
    }
    if (col.check) checkOne(db, t, row, col.check, col.name);
  });
  for (const text of t.checks ?? []) checkOne(db, t, row, text, undefined);
}

function checkOne(db: SqlDatabase, t: TableDef, row: SqlValue[], text: string, column: string | undefined): void {
  const v = evaluate(parseExpr(text), rowScope(t, row), db);
  if (v === false) {
    throw new SqlError(
      'new row for relation "' + t.name + '" violates check constraint "' + t.name + '_' + (column ?? 'check') + '_check"',
      'Failing row contains (' + row.map((x) => (x === null ? 'null' : display(x))).join(', ') + ').',
      'The rule is CHECK (' + text + ').',
    );
  }
}

/** A referencing row somewhere else would be orphaned by deleting this one. */
function blockOrphans(db: SqlDatabase, t: TableDef, removed: SqlValue[][]): void {
  const pkIndex = t.columns.findIndex((c) => c.primaryKey);
  if (pkIndex < 0) return;
  for (const child of Object.values(db.tables)) {
    if (child.name === t.name) continue;
    child.columns.forEach((col, i) => {
      if (col.references?.table !== t.name) return;
      for (const gone of removed) {
        const hit = child.rows.find((r) => r[i] !== null && cmp(r[i], gone[pkIndex]) === 0);
        if (hit) {
          throw new SqlError(
            'update or delete on table "' + t.name + '" violates foreign key constraint "' + child.name + '_' + col.name + '_fkey" on table "' + child.name + '"',
            'Key (' + t.columns[pkIndex].name + ')=(' + display(gone[pkIndex]) + ') is still referenced from table "' + child.name + '".',
            'Delete the rows in "' + child.name + '" first.',
          );
        }
      }
    });
  }
}

/* -------------------------------------------------------------- statements */

function columnIndex(t: TableDef, name: string): number {
  const i = t.columns.findIndex((c) => c.name === name);
  if (i < 0) throw new SqlError('column "' + name + '" of relation "' + t.name + '" does not exist', undefined, '\\d ' + t.name + ' lists its columns.');
  return i;
}

function defaultFor(col: ColumnDef, t: TableDef, i: number): SqlValue {
  if (col.serial !== undefined) {
    const used = t.rows.map((r) => (isNum(r[i]) ? (r[i] as number) : 0));
    const next = Math.max(col.serial, ...used.map((n) => n + 1), 1);
    col.serial = next + 1;
    return next;
  }
  return col.default ?? null;
}

export function execute(state: SqlState, stmt: Stmt, source: string): StatementResult {
  const db = state.db;
  switch (stmt.k) {
    case 'select': {
      const r = runSelect(db, stmt.sel);
      state.lastResult = r;
      return { tag: 'SELECT ' + r.rows.length, columns: r.columns, rows: r.rows };
    }
    case 'explain':
      return { tag: 'EXPLAIN', columns: ['QUERY PLAN'], rows: explain(db, stmt.sel, stmt.analyze === true).map((line) => [line]) };
    case 'insert':
      return insert(db, stmt);
    case 'update':
      return update(db, stmt);
    case 'delete':
      return remove(db, stmt);
    case 'createTable': {
      if (db.tables[stmt.name] || db.views[stmt.name]) {
        if (stmt.ifNotExists) return { tag: 'CREATE TABLE', notices: ['NOTICE:  relation "' + stmt.name + '" already exists, skipping'] };
        throw new SqlError('relation "' + stmt.name + '" already exists');
      }
      for (const col of stmt.columns) {
        if (col.references && !db.tables[col.references.table]) {
          throw new SqlError('relation "' + col.references.table + '" does not exist', undefined, 'A foreign key can only point at a table that already exists, so create "' + col.references.table + '" first.');
        }
        if (col.references && !col.references.column) {
          const parent = db.tables[col.references.table];
          const pk = parent.columns.find((c) => c.primaryKey);
          if (!pk) throw new SqlError('there is no primary key for referenced table "' + col.references.table + '"');
          col.references.column = pk.name;
        }
      }
      db.tables[stmt.name] = { name: stmt.name, columns: stmt.columns, rows: [], checks: stmt.checks.length ? stmt.checks : undefined };
      return { tag: 'CREATE TABLE' };
    }
    case 'dropTable': {
      for (const name of stmt.names) {
        if (!db.tables[name]) {
          if (stmt.ifExists) continue;
          throw new SqlError('table "' + name + '" does not exist');
        }
        const t = db.tables[name];
        blockOrphans(db, t, t.rows);
        delete db.tables[name];
        for (const idx of Object.values(db.indexes)) if (idx.table === name) delete db.indexes[idx.name];
      }
      return { tag: 'DROP TABLE' };
    }
    case 'alterTable':
      return alter(db, stmt);
    case 'createIndex': {
      const t = getTable(db, stmt.table);
      for (const c of stmt.columns) columnIndex(t, c);
      const name = stmt.name ?? stmt.table + '_' + stmt.columns.join('_') + '_idx';
      if (db.indexes[name]) {
        if (stmt.ifNotExists) return { tag: 'CREATE INDEX', notices: ['NOTICE:  relation "' + name + '" already exists, skipping'] };
        throw new SqlError('relation "' + name + '" already exists');
      }
      db.indexes[name] = { name, table: stmt.table, columns: stmt.columns, unique: stmt.unique };
      return { tag: 'CREATE INDEX' };
    }
    case 'dropIndex': {
      if (!db.indexes[stmt.name]) {
        if (stmt.ifExists) return { tag: 'DROP INDEX' };
        throw new SqlError('index "' + stmt.name + '" does not exist');
      }
      delete db.indexes[stmt.name];
      return { tag: 'DROP INDEX' };
    }
    case 'createView': {
      if (db.tables[stmt.name]) throw new SqlError('"' + stmt.name + '" is not a view', undefined, 'A table of that name already exists.');
      if (db.views[stmt.name] && !stmt.replace) throw new SqlError('relation "' + stmt.name + '" already exists', undefined, 'Use CREATE OR REPLACE VIEW to redefine it.');
      // Fail now rather than at first use if the query does not run.
      runSelect(db, parseSelect(stmt.query));
      db.views[stmt.name] = { name: stmt.name, query: stmt.query, columns: stmt.columns };
      return { tag: 'CREATE VIEW' };
    }
    case 'dropView': {
      if (!db.views[stmt.name]) {
        if (stmt.ifExists) return { tag: 'DROP VIEW' };
        throw new SqlError('view "' + stmt.name + '" does not exist');
      }
      delete db.views[stmt.name];
      return { tag: 'DROP VIEW' };
    }
    case 'begin':
      if (state.snapshot) return { tag: 'BEGIN', notices: ['WARNING:  there is already a transaction in progress'] };
      state.snapshot = structuredClone(db);
      return { tag: 'BEGIN' };
    case 'commit': {
      if (!state.snapshot) return { tag: 'COMMIT', notices: ['WARNING:  there is no transaction in progress'] };
      state.snapshot = undefined;
      state.aborted = false;
      return { tag: 'COMMIT' };
    }
    case 'rollback': {
      if (!state.snapshot) return { tag: 'ROLLBACK', notices: ['WARNING:  there is no transaction in progress'] };
      state.db = state.snapshot;
      state.snapshot = undefined;
      state.aborted = false;
      return { tag: 'ROLLBACK' };
    }
    default:
      throw new SqlError('syntax error at or near "' + source.trim().split(/\s+/)[0] + '"');
  }
}

function insert(db: SqlDatabase, stmt: Extract<Stmt, { k: 'insert' }>): StatementResult {
  const t = getTable(db, stmt.table);
  const names = stmt.columns ?? t.columns.map((c) => c.name);
  const targets = names.map((n) => columnIndex(t, n));
  const incoming: SqlValue[][] = [];

  if (stmt.select) {
    const r = runSelect(db, stmt.select);
    if (r.columns.length !== targets.length) throw new SqlError('INSERT has more expressions than target columns');
    incoming.push(...r.rows);
  } else {
    for (const exprs of stmt.values!) {
      if (exprs.length !== targets.length) {
        throw new SqlError(
          exprs.length > targets.length ? 'INSERT has more expressions than target columns' : 'INSERT has more target columns than expressions',
          undefined,
          'The column list has ' + targets.length + ' name' + (targets.length === 1 ? '' : 's') + ' and VALUES has ' + exprs.length + '.',
        );
      }
      incoming.push(exprs.map((e) => (e.k === 'fn' && e.name === 'DEFAULT' ? undefined : evaluate(e, { cols: [], row: [] }, db)) as SqlValue));
    }
  }

  const added: SqlValue[][] = [];
  for (const values of incoming) {
    const row = t.columns.map((col, i) => {
      const at = targets.indexOf(i);
      if (at < 0 || values[at] === undefined) return defaultFor(col, t, i);
      return coerce(values[at], col, t.name);
    });
    enforce(db, t, row, null);
    t.rows.push(row);
    added.push(row);
  }
  return { tag: 'INSERT 0 ' + added.length };
}

function update(db: SqlDatabase, stmt: Extract<Stmt, { k: 'update' }>): StatementResult {
  const t = getTable(db, stmt.table);
  const sets = stmt.set.map((s) => ({ i: columnIndex(t, s.col), e: s.e }));
  let touched = 0;
  t.rows.forEach((row, idx) => {
    const scope = rowScope(t, row);
    if (stmt.where && !truthy(evaluate(stmt.where, scope, db))) return;
    const next = [...row];
    for (const s of sets) next[s.i] = coerce(evaluate(s.e, scope, db), t.columns[s.i], t.name);
    enforce(db, t, next, idx);
    t.rows[idx] = next;
    touched++;
  });
  return { tag: 'UPDATE ' + touched };
}

function remove(db: SqlDatabase, stmt: Extract<Stmt, { k: 'delete' }>): StatementResult {
  const t = getTable(db, stmt.table);
  const keep: SqlValue[][] = [];
  const gone: SqlValue[][] = [];
  for (const row of t.rows) {
    if (stmt.where && !truthy(evaluate(stmt.where, rowScope(t, row), db))) keep.push(row);
    else gone.push(row);
  }
  blockOrphans(db, t, gone);
  t.rows = keep;
  return { tag: 'DELETE ' + gone.length };
}

function alter(db: SqlDatabase, stmt: Extract<Stmt, { k: 'alterTable' }>): StatementResult {
  const t = getTable(db, stmt.table);
  const a = stmt.action;
  switch (a.a) {
    case 'addColumn': {
      if (t.columns.some((c) => c.name === a.column.name)) throw new SqlError('column "' + a.column.name + '" of relation "' + t.name + '" already exists');
      if (a.column.notNull && t.rows.length > 0 && a.column.default === undefined && a.column.serial === undefined) {
        throw new SqlError('column "' + a.column.name + '" of relation "' + t.name + '" contains null values', undefined, 'Give the new column a DEFAULT, or add it without NOT NULL and fill it in first.');
      }
      t.columns.push(a.column);
      t.rows.forEach((row) => row.push(a.column.serial !== undefined ? defaultFor(a.column, t, t.columns.length - 1) : (a.column.default ?? null)));
      return { tag: 'ALTER TABLE' };
    }
    case 'dropColumn': {
      const i = t.columns.findIndex((c) => c.name === a.name);
      if (i < 0) {
        if (a.ifExists) return { tag: 'ALTER TABLE' };
        throw new SqlError('column "' + a.name + '" of relation "' + t.name + '" does not exist');
      }
      t.columns.splice(i, 1);
      t.rows.forEach((row) => row.splice(i, 1));
      return { tag: 'ALTER TABLE' };
    }
    case 'renameColumn': {
      const i = columnIndex(t, a.from);
      t.columns[i] = { ...t.columns[i], name: a.to };
      return { tag: 'ALTER TABLE' };
    }
    case 'renameTable': {
      if (db.tables[a.to]) throw new SqlError('relation "' + a.to + '" already exists');
      delete db.tables[t.name];
      t.name = a.to;
      db.tables[a.to] = t;
      return { tag: 'ALTER TABLE' };
    }
    case 'setNotNull': {
      const i = columnIndex(t, a.column);
      if (a.notNull && t.rows.some((r) => r[i] === null)) {
        throw new SqlError('column "' + a.column + '" of relation "' + t.name + '" contains null values', undefined, 'Fill those rows in before adding the constraint.');
      }
      t.columns[i] = { ...t.columns[i], notNull: a.notNull };
      return { tag: 'ALTER TABLE' };
    }
    case 'addCheck': {
      t.checks = [...(t.checks ?? []), a.text];
      for (const row of t.rows) checkOne(db, t, row, a.text, undefined);
      return { tag: 'ALTER TABLE' };
    }
    case 'addUnique':
    case 'addPrimaryKey': {
      for (const name of a.columns) {
        const i = columnIndex(t, name);
        t.columns[i] = { ...t.columns[i], unique: true, ...(a.a === 'addPrimaryKey' ? { primaryKey: true, notNull: true } : {}) };
      }
      t.rows.forEach((row, idx) => enforce(db, t, row, idx));
      return { tag: 'ALTER TABLE' };
    }
    case 'addForeignKey': {
      const parent = db.tables[a.table];
      if (!parent) throw new SqlError('relation "' + a.table + '" does not exist');
      a.columns.forEach((name, n) => {
        const i = columnIndex(t, name);
        const refColumn = a.refColumns[n] ?? parent.columns.find((c) => c.primaryKey)?.name ?? '';
        t.columns[i] = { ...t.columns[i], references: { table: a.table, column: refColumn } };
      });
      t.rows.forEach((row, idx) => enforce(db, t, row, idx));
      return { tag: 'ALTER TABLE' };
    }
  }
}

/* ---------------------------------------------------------------- EXPLAIN */

/** Columns a WHERE clause compares to a constant, which is what an index can serve. */
function filteredColumns(e: Expr | undefined, out: string[] = []): string[] {
  if (!e) return out;
  if (e.k === 'bin' && ['=', '<', '>', '<=', '>='].includes(e.op)) {
    if (e.l.k === 'col' && e.r.k === 'lit') out.push(e.l.name);
    if (e.r.k === 'col' && e.l.k === 'lit') out.push(e.r.name);
  }
  if (e.k === 'bin') {
    filteredColumns(e.l, out);
    filteredColumns(e.r, out);
  }
  if (e.k === 'between' && e.e.k === 'col') out.push(e.e.name);
  if (e.k === 'in' && e.e.k === 'col' && e.list) out.push(e.e.name);
  return out;
}

/**
 * A readable, deliberately simplified plan. Row counts are real because the query is
 * actually run; the costs are illustrative, and the point is whether an index was used.
 */
function explain(db: SqlDatabase, sel: Select, analyze: boolean): string[] {
  const lines: string[] = [];
  const scan = (item: FromItem, depth: number): void => {
    const pad = '  '.repeat(depth);
    if (item.k === 'join') {
      lines.push(pad + (depth === 0 ? '' : '->  ') + (item.type === 'cross' ? 'Nested Loop' : item.type === 'inner' ? 'Hash Join' : item.type.charAt(0).toUpperCase() + item.type.slice(1) + ' Join'));
      scan(item.l, depth + 1);
      scan(item.r, depth + 1);
      return;
    }
    if (item.k === 'sub') {
      lines.push(pad + '->  Subquery Scan on ' + item.alias);
      return;
    }
    const t = db.tables[item.name];
    const rows = t ? t.rows.length : 0;
    const wanted = filteredColumns(sel.where);
    const usable = Object.values(db.indexes).find((idx) => idx.table === item.name && wanted.includes(idx.columns[0]));
    const head = usable ? 'Index Scan using ' + usable.name + ' on ' + item.name : 'Seq Scan on ' + item.name;
    const cost = usable ? (Math.log2(rows + 2) * 4).toFixed(2) : (rows * 0.01 + 1).toFixed(2);
    lines.push(pad + (depth === 0 ? '' : '->  ') + head + '  (cost=0.00..' + cost + ' rows=' + rows + ' width=32)');
    if (sel.where) lines.push(pad + '  ' + (usable ? 'Index Cond' : 'Filter') + ': ' + describeWhere(sel.where));
  };

  if (sel.from) scan(sel.from, 0);
  else lines.push('Result');
  if (sel.groupBy?.length) lines.unshift('HashAggregate  (keys: ' + sel.groupBy.length + ')');
  if (sel.orderBy?.length) lines.unshift('Sort  (key: ' + sel.orderBy.length + ')');
  if (analyze) {
    const r = runSelect(db, sel);
    lines.push('Planning Time: 0.100 ms');
    lines.push('Execution Time: ' + (0.02 + r.rows.length * 0.001).toFixed(3) + ' ms');
  }
  return lines;
}

function describeWhere(e: Expr): string {
  switch (e.k) {
    case 'bin':
      return '(' + describeWhere(e.l) + ' ' + e.op.toLowerCase() + ' ' + describeWhere(e.r) + ')';
    case 'col':
      return e.name;
    case 'lit':
      return e.v === null ? 'NULL' : typeof e.v === 'string' ? "'" + e.v + "'::text" : display(e.v);
    case 'isnull':
      return '(' + describeWhere(e.e) + ' IS ' + (e.not ? 'NOT ' : '') + 'NULL)';
    case 'like':
      return '(' + describeWhere(e.e) + ' ~~ ' + describeWhere(e.pat) + ')';
    case 'between':
      return '(' + describeWhere(e.e) + ' >= ' + describeWhere(e.lo) + ' AND ' + describeWhere(e.e) + ' <= ' + describeWhere(e.hi) + ')';
    default:
      return '...';
  }
}
