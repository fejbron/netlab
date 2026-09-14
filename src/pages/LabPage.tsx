import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header';
import Objectives from '../components/Objectives';
import ResultsModal from '../components/ResultsModal';
import Terminal from '../components/Terminal';
import Topology from '../components/Topology';
import CloudPanel from '../components/CloudPanel';
import { getLab, isLabUnlocked, labNetwork, nextLab, pathIdOfLab, pathUrl, previousLab, type Lab } from '../content';
import { applyPythonResult, executeHost, executeOn, grade, hostMaskedInput, hostPrompt, isMaskedInput, prompt, tabComplete, type GradeResult, type NetworkState, type PendingPython } from '../engine';
import { runPython } from '../lib/pyodide';
import AccountMenu from '../components/AccountMenu';
import Icon, { NF, deviceGlyph } from '../components/Icon';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';
import { starsFor } from '../lib/pathProgress';
import { clearSession, loadSession, saveSession, type LabSession, type TermLine } from '../lib/session';

function welcome(title: string, network: NetworkState, nodeId: string): TermLine[] {
  const dev = network.devices[nodeId];
  const host = network.hosts[nodeId];
  if (host?.os === 'linux' && host.linux) {
    // A database lab opens already connected, so greet the learner at the psql prompt
    // rather than telling them about a shell they are not currently in.
    const sql = host.linux.pending?.kind === 'sql' ? host.linux.databases?.[host.linux.pending.db] : undefined;
    if (sql) {
      return [
        { kind: 'output', text: `Welcome to NetLab: ${title}` },
        { kind: 'output', text: `psql (16.2, simulated) on ${host.linux.hostname}, connected to database "${sql.db.name}" as "${sql.user}".` },
        { kind: 'output', text: 'Statements end with a semicolon. \\? lists the psql commands, \\dt the tables, \\q leaves for the shell.' },
        { kind: 'output', text: '' },
      ];
    }
    if (host.linux.cloud) {
      return [
        { kind: 'output', text: `Welcome to NetLab: ${title}` },
        { kind: 'output', text: `Ubuntu 24.04.1 LTS on ${host.linux.hostname} (simulated). Terraform v1.12.2 and the netcloud CLI are installed; you are in ${host.linux.cwd.replace(/^\/home\/[^/]+/, '~')}.` },
        { kind: 'output', text: "There is no editor: write files with cat > main.tf << 'EOF' (quote EOF so ${...} is kept), or paste several lines at once." },
        { kind: 'output', text: '' },
      ];
    }
    return [
      { kind: 'output', text: `Welcome to NetLab: ${title}` },
      { kind: 'output', text: `Ubuntu 24.04.1 LTS on ${host.linux.hostname} (simulated). Logged in as ${host.linux.user}.` },
      { kind: 'output', text: "Type 'help' for the commands this shell supports; there is no editor, write files with echo > file or cat > file << 'EOF'." },
      { kind: 'output', text: '' },
    ];
  }
  const who = dev ? `${dev.hostname} (Cisco IOS ${dev.deviceType}, simulated)` : `${host?.name} (PC)`;
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
  const { progress, recordPass } = useProgress();
  const auth = useAuth();

  const [session, setSession] = useState<LabSession | null>(() => (lab ? loadSession(lab.id) ?? freshSession(lab) : null));
  const [showChecks, setShowChecks] = useState(true);
  /** Status text while python3 runs in the browser (Pyodide), or null. */
  const [pythonBusy, setPythonBusy] = useState<string | null>(null);
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
          <p className="display text-lg text-fg-bright">Lab not found</p>
          <Link to="/" className="btn btn-ghost btn-sm">
            <Icon g={NF.arrowLeft} />
            Back to the lab list
          </Link>
        </div>
      </div>
    );
  }

  // Labs require an account whenever the site has accounts.
  if (auth.enabled && auth.loading) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</div>
      </div>
    );
  }
  if (auth.enabled && !auth.user) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-accent">
            <Icon g={NF.lock} />
          </span>
          <p className="display text-xl text-fg-bright">Sign in to start {lab.title}</p>
          <p className="max-w-md text-sm leading-6 text-muted">Labs need an account so your scores and stars are saved and count on the leaderboard. It's free.</p>
          <div className="mt-2 flex gap-3">
            <Link to={`/account?next=/lab/${lab.id}`} className="btn btn-primary">
              <Icon g={NF.signIn} />
              Sign in or create an account
            </Link>
            <Link to={pathUrl(pathIdOfLab(lab))} className="btn btn-ghost">
              Lab list
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!isLabUnlocked(lab.id, progress)) {
    const prev = previousLab(lab.id);
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-2xl text-muted">
            <Icon g={NF.lock} />
          </span>
          <p className="display text-xl text-fg-bright">{lab.title} is locked</p>
          <p className="max-w-md text-sm leading-6 text-muted">
            Labs unlock in order. Pass {prev ? <strong className="text-fg">{prev.title}</strong> : 'the previous lab'} first.
          </p>
          <div className="mt-2 flex gap-3">
            {prev && (
              <Link to={`/lab/${prev.id}`} className="btn btn-primary">
                Go to {prev.title}
                <Icon g={NF.arrowRight} />
              </Link>
            )}
            <Link to={pathUrl(pathIdOfLab(lab))} className="btn btn-ghost">
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

  function runPending(nodeId: string, pending: PendingPython) {
    setPythonBusy('Running python3…');
    runPython(pending, setPythonBusy)
      .then((result) => {
        setSession((cur) => {
          if (!cur) return cur;
          const applied = applyPythonResult(cur.network, nodeId, pending, result);
          const outLines: TermLine[] = applied.output.map((text) => ({ kind: 'output', text }));
          return { ...cur, network: applied.network, lines: { ...cur.lines, [nodeId]: [...(cur.lines[nodeId] ?? []), ...outLines].slice(-2000) } };
        });
      })
      .catch((e: unknown) => {
        const text = `python3: could not start the interpreter (${e instanceof Error ? e.message : String(e)}). Check your connection and try again.`;
        setSession((cur) => (cur ? { ...cur, lines: { ...cur.lines, [nodeId]: [...(cur.lines[nodeId] ?? []), { kind: 'output', text }] } } : cur));
      })
      .finally(() => setPythonBusy(null));
  }

  /** Run lines typed (or pasted) at the active console, one after another. */
  function runLines(typed: string[]): boolean {
    if (!session || pythonBusy) return false;
    let keep = false;
    let net = network;
    let lines = session.lines[active] ?? [];
    let pending: PendingPython | undefined;
    for (const line of typed) {
      const dev = net.devices[active];
      const h = net.hosts[active];
      let echoPrompt: string;
      let masked = false;
      let output: string[];
      if (dev) {
        echoPrompt = prompt(dev);
        masked = isMaskedInput(dev);
        ({ network: net, output } = executeOn(net, active, line));
        keep = line.trimEnd().endsWith('?') && !masked;
      } else {
        echoPrompt = hostPrompt(h!);
        masked = hostMaskedInput(h!);
        ({ network: net, output, pending } = executeHost(net, active, line));
      }
      const echo: TermLine = { kind: 'input', prompt: echoPrompt, text: masked ? '' : line };
      const isClear = !dev && /^(cls|clear)$/i.test(line.trim());
      lines = isClear ? [] : [...lines, echo, ...output.map((text): TermLine => ({ kind: 'output', text }))].slice(-2000);
      // python3 runs asynchronously, so a paste stops at the first script it starts.
      if (pending) break;
    }
    setSession({ ...session, network: net, lines: { ...session.lines, [active]: lines } });
    if (pending) runPending(active, pending);
    return keep;
  }

  function onSubmit(line: string): boolean {
    return runLines([line]);
  }

  function reset() {
    clearSession(lab!.id);
    setSession(freshSession(lab!));
    setResult(null);
  }

  function check() {
    const r = grade(lab!.objectives, network);
    const s = starsFor(r.passed, session!.hintsRevealed, lab!.hints.length);
    setStars(s);
    setResult(r);
    if (r.passed) recordPass(lab!.id, { score: r.score, stars: s, completedAt: new Date().toISOString() });
  }

  const passedCount = live?.objectives.filter((o) => o.passed).length ?? 0;
  const termPrompt = device ? prompt(device) : host ? hostPrompt(host) : '';

  return (
    <div className="flex h-full flex-col">
      <Header>
        <div className="mr-auto hidden min-w-0 flex-col leading-tight md:flex">
          <span className="display truncate text-[15px] text-fg-bright">{lab.title}</span>
          <span className="label text-muted">
            {lab.estimatedMinutes} min · {lab.difficulty} · {passedCount}/{lab.objectives.length} objectives
          </span>
        </div>
        <button type="button" onClick={reset} className="btn btn-danger btn-sm">
          <Icon g={NF.refresh} />
          Reset lab
        </button>
        <Link to={pathUrl(pathIdOfLab(lab))} className="btn btn-ghost btn-sm">
          <Icon g={NF.arrowLeft} />
          Labs
        </Link>
        <AccountMenu />
      </Header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[330px_minmax(0,1fr)_340px]">
        <aside className="min-h-0 overflow-y-auto border-b border-border bg-surface/60 p-4 lg:border-r lg:border-b-0">
          <h2 className="label text-muted">
            <Icon g={NF.book} className="mr-1.5 text-accent" />
            Scenario
          </h2>
          {lab.scenario.split('\n\n').map((p, i) => (
            <p key={i} className="mt-2 whitespace-pre-line text-sm leading-6 text-fg">
              {p}
            </p>
          ))}

          <div className="mt-6">{live && <Objectives result={live} showChecks={showChecks} onToggleChecks={() => setShowChecks((v) => !v)} />}</div>

          <button type="button" onClick={check} className="btn btn-primary mt-5 w-full justify-center py-2.5">
            <Icon g={NF.play} />
            Check results
          </button>

          {lab.hints.length > 0 && (
            <section className="mt-6">
              <h2 className="label text-muted">
                <Icon g={NF.bulb} className="mr-1.5 text-warning" />
                Hints
              </h2>
              <p className="mt-0.5 text-[11px] text-muted">3 stars with no hints, 2 with some, 1 with all of them.</p>
              <ol className="mt-2 space-y-2 text-sm">
                {lab.hints.slice(0, session.hintsRevealed).map((h, i) => (
                  <li key={i} className="rounded-xl border border-warning/20 bg-warning/[0.06] px-3 py-2 text-fg">
                    <span className="mr-2 font-mono text-xs text-warning">{String(i + 1).padStart(2, '0')}</span>
                    {h}
                  </li>
                ))}
              </ol>
              {session.hintsRevealed < lab.hints.length && (
                <button type="button" onClick={() => setSession({ ...session, hintsRevealed: session.hintsRevealed + 1 })} className="btn btn-ghost btn-sm mt-2">
                  <Icon g={NF.eye} />
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
                    className={`flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 font-mono text-xs ${isActive ? 'border-border bg-term text-fg-bright' : 'border-transparent text-muted hover:text-fg'}`}
                  >
                    <Icon g={deviceGlyph(kind)} className={kind === 'router' ? 'text-warning' : kind === 'switch' ? 'text-accent-2' : 'text-muted'} />
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
              masked={device ? isMaskedInput(device) : host ? hostMaskedInput(host) : false}
              onSubmit={onSubmit}
              onTab={(line) => (device ? tabComplete(device, line) : null)}
              onClear={() => setSession({ ...session, lines: { ...session.lines, [active]: [] } })}
              questionHelp={Boolean(device)}
              onPasteLines={device ? undefined : (pasted) => void runLines(pasted)}
              modeLabel={
                pythonBusy
                  ? pythonBusy
                  : device
                    ? device.pendingInput
                      ? 'password'
                      : device.mode
                    : host?.os === 'linux'
                      ? host.linux?.pending?.kind === 'terraform'
                        ? host.linux.pending.console
                          ? 'terraform console (exit to leave)'
                          : 'terraform (waiting for an answer)'
                        : host.linux?.pending?.kind === 'sql'
                        ? host.linux.databases?.[host.linux.pending.db]?.partial
                          ? 'psql (continue…)'
                          : 'psql'
                        : host.linux?.pending?.kind === 'script'
                          ? 'bash (continue…)'
                          : host.linux?.pending?.kind === 'password'
                            ? 'password'
                            : 'bash'
                      : 'pc'
              }
            />
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto border-t border-border bg-surface/60 p-4 lg:border-l lg:border-t-0">
          {host?.linux?.cloud ? <CloudPanel network={network} hostId={active} /> : <Topology network={network} active={active} onSelect={(id) => setSession({ ...session, active: id })} />}
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
