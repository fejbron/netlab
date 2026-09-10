import { describe, expect, it } from 'vitest';
import { rankEntries, sortEntries, type LeaderboardEntry } from './leaderboard';

const e = (displayName: string, totalStars: number, labsPassed: number, lastCompleted: string | null = '2026-01-01T00:00:00.000Z'): LeaderboardEntry => ({ userId: displayName, displayName, totalStars, labsPassed, lastCompleted });

describe('leaderboard ranking', () => {
  it('orders by stars, then labs passed, then earliest finish', () => {
    const sorted = sortEntries([e('slow', 9, 3, '2026-03-01T00:00:00.000Z'), e('fewer-labs', 9, 2), e('top', 12, 4), e('fast', 9, 3, '2026-02-01T00:00:00.000Z')]);
    expect(sorted.map((x) => x.displayName)).toEqual(['top', 'fast', 'slow', 'fewer-labs']);
  });

  it('gives tied learners the same rank and skips the next number', () => {
    const ranked = rankEntries([e('a', 12, 4), e('b', 9, 3), e('c', 9, 3), e('d', 9, 2), e('f', 0, 0)]);
    expect(ranked.map((x) => x.rank)).toEqual([1, 2, 2, 4, 5]);
  });
});
