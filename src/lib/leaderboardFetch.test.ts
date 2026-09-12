import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the fake server was asked for, so a test can assert which view was read and
 * how it was filtered without standing up a database.
 */
interface Ask {
  table: string;
  columns: string;
  orders: string[];
  filters: Record<string, string>;
  limit?: number;
}

const asks: Ask[] = [];
type Answer = unknown[] | { code?: string; message: string } | ((ask: Ask) => unknown[] | { code?: string; message: string });

/** Answers keyed by table name. An object with a message comes back as a Supabase error. */
let answers: Record<string, Answer> = {};

function builder(table: string) {
  const ask: Ask = { table, columns: '', orders: [], filters: {} };
  asks.push(ask);
  const result = () => {
    const raw = answers[table];
    const a = typeof raw === 'function' ? raw(ask) : raw;
    if (a && !Array.isArray(a)) return { data: null, error: a };
    let rows = (a ?? []) as Array<Record<string, unknown>>;
    for (const [k, v] of Object.entries(ask.filters)) rows = rows.filter((r) => r[k] === v);
    return { data: rows, error: null };
  };
  const chain = {
    select(columns: string) {
      ask.columns = columns;
      return chain;
    },
    order(col: string) {
      ask.orders.push(col);
      return chain;
    },
    limit(n: number) {
      ask.limit = n;
      return chain;
    },
    eq(col: string, value: string) {
      ask.filters[col] = value;
      return chain;
    },
    then(onFulfilled: (v: ReturnType<typeof result>) => unknown) {
      return Promise.resolve(result()).then(onFulfilled);
    },
  };
  return chain;
}

vi.mock('./supabase', () => ({
  supabase: { from: (table: string) => builder(table) },
  accountsEnabled: true,
}));

const { fetchLeaderboard } = await import('./leaderboard');

const row = (name: string, path: string, points: number) => ({
  user_id: name,
  display_name: name,
  path,
  total_points: points,
  total_stars: 3,
  labs_passed: 1,
  last_completed: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  asks.length = 0;
  answers = {
    leaderboard: [row('ada', 'all', 1200), row('bo', 'all', 400)],
    leaderboard_by_path: [row('ada', 'ccna', 900), row('bo', 'ccna', 400), row('ada', 'sql', 300)],
  };
});

describe('which board is read', () => {
  it('reads the combined view when no path is asked for', async () => {
    const r = await fetchLeaderboard(50);
    expect(asks[0].table).toBe('leaderboard');
    expect(asks[0].filters).toEqual({});
    expect(r.scope).toBe('all');
    expect(r.entries.map((e) => e.displayName)).toEqual(['ada', 'bo']);
  });

  it('reads the per-path view and filters it when one is', async () => {
    const r = await fetchLeaderboard(50, 'sql');
    expect(asks[0].table).toBe('leaderboard_by_path');
    expect(asks[0].filters).toEqual({ path: 'sql' });
    expect(r.scope).toBe('sql');
    // Only the rows for that path come back, with the totals for that path.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].totalPoints).toBe(300);
  });

  it('orders by points and passes the limit through', async () => {
    await fetchLeaderboard(10, 'ccna');
    expect(asks[0].orders[0]).toBe('total_points');
    expect(asks[0].limit).toBe(10);
  });
});

describe('a database that cannot do everything asked of it', () => {
  it('falls back to the combined board when the per-path view is missing', async () => {
    answers.leaderboard_by_path = { code: '42P01', message: 'relation "public.leaderboard_by_path" does not exist' };
    const r = await fetchLeaderboard(50, 'linux');
    expect(r.scope).toBe('all');
    // The page needs to know the request could not be honoured so it can say so.
    expect(r.wantedPath).toBe('linux');
    expect(r.entries.map((e) => e.displayName)).toEqual(['ada', 'bo']);
    expect(asks.map((a) => a.table)).toEqual(['leaderboard_by_path', 'leaderboard']);
  });

  it('still ranks by stars when the points column is missing', async () => {
    // The column is missing, so only the query that asks for it fails.
    answers.leaderboard = (ask) => (ask.columns.includes('total_points') ? { code: '42703', message: 'column leaderboard.total_points does not exist' } : [row('ada', 'all', 0)]);
    const r = await fetchLeaderboard(50);
    expect(r.rankedBy).toBe('stars');
    expect(asks[1].columns).not.toContain('total_points');
  });

  it('reports any other failure rather than hiding it', async () => {
    answers.leaderboard = { code: '500', message: 'the server is on fire' };
    await expect(fetchLeaderboard(50)).rejects.toThrow('the server is on fire');
  });
});
