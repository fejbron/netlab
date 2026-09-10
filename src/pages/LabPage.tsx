import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header';
import Objectives from '../components/Objectives';
import ResultsModal from '../components/ResultsModal';
import Terminal from '../components/Terminal';
import Topology from '../components/Topology';
import { getLab, isLabUnlocked, labNetwork, nextLab, previousLab, type Lab } from '../content';
import { executeHost, executeOn, grade, hostPrompt, isMaskedInput, prompt, tabComplete, type GradeResult, type NetworkState } from '../engine';
import { loadProgress, loadUnlockAll, saveLabProgress } from '../lib/progress';
import { clearSession, loadSession, saveSession, type LabSession, type TermLine } from '../lib/session';

function welcome(title: string, network: NetworkState, nodeId: string): TermLine[] {
  const dev = network.devices[nodeId];
  const who = dev ? `${dev.hostname} (Cisco IOS ${dev.deviceType}, simulated)` : `${network.hosts[nodeId]?.name} (PC)`;
  return [
    { kind: 'output', text: `Welcome to NetLab: ${title}` },
    { kind: 'output', text: `Console: ${who}` },
    { kind: 'output', text: dev ? "Type '?' for help." : "Type 'help' for the available commands." },
    { kind: 'output', text: '' },
  ];
}

function freshSession(lab: Lab): LabSession {
  const network = labNetwork(lab);
  const lines: Record<string, TermLine[]> = {};
  for (const id of [...Object.keys(network.devices), ...Object.keys(network.hosts)]) lines[id] = welcome(lab.title, network, id);
  return { network, lines, active: network.primary, hintsRevealed: 0 };
}

export default function LabPage() {
  const { labId = '' } = useParams();
  const navigate = useNavigate();
  const lab = getLab(labId);

  const [session, setSession] = useState<LabSession | null>(() => (lab ? loadSession(lab.id) ?? freshSession(lab) : null));
  const [showChecks, setShowChecks] = useState(true);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [stars, setStars] = useState(0);

  // "Next lab" re-uses this component with a new id.
  useEffect(() => {
    if (!lab) return;
    setSession(loadSession(lab.id) ?? freshSession(lab));
    setResult(null);
  }, [lab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lab && session) saveSession(lab.id, session);
  }, [lab, session]);

  const live = useMemo(() => (lab && session ? grade(lab.objectives, session.network) : null), [lab, session]);

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

  if (!isLabUnlocked(lab.id, loadProgress(), loadUnlockAll())) {
    const prev = previousLab(lab.id);
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-3xl" aria-hidden>
            🔒
          </p>
          <p className="text-lg font-semibold text-fg-bright">{lab.title} is locked</p>
          <p className="max-w-md text-sm text-muted">Labs unlock in order. Pass {prev ? <strong className="text-fg">{prev.title}</strong> : 'the previous lab'} first, or turn on "Unlock all labs" on the lab list.</p>
          <div className="flex gap-3">
            {prev && (
              <Link to={`/lab/${prev.id}`} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:brightness-110">
                Go to {prev.title} →
              </Link>
            )}
            <Link to="/" className="rounded-lg border border-border px-4 py-1.5 text-sm hover:bg-surface-2">
              Lab list
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { network, active } = session;
  const device = network.devices[active];
  const host = network.hosts[active];
  const next = nextLab(lab.id);
  const nodeIds = [...Object.keys(network.devices), ...Object.keys(network.hosts)];
  const commandCount = Object.values(network.devices).reduce((n, d) => n + d.commandHistory.length, 0) + Object.values(network.hosts).reduce((n, h) => n + h.commandHistory.length, 0);

  function onSubmit(line: string): boolean {
    if (!session) return false;
    let keep = false;
    let echoPrompt: string;
    let masked = false;
    let nextNetwork: NetworkState;
    let output: string[];
    if (device) {
      echoPrompt = prompt(device);
      masked = isMaskedInput(device);
      ({ network: nextNetwork, output } = executeOn(network, active, line));
      keep = line.trimEnd().endsWith('?') && !masked;
    } else {
      echoPrompt = hostPrompt(host!);
      ({ network: nextNetwork, output } = executeHost(network, active, line));
    }
    const echo: TermLine = { kind: 'input', prompt: echoPrompt, text: masked ? '' : line };
    const outLines: TermLine[] = output.map((text) => ({ kind: 'output', text }));
    const isClear = !device && /^(cls|clear)$/i.test(line.trim());
    setSession({ ...session, network: nextNetwork, lines: { ...session.lines, [active]: isClear ? [] : [...(session.lines[active] ?? []), echo, ...outLines].slice(-2000) } });
    return keep;
  }

  function reset() {
    clearSession(lab!.id);
    setSession(freshSession(lab!));
    setResult(null);
  }

  function check() {
    const r = grade(lab!.objectives, network);
    const s = !r.passed ? 0 : session!.hintsRevealed === 0 ? 3 : session!.hintsRevealed < lab!.hints.length ? 2 : 1;
    setStars(s);
    setResult(r);
    if (r.passed) saveLabProgress(lab!.id, { score: r.score, stars: s, completedAt: new Date().toISOString() });
  }

  const passedCount = live?.objectives.filter((o) => o.passed).length ?? 0;
  const termPrompt = device ? prompt(device) : host ? hostPrompt(host) : '';

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

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
        <aside className="min-h-0 overflow-y-auto border-b border-border bg-surface p-4 lg:border-r lg:border-b-0">
          <h2 className="text-sm font-semibold text-fg-bright">Scenario</h2>
          {lab.scenario.split('\n\n').map((p, i) => (
            <p key={i} className="mt-2 whitespace-pre-line text-sm leading-6 text-fg">
              {p}
            </p>
          ))}

          <div className="mt-5">{live && <Objectives result={live} showChecks={showChecks} onToggleChecks={() => setShowChecks((v) => !v)} />}</div>

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
                <button type="button" onClick={() => setSession({ ...session, hintsRevealed: session.hintsRevealed + 1 })} className="mt-2 text-xs text-accent hover:underline">
                  Show hint {session.hintsRevealed + 1} of {lab.hints.length}
                </button>
              )}
            </section>
          )}
        </aside>

        <section className="flex min-h-[50vh] flex-col lg:min-h-0">
          {nodeIds.length > 1 && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface px-2 pt-2" role="tablist" aria-label="Device consoles">
              {nodeIds.map((id) => {
                const d = network.devices[id];
                const label = d ? d.hostname : network.hosts[id].name;
                const kind = d ? d.deviceType : 'pc';
                const isActive = id === active;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setSession({ ...session, active: id })}
                    className={`rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-medium ${isActive ? 'border-border bg-term text-fg-bright' : 'border-transparent text-muted hover:text-fg'}`}
                  >
                    <span className="mr-1 text-[10px] uppercase text-muted">{kind}</span>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <Terminal
              key={active}
              lines={session.lines[active] ?? []}
              prompt={termPrompt}
              masked={device ? isMaskedInput(device) : false}
              onSubmit={onSubmit}
              onTab={(line) => (device ? tabComplete(device, line) : null)}
              onClear={() => setSession({ ...session, lines: { ...session.lines, [active]: [] } })}
              modeLabel={device ? (device.pendingInput ? 'password' : device.mode) : 'pc'}
            />
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto border-t border-border bg-surface p-4 lg:border-l lg:border-t-0">
          <Topology network={network} active={active} onSelect={(id) => setSession({ ...session, active: id })} />
        </aside>
      </main>

      {result && (
        <ResultsModal
          result={result}
          stars={stars}
          labTitle={lab.title}
          commandCount={commandCount}
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
