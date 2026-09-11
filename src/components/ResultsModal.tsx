import type { GradeResult } from '../engine';
import { STAR_LEVELS } from '../lib/pathProgress';
import Icon, { NF } from './Icon';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <div className="card w-full max-w-md p-7 shadow-2xl shadow-black/50">
        <div className="mb-3 flex justify-center gap-2 text-3xl" aria-label={`${stars} of 3 stars`}>
          {[1, 2, 3].map((n) => (
            <Icon key={n} g={n <= stars ? NF.star : NF.starO} className={n <= stars ? 'text-star drop-shadow-[0_0_12px_rgba(249,226,175,0.45)]' : 'text-surface-3'} />
          ))}
        </div>
        <p className={`label text-center ${result.passed ? 'text-success' : 'text-warning'}`}>
          {result.passed ? `Lab complete · ${STAR_LEVELS.find((l) => l.stars === stars)?.label ?? ''}` : 'Not there yet'}
        </p>
        <h2 id="results-title" className="display mt-1 text-center text-xl text-fg-bright">
          {labTitle}
        </h2>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          {[
            [`${result.score}%`, 'score'],
            [String(commandCount), 'commands'],
            [`${result.objectives.filter((o) => o.passed).length}/${result.objectives.length}`, 'objectives'],
          ].map(([v, k]) => (
            <div key={k} className="rounded-xl bg-surface-2 px-2 py-2">
              <div className="font-mono text-lg font-bold text-fg-bright">{v}</div>
              <div className="label text-muted">{k}</div>
            </div>
          ))}
        </div>
        {!result.passed && (
          <ul className="mt-4 space-y-1.5 text-sm">
            {result.objectives
              .filter((o) => !o.passed)
              .map((o) => (
                <li key={o.id} className="text-fg">
                  <Icon g={NF.times} className="mr-1.5 text-danger" />
                  {o.label}
                  <ul className="ml-6 text-xs text-muted">
                    {o.checks
                      .filter((c) => !c.passed)
                      .map((c, i) => (
                        <li key={i}>
                          <Icon g={NF.circleO} className="mr-1.5 text-[9px]" />
                          {c.label}
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">
            {result.passed ? 'Close' : 'Keep working'}
          </button>
          <button type="button" onClick={onReplay} className="btn btn-ghost">
            <Icon g={NF.refresh} />
            Replay
          </button>
          {result.passed && nextLabId && (
            <button type="button" onClick={() => onNext(nextLabId)} className="btn btn-primary">
              Next lab
              <Icon g={NF.arrowRight} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
