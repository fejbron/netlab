import { describe, expect, it } from 'vitest';
import { emptyLesson } from '../engine';
import { grade } from '../engine/grader';
import { labs, labsForPath } from './index';
import { answerQuestion, completeLesson, lessonNetwork, lessonStars, openStep, patch, q, revealAnswer, scene, server, type LessonSpec } from './lesson';

const spec: LessonSpec = {
  metrics: [],
  steps: [
    { short: 'a', chapter: 'setup', title: 'A', body: ['a'], scene: scene([server('s', 1, 1, 'S')]) },
    { short: 'b', chapter: 'problem', title: 'B', body: ['b'], scene: scene([server('s', 1, 1, 'S')]) },
  ],
  quiz: [q('q1', 'One?', ['no', 'yes'], 1, 'because'), q('q2', 'Two?', ['yes', 'no'], 0, 'because')],
};

describe('lesson progress', () => {
  it('starts on the first step with nothing answered, and is not passed', () => {
    const net = lessonNetwork();
    expect(net.lesson).toEqual(emptyLesson());
    expect(lessonStars(spec, net.lesson)).toBe(0);
  });

  it('awards three stars for right-first-time, two after a wrong try, one after showing an answer', () => {
    let p = emptyLesson();
    p = openStep(p, 1);
    expect(p.seen).toEqual([0, 1]);
    const clean = answerQuestion(answerQuestion(p, spec.quiz[0], 1), spec.quiz[1], 0);
    expect(lessonStars(spec, clean)).toBe(3);
    const guessed = answerQuestion(answerQuestion(answerQuestion(p, spec.quiz[0], 0), spec.quiz[0], 1), spec.quiz[1], 0);
    expect(guessed.answers.q1).toMatchObject({ correct: true, wrong: 1, revealed: false });
    expect(lessonStars(spec, guessed)).toBe(2);
    const shown = answerQuestion(revealAnswer(p, spec.quiz[0]), spec.quiz[1], 0);
    expect(lessonStars(spec, shown)).toBe(1);
    // A right answer is final: later clicks change nothing.
    expect(answerQuestion(clean, spec.quiz[0], 0)).toBe(clean);
  });

  it('completeLesson passes the derived objectives', () => {
    const lab = labs.find((l) => l.lesson)!;
    expect(grade(lab.objectives, lessonNetwork()).passed).toBe(false);
    expect(grade(lab.objectives, completeLesson(lessonNetwork(), lab.lesson!)).passed).toBe(true);
  });

  it('patch copies a scene with the named nodes changed', () => {
    const base = scene([server('a', 0, 0, 'A'), server('b', 1, 0, 'B')]);
    const next = patch(base, { b: { state: 'down', label: 'B!' } });
    expect(next.nodes[1]).toMatchObject({ id: 'b', state: 'down', label: 'B!' });
    expect(base.nodes[1].state).toBeUndefined();
  });
});

describe('system design content', () => {
  const sd = labsForPath('sysdesign');

  it('is all lessons, each with a scene on every step and sensible quiz answers', () => {
    expect(sd.length).toBeGreaterThan(0);
    for (const lab of sd) {
      expect(lab.lesson, lab.id).toBeDefined();
      for (const step of lab.lesson!.steps) {
        expect(step.scene.nodes.length, `${lab.id} ${step.title}`).toBeGreaterThan(0);
        const ids = new Set(step.scene.nodes.map((n) => n.id));
        expect(ids.size, `${lab.id} ${step.title} duplicate node id`).toBe(step.scene.nodes.length);
        for (const l of step.scene.links) {
          expect(ids.has(l.from), `${lab.id} ${step.title} link from ${l.from}`).toBe(true);
          expect(ids.has(l.to), `${lab.id} ${step.title} link to ${l.to}`).toBe(true);
        }
        for (const k of Object.keys(step.metrics ?? {})) expect(lab.lesson!.metrics.some((m) => m.key === k), `${lab.id} ${step.title} metric ${k}`).toBe(true);
      }
      expect(lab.lesson!.quiz.length, lab.id).toBeGreaterThanOrEqual(3);
      const qids = new Set(lab.lesson!.quiz.map((x) => x.id));
      expect(qids.size, lab.id).toBe(lab.lesson!.quiz.length);
    }
  });
});
