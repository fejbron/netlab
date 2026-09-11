import type { Lab } from '../content';
import { isLabUnlocked } from '../content';
import { grade, type NetworkState } from '../engine';
import type { ProgressMap } from './progress';

export type LabStatus = 'locked' | 'not-started' | 'in-progress' | 'completed';

export interface LabState {
  status: LabStatus;
  completedObjectives: number;
  totalObjectives: number;
}

/** Looks up the saved network for a lab (from the per-lab session store), or null. */
export type SessionLookup = (labId: string) => NetworkState | null;

/** True when the learner has typed at least one command in this network. */
export function hasActivity(network: NetworkState): boolean {
  return Object.values(network.devices).some((d) => d.commandHistory.length > 0) || Object.values(network.hosts).some((h) => h.commandHistory.length > 0);
}

/**
 * Where a lab stands for this learner. A lab is in progress when it is not
 * passed yet but a saved session with activity exists; the live grade of that
 * session gives the objective count.
 */
export function labState(lab: Lab, progress: ProgressMap, sessionFor: SessionLookup): LabState {
  const total = lab.objectives.length;
  if (progress[lab.id]) return { status: 'completed', completedObjectives: total, totalObjectives: total };
  if (!isLabUnlocked(lab.id, progress)) return { status: 'locked', completedObjectives: 0, totalObjectives: total };
  const network = sessionFor(lab.id);
  if (!network || !hasActivity(network)) return { status: 'not-started', completedObjectives: 0, totalObjectives: total };
  const done = grade(lab.objectives, network).objectives.filter((o) => o.passed).length;
  return { status: 'in-progress', completedObjectives: done, totalObjectives: total };
}

export interface NextAction {
  lab: Lab;
  reason: 'resume' | 'start' | 'review';
}

/**
 * The lab to put in front of the learner: an unfinished session first, then the
 * first open lab not passed yet, otherwise the first lab to review.
 */
export function nextAction(labs: Lab[], progress: ProgressMap, states: Record<string, LabState>): NextAction | undefined {
  const resume = labs.find((l) => states[l.id]?.status === 'in-progress');
  if (resume) return { lab: resume, reason: 'resume' };
  const start = labs.find((l) => !progress[l.id] && isLabUnlocked(l.id, progress));
  if (start) return { lab: start, reason: 'start' };
  return labs[0] ? { lab: labs[0], reason: 'review' } : undefined;
}

export const STAR_LEVELS = [
  { stars: 3, label: 'Independent', description: 'Pass without revealing any hint.' },
  { stars: 2, label: 'Guided', description: 'Pass after revealing some of the hints.' },
  { stars: 1, label: 'Assisted', description: 'Pass after revealing every hint.' },
  { stars: 0, label: 'Incomplete', description: 'The lab is not complete yet.' },
] as const;

export function starLabel(stars: number): string {
  return STAR_LEVELS.find((l) => l.stars === stars)?.label ?? 'Incomplete';
}

/** Stars for a passed attempt: 3 with no hints, 2 with some, 1 with all of them. */
export function starsFor(passed: boolean, hintsRevealed: number, hintCount: number): number {
  if (!passed) return 0;
  if (hintsRevealed === 0) return 3;
  return hintsRevealed < hintCount ? 2 : 1;
}
