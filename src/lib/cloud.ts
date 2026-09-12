import { getLab, pathIdOfLab } from '../content';
import { supabase } from './supabase';
import { labPoints } from './points';
import type { LabProgress, ProgressMap } from './progress';

/** Row shape of the public.lab_progress table (see supabase/schema.sql). */
interface ProgressRow {
  lab_id: string;
  score: number;
  stars: number;
  completed_at: string;
}

/**
 * Points and the path are both derived from the lab, but they are stored with the row:
 * the leaderboard totals and groups them in SQL, where the lab catalogue is not
 * available. A lab id the catalogue no longer knows keeps its row and simply scores
 * nothing and belongs to no path.
 */
function toRow(userId: string, labId: string, p: LabProgress) {
  const lab = getLab(labId);
  return {
    user_id: userId,
    lab_id: labId,
    score: p.score,
    stars: p.stars,
    points: lab ? labPoints(lab, p.stars) : 0,
    path: lab ? pathIdOfLab(lab) : null,
    completed_at: p.completedAt,
  };
}

/** Every lab the signed-in learner has passed, as stored on the server. */
export async function fetchCloudProgress(userId: string): Promise<ProgressMap> {
  if (!supabase) return {};
  const { data, error } = await supabase.from('lab_progress').select('lab_id, score, stars, completed_at').eq('user_id', userId);
  if (error) throw new Error(error.message);
  const map: ProgressMap = {};
  for (const row of (data ?? []) as ProgressRow[]) map[row.lab_id] = { score: row.score, stars: row.stars, completedAt: row.completed_at };
  return map;
}

/** Insert or replace the rows for the given labs. */
export async function pushCloudProgress(userId: string, progress: ProgressMap, labIds: string[] = Object.keys(progress)): Promise<void> {
  if (!supabase || labIds.length === 0) return;
  const rows = labIds.map((id) => toRow(userId, id, progress[id]));
  const { error } = await supabase.from('lab_progress').upsert(rows, { onConflict: 'user_id,lab_id' });
  if (error) throw new Error(error.message);
}

export async function clearCloudProgress(userId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('lab_progress').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}
