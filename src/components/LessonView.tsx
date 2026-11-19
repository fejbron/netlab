import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LessonProgress } from '../engine';
import { answerQuestion, lessonStars, openStep, revealAnswer, type CalloutKind, type Chapter, type LessonSpec, type Metric, type Question, type Step } from '../content/lesson';
import type { Lab } from '../content';
import Icon, { NF } from './Icon';
import SceneDiagram from './SceneDiagram';

interface Props {
  lab: Lab;
  spec: LessonSpec;
  progress: LessonProgress;
  onProgress: (p: LessonProgress) => void;
  /** Called when the learner asks for the lesson to be graded. */
  onFinish: () => void;
}

const CHAPTER: Record<Chapter, string> = {
  setup: 'Setup',
  problem: 'Problem',
  technique: 'Technique',
  solution: 'Solution',
  insight: 'Insight',
  tradeoff: 'Trade-off',
  recap: 'Recap',
};

const CALLOUT: Record<CalloutKind, { label: string; glyph: string }> = {
  tip: { label: 'Tip', glyph: NF.bulb },
  warn: { label: 'Watch out', glyph: NF.warning },
  insight: { label: 'Insight', glyph: NF.star },
  tradeoff: { label: 'Trade-off', glyph: NF.exchange },
  recap: { label: 'Recap', glyph: NF.flag },
  next: { label: 'Up next', glyph: NF.arrowRight },
};

/** `code`, **strong** and *emphasis* inside a paragraph. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[12px] text-fg-bright">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-fg-bright">{t.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function formatValue(v: number | string | null | undefined, unit?: string): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return `${v.toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`;
  return unit ? `${v} ${unit}` : v;
}

/** Each metric's value at a step: a step that does not mention a metric keeps the last value. */
function metricsAt(spec: LessonSpec, index: number): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  for (const m of spec.metrics) out[m.key] = null;
  for (let i = 0; i <= Math.min(index, spec.steps.length - 1); i++) {
    const step = spec.steps[i];
    if (step.metrics) for (const [k, v] of Object.entries(step.metrics)) out[k] = v;
  }
  return out;
}

function Metrics({ spec, index }: { spec: LessonSpec; index: number }) {
  if (spec.metrics.length === 0) return null;
  const now = metricsAt(spec, index);
  const before = index > 0 ? metricsAt(spec, index - 1) : null;
  const change = (m: Metric): { glyph: string; good: boolean } | null => {
    if (!before) return null;
    const a = before[m.key];
    const b = now[m.key];
    if (typeof a !== 'number' || typeof b !== 'number' || a === b) return null;
    const up = b > a;
    const good = m.good ? (m.good === 'up') === up : true;
    return { glyph: up ? '▲' : '▼', good };
  };
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${Math.max(96, Math.min(150, 560 / spec.metrics.length))}px, 1fr))` }}>
      {spec.metrics.map((m) => {
        const c = change(m);
        const moved = before !== null && before[m.key] !== now[m.key];
        return (
          <div key={m.key} className={`rounded-xl border px-3 py-2 transition-colors ${moved ? 'border-border-strong bg-surface-2' : 'border-border bg-surface'}`}>
            <div className="label truncate text-muted">{m.label}</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[15px] font-bold text-fg-bright">
              <span className="truncate">{formatValue(now[m.key], m.unit)}</span>
              {c && (
                <span className={`text-[10px] ${c.good ? 'text-fg-bright' : 'text-muted'}`} title={c.good ? 'Better' : 'Worse'}>
                  {c.glyph}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Changes({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1 font-mono text-[12px]">
      {lines.map((l, i) => {
        const sign = l[0];
        const text = l.slice(1).trim();
        const glyph = sign === '+' ? '+' : sign === '−' || sign === '-' ? '−' : '~';
        const cls = sign === '+' ? 'text-fg-bright' : sign === '−' || sign === '-' ? 'text-muted line-through decoration-muted/60' : 'text-fg';
        return (
          <li key={i} className="flex gap-2">
            <span className="w-3 shrink-0 text-muted">{glyph}</span>
            <span className={cls}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CalloutBox({ kind, text }: { kind: CalloutKind; text: string }) {
  const c = CALLOUT[kind];
  return (
    <aside className={`mt-4 rounded-xl border px-3.5 py-3 text-[13px] leading-6 ${kind === 'warn' ? 'border-fg/40 bg-surface-2' : kind === 'insight' ? 'border-border-strong bg-surface-2' : 'border-border bg-surface'}`}>
      <span className="label mr-2 inline-flex items-center gap-1.5 text-fg-bright">
        <Icon g={c.glyph} />
        {c.label}
      </span>
      <span className="text-fg">{inline(text)}</span>
    </aside>
  );
}

function Quiz({ spec, progress, onProgress, onFinish, passed }: { spec: LessonSpec; progress: LessonProgress; onProgress: (p: LessonProgress) => void; onFinish: () => void; passed: boolean }) {
  const stars = lessonStars(spec, progress);
  const answered = spec.quiz.filter((q) => progress.answers[q.id]?.correct).length;
  return (
    <div>
      <p className="label text-muted">Knowledge check</p>
      <h2 className="display mt-1 text-2xl text-fg-bright">Check what you learned</h2>
      <p className="mt-2 text-[13px] leading-6 text-muted">
        {spec.quiz.length} questions. Every question right first time earns three stars; a wrong try costs one, and showing an answer leaves one.
      </p>
      <ol className="mt-5 space-y-4">
        {spec.quiz.map((q, qi) => (
          <QuestionCard key={q.id} q={q} n={qi + 1} progress={progress} onProgress={onProgress} />
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onFinish} disabled={answered < spec.quiz.length} className="btn btn-primary py-2.5">
          <Icon g={NF.flag} />
          {passed ? 'See results' : 'Finish lesson'}
        </button>
        <span className="text-xs text-muted">
          {answered}/{spec.quiz.length} answered
          {answered === spec.quiz.length && (
            <>
              {' · '}
              {[1, 2, 3].map((n) => (
                <Icon key={n} g={n <= stars ? NF.star : NF.starO} className={n <= stars ? 'text-star' : 'text-surface-3'} />
              ))}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function QuestionCard({ q, n, progress, onProgress }: { q: Question; n: number; progress: LessonProgress; onProgress: (p: LessonProgress) => void }) {
  const a = progress.answers[q.id];
  const done = a?.correct === true;
  return (
    <li className={`rounded-xl border p-4 ${done ? 'border-border-strong bg-surface-2' : 'border-border bg-surface'}`}>
      <p className="text-sm leading-6 text-fg-bright">
        <span className="label mr-2 text-muted">Q{n}</span>
        {inline(q.prompt)}
      </p>
      <div className="mt-3 grid gap-2">
        {q.options.map((opt, i) => {
          const chosen = a?.chosen === i;
          const wrongHere = chosen && !a?.correct;
          const rightHere = done && i === q.answer;
          return (
            <button
              key={i}
              type="button"
              disabled={done}
              onClick={() => onProgress(answerQuestion(progress, q, i))}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] leading-5 transition-colors ${rightHere ? 'border-fg-bright bg-surface-3 text-fg-bright' : wrongHere ? 'border-border-strong text-muted line-through' : 'border-border text-fg hover:border-border-strong hover:bg-surface-2 disabled:hover:border-border disabled:hover:bg-transparent'}`}
              aria-pressed={chosen}
            >
              <span className="mt-0.5 w-4 shrink-0 font-mono text-[11px] text-muted">{rightHere ? <Icon g={NF.check} className="text-fg-bright" /> : wrongHere ? <Icon g={NF.times} /> : String.fromCharCode(65 + i)}</span>
              <span>{inline(opt)}</span>
            </button>
          );
        })}
      </div>
      {done ? (
        <p className="mt-3 text-[12px] leading-5 text-fg">
          <span className="label mr-1.5 text-fg-bright">{a.revealed ? 'Answer' : a.wrong > 0 ? 'Right, eventually' : 'Right'}</span>
          {inline(q.why)}
        </p>
      ) : a ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-muted">
          <span>Not that one. Try again.</span>
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => onProgress(revealAnswer(progress, q))}>
            Show the answer
          </button>
        </div>
      ) : null}
    </li>
  );
}

export default function LessonView({ lab, spec, progress, onProgress, onFinish }: Props) {
  const total = spec.steps.length;
  const quizIndex = total;
  const [index, setIndex] = useState(() => Math.min(Math.max(...progress.seen, 0), quizIndex));
  const passedQuiz = useMemo(() => spec.quiz.every((q) => progress.answers[q.id]?.correct), [spec, progress]);

  useEffect(() => {
    if (index < total && !progress.seen.includes(index)) onProgress(openStep(progress, index));
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, quizIndex));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quizIndex]);

  const onQuiz = index === quizIndex;
  const step: Step = spec.steps[Math.min(index, total - 1)];
  const seenAll = spec.steps.every((_, i) => progress.seen.includes(i));

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Prose */}
      <aside className="order-2 min-h-0 overflow-y-auto border-t border-border bg-surface/60 p-5 lg:order-1 lg:border-r lg:border-t-0">
        {index === 0 && (
          <p className="mb-4 rounded-xl border border-border bg-surface px-3.5 py-3 text-[13px] leading-6 text-muted">
            <Icon g={NF.book} className="mr-1.5 text-fg" />
            {inline(lab.scenario)}
          </p>
        )}
        {onQuiz ? (
          <Quiz spec={spec} progress={progress} onProgress={onProgress} onFinish={onFinish} passed={passedQuiz} />
        ) : (
          <article key={index}>
            <p className="label text-muted">
              Step {index + 1} of {total} · <span className="text-fg">{CHAPTER[step.chapter]}</span>
            </p>
            <h2 className="display mt-1 text-2xl leading-tight text-fg-bright">{step.title}</h2>
            <div className="mt-3 space-y-3 text-[14px] leading-7 text-fg">
              {step.body.map((p, i) => (
                <p key={i}>{inline(p)}</p>
              ))}
            </div>
            {step.callout && <CalloutBox kind={step.callout.kind} text={step.callout.text} />}
            {step.changes && step.changes.length > 0 && (
              <div className="mt-4">
                <p className="label mb-1.5 text-muted">What changed</p>
                <Changes lines={step.changes} />
              </div>
            )}
          </article>
        )}
        <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
          <button type="button" className="btn btn-ghost btn-sm" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
            <Icon g={NF.chevronLeft} />
            Back
          </button>
          <span className="font-mono text-[11px] text-muted">
            {onQuiz ? 'check' : `${index + 1}/${total}`}
            <span className="ml-2 hidden sm:inline">
              <kbd className="rounded bg-surface-3 px-1 text-[10px] text-fg">←</kbd> <kbd className="rounded bg-surface-3 px-1 text-[10px] text-fg">→</kbd>
            </span>
          </span>
          {onQuiz ? (
            <span />
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setIndex((i) => Math.min(quizIndex, i + 1))}>
              {index === total - 1 ? 'Knowledge check' : 'Next'}
              <Icon g={NF.chevronRight} />
            </button>
          )}
        </div>
      </aside>

      {/* Diagram */}
      <section className="order-1 flex min-h-[46vh] min-w-0 flex-col gap-3 overflow-y-auto p-4 lg:order-2 lg:min-h-0">
        <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Steps">
          {spec.steps.map((s, i) => {
            const seen = progress.seen.includes(i);
            const active = i === index;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-current={active ? 'step' : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${active ? 'border-fg-bright bg-surface-3 text-fg-bright' : seen ? 'border-border bg-surface text-fg hover:border-border-strong' : 'border-border text-muted hover:text-fg'}`}
                title={s.title}
              >
                <span className={`${seen && !active ? 'text-fg-bright' : 'text-muted'}`}>{seen ? <Icon g={NF.check} className="text-[9px]" /> : i + 1}</span>
                {s.short}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setIndex(quizIndex)}
            aria-current={onQuiz ? 'step' : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${onQuiz ? 'border-fg-bright bg-surface-3 text-fg-bright' : passedQuiz ? 'border-border bg-surface text-fg' : seenAll ? 'border-border-strong text-fg' : 'border-border text-muted'}`}
          >
            <Icon g={passedQuiz ? NF.check : NF.question} className="text-[9px]" />
            Check
          </button>
        </nav>
        <div className="card p-3">
          <SceneDiagram scene={step.scene} title={step.title} />
        </div>
        <Metrics spec={spec} index={Math.min(index, total - 1)} />
      </section>
    </main>
  );
}
