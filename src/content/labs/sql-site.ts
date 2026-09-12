import { buildNetwork, createRouter, createSwitch, type LinuxSpec, type NetworkState } from '../../engine';

/**
 * The database every SQL lab works against: a small coffee-equipment shop.
 *
 * It is deliberately tiny so that a learner can print any table in full and check an
 * answer by eye, while still carrying the awkward cases the labs need: a customer with
 * no city, a customer who has never ordered, a product nobody has bought, an order that
 * was cancelled, and prices that do not divide neatly.
 */
export const SHOP_SCHEMA = `
CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text,
  email text,
  joined date NOT NULL
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  price numeric NOT NULL CHECK (price >= 0),
  stock integer NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  placed date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric NOT NULL
);
`;

export const SHOP_DATA = `
INSERT INTO customers (name, city, email, joined) VALUES
  ('Ada Lovelace', 'London', 'ada@example.com', '2025-02-11'),
  ('Bo Nilsson', 'Leeds', 'bo@example.com', '2025-03-04'),
  ('Cleo Marsh', 'London', NULL, '2025-04-09'),
  ('Dev Patel', 'Bristol', 'dev@example.com', '2025-06-21'),
  ('Eve Okafor', 'Leeds', 'eve@example.com', '2025-09-30'),
  ('Finn Doyle', NULL, 'finn@example.com', '2026-01-14');

INSERT INTO products (sku, name, category, price, stock) VALUES
  ('ESP-100', 'Espresso Machine', 'appliances', 249.00, 4),
  ('GRN-200', 'Burr Grinder', 'appliances', 89.50, 11),
  ('BEA-300', 'Ethiopia Beans 1kg', 'coffee', 22.00, 40),
  ('BEA-301', 'Brazil Beans 1kg', 'coffee', 18.50, 25),
  ('CUP-400', 'Flat White Cup', 'tableware', 6.00, 120),
  ('CUP-401', 'Espresso Cup', 'tableware', 4.50, 90),
  ('FLT-500', 'Paper Filters 100', 'coffee', 5.25, 0),
  ('SCA-600', 'Bench Scale', 'appliances', 34.00, 7);

INSERT INTO orders (customer_id, placed, status) VALUES
  (1, '2026-01-05', 'shipped'),
  (1, '2026-02-11', 'shipped'),
  (2, '2026-01-19', 'shipped'),
  (2, '2026-03-01', 'pending'),
  (3, '2026-02-02', 'pending'),
  (4, '2026-02-14', 'shipped'),
  (4, '2026-02-27', 'cancelled'),
  (5, '2026-02-20', 'shipped');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 249.00),
  (1, 3, 2, 22.00),
  (2, 3, 1, 22.00),
  (2, 5, 4, 6.00),
  (3, 2, 1, 89.50),
  (3, 4, 3, 18.50),
  (4, 6, 6, 4.50),
  (5, 3, 1, 22.00),
  (5, 4, 1, 18.50),
  (6, 1, 1, 249.00),
  (6, 2, 1, 89.50),
  (7, 5, 2, 6.00),
  (8, 8, 1, 34.00),
  (8, 6, 2, 4.50);
`;

/** The standard shop, plus whatever else a lab needs in place before it starts. */
export function shopWith(extra: string): string {
  return SHOP_SCHEMA + SHOP_DATA + extra;
}

/**
 * A second, unfamiliar database for the lab about reading a schema you did not write:
 * a lending library, with one book nobody has ever borrowed and two loans still open.
 */
export const LIBRARY = `
CREATE TABLE members (
  id serial PRIMARY KEY,
  name text NOT NULL,
  joined date NOT NULL
);

CREATE TABLE books (
  id serial PRIMARY KEY,
  isbn text NOT NULL UNIQUE,
  title text NOT NULL,
  author text NOT NULL,
  published integer NOT NULL
);

CREATE TABLE loans (
  id serial PRIMARY KEY,
  book_id integer NOT NULL REFERENCES books (id),
  member_id integer NOT NULL REFERENCES members (id),
  taken date NOT NULL,
  returned date
);

INSERT INTO members (name, joined) VALUES
  ('Hana Ito', '2024-09-02'),
  ('Ivan Petrov', '2025-01-20'),
  ('Joy Adeyemi', '2025-11-11');

INSERT INTO books (isbn, title, author, published) VALUES
  ('978-0132350884', 'Clean Code', 'Robert C. Martin', 2008),
  ('978-0201616224', 'The Pragmatic Programmer', 'Andrew Hunt', 1999),
  ('978-1449373320', 'Designing Data-Intensive Applications', 'Martin Kleppmann', 2017),
  ('978-0596007126', 'Head First Design Patterns', 'Eric Freeman', 2004);

INSERT INTO loans (book_id, member_id, taken, returned) VALUES
  (1, 1, '2026-01-08', '2026-01-29'),
  (2, 1, '2026-02-03', NULL),
  (1, 2, '2026-02-10', '2026-02-24'),
  (3, 3, '2026-02-18', NULL),
  (2, 3, '2025-12-01', '2025-12-20');
`;

export interface SqlSiteOptions {
  /** SQL that builds the starting database. Defaults to the full shop. */
  setup?: string;
  /** Database name, which is also what the psql prompt shows. */
  database?: string;
  /** Start at the shell instead of already connected. */
  atShell?: boolean;
  /** Extra Linux settings, for the labs that also touch the server. */
  linux?: LinuxSpec;
}

/**
 * db1 (192.168.1.60) runs PostgreSQL, with PC-A alongside it behind R1, so the
 * networking labs' topology is recognisable to anyone arriving from another path.
 */
export function sqlSite(opts: SqlSiteOptions = {}): NetworkState {
  const database = opts.database ?? 'shop';
  const setup = opts.setup ?? SHOP_SCHEMA + SHOP_DATA;
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'Office LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false } },
  });
  const sw = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'db1' }, 'g0/2': { description: 'PC-A' }, 'g0/8': { description: 'Uplink to R1' } } });
  const net = buildNetwork({
    primary: 'db1',
    devices: [r1, sw],
    hosts: [
      { id: 'db1', ip: '192.168.1.60', mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server', linux: { hostname: 'db1', ...opts.linux, databases: { [database]: { setup } } } },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
    ],
    links: [['db1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0']],
  });
  // Most labs are about SQL rather than Linux, so the terminal opens at the psql prompt.
  if (!opts.atShell) net.hosts.db1.linux!.pending = { kind: 'sql', db: database };
  return net;
}

/** The host every SQL check looks at. */
export const DB = 'db1';
