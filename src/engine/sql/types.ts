/**
 * A small PostgreSQL-flavoured database, kept as plain JSON so lab state clones and
 * persists like everything else in the engine. Rows are arrays of values in column
 * order; nothing here holds a class instance or a closure.
 */

/** Everything a column can hold. `null` is SQL NULL. */
export type SqlValue = string | number | boolean | null;

/** The types a lab may declare. Postgres spellings are accepted and normalised to these. */
export type SqlType = 'integer' | 'bigint' | 'numeric' | 'text' | 'boolean' | 'date' | 'timestamp';

export interface ColumnDef {
  name: string;
  type: SqlType;
  /** varchar(n)/char(n): rejected beyond n characters. */
  length?: number;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  /** Literal default, already evaluated (DEFAULT 0, DEFAULT 'new', DEFAULT true). */
  default?: SqlValue;
  /** serial/bigserial: the next value handed out. */
  serial?: number;
  references?: { table: string; column: string };
  /** Source text of a CHECK on this column, re-parsed when rows are written. */
  check?: string;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  rows: SqlValue[][];
  /** Table-level CHECK constraints, as written. */
  checks?: string[];
}

export interface IndexDef {
  name: string;
  table: string;
  columns: string[];
  unique?: boolean;
}

export interface ViewDef {
  name: string;
  /** The SELECT the view stands for, as written. Re-run on every reference. */
  query: string;
  columns?: string[];
}

export interface SqlDatabase {
  name: string;
  tables: Record<string, TableDef>;
  indexes: Record<string, IndexDef>;
  views: Record<string, ViewDef>;
}

/** One psql session against one database. */
export interface SqlState {
  db: SqlDatabase;
  /** Role the session connected as, shown in the prompt of a superuser as "#". */
  user: string;
  superuser: boolean;
  /** Set while a transaction is open; holds the database as it was at BEGIN. */
  snapshot?: SqlDatabase;
  /** True once a statement has failed inside a transaction: Postgres then refuses the rest. */
  aborted?: boolean;
  /** Text typed so far for a statement that has no terminating semicolon yet. */
  partial?: string;
  /** Every statement the session has run successfully, for grading. */
  ran: string[];
  /** The rows the last SELECT returned, for grading what the learner has seen. */
  lastResult?: { columns: string[]; rows: SqlValue[][] };
  /**
   * Every result the learner has produced, newest last. Grading asks whether any of
   * them is the right answer, which lets a lab accept any query that gets there rather
   * than only the wording the author happened to think of.
   */
  answers: Array<{ sql: string; columns: string[]; rows: SqlValue[][] }>;
}

/** A failure the server reports. Mirrors the shape psql prints. */
export class SqlError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly hint?: string,
    readonly severity: 'ERROR' | 'FATAL' = 'ERROR',
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

/** What one statement produced. */
export interface StatementResult {
  /** psql's command tag: "SELECT 3", "INSERT 0 1", "UPDATE 2", "CREATE TABLE". */
  tag: string;
  columns?: string[];
  rows?: SqlValue[][];
  /** Extra lines printed before the tag, e.g. a NOTICE. */
  notices?: string[];
}
