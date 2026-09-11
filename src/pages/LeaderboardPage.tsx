import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import Icon, { NF } from '../components/Icon';
import { labs } from '../content';
import { useAuth } from '../lib/auth';
import { fetchLeaderboard, rankEntries, type RankedBy, type RankedEntry } from '../lib/leaderboard';
import { DIFFICULTY_POINTS, EXAM_MULTIPLIER, formatPoints, maxTotalPoints } from '../lib/points';

const MAX_POINTS = maxTotalPoints(labs);

function Rank({ n }: { n: number }) {
  if (n === 1) return <Icon g={NF.trophy} className="text-star" label="1st" />;
  if (n === 2) return <Icon g={NF.trophy} className="text-fg" label="2nd" />;
  if (n === 3) return <Icon g={NF.trophy} className="text-warning" label="3rd" />;
  return <span className="font-mono text-muted">{n}</span>;
}

export default function LeaderboardPage() {
  const auth = useAuth();
  const [entries, setEntries] = useState<RankedEntry[] | null>(null);
  const [rankedBy, setRankedBy] = useState<RankedBy>('points');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.enabled) return;
    let cancelled = false;
    fetchLeaderboard(50)
      .then((r) => {
        if (cancelled) return;
        setRankedBy(r.rankedBy);
        setEntries(rankEntries(r.entries, r.rankedBy));
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
        <AccountMenu />
      </Header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 pb-16 pt-10">
        <p className="label text-accent">
          <Icon g={NF.trophy} className="mr-1.5" />
          Top learners
        </p>
        <h1 className="display mt-2 text-4xl text-fg-bright">Leaderboard</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          {rankedBy === 'points' ? (
            <>
              Ranked by points. A lab is worth {DIFFICULTY_POINTS.Beginner} points at Beginner, {DIFFICULTY_POINTS.Intermediate} at Intermediate and {DIFFICULTY_POINTS.Advanced} at Advanced, and an exam counts {EXAM_MULTIPLIER === 2 ? 'double' : `${EXAM_MULTIPLIER} times`}. You keep the full value for a pass without hints, 70% with some hints and 40% after using them all. {labs.length} labs, {formatPoints(MAX_POINTS)} points in total.
            </>
          ) : (
            <>Ranked by stars. Each lab is worth up to three: three for passing without hints, two with some hints, one after using them all. {labs.length} labs, {labs.length * 3} stars in total.</>
          )}
        </p>
        {rankedBy === 'stars' && (
          <p className="mt-3 rounded-xl border border-border bg-surface px-4 py-3 text-xs leading-5 text-muted">
            <Icon g={NF.warning} className="mr-1.5 text-warning" />
            This site's database still totals stars, so the board is ranked by those for now. The operator can re-apply <code className="font-mono text-fg">supabase/schema.sql</code> to rank by points.
          </p>
        )}

        {!auth.enabled ? (
          <section className="card mt-6 p-6 text-sm text-muted">This copy of NetLab runs in guest mode, so there is no shared leaderboard. The site operator can enable accounts with a Supabase project (see the README).</section>
        ) : error ? (
          <p className="mt-6 text-sm text-danger">
            <Icon g={NF.warning} className="mr-1.5" />
            Could not load the leaderboard: {error}
          </p>
        ) : entries === null ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <section className="card mt-6 p-6 text-sm text-muted">Nobody is on the board yet. Pass a lab while signed in to claim the top spot.</section>
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
            <div className="card mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="label text-left text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2.5 font-normal">#</th>
                    <th className="px-4 py-2.5 font-normal">Learner</th>
                    {rankedBy === 'points' && <th className="px-4 py-2.5 text-right font-normal">Points</th>}
                    <th className={`px-4 py-2.5 text-right font-normal ${rankedBy === 'points' ? 'hidden sm:table-cell' : ''}`}>Stars</th>
                    <th className="px-4 py-2.5 text-right font-normal">Labs</th>
                    <th className="hidden px-4 py-2.5 text-right font-normal sm:table-cell">Last pass</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const isMe = e.userId === me;
                    return (
                      <tr key={e.userId} className={`border-b border-border/60 last:border-b-0 ${isMe ? 'bg-accent-soft' : ''}`}>
                        <td className="px-4 py-2.5 text-center">
                          <Rank n={e.rank} />
                        </td>
                        <td className="px-4 py-2.5 font-medium text-fg-bright">
                          {e.displayName}
                          {isMe && <span className="pill ml-2 border-accent/40 text-accent">you</span>}
                        </td>
                        {rankedBy === 'points' && <td className="px-4 py-2.5 text-right font-mono font-bold text-fg-bright">{formatPoints(e.totalPoints)}</td>}
                        <td className={`px-4 py-2.5 text-right font-mono text-star ${rankedBy === 'points' ? 'hidden sm:table-cell' : ''}`}>
                          <Icon g={NF.star} className="mr-1 text-[11px]" />
                          {e.totalStars}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted">
                          {e.labsPassed}
                          <span className="text-xs">/{labs.length}</span>
                        </td>
                        <td className="hidden px-4 py-2.5 text-right font-mono text-xs text-muted sm:table-cell">{e.lastCompleted ? new Date(e.lastCompleted).toLocaleDateString() : '—'}</td>
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
