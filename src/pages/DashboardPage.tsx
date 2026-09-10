import { useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import { labs, labsForModule, modules } from '../content';
import { loadProgress, resetProgress } from '../lib/progress';

export default function DashboardPage() {
  const [progress, setProgress] = useState(loadProgress);
  const completed = labs.filter((l) => progress[l.id]).length;

  return (
    <div className="flex h-full flex-col">
      <Header>
        <span className="text-muted">
          {completed}/{labs.length} labs complete
        </span>
        {completed > 0 && (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg"
            onClick={() => {
              if (confirm('Reset all progress and saved lab sessions?')) {
                resetProgress();
                setProgress({});
              }
            }}
          >
            Reset progress
          </button>
        )}
      </Header>
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 py-8">
        <h1 className="display text-4xl text-fg-bright md:text-5xl">Learn networking by doing.</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Hands-on Cisco IOS labs that run entirely in your browser. No installs, no accounts, no payments. Progress is stored on this device.
        </p>

        {modules.map((m) => {
          const items = labsForModule(m.id);
          const done = items.filter((l) => progress[l.id]).length;
          return (
            <section key={m.id} className="mt-10">
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="display text-2xl text-fg-bright">{m.title}</h2>
                  <p className="text-sm text-muted">{m.description}</p>
                </div>
                <span className="text-xs text-muted">
                  {done}/{items.length} complete
                </span>
              </div>
              <ol className="space-y-2">
                {items.map((lab, idx) => {
                  const p = progress[lab.id];
                  return (
                    <li key={lab.id} className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${p ? 'border-success text-success' : 'border-border text-muted'}`}>
                        {p ? '✓' : idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-fg-bright">{lab.title}</h3>
                          {lab.isExam && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning">Exam</span>}
                          <span className="text-[11px] text-muted">
                            {lab.difficulty} · {lab.estimatedMinutes} min
                          </span>
                        </div>
                        <p className="truncate text-sm text-muted">{lab.description}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {lab.concepts.slice(0, 4).map((c) => (
                            <span key={c} className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {p && (
                          <span className="text-xs text-warning" aria-label={`${p.stars} stars`}>
                            {'★'.repeat(p.stars)}
                            <span className="text-border">{'★'.repeat(3 - p.stars)}</span>
                          </span>
                        )}
                        <Link to={`/lab/${lab.id}`} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:brightness-110">
                          {p ? 'Replay' : 'Begin'} →
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}

        <footer className="mt-16 border-t border-border pt-6 text-xs text-muted">
          NetLab is open source under the MIT license. Cisco and IOS are trademarks of Cisco Systems; this project is an independent simulator and is not affiliated with Cisco.
        </footer>
      </main>
    </div>
  );
}
