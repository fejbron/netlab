import type { Lab } from '../types';
import { DB, sqlSite } from './sql-site';

const MODULE = 'sql-query';

export const sqlQueryLabs: Lab[] = [
  {
    id: 'db-01-first-query',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Query',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Meet the psql prompt, find out what is in the database, and read a table.',
    scenario:
      'You are connected to shop, the database behind a small coffee-equipment business. The prompt reads shop=#, which tells you the database you are attached to. Everything you type is SQL, and every statement ends with a semicolon: without one, psql assumes you have more to say and waits, showing shop-# instead.\n\nStart by finding your way around. \\dt lists the tables. \\d products describes one of them, column by column. Then read the products table in full with SELECT * FROM products; and finally ask for just the two columns you care about, the name and the price.',
    concepts: ['The psql prompt', '\\dt and \\d', 'SELECT * FROM table', 'Choosing columns', 'The semicolon'],
    hints: [
      'Backslash commands are psql’s own and need no semicolon. Type \\dt on its own line.',
      '\\d products prints every column of products with its type.',
      'SELECT * FROM products; reads every column of every row. The * means "all columns".',
      'Name the columns you want instead of the star: SELECT name, price FROM products;',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'tables', label: 'List the tables in the database', checks: [{ type: 'command', device: DB, pattern: '^\\\\dt$', label: 'Run \\dt' }] },
      { id: 'describe', label: 'Describe the products table', checks: [{ type: 'command', device: DB, pattern: '^\\\\d\\s+products$', label: 'Run \\d products' }] },
      { id: 'all', label: 'Read every column of every product', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT * FROM products', label: 'A query returned all 8 products in full' }] },
      { id: 'columns', label: 'Read just the name and price', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name, price FROM products', label: 'A query returned the name and price of all 8 products' }] },
    ],
  },
  {
    id: 'db-02-choose-rows',
    moduleId: MODULE,
    order: 2,
    title: 'Choose the Rows',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Filter with WHERE: equality, comparison, IN, LIKE and BETWEEN.',
    scenario:
      'A table with eight rows is easy to read whole. A real one is not, so you say which rows you want with WHERE.\n\nThe shop needs five answers. Which customers are in London. Which products cost more than 50. Which products are in the coffee or tableware categories, asked with IN rather than two conditions. Which products have "Beans" in the name, asked with LIKE and a % wildcard. And which orders were placed during February 2026, asked with BETWEEN.',
    concepts: ['WHERE', 'Comparison operators', 'IN', 'LIKE and %', 'BETWEEN', 'Quoting text and dates'],
    hints: [
      'Text and dates go in single quotes; numbers do not. SELECT name FROM customers WHERE city = \'London\';',
      'IN takes a list: WHERE category IN (\'coffee\', \'tableware\'). It is shorter than category = \'coffee\' OR category = \'tableware\'.',
      'LIKE matches a pattern where % stands for any run of characters: WHERE name LIKE \'%Beans%\'.',
      'BETWEEN includes both ends: WHERE placed BETWEEN \'2026-02-01\' AND \'2026-02-28\'.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'london', label: 'Find the customers in London', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT name FROM customers WHERE city = 'London'", label: 'A query returned Ada Lovelace and Cleo Marsh' }] },
      { id: 'expensive', label: 'Find the products costing more than 50', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name, price FROM products WHERE price > 50', label: 'A query returned the two products over 50' }] },
      { id: 'categories', label: 'Find the coffee and tableware products with IN', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT name FROM products WHERE category IN ('coffee', 'tableware')", label: 'A query returned the 5 coffee and tableware products' }, { type: 'sql-ran', device: DB, pattern: '\\bIN\\s*\\(', label: 'Used IN' }] },
      { id: 'beans', label: 'Find the products with Beans in the name', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT name FROM products WHERE name LIKE '%Beans%'", label: 'A query returned the two bean products' }, { type: 'sql-ran', device: DB, pattern: '\\bI?LIKE\\b', label: 'Used LIKE' }] },
      { id: 'february', label: 'Find the orders placed in February 2026', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT id FROM orders WHERE placed BETWEEN '2026-02-01' AND '2026-02-28'", label: 'A query returned the 5 February orders' }] },
    ],
  },
  {
    id: 'db-03-sort-and-limit',
    moduleId: MODULE,
    order: 3,
    title: 'Sort and Trim',
    difficulty: 'Beginner',
    estimatedMinutes: 7,
    description: 'Put rows in order with ORDER BY, take the top few with LIMIT, and remove repeats with DISTINCT.',
    scenario:
      'Rows come back in whatever order the database finds them, which is not an order you can rely on. ORDER BY fixes that, and once rows are in order, LIMIT takes only the first few.\n\nProduce the price list cheapest first. Then the three most expensive products, most expensive first. Then the list of categories the shop sells, with each name appearing once. Finally the three newest customers, newest first.',
    concepts: ['ORDER BY', 'ASC and DESC', 'LIMIT', 'DISTINCT'],
    hints: [
      'ORDER BY price sorts ascending; add DESC for the other direction.',
      'LIMIT goes last: SELECT name, price FROM products ORDER BY price DESC LIMIT 3;',
      'DISTINCT comes straight after SELECT and removes duplicate rows: SELECT DISTINCT category FROM products;',
      'Newest first means the largest date first, so ORDER BY joined DESC.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'cheapest', label: 'List the products cheapest first', checks: [{ type: 'sql-answer', device: DB, ordered: true, sql: 'SELECT name, price FROM products ORDER BY price', label: 'A query returned all 8 products in price order' }] },
      { id: 'top3', label: 'Show the three most expensive products', checks: [{ type: 'sql-answer', device: DB, ordered: true, sql: 'SELECT name, price FROM products ORDER BY price DESC LIMIT 3', label: 'A query returned the top 3, dearest first' }] },
      { id: 'categories', label: 'List each category once', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT DISTINCT category FROM products', label: 'A query returned the 3 categories' }] },
      { id: 'newest', label: 'Show the three newest customers', checks: [{ type: 'sql-answer', device: DB, ordered: true, sql: 'SELECT name, joined FROM customers ORDER BY joined DESC LIMIT 3', label: 'A query returned the 3 most recent joiners, newest first' }] },
    ],
  },
  {
    id: 'db-04-missing-values',
    moduleId: MODULE,
    order: 4,
    title: 'The Value That Is Not There',
    difficulty: 'Beginner',
    estimatedMinutes: 7,
    description: 'Work with NULL: why comparing to it never matches, how to test for it, and how to substitute something readable.',
    scenario:
      'Two customers are missing information: one has no email address on file and one has no city. The database stores that absence as NULL, which is not an empty string and not zero. It means "unknown".\n\nThat has a consequence people trip over constantly: WHERE email = NULL returns nothing at all, because comparing anything to an unknown gives an unknown answer, and a WHERE clause keeps only rows where the answer is true. Try it and see, then ask the question properly with IS NULL.\n\nFind the customer with no email, then everyone who does have one, then count how many customers have a city recorded, and finally produce a list of every customer with their city, showing "unknown" where there is none.',
    concepts: ['NULL means unknown', 'IS NULL and IS NOT NULL', 'Why = NULL never matches', 'COALESCE'],
    hints: [
      'Run SELECT name FROM customers WHERE email = NULL; first. It returns no rows, and that is the lesson.',
      'The working form is IS NULL: SELECT name FROM customers WHERE email IS NULL;',
      'count(*) counts rows: SELECT count(*) FROM customers WHERE city IS NOT NULL;',
      "coalesce takes the first argument that is not NULL: SELECT name, coalesce(city, 'unknown') FROM customers;",
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'tryit', label: 'See for yourself that = NULL matches nothing', checks: [{ type: 'sql-ran', device: DB, pattern: '=\\s*NULL', label: 'Compared a column to NULL' }] },
      { id: 'noemail', label: 'Find the customer with no email address', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM customers WHERE email IS NULL', label: 'A query returned Cleo Marsh' }] },
      { id: 'hasemail', label: 'Find the customers who do have one', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM customers WHERE email IS NOT NULL', label: 'A query returned the other 5 customers' }] },
      { id: 'count', label: 'Count the customers with a city on file', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT count(*) FROM customers WHERE city IS NOT NULL', label: 'A query returned 5' }] },
      { id: 'coalesce', label: 'List every customer with a readable city', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT name, coalesce(city, 'unknown') FROM customers", label: 'A query returned all 6 customers with no blank city' }] },
    ],
  },
];
