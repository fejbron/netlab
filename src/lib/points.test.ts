import { describe, expect, it } from 'vitest';
import { labs, labsForPath } from '../content';
import type { Lab } from '../content';
import { DIFFICULTY_POINTS, EXAM_MULTIPLIER, formatPoints, labPoints, maxPoints, maxTotalPoints, totalPoints } from './points';
import type { ProgressMap } from './progress';

const lab = (difficulty: Lab['difficulty'], isExam = false): Lab => ({ id: 'x', moduleId: 'm', order: 1, title: 'x', difficulty, estimatedMinutes: 5, description: '', scenario: '', concepts: [], hints: [], createState: () => ({}) as never, objectives: [], ...(isExam ? { isExam: true } : {}) });

describe('lab points', () => {
  it('scales with difficulty and doubles for an exam', () => {
    expect(maxPoints(lab('Beginner'))).toBe(100);
    expect(maxPoints(lab('Intermediate'))).toBe(200);
    expect(maxPoints(lab('Advanced'))).toBe(300);
    expect(maxPoints(lab('Advanced', true))).toBe(300 * EXAM_MULTIPLIER);
    expect(DIFFICULTY_POINTS.Beginner).toBeLessThan(DIFFICULTY_POINTS.Advanced);
  });

  it('keeps the full value only for a pass without hints', () => {
    const l = lab('Intermediate');
    expect(labPoints(l, 3)).toBe(200);
    expect(labPoints(l, 2)).toBe(140);
    expect(labPoints(l, 1)).toBe(80);
    expect(labPoints(l, 0)).toBe(0);
    // Out-of-range stars are clamped rather than producing NaN.
    expect(labPoints(l, 7)).toBe(200);
    expect(labPoints(l, -1)).toBe(0);
  });

  it('always awards whole points', () => {
    for (const l of labs) for (const stars of [1, 2, 3]) expect(Number.isInteger(labPoints(l, stars)), `${l.id} at ${stars} stars`).toBe(true);
  });

  it('totals a learner and the board they are chasing', () => {
    const [first, second] = labs;
    const progress: ProgressMap = { [first.id]: { score: 100, stars: 3, completedAt: '' }, [second.id]: { score: 100, stars: 1, completedAt: '' } };
    expect(totalPoints(labs, progress)).toBe(labPoints(first, 3) + labPoints(second, 1));
    expect(totalPoints(labs, {})).toBe(0);
    expect(maxTotalPoints(labs)).toBeGreaterThan(totalPoints(labs, progress));
    // Each path can be totalled on its own for its dashboard.
    expect(maxTotalPoints(labsForPath('ccna')) + maxTotalPoints(labsForPath('linux'))).toBe(maxTotalPoints(labs));
  });

  it('formats long totals', () => {
    expect(formatPoints(940)).toBe('940');
    expect(formatPoints(12500)).toBe('12,500');
  });
});
