import type { Difficulty, Lab } from '../content';
import type { ProgressMap } from './progress';

/**
 * Lab points: what a pass is worth on the leaderboard.
 *
 * Stars say how much help you needed; points say how much you did. A harder lab is
 * worth more than an easy one, an exam counts double, and the stars you earned decide
 * how much of that value you keep. Points are derived from the lab and the stars, so
 * there is one definition here and nothing to keep in sync.
 */
export const DIFFICULTY_POINTS: Record<Difficulty, number> = { Beginner: 100, Intermediate: 200, Advanced: 300 };

/** An exam pulls a whole module together, so it is worth twice its difficulty. */
export const EXAM_MULTIPLIER = 2;

/** Share of a lab's value kept for 0-3 stars: all of it without hints, less as hints are revealed. */
export const STAR_SHARE = [0, 0.4, 0.7, 1] as const;

/** What a lab is worth at three stars. */
export function maxPoints(lab: Lab): number {
  return DIFFICULTY_POINTS[lab.difficulty] * (lab.isExam ? EXAM_MULTIPLIER : 1);
}

/** What a pass with `stars` stars is worth. */
export function labPoints(lab: Lab, stars: number): number {
  const share = STAR_SHARE[Math.max(0, Math.min(3, Math.round(stars)))] ?? 0;
  return Math.round(maxPoints(lab) * share);
}

/** Points a learner has earned across the given labs. */
export function totalPoints(labs: Lab[], progress: ProgressMap): number {
  return labs.reduce((n, lab) => n + (progress[lab.id] ? labPoints(lab, progress[lab.id].stars) : 0), 0);
}

/** Points available across the given labs. */
export function maxTotalPoints(labs: Lab[]): number {
  return labs.reduce((n, lab) => n + maxPoints(lab), 0);
}

/** "1,250" so long totals stay readable. */
export function formatPoints(points: number): string {
  return points.toLocaleString('en-US');
}
