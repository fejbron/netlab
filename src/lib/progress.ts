export interface LabProgress {
  score: number;
  /** 0-3 */
  stars: number;
  completedAt: string;
}

const KEY = 'netlab-progress-v1';

export type ProgressMap = Record<string, LabProgress>;

/** True when `next` is a better attempt than `prev` (more stars, then higher score). */
export function isBetter(prev: LabProgress | undefined, next: LabProgress): boolean {
  return !prev || next.stars > prev.stars || (next.stars === prev.stars && next.score > prev.score);
}

/** Union of two progress maps keeping the best attempt per lab. Pure. */
export function mergeProgress(a: ProgressMap, b: ProgressMap): ProgressMap {
  const out: ProgressMap = { ...a };
  for (const [labId, p] of Object.entries(b)) if (isBetter(out[labId], p)) out[labId] = p;
  return out;
}

export function loadProgress(): ProgressMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

export function saveProgress(all: ProgressMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function saveLabProgress(labId: string, progress: LabProgress): ProgressMap {
  const all = loadProgress();
  if (isBetter(all[labId], progress)) all[labId] = progress;
  saveProgress(all);
  return all;
}

export function resetProgress() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem('netlab-unlock-all');
    for (const key of Object.keys(localStorage)) if (key.startsWith('netlab-session-')) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
