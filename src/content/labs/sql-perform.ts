import type { Lab } from '../types';
import { DB, sqlSite } from './sql-site';

const MODULE = 'sql-perform';

export const sqlPerformLabs: Lab[] = [
  {
    id: 'db-16-see-the-plan',
    moduleId: MODULE,
    order: 1,
    title: 'See the Plan',
    difficulty: 'Intermediate',
    estimatedMinutes: 7,
    description: 'Ask the database how it intends to answer a query, and learn to read a sequential scan.',
    scenario:
      'You have been writing queries and reading answers. The database has been deciding how to get them, and it will tell you if you ask. Put EXPLAIN in front of any SELECT and it prints the plan instead of running it.\n\nThe plan here says Seq Scan, short for sequential scan: to find the orders placed on a given day, the database reads every row in the table and keeps the ones that match. On eight rows that is instant. On eight million it is the difference between a report and a coffee break.\n\nExplain a query that filters orders by their date, and one that filters products by category, and read what comes back: the kind of scan, the number of rows the database expects, and the condition it is applying as a filter.',
    concepts: ['EXPLAIN', 'Sequential scans', 'Filters in a plan', 'Estimated rows and cost'],
    hints: [
      "EXPLAIN SELECT * FROM orders WHERE placed = '2026-02-14';",
      'The first line names the operation. Seq Scan means every row is read.',
      'The Filter line underneath is the condition being applied to each row as it goes past.',
      'EXPLAIN ANALYZE runs the query as well and adds the time it actually took.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'orders', label: 'Explain a query that filters orders by date', checks: [{ type: 'sql-ran', device: DB, pattern: '^EXPLAIN\\b.*\\borders\\b', label: 'Ran EXPLAIN on a query against orders' }, { type: 'shell-output', device: DB, pattern: 'Seq Scan on orders', label: 'Saw a sequential scan' }] },
      { id: 'products', label: 'Explain a query that filters products by category', checks: [{ type: 'shell-output', device: DB, pattern: 'Seq Scan on products', label: 'Saw a sequential scan of products' }] },
      { id: 'analyze', label: 'Run one with ANALYZE to see the time taken', checks: [{ type: 'shell-output', device: DB, pattern: 'Execution Time', label: 'Saw the execution time' }] },
    ],
  },
  {
    id: 'db-17-add-an-index',
    moduleId: MODULE,
    order: 2,
    title: 'Add an Index',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Create an index, watch the plan change from a scan to a lookup, and understand what it costs you.',
    scenario:
      'An index is a second copy of one column, kept in order, with a pointer back to the row. Looking a value up in it is like using the index of a book instead of reading the book.\n\nYou saw the database scan the whole orders table to find one date. Give it an index on that column and ask again: the plan changes from Seq Scan to Index Scan, and it names the index it chose.\n\nAn index is not free. It takes space, and every insert, update and delete has to maintain it, so indexing every column makes writes slower for no gain. Index the columns you actually search on. Add one to orders.placed, confirm the plan changed, add one to products.category, then list what you have created with \\di.',
    concepts: ['CREATE INDEX', 'Index Scan versus Seq Scan', 'The write cost of an index', '\\di'],
    hints: [
      'CREATE INDEX orders_placed_idx ON orders (placed);',
      "Now run EXPLAIN SELECT * FROM orders WHERE placed = '2026-02-14'; again and compare.",
      'CREATE INDEX products_category_idx ON products (category);',
      '\\di lists the indexes in the database.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'create', label: 'Index the date orders were placed', checks: [{ type: 'sql-index', device: DB, table: 'orders', column: 'placed', label: 'An index covers orders.placed' }] },
      { id: 'plan', label: 'See the plan switch to an index lookup', checks: [{ type: 'shell-output', device: DB, pattern: 'Index Scan using orders_placed', label: 'Saw an Index Scan on the new index' }] },
      { id: 'category', label: 'Index the product category too', checks: [{ type: 'sql-index', device: DB, table: 'products', column: 'category', label: 'An index covers products.category' }] },
      { id: 'list', label: 'List the indexes you have created', checks: [{ type: 'command', device: DB, pattern: '^\\\\di$', label: 'Run \\di' }] },
    ],
  },
  {
    id: 'db-18-save-a-query',
    moduleId: MODULE,
    order: 3,
    title: 'Save a Query as a View',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Turn a query everyone keeps rewriting into a view, then read it as if it were a table.',
    scenario:
      'The query that totals an order has appeared in three labs now, and it is the sort of thing people paste into chat and get subtly wrong. A view gives it a name.\n\nA view is a stored SELECT. It holds no data of its own: every time you read it, the query runs again, so it is always current. Once it exists you can select from it, filter it and sort it exactly as if it were a table.\n\nCreate order_totals, giving each order its id, the name of the customer who placed it, and the total value of its items. Then use it: read the whole thing, and find the orders worth more than 100 without writing a single join.',
    concepts: ['CREATE VIEW', 'Views hold no data', 'Reading a view like a table', '\\dv'],
    hints: [
      'CREATE VIEW order_totals AS\n  SELECT o.id, c.name AS customer, sum(i.quantity * i.unit_price) AS total\n  FROM orders o\n  JOIN customers c ON c.id = o.customer_id\n  JOIN order_items i ON i.order_id = o.id\n  GROUP BY o.id, c.name;',
      'Every column of a view needs a name, so give the computed one an alias with AS.',
      'SELECT * FROM order_totals ORDER BY total DESC;',
      'SELECT * FROM order_totals WHERE total > 100; reads the view like any other table.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'create', label: 'Create the order_totals view', checks: [{ type: 'sql-view', device: DB, name: 'order_totals', label: 'The view order_totals exists' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM order_totals', rows: [[8]], label: 'and it produces one row per order' }] },
      { id: 'read', label: 'Read the view, dearest order first', checks: [{ type: 'sql-answer', device: DB, ordered: true, sql: 'SELECT * FROM order_totals ORDER BY total DESC', label: 'A query returned all 8 orders by value, dearest first' }] },
      { id: 'filter', label: 'Find the orders worth more than 100', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT * FROM order_totals WHERE total > 100', label: 'A query returned the 3 orders over 100' }] },
    ],
  },
];
