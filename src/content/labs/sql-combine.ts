import type { Lab } from '../types';
import { DB, sqlSite } from './sql-site';

const MODULE = 'sql-combine';

export const sqlCombineLabs: Lab[] = [
  {
    id: 'db-05-join-two-tables',
    moduleId: MODULE,
    order: 1,
    title: 'Join Two Tables',
    difficulty: 'Beginner',
    estimatedMinutes: 9,
    description: 'Follow a foreign key: put customer names next to their orders, and product names next to the items on them.',
    scenario:
      'The orders table does not hold customer names. It holds customer_id, a number pointing at a row in customers. That is deliberate: the name is stored once, in one place, and everything else refers to it.\n\nTo see them together you join. You name both tables and say how a row in one lines up with a row in the other: FROM customers c JOIN orders o ON o.customer_id = c.id. The short names c and o are aliases, and they save you writing the full table name in front of every column.\n\nProduce a list of every order with the name of the customer who placed it. Then go one step further: order_items points at both orders and products, so join three tables to list every item with its product name.',
    concepts: ['Foreign keys', 'JOIN ... ON', 'Table aliases', 'Qualifying columns with t.column', 'Joining three tables'],
    hints: [
      'Give each table a short alias and use it on every column: SELECT c.name, o.id FROM customers c JOIN orders o ON o.customer_id = c.id;',
      'Without ON, the database has no idea which rows belong together and refuses the query.',
      'A third table joins onto what you already have: JOIN products p ON p.id = i.product_id.',
      'Columns that exist in both tables, like id, must be qualified or the server will call them ambiguous.',
    ],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'orders',
        label: 'List every order with its customer name',
        checks: [
          { type: 'sql-answer', device: DB, sql: 'SELECT c.name, o.id, o.placed FROM customers c JOIN orders o ON o.customer_id = c.id', label: 'A query returned all 8 orders with a name attached' },
          { type: 'sql-ran', device: DB, pattern: '\\bJOIN\\b', label: 'Used a JOIN' },
        ],
      },
      {
        id: 'items',
        label: 'List every order item with its product name',
        checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT o.id, p.name, i.quantity FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id', label: 'A query returned all 14 items with a product name' }],
      },
      {
        id: 'one-customer',
        label: 'List the products Ada Lovelace has ordered',
        checks: [{ type: 'sql-answer', device: DB, sql: "SELECT p.name FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id WHERE c.name = 'Ada Lovelace'", label: 'A query returned Ada’s 4 ordered items' }],
      },
    ],
  },
  {
    id: 'db-06-keep-every-row',
    moduleId: MODULE,
    order: 2,
    title: 'Keep Every Row',
    difficulty: 'Intermediate',
    estimatedMinutes: 9,
    description: 'See what an inner join silently drops, then keep those rows with a LEFT JOIN and find the customers who have never ordered.',
    scenario:
      'A plain JOIN only returns rows that matched. That is usually what you want, and occasionally a trap: anyone with no orders at all simply vanishes from the report, and nothing tells you they were dropped.\n\nOne of the six customers has never placed an order. Prove it. First join customers to orders the ordinary way and list the distinct names that come back: you will get five, not six. Then do it again with LEFT JOIN, which keeps every row on the left whether or not it found a partner, and fills the missing columns with NULL.\n\nFinally, turn that into the report the shop actually wants: the customers who have never ordered anything, found by keeping every customer and then keeping only the ones whose order columns came back NULL.',
    concepts: ['INNER JOIN drops unmatched rows', 'LEFT JOIN keeps them', 'NULL from the unmatched side', 'Finding rows with no match'],
    hints: [
      'SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id; returns five names. Count the customers table and you will see one is missing.',
      'LEFT JOIN keeps every row of the left table: FROM customers c LEFT JOIN orders o ON o.customer_id = c.id.',
      'For the customer with no orders, every column from orders is NULL, so WHERE o.id IS NULL finds exactly them.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'inner', label: 'See the five customers an inner join returns', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id', label: 'A query returned only the 5 customers with orders' }] },
      { id: 'outer', label: 'Keep all six with a LEFT JOIN', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT c.name, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id', label: 'A query returned 9 rows, one of them with no order' }, { type: 'sql-ran', device: DB, pattern: 'LEFT\\s+(OUTER\\s+)?JOIN', label: 'Used a LEFT JOIN' }] },
      { id: 'never', label: 'Find the customer who has never ordered', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL', label: 'A query returned Finn Doyle alone' }] },
    ],
  },
  {
    id: 'db-07-summarise',
    moduleId: MODULE,
    order: 3,
    title: 'Summarise the Data',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Collapse many rows into one answer with count, sum and avg, split them with GROUP BY, and filter the groups with HAVING.',
    scenario:
      'So far every query has returned rows. Aggregate functions return an answer about a set of rows instead: count(*) how many, sum() the total, avg() the average, min() and max() the extremes.\n\nOn their own they collapse the whole table to a single row. GROUP BY splits it first, so you get one answer per group. The rule that catches everyone: once you group, every column you select must either be one of the grouping columns or be inside an aggregate, because the database has no single value for the rest.\n\nCount the products in each category. Work out the average price in each, rounded to two decimals. Then the number the shop really wants: the value of every order, which means joining the items on and summing quantity times unit price per order. Finally, filter the groups themselves: which customers have placed more than one order? WHERE cannot answer that, because it runs before the grouping; HAVING runs after.',
    concepts: ['count, sum, avg, min, max', 'GROUP BY', 'One answer per group', 'HAVING filters groups, WHERE filters rows'],
    hints: [
      'SELECT category, count(*) FROM products GROUP BY category;',
      'round(avg(price), 2) keeps the average readable.',
      'An order’s value is sum(i.quantity * i.unit_price), grouped by the order id.',
      'HAVING comes after GROUP BY: SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 1;',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'count', label: 'Count the products in each category', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT category, count(*) FROM products GROUP BY category', label: 'A query returned a count for each of the 3 categories' }] },
      { id: 'avg', label: 'Average the price in each category, to two decimals', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT category, round(avg(price), 2) FROM products GROUP BY category', label: 'A query returned the 3 rounded averages' }] },
      { id: 'totals', label: 'Work out the value of every order', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT o.id, sum(i.quantity * i.unit_price) FROM orders o JOIN order_items i ON i.order_id = o.id GROUP BY o.id', label: 'A query returned a total for each of the 8 orders' }] },
      { id: 'having', label: 'Find the customers who have ordered more than once', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 1', label: 'A query returned the 3 repeat customers' }, { type: 'sql-ran', device: DB, pattern: '\\bHAVING\\b', label: 'Used HAVING' }] },
    ],
  },
  {
    id: 'db-08-questions-inside-questions',
    moduleId: MODULE,
    order: 4,
    title: 'Questions Inside Questions',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Use one query’s answer inside another with IN, a scalar subquery, and EXISTS.',
    scenario:
      'Some questions need an answer before they can be asked. "Which products are dearer than average?" needs the average first. "Which customers ordered in February?" needs the list of February orders first.\n\nA subquery is just a SELECT in brackets inside another statement. Where it returns a single value you can compare to it directly. Where it returns a column of values you can test membership with IN. And where you only care whether anything came back at all, EXISTS is the honest way to say so, because it stops at the first match.\n\nAnswer four questions: which products have never appeared on an order, which customers ordered during February 2026, which products cost more than the average product, and which customers have no orders at all, this time using NOT EXISTS rather than the LEFT JOIN you used before.',
    concepts: ['Subqueries', 'IN with a subquery', 'Scalar subqueries', 'EXISTS and NOT EXISTS', 'Correlated subqueries'],
    hints: [
      'A subquery returning one column works with IN: WHERE id NOT IN (SELECT product_id FROM order_items).',
      'A subquery returning one value can be compared: WHERE price > (SELECT avg(price) FROM products).',
      'EXISTS is correlated: the inner query mentions the outer row. WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id).',
      'Give the outer table an alias so the inner query can refer to it.',
    ],
    createState: () => sqlSite(),
    objectives: [
      { id: 'unsold', label: 'Find the product nobody has ever ordered', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM products WHERE id NOT IN (SELECT product_id FROM order_items)', label: 'A query returned Paper Filters 100 alone' }] },
      { id: 'february', label: 'Find the customers who ordered during February 2026', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE placed BETWEEN '2026-02-01' AND '2026-02-28')", label: 'A query returned the 4 February customers' }] },
      { id: 'dearer', label: 'Find the products dearer than the average product', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM products WHERE price > (SELECT avg(price) FROM products)', label: 'A query returned the 2 above-average products' }] },
      { id: 'exists', label: 'Find the customer with no orders, using NOT EXISTS', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)', label: 'A query returned Finn Doyle alone' }, { type: 'sql-ran', device: DB, pattern: 'NOT\\s+EXISTS', label: 'Used NOT EXISTS' }] },
    ],
  },
];
