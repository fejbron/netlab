/**
 * Running a playbook: resolving hosts, gathering facts, then walking plays, roles,
 * blocks and tasks with their loops, conditions, handlers and error handling, printing
 * what Ansible prints as it goes.
 *
 * Connections are simulated honestly. A managed node is reachable when the control node
 * can actually reach it over the network and the login would work: an authorized key
 * for the remote user, or a password in the inventory. A network device needs SSH
 * enabled on it. Anything else is UNREACHABLE, with the message ssh would have given.
 */
import { getNode, normalizePath, readFile, type LinuxState } from '../linux/fs';
import { ping } from '../network';
import type { NetworkState } from '../network';
import { condition, template, TemplateError, type Ctx, type JValue } from './jinja';
import { groupsOf, inventoryVars, loadInventory, selectHosts, type Inventory } from './inventory';
import { linuxFacts, iosFacts, ModuleError, resolveModule, type Diff, type ModuleCtx, type ModuleResult } from './modules';
import { decryptValues, isVaulted, vaultDecrypt, VaultError } from './vault';
import { parseYaml, YamlError, type YamlValue } from './yaml';

export const ANSIBLE_VERSION = '2.16.3';

export interface AnsibleEnv {
  network: NetworkState;
  controlNode: string;
  control: LinuxState;
  cwd: string;
  env: Record<string, string>;
  out: (line: string) => void;
}

export interface AnsibleConfig {
  inventory?: string;
  remote_user?: string;
  become?: boolean;
  become_user?: string;
  host_key_checking?: boolean;
  roles_path?: string;
  collections_path?: string;
  vault_password_file?: string;
  gathering?: string;
  forks?: number;
  /** Where the settings came from, for ansible-config. */
  source?: string;
}

export interface RunOptions {
  inventoryPaths: string[];
  limit?: string;
  tags: string[];
  skipTags: string[];
  extraVars: Record<string, JValue>;
  check: boolean;
  diff: boolean;
  verbosity: number;
  vaultPasswords: string[];
  become?: boolean;
  remoteUser?: string;
  listHosts?: boolean;
  listTasks?: boolean;
  syntaxCheck?: boolean;
  startAtTask?: string;
}

export interface HostStats {
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  skipped: number;
  rescued: number;
  ignored: number;
}

export interface RunResult {
  failed: boolean;
  stats: Record<string, HostStats>;
  /** Every task that ran, for grading and for "did the playbook do anything" checks. */
  tasks: Array<{ play: string; task: string; host: string; status: 'ok' | 'changed' | 'failed' | 'skipped' | 'unreachable' | 'ignored' }>;
}

export class PlaybookError extends Error {}

const WIDTH = 79;

function banner(kind: string, title: string): string {
  const text = `${kind} [${title}] `;
  return text.length >= WIDTH ? text : text + '*'.repeat(WIDTH - text.length);
}

function emptyStats(): HostStats {
  return { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 };
}

interface HostRun {
  name: string;
  node: string;
  kind: 'linux' | 'ios' | 'local';
  facts: Record<string, JValue>;
  /** set_fact and registered variables, which outlive the play. */
  hostVars: Record<string, JValue>;
  failed: boolean;
  unreachable: boolean;
  notified: string[];
}

interface TaskDef {
  raw: Record<string, YamlValue>;
  name: string;
  module: string;
  args: Record<string, JValue>;
  /** Free-form "module: key=value" style arguments. */
  rawArgs?: string;
}

interface RoleContext {
  name: string;
  dir: string;
  defaults: Record<string, JValue>;
  vars: Record<string, JValue>;
}

const TASK_KEYWORDS = new Set([
  'name',
  'when',
  'loop',
  'with_items',
  'with_dict',
  'with_fileglob',
  'register',
  'become',
  'become_user',
  'notify',
  'tags',
  'ignore_errors',
  'failed_when',
  'changed_when',
  'vars',
  'delegate_to',
  'run_once',
  'block',
  'rescue',
  'always',
  'until',
  'retries',
  'delay',
  'no_log',
  'args',
  'environment',
  'check_mode',
  'listen',
  'local_action',
  'any_errors_fatal',
  'throttle',
]);

const PLAY_KEYWORDS = new Set(['name', 'hosts', 'become', 'become_user', 'gather_facts', 'vars', 'vars_files', 'tasks', 'pre_tasks', 'post_tasks', 'handlers', 'roles', 'remote_user', 'serial', 'any_errors_fatal', 'ignore_unreachable', 'tags', 'collections', 'strategy', 'force_handlers', 'environment', 'connection', 'max_fail_percentage']);

export class Runner {
  private inventory!: Inventory;
  private hosts: Record<string, HostRun> = {};
  stats: Record<string, HostStats> = {};
  tasks: RunResult['tasks'] = [];
  private failed = false;
  private playName = '';

  constructor(
    private env: AnsibleEnv,
    private config: AnsibleConfig,
    private opts: RunOptions,
  ) {}

  // --- files

  private readControl(path: string): string | null {
    const r = readFile(this.env.control, normalizePath(this.env.cwd, path, `/home/${this.env.control.user}`));
    if ('error' in r) return null;
    if (isVaulted(r.content)) return vaultDecrypt(r.content, this.opts.vaultPasswords);
    return r.content;
  }

  private loadYaml(path: string): YamlValue {
    const text = this.readControl(path);
    if (text === null) throw new PlaybookError(`the file_name '${path}' does not exist, or is not readable`);
    try {
      return decryptValues(parseYaml(text), this.opts.vaultPasswords);
    } catch (e) {
      if (e instanceof YamlError) throw e;
      if (e instanceof VaultError) throw new PlaybookError(e.message);
      throw e;
    }
  }

  // --- hosts

  private resolveHost(name: string): HostRun {
    const vars = inventoryVars(this.inventory, name);
    const net = this.env.network;
    const connection = String(vars.ansible_connection ?? '');
    if (name === 'localhost' || name === '127.0.0.1' || connection === 'local') {
      return { name, node: this.env.controlNode, kind: 'local', facts: {}, hostVars: {}, failed: false, unreachable: false, notified: [] };
    }
    const wanted = String(vars.ansible_host ?? name);
    let node = net.hosts[name] || net.devices[name] ? name : '';
    if (!node) {
      node =
        Object.values(net.hosts).find((h) => h.name === wanted || h.ip === wanted || h.linux?.hostname === wanted)?.id ??
        Object.values(net.devices).find((d) => d.hostname === wanted || Object.values(d.interfaces).some((i) => i.ipAddress === wanted))?.id ??
        '';
    }
    const kind: HostRun['kind'] = node && net.devices[node] ? 'ios' : 'linux';
    return { name, node, kind, facts: {}, hostVars: {}, failed: false, unreachable: false, notified: [] };
  }

  /** Check the connection once per host, reporting UNREACHABLE under the current task. */
  private ensureConnected(host: HostRun): boolean {
    if (host.unreachable) return false;
    if (this.connected.has(host.name)) return true;
    const error = this.connectionError(host);
    this.connected.add(host.name);
    if (!error) return true;
    host.unreachable = true;
    this.statsOf(host.name).unreachable++;
    this.failed = true;
    this.say(`fatal: [${host.name}]: UNREACHABLE! => ${JSON.stringify({ changed: false, msg: error, unreachable: true })}`);
    this.tasks.push({ play: this.playName, task: 'connection', host: host.name, status: 'unreachable' });
    return false;
  }

  private connected = new Set<string>();

  /** Could we actually log in? Returns null when we could, or the message ssh would print. */
  private connectionError(host: HostRun): string | null {
    if (host.kind === 'local') return null;
    const net = this.env.network;
    if (!host.node) return `Failed to connect to the host via ssh: ssh: Could not resolve hostname ${host.name}: Name or service not known`;
    const vars = this.varsFor(host, {});
    const address = String(vars.ansible_host ?? (net.hosts[host.node]?.ip || Object.values(net.devices[host.node]?.interfaces ?? {}).find((i) => i.ipAddress)?.ipAddress) ?? '');
    if (address) {
      const reply = ping(net, this.env.controlNode, address);
      if (!reply.success) return `Failed to connect to the host via ssh: ssh: connect to host ${address} port 22: No route to host`;
    }
    const user = String(vars.ansible_user ?? this.opts.remoteUser ?? this.config.remote_user ?? this.env.control.user);
    if (host.kind === 'ios') {
      const dev = net.devices[host.node];
      const sshReady = Boolean(dev.rsaKeyBits && dev.users.length && dev.lines.vty.transportInput !== 'none');
      if (!sshReady) return `Unable to connect to port 22 on ${address || host.name}`;
      if (!dev.users.some((u) => u.username === user)) return `Failed to connect to the host via ssh: Permission denied (publickey,password).`;
      return null;
    }
    const lx = net.hosts[host.node]?.linux;
    if (!lx) return `Failed to connect to the host via ssh: ssh: connect to host ${host.name} port 22: Connection refused`;
    if (!lx.services.ssh?.active) return `Failed to connect to the host via ssh: ssh: connect to host ${address || host.name} port 22: Connection refused`;
    if (!lx.users.some((u) => u.name === user)) return `Failed to connect to the host via ssh: Permission denied (publickey,password).`;
    if (vars.ansible_password !== undefined || vars.ansible_ssh_pass !== undefined) return null;
    const home = lx.users.find((u) => u.name === user)!.home;
    const keys = readFile({ ...lx, user: 'root' }, `${home}/.ssh/authorized_keys`);
    const pub = readFile(this.env.control, `/home/${this.env.control.user}/.ssh/id_rsa.pub`);
    if ('error' in keys || 'error' in pub || !keys.content.includes(pub.content.trim())) {
      return `Failed to connect to the host via ssh: ${user}@${address || host.name}: Permission denied (publickey,password).`;
    }
    return null;
  }

  // --- variables

  private hostvarsSnapshot(): Record<string, JValue> {
    const out: Record<string, JValue> = {};
    for (const [name, host] of Object.entries(this.hosts)) out[name] = { ...inventoryVars(this.inventory, name), ...host.facts, ...host.hostVars };
    return out;
  }

  varsFor(host: HostRun, extra: Record<string, JValue>): Record<string, JValue> {
    const groups: Record<string, JValue> = {};
    for (const g of Object.keys(this.inventory.groups)) groups[g] = selectHosts(this.inventory, g);
    return {
      ...inventoryVars(this.inventory, host.name),
      ...host.facts,
      ...extra,
      ...host.hostVars,
      ...this.opts.extraVars,
      inventory_hostname: host.name,
      inventory_hostname_short: host.name.split('.')[0],
      ansible_facts: host.facts.ansible_facts ?? Object.fromEntries(Object.entries(host.facts).map(([k, v]) => [k.replace(/^ansible_/, ''), v])),
      group_names: groupsOf(this.inventory, host.name).filter((g) => g !== 'all'),
      groups,
      hostvars: this.hostvarsSnapshot(),
      ansible_check_mode: this.opts.check,
      ansible_diff_mode: this.opts.diff,
      ansible_version: { full: ANSIBLE_VERSION, major: 2, minor: 16 },
      playbook_dir: this.env.cwd,
      ansible_playbook_python: '/usr/bin/python3',
      omit: '__omit_place_holder__',
    };
  }

  private ctxFor(vars: Record<string, JValue>): Ctx {
    return {
      vars,
      lookup: (kind, arg) => {
        if (kind === 'file') {
          const text = this.readControl(arg);
          if (text === null) throw new TemplateError(`could not locate file in lookup: ${arg}`);
          return text.replace(/\n$/, '');
        }
        if (kind === 'env') return this.env.env[arg] ?? '';
        if (kind === 'vars') return vars[arg];
        throw new TemplateError(`lookup plugin '${kind}' is not simulated by NetLab`);
      },
    };
  }

  // --- output

  private say(line: string) {
    this.env.out(line);
  }

  private statsOf(name: string): HostStats {
    return (this.stats[name] ??= emptyStats());
  }

  private renderDiff(diff: Diff): string[] {
    const before = diff.before ? diff.before.replace(/\n$/, '').split('\n') : [];
    const after = diff.after ? diff.after.replace(/\n$/, '').split('\n') : [];
    const out = ['--- before' + (diff.path ? `: ${diff.path}` : ''), '+++ after' + (diff.path ? `: ${diff.path}` : ''), `@@ -1,${before.length} +1,${after.length} @@`];
    let i = 0;
    while (i < before.length && i < after.length && before[i] === after[i]) {
      out.push(' ' + before[i]);
      i++;
    }
    for (let j = i; j < before.length; j++) out.push('-' + before[j]);
    for (let j = i; j < after.length; j++) out.push('+' + after[j]);
    out.push('');
    return out;
  }

  private resultLine(status: string, host: string, item: JValue | undefined, result: ModuleResult, moduleName: string): void {
    const itemText = item === undefined ? '' : ` => (item=${typeof item === 'object' ? JSON.stringify(item) : String(item)})`;
    const shown: Record<string, JValue> = {};
    for (const [k, v] of Object.entries(result)) {
      if (k === 'diff' || k === '_debug_var' || v === undefined) continue;
      shown[k] = v as JValue;
    }
    if (moduleName === 'debug') {
      const body = result._debug_var ? { [String(result._debug_var)]: result[String(result._debug_var)] as JValue } : { msg: (result.msg ?? '') as JValue };
      const json = JSON.stringify(body, null, 4);
      this.say(`${status}: [${host}]${itemText} => ${json}`);
      return;
    }
    if (this.opts.verbosity > 0) this.say(`${status}: [${host}]${itemText} => ${JSON.stringify(shown)}`);
    else this.say(`${status}: [${host}]${itemText}`);
  }

  // --- tasks

  private taskFrom(raw: YamlValue): TaskDef {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlaybookError('A malformed block was encountered while loading a block');
    const entry = raw as Record<string, YamlValue>;
    const keys = Object.keys(entry);
    const moduleKey = keys.find((k) => !TASK_KEYWORDS.has(k));
    const name = String(entry.name ?? '');
    if (!moduleKey) {
      if (entry.block) return { raw: entry, name, module: 'block', args: {} };
      throw new PlaybookError(`no module/action detected in task${name ? ` ${name}` : ''}.`);
    }
    const value = entry[moduleKey];
    let args: Record<string, JValue> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) args = { ...(value as Record<string, JValue>) };
    else if (typeof value === 'string') {
      // "command: ls -l" or "file: path=/tmp state=directory"
      const pairs = value.match(/(\w+)=("[^"]*"|'[^']*'|\S+)/g);
      const looksLikeArgs = pairs && pairs.join(' ').length >= value.trim().length - 1;
      if (looksLikeArgs && !['command', 'shell', 'raw', 'script'].includes(moduleKey.split('.').pop()!)) {
        for (const pair of pairs!) {
          const at = pair.indexOf('=');
          args[pair.slice(0, at)] = pair.slice(at + 1).replace(/^['"]|['"]$/g, '');
        }
      } else args._raw_params = value;
    } else if (value !== null) args = { _raw_params: value as JValue };
    if (entry.args && typeof entry.args === 'object') Object.assign(args, entry.args as Record<string, JValue>);
    return { raw: entry, name, module: moduleKey, args };
  }

  private tagsOf(raw: Record<string, YamlValue>): string[] {
    const t = raw.tags;
    if (!t) return [];
    return Array.isArray(t) ? t.map(String) : String(t).split(',').map((s) => s.trim());
  }

  private tagged(tags: string[]): boolean {
    const all = ['all', ...tags];
    if (this.opts.skipTags.length && tags.some((t) => this.opts.skipTags.includes(t))) return false;
    if (!this.opts.tags.length) return true;
    if (this.opts.tags.includes('all')) return true;
    return all.some((t) => this.opts.tags.includes(t)) && tags.length > 0;
  }

  /** Run one task across every host still in the play. */
  private runTask(task: TaskDef, hosts: HostRun[], role: RoleContext | null, playVars: Record<string, JValue>, inherited: { become: boolean; becomeUser: string; tags: string[] }, quiet = false): void {
    const raw = task.raw;
    const tags = [...inherited.tags, ...this.tagsOf(raw)];
    if (task.module === 'block') {
      this.runBlock(task, hosts, role, playVars, { ...inherited, tags });
      return;
    }
    if (!this.tagged(tags)) return;
    const become = raw.become !== undefined ? Boolean(raw.become) : inherited.become;
    const becomeUser = String(raw.become_user ?? inherited.becomeUser);
    const live = hosts.filter((h) => !h.failed && !h.unreachable);
    if (!live.length) return;

    const short = task.module.split('.').pop()!;
    if (!quiet) {
      this.say('');
      this.say(banner('TASK', role ? `${role.name} : ${task.name || short}` : task.name || task.module));
    }

    // Anything that pulls in more tasks runs here, where the runner is in scope.
    if (['include_tasks', 'import_tasks', 'include_role', 'import_role'].includes(short)) {
      const ctx = this.ctxFor(this.varsFor(live[0], playVars));
      const value = String(template((task.args.file ?? task.args._raw_params ?? task.args.name) as JValue, ctx));
      if (short === 'include_role' || short === 'import_role') {
        this.runRole({ role: value, ...(raw.vars ? { vars: raw.vars } : {}) } as YamlValue, live, playVars, { ...inherited, tags });
      } else {
        const file = role ? this.findRoleFile(role, `tasks/${value.replace(/\.ya?ml$/, '')}`) ?? value : value;
        for (const t of ((this.loadYaml(file) as YamlValue[]) ?? [])) this.runTask(this.taskFrom(t), live, role, playVars, { ...inherited, tags });
      }
      return;
    }

    // Connect lazily, so an unreachable host is reported under the task that needed it.
    for (const host of live) this.ensureConnected(host);

    const reachable = live.filter((h) => !h.unreachable);
    const runOnce = Boolean(raw.run_once);
    const targets = runOnce ? reachable.slice(0, 1) : reachable;

    for (const host of targets) {
      const taskVars = { ...playVars, ...(role ? { ...role.defaults, ...role.vars } : {}), ...((raw.vars as Record<string, JValue>) ?? {}) };
      let items: JValue[] | undefined;
      const vars = this.varsFor(host, taskVars);
      const ctx = this.ctxFor(vars);
      try {
        const loopSource = raw.loop ?? raw.with_items ?? raw.with_dict;
        if (loopSource !== undefined) {
          const value = template(loopSource as JValue, ctx);
          if (raw.with_dict !== undefined && value && typeof value === 'object' && !Array.isArray(value)) {
            items = Object.entries(value as Record<string, JValue>).map(([key, val]) => ({ key, value: val }));
          } else items = Array.isArray(value) ? value : value === null ? [] : [value];
        }
      } catch (e) {
        this.taskFailed(host, task, e, Boolean(raw.ignore_errors), undefined, short);
        continue;
      }

      const results: ModuleResult[] = [];
      let anyChanged = false;
      let anySkipped = items !== undefined && items.length === 0;
      let taskFailedFlag = false;

      const runOne = (item: JValue | undefined): boolean => {
        const localVars = { ...vars, ...(item !== undefined ? { item } : {}) };
        const localCtx = this.ctxFor(localVars);
        // when:
        if (raw.when !== undefined) {
          let keep: boolean;
          try {
            keep = condition(raw.when as JValue, localCtx);
          } catch (e) {
            this.taskFailed(host, task, e, Boolean(raw.ignore_errors), item, short);
            return false;
          }
          if (!keep) {
            anySkipped = true;
            if (items !== undefined) this.say(`skipping: [${host.name}] => (item=${typeof item === 'object' ? JSON.stringify(item) : String(item)})`);
            return true;
          }
        }
        let result: ModuleResult;
        try {
          result = this.invoke(task, short, localVars, localCtx, host, { become, becomeUser }, role);
        } catch (e) {
          this.taskFailed(host, task, e, Boolean(raw.ignore_errors), item, short);
          return false;
        }
        // changed_when / failed_when
        const resultCtx = this.ctxFor({ ...localVars, ...(result as Record<string, JValue>) });
        if (raw.changed_when !== undefined) result.changed = condition(raw.changed_when as JValue, resultCtx);
        if (raw.failed_when !== undefined) {
          const failedNow = condition(raw.failed_when as JValue, resultCtx);
          result.failed = failedNow;
          if (!failedNow) delete result.msg;
        }
        results.push(result);
        if (result.failed) {
          this.taskFailed(host, task, new ModuleError(String(result.msg ?? 'failed')), Boolean(raw.ignore_errors), item, short, result);
          return false;
        }
        if (result.skipped) {
          anySkipped = true;
          this.say(`skipping: [${host.name}]${item !== undefined ? ` => (item=${String(item)})` : ''}`);
          return true;
        }
        if (result.changed) anyChanged = true;
        this.resultLine(result.changed ? 'changed' : 'ok', host.name, item, result, short);
        if (this.opts.diff && result.diff && result.diff.before !== result.diff.after) for (const l of this.renderDiff(result.diff)) this.say(l);
        return true;
      };

      if (items === undefined) {
        if (!runOne(undefined)) taskFailedFlag = true;
      } else {
        for (const item of items) if (!runOne(item)) taskFailedFlag = true;
      }
      if (taskFailedFlag) continue;

      // register
      if (raw.register) {
        const value: Record<string, JValue> =
          items === undefined
            ? ({ ...(results[0] as Record<string, JValue>), changed: anyChanged, failed: false, skipped: Boolean(anySkipped && !results.length) } as Record<string, JValue>)
            : { changed: anyChanged, failed: false, skipped: anySkipped && results.length === 0, results: results as unknown as JValue };
        host.hostVars[String(raw.register)] = value;
      }
      if (anySkipped && !results.length) {
        this.statsOf(host.name).skipped++;
        this.tasks.push({ play: this.playName, task: task.name || short, host: host.name, status: 'skipped' });
        if (items === undefined) this.say(`skipping: [${host.name}]`);
        continue;
      }
      const stats = this.statsOf(host.name);
      stats.ok++;
      if (anyChanged) stats.changed++;
      this.tasks.push({ play: this.playName, task: task.name || short, host: host.name, status: anyChanged ? 'changed' : 'ok' });
      // notify
      if (anyChanged && raw.notify) {
        const names = Array.isArray(raw.notify) ? raw.notify.map(String) : [String(raw.notify)];
        for (const n of names) if (!host.notified.includes(n)) host.notified.push(n);
      }
    }
  }

  private taskFailed(host: HostRun, task: TaskDef, e: unknown, ignore: boolean, item: JValue | undefined, short: string, result?: ModuleResult): void {
    const message = e instanceof ModuleError || e instanceof TemplateError || e instanceof Error ? e.message : String(e);
    const payload: Record<string, JValue> = { changed: Boolean(result?.changed), msg: message };
    if (result) for (const [k, v] of Object.entries(result)) if (!['diff', 'failed'].includes(k) && v !== undefined) payload[k] = v as JValue;
    if (e instanceof ModuleError) Object.assign(payload, e.extra);
    const itemText = item === undefined ? '' : ` (item=${typeof item === 'object' ? JSON.stringify(item) : String(item)})`;
    this.say(`fatal: [${host.name}]:${itemText} FAILED! => ${JSON.stringify(payload)}`);
    const stats = this.statsOf(host.name);
    if (ignore) {
      this.say('...ignoring');
      stats.ignored++;
      stats.ok++;
      this.tasks.push({ play: this.playName, task: task.name || short, host: host.name, status: 'ignored' });
      return;
    }
    stats.failed++;
    host.failed = true;
    this.failed = true;
    this.tasks.push({ play: this.playName, task: task.name || short, host: host.name, status: 'failed' });
  }

  /** The module call itself, including the pieces Ansible handles outside modules. */
  private invoke(task: TaskDef, short: string, vars: Record<string, JValue>, ctx: Ctx, host: HostRun, becomeInfo: { become: boolean; becomeUser: string }, role: RoleContext | null): ModuleResult {
    const args = template(task.args, ctx) as Record<string, JValue>;
    for (const [k, v] of Object.entries(args)) if (v === '__omit_place_holder__') delete args[k];

    switch (short) {
      case 'set_fact': {
        for (const [k, v] of Object.entries(args)) {
          if (k === 'cacheable') continue;
          host.hostVars[k] = v;
        }
        return { changed: false };
      }
      case 'debug': {
        if (args.var !== undefined) {
          const name = String(args.var);
          let value: JValue;
          try {
            value = template(`{{ ${name} }}`, ctx);
          } catch {
            value = 'VARIABLE IS NOT DEFINED!';
          }
          return { changed: false, [name]: value, _debug_var: name };
        }
        return { changed: false, msg: (args.msg ?? 'Hello world!') as JValue };
      }
      case 'fail':
        throw new ModuleError(String(args.msg ?? 'Failed as requested from task'));
      case 'assert': {
        const that = Array.isArray(task.args.that) ? (task.args.that as JValue[]) : [task.args.that as JValue];
        for (const assertion of that) {
          if (!condition(assertion, ctx)) {
            const message = args.fail_msg ?? args.msg ?? `Assertion failed`;
            throw new ModuleError(String(template(message as JValue, ctx)), { assertion: String(assertion), evaluated_to: false });
          }
        }
        return { changed: false, msg: String(args.success_msg ?? 'All assertions passed') };
      }
      case 'include_vars': {
        const path = String(args.file ?? args._raw_params ?? '');
        const loaded = this.loadYaml(role ? this.findRoleFile(role, `vars/${path}`) ?? path : path);
        Object.assign(host.hostVars, (loaded as Record<string, JValue>) ?? {});
        return { changed: false, ansible_included_var_files: [path] };
      }
      case 'meta':
        return { changed: false };
      default:
        break;
    }

    const resolved = resolveModule(task.module);
    if ('error' in resolved) throw new ModuleError(resolved.error);
    const collection = resolved.fqcn.split('.').slice(0, 2).join('.');
    if (collection !== 'ansible.builtin' && !this.collectionInstalled(collection)) {
      throw new ModuleError(`couldn't resolve module/action '${task.module}'. This often indicates a misspelling, missing collection, or incorrect module path.`);
    }
    const net = this.env.network;
    const moduleCtx: ModuleCtx = {
      network: net,
      node: host.node,
      control: this.env.control,
      controlNode: this.env.controlNode,
      cwd: this.env.cwd,
      searchPath: role ? [role.dir, this.env.cwd] : [this.env.cwd],
      lx: host.kind === 'ios' ? undefined : net.hosts[host.node]?.linux,
      device: host.kind === 'ios' ? net.devices[host.node] : undefined,
      become: host.kind === 'local' ? becomeInfo.become && this.env.control.user !== 'root' : becomeInfo.become,
      becomeUser: becomeInfo.becomeUser,
      remoteUser: String(vars.ansible_user ?? this.opts.remoteUser ?? this.config.remote_user ?? this.env.control.user),
      checkMode: this.opts.check && task.raw.check_mode !== false,
      diffMode: this.opts.diff,
      render: (text) => String(template(text, ctx)),
      vars,
    };
    const result = resolved.module(args, moduleCtx);
    if (result.ansible_facts) {
      Object.assign(host.facts, result.ansible_facts);
      Object.assign(host.hostVars, result.ansible_facts);
    }
    return result;
  }

  private collectionInstalled(name: string): boolean {
    const [ns, coll] = name.split('.');
    const roots = [`/home/${this.env.control.user}/.ansible/collections/ansible_collections`, '/usr/share/ansible/collections/ansible_collections', `${this.env.cwd}/collections/ansible_collections`];
    return roots.some((root) => getNode(this.env.control, `${root}/${ns}/${coll}`));
  }

  private runBlock(task: TaskDef, hosts: HostRun[], role: RoleContext | null, playVars: Record<string, JValue>, inherited: { become: boolean; becomeUser: string; tags: string[] }): void {
    const raw = task.raw;
    const become = raw.become !== undefined ? Boolean(raw.become) : inherited.become;
    const next = { become, becomeUser: String(raw.become_user ?? inherited.becomeUser), tags: inherited.tags };
    const before = new Set(hosts.filter((h) => h.failed).map((h) => h.name));
    for (const t of (raw.block as YamlValue[]) ?? []) this.runTask(this.taskFrom(t), hosts, role, { ...playVars, ...((raw.vars as Record<string, JValue>) ?? {}) }, next);
    const broke = hosts.filter((h) => h.failed && !before.has(h.name));
    if (broke.length && raw.rescue) {
      for (const h of broke) {
        h.failed = false;
        this.statsOf(h.name).rescued++;
        this.statsOf(h.name).failed = Math.max(0, this.statsOf(h.name).failed - 1);
      }
      this.failed = Object.values(this.stats).some((s) => s.failed > 0);
      for (const t of (raw.rescue as YamlValue[]) ?? []) this.runTask(this.taskFrom(t), hosts, role, playVars, next);
    }
    if (raw.always) {
      const saved = hosts.map((h) => h.failed);
      hosts.forEach((h) => (h.failed = false));
      for (const t of (raw.always as YamlValue[]) ?? []) this.runTask(this.taskFrom(t), hosts, role, playVars, next);
      hosts.forEach((h, i) => (h.failed = h.failed || saved[i]));
    }
  }

  // --- roles

  private roleDirs(): string[] {
    return [`${this.env.cwd}/roles`, ...(this.config.roles_path ? this.config.roles_path.split(':') : []), `/home/${this.env.control.user}/.ansible/roles`, '/etc/ansible/roles', '/usr/share/ansible/roles'];
  }

  private findRoleFile(role: RoleContext, rel: string): string | null {
    for (const candidate of [`${role.dir}/${rel}`, `${role.dir}/${rel}.yml`, `${role.dir}/${rel}.yaml`]) {
      if (getNode(this.env.control, candidate)) return candidate;
    }
    return null;
  }

  private loadRole(name: string): RoleContext {
    for (const base of this.roleDirs()) {
      const dir = `${base}/${name}`;
      if (getNode(this.env.control, dir)) {
        const read = (rel: string): Record<string, JValue> => {
          for (const candidate of [`${dir}/${rel}/main.yml`, `${dir}/${rel}/main.yaml`]) {
            if (getNode(this.env.control, candidate)) return (this.loadYaml(candidate) as Record<string, JValue>) ?? {};
          }
          return {};
        };
        return { name, dir, defaults: read('defaults'), vars: read('vars') };
      }
    }
    throw new PlaybookError(`the role '${name}' was not found in ${this.roleDirs().join(':')}`);
  }

  private runRole(entry: YamlValue, hosts: HostRun[], playVars: Record<string, JValue>, inherited: { become: boolean; becomeUser: string; tags: string[] }): void {
    const name = typeof entry === 'string' ? entry : String((entry as Record<string, YamlValue>).role ?? (entry as Record<string, YamlValue>).name ?? '');
    const params = typeof entry === 'string' ? {} : Object.fromEntries(Object.entries(entry as Record<string, JValue>).filter(([k]) => !['role', 'name', 'tags', 'when', 'vars'].includes(k)));
    const extraVars = typeof entry === 'string' ? {} : ((entry as Record<string, YamlValue>).vars as Record<string, JValue>) ?? {};
    const role = this.loadRole(name);
    const tags = typeof entry === 'string' ? [] : this.tagsOf(entry as Record<string, YamlValue>);
    role.vars = { ...role.vars, ...params, ...extraVars };
    const tasksFile = this.findRoleFile(role, 'tasks/main');
    if (tasksFile) {
      const tasks = (this.loadYaml(tasksFile) as YamlValue[]) ?? [];
      for (const t of tasks) this.runTask(this.taskFrom(t), hosts, role, playVars, { ...inherited, tags: [...inherited.tags, ...tags] });
    }
    const handlersFile = this.findRoleFile(role, 'handlers/main');
    if (handlersFile) {
      const handlers = (this.loadYaml(handlersFile) as YamlValue[]) ?? [];
      this.pendingHandlers.push(...handlers.map((h) => ({ task: this.taskFrom(h), role })));
    }
  }

  private pendingHandlers: Array<{ task: TaskDef; role: RoleContext | null }> = [];

  private flushHandlers(hosts: HostRun[], playVars: Record<string, JValue>, inherited: { become: boolean; becomeUser: string; tags: string[] }): void {
    for (const { task, role } of this.pendingHandlers) {
      const names = [task.name, ...(task.raw.listen ? (Array.isArray(task.raw.listen) ? task.raw.listen.map(String) : [String(task.raw.listen)]) : [])];
      const waiting = hosts.filter((h) => !h.failed && !h.unreachable && h.notified.some((n) => names.includes(n)));
      if (!waiting.length) continue;
      this.say('');
      this.say(banner('RUNNING HANDLER', role ? `${role.name} : ${task.name}` : task.name));
      // Handlers run like tasks, but only for the hosts that notified them.
      this.runTask(task, waiting, role, playVars, inherited, true);
      for (const h of waiting) h.notified = h.notified.filter((n) => !names.includes(n));
    }
  }

  // --- plays

  runPlaybook(path: string): RunResult {
    this.playsIn(path);
    this.recap();
    return { failed: this.failed, stats: this.stats, tasks: this.tasks };
  }

  /** Run plays built in memory rather than read from a file, as an ad-hoc command does. */
  runPlays(plays: YamlValue[], path: string): RunResult {
    this.plays(plays, path);
    this.recap();
    return { failed: this.failed, stats: this.stats, tasks: this.tasks };
  }

  /** The plays of one file, without a recap: an imported playbook is part of the same run. */
  private playsIn(path: string): void {
    const doc = this.loadYaml(path);
    if (!Array.isArray(doc)) throw new PlaybookError(`playbook ${path} must be a list of plays`);
    this.plays(doc, path);
  }

  private plays(doc: YamlValue[], path: string): void {
    for (const entry of doc) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'import_playbook' in (entry as Record<string, YamlValue>)) {
        this.playsIn(String((entry as Record<string, YamlValue>).import_playbook));
        continue;
      }
      this.runPlay(entry as Record<string, YamlValue>, path);
    }
  }

  private recap(): void {
    this.say('');
    this.say('PLAY RECAP '.padEnd(WIDTH, '*'));
    for (const [name, s] of Object.entries(this.stats)) {
      this.say(`${name.padEnd(26)} : ok=${String(s.ok).padEnd(4)} changed=${String(s.changed).padEnd(4)} unreachable=${String(s.unreachable).padEnd(4)} failed=${String(s.failed).padEnd(4)} skipped=${String(s.skipped).padEnd(4)} rescued=${String(s.rescued).padEnd(4)} ignored=${String(s.ignored).padEnd(4)}`);
    }
    this.say('');
  }

  private runPlay(play: Record<string, YamlValue>, path: string): void {
    for (const key of Object.keys(play)) {
      if (!PLAY_KEYWORDS.has(key)) throw new PlaybookError(`${path}: the play has an unknown keyword '${key}'`);
    }
    const pattern = String(play.hosts ?? '');
    if (!pattern) throw new PlaybookError(`${path}: a play is missing the 'hosts' keyword`);
    this.playName = String(play.name ?? pattern);
    const names = selectHosts(this.inventory, pattern).filter((n) => (this.opts.limit ? selectHosts(this.inventory, this.opts.limit).includes(n) : true));
    this.say('');
    this.say(banner('PLAY', this.playName));
    if (!names.length) {
      this.say('skipping: no hosts matched');
      return;
    }
    const hosts = names.map((n) => (this.hosts[n] ??= this.resolveHost(n)));
    for (const h of hosts) {
      h.failed = false;
      h.unreachable = false;
    }

    const become = play.become !== undefined ? Boolean(play.become) : Boolean(this.opts.become ?? this.config.become);
    const inherited = { become, becomeUser: String(play.become_user ?? this.config.become_user ?? 'root'), tags: this.tagsOf(play) };

    // Play variables, including vars_files (which may be vaulted).
    const playVars: Record<string, JValue> = { ...((play.vars as Record<string, JValue>) ?? {}) };
    for (const file of Array.isArray(play.vars_files) ? play.vars_files : play.vars_files ? [play.vars_files] : []) {
      const rendered = String(template(String(file), this.ctxFor({ ...playVars, ...this.opts.extraVars })));
      const loaded = this.loadYaml(rendered);
      Object.assign(playVars, (loaded as Record<string, JValue>) ?? {});
    }

    // Gather facts unless the play says not to; hosts that cannot be reached say so here.
    const gather = play.gather_facts === undefined ? this.config.gathering !== 'explicit' : Boolean(play.gather_facts);
    if (gather) {
      this.say('');
      this.say(banner('TASK', 'Gathering Facts'));
      for (const host of hosts) {
        if (!this.ensureConnected(host)) continue;
        const net = this.env.network;
        host.facts = host.kind === 'ios' ? iosFacts(net.devices[host.node]) : linuxFacts(net.hosts[host.node].linux!, net.hosts[host.node]);
        this.statsOf(host.name).ok++;
        this.say(`ok: [${host.name}]`);
        this.tasks.push({ play: this.playName, task: 'Gathering Facts', host: host.name, status: 'ok' });
      }
    }

    const live = hosts.filter((h) => !h.unreachable);
    this.pendingHandlers = ((play.handlers as YamlValue[]) ?? []).map((h) => ({ task: this.taskFrom(h), role: null }));

    for (const t of ((play.pre_tasks as YamlValue[]) ?? [])) this.runTask(this.taskFrom(t), live, null, playVars, inherited);
    this.flushHandlers(live, playVars, inherited);
    for (const entry of ((play.roles as YamlValue[]) ?? [])) this.runRole(entry, live, playVars, inherited);
    for (const t of ((play.tasks as YamlValue[]) ?? [])) this.runTask(this.taskFrom(t), live, null, playVars, inherited);
    this.flushHandlers(live, playVars, inherited);
    for (const t of ((play.post_tasks as YamlValue[]) ?? [])) this.runTask(this.taskFrom(t), live, null, playVars, inherited);
    this.flushHandlers(live, playVars, inherited);
  }

  /** include_tasks and friends need the runner, so they live here rather than in modules. */
  runIncluded(file: string, hosts: HostRun[], role: RoleContext | null, playVars: Record<string, JValue>, inherited: { become: boolean; becomeUser: string; tags: string[] }): void {
    const tasks = (this.loadYaml(file) as YamlValue[]) ?? [];
    for (const t of tasks) this.runTask(this.taskFrom(t), hosts, role, playVars, inherited);
  }

  setInventory(inv: Inventory): void {
    this.inventory = inv;
  }

  getInventory(): Inventory {
    return this.inventory;
  }

  listHostsFor(playbookPath: string): string[] {
    const doc = this.loadYaml(playbookPath);
    const out = new Set<string>();
    for (const play of Array.isArray(doc) ? doc : []) {
      const pattern = String((play as Record<string, YamlValue>)?.hosts ?? '');
      for (const h of selectHosts(this.inventory, pattern)) out.add(h);
    }
    return [...out];
  }
}

/** Load ansible.cfg, the way Ansible looks for it. */
export function loadConfig(lx: LinuxState, cwd: string, env: Record<string, string>): AnsibleConfig {
  const candidates = [env.ANSIBLE_CONFIG, `${cwd}/ansible.cfg`, `/home/${lx.user}/.ansible.cfg`, '/etc/ansible/ansible.cfg'].filter(Boolean) as string[];
  for (const path of candidates) {
    const r = readFile(lx, normalizePath(cwd, path, `/home/${lx.user}`));
    if ('error' in r) continue;
    const cfg: AnsibleConfig = { source: path };
    let section = '';
    for (const raw of r.content.split('\n')) {
      const line = raw.replace(/[#;].*$/, '').trim();
      if (!line) continue;
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        section = header[1];
        continue;
      }
      const at = line.indexOf('=');
      if (at < 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (section !== 'defaults' && section !== 'privilege_escalation') continue;
      switch (key) {
        case 'inventory':
          cfg.inventory = value;
          break;
        case 'remote_user':
          cfg.remote_user = value;
          break;
        case 'become':
          cfg.become = ['true', 'yes', 'on', '1'].includes(value.toLowerCase());
          break;
        case 'become_user':
          cfg.become_user = value;
          break;
        case 'host_key_checking':
          cfg.host_key_checking = ['true', 'yes', 'on', '1'].includes(value.toLowerCase());
          break;
        case 'roles_path':
          cfg.roles_path = value;
          break;
        case 'collections_path':
        case 'collections_paths':
          cfg.collections_path = value;
          break;
        case 'vault_password_file':
          cfg.vault_password_file = value;
          break;
        case 'gathering':
          cfg.gathering = value;
          break;
        case 'forks':
          cfg.forks = Number(value);
          break;
      }
    }
    return cfg;
  }
  return {};
}

export { loadInventory, selectHosts };
export type { Inventory };
