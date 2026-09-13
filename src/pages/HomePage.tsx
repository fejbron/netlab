import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AccountMenu from '../components/AccountMenu';
import Header from '../components/Header';
import Icon, { NF } from '../components/Icon';
import Reveal from '../components/Reveal';
import TypedTerminal, { type TerminalScene } from '../components/TypedTerminal';
import { labs, labsForPath, modules, modulesForPath, paths, pathUrl, totalMinutes } from '../content';
import { useInView, usePrefersReducedMotion } from '../lib/motion';
import { maxTotalPoints } from '../lib/points';

/**
 * What the terminal types. Every command and every line of output below is what the
 * engines actually produce, including the two mistakes: the point of the page is that
 * the errors are real, so inventing them here would be the wrong kind of demonstration.
 */
const SCENES: TerminalScene[] = [
  {
    label: 'CCNA',
    prompt: 'Branch-SW1#',
    steps: [
      { cmd: 'show vlan breif', out: ['                 ^', "% Invalid input detected at '^' marker.", ''] },
      {
        cmd: 'show vlan brief',
        out: ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- ---------------', '1    default                          active    Gi0/3, Gi0/4', '10   SALES                            active    Gi0/1', '20   HR                               active    Gi0/2'],
      },
    ],
  },
  {
    label: 'Linux',
    prompt: 'student@web1:~$',
    steps: [
      { cmd: 'sudo nginx -t', out: ['nginx: [emerg] unexpected end of file, expecting "}" in /etc/nginx/sites-enabled/netlab:14', 'nginx: configuration file /etc/nginx/nginx.conf test failed'] },
      { cmd: 'sudo systemctl reload nginx', out: ['Job for nginx.service failed. The old configuration is still serving.'] },
    ],
  },
  {
    label: 'SQL',
    prompt: 'shop=#',
    steps: [
      { cmd: 'SELECT name FROM customers WHERE city = NULL;', out: [' name', '------', '(0 rows)', ''] },
      { cmd: 'SELECT name FROM customers WHERE city IS NULL;', out: [' name', '------------', ' Cleo Marsh', '(1 row)'] },
    ],
  },
];

/** Counts up to its value the first time it is seen, because a number that moves is read. */
function Counter({ to, suffix = '' }: { to: number; suffix?: string }) {
  const reduced = usePrefersReducedMotion();
  const [ref, seen] = useInView<HTMLSpanElement>(!reduced);
  const [n, setN] = useState(reduced ? to : 0);

  useEffect(() => {
    if (reduced || !seen) return;
    let raf = 0;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 900);
      // Ease out, so it slows into the final number rather than stopping dead.
      setN(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced, to]);

  return (
    <span ref={ref} className="font-mono tabular-nums">
      {n.toLocaleString('en-US')}
      {suffix}
    </span>
  );
}

/** The objectives panel ticking itself off, which is what grading looks like in a lab. */
function GradedLive() {
  const reduced = usePrefersReducedMotion();
  const items = ['VLAN 10 exists and is named SALES', 'g0/1 is an access port in VLAN 10', 'The trunk to R1 carries both VLANs', 'PC-A can reach PC-B'];
  const [done, setDone] = useState(reduced ? items.length : 0);
  const [ref, seen] = useInView<HTMLDivElement>(!reduced);

  useEffect(() => {
    if (reduced || !seen) return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setDone(n);
      if (n >= items.length) clearInterval(id);
    }, 700);
    return () => clearInterval(id);
  }, [seen, reduced, items.length]);

  return (
    <div ref={ref} className="card p-4">
      <p className="label mb-3 text-muted">
        Objectives {Math.min(done, items.length)}/{items.length}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((text, i) => {
          const passed = i < done;
          return (
            <li key={text} className="flex items-start gap-2.5 text-[13px]">
              <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${passed ? 'border-accent bg-accent text-bg' : 'border-border text-transparent'}`}>
                <span className="tick" data-done={passed}>
                  <Icon g={NF.check} />
                </span>
              </span>
              <span className={passed ? 'text-fg-bright' : 'text-muted'}>{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A small topology with a packet running along the links, for the "real forwarding" claim. */
function Topology() {
  const reduced = usePrefersReducedMotion();
  const link = 'M 28 96 L 96 44 L 176 44 L 244 96';
  return (
    <div className="card p-4">
      <p className="label mb-2 text-muted">Packets take a real path</p>
      <svg viewBox="0 0 272 120" className="w-full" role="img" aria-label="PC-A connects through two switches to PC-B">
        <path d={link} fill="none" stroke="var(--color-border-strong)" strokeWidth="1.5" />
        {[
          { x: 28, y: 96, label: 'PC-A' },
          { x: 96, y: 44, label: 'SW1' },
          { x: 176, y: 44, label: 'SW2' },
          { x: 244, y: 96, label: 'PC-B' },
        ].map((n) => (
          <g key={n.label}>
            <rect x={n.x - 22} y={n.y - 13} width="44" height="26" rx="7" fill="var(--color-surface-2)" stroke="var(--color-border-strong)" />
            <text x={n.x} y={n.y + 4} textAnchor="middle" className="font-mono" fontSize="9" fill="var(--color-fg)">
              {n.label}
            </text>
          </g>
        ))}
        {!reduced && <circle r="3.5" fill="var(--color-accent)" className="packet" style={{ offsetPath: `path('${link}')` }} />}
      </svg>
    </div>
  );
}

const FEATURES = [
  { glyph: NF.terminal, title: 'Real engines, not screenshots', body: 'A command resolver with prefix abbreviation and context help, a packet-forwarding simulation, a Bash subset over a permissioned filesystem, and a SQL parser and planner written from scratch.' },
  { glyph: NF.warning, title: 'Errors that teach', body: "Mistype a command and you get the caret and the marker. Break an nginx file and nginx -t names the file and the line. Break a constraint and the database names the key that already exists." },
  { glyph: NF.check, title: 'Graded as you type', body: 'Objectives check the state of the device, the filesystem or the database, not the text you typed, so any route to the right answer counts.' },
  { glyph: NF.cloud, title: 'Nothing to install', body: 'It all runs in the browser. No virtual machines, no images to download, no licences. Open a tab and start.' },
];

export default function HomePage() {
  const hours = Math.round(totalMinutes(labs) / 60);
  return (
    // Plain block flow rather than a flex column: a flex child that hides its overflow
    // gets min-height 0 and collapses, which silently clipped the whole hero.
    <div className="h-full overflow-y-auto">
      <Header>
        <AccountMenu />
      </Header>

      {/* ------------------------------------------------------------- hero */}
      <section className="grid-bg relative overflow-hidden border-b border-border/60">
        <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-4 pb-16 pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-14 lg:pb-24 lg:pt-20">
          <div>
            <Reveal>
              <p className="label text-accent">
                <Icon g={NF.terminal} className="mr-1.5" />
                Open source · runs in your browser
              </p>
            </Reveal>
            <Reveal delay={80}>
              {/* No forced break: the line wraps where the width allows, and only the
                  closing clause is held together so it never splits across lines. */}
              <h1 className="display mt-3 text-4xl leading-[1.08] text-fg-bright sm:text-5xl lg:text-6xl">
                Learn the command line{' '}
                <span className="whitespace-nowrap">
                  by <span className="underline decoration-accent/40 underline-offset-[6px]">using</span> it.
                </span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-5 max-w-xl text-[15px] leading-7 text-muted">
                NetLab simulates a Cisco network, a Linux server and a PostgreSQL database well enough to get them wrong. You type real commands, they answer the way the real things answer, and every objective is checked against what actually happened.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to={pathUrl(paths[0].id)} className="btn btn-primary px-4 py-2.5">
                  <Icon g={NF.play} />
                  Start with {paths[0].shortTitle}
                </Link>
                <a href="#paths" className="btn btn-ghost px-4 py-2.5">
                  See all {paths.length} paths
                  <Icon g={NF.arrowRight} />
                </a>
              </div>
            </Reveal>
            <Reveal delay={320}>
              <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-border pt-6">
                {[
                  { label: 'Labs', value: <Counter to={labs.length} /> },
                  { label: 'Modules', value: <Counter to={modules.length} /> },
                  { label: 'Hours of practice', value: <Counter to={hours} /> },
                ].map((s) => (
                  <div key={s.label}>
                    <dd className="display text-2xl text-fg-bright sm:text-3xl">{s.value}</dd>
                    <dt className="label mt-1 text-muted">{s.label}</dt>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>
          <Reveal delay={200}>
            <TypedTerminal scenes={SCENES} />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ paths */}
      <section id="paths" className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16 lg:py-20">
        <Reveal>
          <p className="label text-accent">Learning paths</p>
          <h2 className="display mt-2 text-3xl text-fg-bright">Three courses, one terminal</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Each path unlocks lab by lab and ends in exams that put the whole thing together. Start anywhere; they do not depend on each other.</p>
        </Reveal>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {paths.map((p, i) => {
            const list = labsForPath(p.id);
            return (
              <Reveal key={p.id} delay={i * 110}>
                <Link to={pathUrl(p.id)} className="card lift flex h-full flex-col p-5">
                  <p className="label text-muted">{p.eyebrow}</p>
                  <h3 className="display mt-2 text-xl text-fg-bright">{p.title}</h3>
                  <p className="mt-2 flex-1 text-[13px] leading-6 text-muted">{p.summary}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {p.skillTags.slice(0, 4).map((t) => (
                      <span key={t} className="pill">
                        {t}
                      </span>
                    ))}
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                    {[
                      { k: 'Labs', v: list.length },
                      { k: 'Modules', v: modulesForPath(p.id).length },
                      { k: 'Points', v: maxTotalPoints(list).toLocaleString('en-US') },
                    ].map((s) => (
                      <div key={s.k}>
                        <dd className="font-mono text-sm font-bold text-fg-bright">{s.v}</dd>
                        <dt className="label text-muted">{s.k}</dt>
                      </div>
                    ))}
                  </dl>
                  <span className="btn btn-soft mt-4 justify-center">
                    Open the path
                    <Icon g={NF.arrowRight} />
                  </span>
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="border-y border-border/60 bg-surface/40">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:py-20">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-14">
            <div>
              <Reveal>
                <p className="label text-accent">How a lab works</p>
                <h2 className="display mt-2 text-3xl text-fg-bright">Read the brief, do the work, get marked</h2>
              </Reveal>
              <ol className="mt-6 flex flex-col gap-5">
                {[
                  { n: '01', t: 'A scenario, not a script', b: 'Every lab opens with a situation and a list of objectives. Nothing tells you which keys to press.' },
                  { n: '02', t: 'A terminal that argues back', b: 'Abbreviations, tab completion and context help all work. So do the error messages, which is usually how you find out what you actually typed.' },
                  { n: '03', t: 'Checked against the real state', b: 'Grading reads the running configuration, the filesystem or the database. Stars depend on how many hints you needed.' },
                ].map((s, i) => (
                  <Reveal key={s.n} delay={i * 110}>
                    <li className="flex gap-4">
                      <span className="display shrink-0 text-lg text-muted">{s.n}</span>
                      <div>
                        <h3 className="font-semibold text-fg-bright">{s.t}</h3>
                        <p className="mt-1 text-[13px] leading-6 text-muted">{s.b}</p>
                      </div>
                    </li>
                  </Reveal>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-4">
              <Reveal delay={120}>
                <GradedLive />
              </Reveal>
              <Reveal delay={220}>
                <Topology />
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- features */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16 lg:py-20">
        <Reveal>
          <p className="label text-accent">Why it is different</p>
          <h2 className="display mt-2 text-3xl text-fg-bright">Simulated properly, not faked</h2>
        </Reveal>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={i * 90}>
              <div className="card lift h-full p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <Icon g={f.glyph} />
                </span>
                <h3 className="display mt-3 text-lg text-fg-bright">{f.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-muted">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------------------- cta */}
      <section className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center lg:py-20">
          <Reveal>
            <h2 className="display text-3xl text-fg-bright sm:text-4xl">Open a terminal and start</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">
              {labs.length} labs across {paths.length} paths. Free, open source, and nothing to install. Your progress is kept on this device, and follows you everywhere once you make an account.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to={pathUrl(paths[0].id)} className="btn btn-primary px-5 py-2.5">
                <Icon g={NF.play} />
                Start the first lab
              </Link>
              <Link to="/leaderboard" className="btn btn-ghost px-5 py-2.5">
                <Icon g={NF.trophy} />
                See the leaderboard
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-border/60 px-4 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p>NetLab is an independent, open-source simulator. It is not affiliated with Cisco, The Linux Foundation or the PostgreSQL project.</p>
          <a href="https://github.com/fejbron/netlab" className="flex items-center gap-1.5 hover:text-fg" target="_blank" rel="noreferrer">
            <Icon g={NF.github} />
            Source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
