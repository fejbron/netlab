import type { GradeResult } from '../engine';

interface Props {
  result: GradeResult;
  stars: number;
  labTitle: string;
  commandCount: number;
  nextLabId?: string;
  onClose: () => void;
  onReplay: () => void;
  onNext: (id: string) => void;
}

export default function ResultsModal({ result, stars, labTitle, commandCount, nextLabId, onClose, onReplay, onNext }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="mb-3 text-center text-3xl" aria-label={`${stars} of 3 stars`}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={n <= stars ? 'text-warning' : 'text-border'}>
              ★
            </span>
          ))}
        </div>
        <p className="text-center text-xs uppercase tracking-wide text-muted">{result.passed ? 'Lab complete' : 'Not there yet'}</p>
        <h2 id="results-title" className="mt-1 text-center text-xl font-semibold text-fg-bright">
          {labTitle}
        </h2>
        <p className="mt-3 flex justify-center gap-4 text-sm text-muted">
          <span className={result.passed ? 'text-success' : 'text-warning'}>{result.score}%</span>
          <span>{commandCount} commands</span>
          <span>
            {result.objectives.filter((o) => o.passed).length}/{result.objectives.length} objectives
          </span>
        </p>
        {!result.passed && (
          <ul className="mt-4 space-y-1 text-sm">
            {result.objectives
              .filter((o) => !o.passed)
              .map((o) => (
                <li key={o.id} className="text-fg">
                  <span className="text-danger">✗</span> {o.label}
                  <ul className="ml-5 text-xs text-muted">
                    {o.checks.filter((c) => !c.passed).map((c, i) => <li key={i}>○ {c.label}</li>)}
                  </ul>
                </li>
              ))}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2">
            {result.passed ? 'Close' : 'Keep working'}
          </button>
          <button type="button" onClick={onReplay} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2">
            Replay lab
          </button>
          {result.passed && nextLabId && (
            <button type="button" onClick={() => onNext(nextLabId)} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg hover:brightness-110">
              Next lab →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
