import { describe, expect, it } from 'vitest';
import { labNetwork, labs } from '../content';
import { executeOn } from '../engine';
import { labState, nextAction, starsFor, type LabState } from './pathProgress';
import type { ProgressMap } from './progress';

const pass = { score: 100, stars: 3, completedAt: '2026-01-01T00:00:00.000Z' };
const none = () => null;

describe('labState', () => {
  const [first, second, third] = labs;

  it('is not started with no progress and no session', () => {
    expect(labState(first, {}, none)).toEqual({ status: 'not-started', completedObjectives: 0, totalObjectives: first.objectives.length });
  });

  it('is locked until the previous lab is passed', () => {
    expect(labState(second, {}, none).status).toBe('locked');
    expect(labState(second, { [first.id]: pass }, none).status).toBe('not-started');
  });

  it('is completed once recorded, whatever the session says', () => {
    const s = labState(first, { [first.id]: pass }, none);
    expect(s.status).toBe('completed');
    expect(s.completedObjectives).toBe(s.totalObjectives);
  });

  it('is in progress when a session with typed commands exists, counting passed objectives', () => {
    const fresh = labNetwork(first);
    expect(labState(first, {}, () => fresh).status).toBe('not-started');
    const { network } = executeOn(fresh, fresh.primary, 'enable');
    const s = labState(first, {}, () => network);
    expect(s.status).toBe('in-progress');
    expect(s.completedObjectives).toBeGreaterThanOrEqual(1);
    expect(s.completedObjectives).toBeLessThan(s.totalObjectives);
    expect(third.id).not.toBe(first.id);
  });
});

describe('nextAction', () => {
  const [first, second] = labs;
  const state = (status: LabState['status']): LabState => ({ status, completedObjectives: 0, totalObjectives: 1 });

  it('starts with the first lab', () => {
    expect(nextAction(labs, {}, {})).toEqual({ lab: first, reason: 'start' });
  });

  it('resumes an in-progress lab before starting the next open one', () => {
    const progress: ProgressMap = { [first.id]: pass };
    expect(nextAction(labs, progress, {})).toEqual({ lab: second, reason: 'start' });
    expect(nextAction(labs, progress, { [second.id]: state('in-progress') })).toEqual({ lab: second, reason: 'resume' });
  });

  it('offers a review once every lab is passed', () => {
    const all: ProgressMap = Object.fromEntries(labs.map((l) => [l.id, pass]));
    expect(nextAction(labs, all, {})).toEqual({ lab: first, reason: 'review' });
  });
});

describe('starsFor', () => {
  it('rewards independent, guided and assisted passes', () => {
    expect(starsFor(false, 0, 3)).toBe(0);
    expect(starsFor(true, 0, 3)).toBe(3);
    expect(starsFor(true, 1, 3)).toBe(2);
    expect(starsFor(true, 3, 3)).toBe(1);
    expect(starsFor(true, 0, 0)).toBe(3);
  });
});
