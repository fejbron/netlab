import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import { clearCloudProgress, fetchCloudProgress, pushCloudProgress } from './cloud';
import { isBetter, loadProgress, mergeProgress, resetProgress, saveProgress, type LabProgress, type ProgressMap } from './progress';

export type SyncState = 'local' | 'syncing' | 'synced' | 'error';

export interface ProgressStore {
  progress: ProgressMap;
  /** Where progress lives right now: this device only, or synced with the learner's account. */
  sync: SyncState;
  syncError: string | null;
  /** Record a passed lab. Keeps the best attempt locally and, when signed in, on the server. */
  recordPass(labId: string, p: LabProgress): void;
  /** Wipe local progress and saved sessions, and the account's server-side progress when signed in. */
  reset(): Promise<void>;
}

const ProgressContext = createContext<ProgressStore | null>(null);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [progress, setProgress] = useState<ProgressMap>(loadProgress);
  const [sync, setSync] = useState<SyncState>('local');
  const [syncError, setSyncError] = useState<string | null>(null);
  const userId = user?.id ?? null;
  const latest = useRef(progress);
  latest.current = progress;

  // On sign-in: merge what this device knows with what the account knows, then bring both up to date.
  useEffect(() => {
    if (!userId) {
      setSync('local');
      setSyncError(null);
      return;
    }
    let cancelled = false;
    setSync('syncing');
    (async () => {
      try {
        const cloud = await fetchCloudProgress(userId);
        const local = latest.current;
        const merged = mergeProgress(cloud, local);
        const missingOnServer = Object.keys(merged).filter((id) => isBetter(cloud[id], merged[id]));
        await pushCloudProgress(userId, merged, missingOnServer);
        if (cancelled) return;
        saveProgress(merged);
        setProgress(merged);
        setSync('synced');
        setSyncError(null);
      } catch (e) {
        if (cancelled) return;
        setSync('error');
        setSyncError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const recordPass = useCallback(
    (labId: string, p: LabProgress) => {
      const current = latest.current;
      if (!isBetter(current[labId], p)) return;
      const next = { ...current, [labId]: p };
      saveProgress(next);
      setProgress(next);
      if (!userId) return;
      setSync('syncing');
      pushCloudProgress(userId, next, [labId])
        .then(() => {
          setSync('synced');
          setSyncError(null);
        })
        .catch((e: unknown) => {
          setSync('error');
          setSyncError(e instanceof Error ? e.message : String(e));
        });
    },
    [userId],
  );

  const reset = useCallback(async () => {
    resetProgress();
    setProgress({});
    if (!userId) return;
    try {
      setSync('syncing');
      await clearCloudProgress(userId);
      setSync('synced');
    } catch (e) {
      setSync('error');
      setSyncError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  return <ProgressContext.Provider value={{ progress, sync, syncError, recordPass, reset }}>{children}</ProgressContext.Provider>;
}

export function useProgress(): ProgressStore {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error('useProgress must be used inside ProgressProvider');
  return ctx;
}
