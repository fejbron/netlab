import { describe, expect, it } from 'vitest';
import { EXAM_DOMAINS, EXAM_TOPICS, byTopicCode, domainCoverage, topicDomain } from './blueprint';
import { labs, modules } from './index';

describe('CCNA blueprint', () => {
  it('weights add up to the whole exam', () => {
    expect(EXAM_DOMAINS.reduce((n, d) => n + d.weight, 0)).toBe(100);
  });

  it('every module topic is a known blueprint topic in a known domain', () => {
    const domainIds = new Set(EXAM_DOMAINS.map((d) => d.id));
    for (const m of modules) {
      expect(m.examTopics?.length, `${m.id} maps to at least one topic`).toBeGreaterThan(0);
      for (const t of m.examTopics ?? []) {
        expect(EXAM_TOPICS[t], `${m.id}: ${t} is described`).toBeTruthy();
        expect(domainIds.has(topicDomain(t)), `${t} belongs to a domain`).toBe(true);
      }
    }
  });

  it('sorts topic codes numerically', () => {
    expect(['1.13', '2.1', '1.6', '1.1'].sort(byTopicCode)).toEqual(['1.1', '1.6', '1.13', '2.1']);
  });

  it('reports lab counts and progress per domain, and an uncovered domain honestly', () => {
    const none = domainCoverage(modules, labs, {});
    expect(none.map((d) => d.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    const access = none.find((d) => d.id === '2')!;
    expect(access.modules.map((m) => m.id)).toContain('learn-switching');
    expect(access.labs).toBeGreaterThan(0);
    expect(access.percent).toBe(0);
    expect(access.topics).toEqual(['2.1', '2.2', '2.4', '2.5']);
    const automation = none.find((d) => d.id === '6')!;
    expect(automation.labs).toBe(0);
    expect(automation.modules).toEqual([]);

    const switching = labs.filter((l) => l.moduleId === 'learn-switching');
    const progress = Object.fromEntries(switching.map((l) => [l.id, { score: 100, stars: 3, completedAt: '' }]));
    const some = domainCoverage(modules, labs, progress).find((d) => d.id === '2')!;
    expect(some.completed).toBe(switching.length);
    expect(some.percent).toBe(Math.round((switching.length / some.labs) * 100));
  });
});
