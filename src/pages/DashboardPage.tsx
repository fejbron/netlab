import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import Icon, { NF } from '../components/Icon';
import { domainCoverage, getPath, labsForModule, labsForPath, modulesForPath, paths, pathUrl, totalMinutes, type Lab, type LearningPath, type Module } from '../content';
import { useAuth } from '../lib/auth';
import { STAR_LEVELS, labState, nextAction, type LabState } from '../lib/pathProgress';
import { formatPoints, maxTotalPoints, totalPoints } from '../lib/points';
import { useProgress } from '../lib/progressStore';
import { loadSession } from '../lib/session';

function Stat({ value, label, glyph }: { value: string; label: string; glyph: string }) {
  return (
    <div className="card flex min-w-0 items-center gap-3 px-3 py-3 sm:px-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon g={glyph} />
      </span>
      <div>
        <div className="font-mono text-lg font-bold leading-tight text-fg-bright">{value}</div>
        <div className="label whitespace-nowrap text-muted">{label}</div>
      </div>
    </div>
  );
}

/** Small circular progress meter used in the stage navigator. */
function Ring({ percent, done, label }: { percent: number; done: boolean; label: string }) {
  const r = 12;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center" role="img" aria-label={label}>
      <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-surface-3" />
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - percent / 100)} className={done ? 'text-success' : 'text-accent'} />
      </svg>
      <span className={`relative font-mono text-[10px] font-bold ${done ? 'text-success' : 'text-fg'}`}>{done ? <Icon g={NF.check} /> : `${percent}`}</span>
    </span>
  );
}

function statusText(s: LabState): string {
  switch (s.status) {
    case 'completed':
      return 'Completed';
    case 'in-progress':
      return `${s.completedObjectives} of ${s.totalObjectives} objectives`;
    case 'locked':
      return 'Locked';
    default:
      return 'Not started';
  }
}

function hours(minutes: number): string {
  const h = minutes / 60;
  return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 2) / 2} h`;
}

function TopicPill({ code, topics }: { code: string; topics: Record<string, string> }) {
  return (
    <span className="pill border-accent/25 bg-accent-soft text-accent" title={`${code} ${topics[code] ?? ''}`}>
      {code}
    </span>
  );
}

/** Route wrapper: /paths/:pathId */
export function PathRoute() {
  const { pathId = '' } = useParams();
  const path = getPath(pathId);
  if (!path) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <h1 className="display text-xl text-fg-bright">No such learning path</h1>
          <Link to="/" className="text-accent hover:underline">
            Back to the home page
          </Link>
        </div>
      </div>
    );
  }
  return <DashboardPage path={path} />;
}

export default function DashboardPage({ path = paths[0] }: { path?: LearningPath }) {
  const { progress, reset } = useProgress();
  const auth = useAuth();
  /** Labs need an account whenever the site has accounts at all. */
  const mustSignIn = auth.enabled && !auth.loading && !auth.user;
  const pathModules = modulesForPath(path.id);
  const pathLabs = labsForPath(path.id);

  // Status per lab, including "in progress" from saved sessions on this device. Recomputed when progress changes.
  const states = useMemo(() => {
    const sessionFor = (id: string) => loadSession(id)?.network ?? null;
    return Object.fromEntries(pathLabs.map((l) => [l.id, labState(l, progress, sessionFor)])) as Record<string, LabState>;
  }, [progress, pathLabs]);
  const next = useMemo(() => nextAction(pathLabs, progress, states), [pathLabs, progress, states]);
  const coverage = useMemo(() => domainCoverage(path.blueprint.domains, pathModules, pathLabs, progress), [path, pathModules, pathLabs, progress]);

  const completed = pathLabs.filter((l) => progress[l.id]).length;
  const inProgress = pathLabs.filter((l) => states[l.id].status === 'in-progress').length;
  const stars = pathLabs.reduce((n, l) => n + (progress[l.id]?.stars ?? 0), 0);
  const points = totalPoints(pathLabs, progress);
  const pathPercent = pathLabs.length ? Math.round((completed / pathLabs.length) * 100) : 0;
  const started = completed > 0 || inProgress > 0;
  const complete = pathLabs.length > 0 && completed === pathLabs.length;
  const nextModule = next ? pathModules.find((m) => m.id === next.lab.moduleId) : undefined;
  const anyProgress = Object.keys(progress).length > 0;

  const moduleStats = pathModules.map((m) => {
    const items = labsForModule(m.id);
    const done = items.filter((l) => progress[l.id]).length;
    return { module: m, items, done, open: items.some((l) => states[l.id].status !== 'locked'), pct: items.length ? Math.round((done / items.length) * 100) : 0 };
  });

  function labAction(lab: Lab, s: LabState) {
    if (s.status === 'locked')
      return (
        <span className="btn btn-ghost btn-sm text-muted" title="Pass the previous lab to unlock">
          <Icon g={NF.lock} />
          Locked
        </span>
      );
    if (mustSignIn)
      return (
        <Link to={`/account?next=/lab/${lab.id}`} className="btn btn-soft btn-sm" title="Sign in to start this lab">
          <Icon g={NF.signIn} />
          Sign in to begin
        </Link>
      );
    const word = s.status === 'completed' ? 'Replay' : s.status === 'in-progress' ? 'Resume' : 'Begin';
    return (
      <Link to={`/lab/${lab.id}`} className={`btn btn-sm ${s.status === 'in-progress' ? 'btn-soft' : 'btn-primary'}`}>
        {word}
        <Icon g={NF.arrowRight} />
      </Link>
    );
  }

  const bp = path.blueprint;

  return (
    <div className="flex h-full flex-col">
      <Header>
        {anyProgress && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-muted"
            onClick={() => {
              if (confirm(auth.user ? 'Reset all progress and saved lab sessions on every path, on this device and in your account?' : 'Reset all progress and saved lab sessions on every path?')) void reset();
            }}
          >
            <Icon g={NF.refresh} />
            Reset progress
          </button>
        )}
        <AccountMenu />
      </Header>
      <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-4 pb-16 pt-10">
        {/* Path switcher */}
        <nav className="mb-6 flex flex-wrap gap-2" aria-label="Learning paths">
          {paths.map((p) => {
            const items = labsForPath(p.id);
            const done = items.filter((l) => progress[l.id]).length;
            const current = p.id === path.id;
            return (
              <Link key={p.id} to={pathUrl(p.id)} className={`flex items-center gap-3 rounded-xl border px-3.5 py-2 transition-colors ${current ? 'border-accent/50 bg-accent-soft' : 'border-border bg-surface hover:border-border-strong'}`} aria-current={current ? 'page' : undefined}>
                <Icon g={p.id === 'linux' ? NF.code : NF.exchange} className={current ? 'text-accent' : 'text-muted'} />
                <span className="min-w-0">
                  <span className={`block text-sm font-semibold ${current ? 'text-fg-bright' : 'text-fg'}`}>{p.title}</span>
                  <span className="label block text-muted">
                    {done}/{items.length} labs · {p.levelLabel}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Path header */}
        <section className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="label text-accent">
              <Icon g={NF.terminal} className="mr-1.5" />
              {path.scopeLabel} · {path.levelLabel}
            </p>
            <h1 className="display mt-2 text-4xl leading-[1.05] text-fg-bright md:text-5xl">{path.title}</h1>
            <p className="mt-3 text-[15px] leading-7 text-muted">
              {path.summary} Graded live as you type. Labs unlock in order.{' '}
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
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
              <span>
                <Icon g={NF.flag} className="mr-1.5 text-accent" />
                {pathLabs.length} labs
              </span>
              <span>
                <Icon g={NF.book} className="mr-1.5 text-accent" />
                {pathModules.length} modules
              </span>
              <span>
                <Icon g={NF.clock} className="mr-1.5 text-accent" />
                about {hours(totalMinutes(pathLabs))}
              </span>
              <span className="flex flex-wrap gap-1">
                {path.skillTags.map((t) => (
                  <span key={t} className="pill border-transparent bg-surface-2">
                    {t}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-[repeat(3,minmax(0,1fr))] gap-2 md:grid-cols-1 lg:grid-cols-[repeat(3,minmax(0,1fr))]">
            <Stat value={`${completed}/${pathLabs.length}`} label="labs passed" glyph={NF.flag} />
            <Stat value={formatPoints(points)} label="points" glyph={NF.trophy} />
            <Stat value={String(stars)} label="stars" glyph={NF.star} />
          </div>
        </section>

        {/* Next action */}
        {next && (
          <section className="card mt-8 flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6" aria-labelledby="next-heading">
            <div className="min-w-0">
              <p className="label text-muted">{complete ? 'Path complete' : started ? 'Continue your course' : 'Choose your first lab'}</p>
              <h2 id="next-heading" className="display mt-1 truncate text-xl text-fg-bright">
                {nextModule?.title} · {next.lab.title}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {next.reason === 'resume'
                  ? `${states[next.lab.id].completedObjectives} of ${states[next.lab.id].totalObjectives} objectives done. Your console is saved on this device.`
                  : next.reason === 'review'
                    ? 'Every lab is passed. Replay any lab to improve its stars.'
                    : `${next.lab.difficulty} · ${next.lab.estimatedMinutes} min · ${next.lab.description}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-5">
              <span className="display text-5xl leading-none text-fg-bright" aria-label={`${pathPercent} percent of the path complete`}>
                {pathPercent}%
              </span>
              <div className="w-44">
                {mustSignIn ? (
                  <Link to={`/account?next=/lab/${next.lab.id}`} className="btn btn-primary w-full justify-center py-2.5">
                    <Icon g={NF.signIn} />
                    Sign in to begin
                  </Link>
                ) : (
                  <Link to={`/lab/${next.lab.id}`} className="btn btn-primary w-full justify-center py-2.5">
                    {next.reason === 'resume' ? 'Resume' : next.reason === 'review' ? 'Review' : 'Start'}
                    <Icon g={NF.arrowRight} />
                  </Link>
                )}
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pathPercent} aria-valuemin={0} aria-valuemax={100}>
                  <div className={`h-full rounded-full transition-[width] ${complete ? 'bg-success' : 'bg-accent'}`} style={{ width: `${pathPercent}%` }} />
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="mt-10 grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)]">
          {/* Stage navigator */}
          <nav className="min-w-0 lg:sticky lg:top-20 lg:self-start" aria-label="Course stages">
            <p className="label mb-2 text-muted">Stages</p>
            <ol className="flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
              {moduleStats.map(({ module: m, items, done, open, pct }, i) => {
                const current = nextModule?.id === m.id;
                return (
                  <li key={m.id} className="shrink-0">
                    <a href={`#${m.id}`} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2 ${current ? 'bg-surface-2' : ''} ${open ? '' : 'opacity-60'}`} aria-current={current ? 'step' : undefined}>
                      <Ring percent={pct} done={done === items.length} label={`${done} of ${items.length} labs passed`} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-fg-bright">
                          <span className="mr-1.5 font-mono text-[10px] text-muted">{String(i + 1).padStart(2, '0')}</span>
                          {m.title}
                        </span>
                        <span className="label block text-muted">
                          {done}/{items.length} labs
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* Modules */}
          <div className="min-w-0">
            {moduleStats.map(({ module: m, items, done, open, pct }, mi) => (
              <section key={m.id} id={m.id} className={`scroll-mt-20 ${mi ? 'mt-12' : ''} ${open ? '' : 'opacity-60'}`}>
                <div className="mb-4 flex items-end justify-between gap-4">
                  <div className="min-w-0">
                    <p className="label text-muted">Stage {mi + 1}</p>
                    <h2 className="display flex items-center gap-2 text-2xl text-fg-bright">
                      {m.title}
                      {!open && <Icon g={NF.lock} className="text-base text-muted" label="Locked" />}
                    </h2>
                    <p className="mt-0.5 text-sm text-muted">{m.description}</p>
                    {m.examTopics && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <span className="label mr-1 text-muted">Exam topics</span>
                        {m.examTopics.map((t) => (
                          <TopicPill key={t} code={t} topics={bp.topics} />
                        ))}
                      </div>
                    )}
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
                    const s = states[lab.id];
                    const unlocked = s.status !== 'locked';
                    const current = next?.lab.id === lab.id;
                    return (
                      <li key={lab.id} className={`flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-2/60 ${unlocked ? '' : 'opacity-60'} ${current ? 'bg-accent-soft/60' : ''}`}>
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${p ? 'bg-success/15 text-success' : s.status === 'in-progress' ? 'bg-accent-soft text-accent' : unlocked ? 'bg-surface-3 text-fg' : 'bg-surface-2 text-muted'}`}
                          aria-hidden
                        >
                          {p ? <Icon g={NF.check} /> : unlocked ? String(idx + 1).padStart(2, '0') : <Icon g={NF.lock} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold text-fg-bright">{lab.title}</h3>
                            <span className={`pill ${lab.isExam ? 'border-warning/40 text-warning' : ''}`}>{lab.isExam ? 'exam' : 'lab'}</span>
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
                          <span className={`label ${s.status === 'completed' ? 'text-success' : s.status === 'in-progress' ? 'text-accent' : 'text-muted'}`}>{statusText(s)}</span>
                          {p && (
                            <span className="font-mono text-xs" aria-label={`${p.stars} stars`}>
                              {[1, 2, 3].map((n) => (
                                <Icon key={n} g={n <= p.stars ? NF.star : NF.starO} className={n <= p.stars ? 'text-star' : 'text-surface-3'} />
                              ))}
                            </span>
                          )}
                          {labAction(lab, s)}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}

            {/* Outcomes and path notes */}
            <section className="mt-14 grid gap-8 border-t border-border pt-8 md:grid-cols-2" aria-labelledby="outcomes-heading">
              <div>
                <h2 id="outcomes-heading" className="display text-lg text-fg-bright">
                  What you will be able to do
                </h2>
                <ul className="mt-3 space-y-2">
                  {path.outcomes.map((o) => (
                    <li key={o} className="flex gap-2.5 text-sm leading-6 text-fg">
                      <Icon g={NF.check} className="mt-1.5 text-[11px] text-accent" />
                      <span>{o}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <dl className="space-y-4 text-sm">
                <div>
                  <dt className="label text-muted">Designed for</dt>
                  <dd className="mt-1 leading-6 text-fg">{path.audience}</dd>
                </div>
                <div>
                  <dt className="label text-muted">Recommended knowledge</dt>
                  <dd className="mt-1 leading-6 text-fg">{path.prerequisites}</dd>
                </div>
                <div>
                  <dt className="label text-muted">How stars and points work</dt>
                  <dd className="mt-1.5 space-y-1">
                    {STAR_LEVELS.filter((l) => l.stars > 0).map((l) => (
                      <div key={l.stars} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-1.5">
                        <span className="font-mono text-xs" aria-label={`${l.stars} stars`}>
                          {[1, 2, 3].map((n) => (
                            <Icon key={n} g={n <= l.stars ? NF.star : NF.starO} className={n <= l.stars ? 'text-star' : 'text-surface-3'} />
                          ))}
                        </span>
                        <span className="text-fg-bright">{l.label}</span>
                        <span className="text-xs text-muted">{l.description}</span>
                      </div>
                    ))}
                    <p className="pt-1 text-xs leading-5 text-muted">
                      Points follow from the stars: a lab is worth 100 at Beginner, 200 at Intermediate and 300 at Advanced, an exam counts double, and you keep the full value at three stars, 70% at two and 40% at one. This path is worth {formatPoints(maxTotalPoints(pathLabs))} points.
                    </p>
                  </dd>
                </div>
              </dl>
            </section>

            {/* Exam blueprint */}
            <section className="card mt-10 overflow-hidden" aria-labelledby="blueprint-heading">
              <div className="grid xl:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
                <div className="p-5 sm:p-7">
                  <p className="label text-accent">
                    <Icon g={NF.gradCap} className="mr-1.5" />
                    Exam blueprint
                  </p>
                  <h2 id="blueprint-heading" className="display mt-2 text-2xl text-fg-bright">
                    {bp.version}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    {bp.intro} Reviewed {bp.reviewedAt}.
                  </p>
                  <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
                    {bp.facts.map((f) => (
                      <div key={f.label} className="bg-surface-2 p-3">
                        <dt className="label text-muted">{f.label}</dt>
                        <dd className="display mt-1 text-lg text-fg-bright">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <aside className="border-t border-border bg-surface-2/50 p-5 sm:p-7 xl:border-l xl:border-t-0">
                  <h3 className="label text-muted">Sources</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {bp.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                          {s.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-xs leading-5 text-muted">{bp.weightingNote}</p>
                </aside>
              </div>
              <ol className="divide-y divide-border/70 border-t border-border">
                {coverage.map((d) => (
                  <li key={d.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-center sm:px-7">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="font-semibold text-fg-bright">
                          <span className="mr-2 font-mono text-xs text-muted">{/^\d+$/.test(d.id) ? `${d.id}.0` : d.id}</span>
                          {d.title}
                        </h3>
                        <span className="pill">{d.weight}% of the exam</span>
                      </div>
                      {d.labs > 0 ? (
                        <>
                          <p className="mt-1 text-xs text-muted">
                            {d.labs} labs in {d.modules.map((m: Module) => m.title).join(', ')}
                          </p>
                          <ul className="mt-2 space-y-0.5 text-xs text-muted">
                            {d.topics.map((t) => (
                              <li key={t}>
                                <span className="mr-1.5 font-mono text-accent">{t}</span>
                                {bp.topics[t]}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-muted">Not covered by NetLab yet. Study this domain from the official sources.</p>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="label text-muted">{d.labs > 0 ? `${d.completed}/${d.labs} passed` : 'no labs yet'}</div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={d.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.title} progress`}>
                        <div className={`h-full rounded-full transition-[width] ${d.percent === 100 ? 'bg-success' : 'bg-accent'}`} style={{ width: `${d.percent}%` }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="border-t border-border px-5 py-4 text-xs leading-5 text-muted sm:px-7">{bp.trademarkNotice}</p>
            </section>
          </div>
        </div>

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
