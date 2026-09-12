import type { Lab } from '../types';
import { DB, sqlSite } from './sql-site';

const MODULE = 'sql-change';

export const sqlChangeLabs: Lab[] = [
  {
    id: 'db-09-add-rows',
    moduleId: MODULE,
    order: 1,
    title: 'Add Rows',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Put new data in with INSERT, leave the generated id to the database, and add several rows at once.',
    scenario:
      'A new customer has signed up and the shop has taken on three new lines. INSERT adds rows: you name the table, name the columns you are filling, and give the values in the same order.\n\nYou will notice that nobody supplies an id. The id column is a serial, which means the database hands out the next number itself. Leave it out and let it do that: if you invent ids by hand you will eventually pick one that is already taken.\n\nAdd the customer Gus Weber of Bristol, gus@example.com, who joined on 2026-03-05. Add the product TMP-700, a Milk Thermometer in appliances at 12.75 with 15 in stock. Then add two tableware lines in a single statement: CUP-402 Cappuccino Cup at 5.75 with 60 in stock, and SAU-403 Saucer at 3.25 with 80 in stock.',
    concepts: ['INSERT INTO ... VALUES', 'Naming the columns', 'serial and generated ids', 'Inserting several rows at once'],
    hints: [
      "INSERT INTO customers (name, city, email, joined) VALUES ('Gus Weber', 'Bristol', 'gus@example.com', '2026-03-05');",
      'psql answers INSERT 0 1, where the 1 is the number of rows added.',
      'Several rows go in one statement, separated by commas: VALUES (...), (...);',
      'Leave id out of the column list and the database fills it in.',
    ],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'customer',
        label: 'Add the customer Gus Weber',
        checks: [{ type: 'sql-query', device: DB, sql: "SELECT name, city, email, joined FROM customers WHERE name = 'Gus Weber'", rows: [['Gus Weber', 'Bristol', 'gus@example.com', '2026-03-05']], label: 'customers holds Gus Weber of Bristol' }],
      },
      {
        id: 'product',
        label: 'Add the Milk Thermometer',
        checks: [{ type: 'sql-query', device: DB, sql: "SELECT sku, name, category, price, stock FROM products WHERE sku = 'TMP-700'", rows: [['TMP-700', 'Milk Thermometer', 'appliances', 12.75, 15]], label: 'products holds TMP-700 at 12.75 with 15 in stock' }],
      },
      {
        id: 'pair',
        label: 'Add both tableware lines in one statement',
        checks: [
          { type: 'sql-query', device: DB, sql: "SELECT sku, price, stock FROM products WHERE sku IN ('CUP-402', 'SAU-403') ORDER BY sku", rows: [['CUP-402', 5.75, 60], ['SAU-403', 3.25, 80]], label: 'Both new cups are in products' },
          { type: 'sql-ran', device: DB, pattern: '\\),\\s*\\(', label: 'Added them with a single multi-row INSERT' },
        ],
      },
      {
        id: 'generated',
        label: 'Let the database number the new rows',
        checks: [{ type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM products WHERE id IN (9, 10, 11)', rows: [[3]], label: 'The three new products took ids 9, 10 and 11' }],
      },
    ],
  },
  {
    id: 'db-10-change-and-remove',
    moduleId: MODULE,
    order: 2,
    title: 'Change and Remove',
    difficulty: 'Intermediate',
    estimatedMinutes: 9,
    description: 'Update existing rows, delete the ones you no longer want, and meet the foreign key that refuses to let you orphan data.',
    scenario:
      'UPDATE changes rows that are already there and DELETE removes them. Both take a WHERE clause, and both do exactly what you ask if you forget it: an UPDATE with no WHERE changes every row in the table, and a DELETE with no WHERE empties it. The count psql prints back is your receipt, so read it.\n\nThe espresso machine is going up to 259.00. Cleo Marsh’s order, number 5, has finally gone out and should be marked shipped. The paper filters have been discontinued and nobody has ever ordered them, so that row can go.\n\nThen try something that should not work: delete Ada Lovelace, who has two orders. The database will refuse, because her orders point at her and removing her would leave them pointing at nothing. Read the error: it names the constraint and the table that still references her.',
    concepts: ['UPDATE ... SET ... WHERE', 'DELETE FROM ... WHERE', 'The row count psql reports', 'Foreign keys refuse orphans'],
    hints: [
      "UPDATE products SET price = 259.00 WHERE sku = 'ESP-100';",
      "UPDATE orders SET status = 'shipped' WHERE id = 5;",
      "DELETE FROM products WHERE sku = 'FLT-500';",
      'DELETE FROM customers WHERE name = \'Ada Lovelace\'; is refused, and the error names orders as the table still pointing at her.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'price', label: 'Raise the espresso machine to 259.00', checks: [{ type: 'sql-query', device: DB, sql: "SELECT price FROM products WHERE sku = 'ESP-100'", rows: [[259]], label: 'ESP-100 now costs 259.00' }] },
      { id: 'shipped', label: 'Mark order 5 as shipped', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT status FROM orders WHERE id = 5', rows: [['shipped']], label: 'Order 5 is shipped' }] },
      { id: 'discontinue', label: 'Remove the discontinued paper filters', checks: [{ type: 'sql-query', device: DB, sql: "SELECT count(*) FROM products WHERE sku = 'FLT-500'", rows: [[0]], label: 'FLT-500 is gone' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM products', rows: [[7]], label: 'and nothing else was deleted with it' }] },
      {
        id: 'refused',
        label: 'See the database refuse to orphan Ada’s orders',
        checks: [
          // The delete is refused, so it never becomes a statement that ran: what proves
          // the learner tried it is the error the server printed back at them.
          { type: 'shell-output', device: DB, pattern: 'is still referenced from table "orders"', label: 'Saw the foreign key refuse the delete' },
          { type: 'sql-query', device: DB, sql: "SELECT count(*) FROM customers WHERE name = 'Ada Lovelace'", rows: [[1]], label: 'Ada Lovelace is still there' },
        ],
      },
    ],
  },
  {
    id: 'db-11-all-or-nothing',
    moduleId: MODULE,
    order: 3,
    title: 'All or Nothing',
    difficulty: 'Intermediate',
    estimatedMinutes: 9,
    description: 'Wrap changes in a transaction, undo a mistake with ROLLBACK, then make the right change and COMMIT it.',
    scenario:
      'Coffee prices are going up 10 per cent. Appliances and tableware are not.\n\nThis is exactly the change that goes wrong, so do it behind a safety net. BEGIN opens a transaction: everything after it is provisional, visible to you and to nobody else, until you either COMMIT to keep it or ROLLBACK to throw it away.\n\nFirst make the mistake on purpose. Open a transaction and run the update with no WHERE clause, so every product goes up. Look at the prices, see that the espresso machine has moved too, and ROLLBACK. Check the prices again: everything is back.\n\nNow do it properly. Open another transaction, raise only the coffee prices, rounding to two decimals, check the result, and COMMIT. The three coffee lines should end at 24.20, 20.35 and 5.78, and nothing else should have moved.',
    concepts: ['BEGIN, COMMIT, ROLLBACK', 'Provisional changes', 'Checking before committing', 'Why a WHERE-less UPDATE is worth rehearsing'],
    hints: [
      'BEGIN; then UPDATE products SET price = round(price * 1.1, 2); with no WHERE, and look at the damage.',
      'ROLLBACK; throws the whole transaction away. Re-read the prices and they are the originals.',
      "The correct statement is UPDATE products SET price = round(price * 1.1, 2) WHERE category = 'coffee';",
      'COMMIT; makes it permanent. Until then nobody else would see it.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'begin', label: 'Work inside a transaction', checks: [{ type: 'sql-ran', device: DB, pattern: '^BEGIN', label: 'Opened a transaction with BEGIN' }] },
      { id: 'rollback', label: 'Undo the over-broad update', checks: [{ type: 'sql-ran', device: DB, pattern: '^ROLLBACK', label: 'Threw the mistake away with ROLLBACK' }] },
      { id: 'commit', label: 'Keep the correct one', checks: [{ type: 'sql-ran', device: DB, pattern: '^COMMIT', label: 'Made it permanent with COMMIT' }] },
      {
        id: 'prices',
        label: 'Coffee went up and nothing else did',
        checks: [
          { type: 'sql-query', device: DB, sql: "SELECT price FROM products WHERE category = 'coffee' ORDER BY price", rows: [[5.78], [20.35], [24.2]], label: 'The three coffee lines are 5.78, 20.35 and 24.20' },
          { type: 'sql-query', device: DB, sql: "SELECT price FROM products WHERE category <> 'coffee' ORDER BY price", rows: [[4.5], [6], [34], [89.5], [249]], label: 'Every other price is untouched' },
        ],
      },
    ],
  },
  {
    id: 'db-25-copy-and-archive',
    moduleId: MODULE,
    order: 4,
    title: 'Copy Before You Delete',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Move rows out of a live table into an archive with INSERT ... SELECT, then delete them in the right order.',
    scenario:
      'Cancelled orders are cluttering the orders table, but throwing them away would destroy the record. The answer is to copy them somewhere else first.\n\nINSERT can take its rows from a query instead of from a list of values, which is how you copy data between tables without it ever leaving the database. Build an orders_archive table with the same shape, then fill it from a SELECT that picks out the cancelled orders.\n\nThen delete them, and discover the order matters. An order has items pointing at it, and the foreign key will not let you remove a row something still references. Children first, then the parent. Check the counts before and after so you know exactly what moved.',
    concepts: ['INSERT ... SELECT', 'Archiving before deleting', 'Deleting children before parents', 'Checking counts either side of a change'],
    hints: [
      'CREATE TABLE orders_archive (id integer PRIMARY KEY, customer_id integer NOT NULL, placed date NOT NULL, status text NOT NULL);',
      "INSERT INTO orders_archive (id, customer_id, placed, status) SELECT id, customer_id, placed, status FROM orders WHERE status = 'cancelled';",
      'Delete the items first: DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders_archive);',
      'Then the order itself: DELETE FROM orders WHERE id IN (SELECT id FROM orders_archive);',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'table', label: 'Create the archive table', checks: [{ type: 'sql-table', device: DB, name: 'orders_archive', columns: [{ name: 'id', type: 'integer' }, { name: 'customer_id', type: 'integer' }, { name: 'placed', type: 'date' }, { name: 'status', type: 'text' }], label: 'orders_archive has the same four columns' }] },
      { id: 'copy', label: 'Copy the cancelled order into it with a query', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT id, status FROM orders_archive', rows: [[7, 'cancelled']], label: 'The cancelled order is archived' }, { type: 'sql-ran', device: DB, pattern: 'INSERT\\s+INTO\\s+orders_archive\\s*\\(?[^)]*\\)?\\s*SELECT', label: 'Copied it with INSERT ... SELECT' }] },
      { id: 'items', label: 'Remove its items first', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM order_items WHERE order_id = 7', rows: [[0]], label: 'Order 7 has no items left' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM order_items', rows: [[13]], label: 'and the other 13 items are untouched' }] },
      { id: 'order', label: 'Then remove the order', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM orders', rows: [[7]], label: 'orders is down to 7 rows' }, { type: 'sql-query', device: DB, sql: "SELECT count(*) FROM orders WHERE status = 'cancelled'", rows: [[0]], label: 'and none of them is cancelled' }] },
    ],
  },
  {
    id: 'db-26-update-from-what-you-find',
    moduleId: MODULE,
    order: 5,
    title: 'Update What a Query Finds',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Drive an UPDATE from a subquery, so the rows it changes are the rows another question identifies.',
    scenario:
      'So far every UPDATE has named its rows directly. Real ones rarely can: the rows to change are the answer to a question, and putting that question in the WHERE clause is both shorter and safer than pasting in a list of ids that was correct an hour ago.\n\nThree changes, each driven by a query. Close every order belonging to Ada Lovelace, without looking up her id by hand. Set the stock to zero on every product that has never been ordered. And give five per cent off every product in the category whose products average more than 100, which the database can work out for itself.\n\nOne habit worth forming while you do it: run the inner SELECT on its own first. If it returns the rows you expected, wrapping it in an UPDATE is safe. If it does not, you have just saved yourself.',
    concepts: ['Subqueries in WHERE', 'Updating by question rather than by id', 'Checking the SELECT before running the UPDATE', 'GROUP BY inside a subquery'],
    hints: [
      "UPDATE orders SET status = 'closed' WHERE customer_id = (SELECT id FROM customers WHERE name = 'Ada Lovelace');",
      'UPDATE products SET stock = 0 WHERE id NOT IN (SELECT product_id FROM order_items);',
      'The dear category is the answer to SELECT category FROM products GROUP BY category HAVING avg(price) > 100.',
      'Put that whole query inside WHERE category IN ( ... ) and set price = round(price * 0.95, 2).',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'ada', label: 'Close every order of Ada’s, found by name', checks: [{ type: 'sql-query', device: DB, sql: "SELECT count(*) FROM orders WHERE status = 'closed'", rows: [[2]], label: 'Ada’s 2 orders are closed' }, { type: 'sql-query', device: DB, sql: "SELECT count(*) FROM orders WHERE status = 'closed' AND customer_id <> 1", rows: [[0]], label: 'and nobody else’s were' }] },
      { id: 'stock', label: 'Zero the stock of anything never ordered', checks: [{ type: 'sql-query', device: DB, sql: "SELECT stock FROM products WHERE sku = 'FLT-500'", rows: [[0]], label: 'The unsold product is at zero' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM products WHERE stock = 0', rows: [[1]], label: 'and it is the only one' }] },
      { id: 'discount', label: 'Discount the expensive category', checks: [{ type: 'sql-query', device: DB, sql: "SELECT price FROM products WHERE category = 'appliances' ORDER BY price", rows: [[32.3], [85.03], [236.55]], label: 'The three appliances have 5 per cent off' }, { type: 'sql-query', device: DB, sql: "SELECT price FROM products WHERE category = 'coffee' ORDER BY price", rows: [[5.25], [18.5], [22]], label: 'and the coffee is unchanged' }] },
    ],
  },
];
