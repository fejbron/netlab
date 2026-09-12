import { describe, expect, it } from 'vitest';
import { buildNetwork, createSwitch, executeHost, hostPrompt, type NetworkState } from './index';
import { evaluateCheck, type Check } from './grader';

const SETUP = `
CREATE TABLE staff (id serial PRIMARY KEY, name text NOT NULL, team text, salary numeric);
INSERT INTO staff (name, team, salary) VALUES ('Ada', 'ops', 40000), ('Bo', 'dev', 52000);
`;

function site(): NetworkState {
  return buildNetwork({
    primary: 'db1',
    devices: [createSwitch({ hostname: 'SW1', ports: 4 })],
    hosts: [{ id: 'db1', ip: '192.168.1.60', mask: '255.255.255.0', linux: { hostname: 'db1', databases: { hr: { setup: SETUP } } } }],
    links: [['db1', 'SW1:g0/1']],
  });
}

/** Type lines at db1 and collect what the terminal showed. */
function type(net: NetworkState, ...lines: string[]): { net: NetworkState; out: string[] } {
  let out: string[] = [];
  let n = net;
  for (const line of lines) {
    const r = executeHost(n, 'db1', line);
    n = r.network;
    out = [...out, ...r.output];
  }
  return { net: n, out };
}

describe('reaching a database from the shell', () => {
  it('installs the server and its databases when a lab asks for one', () => {
    const lx = site().hosts.db1.linux!;
    expect(lx.packages).toContain('postgresql');
    expect(lx.services.postgresql.active).toBe(true);
    expect(Object.keys(lx.databases!)).toEqual(['hr']);
    expect(lx.databases!.hr.db.tables.staff.rows).toHaveLength(2);
  });

  it('opens psql, runs a query, and comes back to the shell on \\q', () => {
    let net = site();
    expect(hostPrompt(net.hosts.db1)).toBe('student@db1:~$ ');

    const opened = type(net, 'psql hr');
    net = opened.net;
    expect(opened.out.join('\n')).toContain('psql (16.2');
    // The prompt is now the database's, not the shell's.
    expect(hostPrompt(net.hosts.db1)).toBe('hr=# ');

    const queried = type(net, 'SELECT name FROM staff ORDER BY name;');
    net = queried.net;
    expect(queried.out.join('\n')).toContain('Ada');
    expect(queried.out.join('\n')).toContain('(2 rows)');

    const quit = type(net, '\\q');
    net = quit.net;
    expect(hostPrompt(net.hosts.db1)).toBe('student@db1:~$ ');
    // Back in the shell, shell commands work again.
    expect(type(net, 'whoami').out.join('\n')).toContain('student');
  });

  it('shows a continuation prompt until the statement is finished', () => {
    let net = type(site(), 'psql hr').net;
    net = type(net, 'SELECT name').net;
    expect(hostPrompt(net.hosts.db1)).toBe('hr-# ');
    const done = type(net, 'FROM staff;');
    expect(done.out.join('\n')).toContain('Ada');
    expect(hostPrompt(done.net.hosts.db1)).toBe('hr=# ');
  });

  it('runs one statement without a session when given -c', () => {
    const r = type(site(), "psql hr -c 'SELECT count(*) FROM staff'");
    expect(r.out.join('\n')).toContain('(1 row)');
    // No session was opened, so the shell prompt is unchanged.
    expect(hostPrompt(r.net.hosts.db1)).toBe('student@db1:~$ ');
  });

  it('refuses to connect when the server is stopped', () => {
    let net = site();
    net = type(net, 'sudo systemctl stop postgresql').net;
    expect(type(net, 'psql hr').out.join('\n')).toContain('Connection refused');
  });

  it('says so when the database is not there', () => {
    expect(type(site(), 'psql payroll').out.join('\n')).toContain('database "payroll" does not exist');
  });

  it('does not count a statement the server refused as one the learner ran', () => {
    let net = type(site(), 'psql hr').net;
    net = type(net, 'SELECT nope FROM staff;').net;
    expect(net.hosts.db1.linux!.databases!.hr.ran).toEqual([]);
    expect(net.hosts.db1.acceptedHistory).not.toContain('SELECT nope FROM staff;');
    net = type(net, 'SELECT name FROM staff;').net;
    expect(net.hosts.db1.linux!.databases!.hr.ran).toEqual(['SELECT name FROM staff']);
  });
});

describe('grading a database', () => {
  const check = (net: NetworkState, c: Check) => evaluateCheck({ device: 'db1', ...c } as Check, net);

  it('reads the shape of a table', () => {
    const net = site();
    expect(check(net, { type: 'sql-table', name: 'staff', rows: 2 })).toBe(true);
    expect(check(net, { type: 'sql-table', name: 'staff', columns: [{ name: 'id', primaryKey: true }, { name: 'name', notNull: true }] })).toBe(true);
    expect(check(net, { type: 'sql-table', name: 'staff', columns: [{ name: 'team', notNull: true }] })).toBe(false);
    expect(check(net, { type: 'sql-table', name: 'payroll', exists: false })).toBe(true);
  });

  it('runs its own query against the learner’s data', () => {
    let net = site();
    expect(check(net, { type: 'sql-query', sql: 'SELECT count(*) FROM staff', rows: [[2]] })).toBe(true);
    net = type(net, 'psql hr', "INSERT INTO staff (name, team, salary) VALUES ('Cleo', 'dev', 45000);").net;
    expect(check(net, { type: 'sql-query', sql: 'SELECT count(*) FROM staff', rows: [[3]] })).toBe(true);
    expect(check(net, { type: 'sql-query', sql: "SELECT name FROM staff WHERE team = 'dev' ORDER BY name", rows: [['Bo'], ['Cleo']] })).toBe(true);
    // 45000 and 45000.00 are the same answer.
    expect(check(net, { type: 'sql-query', sql: "SELECT salary FROM staff WHERE name = 'Cleo'", rows: [[45000.0]] })).toBe(true);
  });

  it('sees what the learner ran and what came back', () => {
    const net = type(site(), 'psql hr', 'SELECT name, team FROM staff ORDER BY name;').net;
    expect(check(net, { type: 'sql-ran', pattern: '^SELECT .*FROM staff' })).toBe(true);
    expect(check(net, { type: 'sql-ran', pattern: 'DELETE' })).toBe(false);
    expect(check(net, { type: 'sql-result', rows: 2, columns: ['name', 'team'] })).toBe(true);
    expect(check(net, { type: 'sql-result', contains: 'Ada' })).toBe(true);
    expect(check(net, { type: 'sql-result', contains: 'Zoe' })).toBe(false);
  });

  it('sees new indexes and views', () => {
    let net = type(site(), 'psql hr').net;
    expect(check(net, { type: 'sql-index', table: 'staff', column: 'team' })).toBe(false);
    net = type(net, 'CREATE INDEX staff_team_idx ON staff (team);', 'CREATE VIEW dev_team AS SELECT * FROM staff WHERE team = \'dev\';').net;
    expect(check(net, { type: 'sql-index', table: 'staff', column: 'team' })).toBe(true);
    expect(check(net, { type: 'sql-view', name: 'dev_team' })).toBe(true);
  });
});
