export interface LabProgress {
  score: number;
  /** 0-3 */
  stars: number;
  completedAt: string;
}

const KEY = 'netlab-progress-v1';

export type ProgressMap = Record<string, LabProgress>;

export function loadProgress(): ProgressMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

export function saveLabProgress(labId: string, progress: LabProgress): ProgressMap {
  const all = loadProgress();
  const prev = all[labId];
  // Keep the best attempt.
  if (!prev || progress.stars > prev.stars || (progress.stars === prev.stars && progress.score > prev.score)) {
    all[labId] = progress;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  return all;
}

const UNLOCK_KEY = 'netlab-unlock-all';

/** Practice mode: ignore the sequential unlock and open every lab. */
export function loadUnlockAll(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveUnlockAll(value: boolean) {
  try {
    if (value) localStorage.setItem(UNLOCK_KEY, '1');
    else localStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function resetProgress() {
  try {
    localStorage.removeItem(KEY);
    for (const key of Object.keys(localStorage)) if (key.startsWith('netlab-session-')) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
