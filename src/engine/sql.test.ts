import { describe, expect, it } from 'vitest';
import { createSqlState, formatResult, runSqlLine, sqlPrompt, type SqlState } from './sql';

const SETUP = `
CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text,
  joined date NOT NULL DEFAULT '2025-01-01'
);
CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  total numeric NOT NULL CHECK (total >= 0),
  placed date NOT NULL
);
INSERT INTO customers (name, city, joined) VALUES
  ('Ada', 'London', '2025-02-01'),
  ('Bo', 'Leeds', '2025-03-04'),
  ('Cleo', NULL, '2025-04-09');
INSERT INTO orders (customer_id, total, placed) VALUES
  (1, 30.00, '2026-01-05'),
  (1, 12.50, '2026-01-19'),
  (2, 99.00, '2026-02-02');
`;

/** Run lines through a session and return everything printed. */
function run(state: SqlState, ...lines: string[]): string[] {
  return lines.flatMap((l) => runSqlLine(state, l).output);
}

/** Run one query and return its rows as plain text, without the psql frame. */
function rows(state: SqlState, sql: string): string[][] {
  runSqlLine(state, sql);
  return (state.lastResult?.rows ?? []).map((r) => r.map((v) => (v === null ? 'NULL' : String(v))));
}

const fresh = () => createSqlState({ database: 'shop', setup: SETUP });

describe('the database a lab starts with', () => {
  it('builds itself from the setup SQL', () => {
    const s = fresh();
    expect(Object.keys(s.db.tables).sort()).toEqual(['customers', 'orders']);
    expect(s.db.tables.customers.rows).toHaveLength(3);
    // The statements that built it are not counted as the learner's work.
    expect(s.ran).toEqual([]);
    // serial hands out 1, 2, 3 without being told.
    expect(rows(s, 'SELECT id FROM customers ORDER BY id;')).toEqual([['1'], ['2'], ['3']]);
  });

  it('shows the psql prompt, and a different one mid-statement', () => {
    const s = fresh();
    expect(sqlPrompt(s)).toBe('shop=# ');
    runSqlLine(s, 'SELECT name');
    expect(sqlPrompt(s)).toBe('shop-# ');
    runSqlLine(s, 'FROM customers;');
    expect(sqlPrompt(s)).toBe('shop=# ');
  });

  it('refuses a setup script that does not run', () => {
    expect(() => createSqlState({ setup: 'CREATE TABLE t (id nonsense);' })).toThrow(/setup failed/);
  });
});

describe('SELECT', () => {
  it('filters, orders and limits', () => {
    const s = fresh();
    expect(rows(s, "SELECT name FROM customers WHERE city = 'London';")).toEqual([['Ada']]);
    expect(rows(s, 'SELECT name FROM customers ORDER BY name DESC;')).toEqual([['Cleo'], ['Bo'], ['Ada']]);
    expect(rows(s, 'SELECT name FROM customers ORDER BY name LIMIT 2;')).toEqual([['Ada'], ['Bo']]);
    expect(rows(s, 'SELECT name FROM customers ORDER BY name OFFSET 2;')).toEqual([['Cleo']]);
  });

  it('treats NULL as unknown rather than as a value', () => {
    const s = fresh();
    // city = NULL matches nothing, which is the classic surprise.
    expect(rows(s, 'SELECT name FROM customers WHERE city = NULL;')).toEqual([]);
    expect(rows(s, 'SELECT name FROM customers WHERE city IS NULL;')).toEqual([['Cleo']]);
    expect(rows(s, 'SELECT name FROM customers WHERE city IS NOT NULL ORDER BY name;')).toEqual([['Ada'], ['Bo']]);
    // A NULL sorts last, and prints as an empty cell.
    expect(rows(s, 'SELECT city FROM customers ORDER BY city;')).toEqual([['Leeds'], ['London'], ['NULL']]);
  });

  it('does the usual comparisons and pattern matches', () => {
    const s = fresh();
    expect(rows(s, "SELECT name FROM customers WHERE name LIKE 'A%';")).toEqual([['Ada']]);
    expect(rows(s, "SELECT name FROM customers WHERE name ILIKE 'a%';")).toEqual([['Ada']]);
    expect(rows(s, "SELECT name FROM customers WHERE name IN ('Ada', 'Bo') ORDER BY name;")).toEqual([['Ada'], ['Bo']]);
    expect(rows(s, 'SELECT id FROM orders WHERE total BETWEEN 10 AND 40 ORDER BY id;')).toEqual([['1'], ['2']]);
    expect(rows(s, "SELECT id FROM orders WHERE placed >= '2026-02-01';")).toEqual([['3']]);
  });

  it('computes expressions and gives them names', () => {
    const s = fresh();
    runSqlLine(s, "SELECT upper(name) AS shouty, length(name) AS len FROM customers WHERE name = 'Ada';");
    expect(s.lastResult?.columns).toEqual(['shouty', 'len']);
    expect(s.lastResult?.rows).toEqual([['ADA', 3]]);
    expect(rows(s, "SELECT coalesce(city, 'unknown') FROM customers ORDER BY id;")).toEqual([['London'], ['Leeds'], ['unknown']]);
    expect(rows(s, "SELECT name || ' of ' || coalesce(city, '?') FROM customers WHERE id = 2;")).toEqual([['Bo of Leeds']]);
    expect(rows(s, 'SELECT round(total * 2, 2) FROM orders WHERE id = 2;')).toEqual([['25']]);
  });

  it('says so when a column or table is not there', () => {
    const s = fresh();
    expect(run(s, 'SELECT nam FROM customers;').join('\n')).toContain('column "nam" does not exist');
    expect(run(s, 'SELECT * FROM custmers;').join('\n')).toContain('relation "custmers" does not exist');
    // The hint points at the real name rather than leaving the learner guessing.
    expect(run(s, 'SELECT * FROM custmers;').join('\n')).toContain('customers');
  });

  it('reports a syntax error the way the server does', () => {
    const s = fresh();
    expect(run(s, 'SELECT FROM WHERE;').join('\n')).toMatch(/ERROR:  syntax error at or near/);
  });
});

describe('joins', () => {
  it('matches rows across tables', () => {
    const s = fresh();
    expect(rows(s, 'SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id ORDER BY o.id;')).toEqual([
      ['Ada', '30'],
      ['Ada', '12.5'],
      ['Bo', '99'],
    ]);
  });

  it('keeps the unmatched left rows in a LEFT JOIN', () => {
    const s = fresh();
    expect(rows(s, 'SELECT c.name, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ORDER BY c.name, o.id;')).toEqual([
      ['Ada', '1'],
      ['Ada', '2'],
      ['Bo', '3'],
      ['Cleo', 'NULL'],
    ]);
  });

  it('multiplies rows out when there is no condition', () => {
    const s = fresh();
    expect(rows(s, 'SELECT count(*) FROM customers CROSS JOIN orders;')).toEqual([['9']]);
  });

  it('insists on being told how the tables line up', () => {
    const s = fresh();
    expect(run(s, 'SELECT * FROM customers JOIN orders;').join('\n')).toContain('ON');
  });

  it('refuses an ambiguous column name', () => {
    const s = fresh();
    expect(run(s, 'SELECT id FROM customers JOIN orders ON orders.customer_id = customers.id;').join('\n')).toContain('ambiguous');
  });
});

describe('grouping and aggregates', () => {
  it('counts and totals per group', () => {
    const s = fresh();
    expect(rows(s, 'SELECT customer_id, count(*), sum(total) FROM orders GROUP BY customer_id ORDER BY customer_id;')).toEqual([
      ['1', '2', '42.5'],
      ['2', '1', '99'],
    ]);
  });

  it('filters groups with HAVING, not WHERE', () => {
    const s = fresh();
    expect(rows(s, 'SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 1;')).toEqual([['1']]);
    expect(run(s, 'SELECT customer_id FROM orders WHERE count(*) > 1 GROUP BY customer_id;').join('\n')).toContain('aggregate functions are not allowed in WHERE');
  });

  it('insists every selected column is grouped or summarised', () => {
    const s = fresh();
    const out = run(s, 'SELECT customer_id, total, count(*) FROM orders GROUP BY customer_id;').join('\n');
    expect(out).toContain('must appear in the GROUP BY clause');
  });

  it('ignores NULLs in aggregates, and counts rows with count(*)', () => {
    const s = fresh();
    expect(rows(s, 'SELECT count(*), count(city) FROM customers;')).toEqual([['3', '2']]);
    expect(rows(s, 'SELECT avg(total) FROM orders WHERE customer_id = 1;')).toEqual([['21.25']]);
    expect(rows(s, 'SELECT min(total), max(total) FROM orders;')).toEqual([['12.5', '99']]);
  });

  it('orders by an aggregate', () => {
    const s = fresh();
    expect(rows(s, 'SELECT customer_id, count(*) AS n FROM orders GROUP BY customer_id ORDER BY n DESC;')).toEqual([
      ['1', '2'],
      ['2', '1'],
    ]);
  });
});

describe('subqueries', () => {
  it('runs one inside IN and inside a scalar position', () => {
    const s = fresh();
    expect(rows(s, 'SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders) ORDER BY name;')).toEqual([['Ada'], ['Bo']]);
    expect(rows(s, 'SELECT name FROM customers WHERE id = (SELECT customer_id FROM orders WHERE total = 99);')).toEqual([['Bo']]);
  });

  it('correlates with the outer row', () => {
    const s = fresh();
    expect(rows(s, 'SELECT name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY name;')).toEqual([['Ada'], ['Bo']]);
    expect(rows(s, 'SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);')).toEqual([['Cleo']]);
  });

  it('reads from a subquery in FROM', () => {
    const s = fresh();
    expect(rows(s, 'SELECT n FROM (SELECT count(*) AS n FROM orders) AS t;')).toEqual([['3']]);
    expect(run(s, 'SELECT * FROM (SELECT 1 AS a);').join('\n')).toContain('must have an alias');
  });
});

describe('changing data', () => {
  it('inserts, updates and deletes, reporting the row counts', () => {
    const s = fresh();
    expect(run(s, "INSERT INTO customers (name, city) VALUES ('Dev', 'Hull');")).toEqual(['INSERT 0 1']);
    expect(run(s, "UPDATE customers SET city = 'York' WHERE name = 'Dev';")).toEqual(['UPDATE 1']);
    expect(run(s, "DELETE FROM customers WHERE name = 'Dev';")).toEqual(['DELETE 1']);
    expect(rows(s, 'SELECT count(*) FROM customers;')).toEqual([['3']]);
  });

  it('fills in defaults for columns left out', () => {
    const s = fresh();
    runSqlLine(s, "INSERT INTO customers (name) VALUES ('Dev');");
    expect(rows(s, "SELECT joined, city FROM customers WHERE name = 'Dev';")).toEqual([['2025-01-01', 'NULL']]);
  });

  it('updates every row when WHERE is forgotten', () => {
    const s = fresh();
    expect(run(s, "UPDATE customers SET city = 'Everywhere';")).toEqual(['UPDATE 3']);
  });

  it('counts the columns against the values', () => {
    const s = fresh();
    expect(run(s, "INSERT INTO customers (name, city) VALUES ('Dev');").join('\n')).toContain('more target columns than expressions');
  });
});

describe('constraints', () => {
  it('refuses a NULL in a NOT NULL column', () => {
    const s = fresh();
    expect(run(s, 'INSERT INTO customers (name) VALUES (NULL);').join('\n')).toContain('violates not-null constraint');
  });

  it('refuses a duplicate primary key', () => {
    const s = fresh();
    const out = run(s, "INSERT INTO customers (id, name) VALUES (1, 'Clone');").join('\n');
    expect(out).toContain('duplicate key value violates unique constraint');
    expect(out).toContain('(id)=(1) already exists');
  });

  it('refuses a foreign key pointing at nothing', () => {
    const s = fresh();
    const out = run(s, "INSERT INTO orders (customer_id, total, placed) VALUES (99, 5, '2026-01-01');").join('\n');
    expect(out).toContain('violates foreign key constraint');
    expect(out).toContain('is not present in table "customers"');
  });

  it('refuses to orphan a child row', () => {
    const s = fresh();
    const out = run(s, 'DELETE FROM customers WHERE id = 1;').join('\n');
    expect(out).toContain('is still referenced from table "orders"');
    expect(s.db.tables.customers.rows).toHaveLength(3);
  });

  it('enforces a CHECK', () => {
    const s = fresh();
    const out = run(s, "INSERT INTO orders (customer_id, total, placed) VALUES (1, -5, '2026-01-01');").join('\n');
    expect(out).toContain('violates check constraint');
    expect(out).toContain('total >= 0');
  });

  it('refuses a value of the wrong type', () => {
    const s = fresh();
    expect(run(s, "INSERT INTO orders (customer_id, total, placed) VALUES (1, 5, 'last tuesday');").join('\n')).toContain('invalid input syntax for type date');
  });
});

describe('transactions', () => {
  it('undoes everything on ROLLBACK', () => {
    const s = fresh();
    run(s, 'BEGIN;', "INSERT INTO customers (name) VALUES ('Temp');");
    expect(rows(s, 'SELECT count(*) FROM customers;')).toEqual([['4']]);
    run(s, 'ROLLBACK;');
    expect(rows(s, 'SELECT count(*) FROM customers;')).toEqual([['3']]);
  });

  it('keeps everything on COMMIT', () => {
    const s = fresh();
    run(s, 'BEGIN;', "INSERT INTO customers (name) VALUES ('Temp');", 'COMMIT;');
    expect(rows(s, 'SELECT count(*) FROM customers;')).toEqual([['4']]);
  });

  it('refuses the rest of an aborted transaction until it ends', () => {
    const s = fresh();
    run(s, 'BEGIN;', 'SELECT nope FROM customers;');
    expect(run(s, "INSERT INTO customers (name) VALUES ('Temp');").join('\n')).toContain('current transaction is aborted');
    run(s, 'ROLLBACK;');
    expect(run(s, "INSERT INTO customers (name) VALUES ('Temp');")).toEqual(['INSERT 0 1']);
  });
});

describe('schema changes', () => {
  it('creates a table and describes it', () => {
    const s = fresh();
    expect(run(s, 'CREATE TABLE products (id serial PRIMARY KEY, sku text UNIQUE NOT NULL, price numeric DEFAULT 0);')).toEqual(['CREATE TABLE']);
    const described = run(s, '\\d products').join('\n');
    expect(described).toContain('Table "public.products"');
    expect(described).toContain('sku');
    expect(described).toContain('products_pkey');
  });

  it('will not point a foreign key at a table that does not exist yet', () => {
    const s = fresh();
    expect(run(s, 'CREATE TABLE lines (id serial PRIMARY KEY, order_id integer REFERENCES nope (id));').join('\n')).toContain('relation "nope" does not exist');
  });

  it('adds and drops columns', () => {
    const s = fresh();
    run(s, "ALTER TABLE customers ADD COLUMN email text;");
    expect(rows(s, 'SELECT email FROM customers WHERE id = 1;')).toEqual([['NULL']]);
    run(s, 'ALTER TABLE customers DROP COLUMN email;');
    expect(run(s, 'SELECT email FROM customers;').join('\n')).toContain('does not exist');
  });

  it('will not add a NOT NULL column to a table with rows in it', () => {
    const s = fresh();
    expect(run(s, 'ALTER TABLE customers ADD COLUMN code text NOT NULL;').join('\n')).toContain('contains null values');
  });

  it('makes views and indexes, and lists them', () => {
    const s = fresh();
    expect(run(s, 'CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 20;')).toEqual(['CREATE VIEW']);
    expect(rows(s, 'SELECT count(*) FROM big_orders;')).toEqual([['2']]);
    expect(run(s, 'CREATE INDEX orders_placed_idx ON orders (placed);')).toEqual(['CREATE INDEX']);
    expect(run(s, '\\di').join('\n')).toContain('orders_placed_idx');
  });

  it('shows an index in the plan once there is one to use', () => {
    const s = fresh();
    const before = run(s, "EXPLAIN SELECT * FROM orders WHERE placed = '2026-01-05';").join('\n');
    expect(before).toContain('Seq Scan on orders');
    run(s, 'CREATE INDEX orders_placed_idx ON orders (placed);');
    const after = run(s, "EXPLAIN SELECT * FROM orders WHERE placed = '2026-01-05';").join('\n');
    expect(after).toContain('Index Scan using orders_placed_idx');
  });
});

describe('the psql session itself', () => {
  it('lists tables with \\dt and knows nothing else', () => {
    const s = fresh();
    const out = run(s, '\\dt').join('\n');
    expect(out).toContain('customers');
    expect(out).toContain('orders');
    expect(run(s, '\\nope').join('\n')).toContain('invalid command');
  });

  it('carries a statement across several lines', () => {
    const s = fresh();
    expect(run(s, 'SELECT name', 'FROM customers', "WHERE city = 'Leeds';").join('\n')).toContain('Bo');
  });

  it('runs two statements typed on one line', () => {
    const s = fresh();
    const out = run(s, "INSERT INTO customers (name) VALUES ('X'); SELECT count(*) FROM customers;");
    expect(out[0]).toBe('INSERT 0 1');
    expect(out.join('\n')).toContain('4');
  });

  it('reports \\q so the shell can close the session', () => {
    expect(runSqlLine(fresh(), '\\q').quit).toBe(true);
  });

  it('remembers only the statements that ran', () => {
    const s = fresh();
    run(s, 'SELECT 1;', 'SELECT bad FROM customers;');
    expect(s.ran).toEqual(['SELECT 1']);
  });

  it('prints results in the psql frame', () => {
    const out = formatResult(['id', 'name'], [[1, 'Ada'], [2, null]]);
    expect(out[1]).toMatch(/^-+\+-+$/);
    expect(out[out.length - 1]).toBe('(2 rows)');
    // A NULL is an empty cell, not the word null.
    expect(out[3]).not.toContain('null');
  });
});
