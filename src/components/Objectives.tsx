import type { GradeResult } from '../engine';
import Icon, { NF } from './Icon';

interface Props {
  result: GradeResult;
  showChecks: boolean;
  onToggleChecks: () => void;
}

export default function Objectives({ result, showChecks, onToggleChecks }: Props) {
  const done = result.objectives.filter((o) => o.passed).length;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="label text-muted">
          Objectives <span className="text-fg-bright">{done}</span>/{result.objectives.length}
        </h2>
        <button type="button" onClick={onToggleChecks} className="text-[11px] text-muted hover:text-fg">
          {showChecks ? 'Hide steps' : 'Show steps'}
        </button>
      </div>
      <ol className="space-y-1.5">
        {result.objectives.map((o, idx) => (
          <li key={o.id} className={`rounded-xl border px-3 py-2.5 transition-colors ${o.passed ? 'border-success/30 bg-success/[0.06]' : 'border-border bg-surface-2/60'}`}>
            <div className="flex items-start gap-2.5 text-sm">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] ${o.passed ? 'bg-success text-bg' : 'bg-surface-3 font-mono text-muted'}`} aria-hidden>
                {o.passed ? <Icon g={NF.check} /> : idx + 1}
              </span>
              <span className={o.passed ? 'text-fg-bright' : 'text-fg'}>{o.label}</span>
            </div>
            {showChecks && (
              <ul className="mt-1.5 space-y-1 pl-7 text-xs">
                {o.checks.map((c, i) => (
                  <li key={i} className={`flex gap-2 ${c.passed ? 'text-success' : 'text-muted'}`}>
                    <Icon g={c.passed ? NF.check : NF.circleO} className="mt-0.5 text-[10px]" />
                    <span>{c.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
