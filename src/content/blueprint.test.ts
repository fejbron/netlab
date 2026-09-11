import { describe, expect, it } from 'vitest';
import { EXAM_DOMAINS, EXAM_TOPICS, byTopicCode, domainCoverage, topicDomain } from './blueprint';
import { labs, modules as allModules, paths, labsForPath, modulesForPath } from './index';

const modules = allModules.filter((m) => m.pathId === 'ccna');

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
    expect(['OD.2', 'EC.10', 'EC.2', 'NW.1'].sort(byTopicCode)).toEqual(['EC.2', 'EC.10', 'NW.1', 'OD.2']);
  });

  it('reports lab counts and progress per domain, and an uncovered domain honestly', () => {
    const none = domainCoverage(EXAM_DOMAINS, modules, labs, {});
    expect(none.map((d) => d.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    const access = none.find((d) => d.id === '2')!;
    expect(access.modules.map((m) => m.id)).toContain('learn-switching');
    expect(access.labs).toBeGreaterThan(0);
    expect(access.percent).toBe(0);
    expect(access.topics).toEqual(['2.1', '2.2', '2.4', '2.5']);
    const automation = none.find((d) => d.id === '6')!;
    expect(automation.modules.map((m) => m.id)).toEqual(['learn-automation']);
    expect(automation.topics).toEqual(['6.4', '6.5', '6.7']);
    // A domain nobody maps to reports zero labs rather than pretending.
    const uncovered = domainCoverage(EXAM_DOMAINS, modules.filter((m) => m.id !== 'learn-automation'), labs, {}).find((d) => d.id === '6')!;
    expect(uncovered.labs).toBe(0);
    expect(uncovered.modules).toEqual([]);
    expect(uncovered.percent).toBe(0);

    const switching = labs.filter((l) => l.moduleId === 'learn-switching');
    const progress = Object.fromEntries(switching.map((l) => [l.id, { score: 100, stars: 3, completedAt: '' }]));
    const some = domainCoverage(EXAM_DOMAINS, modules, labs, progress).find((d) => d.id === '2')!;
    expect(some.completed).toBe(switching.length);
    expect(some.percent).toBe(Math.round((switching.length / some.labs) * 100));
  });
});

describe('learning paths', () => {
  it('every path has weighted domains that total 100 and modules whose topics are described', () => {
    for (const p of paths) {
      expect(p.blueprint.domains.reduce((n, d) => n + d.weight, 0), p.id).toBe(100);
      const ids = new Set(p.blueprint.domains.map((d) => d.id));
      const mods = modulesForPath(p.id);
      expect(mods.length, p.id).toBeGreaterThan(0);
      for (const m of mods) for (const t of m.examTopics ?? []) {
        expect(p.blueprint.topics[t], `${m.id}: ${t}`).toBeTruthy();
        expect(ids.has(topicDomain(t)), t).toBe(true);
      }
      expect(labsForPath(p.id).length, p.id).toBeGreaterThan(0);
    }
    // Storage is honestly reported as uncovered on the Linux path.
    const linux = paths.find((p) => p.id === 'linux')!;
    const storage = domainCoverage(linux.blueprint.domains, modulesForPath('linux'), labs, {}).find((d) => d.id === 'ST')!;
    expect(storage.labs).toBe(0);
  });
});
