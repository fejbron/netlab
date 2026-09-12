import { SqlError, type ColumnDef, type SqlType, type SqlValue } from './types';

/* ------------------------------------------------------------------ lexer */

export type TokenKind = 'word' | 'string' | 'number' | 'punct' | 'end';

export interface Token {
  kind: TokenKind;
  /** Upper-cased for words and punctuation, verbatim for strings and numbers. */
  value: string;
  /** As written, which is what an error message quotes. */
  raw: string;
  pos: number;
  /** A word written in "double quotes" keeps its case and is never a keyword. */
  quoted?: boolean;
}

const PUNCT = ['<>', '!=', '<=', '>=', '||', '::', '(', ')', ',', ';', '.', '+', '-', '*', '/', '%', '=', '<', '>'];

export function lex(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const start = i;
    if (c === "'") {
      i++;
      let s = '';
      for (;;) {
        if (i >= sql.length) throw new SqlError('unterminated quoted string at or near "' + sql.slice(start) + '"');
        if (sql[i] === "'" && sql[i + 1] === "'") {
          s += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        s += sql[i++];
      }
      out.push({ kind: 'string', value: s, raw: sql.slice(start, i), pos: start });
      continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < sql.length && sql[i] !== '"') s += sql[i++];
      if (i >= sql.length) throw new SqlError('unterminated quoted identifier at or near "' + sql.slice(start) + '"');
      i++;
      out.push({ kind: 'word', value: s, raw: sql.slice(start, i), pos: start, quoted: true });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++;
      out.push({ kind: 'number', value: sql.slice(start, i), raw: sql.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const raw = sql.slice(start, i);
      out.push({ kind: 'word', value: raw.toUpperCase(), raw, pos: start });
      continue;
    }
    const p = PUNCT.find((x) => sql.startsWith(x, i));
    if (!p) throw new SqlError('syntax error at or near "' + c + '"');
    i += p.length;
    out.push({ kind: 'punct', value: p, raw: p, pos: start });
  }
  out.push({ kind: 'end', value: '', raw: '', pos: sql.length });
  return out;
}

/** Split a script into statements on semicolons that are not inside quotes or parentheses. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote && sql[i + 1] === quote) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '-' && sql[i + 1] === '-') while (i < sql.length && sql[i] !== '\n') i++;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth <= 0) {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  const rest = sql.slice(start);
  if (rest.trim()) out.push(rest);
  return out.filter((s) => s.trim() !== '');
}

/** True when the text ends a statement, i.e. has a semicolon outside quotes. */
export function isComplete(sql: string): boolean {
  let quote: string | null = null;
  let last = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote && sql[i + 1] === quote) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (!/\s/.test(c)) last = c;
  }
  return !quote && last === ';';
}

/* -------------------------------------------------------------------- ast */

export type Expr =
  | { k: 'lit'; v: SqlValue; dec?: boolean }
  | { k: 'col'; table?: string; name: string }
  | { k: 'star'; table?: string }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'fn'; name: string; args: Expr[]; distinct?: boolean }
  | { k: 'case'; operand?: Expr; whens: Array<{ when: Expr; then: Expr }>; alt?: Expr }
  | { k: 'in'; e: Expr; list?: Expr[]; sub?: Select; not?: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not?: boolean }
  | { k: 'like'; e: Expr; pat: Expr; not?: boolean; ci?: boolean }
  | { k: 'isnull'; e: Expr; not?: boolean }
  | { k: 'exists'; sub: Select; not?: boolean }
  | { k: 'scalar'; sub: Select }
  | { k: 'cast'; e: Expr; type: SqlType };

export type FromItem =
  | { k: 'table'; name: string; alias?: string }
  | { k: 'sub'; sel: Select; alias: string }
  | { k: 'join'; type: 'inner' | 'left' | 'right' | 'full' | 'cross'; l: FromItem; r: FromItem; on?: Expr; using?: string[] };

export interface Select {
  distinct?: boolean;
  items: Array<{ expr: Expr; alias?: string }>;
  from?: FromItem;
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  orderBy?: Array<{ expr: Expr; desc?: boolean }>;
  limit?: number;
  offset?: number;
  setOp?: { op: 'UNION' | 'INTERSECT' | 'EXCEPT'; all?: boolean; sel: Select };
}

export type AlterAction =
  | { a: 'addColumn'; column: ColumnDef }
  | { a: 'dropColumn'; name: string; ifExists?: boolean }
  | { a: 'renameColumn'; from: string; to: string }
  | { a: 'renameTable'; to: string }
  | { a: 'setNotNull'; column: string; notNull: boolean }
  | { a: 'addCheck'; text: string }
  | { a: 'addUnique'; columns: string[] }
  | { a: 'addPrimaryKey'; columns: string[] }
  | { a: 'addForeignKey'; columns: string[]; table: string; refColumns: string[] };

export type Stmt =
  | { k: 'select'; sel: Select }
  | { k: 'insert'; table: string; columns?: string[]; values?: Expr[][]; select?: Select }
  | { k: 'update'; table: string; set: Array<{ col: string; e: Expr }>; where?: Expr }
  | { k: 'delete'; table: string; where?: Expr }
  | { k: 'createTable'; name: string; ifNotExists?: boolean; columns: ColumnDef[]; checks: string[]; primaryKey?: string[] }
  | { k: 'dropTable'; names: string[]; ifExists?: boolean }
  | { k: 'alterTable'; table: string; action: AlterAction }
  | { k: 'createIndex'; name?: string; table: string; columns: string[]; unique?: boolean; ifNotExists?: boolean }
  | { k: 'dropIndex'; name: string; ifExists?: boolean }
  | { k: 'createView'; name: string; replace?: boolean; query: string; columns?: string[] }
  | { k: 'dropView'; name: string; ifExists?: boolean }
  | { k: 'begin' }
  | { k: 'commit' }
  | { k: 'rollback' }
  | { k: 'explain'; sel: Select; analyze?: boolean };

/* ----------------------------------------------------------------- parser */

const TYPE_ALIASES: Record<string, SqlType> = {
  INT: 'integer',
  INTEGER: 'integer',
  INT4: 'integer',
  SMALLINT: 'integer',
  SERIAL: 'integer',
  BIGINT: 'bigint',
  INT8: 'bigint',
  BIGSERIAL: 'bigint',
  NUMERIC: 'numeric',
  DECIMAL: 'numeric',
  REAL: 'numeric',
  FLOAT: 'numeric',
  DOUBLE: 'numeric',
  MONEY: 'numeric',
  TEXT: 'text',
  VARCHAR: 'text',
  CHAR: 'text',
  CHARACTER: 'text',
  UUID: 'text',
  BOOL: 'boolean',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
  TIMESTAMPTZ: 'timestamp',
  DATETIME: 'timestamp',
};

/** Words that cannot be a bare alias, so "SELECT name FROM t" does not read FROM as one. */
const RESERVED = new Set([
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'USING',
  'UNION', 'INTERSECT', 'EXCEPT', 'AND', 'OR', 'NOT', 'AS', 'SET', 'VALUES', 'INTO', 'SELECT', 'WHEN', 'THEN', 'ELSE', 'END', 'CASE',
  'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS', 'DISTINCT', 'ASC', 'DESC', 'BY', 'DEFAULT', 'PRIMARY', 'REFERENCES',
  'UNIQUE', 'CHECK', 'CONSTRAINT', 'FOREIGN', 'KEY', 'TABLE', 'INDEX', 'VIEW', 'RETURNING',
]);

/** Words that start a clause, so they cannot be read as a column name. */
const CLAUSE_WORDS = new Set([
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'ON', 'USING', 'SET', 'VALUES', 'INTO',
  'UNION', 'INTERSECT', 'EXCEPT', 'AND', 'OR', 'THEN', 'ELSE', 'END', 'WHEN', 'BY', 'ASC', 'DESC',
]);

/** The date the labs are set on, so CURRENT_DATE is stable and gradeable. */
export const TODAY = '2026-03-01';

class Parser {
  private i = 0;
  constructor(
    private readonly t: Token[],
    private readonly src: string,
  ) {}

  private peek(n = 0): Token {
    return this.t[Math.min(this.i + n, this.t.length - 1)];
  }
  private at(...words: string[]): boolean {
    const tok = this.peek();
    if (tok.kind === 'word') return !tok.quoted && words.includes(tok.value);
    return tok.kind === 'punct' && words.includes(tok.value);
  }
  private next(): Token {
    return this.t[this.i++];
  }
  private eat(...words: string[]): boolean {
    if (!this.at(...words)) return false;
    this.i++;
    return true;
  }
  private expect(word: string): Token {
    if (!this.at(word)) this.fail();
    return this.next();
  }
  private fail(): never {
    const tok = this.peek();
    throw new SqlError(tok.kind === 'end' ? 'syntax error at end of input' : 'syntax error at or near "' + tok.raw + '"');
  }
  /** An identifier: a word used as a name rather than a keyword. */
  private name(): string {
    const tok = this.peek();
    if (tok.kind !== 'word') this.fail();
    this.i++;
    return tok.quoted ? tok.value : tok.raw.toLowerCase();
  }
  /** A bare word that may follow an expression as its alias. */
  private aliasAhead(): boolean {
    const tok = this.peek();
    return tok.kind === 'word' && (tok.quoted === true || !RESERVED.has(tok.value));
  }

  statement(): Stmt {
    if (this.at('SELECT', '(')) return { k: 'select', sel: this.select() };
    if (this.at('WITH')) throw new SqlError('common table expressions are not supported here', undefined, 'Write the subquery inside FROM instead.');
    if (this.eat('INSERT')) return this.insert();
    if (this.eat('UPDATE')) return this.update();
    if (this.eat('DELETE')) return this.deleteFrom();
    if (this.eat('CREATE')) return this.create();
    if (this.eat('DROP')) return this.drop();
    if (this.eat('ALTER')) return this.alter();
    if (this.eat('TRUNCATE')) {
      this.eat('TABLE');
      return { k: 'delete', table: this.name() };
    }
    if (this.eat('BEGIN', 'START')) {
      this.eat('TRANSACTION', 'WORK');
      return { k: 'begin' };
    }
    if (this.eat('COMMIT')) {
      this.eat('TRANSACTION', 'WORK');
      return { k: 'commit' };
    }
    if (this.eat('ROLLBACK', 'ABORT')) {
      this.eat('TRANSACTION', 'WORK');
      return { k: 'rollback' };
    }
    if (this.eat('EXPLAIN')) {
      const analyze = this.eat('ANALYZE', 'ANALYSE');
      this.eat('VERBOSE');
      return { k: 'explain', sel: this.select(), analyze };
    }
    this.fail();
  }

  /* ------------------------------------------------------------- queries */

  select(): Select {
    if (this.at('(')) {
      this.next();
      const inner = this.select();
      this.expect(')');
      return this.setOp(inner);
    }
    this.expect('SELECT');
    const sel: Select = { items: [] };
    if (this.eat('DISTINCT')) sel.distinct = true;
    else this.eat('ALL');
    do {
      if (this.at('*')) {
        this.next();
        sel.items.push({ expr: { k: 'star' } });
        continue;
      }
      const expr = this.expr();
      let alias: string | undefined;
      if (this.eat('AS')) alias = this.name();
      else if (this.aliasAhead()) alias = this.name();
      sel.items.push({ expr, alias });
    } while (this.eat(','));

    if (this.eat('FROM')) sel.from = this.fromItem();
    if (this.eat('WHERE')) sel.where = this.expr();
    if (this.eat('GROUP')) {
      this.expect('BY');
      sel.groupBy = [];
      do sel.groupBy.push(this.expr());
      while (this.eat(','));
    }
    if (this.eat('HAVING')) sel.having = this.expr();
    if (this.eat('ORDER')) {
      this.expect('BY');
      sel.orderBy = [];
      do {
        const expr = this.expr();
        let desc = false;
        if (this.eat('DESC')) desc = true;
        else this.eat('ASC');
        if (this.eat('NULLS')) this.eat('FIRST', 'LAST');
        sel.orderBy.push({ expr, desc });
      } while (this.eat(','));
    }
    if (this.eat('LIMIT') && !this.eat('ALL')) sel.limit = this.intLiteral();
    if (this.eat('OFFSET')) {
      sel.offset = this.intLiteral();
      this.eat('ROW', 'ROWS');
    }
    return this.setOp(sel);
  }

  private setOp(sel: Select): Select {
    if (this.at('UNION', 'INTERSECT', 'EXCEPT')) {
      const op = this.next().value as 'UNION' | 'INTERSECT' | 'EXCEPT';
      const all = this.eat('ALL');
      this.eat('DISTINCT');
      sel.setOp = { op, all, sel: this.select() };
    }
    return sel;
  }

  private intLiteral(): number {
    const tok = this.peek();
    if (tok.kind !== 'number') this.fail();
    this.next();
    return Number(tok.value);
  }

  private fromItem(): FromItem {
    let left = this.fromAtom();
    for (;;) {
      if (this.eat(',')) {
        left = { k: 'join', type: 'cross', l: left, r: this.fromAtom() };
        continue;
      }
      if (this.eat('CROSS')) {
        this.expect('JOIN');
        left = { k: 'join', type: 'cross', l: left, r: this.fromAtom() };
        continue;
      }
      let type: 'inner' | 'left' | 'right' | 'full' | null = null;
      if (this.eat('INNER')) type = 'inner';
      else if (this.eat('LEFT')) type = 'left';
      else if (this.eat('RIGHT')) type = 'right';
      else if (this.eat('FULL')) type = 'full';
      if (type) this.eat('OUTER');
      if (!this.at('JOIN')) {
        if (type) this.fail();
        return left;
      }
      this.next();
      const right = this.fromAtom();
      const join: FromItem = { k: 'join', type: type ?? 'inner', l: left, r: right };
      if (this.eat('ON')) join.on = this.expr();
      else if (this.eat('USING')) join.using = this.nameList();
      else throw new SqlError('syntax error at or near "' + this.peek().raw + '"', undefined, 'A JOIN needs ON to say how the two tables line up.');
      left = join;
    }
  }

  private fromAtom(): FromItem {
    if (this.at('(')) {
      this.next();
      const sel = this.select();
      this.expect(')');
      this.eat('AS');
      if (!this.aliasAhead()) throw new SqlError('subquery in FROM must have an alias', undefined, 'For example, FROM (SELECT ...) AS t.');
      return { k: 'sub', sel, alias: this.name() };
    }
    const name = this.name();
    let alias: string | undefined;
    if (this.eat('AS')) alias = this.name();
    else if (this.aliasAhead()) alias = this.name();
    return { k: 'table', name, alias };
  }

  /* --------------------------------------------------------- expressions */

  expr(): Expr {
    return this.or();
  }
  private or(): Expr {
    let e = this.and();
    while (this.eat('OR')) e = { k: 'bin', op: 'OR', l: e, r: this.and() };
    return e;
  }
  private and(): Expr {
    let e = this.notExpr();
    while (this.eat('AND')) e = { k: 'bin', op: 'AND', l: e, r: this.notExpr() };
    return e;
  }
  private notExpr(): Expr {
    if (this.eat('NOT')) return { k: 'not', e: this.notExpr() };
    return this.comparison();
  }

  private comparison(): Expr {
    let e = this.additive();
    for (;;) {
      if (this.at('=', '<', '>', '<=', '>=', '<>', '!=')) {
        const op = this.next().value;
        e = { k: 'bin', op: op === '!=' ? '<>' : op, l: e, r: this.additive() };
        continue;
      }
      if (this.eat('IS')) {
        const not = this.eat('NOT');
        if (this.eat('NULL')) {
          e = { k: 'isnull', e, not };
          continue;
        }
        if (this.at('TRUE', 'FALSE')) {
          const v = this.next().value === 'TRUE';
          const cmp: Expr = { k: 'bin', op: '=', l: e, r: { k: 'lit', v } };
          e = not ? { k: 'not', e: cmp } : cmp;
          continue;
        }
        this.fail();
      }
      const negated = this.at('NOT') && ['IN', 'LIKE', 'ILIKE', 'BETWEEN'].includes(this.peek(1).value);
      if (negated) this.next();
      if (this.eat('IN')) {
        this.expect('(');
        if (this.at('SELECT')) {
          const sub = this.select();
          this.expect(')');
          e = { k: 'in', e, sub, not: negated };
        } else {
          const list: Expr[] = [];
          do list.push(this.expr());
          while (this.eat(','));
          this.expect(')');
          e = { k: 'in', e, list, not: negated };
        }
        continue;
      }
      if (this.at('LIKE', 'ILIKE')) {
        const ci = this.next().value === 'ILIKE';
        e = { k: 'like', e, pat: this.additive(), not: negated, ci };
        continue;
      }
      if (this.eat('BETWEEN')) {
        const lo = this.additive();
        this.expect('AND');
        e = { k: 'between', e, lo, hi: this.additive(), not: negated };
        continue;
      }
      if (negated) this.fail();
      return e;
    }
  }

  private additive(): Expr {
    let e = this.multiplicative();
    while (this.at('+', '-', '||')) {
      const op = this.next().value;
      e = { k: 'bin', op, l: e, r: this.multiplicative() };
    }
    return e;
  }
  private multiplicative(): Expr {
    let e = this.unary();
    while (this.at('*', '/', '%')) {
      const op = this.next().value;
      e = { k: 'bin', op, l: e, r: this.unary() };
    }
    return e;
  }
  private unary(): Expr {
    if (this.eat('-')) return { k: 'neg', e: this.unary() };
    if (this.eat('+')) return this.unary();
    let e = this.primary();
    while (this.eat('::')) e = { k: 'cast', e, type: this.typeName().type };
    return e;
  }

  private primary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.next();
      return { k: 'lit', v: Number(tok.value), dec: tok.value.includes('.') };
    }
    if (tok.kind === 'string') {
      this.next();
      return { k: 'lit', v: tok.value };
    }
    if (this.eat('(')) {
      if (this.at('SELECT')) {
        const sub = this.select();
        this.expect(')');
        return { k: 'scalar', sub };
      }
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (this.eat('EXISTS')) {
      this.expect('(');
      const sub = this.select();
      this.expect(')');
      return { k: 'exists', sub };
    }
    if (this.eat('CASE')) return this.caseExpr();
    if (this.eat('CAST')) {
      this.expect('(');
      const e = this.expr();
      this.expect('AS');
      const type = this.typeName().type;
      this.expect(')');
      return { k: 'cast', e, type };
    }
    if (tok.kind === 'word' && !tok.quoted) {
      if (tok.value === 'NULL') {
        this.next();
        return { k: 'lit', v: null };
      }
      if (tok.value === 'TRUE' || tok.value === 'FALSE') {
        this.next();
        return { k: 'lit', v: tok.value === 'TRUE' };
      }
      if (tok.value === 'CURRENT_DATE' || tok.value === 'CURRENT_TIMESTAMP') {
        this.next();
        return { k: 'fn', name: tok.value, args: [] };
      }
    }
    if (tok.kind !== 'word') this.fail();
    if (!tok.quoted && CLAUSE_WORDS.has(tok.value)) this.fail();

    const first = this.name();
    if (this.at('(')) {
      this.next();
      const name = first.toUpperCase();
      const args: Expr[] = [];
      let distinct = false;
      if (this.at('*')) {
        this.next();
        args.push({ k: 'star' });
      } else if (!this.at(')')) {
        distinct = this.eat('DISTINCT');
        do args.push(this.expr());
        while (this.eat(','));
      }
      this.expect(')');
      return { k: 'fn', name, args, distinct };
    }
    if (this.eat('.')) {
      if (this.at('*')) {
        this.next();
        return { k: 'star', table: first };
      }
      return { k: 'col', table: first, name: this.name() };
    }
    return { k: 'col', name: first };
  }

  private caseExpr(): Expr {
    const operand = this.at('WHEN') ? undefined : this.expr();
    const whens: Array<{ when: Expr; then: Expr }> = [];
    while (this.eat('WHEN')) {
      const when = this.expr();
      this.expect('THEN');
      whens.push({ when, then: this.expr() });
    }
    const alt = this.eat('ELSE') ? this.expr() : undefined;
    this.expect('END');
    if (whens.length === 0) this.fail();
    return { k: 'case', operand, whens, alt };
  }

  /* ---------------------------------------------------------------- dml */

  private insert(): Stmt {
    this.expect('INTO');
    const table = this.name();
    let columns: string[] | undefined;
    if (this.at('(') && this.peek(1).value !== 'SELECT') columns = this.nameList();
    if (this.eat('VALUES')) {
      const values: Expr[][] = [];
      do {
        this.expect('(');
        const row: Expr[] = [];
        do {
          if (this.at('DEFAULT')) {
            this.next();
            row.push({ k: 'fn', name: 'DEFAULT', args: [] });
          } else row.push(this.expr());
        } while (this.eat(','));
        this.expect(')');
        values.push(row);
      } while (this.eat(','));
      return { k: 'insert', table, columns, values };
    }
    if (this.at('SELECT', '(')) return { k: 'insert', table, columns, select: this.select() };
    this.fail();
  }

  private update(): Stmt {
    const table = this.name();
    this.expect('SET');
    const set: Array<{ col: string; e: Expr }> = [];
    do {
      const col = this.name();
      if (!this.eat('=')) this.fail();
      set.push({ col, e: this.expr() });
    } while (this.eat(','));
    const where = this.eat('WHERE') ? this.expr() : undefined;
    return { k: 'update', table, set, where };
  }

  private deleteFrom(): Stmt {
    this.expect('FROM');
    const table = this.name();
    const where = this.eat('WHERE') ? this.expr() : undefined;
    return { k: 'delete', table, where };
  }

  /* ---------------------------------------------------------------- ddl */

  private typeName(): { type: SqlType; length?: number; serial?: boolean } {
    const tok = this.peek();
    if (tok.kind !== 'word') this.fail();
    let word = tok.value;
    this.next();
    if (word === 'DOUBLE') this.eat('PRECISION');
    if (word === 'CHARACTER' && this.eat('VARYING')) word = 'VARCHAR';
    if (word === 'TIMESTAMP' || word === 'TIME') {
      if (this.eat('WITH', 'WITHOUT')) {
        this.eat('TIME');
        this.eat('ZONE');
      }
    }
    const type = TYPE_ALIASES[word];
    if (!type) throw new SqlError('type "' + tok.raw.toLowerCase() + '" does not exist');
    let length: number | undefined;
    if (this.eat('(')) {
      length = this.intLiteral();
      while (this.eat(',')) this.intLiteral();
      this.expect(')');
    }
    return { type, length, serial: word === 'SERIAL' || word === 'BIGSERIAL' };
  }

  private create(): Stmt {
    const replace = this.eat('OR') ? (this.expect('REPLACE'), true) : false;
    if (this.eat('VIEW')) {
      const name = this.name();
      const columns = this.at('(') ? this.nameList() : undefined;
      this.expect('AS');
      const start = this.peek().pos;
      this.select();
      const end = this.peek().kind === 'end' ? this.src.length : this.peek().pos;
      return { k: 'createView', name, replace, columns, query: this.src.slice(start, end).replace(/;\s*$/, '').trim() };
    }
    const unique = this.eat('UNIQUE');
    if (this.eat('INDEX')) {
      const ifNotExists = this.ifNotExists();
      const name = this.at('ON') ? undefined : this.name();
      this.expect('ON');
      const table = this.name();
      this.expect('(');
      const columns: string[] = [];
      do {
        columns.push(this.name());
        if (!this.eat('ASC')) this.eat('DESC');
      } while (this.eat(','));
      this.expect(')');
      return { k: 'createIndex', name, table, columns, unique, ifNotExists };
    }
    this.eat('TEMP', 'TEMPORARY');
    this.expect('TABLE');
    const ifNotExists = this.ifNotExists();
    const name = this.name();
    this.expect('(');
    const columns: ColumnDef[] = [];
    const checks: string[] = [];
    const key: { composite?: string[] } = {};
    do {
      if (this.at(')')) break;
      if (this.eat('CONSTRAINT')) this.name();
      if (this.at('PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN')) {
        this.tableConstraint(columns, checks, key);
        continue;
      }
      columns.push(this.columnDef());
    } while (this.eat(','));
    this.expect(')');
    if (columns.length === 0) throw new SqlError('table "' + name + '" must have at least one column');
    for (const n of key.composite ?? []) {
      if (!columns.some((c) => c.name === n)) throw new SqlError('column "' + n + '" named in key does not exist');
    }
    return { k: 'createTable', name, ifNotExists, columns, checks, primaryKey: key.composite };
  }

  private ifNotExists(): boolean {
    if (!this.at('IF')) return false;
    this.next();
    this.expect('NOT');
    this.expect('EXISTS');
    return true;
  }
  private ifExists(): boolean {
    if (!this.at('IF')) return false;
    this.next();
    this.expect('EXISTS');
    return true;
  }

  private columnDef(): ColumnDef {
    const name = this.name();
    const t = this.typeName();
    const col: ColumnDef = { name, type: t.type };
    if (t.length !== undefined) col.length = t.length;
    if (t.serial) {
      col.serial = 1;
      col.notNull = true;
    }
    for (;;) {
      if (this.eat('PRIMARY')) {
        this.expect('KEY');
        col.primaryKey = true;
        col.notNull = true;
        continue;
      }
      if (this.eat('UNIQUE')) {
        col.unique = true;
        continue;
      }
      if (this.eat('NOT')) {
        this.expect('NULL');
        col.notNull = true;
        continue;
      }
      if (this.eat('NULL')) continue;
      if (this.eat('DEFAULT')) {
        col.default = this.literalValue();
        continue;
      }
      if (this.eat('REFERENCES')) {
        const table = this.name();
        let column = '';
        if (this.at('(')) column = this.nameList()[0] ?? '';
        this.referentialActions();
        col.references = { table, column };
        continue;
      }
      if (this.eat('CHECK')) {
        col.check = this.parenSource();
        continue;
      }
      if (this.eat('CONSTRAINT')) {
        this.name();
        continue;
      }
      return col;
    }
  }

  private referentialActions(): void {
    while (this.eat('ON')) {
      this.eat('DELETE', 'UPDATE');
      if (this.eat('SET')) this.eat('NULL', 'DEFAULT');
      else if (this.eat('NO')) this.eat('ACTION');
      else this.eat('CASCADE', 'RESTRICT');
    }
  }

  /** Source text of a parenthesised expression, kept so a CHECK can be re-run per row. */
  private parenSource(): string {
    this.expect('(');
    const start = this.peek().pos;
    let depth = 1;
    let end = start;
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'end') this.fail();
      if (tok.value === '(') depth++;
      if (tok.value === ')') {
        depth--;
        if (depth === 0) {
          end = tok.pos;
          this.next();
          break;
        }
      }
      end = tok.pos + tok.raw.length;
      this.next();
    }
    return this.src.slice(start, end).trim();
  }

  private tableConstraint(columns: ColumnDef[], checks: string[], key: { composite?: string[] }): void {
    if (this.eat('CHECK')) {
      checks.push(this.parenSource());
      return;
    }
    if (this.eat('PRIMARY')) {
      this.expect('KEY');
      const names = this.nameList();
      for (const n of names) {
        const c = columns.find((x) => x.name === n);
        // Every part of a key is required, whether the key is one column or several.
        if (c) c.notNull = true;
      }
      // Only a single-column key makes that column unique on its own.
      if (names.length === 1) {
        const c = columns.find((x) => x.name === names[0]);
        if (c) c.primaryKey = true;
      } else key.composite = names;
      return;
    }
    if (this.eat('UNIQUE')) {
      for (const n of this.nameList()) {
        const c = columns.find((x) => x.name === n);
        if (c) c.unique = true;
      }
      return;
    }
    this.expect('FOREIGN');
    this.expect('KEY');
    const cols = this.nameList();
    this.expect('REFERENCES');
    const table = this.name();
    const refs = this.at('(') ? this.nameList() : [];
    this.referentialActions();
    cols.forEach((n, idx) => {
      const c = columns.find((x) => x.name === n);
      if (c) c.references = { table, column: refs[idx] ?? '' };
    });
  }

  private nameList(): string[] {
    this.expect('(');
    const out: string[] = [];
    do out.push(this.name());
    while (this.eat(','));
    this.expect(')');
    return out;
  }

  private literalValue(): SqlValue {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.next();
      return Number(tok.value);
    }
    if (tok.kind === 'string') {
      this.next();
      return tok.value;
    }
    if (this.eat('NULL')) return null;
    if (this.at('TRUE', 'FALSE')) return this.next().value === 'TRUE';
    if (this.eat('-')) return -this.intLiteral();
    if (this.at('CURRENT_DATE')) {
      this.next();
      return TODAY;
    }
    if (this.at('CURRENT_TIMESTAMP')) {
      this.next();
      return TODAY + ' 00:00:00';
    }
    this.fail();
  }

  private drop(): Stmt {
    if (this.eat('VIEW')) {
      const ifExists = this.ifExists();
      const name = this.name();
      this.eat('CASCADE', 'RESTRICT');
      return { k: 'dropView', name, ifExists };
    }
    if (this.eat('INDEX')) {
      const ifExists = this.ifExists();
      const name = this.name();
      return { k: 'dropIndex', name, ifExists };
    }
    this.expect('TABLE');
    const ifExists = this.ifExists();
    const names: string[] = [];
    do names.push(this.name());
    while (this.eat(','));
    this.eat('CASCADE', 'RESTRICT');
    return { k: 'dropTable', names, ifExists };
  }

  private alter(): Stmt {
    this.expect('TABLE');
    this.ifExists();
    const table = this.name();
    if (this.eat('RENAME')) {
      if (this.eat('TO')) return { k: 'alterTable', table, action: { a: 'renameTable', to: this.name() } };
      this.eat('COLUMN');
      const from = this.name();
      this.expect('TO');
      return { k: 'alterTable', table, action: { a: 'renameColumn', from, to: this.name() } };
    }
    if (this.eat('ADD')) {
      if (this.eat('CONSTRAINT')) this.name();
      if (this.eat('CHECK')) return { k: 'alterTable', table, action: { a: 'addCheck', text: this.parenSource() } };
      if (this.eat('UNIQUE')) return { k: 'alterTable', table, action: { a: 'addUnique', columns: this.nameList() } };
      if (this.eat('PRIMARY')) {
        this.expect('KEY');
        return { k: 'alterTable', table, action: { a: 'addPrimaryKey', columns: this.nameList() } };
      }
      if (this.eat('FOREIGN')) {
        this.expect('KEY');
        const columns = this.nameList();
        this.expect('REFERENCES');
        const ref = this.name();
        const refColumns = this.at('(') ? this.nameList() : [];
        this.referentialActions();
        return { k: 'alterTable', table, action: { a: 'addForeignKey', columns, table: ref, refColumns } };
      }
      this.eat('COLUMN');
      this.ifNotExists();
      return { k: 'alterTable', table, action: { a: 'addColumn', column: this.columnDef() } };
    }
    if (this.eat('DROP')) {
      this.eat('COLUMN');
      const ifExists = this.ifExists();
      const name = this.name();
      this.eat('CASCADE', 'RESTRICT');
      return { k: 'alterTable', table, action: { a: 'dropColumn', name, ifExists } };
    }
    if (this.eat('ALTER')) {
      this.eat('COLUMN');
      const column = this.name();
      if (this.eat('SET')) {
        this.expect('NOT');
        this.expect('NULL');
        return { k: 'alterTable', table, action: { a: 'setNotNull', column, notNull: true } };
      }
      if (this.eat('DROP')) {
        this.expect('NOT');
        this.expect('NULL');
        return { k: 'alterTable', table, action: { a: 'setNotNull', column, notNull: false } };
      }
    }
    this.fail();
  }
}

export function parse(sql: string): Stmt {
  return new Parser(lex(sql), sql).statement();
}

/** Parse an expression on its own, for CHECK constraints. */
export function parseExpr(sql: string): Expr {
  return new Parser(lex(sql), sql).expr();
}

export function parseSelect(sql: string): Select {
  return new Parser(lex(sql), sql).select();
}
