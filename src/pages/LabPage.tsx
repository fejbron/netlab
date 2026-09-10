import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header';
import Objectives from '../components/Objectives';
import ResultsModal from '../components/ResultsModal';
import Terminal from '../components/Terminal';
import Topology from '../components/Topology';
import { getLab, nextLab } from '../content';
import { execute, grade, isMaskedInput, prompt, tabComplete, type DeviceState, type GradeResult } from '../engine';
import { saveLabProgress } from '../lib/progress';
import { clearSession, loadSession, saveSession, type LabSession, type TermLine } from '../lib/session';

function welcome(title: string): TermLine[] {
  return [
    { kind: 'output', text: `Welcome to NetLab: ${title}` },
    { kind: 'output', text: 'Vendor: Cisco IOS (simulated)' },
    { kind: 'output', text: "Type '?' for help." },
    { kind: 'output', text: '' },
  ];
}

export default function LabPage() {
  const { labId = '' } = useParams();
  const navigate = useNavigate();
  const lab = getLab(labId);

  const [session, setSession] = useState<LabSession | null>(() => {
    if (!lab) return null;
    return loadSession(lab.id) ?? { state: lab.createState(), lines: welcome(lab.title), hintsRevealed: 0 };
  });
  const [showChecks, setShowChecks] = useState(true);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [stars, setStars] = useState(0);

  // Switching between labs via the "Next lab" button re-uses this component.
  useEffect(() => {
    if (!lab) return;
    setSession(loadSession(lab.id) ?? { state: lab.createState(), lines: welcome(lab.title), hintsRevealed: 0 });
    setResult(null);
  }, [lab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lab && session) saveSession(lab.id, session);
  }, [lab, session]);

  const live = useMemo(() => (lab && session ? grade(lab.objectives, session.state) : null), [lab, session]);

  const update = useCallback((fn: (s: LabSession) => LabSession) => setSession((s) => (s ? fn(s) : s)), []);

  function onSubmit(line: string): boolean {
    if (!session) return false;
    const p = prompt(session.state);
    const masked = isMaskedInput(session.state);
    const { state, output } = execute(session.state, line);
    const echo: TermLine = { kind: 'input', prompt: p, text: masked ? '' : line };
    const outLines: TermLine[] = output.map((text) => ({ kind: 'output', text }));
    setSession({ ...session, state, lines: [...session.lines, echo, ...outLines].slice(-2000) });
    return line.trimEnd().endsWith('?') && !masked;
  }

  if (!lab || !session) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className="text-lg font-semibold text-fg-bright">Lab not found</p>
          <Link to="/" className="text-accent hover:underline">
            Back to the lab list
          </Link>
        </div>
      </div>
    );
  }

  const state: DeviceState = session.state;
  const next = nextLab(lab.id);

  function reset() {
    clearSession(lab!.id);
    setSession({ state: lab!.createState(), lines: welcome(lab!.title), hintsRevealed: 0 });
    setResult(null);
  }

  function check() {
    const r = grade(lab!.objectives, state);
    const s = !r.passed ? 0 : session!.hintsRevealed === 0 ? 3 : session!.hintsRevealed < lab!.hints.length ? 2 : 1;
    setStars(s);
    setResult(r);
    if (r.passed) saveLabProgress(lab!.id, { score: r.score, stars: s, completedAt: new Date().toISOString() });
  }

  const passedCount = live?.objectives.filter((o) => o.passed).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <Header>
        <div className="mr-auto hidden flex-col leading-tight md:flex">
          <span className="font-semibold text-fg-bright">{lab.title}</span>
          <span className="text-[11px] text-muted">
            {lab.estimatedMinutes} min · {lab.difficulty} · {passedCount}/{lab.objectives.length} objectives
          </span>
        </div>
        <button type="button" onClick={reset} className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10">
          Reset lab
        </button>
        <Link to="/" className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2">
          ← Labs
        </Link>
      </Header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
        <aside className="min-h-0 overflow-y-auto border-b border-border bg-surface p-4 lg:border-r lg:border-b-0">
          <h2 className="text-sm font-semibold text-fg-bright">Scenario</h2>
          {lab.scenario.split('\n\n').map((p, i) => (
            <p key={i} className="mt-2 whitespace-pre-line text-sm leading-6 text-fg">
              {p}
            </p>
          ))}

          <div className="mt-5">
            {live && <Objectives result={live} showChecks={showChecks} onToggleChecks={() => setShowChecks((v) => !v)} />}
          </div>

          <button type="button" onClick={check} className="mt-5 w-full rounded-lg border border-accent/40 bg-accent-soft py-2.5 text-sm font-semibold text-accent hover:bg-accent/20">
            ▷ Check results
          </button>

          {lab.hints.length > 0 && (
            <section className="mt-5">
              <h2 className="text-sm font-semibold text-fg-bright">Hints</h2>
              <p className="text-[11px] text-muted">Revealing hints lowers your star rating for this attempt.</p>
              <ol className="mt-2 space-y-2 text-sm">
                {lab.hints.slice(0, session.hintsRevealed).map((h, i) => (
                  <li key={i} className="rounded-lg border border-border bg-surface-2 p-2 text-fg">
                    {i + 1}. {h}
                  </li>
                ))}
              </ol>
              {session.hintsRevealed < lab.hints.length && (
                <button type="button" onClick={() => update((s) => ({ ...s, hintsRevealed: s.hintsRevealed + 1 }))} className="mt-2 text-xs text-accent hover:underline">
                  Show hint {session.hintsRevealed + 1} of {lab.hints.length}
                </button>
              )}
            </section>
          )}
        </aside>

        <section className="min-h-[50vh] lg:min-h-0">
          <Terminal
            lines={session.lines}
            prompt={prompt(state)}
            masked={isMaskedInput(state)}
            onSubmit={onSubmit}
            onTab={(line) => tabComplete(state, line)}
            onClear={() => update((s) => ({ ...s, lines: [] }))}
            modeLabel={state.pendingInput ? 'password' : state.mode}
          />
        </section>

        <aside className="min-h-0 overflow-y-auto border-t border-border bg-surface p-4 lg:border-l lg:border-t-0">
          <Topology state={state} />
        </aside>
      </main>

      {result && (
        <ResultsModal
          result={result}
          stars={stars}
          labTitle={lab.title}
          commandCount={state.commandHistory.length}
          nextLabId={next?.id}
          onClose={() => setResult(null)}
          onReplay={reset}
          onNext={(id) => {
            setResult(null);
            navigate(`/lab/${id}`);
          }}
        />
      )}
    </div>
  );
}
