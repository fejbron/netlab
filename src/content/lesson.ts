import { emptyLesson, type LessonProgress, type NetworkState, type Objective } from '../engine';
import type { Difficulty, Lab } from './types';

/*
 * Lesson labs: a stepped explanation of a system-design idea. Each step shows a
 * diagram of the system at that point, the prose that goes with it, what changed
 * since the previous step and what the dashboard numbers did. A knowledge check
 * at the end is what gets graded.
 *
 * Nothing here is drawn by hand: a step's scene is a list of nodes on a grid and
 * the links between them, and the viewer (components/LessonView.tsx) lays it out.
 */

export type NodeKind = 'users' | 'client' | 'server' | 'lb' | 'db' | 'replica' | 'cache' | 'queue' | 'cdn' | 'dns' | 'service' | 'storage' | 'worker' | 'proxy' | 'cloud' | 'region' | 'note';

export type NodeState = 'ok' | 'hot' | 'down' | 'dim' | 'new' | 'warn';

export interface SceneNode {
  id: string;
  kind: NodeKind;
  /** Grid position: x from 0 (left) to 12, y from 0 (top) to 6. */
  x: number;
  y: number;
  label: string;
  /** Second line under the label, e.g. an address, a count or a load figure. */
  sub?: string;
  state?: NodeState;
  /** A short tag drawn above the node, e.g. "DOWN" or "cache hit 92%". */
  tag?: string;
  /** A region: how many grid cells it spans. Drawn behind everything else. */
  span?: { w: number; h: number };
}

export type LinkState = 'ok' | 'fail' | 'off' | 'dashed';
export type FlowDir = 'to' | 'from' | 'both' | 'none';

export interface SceneLink {
  from: string;
  to: string;
  label?: string;
  state?: LinkState;
  /** Which way the animated traffic runs along the link. Defaults to 'to'. */
  flow?: FlowDir;
  /** Traffic density. Defaults to 'normal'. */
  rate?: 'light' | 'normal' | 'heavy';
}

export interface Scene {
  nodes: SceneNode[];
  links: SceneLink[];
}

export type Chapter = 'setup' | 'problem' | 'technique' | 'solution' | 'insight' | 'tradeoff' | 'recap';
export type CalloutKind = 'tip' | 'warn' | 'insight' | 'tradeoff' | 'recap' | 'next';

export interface Callout {
  kind: CalloutKind;
  text: string;
}

export interface Step {
  /** Two or three words for the step rail. */
  short: string;
  chapter: Chapter;
  title: string;
  /** Paragraphs. `code`, **strong** and *emphasis* are rendered. */
  body: string[];
  callout?: Callout;
  /** What changed since the previous step: lines starting with "+", "−" or "~". */
  changes?: string[];
  /** Dashboard values keyed by the lesson's metric keys; null means not measured yet. */
  metrics?: Record<string, number | string | null>;
  scene: Scene;
}

export interface Metric {
  key: string;
  label: string;
  /** Appended to the value, e.g. "ms" or "%". */
  unit?: string;
  /** Which direction is an improvement, for the change arrow. */
  good?: 'up' | 'down';
}

export interface Question {
  id: string;
  prompt: string;
  options: string[];
  /** Index into options. */
  answer: number;
  /** Shown after answering: why the right option is right. */
  why: string;
}

export interface LessonSpec {
  metrics: Metric[];
  steps: Step[];
  quiz: Question[];
}

/** The pieces a lesson file supplies; the rest of the Lab is derived. */
export interface LessonInput {
  id: string;
  moduleId: string;
  order: number;
  title: string;
  difficulty: Difficulty;
  estimatedMinutes: number;
  description: string;
  /** One-paragraph framing shown on the lab page before the first step. */
  scenario: string;
  concepts: string[];
  isExam?: boolean;
  metrics?: Metric[];
  steps: Step[];
  quiz: Question[];
}

/** The one node id of a lesson network. Nothing is typed at it; it only keeps the session store happy. */
export const LESSON_NODE = 'lesson';

export function lessonNetwork(): NetworkState {
  return { primary: LESSON_NODE, devices: {}, hosts: {}, links: [], lesson: emptyLesson() };
}

/** Objectives a lesson is graded on: every step opened, every question answered right. */
export function lessonObjectives(spec: LessonSpec): Objective[] {
  return [
    { id: 'steps', label: 'Step through the lesson', checks: [{ type: 'lesson-steps', count: spec.steps.length, label: `Open all ${spec.steps.length} steps` }] },
    { id: 'quiz', label: 'Pass the knowledge check', checks: [{ type: 'lesson-quiz', questions: spec.quiz.map((q) => q.id), label: `Answer all ${spec.quiz.length} questions correctly` }] },
  ];
}

/** Build a Lab from a lesson. Hints are not used: the stars come from the knowledge check instead. */
export function lesson(input: LessonInput): Lab {
  const spec: LessonSpec = { metrics: input.metrics ?? [], steps: input.steps, quiz: input.quiz };
  if (spec.steps.length < 2) throw new Error(`lesson ${input.id} needs at least two steps`);
  if (spec.quiz.length < 1) throw new Error(`lesson ${input.id} needs a knowledge check`);
  for (const q of spec.quiz) if (q.answer < 0 || q.answer >= q.options.length) throw new Error(`lesson ${input.id}: question ${q.id} answer out of range`);
  return {
    id: input.id,
    moduleId: input.moduleId,
    order: input.order,
    title: input.title,
    difficulty: input.difficulty,
    estimatedMinutes: input.estimatedMinutes,
    description: input.description,
    scenario: input.scenario,
    concepts: input.concepts,
    hints: [],
    isExam: input.isExam,
    createState: lessonNetwork,
    objectives: lessonObjectives(spec),
    lesson: spec,
  };
}

/**
 * Stars for a lesson: three when every question was right first time, two when some
 * wrong options were tried, one when an answer had to be shown. Zero until every
 * question is right.
 */
export function lessonStars(spec: LessonSpec, progress: LessonProgress | undefined): number {
  if (!progress) return 0;
  const answers = spec.quiz.map((q) => progress.answers[q.id]);
  if (answers.some((a) => !a?.correct)) return 0;
  if (answers.some((a) => a!.revealed)) return 1;
  if (answers.some((a) => a!.wrong > 0)) return 2;
  return 3;
}

/** Record that a step was opened. Pure. */
export function openStep(progress: LessonProgress, index: number): LessonProgress {
  if (progress.seen.includes(index)) return progress;
  return { ...progress, seen: [...progress.seen, index].sort((a, b) => a - b) };
}

/** Record an answer. A right answer after wrong ones keeps the count of wrong tries. Pure. */
export function answerQuestion(progress: LessonProgress, q: Question, chosen: number): LessonProgress {
  const prev = progress.answers[q.id];
  if (prev?.correct) return progress;
  const correct = chosen === q.answer;
  return { ...progress, answers: { ...progress.answers, [q.id]: { chosen, correct, wrong: (prev?.wrong ?? 0) + (correct ? 0 : 1), revealed: prev?.revealed ?? false } } };
}

/** Show the answer: the question counts as answered, at the cost of the star rating. Pure. */
export function revealAnswer(progress: LessonProgress, q: Question): LessonProgress {
  const prev = progress.answers[q.id];
  if (prev?.correct) return progress;
  return { ...progress, answers: { ...progress.answers, [q.id]: { chosen: q.answer, correct: true, wrong: prev?.wrong ?? 0, revealed: true } } };
}

/** A reference "solution": every step opened and every question answered right first time. */
export function completeLesson(net: NetworkState, spec: LessonSpec): NetworkState {
  let p = net.lesson ?? emptyLesson();
  spec.steps.forEach((_, i) => (p = openStep(p, i)));
  for (const q of spec.quiz) p = answerQuestion(p, q, q.answer);
  return { ...net, lesson: p };
}

// ---------------------------------------------------------------------------
// Scene helpers, so a lesson reads as a sketch rather than a data structure.

type NodeOpts = Partial<Pick<SceneNode, 'sub' | 'state' | 'tag' | 'span'>>;

const node = (kind: NodeKind) => (id: string, x: number, y: number, label: string, opts: NodeOpts = {}): SceneNode => ({ id, kind, x, y, label, ...opts });

export const users = node('users');
export const client = node('client');
export const server = node('server');
export const lb = node('lb');
export const db = node('db');
export const replica = node('replica');
export const cache = node('cache');
export const queue = node('queue');
export const cdn = node('cdn');
export const dns = node('dns');
export const service = node('service');
export const storage = node('storage');
export const worker = node('worker');
export const proxy = node('proxy');
export const cloud = node('cloud');
export const note = node('note');
/** A labelled region behind other nodes, `w` by `h` grid cells from its top-left corner. */
export const region = (id: string, x: number, y: number, w: number, h: number, label: string, opts: Omit<NodeOpts, 'span'> = {}): SceneNode => ({ id, kind: 'region', x, y, label, span: { w, h }, ...opts });

export const link = (from: string, to: string, opts: Omit<SceneLink, 'from' | 'to'> = {}): SceneLink => ({ from, to, ...opts });

export const scene = (nodes: SceneNode[], links: SceneLink[] = []): Scene => ({ nodes, links });

/** A copy of a scene with some nodes changed, so a step can be "the previous scene, but". */
export function patch(base: Scene, nodes: Record<string, NodeOpts & Partial<Pick<SceneNode, 'label' | 'x' | 'y'>>>, links?: SceneLink[]): Scene {
  return {
    nodes: base.nodes.map((n) => (nodes[n.id] ? { ...n, ...nodes[n.id] } : n)),
    links: links ?? base.links,
  };
}

export const q = (id: string, prompt: string, options: string[], answer: number, why: string): Question => ({ id, prompt, options, answer, why });
