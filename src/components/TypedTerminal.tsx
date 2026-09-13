import { useEffect, useState } from 'react';
import { useInView, usePrefersReducedMotion } from '../lib/motion';

export interface TerminalStep {
  cmd: string;
  out?: string[];
}

export interface TerminalScene {
  /** Shown on the tab above the window. */
  label: string;
  prompt: string;
  steps: TerminalStep[];
}

interface Line {
  kind: 'cmd' | 'out';
  text: string;
  prompt?: string;
}

const sleep = (ms: number, signal: { cancelled: boolean }) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal.cancelled) clearTimeout(t);
  });

/** Everything a scene ends up showing, for the version that does not animate. */
function finished(scene: TerminalScene): Line[] {
  return scene.steps.flatMap((s) => [{ kind: 'cmd' as const, text: s.cmd, prompt: scene.prompt }, ...(s.out ?? []).map((text) => ({ kind: 'out' as const, text }))]);
}

/**
 * A terminal that types itself: real commands from the labs, with the real output,
 * cycling through one scene per learning path.
 *
 * It only runs while it is on screen, and not at all when the visitor has asked for
 * less movement, in which case the last scene is shown as it would finish.
 */
export default function TypedTerminal({ scenes, className = '' }: { scenes: TerminalScene[]; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [ref, onScreen] = useInView<HTMLDivElement>(!reduced);
  const [scene, setScene] = useState(0);
  const [lines, setLines] = useState<Line[]>(() => (reduced ? finished(scenes[0]) : []));
  const [typing, setTyping] = useState('');

  useEffect(() => {
    const current = scenes[scene];
    if (reduced) {
      setLines(finished(current));
      setTyping('');
      return;
    }
    if (!onScreen) return;

    const signal = { cancelled: false };
    const run = async () => {
      setLines([]);
      setTyping('');
      await sleep(500, signal);
      for (const step of current.steps) {
        for (let i = 1; i <= step.cmd.length; i++) {
          if (signal.cancelled) return;
          setTyping(step.cmd.slice(0, i));
          // An uneven rhythm reads as typing rather than as a machine printing.
          await sleep(26 + (step.cmd.charCodeAt(i - 1) % 5) * 11, signal);
        }
        await sleep(300, signal);
        if (signal.cancelled) return;
        setTyping('');
        setLines((l) => [...l, { kind: 'cmd', text: step.cmd, prompt: current.prompt }]);
        for (const text of step.out ?? []) {
          await sleep(60, signal);
          if (signal.cancelled) return;
          setLines((l) => [...l, { kind: 'out', text }]);
        }
        await sleep(650, signal);
      }
      await sleep(2600, signal);
      if (!signal.cancelled) setScene((s) => (s + 1) % scenes.length);
    };
    void run();
    return () => {
      signal.cancelled = true;
    };
  }, [scene, scenes, reduced, onScreen]);

  const current = scenes[scene];
  return (
    <div ref={ref} className={`card overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
        </span>
        <div className="ml-2 flex gap-1">
          {scenes.map((s, i) => (
            <span key={s.label} className={`label rounded px-2 py-0.5 transition-colors duration-500 ${i === scene ? 'bg-accent text-bg' : 'text-muted'}`}>
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <pre className="m-0 h-[330px] overflow-hidden bg-term px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-fg" aria-live="off">
        {lines.map((l, i) => (
          <div key={i} className="term-line whitespace-pre-wrap break-words">
            {l.kind === 'cmd' ? (
              <>
                <span className="text-muted">{l.prompt} </span>
                <span className="text-fg-bright">{l.text}</span>
              </>
            ) : (
              <span className="text-muted">{l.text}</span>
            )}
          </div>
        ))}
        {!reduced && (
          <div className="whitespace-pre-wrap break-words">
            <span className="text-muted">{current.prompt} </span>
            <span className="text-fg-bright">{typing}</span>
            <span className="caret" aria-hidden="true" />
          </div>
        )}
      </pre>
    </div>
  );
}
