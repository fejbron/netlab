import { buildNetwork, createSwitch, executeHost, type LinuxSpec, type NetworkState } from '../../engine';

/**
 * Every Git lab runs on dev1, a workstation with git installed, and can reach git1,
 * a server holding bare repositories under /srv/git. A second workstation, dev2,
 * is there for the labs where two people push to the same branch.
 *
 * Preparation is real: the history a lab starts from is built by running git
 * commands before the learner arrives, so the objects, refs and reflogs are
 * genuinely what those commands produce.
 */
export const DEV = 'dev1';
export const OTHER = 'dev2';
export const SERVER = 'git1';
export const HOME = '/home/student';
export const WORK = `${HOME}/project`;
export const SERVER_DIR = '/srv/git';
export const PASSWORD = 'student';

export interface GitSiteOptions {
  /** Files in the working directory, by path relative to ~/project unless absolute. */
  files?: Record<string, string>;
  /** Commands run on dev1 before the learner arrives, in ~/project. */
  prepare?: string[];
  /** Commands run on dev2, for the labs where a colleague pushed first. */
  prepareOther?: string[];
  /** Commands run on git1 itself, e.g. to create a bare repository by hand. */
  prepareServer?: string[];
  /** Bare repositories to create on git1, by name (without .git). */
  bare?: string[];
  /** Leave git uninstalled, for the lab that installs it. */
  noGit?: boolean;
  /** Skip the global user.name and user.email, for the lab that sets them. */
  noIdentity?: boolean;
  /** Do not create ~/project or cd into it. */
  noWorkdir?: boolean;
  /** Files written after preparation, replacing what was there (a colleague's edits). */
  edits?: Record<string, string>;
  after?: (net: NetworkState) => void;
}

function workstation(id: string, opts: { git: boolean; files?: Record<string, string> }): LinuxSpec {
  return {
    hostname: id,
    user: 'student',
    sudo: true,
    packages: opts.git ? ['git'] : [],
    services: { ssh: { active: true, enabled: true } },
    files: opts.files,
  };
}

export function gitSite(opts: GitSiteOptions = {}): NetworkState {
  const files: Record<string, string> = {};
  for (const [p, content] of Object.entries(opts.files ?? {})) files[p.startsWith('/') ? p : `${WORK}/${p}`] = content;

  const sw = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'dev1' }, 'g0/2': { description: 'dev2' }, 'g0/3': { description: 'git1' } } });
  let net = buildNetwork({
    primary: DEV,
    devices: [sw],
    hosts: [
      { id: DEV, name: 'dev1', ip: '192.168.1.30', mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server', linux: workstation('dev1', { git: !opts.noGit, files }) },
      { id: OTHER, name: 'dev2', ip: '192.168.1.31', mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server', linux: workstation('dev2', { git: true }) },
      { id: SERVER, name: 'git1', ip: '192.168.1.40', mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server', linux: { hostname: 'git1', user: 'student', sudo: true, packages: ['git'], services: { ssh: { active: true, enabled: true } } } },
    ],
    links: [[DEV, 'SW1:g0/1'], [OTHER, 'SW1:g0/2'], [SERVER, 'SW1:g0/3']],
  });

  const dev = net.hosts[DEV].linux!;
  if (!opts.noWorkdir) {
    dev.fs[WORK] ??= { type: 'dir', content: '', owner: 'student', group: 'student', mode: 0o755, mtime: 0 };
    dev.cwd = WORK;
  }
  net.hosts[SERVER].linux!.fs[SERVER_DIR] ??= { type: 'dir', content: '', owner: 'student', group: 'student', mode: 0o755, mtime: 0 };

  const run = (node: string, lines: string[]) => {
    for (const line of lines) {
      const r = executeHost(net, node, line);
      // A lab whose preparation fails is an authoring mistake: make it loud.
      if (r.output.some((l) => /^fatal:|^error:|command not found/.test(l))) throw new Error(`lab preparation failed on ${node} "${line}":\n${r.output.join('\n')}`);
      net = r.network;
    }
  };

  // The workstations trust the server, so pushing never stops for a password.
  const keys: string[] = [`ssh-keygen -t rsa -N '' -f ${HOME}/.ssh/id_rsa -q`, `ssh-copy-id student@${SERVER}`, PASSWORD];
  if (!opts.noGit) run(DEV, keys);
  run(OTHER, keys);

  const identity = (name: string, email: string) => [`git config --global user.name "${name}"`, `git config --global user.email "${email}"`];
  if (!opts.noGit && !opts.noIdentity) run(DEV, identity('Student', 'student@netlab.lab'));
  run(OTHER, identity('Sam Okafor', 'sam@netlab.lab'));

  for (const name of opts.bare ?? []) run(SERVER, [`git init --bare ${SERVER_DIR}/${name}.git`]);
  run(SERVER, opts.prepareServer ?? []);
  run(DEV, opts.prepare ?? []);
  run(OTHER, opts.prepareOther ?? []);

  const host = net.hosts[DEV];
  const lx = host.linux!;
  for (const [p, content] of Object.entries(opts.edits ?? {})) {
    const path = p.startsWith('/') ? p : `${WORK}/${p}`;
    const node = lx.fs[path];
    if (node) node.content = content;
    else lx.fs[path] = { type: 'file', content, owner: 'student', group: 'student', mode: 0o644, mtime: 0 };
  }
  opts.after?.(net);

  // The learner starts with a clean history: preparation is not their work.
  for (const id of [DEV, OTHER, SERVER]) {
    const h = net.hosts[id];
    h.commandHistory = [];
    h.acceptedHistory = [];
    h.linux!.history = [];
    h.linux!.outputs = [];
    h.linux!.gitRuns = [];
    h.linux!.pending = undefined;
  }
  if (!opts.noWorkdir) net.hosts[DEV].linux!.cwd = WORK;
  return net;
}

/** The URL of a bare repository on the server, as the labs write it. */
export function serverUrl(name: string): string {
  return `student@${SERVER}:${SERVER_DIR}/${name}.git`;
}
