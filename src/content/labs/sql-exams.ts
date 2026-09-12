import type { Lab } from '../types';
import { DB, shopWith, sqlSite } from './sql-site';

/** A contact list assembled by hand over two years, with every mistake that implies. */
const CONTACTS = `
CREATE TABLE contacts (
  id serial PRIMARY KEY,
  email text,
  name text NOT NULL,
  marketing text
);
INSERT INTO contacts (email, name, marketing) VALUES
  ('ada@example.com', 'Ada Lovelace', 'yes'),
  ('bo@example.com', 'Bo Nilsson', 'NO'),
  (NULL, 'Unknown Walk-in', NULL),
  ('cleo@example.com', 'Cleo Marsh', 'Yes'),
  ('ada@example.com', 'A. Lovelace', 'yes'),
  ('dev@example.com', 'Dev Patel', NULL),
  ('cleo@example.com', 'C Marsh', 'no');
`;

const MODULE = 'sql-exams';

export const sqlExamLabs: Lab[] = [
  {
    id: 'db-19-exam-the-monthly-report',
    moduleId: MODULE,
    order: 1,
    title: 'Exam: The Monthly Report',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Answer five questions about the shop using joins, aggregates and subqueries. No hints are available.',
    scenario:
      'The shop’s owner wants a trading report and has given you five questions. Answer each one with a single query. How you write it is up to you; what is graded is whether the rows you get back are right.\n\n1. What is the total value of everything shipped? Count only orders whose status is shipped, and value an order as the sum of quantity times unit price across its items.\n\n2. Who are the three biggest customers by money spent, largest first? Ignore cancelled orders. Show the customer name and the amount.\n\n3. Which products have never appeared on any order?\n\n4. Which categories have an average product price above 20? Show the category and the average, rounded to two decimals.\n\n5. Which customers have never placed an order at all?',
    concepts: ['Joining three tables', 'Aggregating across a join', 'Filtering before and after grouping', 'Subqueries', 'Finding rows with no match'],
    hints: [],
    createState: () => sqlSite(),
    objectives: [
      { id: 'revenue', label: 'Total value of everything shipped', checks: [{ type: 'sql-answer', device: DB, sql: "SELECT sum(i.quantity * i.unit_price) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'shipped'", label: 'A query returned 865.5' }] },
      { id: 'top', label: 'The three biggest customers by spend', checks: [{ type: 'sql-answer', device: DB, ordered: true, sql: "SELECT c.name, sum(i.quantity * i.unit_price) FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items i ON i.order_id = o.id WHERE o.status <> 'cancelled' GROUP BY c.name ORDER BY sum(i.quantity * i.unit_price) DESC LIMIT 3", label: 'A query returned the top 3 spenders, largest first' }] },
      { id: 'unsold', label: 'Products that have never been ordered', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT name FROM products WHERE id NOT IN (SELECT product_id FROM order_items)', label: 'A query returned the 1 product nobody has bought' }] },
      { id: 'categories', label: 'Categories averaging more than 20', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT category, round(avg(price), 2) FROM products GROUP BY category HAVING avg(price) > 20', label: 'A query returned the 1 category above 20' }] },
      { id: 'quiet', label: 'Customers who have never ordered', checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL', label: 'A query returned the 1 customer with no orders' }] },
    ],
  },
  {
    id: 'db-20-exam-design-a-schema',
    moduleId: MODULE,
    order: 2,
    title: 'Exam: Design a Schema',
    difficulty: 'Advanced',
    estimatedMinutes: 22,
    isExam: true,
    description: 'Build two new tables with the right keys and constraints, fill them, prove the rules hold, and report on the result. No hints are available.',
    scenario:
      'The shop has taken a second unit and now needs to track where stock physically is. Build it.\n\nCreate warehouses with an id the database numbers itself and uses as the primary key, a short code that must be present and must be unique across the table, and a city that must be present.\n\nCreate stock_moves with its own generated primary key, a product_id that must be present and must refer to a real product, a warehouse_id that must be present and must refer to a real warehouse, the date the movement happened, and a quantity that must be present and must never be zero, since a movement of nothing is a mistake rather than a record.\n\nAdd two warehouses: LDN in London and BRS in Bristol. Then record three movements, all into LDN except the last: ten of product 1 on 2026-03-02, twenty-five of product 3 on the same day, and minus four of product 2 into BRS on 2026-03-03.\n\nNow prove the rules are real. Try to add a second warehouse with the code LDN. Try to record a movement of zero. Try to record a movement of product 999. All three must be refused.\n\nFinally, report the net quantity held in each warehouse, by code.',
    concepts: ['Choosing keys', 'UNIQUE and NOT NULL', 'CHECK constraints', 'Foreign keys across two tables', 'Aggregating a join'],
    hints: [],
    createState: () => sqlSite(),
    objectives: [
      {
        id: 'warehouses',
        label: 'Create the warehouses table',
        checks: [{ type: 'sql-table', device: DB, name: 'warehouses', columns: [{ name: 'id', type: 'integer', primaryKey: true }, { name: 'code', type: 'text', notNull: true, unique: true }, { name: 'city', type: 'text', notNull: true }], label: 'warehouses has a generated key, a unique code and a required city' }],
      },
      {
        id: 'moves',
        label: 'Create the stock_moves table',
        checks: [
          { type: 'sql-table', device: DB, name: 'stock_moves', columns: [{ name: 'id', type: 'integer', primaryKey: true }, { name: 'product_id', type: 'integer', notNull: true, references: 'products' }, { name: 'warehouse_id', type: 'integer', notNull: true, references: 'warehouses' }, { name: 'quantity', type: 'integer', notNull: true }], label: 'stock_moves points at both products and warehouses' },
          { type: 'sql-ran', device: DB, pattern: 'CHECK\\s*\\(', label: 'Added a CHECK on the quantity' },
        ],
      },
      {
        id: 'data',
        label: 'Fill both tables',
        checks: [
          { type: 'sql-query', device: DB, sql: 'SELECT code, city FROM warehouses ORDER BY code', rows: [['BRS', 'Bristol'], ['LDN', 'London']], label: 'Both warehouses are recorded' },
          { type: 'sql-query', device: DB, sql: 'SELECT product_id, warehouse_id, quantity FROM stock_moves ORDER BY id', rows: [[1, 1, 10], [3, 1, 25], [2, 2, -4]], label: 'All three movements are recorded' },
        ],
      },
      {
        id: 'rules',
        label: 'Prove all three rules refuse bad data',
        checks: [
          { type: 'shell-output', device: DB, pattern: 'duplicate key value violates unique constraint', label: 'A second LDN was refused' },
          { type: 'shell-output', device: DB, pattern: 'violates check constraint', label: 'A movement of zero was refused' },
          { type: 'shell-output', device: DB, pattern: 'violates foreign key constraint', label: 'A movement of product 999 was refused' },
          { type: 'sql-table', device: DB, name: 'stock_moves', rows: 3, label: 'and none of them were stored' },
        ],
      },
      {
        id: 'report',
        label: 'Report the net quantity in each warehouse',
        checks: [{ type: 'sql-answer', device: DB, sql: 'SELECT w.code, sum(m.quantity) FROM warehouses w JOIN stock_moves m ON m.warehouse_id = w.id GROUP BY w.code', label: 'A query returned 35 in LDN and -4 in BRS' }],
      },
    ],
  },
  {
    id: 'db-30-exam-clean-up-the-data',
    moduleId: MODULE,
    order: 3,
    title: 'Exam: Clean Up the Data',
    difficulty: 'Advanced',
    estimatedMinutes: 25,
    isExam: true,
    description: 'Take a contact list nobody constrained, work out what is wrong with it, fix it, and make the same mistakes impossible. No hints are available.',
    scenario:
      'The contacts table has been maintained by hand for two years by people in a hurry. It has seven rows, and almost everything that can be wrong with a table is wrong with this one: an address missing entirely, the same address entered twice under different spellings of the name, and a marketing preference recorded as yes, Yes, NO, no and nothing at all.\n\nWork through it in order.\n\nFirst, survey the damage. Find how many rows have no email address. Find which addresses appear more than once, and how many times.\n\nThen fix it. Delete the row with no email: without one it cannot be contacted and cannot be de-duplicated. Of the remaining duplicates, keep the earliest row for each address and delete the later ones. Put the marketing column into one shape: every value lowercase, and anything missing set to no.\n\nThen make it stay fixed. Email must be present and must be unique. Marketing must be present and must be one of exactly yes or no.\n\nFinally, prove the rules are real by trying to add a contact whose address is already in the table, and report what you are left with: how many contacts, and how many of them have opted in.',
    concepts: ['Surveying data quality', 'Deduplicating with min(id)', 'Normalising values with lower() and coalesce()', 'Adding constraints to existing data', 'Proving a constraint works'],
    hints: [],
    createState: () => sqlSite({ setup: shopWith(CONTACTS) }),
    objectives: [
      {
        id: 'survey',
        label: 'Survey what is wrong',
        checks: [
          { type: 'sql-answer', device: DB, rows: [[1]], label: 'A query counted the 1 row with no email' },
          { type: 'sql-answer', device: DB, rows: [['ada@example.com', 2], ['cleo@example.com', 2]], label: 'A query found the 2 repeated addresses' },
        ],
      },
      {
        id: 'dedupe',
        label: 'Remove the unreachable row and the later duplicates',
        checks: [
          { type: 'sql-table', device: DB, name: 'contacts', rows: 4, label: 'contacts is down to 4 rows' },
          { type: 'sql-query', device: DB, sql: 'SELECT id FROM contacts ORDER BY id', rows: [[1], [2], [4], [6]], label: 'and the ones kept are the earliest of each address' },
        ],
      },
      {
        id: 'normalise',
        label: 'Put the marketing column into one shape',
        checks: [{ type: 'sql-query', device: DB, sql: 'SELECT marketing, count(*) FROM contacts GROUP BY marketing', rows: [['no', 2], ['yes', 2]], label: 'Every row is now yes or no' }],
      },
      {
        id: 'constrain',
        label: 'Make the same mistakes impossible',
        checks: [
          { type: 'sql-table', device: DB, name: 'contacts', columns: [{ name: 'email', type: 'text', notNull: true, unique: true }, { name: 'marketing', type: 'text', notNull: true }], label: 'email is required and unique, marketing is required' },
          { type: 'sql-ran', device: DB, pattern: 'CHECK\\s*\\(', label: 'and a CHECK limits marketing to two values' },
        ],
      },
      {
        id: 'prove',
        label: 'Prove a repeated address is refused',
        checks: [
          { type: 'shell-output', device: DB, pattern: 'duplicate key value violates unique constraint', label: 'The duplicate was refused' },
          { type: 'sql-table', device: DB, name: 'contacts', rows: 4, label: 'and nothing was added' },
        ],
      },
      {
        id: 'report',
        label: 'Report what is left',
        checks: [
          { type: 'sql-answer', device: DB, sql: 'SELECT count(*) FROM contacts', label: 'A query counted the surviving contacts' },
          { type: 'sql-answer', device: DB, sql: "SELECT count(*) FROM contacts WHERE marketing = 'yes'", label: 'A query counted the ones who opted in' },
        ],
      },
    ],
  },
];
