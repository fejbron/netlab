import { describe, expect, it } from 'vitest';
import { labsForPath } from './index';

/**
 * Lesson scenes place nodes on a grid whose columns are narrower than a node, so two
 * nodes in neighbouring columns of the same row would overlap. Authors keep nodes at
 * least two columns apart; this test names any step that does not.
 */
describe('lesson scenes', () => {
  it('keep nodes on the same row at least two columns apart', () => {
    const offenders: string[] = [];
    for (const lab of labsForPath('sysdesign')) {
      for (const step of lab.lesson!.steps) {
        const nodes = step.scene.nodes.filter((n) => n.kind !== 'region');
        for (const a of nodes) for (const b of nodes) if (a.id < b.id && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 0.75) offenders.push(`${lab.id} · ${step.short}: ${a.id} (${a.x},${a.y}) vs ${b.id} (${b.x},${b.y})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
