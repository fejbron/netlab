import { execute, display, runSelect } from './exec';
import { isComplete, parse, parseSelect, splitStatements } from './parser';
import { SqlError, type SqlDatabase, type SqlState, type SqlValue, type StatementResult, type TableDef } from './types';

export * from './types';
export { runSelect, display } from './exec';
export { parse, parseSelect, splitStatements, isComplete } from './parser';
export type { Select, Stmt, Expr } from './parser';

/** What a lab declares to stand a database up. */
export interface SqlSpec {
  database?: string;
  user?: string;
  /** Connected as a superuser, which psql shows as "=#" rather than "=>". */
  superuser?: boolean;
  /** Real SQL, run once at start-up to create and fill the tables. */
  setup?: string;
}

export function emptyDatabase(name: string): SqlDatabase {
  return { name, tables: {}, indexes: {}, views: {} };
}

export function createSqlState(spec: SqlSpec = {}): SqlState {
  const state: SqlState = {
    db: emptyDatabase(spec.database ?? 'shop'),
    user: spec.user ?? 'student',
    superuser: spec.superuser ?? true,
    ran: [],
    answers: [],
  };
  if (spec.setup) {
    for (const sql of splitStatements(spec.setup)) {
      try {
        execute(state, parse(sql), sql);
      } catch (e) {
        // A broken seed is an authoring mistake, so make it loud rather than silent.
        throw new Error('lab database setup failed on "' + sql.trim().slice(0, 60) + '": ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
  state.ran = [];
  state.answers = [];
  return state;
}

/** psql's prompt: "shop=#" for a superuser, "shop=>" otherwise, "shop-#" mid-statement. */
export function sqlPrompt(state: SqlState): string {
  const mark = state.superuser ? '#' : '>';
  return state.db.name + (state.partial ? '-' : '=') + mark + ' ';
}

/* ------------------------------------------------------------- formatting */

/** Numbers sit to the right of the column, like psql. */
function alignRight(t: TableDef | undefined, columns: string[], rows: SqlValue[][]): boolean[] {
  void t;
  return columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === 'number'));
}

export function formatResult(columns: string[], rows: SqlValue[][]): string[] {
  if (columns.length === 0) return ['--', '(' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ')'];
  const cells = rows.map((r) => r.map(display));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length), 0));
  const right = alignRight(undefined, columns, rows);

  const centre = (s: string, w: number) => {
    const total = w - s.length;
    const left = Math.floor(total / 2);
    return ' '.repeat(left) + s + ' '.repeat(total - left);
  };
  const out: string[] = [];
  out.push(' ' + columns.map((c, i) => centre(c, widths[i])).join(' | ') + ' ');
  out.push(widths.map((w) => '-'.repeat(w + 2)).join('+'));
  for (const row of cells) {
    out.push(' ' + row.map((v, i) => (right[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' | ') + ' ');
  }
  out.push('(' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ')');
  return out.map((line) => line.replace(/\s+$/, ''));
}

function typeLabel(t: TableDef['columns'][number]): string {
  switch (t.type) {
    case 'text':
      return t.length ? 'character varying(' + t.length + ')' : 'text';
    case 'integer':
      return t.serial !== undefined ? 'integer' : 'integer';
    case 'numeric':
      return 'numeric';
    default:
      return t.type;
  }
}

function describeTable(db: SqlDatabase, name: string): string[] {
  const t = db.tables[name];
  if (!t) {
    const v = db.views[name];
    if (v) return ['View "public.' + name + '"', ...formatResult(['Definition'], [[v.query]])];
    throw new SqlError('Did not find any relation named "' + name + '".');
  }
  const rows: SqlValue[][] = t.columns.map((c) => {
    const bits: string[] = [];
    if (c.notNull) bits.push('not null');
    if (c.serial !== undefined) bits.push('default nextval(\'' + t.name + '_' + c.name + '_seq\'::regclass)');
    else if (c.default !== undefined && c.default !== null) bits.push('default ' + (typeof c.default === 'string' ? "'" + c.default + "'::text" : display(c.default)));
    return [c.name, typeLabel(c), bits.join(' ')];
  });
  const out = ['Table "public.' + t.name + '"', ...formatResult(['Column', 'Type', 'Modifiers'], rows).slice(0, -1)];
  const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pk.length) out.push('Indexes:', '    "' + t.name + '_pkey" PRIMARY KEY, btree (' + pk.join(', ') + ')');
  const extra = Object.values(db.indexes).filter((i) => i.table === t.name);
  if (extra.length) {
    if (!pk.length) out.push('Indexes:');
    for (const i of extra) out.push('    "' + i.name + '"' + (i.unique ? ' UNIQUE,' : '') + ' btree (' + i.columns.join(', ') + ')');
  }
  const checks = [...t.columns.filter((c) => c.check).map((c) => ({ name: t.name + '_' + c.name + '_check', text: c.check! })), ...(t.checks ?? []).map((text, n) => ({ name: t.name + '_check' + (n || ''), text }))];
  if (checks.length) {
    out.push('Check constraints:');
    for (const c of checks) out.push('    "' + c.name + '" CHECK (' + c.text + ')');
  }
  const fks = t.columns.filter((c) => c.references);
  if (fks.length) {
    out.push('Foreign-key constraints:');
    for (const c of fks) out.push('    "' + t.name + '_' + c.name + '_fkey" FOREIGN KEY (' + c.name + ') REFERENCES ' + c.references!.table + '(' + c.references!.column + ')');
  }
  return out;
}

const META_HELP = [
  'General',
  '  \\q                     quit psql',
  '  \\?                     show this help',
  '  \\h [NAME]              help on a SQL command',
  '',
  'Informational',
  '  \\dt                    list tables',
  '  \\dv                    list views',
  '  \\di                    list indexes',
  '  \\d NAME                describe a table or view',
  '  \\l                     list databases',
  '',
  'Statements end with a semicolon and may span several lines.',
];

const SQL_HELP: Record<string, string[]> = {
  SELECT: ['Command:     SELECT', 'Description: retrieve rows from a table or view', 'Syntax:', 'SELECT [ DISTINCT ] expression [ AS name ] [, ...]', '    [ FROM table [ [AS] alias ] [ join ... ] ]', '    [ WHERE condition ]', '    [ GROUP BY expression [, ...] ]', '    [ HAVING condition ]', '    [ ORDER BY expression [ ASC | DESC ] [, ...] ]', '    [ LIMIT count ] [ OFFSET start ]'],
  INSERT: ['Command:     INSERT', 'Description: create new rows in a table', 'Syntax:', 'INSERT INTO table [ ( column [, ...] ) ]', '    VALUES ( expression [, ...] ) [, ...]'],
  UPDATE: ['Command:     UPDATE', 'Description: update rows of a table', 'Syntax:', 'UPDATE table SET column = expression [, ...] [ WHERE condition ]'],
  DELETE: ['Command:     DELETE', 'Description: delete rows of a table', 'Syntax:', 'DELETE FROM table [ WHERE condition ]'],
  'CREATE TABLE': ['Command:     CREATE TABLE', 'Description: define a new table', 'Syntax:', 'CREATE TABLE name (', '    column type [ PRIMARY KEY | NOT NULL | UNIQUE | DEFAULT value', '                  | REFERENCES table (column) | CHECK (condition) ] [, ...]', ')'],
  JOIN: ['Description: combine rows from two tables', 'Syntax:', 'FROM a [ INNER | LEFT | RIGHT | FULL | CROSS ] JOIN b ON a.col = b.col'],
};

/* ---------------------------------------------------------------- session */

export interface SqlLineResult {
  output: string[];
  /** The learner typed \q, so the caller should close the session. */
  quit?: boolean;
}

function errorLines(e: SqlError): string[] {
  const out = [e.severity + ':  ' + e.message];
  if (e.detail) out.push('DETAIL:  ' + e.detail);
  if (e.hint) out.push('HINT:  ' + e.hint);
  return out;
}

function listing(db: SqlDatabase, what: 'tables' | 'views' | 'indexes'): string[] {
  const rows: SqlValue[][] =
    what === 'tables'
      ? Object.values(db.tables).map((t) => ['public', t.name, 'table', 'student'])
      : what === 'views'
        ? Object.values(db.views).map((v) => ['public', v.name, 'view', 'student'])
        : Object.values(db.indexes).map((i) => ['public', i.name, 'index', 'student']);
  if (rows.length === 0) return ['Did not find any relations.'];
  const label = what === 'tables' ? 'List of relations' : what === 'views' ? 'List of views' : 'List of indexes';
  return [label, ...formatResult(['Schema', 'Name', 'Type', 'Owner'], rows.sort((a, b) => String(a[1]).localeCompare(String(b[1]))))];
}

function meta(state: SqlState, line: string): SqlLineResult {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch (cmd) {
    case '\\q':
    case '\\quit':
      return { output: [], quit: true };
    case '\\?':
      return { output: META_HELP };
    case '\\h':
    case '\\help': {
      const topic = args.join(' ').toUpperCase();
      if (!topic) return { output: ['Available help:', ...Object.keys(SQL_HELP).map((k) => '  ' + k)] };
      const entry = SQL_HELP[topic] ?? SQL_HELP[Object.keys(SQL_HELP).find((k) => k.startsWith(topic)) ?? ''];
      return { output: entry ?? ['No help available for "' + args.join(' ') + '".'] };
    }
    case '\\dt':
      return { output: listing(state.db, 'tables') };
    case '\\dv':
      return { output: listing(state.db, 'views') };
    case '\\di':
      return { output: listing(state.db, 'indexes') };
    case '\\d': {
      if (args.length === 0) {
        const all = [...Object.values(state.db.tables).map((t) => ['public', t.name, 'table', 'student'] as SqlValue[]), ...Object.values(state.db.views).map((v) => ['public', v.name, 'view', 'student'] as SqlValue[])];
        if (all.length === 0) return { output: ['Did not find any relations.'] };
        return { output: ['List of relations', ...formatResult(['Schema', 'Name', 'Type', 'Owner'], all.sort((a, b) => String(a[1]).localeCompare(String(b[1]))))] };
      }
      try {
        return { output: describeTable(state.db, args[0]) };
      } catch (e) {
        return { output: e instanceof SqlError ? [e.message] : ['Did not find any relation named "' + args[0] + '".'] };
      }
    }
    case '\\l':
    case '\\list':
      return { output: ['List of databases', ...formatResult(['Name', 'Owner', 'Encoding'], [[state.db.name, state.user, 'UTF8']])] };
    case '\\c':
    case '\\connect':
      return { output: args[0] && args[0] !== state.db.name ? ['FATAL:  database "' + args[0] + '" does not exist'] : ['You are now connected to database "' + state.db.name + '" as user "' + state.user + '".'] };
    case '\\timing':
      return { output: ['Timing is on.'] };
    default:
      return { output: ['invalid command ' + cmd, 'Try \\? for help.'] };
  }
}

function resultLines(r: StatementResult): string[] {
  const out = [...(r.notices ?? [])];
  if (r.columns) out.push(...formatResult(r.columns, r.rows ?? []));
  else out.push(r.tag);
  return out;
}

/**
 * One line typed at the psql prompt. Statements may span lines, so anything without a
 * closing semicolon is held in `state.partial` and the caller shows a continuation prompt.
 */
export function runSqlLine(state: SqlState, rawLine: string): SqlLineResult {
  const line = rawLine.replace(/\s+$/, '');
  if (!state.partial && line.trim().startsWith('\\')) return meta(state, line);
  if (!state.partial && line.trim() === '') return { output: [] };

  const text = state.partial ? state.partial + '\n' + line : line;
  if (!isComplete(text)) {
    state.partial = text;
    return { output: [] };
  }
  state.partial = undefined;

  const out: string[] = [];
  for (const sql of splitStatements(text)) {
    if (!sql.trim()) continue;
    if (state.aborted && !/^\s*(rollback|abort|commit|end)\b/i.test(sql)) {
      out.push('ERROR:  current transaction is aborted, commands ignored until end of transaction block');
      continue;
    }
    try {
      const stmt = parse(sql);
      const r = execute(state, stmt, sql);
      state.ran.push(sql.trim().replace(/\s+/g, ' '));
      if (r.columns) {
        state.answers.push({ sql: sql.trim().replace(/\s+/g, ' '), columns: r.columns, rows: r.rows ?? [] });
        if (state.answers.length > 60) state.answers.shift();
      }
      out.push(...resultLines(r));
    } catch (e) {
      if (!(e instanceof SqlError)) throw e;
      out.push(...errorLines(e));
      if (state.snapshot) state.aborted = true;
    }
  }
  return { output: out };
}

/** Run a query for grading. Returns null when it cannot run at all. */
export function queryFor(state: SqlState, sql: string): { columns: string[]; rows: SqlValue[][] } | null {
  try {
    return runSelect(state.db, parseSelect(sql));
  } catch {
    return null;
  }
}
