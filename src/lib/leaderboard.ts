import { supabase } from './supabase';

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  totalStars: number;
  labsPassed: number;
  lastCompleted: string | null;
}

export interface RankedEntry extends LeaderboardEntry {
  /** 1-based rank; learners with equal stars and labs share a rank. */
  rank: number;
}

export interface Profile {
  id: string;
  displayName: string;
  showOnLeaderboard: boolean;
}

/** Assign competition ranks ("1, 2, 2, 4") to entries already sorted by the server. Pure. */
export function rankEntries(entries: LeaderboardEntry[]): RankedEntry[] {
  const out: RankedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const prev = out[i - 1];
    const tie = prev && prev.totalStars === entries[i].totalStars && prev.labsPassed === entries[i].labsPassed;
    out.push({ ...entries[i], rank: tie ? prev.rank : i + 1 });
  }
  return out;
}

/** Sort the way the server view does: stars, then labs passed, then who got there first. Pure. */
export function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => b.totalStars - a.totalStars || b.labsPassed - a.labsPassed || (a.lastCompleted ?? '').localeCompare(b.lastCompleted ?? ''));
}

export async function fetchLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('leaderboard')
    .select('user_id, display_name, total_stars, labs_passed, last_completed')
    .order('total_stars', { ascending: false })
    .order('labs_passed', { ascending: false })
    .order('last_completed', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ userId: r.user_id as string, displayName: r.display_name as string, totalStars: r.total_stars as number, labsPassed: r.labs_passed as number, lastCompleted: (r.last_completed as string | null) ?? null }));
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
