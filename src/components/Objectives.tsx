import type { GradeResult } from '../engine';

interface Props {
  result: GradeResult;
  showChecks: boolean;
  onToggleChecks: () => void;
}

function Dot({ done }: { done: boolean }) {
  return (
    <span
      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${
        done ? 'border-success bg-success/20 text-success' : 'border-border text-transparent'
      }`}
      aria-hidden
    >
      ✓
    </span>
  );
}

export default function Objectives({ result, showChecks, onToggleChecks }: Props) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-bright">Objectives</h2>
        <button type="button" onClick={onToggleChecks} className="text-[11px] text-muted hover:text-fg">
          {showChecks ? 'Hide steps' : 'Show steps'}
        </button>
      </div>
      <ol className="space-y-2">
        {result.objectives.map((o) => (
          <li key={o.id} className={`rounded-lg border p-3 ${o.passed ? 'border-success/40 bg-success/5' : 'border-border bg-surface'}`}>
            <div className="flex gap-2 text-sm">
              <Dot done={o.passed} />
              <span className={o.passed ? 'text-fg-bright' : 'text-fg'}>{o.label}</span>
            </div>
            {showChecks && (
              <ul className="mt-2 space-y-1 pl-6 text-xs">
                {o.checks.map((c, i) => (
                  <li key={i} className={`flex gap-2 ${c.passed ? 'text-success' : 'text-muted'}`}>
                    <span aria-hidden>{c.passed ? '✓' : '○'}</span>
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
