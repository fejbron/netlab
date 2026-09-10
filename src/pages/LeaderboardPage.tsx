import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import { labs } from '../content';
import { useAuth } from '../lib/auth';
import { fetchLeaderboard, rankEntries, type RankedEntry } from '../lib/leaderboard';

const MAX_STARS = labs.length * 3;

function Stars({ n }: { n: number }) {
  return (
    <span className="text-warning" title={`${n} stars`}>
      ★ {n}
    </span>
  );
}

export default function LeaderboardPage() {
  const auth = useAuth();
  const [entries, setEntries] = useState<RankedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.enabled) return;
    let cancelled = false;
    fetchLeaderboard(50)
      .then((rows) => {
        if (!cancelled) setEntries(rankEntries(rows));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [auth.enabled]);

  const me = auth.user?.id;
  const mine = entries?.find((e) => e.userId === me);

  return (
    <div className="flex h-full flex-col">
      <Header>
        <Link to="/" className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg">
          ← Labs
        </Link>
        <AccountMenu />
      </Header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-8">
        <h1 className="display text-4xl text-fg-bright">Leaderboard</h1>
        <p className="mt-2 text-sm text-muted">
          Top learners by stars. Every lab is worth up to three stars: three for passing without hints, two with some hints, one after using them all. {labs.length} labs, {MAX_STARS} stars in total.
        </p>

        {!auth.enabled ? (
          <section className="mt-6 rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            This copy of NetLab runs in guest mode, so there is no shared leaderboard. The site operator can enable accounts with a Supabase project (see the README).
          </section>
        ) : error ? (
          <p className="mt-6 text-sm text-danger">Could not load the leaderboard: {error}</p>
        ) : entries === null ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <section className="mt-6 rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            Nobody is on the board yet. Pass a lab while signed in to claim the top spot.
          </section>
        ) : (
          <>
            {auth.user && !mine && (
              <p className="mt-4 text-xs text-muted">
                You are not on the board yet. Pass a lab while signed in, or check the leaderboard setting on your{' '}
                <Link to="/account" className="text-accent hover:underline">
                  account page
                </Link>
                .
              </p>
            )}
            <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2">#</th>
                    <th className="px-4 py-2">Learner</th>
                    <th className="px-4 py-2 text-right">Stars</th>
                    <th className="px-4 py-2 text-right">Labs passed</th>
                    <th className="hidden px-4 py-2 text-right sm:table-cell">Last pass</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const isMe = e.userId === me;
                    return (
                      <tr key={e.userId} className={`border-b border-border/60 last:border-b-0 ${isMe ? 'bg-accent-soft' : ''}`}>
                        <td className="px-4 py-2 text-muted">{e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : e.rank}</td>
                        <td className="px-4 py-2 text-fg-bright">
                          {e.displayName}
                          {isMe && <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase text-accent">you</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Stars n={e.totalStars} />
                        </td>
                        <td className="px-4 py-2 text-right text-muted">
                          {e.labsPassed}
                          <span className="text-xs"> / {labs.length}</span>
                        </td>
                        <td className="hidden px-4 py-2 text-right text-muted sm:table-cell">{e.lastCompleted ? new Date(e.lastCompleted).toLocaleDateString() : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!auth.user && (
              <p className="mt-4 text-xs text-muted">
                <Link to="/account" className="text-accent hover:underline">
                  Sign in
                </Link>{' '}
                to see where you stand.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
