import { Link } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import { isLabUnlocked, labs, labsForModule, modules } from '../content';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';

export default function DashboardPage() {
  const { progress, reset } = useProgress();
  const auth = useAuth();
  const completed = labs.filter((l) => progress[l.id]).length;
  /** Labs need an account whenever the site has accounts at all. */
  const mustSignIn = auth.enabled && !auth.loading && !auth.user;

  return (
    <div className="flex h-full flex-col">
      <Header>
        <AccountMenu />
        <span className="text-muted">
          {completed}/{labs.length} labs complete
        </span>
        {completed > 0 && (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg"
            onClick={() => {
              if (confirm(auth.user ? 'Reset all progress and saved lab sessions, on this device and in your account?' : 'Reset all progress and saved lab sessions?')) void reset();
            }}
          >
            Reset progress
          </button>
        )}
      </Header>
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 py-8">
        <h1 className="display text-4xl text-fg-bright md:text-5xl">Learn networking by doing.</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Hands-on Cisco IOS labs that run entirely in your browser. No installs, no payments. Labs unlock in order: pass one to open the next.{' '}
          {!auth.enabled ? (
            'Progress is stored on this device.'
          ) : auth.user ? (
            'Progress is saved to your account.'
          ) : (
            <>
              <Link to="/account" className="text-accent hover:underline">
                Sign in or create a free account
              </Link>{' '}
              to start the labs; your scores and stars follow you to any device.
            </>
          )}
        </p>

        {modules.map((m) => {
          const items = labsForModule(m.id);
          const done = items.filter((l) => progress[l.id]).length;
          const moduleOpen = items.some((l) => isLabUnlocked(l.id, progress));
          return (
            <section key={m.id} className={`mt-10 ${moduleOpen ? '' : 'opacity-60'}`}>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="display text-2xl text-fg-bright">
                    {m.title}
                    {!moduleOpen && <span className="ml-2 text-base not-italic text-muted">🔒</span>}
                  </h2>
                  <p className="text-sm text-muted">{m.description}</p>
                </div>
                <span className="text-xs text-muted">
                  {done}/{items.length} complete
                </span>
              </div>
              <ol className="space-y-2">
                {items.map((lab, idx) => {
                  const p = progress[lab.id];
                  const unlocked = isLabUnlocked(lab.id, progress);
                  return (
                    <li key={lab.id} className={`flex items-center gap-4 rounded-xl border border-border bg-surface p-4 ${unlocked ? '' : 'opacity-70'}`}>
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${p ? 'border-success text-success' : unlocked ? 'border-border text-muted' : 'border-border text-muted'}`} aria-hidden>
                        {p ? '✓' : unlocked ? idx + 1 : '🔒'}
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
                        {unlocked && mustSignIn ? (
                          <Link to={`/account?next=/lab/${lab.id}`} className="rounded-lg border border-accent px-4 py-1.5 text-sm font-semibold text-accent hover:bg-accent-soft" title="Sign in to start this lab">
                            Sign in to begin
                          </Link>
                        ) : unlocked ? (
                          <Link to={`/lab/${lab.id}`} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:brightness-110">
                            {p ? 'Replay' : 'Begin'} →
                          </Link>
                        ) : (
                          <span className="rounded-lg border border-border px-4 py-1.5 text-sm text-muted" title="Pass the previous lab to unlock">
                            Locked
                          </span>
                        )}
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
