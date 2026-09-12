import type { Lab } from '../types';
import { DB, shopWith, sqlSite } from './sql-site';

/** A mailing list somebody imported twice, which is how duplicates usually arrive. */
const SUBSCRIBERS = `
CREATE TABLE subscribers (
  id serial PRIMARY KEY,
  email text NOT NULL,
  signed_up date NOT NULL
);
INSERT INTO subscribers (email, signed_up) VALUES
  ('ada@example.com', '2025-11-02'),
  ('bo@example.com', '2025-11-04'),
  ('cleo@example.com', '2025-11-09'),
  ('ada@example.com', '2026-01-15'),
  ('dev@example.com', '2026-01-22'),
  ('cleo@example.com', '2026-02-01'),
  ('cleo@example.com', '2026-02-03');
`;

const MODULE = 'sql-design';

export const sqlDesignLabs: Lab[] = [
  {
    id: 'db-12-create-a-table',
    moduleId: MODULE,
    order: 1,
    title: 'Create a Table',
    difficulty: 'Beginner',
    estimatedMinutes: 9,
    description: 'Design a table from scratch: choose a type for every column and a key that identifies each row.',
    scenario:
      'The shop wants to record who it buys from. Nothing in the database tracks that yet, so you will build the table.\n\nA column’s type is a promise about what it can hold, and the database keeps it: text for words, integer for whole numbers, numeric for money, boolean for yes or no, date for a day. Choosing the right one is not fussiness. A price stored as text will sort 9.00 above 10.00, and a date stored as text will accept "last tuesday".\n\nCreate suppliers with an id that the database numbers itself and uses as the primary key, a name that must always be present, a country that defaults to UK when nobody says otherwise, an active flag that is true unless stated, and the date the shop started buying from them. Then add two suppliers and read the table back with \\d to see what you built.',
    concepts: ['CREATE TABLE', 'Column types', 'serial', 'PRIMARY KEY', 'NOT NULL and DEFAULT'],
    hints: [
      'CREATE TABLE suppliers (\n  id serial PRIMARY KEY,\n  name text NOT NULL,\n  ...\n);',
      "A default goes after the type: country text NOT NULL DEFAULT 'UK'.",
      'A boolean holds true or false: active boolean NOT NULL DEFAULT true.',
      '\\d suppliers prints the table you just made, including the defaults and the primary key.',
    ],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'create',
        label: 'Create the suppliers table',
        checks: [
          {
            type: 'sql-table',
            device: DB,
            name: 'suppliers',
            columns: [
              { name: 'id', type: 'integer', primaryKey: true },
              { name: 'name', type: 'text', notNull: true },
              { name: 'country', type: 'text', notNull: true },
              { name: 'active', type: 'boolean', notNull: true },
              { name: 'since', type: 'date' },
            ],
            label: 'suppliers has id, name, country, active and since with the right types',
          },
        ],
      },
      {
        id: 'defaults',
        label: 'Give country and active their defaults',
        checks: [{ type: 'sql-ran', device: DB, pattern: 'DEFAULT', label: 'Used DEFAULT in the table definition' }],
      },
      {
        id: 'rows',
        label: 'Add two suppliers',
        checks: [{ type: 'sql-table', device: DB, name: 'suppliers', rows: 2, label: 'suppliers holds 2 rows' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM suppliers WHERE id IN (1, 2)', rows: [[2]], label: 'and the database numbered them 1 and 2' }],
      },
      { id: 'describe', label: 'Read the table you built', checks: [{ type: 'command', device: DB, pattern: '^\\\\d\\s+suppliers$', label: 'Run \\d suppliers' }] },
    ],
  },
  {
    id: 'db-13-keys-and-rules',
    moduleId: MODULE,
    order: 2,
    title: 'Rules the Data Must Follow',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Constrain a table with UNIQUE and CHECK, then watch the database refuse the data that breaks the rules.',
    scenario:
      'Validation you write in an application protects only the path through that application. A constraint in the database protects the data from everything, including the script somebody runs at midnight.\n\nThe shop is launching discount codes. Build a coupons table where the code itself is the primary key, the discount is a whole number of per cent that must be more than zero and no more than fifty, the expiry date is always required, and a counter of uses starts at zero.\n\nThen try to break it, three times, and read each refusal. Add a perfectly good coupon. Try a second coupon with the same code. Try one offering ninety per cent off. Each error names the constraint that stopped you, which is exactly what you want to happen at three in the morning.',
    concepts: ['PRIMARY KEY on a natural key', 'CHECK constraints', 'UNIQUE', 'Reading a constraint violation'],
    hints: [
      'CREATE TABLE coupons (\n  code text PRIMARY KEY,\n  percent integer NOT NULL CHECK (percent > 0 AND percent <= 50),\n  expires date NOT NULL,\n  uses integer NOT NULL DEFAULT 0\n);',
      "INSERT INTO coupons (code, percent, expires) VALUES ('SPRING10', 10, '2026-06-30');",
      'Insert SPRING10 a second time and the error mentions a duplicate key value.',
      'Insert a coupon with percent 90 and the error names the check constraint that refused it.',
    ],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'create',
        label: 'Create the coupons table with its rules',
        checks: [
          { type: 'sql-table', device: DB, name: 'coupons', columns: [{ name: 'code', type: 'text', primaryKey: true }, { name: 'percent', type: 'integer', notNull: true }, { name: 'expires', type: 'date', notNull: true }, { name: 'uses', type: 'integer', notNull: true }], label: 'coupons has code, percent, expires and uses' },
          { type: 'sql-ran', device: DB, pattern: 'CHECK\\s*\\(', label: 'Added a CHECK constraint' },
        ],
      },
      { id: 'good', label: 'Add a coupon that follows the rules', checks: [{ type: 'sql-table', device: DB, name: 'coupons', rows: 1, label: 'coupons holds exactly one row' }, { type: 'sql-query', device: DB, sql: 'SELECT uses FROM coupons', rows: [[0]], label: 'and its use count defaulted to 0' }] },
      { id: 'duplicate', label: 'See a duplicate code refused', checks: [{ type: 'shell-output', device: DB, pattern: 'duplicate key value violates unique constraint', label: 'Saw the primary key refuse a repeat' }] },
      { id: 'toobig', label: 'See an impossible discount refused', checks: [{ type: 'shell-output', device: DB, pattern: 'violates check constraint', label: 'Saw the CHECK refuse 90 per cent' }] },
    ],
  },
  {
    id: 'db-14-link-tables',
    moduleId: MODULE,
    order: 3,
    title: 'Link the Tables',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Point one table at another with a foreign key, and see the database refuse a row that points nowhere.',
    scenario:
      'The shop wants to track deliveries. A shipment belongs to exactly one order, so the shipments table holds the order’s id rather than a copy of its details.\n\nSaying REFERENCES orders (id) turns that from a convention into a rule. The database will then refuse any shipment whose order does not exist, and refuse to delete an order that still has shipments. That is the whole point: the two tables cannot drift apart.\n\nBuild shipments with its own id, the order it belongs to, a courier, and the date it went out. Record the shipment of order 1 by DPD on 2026-01-07. Then try to record a shipment for order 99, which does not exist, and read the refusal.',
    concepts: ['REFERENCES', 'Foreign keys', 'Referential integrity', 'Reading a foreign key violation'],
    hints: [
      'CREATE TABLE shipments (\n  id serial PRIMARY KEY,\n  order_id integer NOT NULL REFERENCES orders (id),\n  courier text NOT NULL,\n  sent date NOT NULL\n);',
      "INSERT INTO shipments (order_id, courier, sent) VALUES (1, 'DPD', '2026-01-07');",
      'Now try order_id 99. The error names the foreign key constraint and the table it points at.',
      '\\d shipments lists the foreign key at the bottom.',
    ],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'create',
        label: 'Create shipments pointing at orders',
        checks: [{ type: 'sql-table', device: DB, name: 'shipments', columns: [{ name: 'id', primaryKey: true }, { name: 'order_id', type: 'integer', notNull: true, references: 'orders' }, { name: 'courier', type: 'text', notNull: true }, { name: 'sent', type: 'date', notNull: true }], label: 'shipments.order_id references orders' }],
      },
      { id: 'record', label: 'Record the shipment of order 1', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT order_id, courier, sent FROM shipments', rows: [[1, 'DPD', '2026-01-07']], label: 'shipments holds the DPD delivery of order 1' }] },
      { id: 'refused', label: 'See a shipment for a missing order refused', checks: [{ type: 'shell-output', device: DB, pattern: 'violates foreign key constraint', label: 'Saw the foreign key refuse order 99' }, { type: 'sql-table', device: DB, name: 'shipments', rows: 1, label: 'and the bad row was not stored' }] },
    ],
  },
  {
    id: 'db-15-change-the-shape',
    moduleId: MODULE,
    order: 4,
    title: 'Change the Shape',
    difficulty: 'Intermediate',
    estimatedMinutes: 9,
    description: 'Alter a table that already holds data: add columns, rename one, and drop one you no longer need.',
    scenario:
      'A schema is never finished. ALTER TABLE changes one that is already in use, and the rows already in it have to remain valid, which constrains what you are allowed to do.\n\nThe customers table needs a phone number, and a loyalty tier. Add phone first: it is optional, so every existing row simply gets NULL. Then try to add loyalty as text NOT NULL and watch it fail, because the six rows already there would have no value for it. Add it properly with a default of bronze, and the existing rows take that value.\n\nWhile you are there, joined is a vague name, so rename it to signed_up. Then the marketing team change their mind about phone numbers, so drop that column again.',
    concepts: ['ALTER TABLE ADD COLUMN', 'Why NOT NULL needs a DEFAULT on a filled table', 'RENAME COLUMN', 'DROP COLUMN'],
    hints: [
      'ALTER TABLE customers ADD COLUMN phone text;',
      'ALTER TABLE customers ADD COLUMN loyalty text NOT NULL; fails, because the rows already there would breach it.',
      "Give it a value for them: ALTER TABLE customers ADD COLUMN loyalty text NOT NULL DEFAULT 'bronze';",
      'ALTER TABLE customers RENAME COLUMN joined TO signed_up; and ALTER TABLE customers DROP COLUMN phone;',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'refused', label: 'See NOT NULL refused on a table with rows in it', checks: [{ type: 'shell-output', device: DB, pattern: 'contains null values', label: 'Saw the server refuse a NOT NULL column with no default' }] },
      { id: 'loyalty', label: 'Add loyalty with a default of bronze', checks: [{ type: 'sql-table', device: DB, name: 'customers', columns: [{ name: 'loyalty', type: 'text', notNull: true }], label: 'customers has a NOT NULL loyalty column' }, { type: 'sql-query', device: DB, sql: "SELECT count(*) FROM customers WHERE loyalty = 'bronze'", rows: [[6]], label: 'and all 6 existing customers are bronze' }] },
      { id: 'rename', label: 'Rename joined to signed_up', checks: [{ type: 'sql-table', device: DB, name: 'customers', columns: [{ name: 'signed_up', type: 'date' }], absent: ['joined'], label: 'joined is now signed_up' }] },
      { id: 'drop', label: 'Drop the phone column again', checks: [{ type: 'sql-table', device: DB, name: 'customers', absent: ['phone'], label: 'phone is gone' }, { type: 'sql-ran', device: DB, pattern: 'ADD\\s+COLUMN\\s+phone', label: 'after having added it' }] },
    ],
  },
  {
    id: 'db-27-find-and-fix-duplicates',
    moduleId: MODULE,
    order: 5,
    title: 'Find and Fix Duplicates',
    difficulty: 'Intermediate',
    estimatedMinutes: 11,
    description: 'Track down duplicated rows with GROUP BY and HAVING, remove the extras, and add the constraint that stops them coming back.',
    scenario:
      'Somebody imported the mailing list twice. The subscribers table now holds seven rows for five people, and because nothing stops it, it will happen again.\n\nFind the damage first. Grouping by email and keeping only the groups with more than one row is the standard way to ask "what is duplicated, and how badly".\n\nThen try to add the rule that should have been there from the start, a UNIQUE constraint on email. It will be refused, and that refusal is useful: a constraint cannot be added to data that already breaks it, which tells you the cleanup has to come first.\n\nClean up by keeping the earliest sign-up for each address and deleting the rest. The lowest id per email is the one to keep. Then add the constraint for real, and prove it works by trying to insert a duplicate.',
    concepts: ['Finding duplicates with GROUP BY and HAVING', 'Why a constraint cannot be added to broken data', 'Keeping one row per group with min(id)', 'ALTER TABLE ADD UNIQUE'],
    hints: [
      'SELECT email, count(*) FROM subscribers GROUP BY email HAVING count(*) > 1;',
      'ALTER TABLE subscribers ADD UNIQUE (email); is refused while the duplicates are still there.',
      'The rows worth keeping are SELECT min(id) FROM subscribers GROUP BY email, so delete everything not in that list.',
      'Then add the constraint again, and try inserting an address that already exists.',
    ],
    createState: () => sqlSite({ setup: shopWith(SUBSCRIBERS) }),
    objectives: [
      { id: 'find', label: 'Find which addresses are duplicated', checks: [{ type: 'sql-answer', device: DB, rows: [['ada@example.com', 2], ['cleo@example.com', 3]], label: 'A query returned the 2 duplicated addresses with their counts' }] },
      { id: 'refused', label: 'See the constraint refused while the data is dirty', checks: [{ type: 'shell-output', device: DB, pattern: 'duplicate key value|could not create unique index', label: 'Adding UNIQUE was refused' }] },
      { id: 'clean', label: 'Keep only the earliest row per address', checks: [{ type: 'sql-table', device: DB, name: 'subscribers', rows: 4, label: 'subscribers is down to 4 rows' }, { type: 'sql-query', device: DB, sql: 'SELECT id FROM subscribers ORDER BY id', rows: [[1], [2], [3], [5]], label: 'and the rows kept are the earliest of each' }] },
      { id: 'constrain', label: 'Add the constraint and prove it holds', checks: [{ type: 'sql-table', device: DB, name: 'subscribers', columns: [{ name: 'email', unique: true }], label: 'email is now unique' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM subscribers', rows: [[4]], label: 'and a duplicate insert changed nothing' }] },
    ],
  },
  {
    id: 'db-28-model-a-choice',
    moduleId: MODULE,
    order: 6,
    title: 'Model a Many-to-Many',
    difficulty: 'Intermediate',
    estimatedMinutes: 11,
    description: 'Add tags to products with a table in the middle, keyed on the pair of columns rather than on either one.',
    scenario:
      'The shop wants to tag products: gift, sale, new, and so on. A product can carry several tags and a tag applies to several products, so neither table can hold the other’s id in a column.\n\nThe answer is a third table holding nothing but pairs. What makes it work is the key: neither column is unique on its own, because a product appears once per tag and a tag once per product, but the combination must never repeat. A primary key can span two columns, and that is exactly what this needs.\n\nBuild tags with a generated id and a name that cannot repeat. Build product_tags with a product_id and a tag_id, each required and each pointing at its table, and a primary key over the pair. Add the tags gift, sale and new, then tag the espresso machine as a gift and on sale, and the burr grinder as a gift.\n\nThen use it: list the products tagged gift, list the tags on the espresso machine, and try to tag it as a gift a second time to see the pair refused.',
    concepts: ['Junction tables', 'A primary key over two columns', 'Two foreign keys in one table', 'Querying through the middle table'],
    hints: [
      'CREATE TABLE tags (id serial PRIMARY KEY, name text NOT NULL UNIQUE);',
      'CREATE TABLE product_tags (\n  product_id integer NOT NULL REFERENCES products (id),\n  tag_id integer NOT NULL REFERENCES tags (id),\n  PRIMARY KEY (product_id, tag_id)\n);',
      'The espresso machine is product 1 and the burr grinder is product 2; look the tag ids up rather than guessing.',
      'To list products by tag, join products to product_tags to tags and filter on the tag name.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'tags', label: 'Create the tags table', checks: [{ type: 'sql-table', device: DB, name: 'tags', columns: [{ name: 'id', type: 'integer', primaryKey: true }, { name: 'name', type: 'text', notNull: true, unique: true }], label: 'tags has a generated id and a unique name' }] },
      { id: 'join-table', label: 'Create product_tags keyed on the pair', checks: [{ type: 'sql-table', device: DB, name: 'product_tags', columns: [{ name: 'product_id', type: 'integer', notNull: true, references: 'products' }, { name: 'tag_id', type: 'integer', notNull: true, references: 'tags' }], label: 'product_tags points at both tables' }, { type: 'sql-ran', device: DB, pattern: 'PRIMARY\\s+KEY\\s*\\(\\s*\\w+\\s*,', label: 'with a primary key over both columns' }] },
      { id: 'apply', label: 'Add the tags and apply three of them', checks: [{ type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM tags', rows: [[3]], label: 'Three tags exist' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM product_tags', rows: [[3]], label: 'and three products are tagged' }] },
      { id: 'query', label: 'List the products tagged gift', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT p.name FROM products p JOIN product_tags pt ON pt.product_id = p.id JOIN tags t ON t.id = pt.tag_id WHERE t.name = 'gift'", label: 'A query returned the 2 gift products' }] },
      { id: 'refused', label: 'See the same pair refused a second time', checks: [{ type: 'shell-output', device: DB, pattern: 'duplicate key value violates unique constraint "product_tags_pkey"', label: 'The pair could not be repeated' }, { type: 'sql-query', device: DB, sql: 'SELECT count(*) FROM product_tags', rows: [[3]], label: 'and nothing was added' }] },
    ],
  },
];
