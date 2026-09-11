import { Link } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import Icon, { NF } from '../components/Icon';
import { isLabUnlocked, labs, labsForModule, modules } from '../content';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';

function Stat({ value, label, glyph }: { value: string; label: string; glyph: string }) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon g={glyph} />
      </span>
      <div>
        <div className="font-mono text-lg font-bold leading-tight text-fg-bright">{value}</div>
        <div className="label text-muted">{label}</div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { progress, reset } = useProgress();
  const auth = useAuth();
  const completed = labs.filter((l) => progress[l.id]).length;
  const stars = labs.reduce((n, l) => n + (progress[l.id]?.stars ?? 0), 0);
  /** Labs need an account whenever the site has accounts at all. */
  const mustSignIn = auth.enabled && !auth.loading && !auth.user;

  return (
    <div className="flex h-full flex-col">
      <Header>
        {completed > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-muted"
            onClick={() => {
              if (confirm(auth.user ? 'Reset all progress and saved lab sessions, on this device and in your account?' : 'Reset all progress and saved lab sessions?')) void reset();
            }}
          >
            <Icon g={NF.refresh} />
            Reset progress
          </button>
        )}
        <AccountMenu />
      </Header>
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-16 pt-10">
        <section className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="label text-accent">
              <Icon g={NF.terminal} className="mr-1.5" />
              Cisco IOS · in your browser
            </p>
            <h1 className="display mt-2 text-4xl leading-[1.05] text-fg-bright md:text-5xl">Learn networking by doing.</h1>
            <p className="mt-3 text-[15px] leading-7 text-muted">
              Real IOS syntax, real topologies, graded live as you type. Labs unlock in order.{' '}
              {!auth.enabled ? (
                'Progress is stored on this device.'
              ) : auth.user ? (
                'Progress is saved to your account.'
              ) : (
                <>
                  <Link to="/account" className="text-accent hover:underline">
                    Sign in or create a free account
                  </Link>{' '}
                  to start; scores and stars follow you to any device.
                </>
              )}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 md:grid-cols-1 md:gap-2 lg:grid-cols-3">
            <Stat value={`${completed}/${labs.length}`} label="labs passed" glyph={NF.flag} />
            <Stat value={String(stars)} label="stars" glyph={NF.star} />
            <Stat value={String(modules.length)} label="modules" glyph={NF.book} />
          </div>
        </section>

        {modules.map((m) => {
          const items = labsForModule(m.id);
          const done = items.filter((l) => progress[l.id]).length;
          const moduleOpen = items.some((l) => isLabUnlocked(l.id, progress));
          const pct = items.length ? Math.round((done / items.length) * 100) : 0;
          return (
            <section key={m.id} className={`mt-12 ${moduleOpen ? '' : 'opacity-60'}`}>
              <div className="mb-4 flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="display flex items-center gap-2 text-2xl text-fg-bright">
                    {m.title}
                    {!moduleOpen && <Icon g={NF.lock} className="text-base text-muted" label="Locked" />}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted">{m.description}</p>
                </div>
                <div className="w-36 shrink-0 text-right">
                  <div className="label text-muted">
                    {done}/{items.length} complete
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
              <ol className="card divide-y divide-border/70 overflow-hidden">
                {items.map((lab, idx) => {
                  const p = progress[lab.id];
                  const unlocked = isLabUnlocked(lab.id, progress);
                  return (
                    <li key={lab.id} className={`flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-2/60 ${unlocked ? '' : 'opacity-60'}`}>
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${p ? 'bg-success/15 text-success' : unlocked ? 'bg-surface-3 text-fg' : 'bg-surface-2 text-muted'}`} aria-hidden>
                        {p ? <Icon g={NF.check} /> : unlocked ? String(idx + 1).padStart(2, '0') : <Icon g={NF.lock} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-fg-bright">{lab.title}</h3>
                          {lab.isExam && <span className="pill border-warning/40 text-warning">exam</span>}
                          <span className="pill">
                            {lab.difficulty} · {lab.estimatedMinutes} min
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-sm text-muted">{lab.description}</p>
                        <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
                          {lab.concepts.slice(0, 4).map((c) => (
                            <span key={c} className="pill border-transparent bg-surface-2 text-[10px]">
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {p && (
                          <span className="font-mono text-xs" aria-label={`${p.stars} stars`}>
                            {[1, 2, 3].map((n) => (
                              <Icon key={n} g={n <= p.stars ? NF.star : NF.starO} className={n <= p.stars ? 'text-star' : 'text-surface-3'} />
                            ))}
                          </span>
                        )}
                        {unlocked && mustSignIn ? (
                          <Link to={`/account?next=/lab/${lab.id}`} className="btn btn-soft btn-sm" title="Sign in to start this lab">
                            <Icon g={NF.signIn} />
                            Sign in to begin
                          </Link>
                        ) : unlocked ? (
                          <Link to={`/lab/${lab.id}`} className="btn btn-primary btn-sm">
                            {p ? 'Replay' : 'Begin'}
                            <Icon g={NF.arrowRight} />
                          </Link>
                        ) : (
                          <span className="btn btn-ghost btn-sm text-muted" title="Pass the previous lab to unlock">
                            <Icon g={NF.lock} />
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

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted">
          <span>
            <span className="display text-fg">netlab</span> · open source, MIT licensed
          </span>
          <a href="https://github.com/fejbron/netlab" className="flex items-center gap-1.5 hover:text-fg" target="_blank" rel="noreferrer">
            <Icon g={NF.github} />
            fejbron/netlab
          </a>
        </footer>
      </main>
    </div>
  );
}
