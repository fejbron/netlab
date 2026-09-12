/**
 * Linux host model: a small virtual filesystem with owners and permission bits,
 * users and groups, services, processes and the shell state a learner sees.
 * Pure data; the shell and the commands operate on it.
 */
import { installApacheFiles, loadApache } from './apache';
import { createSqlState, type SqlSpec, type SqlState } from '../sql';
import { loadNginx } from './web';

export interface FsNode {
  type: 'file' | 'dir' | 'link';
  content: string;
  /** Symlink target (for type 'link'). */
  target?: string;
  owner: string;
  group: string;
  /** Permission bits, e.g. 0o644. */
  mode: number;
  /** Fake modification time (seconds since the lab clock started). */
  mtime: number;
}

export interface LinuxUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  /** Supplementary groups. */
  groups: string[];
  password?: string;
  locked?: boolean;
}

export interface LinuxGroup {
  name: string;
  gid: number;
}

export interface LinuxService {
  name: string;
  description: string;
  active: boolean;
  enabled: boolean;
  /** TCP port it listens on when active (for ss). */
  port?: number;
  /** All listening ports when a service has several (nginx after loading its configuration). */
  ports?: number[];
}

export interface WebRequestRecord {
  scheme: 'http' | 'https';
  host: string;
  path: string;
  status: number;
  server?: string;
  backend?: string;
  /** Which server answered. */
  engine?: 'nginx' | 'apache' | 'app';
}

/** What one web server is serving right now. */
export interface ServerRuntime {
  /** Snapshot of the configuration files at the last successful start or reload. */
  loaded?: string;
  listens: number[];
  lastError?: string;
}

/** Web runtime state: one entry per server, plus round-robin pointers and the request log. */
export interface WebState {
  nginx: ServerRuntime;
  apache: ServerRuntime;
  rr: Record<string, number>;
  requests: WebRequestRecord[];
}

export interface LinuxProcess {
  pid: number;
  user: string;
  cmd: string;
}

export interface PythonRun {
  file?: string;
  stdout: string;
  exitCode: number;
}

export type LinuxPending =
  /** A multi-line command (heredoc, unfinished loop, trailing backslash) is being collected. */
  | { kind: 'script'; text: string }
  /** passwd is asking for a password. */
  | { kind: 'password'; user: string; stage: 'new' | 'retype'; first?: string }
  /** The learner is inside psql, so lines are SQL rather than shell commands. */
  | { kind: 'sql'; db: string };

export interface LinuxState {
  hostname: string;
  /** Current login name; sudo -i pushes root onto `userStack`. */
  user: string;
  userStack: string[];
  cwd: string;
  fs: Record<string, FsNode>;
  users: LinuxUser[];
  groups: LinuxGroup[];
  services: Record<string, LinuxService>;
  processes: LinuxProcess[];
  nextPid: number;
  env: Record<string, string>;
  /** Shell functions defined in this session, by name (body source). */
  functions: Record<string, string>;
  lastExit: number;
  /** Users allowed to sudo. */
  sudoers: string[];
  packages: string[];
  /** Every output line the learner has seen, for grading "your script printed X". */
  outputs: string[];
  pythonRuns: PythonRun[];
  pending?: LinuxPending;
  clock: number;
  /** Lines typed at the shell (for `history`). */
  history: string[];
  web: WebState;
  /** PostgreSQL databases on this host, by name. Absent when the server is not installed. */
  databases?: Record<string, SqlState>;
}

export interface LinuxFileSpec {
  content?: string;
  mode?: number;
  owner?: string;
  group?: string;
  /** Make the path a symbolic link to this target instead of a regular file. */
  link?: string;
}

export interface LinuxServiceSpec {
  description?: string;
  active?: boolean;
  enabled?: boolean;
  port?: number;
}

export interface LinuxUserSpec {
  name: string;
  groups?: string[];
  shell?: string;
  password?: string;
  sudo?: boolean;
}

/** How a lab describes a Linux host; everything is optional. */
export interface LinuxSpec {
  hostname?: string;
  /** Login user; created if missing. Defaults to "student" with sudo. */
  user?: string;
  sudo?: boolean;
  users?: LinuxUserSpec[];
  groups?: string[];
  files?: Record<string, string | LinuxFileSpec>;
  services?: Record<string, LinuxServiceSpec>;
  packages?: string[];
  /** Extra running processes, e.g. a runaway script to find and kill. */
  processes?: Array<{ user: string; cmd: string }>;
  /** PostgreSQL databases to stand up, by name. Declaring any installs and starts the server. */
  databases?: Record<string, SqlSpec>;
}

export const KNOWN_SERVICES: Record<string, { description: string; port?: number; package?: string }> = {
  ssh: { description: 'OpenBSD Secure Shell server', port: 22, package: 'openssh-server' },
  nginx: { description: 'A high performance web server and a reverse proxy server', port: 80, package: 'nginx' },
  apache2: { description: 'The Apache HTTP Server', port: 80, package: 'apache2' },
  cron: { description: 'Regular background program processing daemon' },
  rsyslog: { description: 'System Logging Service' },
  chrony: { description: 'chrony, an NTP client/server', port: 123, package: 'chrony' },
  docker: { description: 'Docker Application Container Engine', package: 'docker.io' },
  ufw: { description: 'Uncomplicated firewall', package: 'ufw' },
  app: { description: 'NetLab demo application server', port: 8080, package: 'netlab-app' },
  postgresql: { description: 'PostgreSQL RDBMS server', port: 5432, package: 'postgresql' },
};

/** Packages apt knows about and the service each one provides. */
export const KNOWN_PACKAGES: Record<string, { service?: string; description: string }> = {
  nginx: { service: 'nginx', description: 'small, powerful, scalable web/proxy server' },
  apache2: { service: 'apache2', description: 'Apache HTTP Server' },
  'openssh-server': { service: 'ssh', description: 'secure shell (SSH) server, for secure access from remote machines' },
  chrony: { service: 'chrony', description: 'Versatile implementation of the Network Time Protocol' },
  ufw: { service: 'ufw', description: 'program for managing a Netfilter firewall' },
  'docker.io': { service: 'docker', description: 'Linux container runtime' },
  'netlab-app': { service: 'app', description: 'NetLab demo application server (answers with its hostname on port 8080)' },
  openssl: { description: 'Secure Sockets Layer toolkit - cryptographic utility' },
  python3: { description: 'interactive high-level object-oriented language (default python3 version)' },
  'python3-pip': { description: 'Python package installer' },
  curl: { description: 'command line tool for transferring data with URL syntax' },
  git: { description: 'fast, scalable, distributed revision control system' },
  tree: { description: 'displays an indented directory tree, in color' },
  htop: { description: 'interactive processes viewer' },
  jq: { description: 'lightweight and flexible command-line JSON processor' },
  vim: { description: 'Vi IMproved - enhanced vi editor' },
  'net-tools': { description: 'NET-3 networking toolkit' },
};

// ---------------------------------------------------------------------------
// paths

export function normalizePath(cwd: string, p: string, home = '/root'): string {
  let path = p;
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  if (!path.startsWith('/')) path = (cwd === '/' ? '' : cwd) + '/' + path;
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function parentPath(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

export function baseName(p: string): string {
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Resolve symlinks (up to 8 hops). Returns the final path, or the original when it dangles. */
export function resolveLink(state: LinuxState, p: string): string {
  let cur = p;
  for (let i = 0; i < 8; i++) {
    const n = state.fs[cur];
    if (!n || n.type !== 'link' || !n.target) return cur;
    cur = normalizePath(parentPath(cur), n.target);
  }
  return cur;
}

export function getNode(state: LinuxState, p: string, follow = true): FsNode | undefined {
  return state.fs[follow ? resolveLink(state, p) : p];
}

export function listDir(state: LinuxState, dir: string): string[] {
  const prefix = dir === '/' ? '/' : dir + '/';
  const names = new Set<string>();
  for (const key of Object.keys(state.fs)) {
    if (key === dir || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest) names.add(rest.split('/')[0]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function modeString(node: FsNode): string {
  const t = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let s = t;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const v = (node.mode >> shift) & 7;
    for (let b = 0; b < 3; b++) s += v & (4 >> b) ? bits[b] : '-';
  }
  return s;
}

export function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// users and permissions

export function findUser(state: LinuxState, name: string): LinuxUser | undefined {
  return state.users.find((u) => u.name === name);
}

export function currentUser(state: LinuxState): LinuxUser {
  return findUser(state, state.user) ?? { name: state.user, uid: 65534, gid: 65534, home: '/', shell: '/bin/bash', groups: [] };
}

export function isRoot(state: LinuxState): boolean {
  return state.user === 'root';
}

export function homeOf(state: LinuxState, user = state.user): string {
  return findUser(state, user)?.home ?? (user === 'root' ? '/root' : `/home/${user}`);
}

export function groupName(state: LinuxState, gid: number): string {
  return state.groups.find((g) => g.gid === gid)?.name ?? String(gid);
}

export function userGroups(state: LinuxState, user: LinuxUser): string[] {
  return [groupName(state, user.gid), ...user.groups.filter((g) => g !== groupName(state, user.gid))];
}

function permissionBits(state: LinuxState, node: FsNode): number {
  if (isRoot(state)) return 7;
  const u = currentUser(state);
  if (node.owner === u.name) return (node.mode >> 6) & 7;
  if (userGroups(state, u).includes(node.group)) return (node.mode >> 3) & 7;
  return node.mode & 7;
}

export function canRead(state: LinuxState, node: FsNode): boolean {
  return (permissionBits(state, node) & 4) !== 0;
}

export function canWrite(state: LinuxState, node: FsNode): boolean {
  return (permissionBits(state, node) & 2) !== 0;
}

export function canExec(state: LinuxState, node: FsNode): boolean {
  if (isRoot(state)) return (node.mode & 0o111) !== 0 || node.type === 'dir';
  return (permissionBits(state, node) & 1) !== 0;
}

// ---------------------------------------------------------------------------
// mutations

export interface FsError {
  error: string;
}

function tick(state: LinuxState): number {
  state.clock += 7;
  return state.clock;
}

export function makeDir(state: LinuxState, p: string, parents = false): FsError | null {
  if (state.fs[p]) return state.fs[p].type === 'dir' ? (parents ? null : { error: `mkdir: cannot create directory ‘${p}’: File exists` }) : { error: `mkdir: cannot create directory ‘${p}’: File exists` };
  const parent = parentPath(p);
  const pn = getNode(state, parent);
  if (!pn) {
    if (!parents) return { error: `mkdir: cannot create directory ‘${p}’: No such file or directory` };
    const e = makeDir(state, parent, true);
    if (e) return e;
  } else if (pn.type !== 'dir') return { error: `mkdir: cannot create directory ‘${p}’: Not a directory` };
  const parentNode = getNode(state, parent)!;
  if (!canWrite(state, parentNode)) return { error: `mkdir: cannot create directory ‘${p}’: Permission denied` };
  state.fs[p] = { type: 'dir', content: '', owner: state.user, group: groupName(state, currentUser(state).gid), mode: 0o755, mtime: tick(state) };
  return null;
}

/** Write (or append to) a file, creating it with the current user's ownership. */
export function writeFile(state: LinuxState, p: string, content: string, append = false, who = 'sh', shown = p): FsError | null {
  const path = resolveLink(state, p);
  const existing = state.fs[path];
  if (existing) {
    if (existing.type === 'dir') return { error: `${who}: ${shown}: Is a directory` };
    if (!canWrite(state, existing)) return { error: `${who}: ${shown}: Permission denied` };
    existing.content = append ? existing.content + content : content;
    existing.mtime = tick(state);
    return null;
  }
  const parent = getNode(state, parentPath(path));
  if (!parent || parent.type !== 'dir') return { error: `${who}: ${shown}: No such file or directory` };
  if (!canWrite(state, parent)) return { error: `${who}: ${shown}: Permission denied` };
  state.fs[path] = { type: 'file', content, owner: state.user, group: groupName(state, currentUser(state).gid), mode: 0o644, mtime: tick(state) };
  return null;
}

/** Contents of /etc/passwd, /etc/group and /etc/shadow are generated from the user database. */
export function readFile(state: LinuxState, p: string, who = 'cat', shown = p): { content: string } | FsError {
  const path = resolveLink(state, p);
  if (path === '/etc/passwd') return { content: state.users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.name === 'root' ? 'root' : ''}:${u.home}:${u.shell}`).join('\n') + '\n' };
  if (path === '/etc/group') return { content: state.groups.map((g) => `${g.name}:x:${g.gid}:${state.users.filter((u) => u.groups.includes(g.name)).map((u) => u.name).join(',')}`).join('\n') + '\n' };
  if (path === '/etc/shadow') {
    if (!isRoot(state)) return { error: `${who}: ${shown}: Permission denied` };
    return { content: state.users.map((u) => `${u.name}:${u.locked ? '!' : u.password ? '$6$salt$' + Buffer_hash(u.password) : '*'}:19980:0:99999:7:::`).join('\n') + '\n' };
  }
  if (path === '/etc/hostname') return { content: state.hostname + '\n' };
  const node = state.fs[path];
  if (!node) return { error: `${who}: ${shown}: No such file or directory` };
  if (node.type === 'dir') return { error: `${who}: ${shown}: Is a directory` };
  if (!canRead(state, node)) return { error: `${who}: ${shown}: Permission denied` };
  return { content: node.content };
}

/** Deterministic fake hash so shadow entries look plausible. */
function Buffer_hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36).padEnd(22, 'x').slice(0, 22);
}

export function removeNode(state: LinuxState, p: string, recursive: boolean, who = 'rm'): FsError | null {
  const node = state.fs[p];
  if (!node) return { error: `${who}: cannot remove '${p}': No such file or directory` };
  const parent = getNode(state, parentPath(p));
  if (parent && !canWrite(state, parent)) return { error: `${who}: cannot remove '${p}': Permission denied` };
  if (node.type === 'dir') {
    if (!recursive) return { error: `${who}: cannot remove '${p}': Is a directory` };
    for (const key of Object.keys(state.fs)) if (key.startsWith(p + '/')) delete state.fs[key];
  }
  delete state.fs[p];
  return null;
}

/** Copy a file (or a tree with `recursive`) to `dest`, which may be an existing directory. */
export function copyNode(state: LinuxState, src: string, dest: string, recursive: boolean, who = 'cp'): FsError | null {
  const s = state.fs[src];
  if (!s) return { error: `${who}: cannot stat '${src}': No such file or directory` };
  if (s.type === 'dir' && !recursive) return { error: `${who}: -r not specified; omitting directory '${src}'` };
  if (s.type !== 'dir' && !canRead(state, s)) return { error: `${who}: cannot open '${src}' for reading: Permission denied` };
  const destNode = state.fs[dest];
  const target = destNode?.type === 'dir' ? `${dest === '/' ? '' : dest}/${baseName(src)}` : dest;
  const parent = getNode(state, parentPath(target));
  if (!parent || parent.type !== 'dir') return { error: `${who}: cannot create regular file '${target}': No such file or directory` };
  if (!canWrite(state, parent)) return { error: `${who}: cannot create regular file '${target}': Permission denied` };
  const owner = state.user;
  const group = groupName(state, currentUser(state).gid);
  const copy = (from: string, to: string) => {
    const n = state.fs[from];
    state.fs[to] = { ...n, owner, group, mtime: tick(state) };
    if (n.type === 'dir') for (const key of Object.keys(state.fs)) if (key.startsWith(from + '/')) copy(key, to + key.slice(from.length));
  };
  copy(src, target);
  return null;
}

export function moveNode(state: LinuxState, src: string, dest: string, who = 'mv'): FsError | null {
  const s = state.fs[src];
  if (!s) return { error: `${who}: cannot stat '${src}': No such file or directory` };
  const srcParent = getNode(state, parentPath(src));
  if (srcParent && !canWrite(state, srcParent)) return { error: `${who}: cannot move '${src}': Permission denied` };
  const destNode = state.fs[dest];
  const target = destNode?.type === 'dir' ? `${dest === '/' ? '' : dest}/${baseName(src)}` : dest;
  if (target === src) return null;
  const parent = getNode(state, parentPath(target));
  if (!parent || parent.type !== 'dir') return { error: `${who}: cannot move '${src}' to '${target}': No such file or directory` };
  if (!canWrite(state, parent)) return { error: `${who}: cannot move '${src}' to '${target}': Permission denied` };
  const keys = Object.keys(state.fs).filter((k) => k === src || k.startsWith(src + '/'));
  for (const key of keys) {
    state.fs[target + key.slice(src.length)] = state.fs[key];
    delete state.fs[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
// factory

function baseFiles(hostname: string): Record<string, FsNode> {
  const d = (owner = 'root', mode = 0o755): FsNode => ({ type: 'dir', content: '', owner, group: owner, mode, mtime: 0 });
  const f = (content: string, mode = 0o644, owner = 'root'): FsNode => ({ type: 'file', content, owner, group: owner, mode, mtime: 0 });
  return {
    '/': d(),
    '/bin': d(),
    '/etc': d(),
    '/etc/ssh': d(),
    '/etc/ssh/sshd_config': f('# This is the sshd server system-wide configuration file.\nInclude /etc/ssh/sshd_config.d/*.conf\nPort 22\n#PermitRootLogin prohibit-password\nPasswordAuthentication yes\nX11Forwarding yes\n'),
    '/etc/hosts': f(`127.0.0.1 localhost\n127.0.1.1 ${hostname}\n\n::1 ip6-localhost ip6-loopback\n`),
    '/etc/os-release': f('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\n'),
    '/etc/motd': f('Welcome to NetLab Linux. Type help for the commands this shell supports.\n'),
    '/etc/sudoers': f('# User privilege specification\nroot    ALL=(ALL:ALL) ALL\n%sudo   ALL=(ALL:ALL) ALL\n', 0o440),
    '/home': d(),
    '/root': d('root', 0o700),
    '/tmp': d('root', 0o777),
    '/opt': d(),
    '/srv': d(),
    '/usr': d(),
    '/usr/bin': d(),
    '/usr/local': d(),
    '/usr/local/bin': d(),
    '/var': d(),
    '/var/log': d(),
    '/var/log/syslog': f(
      [
        'Sep 11 08:55:01 HOST systemd[1]: Started Daily apt download activities.',
        'Sep 11 08:55:12 HOST sshd[812]: Server listening on 0.0.0.0 port 22.',
        'Sep 11 08:57:44 HOST kernel: [  114.221] eth0: link becomes ready',
        'Sep 11 08:58:03 HOST CRON[1201]: (root) CMD (command -v debian-sa1 > /dev/null && debian-sa1 1 1)',
        'Sep 11 08:59:30 HOST systemd[1]: Reached target Timers.',
      ]
        .join('\n')
        .replace(/HOST/g, hostname) + '\n',
    ),
    '/var/log/auth.log': f(
      [
        'Sep 11 08:40:11 HOST sshd[790]: Accepted publickey for student from 192.168.1.10 port 51234 ssh2',
        'Sep 11 08:41:02 HOST sshd[801]: Failed password for invalid user admin from 203.0.113.45 port 40122 ssh2',
        'Sep 11 08:41:05 HOST sshd[801]: Failed password for invalid user admin from 203.0.113.45 port 40122 ssh2',
        'Sep 11 08:41:09 HOST sshd[801]: Failed password for root from 203.0.113.45 port 40130 ssh2',
        'Sep 11 08:42:00 HOST sudo:  student : TTY=pts/0 ; PWD=/home/student ; USER=root ; COMMAND=/usr/bin/apt update',
        'Sep 11 08:45:17 HOST sshd[830]: Failed password for root from 198.51.100.7 port 33002 ssh2',
        'Sep 11 08:50:00 HOST sshd[844]: Accepted password for student from 192.168.1.10 port 51300 ssh2',
      ]
        .join('\n')
        .replace(/HOST/g, hostname) + '\n',
    ),
    '/var/www': d(),
  };
}

export function createLinuxState(spec: LinuxSpec, hostName: string): LinuxState {
  const hostname = spec.hostname ?? hostName.toLowerCase();
  const loginName = spec.user ?? 'student';
  const state: LinuxState = {
    hostname,
    user: loginName,
    userStack: [],
    cwd: loginName === 'root' ? '/root' : `/home/${loginName}`,
    fs: baseFiles(hostname),
    users: [
      { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash', groups: [], password: 'root' },
      { name: 'daemon', uid: 1, gid: 1, home: '/usr/sbin', shell: '/usr/sbin/nologin', groups: [] },
      { name: 'www-data', uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin', groups: [] },
      { name: 'nobody', uid: 65534, gid: 65534, home: '/nonexistent', shell: '/usr/sbin/nologin', groups: [] },
    ],
    groups: [
      { name: 'root', gid: 0 },
      { name: 'daemon', gid: 1 },
      { name: 'adm', gid: 4 },
      { name: 'sudo', gid: 27 },
      { name: 'www-data', gid: 33 },
      { name: 'users', gid: 100 },
      { name: 'nogroup', gid: 65534 },
    ],
    services: {
      ssh: { name: 'ssh', description: KNOWN_SERVICES.ssh.description, active: true, enabled: true, port: 22 },
      cron: { name: 'cron', description: KNOWN_SERVICES.cron.description, active: true, enabled: true },
      rsyslog: { name: 'rsyslog', description: KNOWN_SERVICES.rsyslog.description, active: true, enabled: true },
    },
    processes: [
      { pid: 1, user: 'root', cmd: '/sbin/init' },
      { pid: 412, user: 'root', cmd: '/usr/lib/systemd/systemd-journald' },
      { pid: 601, user: 'root', cmd: '/usr/sbin/cron -f -P' },
      { pid: 655, user: 'syslog', cmd: '/usr/sbin/rsyslogd -n -iNONE' },
      { pid: 812, user: 'root', cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups' },
    ],
    nextPid: 1300,
    env: { HOME: '', USER: loginName, SHELL: '/bin/bash', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', HOSTNAME: hostname },
    functions: {},
    lastExit: 0,
    sudoers: ['root'],
    packages: ['bash', 'coreutils', 'openssh-server', 'curl', 'python3', 'iproute2', 'grep', 'sed', 'gawk', 'findutils', 'procps', 'systemd'],
    outputs: [],
    pythonRuns: [],
    clock: 100,
    history: [],
    web: { nginx: { listens: [] }, apache: { listens: [] }, rr: {}, requests: [] },
  };
  let uid = 1000;
  const addUser = (u: LinuxUserSpec) => {
    if (findUser(state, u.name)) return;
    const gid = uid;
    state.groups.push({ name: u.name, gid });
    const groups = [...(u.groups ?? [])];
    if (u.sudo && !groups.includes('sudo')) groups.push('sudo');
    for (const g of groups) if (!state.groups.some((x) => x.name === g)) state.groups.push({ name: g, gid: 1000 + state.groups.length });
    state.users.push({ name: u.name, uid, gid, home: `/home/${u.name}`, shell: u.shell ?? '/bin/bash', groups, password: u.password ?? (u.name === loginName ? 'student' : undefined) });
    state.fs[`/home/${u.name}`] = { type: 'dir', content: '', owner: u.name, group: u.name, mode: 0o750, mtime: 0 };
    state.fs[`/home/${u.name}/.bashrc`] = { type: 'file', content: '# ~/.bashrc: executed by bash(1) for non-login shells.\nexport PATH="$HOME/bin:$PATH"\nalias ll=\'ls -alF\'\n', owner: u.name, group: u.name, mode: 0o644, mtime: 0 };
    if (u.sudo) state.sudoers.push(u.name);
    uid += 1;
  };
  for (const g of spec.groups ?? []) if (!state.groups.some((x) => x.name === g)) state.groups.push({ name: g, gid: 1000 + state.groups.length + 50 });
  if (loginName !== 'root') addUser({ name: loginName, sudo: spec.sudo ?? true });
  for (const u of spec.users ?? []) addUser(u);
  state.env.HOME = homeOf(state, loginName);
  state.processes.push({ pid: 1201, user: loginName, cmd: '-bash' });
  for (const pkg of spec.packages ?? []) if (!state.packages.includes(pkg)) state.packages.push(pkg);
  for (const p of spec.processes ?? []) state.processes.push({ pid: state.nextPid++, user: p.user, cmd: p.cmd });
  for (const [name, s] of Object.entries(spec.services ?? {})) {
    const known = KNOWN_SERVICES[name];
    state.services[name] = { name, description: s.description ?? known?.description ?? `${name} service`, active: s.active ?? false, enabled: s.enabled ?? false, port: s.port ?? known?.port };
    if (known?.package && !state.packages.includes(known.package)) state.packages.push(known.package);
    if (state.services[name].active) state.processes.push({ pid: state.nextPid++, user: name === 'nginx' || name === 'apache2' ? 'www-data' : 'root', cmd: daemonCommand(name) });
  }
  if (state.packages.includes('nginx')) installNginxFiles(state);
  if (state.packages.includes('apache2')) installApacheFiles(state);
  if (state.packages.includes('netlab-app')) installAppFiles(state);
  installSslDirs(state);
  for (const [rawPath, value] of Object.entries(spec.files ?? {})) {
    const path = normalizePath('/', rawPath, homeOf(state));
    const f = typeof value === 'string' ? { content: value } : value;
    const underHome = path.startsWith(homeOf(state) + '/');
    const defaultOwner = underHome ? loginName : 'root';
    // Parents are created as needed, owned like the file.
    let parent = parentPath(path);
    const missing: string[] = [];
    while (!state.fs[parent] && parent !== '/') {
      missing.unshift(parent);
      parent = parentPath(parent);
    }
    for (const dir of missing) state.fs[dir] = { type: 'dir', content: '', owner: f.owner ?? defaultOwner, group: f.group ?? f.owner ?? defaultOwner, mode: 0o755, mtime: 0 };
    state.fs[path] = f.link
      ? { type: 'link', content: '', target: f.link, owner: f.owner ?? defaultOwner, group: f.group ?? f.owner ?? defaultOwner, mode: f.mode ?? 0o777, mtime: 0 }
      : { type: 'file', content: f.content ?? '', owner: f.owner ?? defaultOwner, group: f.group ?? f.owner ?? defaultOwner, mode: f.mode ?? 0o644, mtime: 0 };
  }
  if (spec.databases) {
    state.databases = {};
    for (const [name, db] of Object.entries(spec.databases)) state.databases[name] = createSqlState({ ...db, database: name });
    if (!state.packages.includes('postgresql')) state.packages.push('postgresql');
    state.services.postgresql ??= { name: 'postgresql', description: KNOWN_SERVICES.postgresql.description, active: true, enabled: true, port: 5432 };
  }
  if (state.services.nginx?.active) loadNginx(state);
  if (state.services.apache2?.active) loadApache(state);
  return state;
}

const NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    access_log /var/log/nginx/access.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

const NGINX_DEFAULT_SITE = `##
# Default server configuration
##
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    root /var/www/html;

    # Add index.php to the list if you are using PHP
    index index.html index.htm index.nginx-debian.html;

    server_name _;

    location / {
        # First attempt to serve request as file, then
        # as directory, then fall back to displaying a 404.
        try_files $uri $uri/ =404;
    }
}
`;

/** Files the nginx package ships with (Debian/Ubuntu layout). Idempotent. */
export function installNginxFiles(state: LinuxState): void {
  const d = (p: string, mode = 0o755) => (state.fs[p] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode, mtime: 0 });
  const f = (p: string, content: string, mode = 0o644) => (state.fs[p] ??= { type: 'file', content, owner: 'root', group: 'root', mode, mtime: 0 });
  d('/var/www/html');
  f('/var/www/html/index.nginx-debian.html', '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>\n');
  d('/etc/nginx');
  d('/etc/nginx/conf.d');
  d('/etc/nginx/sites-available');
  d('/etc/nginx/sites-enabled');
  d('/etc/nginx/snippets');
  d('/etc/nginx/modules-enabled');
  f('/etc/nginx/nginx.conf', NGINX_CONF);
  f('/etc/nginx/mime.types', 'types {\n    text/html                             html htm shtml;\n    text/css                              css;\n    application/javascript                js;\n    application/json                      json;\n    text/plain                            txt;\n}\n');
  f('/etc/nginx/sites-available/default', NGINX_DEFAULT_SITE);
  state.fs['/etc/nginx/sites-enabled/default'] ??= { type: 'link', content: '', target: '/etc/nginx/sites-available/default', owner: 'root', group: 'root', mode: 0o777, mtime: 0 };
  d('/var/log/nginx');
  f('/var/log/nginx/access.log', '');
  f('/var/log/nginx/error.log', '');
}

/** The demo application: a tiny server on 8080 that answers with the hostname. */
export function installAppFiles(state: LinuxState): void {
  state.fs['/opt/app'] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode: 0o755, mtime: 0 };
  state.fs['/opt/app/server.py'] ??= { type: 'file', content: '#!/usr/bin/env python3\n"""NetLab demo app: answers every request with this host\'s name (or /opt/app/index.html if present)."""\nimport socket, http.server\n\nclass H(http.server.BaseHTTPRequestHandler):\n    def do_GET(self):\n        body = f"Hello from {socket.gethostname()}\\n".encode()\n        self.send_response(200)\n        self.send_header("Content-Type", "text/plain")\n        self.end_headers()\n        self.wfile.write(body)\n\nhttp.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()\n', owner: 'root', group: 'root', mode: 0o755, mtime: 0 };
}

export function installSslDirs(state: LinuxState): void {
  state.fs['/etc/ssl'] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode: 0o755, mtime: 0 };
  state.fs['/etc/ssl/certs'] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode: 0o755, mtime: 0 };
  state.fs['/etc/ssl/private'] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode: 0o700, mtime: 0 };
  state.fs['/etc/ssl/openssl.cnf'] ??= { type: 'file', content: '# OpenSSL default configuration (abridged)\n[ req ]\ndefault_bits = 2048\ndistinguished_name = req_distinguished_name\n[ req_distinguished_name ]\ncountryName = Country Name (2 letter code)\ncommonName = Common Name (e.g. server FQDN or YOUR name)\n', owner: 'root', group: 'root', mode: 0o644, mtime: 0 };
}

export function daemonCommand(service: string): string {
  switch (service) {
    case 'nginx':
      return 'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;';
    case 'apache2':
      return '/usr/sbin/apache2 -k start';
    case 'ssh':
      return 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups';
    case 'chrony':
      return '/usr/sbin/chronyd -F 1';
    case 'docker':
      return '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock';
    case 'app':
      return '/usr/bin/python3 /opt/app/server.py --port 8080';
    case 'apache2':
      return '/usr/sbin/apache2 -k start';
    default:
      return `/usr/sbin/${service}`;
  }
}
