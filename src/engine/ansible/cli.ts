/**
 * The ansible command line: ansible for ad-hoc commands, ansible-playbook, and the
 * tools around them (inventory, vault, galaxy, doc, config).
 *
 * Commands that need a password (a vault password, a sudo password, ssh-copy-id) ask
 * for it before anything runs, so answering one simply runs the command again with the
 * answer to hand; nothing can happen twice.
 */
import { getNode, listDir, makeDir, normalizePath, readFile, writeFile, type LinuxState } from '../linux/fs';
import type { NetworkState } from '../network';
import { template, type JValue } from './jinja';
import { inventoryJson, inventoryVars, loadInventory, selectHosts, InventoryError, type Inventory } from './inventory';
import { MODULES, MODULE_COLLECTIONS, ModuleError, UNSUPPORTED_MODULES } from './modules';
import { ANSIBLE_VERSION, loadConfig, PlaybookError, Runner, type AnsibleConfig, type AnsibleEnv, type RunOptions } from './run';
import { encryptString, isVaulted, vaultDecrypt, vaultEncrypt, VaultError } from './vault';
import { parseYaml, renderYamlError, toYaml, YamlError, type YamlValue } from './yaml';

export interface AnsibleRun {
  playbook: string;
  dir: string;
  code: number;
  check: boolean;
  tags: string[];
  limit: string;
  stats: Record<string, { ok: number; changed: number; unreachable: number; failed: number; skipped: number; rescued: number; ignored: number }>;
  tasks: Array<{ play: string; task: string; host: string; status: string }>;
}

export interface AnsiblePending {
  kind: 'ansible';
  argv: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  answers: string[];
  printed: number;
  prompt: string;
  masked?: boolean;
}

export interface AnsibleResult {
  out: string[];
  err: string[];
  code: number;
  pending?: AnsiblePending;
}

class Ask extends Error {
  constructor(
    public prompt: string,
    public masked: boolean,
  ) {
    super('ask');
  }
}

class Exit extends Error {
  constructor(public code: number) {
    super('exit');
  }
}

class Io {
  out: string[] = [];
  err: string[] = [];
  private askIndex = 0;

  constructor(
    public lx: LinuxState,
    public network: NetworkState,
    public node: string,
    public cwd: string,
    public env: Record<string, string>,
    private answers: string[],
  ) {}

  print(...lines: string[]) {
    this.out.push(...lines);
  }

  error(...lines: string[]) {
    this.err.push(...lines);
  }

  ask(prompt: string, masked = true): string {
    const i = this.askIndex++;
    if (i < this.answers.length) return this.answers[i];
    throw new Ask(prompt, masked);
  }
}

// ---------------------------------------------------------------------------
// flags

interface Flags {
  bool: Set<string>;
  values: Record<string, string[]>;
  positional: string[];
  verbosity: number;
}

const VALUE_FLAGS: Record<string, string> = {
  i: 'inventory',
  inventory: 'inventory',
  'inventory-file': 'inventory',
  l: 'limit',
  limit: 'limit',
  m: 'module',
  'module-name': 'module',
  a: 'args',
  args: 'args',
  e: 'extra-vars',
  'extra-vars': 'extra-vars',
  t: 'tags',
  tags: 'tags',
  'skip-tags': 'skip-tags',
  u: 'user',
  user: 'user',
  'vault-password-file': 'vault-password-file',
  'vault-id': 'vault-password-file',
  'start-at-task': 'start-at-task',
  f: 'forks',
  forks: 'forks',
  'become-user': 'become-user',
  p: 'path',
  'roles-path': 'path',
  r: 'requirements',
  'role-file': 'requirements',
  name: 'name',
  'output-file': 'output',
  'new-vault-password-file': 'new-vault-password-file',
  host: 'host',
};

const BOOL_FLAGS = new Set(['check', 'C', 'diff', 'D', 'become', 'b', 'list-hosts', 'list-tasks', 'list', 'syntax-check', 'ask-vault-pass', 'J', 'ask-become-pass', 'K', 'one-line', 'o', 'graph', 'vars', 'version', 'help', 'h', 'force', 'yaml', 'only-changed', 'private-key', 'flush-cache', 'step']);

function parseFlags(args: string[]): Flags {
  const f: Flags = { bool: new Set(), values: {}, positional: [], verbosity: 0 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') {
      f.positional.push(arg);
      continue;
    }
    if (/^-v+$/.test(arg)) {
      f.verbosity += arg.length - 1;
      continue;
    }
    const long = arg.startsWith('--');
    const body = arg.replace(/^--?/, '');
    const [rawName, inlineValue] = body.includes('=') ? [body.slice(0, body.indexOf('=')), body.slice(body.indexOf('=') + 1)] : [body, undefined];
    // Short flags may be bundled, as in -vvb.
    const names = long || rawName.length === 1 || VALUE_FLAGS[rawName] ? [rawName] : rawName.split('');
    for (const name of names) {
      const key = VALUE_FLAGS[name];
      if (key) {
        const value = inlineValue ?? args[++i];
        if (value === undefined) continue;
        (f.values[key] ??= []).push(value);
      } else if (BOOL_FLAGS.has(name)) {
        const canonical = { C: 'check', D: 'diff', b: 'become', J: 'ask-vault-pass', K: 'ask-become-pass', o: 'one-line', h: 'help' }[name] ?? name;
        f.bool.add(canonical);
      } else if (name === 'v') f.verbosity++;
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// shared setup

function abs(io: Io, path: string): string {
  return normalizePath(io.cwd, path, `/home/${io.lx.user}`);
}

function vaultPasswords(io: Io, f: Flags, config: AnsibleConfig): string[] {
  const out: string[] = [];
  const files = [...(f.values['vault-password-file'] ?? []), ...(config.vault_password_file ? [config.vault_password_file] : []), ...(io.env.ANSIBLE_VAULT_PASSWORD_FILE ? [io.env.ANSIBLE_VAULT_PASSWORD_FILE] : [])];
  for (const file of files) {
    const r = readFile(io.lx, abs(io, file));
    if ('error' in r) {
      io.error(`ERROR! The vault password file ${file} was not found`);
      throw new Exit(1);
    }
    out.push(r.content.trim());
  }
  if (f.bool.has('ask-vault-pass')) out.push(io.ask('Vault password: '));
  return out;
}

function extraVars(io: Io, f: Flags): Record<string, JValue> {
  const out: Record<string, JValue> = {};
  for (const item of f.values['extra-vars'] ?? []) {
    if (item.startsWith('@')) {
      const r = readFile(io.lx, abs(io, item.slice(1)));
      if ('error' in r) {
        io.error(`ERROR! the file_name '${item.slice(1)}' does not exist, or is not readable`);
        throw new Exit(1);
      }
      const doc = parseYaml(isVaulted(r.content) ? r.content : r.content);
      Object.assign(out, (doc as Record<string, JValue>) ?? {});
      continue;
    }
    if (item.trim().startsWith('{')) {
      Object.assign(out, JSON.parse(item) as Record<string, JValue>);
      continue;
    }
    for (const pair of item.split(' ')) {
      const at = pair.indexOf('=');
      if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  return out;
}

function inventoryPaths(io: Io, f: Flags, config: AnsibleConfig): string[] {
  const fromFlags = f.values.inventory ?? [];
  if (fromFlags.length) return fromFlags;
  if (io.env.ANSIBLE_INVENTORY) return [io.env.ANSIBLE_INVENTORY];
  if (config.inventory) return [config.inventory];
  return ['/etc/ansible/hosts'];
}

function buildInventory(io: Io, paths: string[]): Inventory {
  let merged: Inventory | null = null;
  for (const p of paths) {
    try {
      const inv = loadInventory(io.lx, p, io.cwd);
      if (!merged) merged = inv;
      else {
        Object.assign(merged.hosts, inv.hosts);
        for (const [name, g] of Object.entries(inv.groups)) {
          const target = (merged.groups[name] ??= { name, hosts: [], children: [], vars: {} });
          target.hosts = [...new Set([...target.hosts, ...g.hosts])];
          target.children = [...new Set([...target.children, ...g.children])];
          Object.assign(target.vars, g.vars);
        }
      }
    } catch (e) {
      if (e instanceof InventoryError) {
        io.print(`[WARNING]: ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  if (!merged || !Object.keys(merged.hosts).length) {
    io.print('[WARNING]: No inventory was parsed, only implicit localhost is available');
    io.print("[WARNING]: provided hosts list is empty, only localhost is available. Note that the implicit localhost does not match 'all'");
    const inv: Inventory = merged ?? { hosts: {}, groups: {}, source: '' };
    inv.hosts.localhost ??= { name: 'localhost', vars: { ansible_connection: 'local' } };
    inv.groups.all ??= { name: 'all', hosts: [], children: [], vars: {} };
    inv.groups.ungrouped ??= { name: 'ungrouped', hosts: ['localhost'], children: [], vars: {} };
    return inv;
  }
  return merged;
}

function envFor(io: Io): AnsibleEnv {
  return {
    network: io.network,
    controlNode: io.node,
    control: io.lx,
    cwd: io.cwd,
    env: io.env,
    out: (line) => io.print(line),
  };
}

function runOptions(io: Io, f: Flags, config: AnsibleConfig): RunOptions {
  if (f.bool.has('ask-become-pass')) io.ask('BECOME password: ');
  return {
    inventoryPaths: inventoryPaths(io, f, config),
    limit: f.values.limit?.[0],
    tags: (f.values.tags ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean),
    skipTags: (f.values['skip-tags'] ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean),
    extraVars: extraVars(io, f),
    check: f.bool.has('check'),
    diff: f.bool.has('diff'),
    verbosity: f.verbosity,
    vaultPasswords: vaultPasswords(io, f, config),
    become: f.bool.has('become') ? true : undefined,
    remoteUser: f.values.user?.[0],
    startAtTask: f.values['start-at-task']?.[0],
  };
}

// ---------------------------------------------------------------------------
// ansible-playbook

function playbookCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const config = loadConfig(io.lx, io.cwd, io.env);
  if (f.bool.has('version')) return versionCmd(io, 'ansible-playbook', config);
  if (f.bool.has('help') || !f.positional.length) {
    io.print('usage: ansible-playbook [-h] [--version] [-v] [-i INVENTORY] [--list-hosts]', '                        [-l SUBSET] [-e EXTRA_VARS] [-t TAGS] [--skip-tags SKIP_TAGS]', '                        [-C] [-D] [-b] [-K] [--syntax-check] [--list-tasks]', '                        playbook [playbook ...]');
    return f.positional.length ? 0 : 5;
  }
  const opts = runOptions(io, f, config);
  const inv = buildInventory(io, opts.inventoryPaths);
  const runner = new Runner(envFor(io), config, opts);
  runner.setInventory(inv);
  let code = 0;
  for (const path of f.positional) {
    const full = abs(io, path);
    if (!getNode(io.lx, full)) {
      io.error(`ERROR! the playbook: ${path} could not be found`);
      return 1;
    }
    try {
      if (f.bool.has('list-hosts')) {
        io.print(`\nplaybook: ${path}`);
        const hosts = runner.listHostsFor(full);
        io.print(`\n  play #1 (${hosts.join(',')}): pattern hosts (${hosts.length}):`);
        for (const h of hosts) io.print(`    ${h}`);
        continue;
      }
      if (f.bool.has('syntax-check')) {
        runner.listHostsFor(full);
        io.print(`playbook: ${path}`);
        continue;
      }
      const result = runner.runPlaybook(full);
      if (result.failed) {
        const anyUnreachable = Object.values(result.stats).some((s) => s.unreachable > 0);
        const anyFailed = Object.values(result.stats).some((s) => s.failed > 0);
        code = anyFailed ? 2 : anyUnreachable ? 4 : 2;
      }
      recordRun(io, path, result.failed ? code : 0, result.stats, result.tasks, opts);
    } catch (e) {
      if (e instanceof YamlError) {
        io.error(...renderYamlError(e, full));
        return 4;
      }
      if (e instanceof PlaybookError) {
        io.error(`ERROR! ${e.message}`);
        return 4;
      }
      if (e instanceof VaultError) {
        io.error(`ERROR! ${e.message}`);
        return 1;
      }
      throw e;
    }
  }
  return code;
}

function recordRun(io: Io, playbook: string, code: number, stats: Record<string, { ok: number; changed: number; unreachable: number; failed: number; skipped: number; rescued: number; ignored: number }>, tasks: Array<{ play: string; task: string; host: string; status: string }>, opts: RunOptions) {
  const runs = (io.lx.ansibleRuns ??= []);
  runs.push({ playbook, dir: io.cwd, code, check: opts.check, tags: opts.tags, limit: opts.limit ?? '', stats, tasks });
  if (runs.length > 100) runs.shift();
}

// ---------------------------------------------------------------------------
// ansible (ad hoc)

function adHocCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const config = loadConfig(io.lx, io.cwd, io.env);
  if (f.bool.has('version')) return versionCmd(io, 'ansible', config);
  const pattern = f.positional[0];
  if (!pattern) {
    io.error('usage: ansible [-h] [--version] [-v] [-i INVENTORY] [-m MODULE_NAME] [-a MODULE_ARGS] pattern');
    return 5;
  }
  const opts = runOptions(io, f, config);
  const inv = buildInventory(io, opts.inventoryPaths);
  const hosts = selectHosts(inv, pattern);
  if (f.bool.has('list-hosts')) {
    io.print(`  hosts (${hosts.length}):`);
    for (const h of hosts) io.print(`    ${h}`);
    return 0;
  }
  if (!hosts.length) {
    io.print(`[WARNING]: Could not match supplied host pattern, ignoring: ${pattern}`);
    io.error('ERROR! Specified inventory, host pattern and/or --limit does not match any hosts');
    return 1;
  }
  const moduleName = f.values.module?.[0] ?? 'command';
  const rawArgs = f.values.args?.[0] ?? '';
  const short = moduleName.split('.').pop()!;
  if (UNSUPPORTED_MODULES[short]) {
    io.error(`ERROR! ${UNSUPPORTED_MODULES[short]}`);
    return 1;
  }
  if (!MODULES[short]) {
    io.error(`ERROR! couldn't resolve module/action '${moduleName}'. This often indicates a misspelling, missing collection, or incorrect module path.`);
    return 1;
  }
  // An ad-hoc run is a one-task play, so build one and let the runner do the work.
  const taskArgs: Record<string, YamlValue> = {};
  if (rawArgs) {
    const pairs = rawArgs.match(/(\w+)=("[^"]*"|'[^']*'|\S+)/g);
    if (pairs && pairs.join(' ').length >= rawArgs.trim().length - 1 && !['command', 'shell', 'raw'].includes(short)) {
      for (const pair of pairs) {
        const at = pair.indexOf('=');
        taskArgs[pair.slice(0, at)] = pair.slice(at + 1).replace(/^['"]|['"]$/g, '');
      }
    } else taskArgs._raw_params = rawArgs;
  }
  const lines: string[] = [];
  const env = { ...envFor(io), out: (line: string) => lines.push(line) };
  const runner = new Runner(env, config, { ...opts, verbosity: Math.max(1, f.verbosity) });
  runner.setInventory(inv);
  // An ad-hoc run never gathers facts of its own: -m setup is the task, not a prelude.
  const play: YamlValue[] = [{ name: `Ansible Ad-Hoc`, hosts: pattern, gather_facts: false, tasks: [{ name: moduleName, [moduleName]: taskArgs }] }];
  let result;
  try {
    result = runner.runPlays(play, 'the command line');
  } catch (e) {
    if (e instanceof ModuleError || e instanceof PlaybookError) {
      io.error(`ERROR! ${e.message}`);
      return 1;
    }
    throw e;
  }
  // Re-shape the play output into the one-line-per-host form ad-hoc runs use.
  for (const host of hosts) {
    const stat = result.stats[host];
    const line = lines.find((l) => l.includes(`[${host}]`) && (l.startsWith('ok:') || l.startsWith('changed:') || l.startsWith('fatal:') || l.startsWith('skipping:')));
    if (!line) continue;
    const json = line.slice(line.indexOf('=>') + 2).trim();
    const payload = json && json.startsWith('{') ? json : '{}';
    if (line.startsWith('fatal:') && line.includes('UNREACHABLE')) io.print(`${host} | UNREACHABLE! => ${prettyJson(payload)}`);
    else if (line.startsWith('fatal:')) io.print(`${host} | FAILED! => ${prettyJson(payload)}`);
    else if (['command', 'shell', 'raw'].includes(short)) {
      const data = JSON.parse(payload) as { rc?: number; stdout?: string; stderr?: string };
      const status = stat?.changed ? 'CHANGED' : 'SUCCESS';
      io.print(`${host} | ${status} | rc=${data.rc ?? 0} >>`);
      if (data.stdout) io.print(...data.stdout.split('\n'));
      if (data.stderr) io.print(...data.stderr.split('\n'));
    } else io.print(`${host} | ${stat?.changed ? 'CHANGED' : 'SUCCESS'} => ${prettyJson(payload)}`);
  }
  const failed = Object.values(result.stats).some((s) => s.failed > 0 || s.unreachable > 0);
  recordRun(io, `ad-hoc:${moduleName}`, failed ? 2 : 0, result.stats, result.tasks, opts);
  return failed ? 2 : 0;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 4);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// ansible-inventory

function inventoryCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const config = loadConfig(io.lx, io.cwd, io.env);
  const inv = buildInventory(io, inventoryPaths(io, f, config));
  if (f.values.host) {
    const name = f.values.host[0];
    if (!inv.hosts[name]) {
      io.error(`ERROR! Could not match supplied host pattern, ignoring: ${name}`);
      return 1;
    }
    io.print(...JSON.stringify(inventoryVars(inv, name), null, 4).split('\n'));
    return 0;
  }
  if (f.bool.has('graph')) {
    const seen = new Set<string>();
    const walk = (name: string, depth: number) => {
      const pad = depth === 0 ? '' : '  '.repeat(depth - 1) + '  |--';
      io.print(`${pad}@${name}:`);
      const g = inv.groups[name];
      if (!g || seen.has(name)) return;
      seen.add(name);
      for (const child of [...g.children].sort()) walk(child, depth + 1);
      for (const host of [...g.hosts].sort()) io.print(`${'  '.repeat(depth)}  |--${host}`);
    };
    const top = Object.keys(inv.groups).filter((n) => n !== 'all' && !Object.values(inv.groups).some((g) => g.children.includes(n)));
    io.print('@all:');
    for (const name of top.sort()) walk(name, 1);
    return 0;
  }
  if (f.bool.has('list') || true) {
    const json = inventoryJson(inv);
    if (f.bool.has('yaml')) io.print(...toYaml(json as YamlValue).replace(/^\n/, '').split('\n'));
    else io.print(...JSON.stringify(json, null, 4).split('\n'));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ansible-vault

function vaultCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const config = loadConfig(io.lx, io.cwd, io.env);
  const action = f.positional[0] ?? '';
  const targets = f.positional.slice(1);
  const passwordFor = (prompt: string): string => {
    const files = [...(f.values['vault-password-file'] ?? []), ...(config.vault_password_file ? [config.vault_password_file] : [])];
    for (const file of files) {
      const r = readFile(io.lx, abs(io, file));
      if (!('error' in r)) return r.content.trim();
      io.error(`ERROR! The vault password file ${file} was not found`);
      throw new Exit(1);
    }
    return io.ask(prompt);
  };
  switch (action) {
    case 'encrypt':
    case 'decrypt':
    case 'view':
    case 'rekey': {
      if (!targets.length) {
        io.error(`ERROR! ${action} requires at least one input file`);
        return 1;
      }
      const password = passwordFor(action === 'encrypt' ? 'New Vault password: ' : 'Vault password: ');
      if (action === 'encrypt' && !f.values['vault-password-file']?.length && !config.vault_password_file) io.ask('Confirm New Vault password: ');
      for (const t of targets) {
        const path = abs(io, t);
        const r = readFile(io.lx, path);
        if ('error' in r) {
          io.error(`ERROR! The vault file ${t} was not found`);
          return 1;
        }
        try {
          if (action === 'encrypt') {
            if (isVaulted(r.content)) {
              io.error(`ERROR! input is already encrypted`);
              return 1;
            }
            writeFile(io.lx, path, vaultEncrypt(r.content, password, t.split('/').pop() ?? 'netlab'), false, 'ansible-vault');
          } else if (action === 'decrypt') {
            writeFile(io.lx, path, vaultDecrypt(r.content, [password]), false, 'ansible-vault');
          } else if (action === 'view') {
            io.print(...vaultDecrypt(r.content, [password]).replace(/\n$/, '').split('\n'));
          } else {
            const newPassword = (() => {
              const file = f.values['new-vault-password-file']?.[0];
              if (file) {
                const nr = readFile(io.lx, abs(io, file));
                if ('error' in nr) {
                  io.error(`ERROR! The vault password file ${file} was not found`);
                  throw new Exit(1);
                }
                return nr.content.trim();
              }
              return io.ask('New Vault password: ');
            })();
            writeFile(io.lx, path, vaultEncrypt(vaultDecrypt(r.content, [password]), newPassword, t.split('/').pop() ?? 'netlab'), false, 'ansible-vault');
          }
        } catch (e) {
          if (e instanceof VaultError) {
            io.error(`ERROR! ${e.message} for ${path}`);
            return 1;
          }
          throw e;
        }
      }
      if (action !== 'view') io.print(`${action === 'encrypt' ? 'Encryption' : action === 'decrypt' ? 'Decryption' : 'Rekey'} successful`);
      return 0;
    }
    case 'create': {
      const path = abs(io, targets[0] ?? '');
      if (!targets.length) {
        io.error('ERROR! create requires at least one input file');
        return 1;
      }
      const password = passwordFor('New Vault password: ');
      if (!f.values['vault-password-file']?.length && !config.vault_password_file) io.ask('Confirm New Vault password: ');
      if (getNode(io.lx, path)) {
        io.error(`ERROR! ${targets[0]} exists, use 'edit' or 'encrypt' instead`);
        return 1;
      }
      writeFile(io.lx, path, vaultEncrypt('---\n', password, targets[0]), false, 'ansible-vault');
      io.print(`[NETLAB] There is no editor here, so an empty encrypted file was created.`, `[NETLAB] Write the plain text first and run: ansible-vault encrypt ${targets[0]}`);
      return 0;
    }
    case 'encrypt_string': {
      const password = passwordFor('New Vault password: ');
      if (!f.values['vault-password-file']?.length && !config.vault_password_file) io.ask('Confirm New Vault password: ');
      const text = targets[0] ?? io.ask('String to encrypt: ', false);
      const name = f.values.name?.[0];
      io.print('Encryption successful');
      if (name) io.print(`${name}: ${encryptString(text, password)}`);
      else io.print(...encryptString(text, password, '          ').split('\n'));
      return 0;
    }
    default:
      io.error('usage: ansible-vault [-h] [--version] [-v] {create,decrypt,edit,view,encrypt,encrypt_string,rekey} ...');
      return 1;
  }
}

// ---------------------------------------------------------------------------
// ansible-galaxy

const GALAXY_COLLECTIONS: Record<string, { versions: string[]; modules: string[] }> = {
  'community.general': { versions: ['8.6.0', '9.5.1', '10.1.0'], modules: ['ufw', 'timezone', 'pids'] },
  'ansible.posix': { versions: ['1.5.4', '1.6.2'], modules: ['authorized_key', 'sysctl', 'mount'] },
  'cisco.ios': { versions: ['7.1.0', '8.0.0'], modules: ['ios_facts', 'ios_command', 'ios_config'] },
  'ansible.utils': { versions: ['5.1.2'], modules: ['validate'] },
};

const GALAXY_ROLES: Record<string, { versions: string[] }> = {
  'geerlingguy.nginx': { versions: ['3.1.4'] },
  'netlab.motd': { versions: ['1.0.0', '1.1.0'] },
};

function collectionPath(io: Io, f: Flags): string {
  return abs(io, f.values.path?.[0] ?? `/home/${io.lx.user}/.ansible/collections`);
}

function installCollection(io: Io, name: string, version: string | undefined, base: string): string {
  const entry = GALAXY_COLLECTIONS[name];
  if (!entry) throw new ModuleError(`Failed to resolve the requested dependencies map. Could not satisfy the following requirements: ${name}:* (direct request)`);
  const chosen = version && version !== '*' ? entry.versions.find((v) => v === version.replace(/^[>=<~]*/, '')) ?? entry.versions[entry.versions.length - 1] : entry.versions[entry.versions.length - 1];
  const [ns, coll] = name.split('.');
  const dir = `${base}/ansible_collections/${ns}/${coll}`;
  makeDir(io.lx, `${dir}/plugins/modules`, true);
  writeFile(io.lx, `${dir}/MANIFEST.json`, JSON.stringify({ collection_info: { namespace: ns, name: coll, version: chosen } }, null, 2) + '\n', false, 'ansible-galaxy');
  writeFile(io.lx, `${dir}/README.md`, `# ${name}\n\nModules: ${entry.modules.join(', ')}\n`, false, 'ansible-galaxy');
  for (const m of entry.modules) writeFile(io.lx, `${dir}/plugins/modules/${m}.py`, `# ${name}.${m} (simulated)\n`, false, 'ansible-galaxy');
  return chosen;
}

const ROLE_SKELETON: Record<string, string> = {
  'tasks/main.yml': '---\n# tasks file for {{role}}\n',
  'handlers/main.yml': '---\n# handlers file for {{role}}\n',
  'defaults/main.yml': '---\n# defaults file for {{role}}\n',
  'vars/main.yml': '---\n# vars file for {{role}}\n',
  'meta/main.yml': '---\ngalaxy_info:\n  author: your name\n  description: your role description\n  license: MIT\n  min_ansible_version: "2.14"\n\ndependencies: []\n',
  'README.md': 'Role Name\n=========\n\nA brief description of the role goes here.\n',
  'files/.gitkeep': '',
  'templates/.gitkeep': '',
  'tests/test.yml': '---\n- hosts: localhost\n  remote_user: root\n  roles:\n    - {{role}}\n',
};

function galaxyCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const what = f.positional[0] ?? '';
  const action = f.positional[1] ?? '';
  const names = f.positional.slice(2);
  if (what === 'collection' && action === 'install') {
    const base = collectionPath(io, f);
    const wanted: Array<{ name: string; version?: string }> = names.map((n) => ({ name: n.split(':')[0], version: n.split(':')[1] }));
    for (const req of f.values.requirements ?? []) {
      const r = readFile(io.lx, abs(io, req));
      if ('error' in r) {
        io.error(`ERROR! The requirements file '${req}' does not exist.`);
        return 1;
      }
      const doc = parseYaml(r.content) as Record<string, YamlValue>;
      for (const c of (doc?.collections as YamlValue[]) ?? []) {
        if (typeof c === 'string') wanted.push({ name: c });
        else wanted.push({ name: String((c as Record<string, YamlValue>).name), version: (c as Record<string, YamlValue>).version as string | undefined });
      }
      for (const role of (doc?.roles as YamlValue[]) ?? []) {
        const name = typeof role === 'string' ? role : String((role as Record<string, YamlValue>).name);
        installRole(io, name, f);
      }
    }
    if (!wanted.length) {
      io.error('ERROR! You must specify a collection name or a requirements file.');
      return 1;
    }
    io.print('Starting galaxy collection install process', 'Process install dependency map');
    for (const { name, version } of wanted) {
      try {
        const chosen = installCollection(io, name, version, base);
        io.print('Starting collection install process', `Installing '${name}:${chosen}' to '${base}/ansible_collections/${name.replace('.', '/')}'`, `${name}:${chosen} was installed successfully`);
      } catch (e) {
        io.error(`ERROR! ${(e as Error).message}`);
        return 1;
      }
    }
    return 0;
  }
  if (what === 'collection' && action === 'list') {
    const base = collectionPath(io, f);
    const root = `${base}/ansible_collections`;
    io.print(`# ${root}`, 'Collection        Version', '----------------- -------');
    for (const ns of listDir(io.lx, root)) {
      for (const coll of listDir(io.lx, `${root}/${ns}`)) {
        const manifest = readFile(io.lx, `${root}/${ns}/${coll}/MANIFEST.json`);
        const version = 'error' in manifest ? '*' : (JSON.parse(manifest.content).collection_info?.version ?? '*');
        io.print(`${`${ns}.${coll}`.padEnd(17)} ${version}`);
      }
    }
    return 0;
  }
  if ((what === 'role' || what === 'init') && (action === 'init' || what === 'init')) {
    const name = what === 'init' ? f.positional[1] : names[0];
    if (!name) {
      io.error('ERROR! You must specify a role name');
      return 1;
    }
    // Like the real command, the skeleton lands under --init-path, which defaults to ".".
    const base = abs(io, f.values['init-path']?.[0] ?? f.values.path?.[0] ?? io.cwd);
    const dir = `${base}/${name}`;
    if (getNode(io.lx, dir) && !f.bool.has('force')) {
      io.error(`ERROR! The directory ${dir} already exists. Use --force to overwrite.`);
      return 1;
    }
    for (const [rel, body] of Object.entries(ROLE_SKELETON)) {
      const path = `${dir}/${rel}`;
      makeDir(io.lx, path.slice(0, path.lastIndexOf('/')), true);
      writeFile(io.lx, path, body.replace(/\{\{role\}\}/g, name), false, 'ansible-galaxy');
    }
    io.print(`- Role ${name} was created successfully`);
    return 0;
  }
  if (what === 'role' && action === 'install') {
    for (const n of names) installRole(io, n.split(',')[0], f);
    for (const req of f.values.requirements ?? []) {
      const r = readFile(io.lx, abs(io, req));
      if ('error' in r) continue;
      const doc = parseYaml(r.content);
      const roles = Array.isArray(doc) ? doc : ((doc as Record<string, YamlValue>)?.roles as YamlValue[]) ?? [];
      for (const role of roles) installRole(io, typeof role === 'string' ? role : String((role as Record<string, YamlValue>).name), f);
    }
    return 0;
  }
  if (what === 'role' && action === 'list') {
    const base = abs(io, f.values.path?.[0] ?? `/home/${io.lx.user}/.ansible/roles`);
    io.print(`# ${base}`);
    for (const name of listDir(io.lx, base)) io.print(`- ${name}, (unknown version)`);
    return 0;
  }
  io.error('usage: ansible-galaxy [-h] [--version] [-v] TYPE ...', '', 'positional arguments:', '  TYPE        collection, role');
  return 1;
}

function installRole(io: Io, name: string, f: Flags): void {
  const entry = GALAXY_ROLES[name];
  const base = abs(io, f.values.path?.[0] ?? `/home/${io.lx.user}/.ansible/roles`);
  if (!entry) {
    io.error(`ERROR! - the role ${name} was not found in the galaxy`);
    throw new Exit(1);
  }
  const version = entry.versions[entry.versions.length - 1];
  const dir = `${base}/${name}`;
  for (const [rel, body] of Object.entries(ROLE_SKELETON)) {
    const path = `${dir}/${rel}`;
    makeDir(io.lx, path.slice(0, path.lastIndexOf('/')), true);
    writeFile(io.lx, path, body.replace(/\{\{role\}\}/g, name), false, 'ansible-galaxy');
  }
  if (name === 'netlab.motd') {
    writeFile(io.lx, `${dir}/tasks/main.yml`, '---\n- name: Write the message of the day\n  ansible.builtin.template:\n    src: motd.j2\n    dest: /etc/motd\n    owner: root\n    group: root\n    mode: "0644"\n  become: true\n', false, 'ansible-galaxy');
    writeFile(io.lx, `${dir}/templates/motd.j2`, 'Welcome to {{ ansible_hostname }}.\nManaged by Ansible: {{ motd_owner | default("the platform team") }}.\n', false, 'ansible-galaxy');
    writeFile(io.lx, `${dir}/defaults/main.yml`, '---\nmotd_owner: the platform team\n', false, 'ansible-galaxy');
  }
  io.print(`- downloading role '${name.split('.')[1] ?? name}', owned by ${name.split('.')[0]}`, `- extracting ${name} to ${dir}`, `- ${name} (${version}) was installed successfully`);
}

// ---------------------------------------------------------------------------
// ansible-doc

const DOCS: Record<string, { short: string; options: Array<[string, string]>; example: string }> = {
  file: { short: 'Manage files and file properties', options: [['path', 'Path to the file being managed (aliases: dest, name)'], ['state', 'absent, directory, file, link or touch'], ['owner', 'Name of the user that should own the file'], ['group', 'Name of the group that should own the file'], ['mode', 'Permissions, as an octal string like "0644"']], example: '- name: Create a directory\n  ansible.builtin.file:\n    path: /srv/app\n    state: directory\n    mode: "0755"' },
  copy: { short: 'Copy files to remote locations', options: [['src', 'Local path to a file to copy to the remote server'], ['content', 'When used instead of src, sets the contents of a file directly'], ['dest', 'Remote absolute path where the file should be copied to'], ['owner', 'Name of the user that should own the file'], ['mode', 'Permissions of the destination file']], example: '- name: Write a file\n  ansible.builtin.copy:\n    content: "hello\\n"\n    dest: /etc/motd\n    mode: "0644"' },
  template: { short: 'Template a file out to a target host', options: [['src', 'Path of a Jinja2 template on the controller'], ['dest', 'Location to render the template to on the remote machine'], ['owner', 'Name of the user that should own the file'], ['mode', 'Permissions of the destination file']], example: '- name: Render the site configuration\n  ansible.builtin.template:\n    src: site.conf.j2\n    dest: /etc/nginx/conf.d/site.conf' },
  package: { short: 'Generic OS package manager', options: [['name', 'Package name, or package specifier with version'], ['state', 'present, absent or latest']], example: '- name: Install nginx\n  ansible.builtin.package:\n    name: nginx\n    state: present' },
  service: { short: 'Manage services', options: [['name', 'Name of the service'], ['state', 'started, stopped, restarted or reloaded'], ['enabled', 'Whether the service should start on boot']], example: '- name: Start and enable nginx\n  ansible.builtin.service:\n    name: nginx\n    state: started\n    enabled: true' },
  user: { short: 'Manage user accounts', options: [['name', 'Name of the user to create, remove or modify'], ['state', 'present or absent'], ['groups', 'List of groups the user will be added to'], ['append', 'Add to groups rather than replacing them'], ['shell', 'Optionally set the user shell'], ['password', 'Hashed password, as from the password_hash filter']], example: '- name: Add a deploy user\n  ansible.builtin.user:\n    name: deploy\n    groups: sudo\n    append: true' },
  lineinfile: { short: 'Manage lines in text files', options: [['path', 'The file to modify'], ['line', 'The line to insert or replace'], ['regexp', 'The regular expression to look for in every line'], ['state', 'present or absent'], ['insertafter', 'Insert after the last line matching this expression, or EOF']], example: '- name: Turn off password logins\n  ansible.builtin.lineinfile:\n    path: /etc/ssh/sshd_config\n    regexp: "^#?PasswordAuthentication"\n    line: "PasswordAuthentication no"' },
  debug: { short: 'Print statements during execution', options: [['msg', 'The customized message that is printed'], ['var', 'A variable name to debug, without braces']], example: '- name: Show the host\n  ansible.builtin.debug:\n    var: ansible_hostname' },
  command: { short: 'Execute commands on targets', options: [['cmd', 'The command to run'], ['chdir', 'Change into this directory before running'], ['creates', 'A filename: if it already exists, the step is skipped']], example: '- name: Report uptime\n  ansible.builtin.command: uptime\n  changed_when: false' },
  shell: { short: 'Execute shell commands on targets', options: [['cmd', 'The command to run, through the shell, so pipes and redirection work'], ['chdir', 'Change into this directory before running'], ['creates', 'A filename: if it already exists, the step is skipped']], example: '- name: Count lines\n  ansible.builtin.shell: wc -l < /etc/passwd\n  register: count\n  changed_when: false' },
  cron: { short: 'Manage cron.d and crontab entries', options: [['name', 'Description of the job, used to find it again'], ['job', 'The command to run'], ['minute', 'Minute to run, * by default'], ['hour', 'Hour to run, * by default'], ['user', 'The user whose crontab is edited']], example: '- name: Nightly backup\n  ansible.builtin.cron:\n    name: backup\n    minute: "0"\n    hour: "2"\n    job: /usr/local/bin/backup.sh' },
  stat: { short: 'Retrieve file or file system status', options: [['path', 'The full path of the file to get information about']], example: '- name: Check for the config\n  ansible.builtin.stat:\n    path: /etc/app.conf\n  register: conf' },
  uri: { short: 'Interact with webservices', options: [['url', 'HTTP or HTTPS URL'], ['status_code', 'A list of valid, numeric response status codes'], ['return_content', 'Whether to return the body of the response as content']], example: '- name: Check the site answers\n  ansible.builtin.uri:\n    url: http://localhost\n    status_code: 200' },
  ios_config: { short: 'Module to configure Cisco IOS devices', options: [['lines', 'The ordered set of commands that should be configured'], ['parents', 'The parent line that uniquely identifies the section'], ['save_when', 'When to copy the running config to startup: always, modified, never']], example: '- name: Set the hostname\n  cisco.ios.ios_config:\n    lines:\n      - hostname Branch-SW1\n    save_when: modified' },
  ios_facts: { short: 'Module to collect facts from Cisco IOS devices', options: [['gather_subset', 'Subsets of facts to collect: all, hardware, config, interfaces']], example: '- name: Gather device facts\n  cisco.ios.ios_facts:' },
  ios_command: { short: 'Module to run commands on Cisco IOS devices', options: [['commands', 'List of show commands to send to the device']], example: '- name: Read the interfaces\n  cisco.ios.ios_command:\n    commands:\n      - show ip interface brief\n  register: out' },
};

function docCmd(io: Io, args: string[]): number {
  // For ansible-doc, -l is --list rather than --limit.
  const f = parseFlags(args.map((a) => (a === '-l' ? '--list' : a)));
  if (f.bool.has('list') || f.values.list) {
    for (const name of Object.keys(MODULES).sort()) {
      const collection = MODULE_COLLECTIONS[name] ?? 'ansible.builtin';
      io.print(`${`${collection}.${name}`.padEnd(38)} ${DOCS[name]?.short ?? 'Simulated module'}`);
    }
    return 0;
  }
  const name = (f.positional[0] ?? '').split('.').pop() ?? '';
  const doc = DOCS[name];
  if (!doc) {
    if (MODULES[name]) {
      io.print(`> ${(MODULE_COLLECTIONS[name] ?? 'ansible.builtin').toUpperCase()}.${name.toUpperCase()}`, '', '  This module is simulated by NetLab; see the lab hints for its options.');
      return 0;
    }
    io.error(`[WARNING]: module ${f.positional[0]} not found in: NetLab simulated modules`);
    return 1;
  }
  const collection = MODULE_COLLECTIONS[name] ?? 'ansible.builtin';
  io.print(`> ${collection.toUpperCase()}.${name.toUpperCase()}    (simulated by NetLab)`, '', `        ${doc.short}.`, '', 'OPTIONS (= is mandatory):', '');
  for (const [option, text] of doc.options) io.print(`- ${option}`, `        ${text}`, '');
  io.print('EXAMPLES:', '', ...doc.example.split('\n').map((l) => `    ${l}`), '');
  return 0;
}

// ---------------------------------------------------------------------------
// ansible-config, version

function configCmd(io: Io, args: string[]): number {
  const f = parseFlags(args);
  const config = loadConfig(io.lx, io.cwd, io.env);
  const action = f.positional[0] ?? 'dump';
  if (action === 'view') {
    if (!config.source) {
      io.error('ERROR! No config file found; using defaults');
      return 1;
    }
    const r = readFile(io.lx, abs(io, config.source));
    if ('error' in r) return 1;
    io.print(...r.content.replace(/\n$/, '').split('\n'));
    return 0;
  }
  const settings: Array<[string, JValue]> = [
    ['DEFAULT_HOST_LIST', config.inventory ? [config.inventory] : ['/etc/ansible/hosts']],
    ['DEFAULT_REMOTE_USER', config.remote_user ?? null],
    ['DEFAULT_BECOME', config.become ?? false],
    ['HOST_KEY_CHECKING', config.host_key_checking ?? true],
    ['DEFAULT_ROLES_PATH', config.roles_path ? config.roles_path.split(':') : [`/home/${io.lx.user}/.ansible/roles`, '/etc/ansible/roles']],
    ['DEFAULT_VAULT_PASSWORD_FILE', config.vault_password_file ?? null],
    ['DEFAULT_GATHERING', config.gathering ?? 'implicit'],
    ['DEFAULT_FORKS', config.forks ?? 5],
  ];
  const changed = new Set(['DEFAULT_HOST_LIST', config.remote_user ? 'DEFAULT_REMOTE_USER' : '', config.become !== undefined ? 'DEFAULT_BECOME' : '', config.host_key_checking !== undefined ? 'HOST_KEY_CHECKING' : '', config.roles_path ? 'DEFAULT_ROLES_PATH' : '', config.vault_password_file ? 'DEFAULT_VAULT_PASSWORD_FILE' : '', config.gathering ? 'DEFAULT_GATHERING' : '', config.forks ? 'DEFAULT_FORKS' : ''].filter(Boolean));
  io.print(`CONFIG FILE = ${config.source ?? '/etc/ansible/ansible.cfg'}`);
  for (const [name, value] of settings) {
    const isChanged = changed.has(name) && config.source;
    if (f.bool.has('only-changed') && !isChanged) continue;
    io.print(`${name}(${isChanged ? config.source : 'default'}) = ${JSON.stringify(value).replace(/"/g, "'")}`);
  }
  return 0;
}

function versionCmd(io: Io, program: string, config: AnsibleConfig): number {
  io.print(
    `${program} [core ${ANSIBLE_VERSION}]`,
    `  config file = ${config.source ? abs(io, config.source) : 'None'}`,
    `  configured module search path = ['/home/${io.lx.user}/.ansible/plugins/modules', '/usr/share/ansible/plugins/modules']`,
    '  ansible python module location = /usr/lib/python3/dist-packages/ansible',
    `  ansible collection location = /home/${io.lx.user}/.ansible/collections:/usr/share/ansible/collections`,
    `  executable location = /usr/bin/${program}`,
    '  python version = 3.12.3 (main, Feb  4 2026, 10:12:03) [GCC 13.2.0] (/usr/bin/python3)',
    '  jinja version = 3.1.2',
    '  libyaml = True',
  );
  return 0;
}

// ---------------------------------------------------------------------------
// entry points

const COMMANDS: Record<string, (io: Io, args: string[]) => number> = {
  ansible: adHocCmd,
  'ansible-playbook': playbookCmd,
  'ansible-inventory': inventoryCmd,
  'ansible-vault': vaultCmd,
  'ansible-galaxy': galaxyCmd,
  'ansible-doc': docCmd,
  'ansible-config': configCmd,
};

export const ANSIBLE_COMMANDS = Object.keys(COMMANDS);

export function runAnsible(lx: LinuxState, network: NetworkState, node: string, command: string, args: string[], env: Record<string, string>, cwd: string, answers: string[] = [], stdin = ''): AnsibleResult {
  const io = new Io(lx, network, node, cwd, env, answers.length ? answers : stdin ? stdin.replace(/\n$/, '').split('\n') : []);
  const fn = COMMANDS[command];
  if (!fn) return { out: [], err: [`${command}: command not found`], code: 127 };
  try {
    const code = fn(io, args);
    return { out: io.out, err: io.err, code };
  } catch (e) {
    if (e instanceof Ask) {
      return { out: io.out, err: io.err, code: 0, pending: { kind: 'ansible', argv: args, command, cwd, env: { ...env }, answers: [...answers], printed: io.out.length, prompt: e.prompt, masked: e.masked } };
    }
    if (e instanceof Exit) return { out: io.out, err: io.err, code: e.code };
    if (e instanceof YamlError) {
      return { out: io.out, err: [...io.err, ...renderYamlError(e, 'the file')], code: 4 };
    }
    if (e instanceof InventoryError || e instanceof ModuleError || e instanceof PlaybookError || e instanceof VaultError) {
      return { out: io.out, err: [...io.err, `ERROR! ${e.message}`], code: 1 };
    }
    throw e;
  }
}

/** Continue a command that stopped to ask for a password. */
export function resumeAnsible(lx: LinuxState, network: NetworkState, node: string, pending: AnsiblePending, answer: string): AnsibleResult {
  const r = runAnsible(lx, network, node, pending.command, pending.argv, pending.env, pending.cwd, [...pending.answers, answer]);
  return { ...r, out: r.out.slice(pending.printed) };
}

export { template };
