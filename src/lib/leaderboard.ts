import { supabase } from './supabase';

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  /** What the learner's passes are worth; see lib/points.ts. */
  totalPoints: number;
  totalStars: number;
  labsPassed: number;
  lastCompleted: string | null;
}

export interface RankedEntry extends LeaderboardEntry {
  /** 1-based rank; learners with equal totals and labs share a rank. */
  rank: number;
}

/**
 * How the board is ordered. A database that predates the points column still totals
 * stars, so the page falls back to those rather than failing.
 */
export type RankedBy = 'points' | 'stars';

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  rankedBy: RankedBy;
  /** The path this board covers, or 'all' when every path counts towards one ranking. */
  scope: string;
  /** Set when a path board was asked for and the database could not provide one. */
  wantedPath?: string;
}

const total = (e: LeaderboardEntry, by: RankedBy) => (by === 'points' ? e.totalPoints : e.totalStars);

export interface Profile {
  id: string;
  displayName: string;
  showOnLeaderboard: boolean;
}

/** Assign competition ranks ("1, 2, 2, 4") to entries already sorted by the server. Pure. */
export function rankEntries(entries: LeaderboardEntry[], rankedBy: RankedBy = 'points'): RankedEntry[] {
  const out: RankedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const prev = out[i - 1];
    const tie = prev && total(prev, rankedBy) === total(entries[i], rankedBy) && prev.labsPassed === entries[i].labsPassed;
    out.push({ ...entries[i], rank: tie ? prev.rank : i + 1 });
  }
  return out;
}

/** Sort the way the server view does: the ranking total, then labs passed, then who got there first. Pure. */
export function sortEntries(entries: LeaderboardEntry[], rankedBy: RankedBy = 'points'): LeaderboardEntry[] {
  return [...entries].sort((a, b) => total(b, rankedBy) - total(a, rankedBy) || b.labsPassed - a.labsPassed || (a.lastCompleted ?? '').localeCompare(b.lastCompleted ?? ''));
}

interface Row {
  user_id: string;
  display_name: string;
  total_points?: number;
  total_stars: number;
  labs_passed: number;
  last_completed: string | null;
}

function toEntry(r: Row): LeaderboardEntry {
  return { userId: r.user_id, displayName: r.display_name, totalPoints: r.total_points ?? 0, totalStars: r.total_stars, labsPassed: r.labs_passed, lastCompleted: r.last_completed ?? null };
}

/** The database has not had supabase/schema.sql re-applied since points were added. */
function missingPointsColumn(error: { code?: string; message?: string }): boolean {
  return error.code === '42703' || /total_points/.test(error.message ?? '');
}

/** The per-path view does not exist yet, so the schema predates path boards. */
function missingPathView(error: { code?: string; message?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205' || /leaderboard_by_path/.test(error.message ?? '');
}

/**
 * One board. `path` narrows it to a single learning path; without it every path counts
 * towards one combined ranking.
 *
 * A database that predates either change still works: one without the per-path view
 * falls back to the combined board, and one without points ranks by stars.
 */
export async function fetchLeaderboard(limit = 50, path?: string): Promise<LeaderboardResult> {
  if (!supabase) return { entries: [], rankedBy: 'points', scope: path ?? 'all' };
  const query = (columns: string, order: string) => {
    const q = supabase!
      .from(path ? 'leaderboard_by_path' : 'leaderboard')
      .select(columns)
      .order(order, { ascending: false })
      .order('labs_passed', { ascending: false })
      .order('last_completed', { ascending: true })
      .limit(limit);
    return path ? q.eq('path', path) : q;
  };

  const { data, error } = await query('user_id, display_name, total_points, total_stars, labs_passed, last_completed', 'total_points');
  if (!error) return { entries: (data as unknown as Row[]).map(toEntry), rankedBy: 'points', scope: path ?? 'all' };

  // The per-path board needs a view an older schema does not have; fall back to the
  // combined one rather than showing the learner an error they cannot act on.
  if (path && missingPathView(error)) {
    const combined = await fetchLeaderboard(limit);
    return { ...combined, scope: 'all', wantedPath: path };
  }
  if (!missingPointsColumn(error)) throw new Error(error.message);

  // Older database: rank by stars so the board still works until the schema is re-applied.
  const legacy = await query('user_id, display_name, total_stars, labs_passed, last_completed', 'total_stars');
  if (legacy.error) throw new Error(legacy.error.message);
  return { entries: (legacy.data as unknown as Row[]).map(toEntry), rankedBy: 'stars', scope: path ?? 'all' };
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('profiles').select('id, display_name, show_on_leaderboard').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: data.id as string, displayName: data.display_name as string, showOnLeaderboard: data.show_on_leaderboard as boolean } : null;
}

export async function updateProfile(userId: string, patch: Partial<Pick<Profile, 'displayName' | 'showOnLeaderboard'>>): Promise<void> {
  if (!supabase) return;
  const row: Record<string, unknown> = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.showOnLeaderboard !== undefined) row.show_on_leaderboard = patch.showOnLeaderboard;
  const { error } = await supabase.from('profiles').upsert({ id: userId, ...row }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}
