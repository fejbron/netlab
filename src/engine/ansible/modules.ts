/**
 * The modules the labs use. File-shaped modules (file, copy, template, lineinfile)
 * work on the target's filesystem directly, which is what makes their diffs exact;
 * package, service, user, group and cron drive the same commands the Linux engine
 * already simulates, so a playbook and a shell session cannot disagree.
 *
 * Every module reports `changed` only when it actually changed something, which is what
 * makes a second run come back all green, and check mode reports what it would have
 * done without touching anything.
 */
import { curl } from '../curl';
import { executeOn } from '../ios/device';
import { canWrite, getNode, listDir, makeDir, normalizePath, octal, parentPath, readFile, removeNode, writeFile, type FsNode, type LinuxState } from '../linux/fs';
import { runLine } from '../linux/shell';
import { renderConfigBody } from '../ios/show';
import type { DeviceState } from '../types';
import type { NetworkState } from '../network';
import type { JValue } from './jinja';

export interface ModuleCtx {
  network: NetworkState;
  /** Node id of the target in the network. */
  node: string;
  /** The control node, where source files and templates live. */
  control: LinuxState;
  controlNode: string;
  /** Directory the playbook was run from, for relative paths. */
  cwd: string;
  /** Directories to search for files/ and templates/ (role directories first). */
  searchPath: string[];
  lx?: LinuxState;
  device?: DeviceState;
  become: boolean;
  becomeUser: string;
  remoteUser: string;
  checkMode: boolean;
  diffMode: boolean;
  /** Render a Jinja template with the variables in scope. */
  render: (text: string) => string;
  vars: Record<string, JValue>;
}

export interface Diff {
  before: string;
  after: string;
  path?: string;
}

export interface ModuleResult {
  changed: boolean;
  failed?: boolean;
  msg?: JValue;
  rc?: number;
  stdout?: string;
  stderr?: string;
  stdout_lines?: string[];
  diff?: Diff;
  ansible_facts?: Record<string, JValue>;
  [key: string]: JValue | Diff | undefined;
}

export class ModuleError extends Error {
  constructor(
    message: string,
    public extra: Record<string, JValue> = {},
  ) {
    super(message);
  }
}

export type Module = (args: Record<string, JValue>, ctx: ModuleCtx) => ModuleResult;

const ok = (changed = false, extra: Record<string, JValue> = {}): ModuleResult => ({ changed, ...extra });

// ---------------------------------------------------------------------------
// argument helpers

interface Spec {
  required?: string[];
  optional?: string[];
  aliases?: Record<string, string>;
}

function check(name: string, args: Record<string, JValue>, spec: Spec): Record<string, JValue> {
  const out: Record<string, JValue> = {};
  const known = new Set([...(spec.required ?? []), ...(spec.optional ?? [])]);
  for (const [k, v] of Object.entries(args)) {
    const key = spec.aliases?.[k] ?? k;
    if (!known.has(key)) {
      const supported = [...known].sort().join(', ');
      throw new ModuleError(`Unsupported parameters for (${name}) module: ${k}. Supported parameters include: ${supported}.`);
    }
    out[key] = v;
  }
  const missing = (spec.required ?? []).filter((r) => out[r] === undefined || out[r] === null);
  if (missing.length) throw new ModuleError(`missing required arguments: ${missing.join(', ')}`);
  return out;
}

function str(v: JValue, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function bool(v: JValue, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return ['yes', 'true', 'on', '1'].includes(String(v).toLowerCase());
}

function list(v: JValue): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => str(x));
  return str(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function target(ctx: ModuleCtx): LinuxState {
  if (!ctx.lx) throw new ModuleError('this module needs a Linux host');
  return ctx.lx;
}

/** The user a task runs as: root when become is on, otherwise the connection user. */
function asUser(ctx: ModuleCtx): string {
  return ctx.become ? ctx.becomeUser : ctx.remoteUser;
}

/** Run something on the target as the effective user, and put the state back afterwards. */
function withUser<T>(ctx: ModuleCtx, fn: (lx: LinuxState) => T): T {
  const lx = target(ctx);
  const saved = lx.user;
  const savedCwd = lx.cwd;
  lx.user = asUser(ctx);
  lx.cwd = `/home/${lx.user === 'root' ? 'root' : lx.user}`.replace('/home/root', '/root');
  try {
    return fn(lx);
  } finally {
    lx.user = saved;
    lx.cwd = savedCwd;
  }
}

function shell(ctx: ModuleCtx, line: string): { out: string[]; err: string[]; code: number } {
  return withUser(ctx, (lx) => {
    const r = runLine({ state: lx, network: ctx.network, hostId: ctx.node }, line);
    if ('incomplete' in r) return { out: [], err: ['unexpected end of input'], code: 2 };
    return { out: r.out, err: r.err, code: r.code };
  });
}

function remotePath(ctx: ModuleCtx, p: string): string {
  const user = asUser(ctx);
  return normalizePath(user === 'root' ? '/root' : `/home/${user}`, p, user === 'root' ? '/root' : `/home/${user}`);
}

/** Find a source file next to the playbook, or in a role's files/ or templates/. */
function sourceFile(ctx: ModuleCtx, src: string, kind: 'files' | 'templates'): { path: string; content: string } {
  const candidates = [...ctx.searchPath.flatMap((dir) => [`${dir}/${kind}/${src}`, `${dir}/${src}`]), normalizePath(ctx.cwd, src, `/home/${ctx.control.user}`)];
  for (const path of candidates) {
    const r = readFile(ctx.control, path);
    if (!('error' in r)) return { path, content: r.content };
  }
  throw new ModuleError(`Could not find or access '${src}' on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`);
}

function applyAttributes(lx: LinuxState, path: string, args: Record<string, JValue>, changedAlready: boolean): boolean {
  const node = getNode(lx, path);
  if (!node) return changedAlready;
  let changed = changedAlready;
  if (args.mode !== undefined) {
    const wanted = typeof args.mode === 'number' ? args.mode : parseInt(str(args.mode).replace(/^0o?/, ''), 8);
    if (!Number.isNaN(wanted) && (node.mode & 0o7777) !== wanted) {
      node.mode = wanted;
      changed = true;
    }
  }
  if (args.owner !== undefined && node.owner !== str(args.owner)) {
    node.owner = str(args.owner);
    changed = true;
  }
  if (args.group !== undefined && node.group !== str(args.group)) {
    node.group = str(args.group);
    changed = true;
  }
  return changed;
}

function fileState(lx: LinuxState, path: string): { exists: boolean; content: string; node?: FsNode } {
  const node = getNode(lx, path);
  return { exists: Boolean(node), content: node?.type === 'file' ? node.content : '', node };
}

function writeAs(ctx: ModuleCtx, path: string, content: string): void {
  withUser(ctx, (lx) => {
    const parent = getNode(lx, parentPath(path));
    if (!parent) throw new ModuleError(`Destination directory ${parentPath(path)} does not exist`);
    if (!canWrite(lx, parent) && !getNode(lx, path)) throw new ModuleError(`There was an issue creating ${path} as requested: [Errno 13] Permission denied: '${path}'`);
    const existing = getNode(lx, path);
    if (existing && !canWrite(lx, existing)) throw new ModuleError(`The destination directory (${parentPath(path)}) is not writable by the current user: [Errno 13] Permission denied: '${path}'`);
    const e = writeFile(lx, path, content, false, 'ansible');
    if (e) throw new ModuleError(e.error.replace(/^\w+: /, ''));
  });
}

// ---------------------------------------------------------------------------
// facts

export function linuxFacts(lx: LinuxState, host: { ip?: string; mask?: string; gateway?: string }): Record<string, JValue> {
  const iface = { device: 'eth0', address: host.ip ?? '', netmask: host.mask ?? '', gateway: host.gateway ?? '' };
  return {
    ansible_hostname: lx.hostname,
    ansible_nodename: lx.hostname,
    ansible_fqdn: `${lx.hostname}.lab.local`,
    ansible_distribution: 'Ubuntu',
    ansible_distribution_version: '24.04',
    ansible_distribution_major_version: '24',
    ansible_distribution_release: 'noble',
    ansible_os_family: 'Debian',
    ansible_system: 'Linux',
    ansible_kernel: '6.8.0-45-generic',
    ansible_architecture: 'x86_64',
    ansible_pkg_mgr: 'apt',
    ansible_service_mgr: 'systemd',
    ansible_processor_vcpus: 2,
    ansible_memtotal_mb: 2048,
    ansible_user_id: lx.user,
    ansible_env: { HOME: lx.env.HOME, USER: lx.env.USER, PATH: lx.env.PATH },
    ansible_default_ipv4: iface,
    ansible_all_ipv4_addresses: host.ip ? [host.ip] : [],
    ansible_interfaces: ['lo', 'eth0'],
    ansible_eth0: { device: 'eth0', active: true, ipv4: iface },
    ansible_date_time: { date: '2026-09-16', time: '09:00:00', epoch: '1789542000', year: '2026', month: '09', day: '16', weekday: 'Wednesday' },
    ansible_virtualization_type: 'container',
    ansible_python_version: '3.12.3',
  };
}

export function iosFacts(dev: DeviceState): Record<string, JValue> {
  const interfaces: Record<string, JValue> = {};
  const addresses: string[] = [];
  for (const [name, i] of Object.entries(dev.interfaces)) {
    interfaces[name] = { description: i.description ?? null, ipv4: i.ipAddress ? [{ address: i.ipAddress, subnet: i.subnetMask }] : [], operstatus: i.shutdown ? 'down' : 'up', type: name.replace(/[0-9/.]+$/, '') };
    if (i.ipAddress) addresses.push(i.ipAddress);
  }
  return {
    ansible_net_hostname: dev.hostname,
    ansible_net_model: dev.deviceType === 'router' ? 'ISR4331/K9' : 'C9200-24T',
    ansible_net_serialnum: `FTX${dev.mac.replace(/\./g, '').slice(0, 9).toUpperCase()}`,
    ansible_net_version: '17.09.04a',
    ansible_net_iostype: 'IOS-XE',
    ansible_net_system: 'ios',
    ansible_net_all_ipv4_addresses: addresses,
    ansible_net_interfaces: interfaces,
    ansible_network_resources: {},
  };
}

// ---------------------------------------------------------------------------
// modules

const fileModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.file', rawArgs, {
    required: ['path'],
    optional: ['state', 'owner', 'group', 'mode', 'src', 'recurse'],
    aliases: { dest: 'path', name: 'path' },
  });
  const path = remotePath(ctx, str(args.path));
  const state = str(args.state, 'file');
  return withUser(ctx, (lx) => {
    const before = fileState(lx, path);
    if (state === 'absent') {
      if (!before.exists) return ok(false, { path });
      if (ctx.checkMode) return ok(true, { path });
      const e = removeNode(lx, path, true, 'ansible');
      if (e) throw new ModuleError(e.error);
      return ok(true, { path, diff: { before: before.content, after: '', path } });
    }
    if (state === 'directory') {
      let changed = false;
      if (!before.exists) {
        if (!ctx.checkMode) {
          const e = makeDir(lx, path, true);
          if (e) throw new ModuleError(e.error.replace(/^mkdir: cannot create directory .*: /, ''));
        }
        changed = true;
      } else if (before.node?.type !== 'dir') throw new ModuleError(`${path} already exists as a file`);
      if (!ctx.checkMode) changed = applyAttributes(lx, path, args, changed);
      return ok(changed, { path, state: 'directory' });
    }
    if (state === 'touch') {
      if (!before.exists && !ctx.checkMode) writeFile(lx, path, '', false, 'ansible');
      let changed = !before.exists;
      if (!ctx.checkMode) changed = applyAttributes(lx, path, args, changed);
      return ok(changed || !before.exists, { path });
    }
    if (state === 'link') {
      const src = str(args.src);
      if (!src) throw new ModuleError('src is required for state=link');
      if (before.node?.type === 'link' && before.node.target === src) return ok(false, { path });
      if (!ctx.checkMode) {
        if (before.exists) removeNode(lx, path, false, 'ansible');
        lx.fs[path] = { type: 'link', content: '', target: src, owner: asUser(ctx), group: asUser(ctx), mode: 0o777, mtime: 0 };
      }
      return ok(true, { path });
    }
    // state: file — only adjust attributes, and complain when it is missing.
    if (!before.exists) throw new ModuleError(`file (${path}) is absent, cannot continue`);
    const changed = ctx.checkMode ? false : applyAttributes(lx, path, args, false);
    return ok(changed, { path, mode: octal(getNode(lx, path)!.mode) });
  });
};

const copyModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.copy', rawArgs, {
    required: ['dest'],
    optional: ['src', 'content', 'owner', 'group', 'mode', 'backup', 'force'],
    aliases: { path: 'dest' },
  });
  if (args.src === undefined && args.content === undefined) throw new ModuleError('one of the following is required: src, content');
  const dest = remotePath(ctx, str(args.dest));
  const content = args.content !== undefined ? str(args.content) : sourceFile(ctx, str(args.src), 'files').content;
  return withUser(ctx, (lx) => {
    const before = fileState(lx, dest);
    const destIsDir = before.node?.type === 'dir';
    const finalPath = destIsDir && args.src !== undefined ? `${dest}/${str(args.src).split('/').pop()}` : dest;
    const current = fileState(lx, finalPath);
    let changed = !current.exists || current.content !== content;
    if (changed && !ctx.checkMode) writeAs(ctx, finalPath, content);
    if (!ctx.checkMode) changed = applyAttributes(lx, finalPath, args, changed);
    return ok(changed, { dest: finalPath, ...(changed ? { diff: { before: current.content, after: content, path: finalPath } } : {}) });
  });
};

const templateModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.template', rawArgs, {
    required: ['src', 'dest'],
    optional: ['owner', 'group', 'mode', 'backup', 'validate'],
  });
  const source = sourceFile(ctx, str(args.src), 'templates');
  const rendered = ctx.render(source.content);
  return copyModule({ dest: args.dest, content: rendered, ...(args.owner !== undefined ? { owner: args.owner } : {}), ...(args.group !== undefined ? { group: args.group } : {}), ...(args.mode !== undefined ? { mode: args.mode } : {}) }, ctx);
};

const lineinfileModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.lineinfile', rawArgs, {
    required: ['path'],
    optional: ['line', 'regexp', 'state', 'insertafter', 'insertbefore', 'create', 'owner', 'group', 'mode', 'backrefs'],
    aliases: { dest: 'path' },
  });
  const path = remotePath(ctx, str(args.path));
  const state = str(args.state, 'present');
  const line = str(args.line);
  const re = args.regexp !== undefined ? new RegExp(str(args.regexp)) : null;
  return withUser(ctx, (lx) => {
    const before = fileState(lx, path);
    if (!before.exists && !bool(args.create)) throw new ModuleError(`Destination ${path} does not exist !`);
    const lines = before.content === '' ? [] : before.content.replace(/\n$/, '').split('\n');
    let changed = false;
    if (state === 'absent') {
      const kept = lines.filter((l) => !(re ? re.test(l) : l === line));
      changed = kept.length !== lines.length;
      if (changed && !ctx.checkMode) writeAs(ctx, path, kept.length ? kept.join('\n') + '\n' : '');
      return ok(changed, { path, ...(changed ? { diff: { before: before.content, after: kept.join('\n') + '\n', path } } : {}) });
    }
    const idx = re ? lines.findIndex((l) => re.test(l)) : lines.indexOf(line);
    let next = [...lines];
    if (idx >= 0) {
      if (lines[idx] !== line) {
        next[idx] = line;
        changed = true;
      }
    } else {
      const after = args.insertafter !== undefined ? str(args.insertafter) : null;
      const beforeAt = args.insertbefore !== undefined ? str(args.insertbefore) : null;
      let at = next.length;
      if (after && after !== 'EOF') {
        const m = next.findIndex((l) => new RegExp(after).test(l));
        if (m >= 0) at = m + 1;
      } else if (beforeAt) {
        const m = beforeAt === 'BOF' ? 0 : next.findIndex((l) => new RegExp(beforeAt).test(l));
        if (m >= 0) at = m;
      }
      next = [...next.slice(0, at), line, ...next.slice(at)];
      changed = true;
    }
    const text = next.length ? next.join('\n') + '\n' : '';
    if (changed && !ctx.checkMode) writeAs(ctx, path, text);
    if (!ctx.checkMode) changed = applyAttributes(lx, path, args, changed);
    return ok(changed, { path, ...(changed ? { diff: { before: before.content, after: text, path } } : {}) });
  });
};

const blockinfileModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.blockinfile', rawArgs, {
    required: ['path'],
    optional: ['block', 'marker', 'state', 'create', 'insertafter', 'insertbefore', 'owner', 'group', 'mode'],
    aliases: { dest: 'path' },
  });
  const path = remotePath(ctx, str(args.path));
  const marker = str(args.marker, '# {mark} ANSIBLE MANAGED BLOCK');
  const begin = marker.replace('{mark}', 'BEGIN');
  const end = marker.replace('{mark}', 'END');
  const block = str(args.block).replace(/\n$/, '');
  return withUser(ctx, (lx) => {
    const before = fileState(lx, path);
    if (!before.exists && !bool(args.create)) throw new ModuleError(`Path ${path} does not exist !`);
    const text = before.content;
    const startAt = text.indexOf(begin);
    const endAt = text.indexOf(end);
    const wanted = `${begin}\n${block}\n${end}\n`;
    let next: string;
    if (startAt >= 0 && endAt > startAt) next = text.slice(0, startAt) + (str(args.state, 'present') === 'absent' ? '' : wanted) + text.slice(endAt + end.length + 1);
    else if (str(args.state, 'present') === 'absent') next = text;
    else next = text + (text && !text.endsWith('\n') ? '\n' : '') + wanted;
    const changed = next !== text;
    if (changed && !ctx.checkMode) writeAs(ctx, path, next);
    return ok(changed, { path, ...(changed ? { diff: { before: text, after: next, path } } : {}) });
  });
};

const statModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.stat', rawArgs, { required: ['path'], optional: ['get_checksum'] });
  const path = remotePath(ctx, str(args.path));
  const lx = target(ctx);
  const node = getNode(lx, path);
  if (!node) return ok(false, { stat: { exists: false } });
  return ok(false, {
    stat: {
      exists: true,
      isdir: node.type === 'dir',
      islnk: node.type === 'link',
      isreg: node.type === 'file',
      mode: octal(node.mode),
      pw_name: node.owner,
      gr_name: node.group,
      size: node.type === 'file' ? node.content.length : 4096,
      path,
    },
  });
};

const packageModule: Module = (rawArgs, ctx, ) => {
  const args = check('ansible.builtin.package', rawArgs, {
    required: ['name'],
    optional: ['state', 'update_cache', 'cache_valid_time'],
    aliases: { pkg: 'name' },
  });
  const names = list(args.name);
  const state = str(args.state, 'present');
  const lx = target(ctx);
  const installed = names.filter((n) => lx.packages.includes(n));
  if (state === 'absent') {
    if (!installed.length) return ok(false);
    if (ctx.checkMode) return ok(true);
    const r = shell(ctx, `apt-get remove -y ${installed.join(' ')}`);
    if (r.code !== 0) throw new ModuleError(r.err.join('\n') || 'apt failed');
    return ok(true, { stdout: r.out.join('\n') });
  }
  const missing = names.filter((n) => !lx.packages.includes(n));
  if (!missing.length) return ok(false);
  if (ctx.checkMode) return ok(true);
  const r = shell(ctx, `apt-get install -y ${missing.join(' ')}`);
  if (r.code !== 0) {
    throw new ModuleError(`No package matching '${missing[0]}' is available`, { stderr: r.err.join('\n') });
  }
  return ok(true, { stdout: r.out.join('\n') });
};

const serviceModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.service', rawArgs, {
    required: ['name'],
    optional: ['state', 'enabled', 'daemon_reload'],
  });
  const name = str(args.name).replace(/\.service$/, '');
  const lx = target(ctx);
  const svc = lx.services[name];
  if (!svc) throw new ModuleError(`Could not find the requested service ${name}: host`);
  const wanted = args.state !== undefined ? str(args.state) : null;
  let changed = false;
  const run = (line: string) => {
    if (ctx.checkMode) return;
    const r = shell(ctx, line);
    if (r.code !== 0) throw new ModuleError(r.err.join('\n') || r.out.join('\n') || `${line} failed`);
  };
  if (wanted === 'started' && !svc.active) {
    run(`systemctl start ${name}`);
    changed = true;
  } else if (wanted === 'stopped' && svc.active) {
    run(`systemctl stop ${name}`);
    changed = true;
  } else if (wanted === 'restarted') {
    run(`systemctl restart ${name}`);
    changed = true;
  } else if (wanted === 'reloaded') {
    run(`systemctl reload ${name}`);
    changed = true;
  }
  if (args.enabled !== undefined) {
    const want = bool(args.enabled);
    if (lx.services[name].enabled !== want) {
      run(`systemctl ${want ? 'enable' : 'disable'} ${name}`);
      changed = true;
    }
  }
  const after = lx.services[name];
  if (wanted === 'started' && !ctx.checkMode && !after.active) throw new ModuleError(`Unable to start service ${name}: see systemctl status ${name}`);
  return ok(changed, { name, state: after.active ? 'started' : 'stopped', enabled: after.enabled });
};

const userModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.user', rawArgs, {
    required: ['name'],
    optional: ['state', 'groups', 'append', 'shell', 'home', 'create_home', 'system', 'password', 'comment', 'uid', 'generate_ssh_key'],
  });
  const name = str(args.name);
  const lx = target(ctx);
  const existing = lx.users.find((u) => u.name === name);
  if (str(args.state, 'present') === 'absent') {
    if (!existing) return ok(false, { name, state: 'absent' });
    if (!ctx.checkMode) {
      const r = shell(ctx, `userdel -r ${name}`);
      if (r.code !== 0) throw new ModuleError(r.err.join('\n'));
    }
    return ok(true, { name, state: 'absent' });
  }
  let changed = false;
  if (!existing) {
    if (!ctx.checkMode) {
      const flags = [bool(args.system) ? '-r' : '', args.shell !== undefined ? `-s ${str(args.shell)}` : '-m', args.home !== undefined ? `-d ${str(args.home)}` : '', args.groups !== undefined ? `-G ${list(args.groups).join(',')}` : '', args.comment !== undefined ? `-c "${str(args.comment)}"` : ''].filter(Boolean).join(' ');
      const r = shell(ctx, `useradd ${flags} ${name}`);
      if (r.code !== 0) throw new ModuleError(r.err.join('\n') || r.out.join('\n'));
    }
    changed = true;
  } else {
    if (args.shell !== undefined && existing.shell !== str(args.shell)) {
      if (!ctx.checkMode) shell(ctx, `usermod -s ${str(args.shell)} ${name}`);
      changed = true;
    }
    if (args.groups !== undefined) {
      const want = list(args.groups);
      const have = existing.groups;
      const missing = want.filter((g) => !have.includes(g));
      const extra = bool(args.append, false) ? [] : have.filter((g) => !want.includes(g) && g !== 'sudo' && g !== name);
      if (missing.length || extra.length) {
        if (!ctx.checkMode) {
          const final = bool(args.append, false) ? [...have, ...missing] : want;
          shell(ctx, `usermod -G ${final.join(',')} ${name}`);
        }
        changed = true;
      }
    }
  }
  const user = lx.users.find((u) => u.name === name);
  if (args.password !== undefined && user && user.password !== str(args.password)) {
    if (!ctx.checkMode) user.password = str(args.password);
    changed = true;
  }
  return ok(changed, { name, home: user?.home ?? `/home/${name}`, shell: user?.shell ?? '/bin/bash', groups: user?.groups ?? [] });
};

const groupModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.group', rawArgs, { required: ['name'], optional: ['state', 'gid', 'system'] });
  const name = str(args.name);
  const lx = target(ctx);
  const exists = lx.groups.some((g) => g.name === name);
  if (str(args.state, 'present') === 'absent') {
    if (!exists) return ok(false, { name });
    if (!ctx.checkMode) shell(ctx, `groupdel ${name}`);
    return ok(true, { name });
  }
  if (exists) return ok(false, { name });
  if (!ctx.checkMode) {
    const r = shell(ctx, `groupadd ${name}`);
    if (r.code !== 0) throw new ModuleError(r.err.join('\n'));
  }
  return ok(true, { name });
};

const authorizedKeyModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.posix.authorized_key', rawArgs, { required: ['user', 'key'], optional: ['state', 'exclusive', 'path'] });
  const user = str(args.user);
  const lx = target(ctx);
  const home = lx.users.find((u) => u.name === user)?.home ?? `/home/${user}`;
  const path = args.path !== undefined ? str(args.path) : `${home}/.ssh/authorized_keys`;
  const key = str(args.key).trim();
  return withUser(ctx, (lx2) => {
    const before = fileState(lx2, path);
    const lines = before.content ? before.content.replace(/\n$/, '').split('\n') : [];
    const has = lines.includes(key);
    if (str(args.state, 'present') === 'absent') {
      if (!has) return ok(false);
      if (!ctx.checkMode) writeAs(ctx, path, lines.filter((l) => l !== key).join('\n') + '\n');
      return ok(true);
    }
    if (has) return ok(false);
    if (!ctx.checkMode) {
      if (!getNode(lx2, `${home}/.ssh`)) {
        makeDir(lx2, `${home}/.ssh`, true);
        const dir = getNode(lx2, `${home}/.ssh`)!;
        dir.mode = 0o700;
        dir.owner = user;
        dir.group = user;
      }
      writeAs(ctx, path, [...lines, key].join('\n') + '\n');
      const node = getNode(lx2, path)!;
      node.owner = user;
      node.group = user;
      node.mode = 0o600;
    }
    return ok(true, { key_options: null, user });
  });
};

const cronModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.cron', rawArgs, {
    required: ['name'],
    optional: ['job', 'minute', 'hour', 'day', 'month', 'weekday', 'user', 'state', 'disabled'],
  });
  const user = args.user !== undefined ? str(args.user) : asUser(ctx);
  const path = `/var/spool/cron/crontabs/${user}`;
  const name = str(args.name);
  const spec = [str(args.minute, '*'), str(args.hour, '*'), str(args.day, '*'), str(args.month, '*'), str(args.weekday, '*')].join(' ');
  const marker = `#Ansible: ${name}`;
  return withUser(ctx, (lx) => {
    const before = fileState(lx, path);
    const lines = before.content ? before.content.replace(/\n$/, '').split('\n') : [];
    const at = lines.indexOf(marker);
    const entry = `${spec} ${str(args.job)}`;
    let next = [...lines];
    let changed = false;
    if (str(args.state, 'present') === 'absent') {
      if (at < 0) return ok(false);
      next.splice(at, 2);
      changed = true;
    } else if (at >= 0) {
      if (next[at + 1] !== entry) {
        next[at + 1] = entry;
        changed = true;
      }
    } else {
      next = [...next, marker, entry];
      changed = true;
    }
    if (changed && !ctx.checkMode) {
      if (!getNode(lx, '/var/spool/cron/crontabs')) makeDir(lx, '/var/spool/cron/crontabs', true);
      writeAs(ctx, path, next.length ? next.join('\n') + '\n' : '');
    }
    return ok(changed, { name });
  });
};

const commandModule = (isShell: boolean): Module => (rawArgs, ctx) => {
  const args = check(isShell ? 'ansible.builtin.shell' : 'ansible.builtin.command', rawArgs, {
    required: [],
    optional: ['cmd', '_raw_params', 'chdir', 'creates', 'removes', 'warn', 'executable'],
  });
  const cmd = str(args.cmd ?? args._raw_params).trim();
  if (!cmd) throw new ModuleError('no command given');
  if (!isShell && /[|><&;]|\$\(/.test(cmd)) {
    throw new ModuleError(`Unsupported parameters... the command module does not support shell features such as pipes and redirection. Consider using the ansible.builtin.shell module instead.`);
  }
  const lx = target(ctx);
  if (args.creates !== undefined && getNode(lx, remotePath(ctx, str(args.creates)))) return { changed: false, skipped: true, msg: `skipped, since ${str(args.creates)} exists`, rc: 0, stdout: '', stderr: '', stdout_lines: [] };
  if (args.removes !== undefined && !getNode(lx, remotePath(ctx, str(args.removes)))) return { changed: false, skipped: true, msg: `skipped, since ${str(args.removes)} does not exist`, rc: 0, stdout: '', stderr: '', stdout_lines: [] };
  if (ctx.checkMode) return { changed: true, rc: 0, stdout: '', stderr: '', stdout_lines: [], msg: 'Command would have run if not in check mode' };
  const line = args.chdir !== undefined ? `cd ${str(args.chdir)} && ${cmd}` : cmd;
  const r = shell(ctx, line);
  const result: ModuleResult = { changed: true, rc: r.code, stdout: r.out.join('\n'), stderr: r.err.join('\n'), stdout_lines: r.out, stderr_lines: r.err, cmd };
  if (r.code !== 0) {
    result.failed = true;
    result.msg = 'non-zero return code';
  }
  return result;
};

const debugModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.debug', rawArgs, { required: [], optional: ['msg', 'var', 'verbosity'] });
  if (args.var !== undefined) {
    const name = str(args.var);
    let value: JValue;
    try {
      value = ctx.render(`{{ ${name} }}`);
    } catch {
      value = `VARIABLE IS NOT DEFINED!`;
    }
    return ok(false, { [name]: value as JValue, _debug_var: name });
  }
  return ok(false, { msg: args.msg !== undefined ? (args.msg as JValue) : 'Hello world!' });
};

const assertModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.assert', rawArgs, { required: ['that'], optional: ['fail_msg', 'success_msg', 'msg', 'quiet'] });
  void ctx;
  const failed = (args as { _failed?: boolean })._failed;
  void failed;
  return ok(false, { msg: str(args.success_msg, 'All assertions passed') });
};

const uriModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.uri', rawArgs, { required: ['url'], optional: ['return_content', 'status_code', 'method', 'validate_certs', 'headers', 'body', 'body_format'] });
  const url = str(args.url);
  const flags = ['-i', '-k'];
  if (args.method !== undefined) flags.push('-X', str(args.method));
  const r = curl(ctx.network, ctx.network.hosts[ctx.controlNode], [...flags, url]);
  const statusLine = r.output.find((l) => /^HTTP\/1\.1 \d+/.test(l));
  const status = statusLine ? Number(/^HTTP\/1\.1 (\d+)/.exec(statusLine)![1]) : 0;
  const wanted = args.status_code !== undefined ? list(args.status_code).map(Number) : [200];
  const blank = r.output.indexOf('');
  const content = blank >= 0 ? r.output.slice(blank + 1).join('\n') : '';
  if (!status) throw new ModuleError(`Status code was -1 and not [${wanted.join(', ')}]: Request failed: ${r.output.join(' ')}`);
  if (!wanted.includes(status)) throw new ModuleError(`Status code was ${status} and not [${wanted.join(', ')}]: HTTP Error ${status}`, { status });
  return ok(false, { status, url, ...(bool(args.return_content) ? { content } : {}) });
};

const setupModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.setup', rawArgs, { required: [], optional: ['filter', 'gather_subset'] });
  const facts = ctx.device ? iosFacts(ctx.device) : linuxFacts(target(ctx), ctx.network.hosts[ctx.node] ?? {});
  const patterns = args.filter === undefined ? [] : (Array.isArray(args.filter) ? args.filter : [args.filter]).map(String);
  if (!patterns.length) return { changed: false, ansible_facts: facts };
  const matches = (name: string) => patterns.some((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name));
  return { changed: false, ansible_facts: Object.fromEntries(Object.entries(facts).filter(([k]) => matches(k))) };
};

// --- cisco.ios

const iosFactsModule: Module = (rawArgs, ctx) => {
  check('cisco.ios.ios_facts', rawArgs, { required: [], optional: ['gather_subset', 'gather_network_resources'] });
  if (!ctx.device) throw new ModuleError('ios_facts needs a network device');
  return { changed: false, ansible_facts: iosFacts(ctx.device) };
};

/**
 * network_cli logs in like a person does, and a person has to reach privileged EXEC
 * before running `show running-config` or configuring anything. A device with an enable
 * secret asks for it, and the play supplies it the way a real one does.
 */
function iosEnable(ctx: ModuleCtx, net: NetworkState): NetworkState {
  if (net.devices[ctx.node].mode !== 'user') return net;
  let now = executeOn(net, ctx.node, 'enable').network;
  if (now.devices[ctx.node].pendingInput) {
    const secret = String(ctx.vars.ansible_become_password ?? ctx.vars.ansible_become_pass ?? ctx.vars.ansible_password ?? '');
    now = executeOn(now, ctx.node, secret).network;
  }
  if (now.devices[ctx.node].mode === 'user') {
    throw new ModuleError('unable to elevate privilege to enable mode, at prompt [Password: ] with error: Bad secrets. Set ansible_become_password to the enable secret.');
  }
  return now;
}

const iosCommandModule: Module = (rawArgs, ctx) => {
  const args = check('cisco.ios.ios_command', rawArgs, { required: ['commands'], optional: ['wait_for', 'retries'] });
  if (!ctx.device) throw new ModuleError('ios_command needs a network device');
  const commands = list(args.commands);
  const bad = commands.find((c) => !/^\s*(show|ping|traceroute|dir)\b/.test(c));
  if (bad) throw new ModuleError(`ios_command does not support running config mode commands. Please use ios_config instead: ${bad}`);
  const out: string[] = [];
  let net = iosEnable(ctx, ctx.network);
  for (const c of commands) {
    const r = executeOn(net, ctx.node, c);
    net = r.network;
    out.push(r.output.join('\n'));
  }
  Object.assign(ctx.network.devices[ctx.node], net.devices[ctx.node]);
  return ok(false, { stdout: out, stdout_lines: out.map((o) => o.split('\n')) });
};

const iosConfigModule: Module = (rawArgs, ctx) => {
  const args = check('cisco.ios.ios_config', rawArgs, { required: [], optional: ['lines', 'parents', 'save_when', 'before', 'after', 'match', 'backup', 'src'] });
  if (!ctx.device) throw new ModuleError('ios_config needs a network device');
  // src names a file on the control node, which ios_config renders as a template first.
  const lines =
    args.src !== undefined
      ? ctx
          .render(sourceFile(ctx, str(args.src), 'templates').content)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('!'))
      : list(args.lines);
  if (!lines.length) throw new ModuleError('one of the following is required: lines, src');
  const parents = list(args.parents);
  const before = renderConfigBody(ctx.device).join('\n');
  if (ctx.checkMode) {
    // Work out what would change by applying to a copy of the device.
    let net = iosEnable(ctx, structuredClone(ctx.network));
    for (const line of ['configure terminal', ...parents, ...lines, 'end']) net = executeOn(net, ctx.node, line).network;
    const after = renderConfigBody(net.devices[ctx.node]).join('\n');
    return ok(after !== before, { commands: [...parents, ...lines] });
  }
  let net = iosEnable(ctx, ctx.network);
  const applied: string[] = [];
  for (const line of ['configure terminal', ...list(args.before), ...parents, ...lines, ...list(args.after), 'end']) {
    const r = executeOn(net, ctx.node, line);
    net = r.network;
    const complaint = r.output.find((l) => l.startsWith('%'));
    if (complaint) throw new ModuleError(complaint.trim(), { commands: applied });
    applied.push(line);
  }
  Object.assign(ctx.network.devices[ctx.node], net.devices[ctx.node]);
  const after = renderConfigBody(ctx.network.devices[ctx.node]).join('\n');
  const changed = after !== before;
  const saveWhen = str(args.save_when, 'never');
  if (changed && (saveWhen === 'always' || saveWhen === 'modified')) {
    const r = executeOn(ctx.network, ctx.node, 'write memory');
    Object.assign(ctx.network.devices[ctx.node], r.network.devices[ctx.node]);
  }
  return ok(changed, { commands: [...parents, ...lines], updates: [...parents, ...lines] });
};

const ufwModule: Module = (rawArgs, ctx) => {
  const args = check('community.general.ufw', rawArgs, { required: [], optional: ['rule', 'port', 'proto', 'state', 'direction', 'from_ip', 'to_port'] });
  const lx = target(ctx);
  const path = '/etc/ufw/user.rules';
  return withUser(ctx, () => {
    const before = fileState(lx, path);
    const lines = before.content ? before.content.replace(/\n$/, '').split('\n') : [];
    let changed = false;
    const state = str(args.state);
    if (state === 'enabled' || state === 'disabled') {
      const want = state === 'enabled';
      const svc = (lx.services.ufw ??= { name: 'ufw', description: 'Uncomplicated firewall', active: false, enabled: false });
      if (svc.active !== want) {
        if (!ctx.checkMode) {
          svc.active = want;
          svc.enabled = want;
        }
        changed = true;
      }
    }
    if (args.rule !== undefined) {
      const entry = `${str(args.rule)} ${str(args.proto, 'tcp')} ${str(args.port ?? args.to_port)}${args.from_ip !== undefined ? ` from ${str(args.from_ip)}` : ''}`.trim();
      if (!lines.includes(entry)) {
        if (!ctx.checkMode) {
          if (!getNode(lx, '/etc/ufw')) makeDir(lx, '/etc/ufw', true);
          writeAs(ctx, path, [...lines, entry].join('\n') + '\n');
        }
        changed = true;
      }
    }
    return ok(changed);
  });
};

const slurpModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.slurp', rawArgs, { required: ['src'], optional: [] });
  const path = remotePath(ctx, str(args.src));
  const r = readFile(target(ctx), path);
  if ('error' in r) throw new ModuleError(`file not found: ${path}`);
  return ok(false, { content: btoa(unescape(encodeURIComponent(r.content))), encoding: 'base64', source: path });
};

const findModule: Module = (rawArgs, ctx) => {
  const args = check('ansible.builtin.find', rawArgs, { required: ['paths'], optional: ['patterns', 'file_type', 'recurse', 'age'] });
  const lx = target(ctx);
  const patterns = list(args.patterns).map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
  const files: JValue[] = [];
  for (const base of list(args.paths)) {
    const dir = remotePath(ctx, base);
    for (const name of listDir(lx, dir)) {
      const node = getNode(lx, `${dir}/${name}`);
      if (!node || (str(args.file_type, 'file') === 'file' && node.type !== 'file')) continue;
      if (patterns.length && !patterns.some((p) => p.test(name))) continue;
      files.push({ path: `${dir}/${name}`, size: node.type === 'file' ? node.content.length : 0, mode: octal(node.mode) });
    }
  }
  return ok(false, { files, matched: files.length });
};

/** Modules by their short name; the fully qualified names map onto these. */
export const MODULES: Record<string, Module> = {
  file: fileModule,
  copy: copyModule,
  template: templateModule,
  lineinfile: lineinfileModule,
  blockinfile: blockinfileModule,
  stat: statModule,
  slurp: slurpModule,
  find: findModule,
  package: packageModule,
  apt: packageModule,
  service: serviceModule,
  systemd: serviceModule,
  systemd_service: serviceModule,
  user: userModule,
  group: groupModule,
  authorized_key: authorizedKeyModule,
  cron: cronModule,
  command: commandModule(false),
  shell: commandModule(true),
  raw: commandModule(true),
  debug: debugModule,
  assert: assertModule,
  uri: uriModule,
  setup: setupModule,
  ping: () => ok(false, { ping: 'pong' }),
  ufw: ufwModule,
  ios_facts: iosFactsModule,
  ios_command: iosCommandModule,
  ios_config: iosConfigModule,
};

/** Collections these modules come from, for "module not found" messages and FQCNs. */
export const MODULE_COLLECTIONS: Record<string, string> = {
  ufw: 'community.general',
  authorized_key: 'ansible.posix',
  ios_facts: 'cisco.ios',
  ios_command: 'cisco.ios',
  ios_config: 'cisco.ios',
};

/** Modules that only exist on Red Hat systems, so a lab says so plainly rather than pretending. */
export const UNSUPPORTED_MODULES: Record<string, string> = {
  dnf: "the dnf module needs a Red Hat system; NetLab's managed nodes run Ubuntu, so use ansible.builtin.package or ansible.builtin.apt",
  yum: "the yum module needs a Red Hat system; NetLab's managed nodes run Ubuntu, so use ansible.builtin.package or ansible.builtin.apt",
  firewalld: "the firewalld module needs a Red Hat system; NetLab's managed nodes run Ubuntu, so use community.general.ufw",
  selinux: 'SELinux is not simulated by NetLab',
  parted: 'storage and filesystem modules are not simulated by NetLab',
  lvg: 'storage and filesystem modules are not simulated by NetLab',
  lvol: 'storage and filesystem modules are not simulated by NetLab',
  filesystem: 'storage and filesystem modules are not simulated by NetLab',
  mount: 'storage and filesystem modules are not simulated by NetLab',
};

export function resolveModule(name: string): { module: Module; fqcn: string } | { error: string } {
  const short = name.includes('.') ? name.split('.').pop()! : name;
  const namespace = name.includes('.') ? name.split('.').slice(0, -1).join('.') : '';
  if (UNSUPPORTED_MODULES[short]) return { error: UNSUPPORTED_MODULES[short] };
  const module = MODULES[short];
  if (!module) return { error: `couldn't resolve module/action '${name}'. This often indicates a misspelling, missing collection, or incorrect module path.` };
  const collection = MODULE_COLLECTIONS[short] ?? 'ansible.builtin';
  if (namespace && namespace !== collection && namespace !== 'ansible.builtin') {
    return { error: `couldn't resolve module/action '${name}'. This often indicates a misspelling, missing collection, or incorrect module path.` };
  }
  return { module, fqcn: `${collection}.${short}` };
}
