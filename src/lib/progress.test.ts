import { describe, expect, it } from 'vitest';
import { isBetter, mergeProgress, type LabProgress } from './progress';

const p = (stars: number, score: number, completedAt = '2026-01-01T00:00:00.000Z'): LabProgress => ({ stars, score, completedAt });

describe('progress merging', () => {
  it('prefers more stars, then a higher score, and never downgrades', () => {
    expect(isBetter(undefined, p(1, 50))).toBe(true);
    expect(isBetter(p(2, 100), p(3, 80))).toBe(true);
    expect(isBetter(p(2, 80), p(2, 100))).toBe(true);
    expect(isBetter(p(2, 100), p(2, 100))).toBe(false);
    expect(isBetter(p(3, 100), p(2, 100))).toBe(false);
  });

  it('merges a device map with an account map keeping the best attempt per lab', () => {
    const cloud = { 'cli-01': p(3, 100, '2026-02-01T00:00:00.000Z'), 'cli-02': p(1, 60) };
    const local = { 'cli-02': p(2, 100), 'cli-03': p(3, 100) };
    const merged = mergeProgress(cloud, local);
    expect(Object.keys(merged).sort()).toEqual(['cli-01', 'cli-02', 'cli-03']);
    expect(merged['cli-01']).toEqual(cloud['cli-01']);
    expect(merged['cli-02']).toEqual(local['cli-02']);
    expect(merged['cli-03']).toEqual(local['cli-03']);
    // Pure: inputs untouched.
    expect(cloud['cli-02'].stars).toBe(1);
  });
});
