import { describe, expect, it } from 'vitest';
import { rankEntries, sortEntries, type LeaderboardEntry } from './leaderboard';

const e = (displayName: string, totalPoints: number, labsPassed: number, lastCompleted: string | null = '2026-01-01T00:00:00.000Z'): LeaderboardEntry => ({ userId: displayName, displayName, totalPoints, totalStars: labsPassed * 3, labsPassed, lastCompleted });

describe('leaderboard ranking', () => {
  it('orders by points, then labs passed, then earliest finish', () => {
    const sorted = sortEntries([e('slow', 900, 3, '2026-03-01T00:00:00.000Z'), e('fewer-labs', 900, 2), e('top', 1200, 4), e('fast', 900, 3, '2026-02-01T00:00:00.000Z')]);
    expect(sorted.map((x) => x.displayName)).toEqual(['top', 'fast', 'slow', 'fewer-labs']);
  });

  it('ranks a learner with fewer, harder labs above one with more easy ones', () => {
    const sorted = sortEntries([e('many-easy', 600, 6), e('few-hard', 1200, 2)]);
    expect(sorted.map((x) => x.displayName)).toEqual(['few-hard', 'many-easy']);
  });

  it('falls back to stars when the database cannot report points', () => {
    // A database that predates the points column reports zero for every learner.
    const rows = [e('few-hard', 0, 2), e('many-easy', 0, 6)].map((x) => ({ ...x, totalStars: x.labsPassed * 3 }));
    const sorted = sortEntries(rows, 'stars');
    expect(sorted.map((x) => x.displayName)).toEqual(['many-easy', 'few-hard']);
    expect(rankEntries(sorted, 'stars').map((x) => x.rank)).toEqual([1, 2]);
    // Ranking those same rows by points would tie everyone on zero.
    expect(rankEntries(rows, 'points').map((x) => x.rank)).toEqual([1, 2]);
  });

  it('gives tied learners the same rank and skips the next number', () => {
    const ranked = rankEntries([e('a', 1200, 4), e('b', 900, 3), e('c', 900, 3), e('d', 900, 2), e('f', 0, 0)]);
    expect(ranked.map((x) => x.rank)).toEqual([1, 2, 2, 4, 5]);
  });
});
