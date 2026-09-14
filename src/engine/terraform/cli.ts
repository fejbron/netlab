/**
 * The terraform command: every subcommand a learner meets on the way to the Terraform
 * Associate exam, with the output Terraform 1.12 prints.
 *
 * Commands that ask a question (apply's approval, a missing variable, state migration,
 * force-unlock, login) stop and leave a pending prompt on the host. When the learner
 * answers, the command runs again from the start with the answers so far; everything is
 * deterministic, so it reaches the same question, takes the answer and carries on, and
 * only the lines not yet shown are printed.
 */
import { getNode, makeDir, normalizePath, readFile, removeNode, writeFile, type LinuxState } from '../linux/fs';
import type { CloudAccount, HcpOrg, HcpPolicy } from './cloud';
import { closest, loadModuleDir, type Source } from './config';
import { evaluate } from './eval';
import { formatHcl, unifiedDiff } from './fmt';
import { DiagError, parseExpression, parseHcl, renderDiags, type Diag } from './hcl';
import {
  backendHash,
  currentWorkspace,
  dataDir,
  installProvider,
  installRegistryModule,
  isLocalSource,
  isProviderInstalled,
  providerHashes,
  readBackendRecord,
  readLock,
  readModules,
  REGISTRY_MODULES,
  selectWorkspace,
  writeBackendRecord,
  writeLock,
  writeModules,
  type LockEntry,
  type ModuleRecord,
} from './project';
import { cmpVersion, newestMatching, PROVIDERS, providerFor, satisfies } from './providers';
import { renderInstance, renderOutputs, renderPlan, planNote, RULE } from './render';
import { allTrees, apply, getProvider, hasChanges, loadTree, NeedInput, plan, prepareRun, requiredProviders, stateScope, type Run, type RunEnv, type RunOptions } from './run';
import {
  cloudBackend,
  cloudSettings,
  flatten,
  hcpOrg,
  httpBackend,
  instanceAddr,
  localBackend,
  parseAddress,
  parseState,
  providerAddr,
  stateJson,
  buildState,
  TF_VERSION,
  type Backend,
  type BackendEnv,
  type Inst,
  type StateFile,
} from './state';
import { hexHash } from './providers';
import { canonical, isObj, plain, renderValue, typeName, type Val } from './values';

export interface TfPending {
  kind: 'terraform';
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  answers: string[];
  /** Output lines already shown before the current question. */
  printed: number;
  prompt: string;
  masked?: boolean;
  /** An interactive `terraform console` session. */
  console?: boolean;
}

export interface TfResult {
  out: string[];
  err: string[];
  code: number;
  pending?: TfPending;
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

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

class Io {
  out: string[] = [];
  err: string[] = [];
  private askIndex = 0;
  private logLines: string[] = [];
  private stdinAnswers: string[];

  constructor(
    public lx: LinuxState,
    public cwd: string,
    public env: Record<string, string>,
    public argv: string[],
    private answers: string[],
    stdin: string,
  ) {
    this.stdinAnswers = stdin ? stdin.replace(/\n$/, '').split('\n') : [];
  }

  print(...lines: string[]) {
    this.out.push(...lines);
  }

  error(...lines: string[]) {
    this.err.push(...lines);
  }

  /** Ask a question. Throws Ask when there is no answer yet. */
  ask(lines: string[], label = '  Enter a value: ', masked = false): string {
    const i = this.askIndex++;
    this.print(...lines);
    if (i < this.answers.length) {
      this.print('');
      return this.answers[i];
    }
    if (this.stdinAnswers.length) {
      const a = this.stdinAnswers.shift()!;
      this.print(label, '');
      return a;
    }
    if (this.env.TF_INPUT === '0' || this.env.TF_INPUT === 'false') throw new Exit(1);
    throw new Ask(label, masked);
  }

  log(level: string, line: string) {
    const want = (this.env.TF_LOG ?? '').toUpperCase();
    if (!want) return;
    const threshold = LEVELS.includes(want) ? LEVELS.indexOf(want) : 0;
    if (LEVELS.indexOf(level) < threshold) return;
    this.lx.clock += 1;
    const s = this.lx.clock;
    const stamp = `2026-09-14T${String(9 + (Math.floor(s / 3600) % 12)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String((s * 131) % 1000).padStart(3, '0')}Z`;
    const text = `${stamp} [${level}]${level.length === 4 ? ' ' : ''} ${line}`;
    if (this.env.TF_LOG_PATH) this.logLines.push(text);
    else this.err.push(text);
  }

  flushLog() {
    if (!this.env.TF_LOG_PATH || !this.logLines.length) return;
    const path = normalizePath(this.cwd, this.env.TF_LOG_PATH, `/home/${this.lx.user}`);
    const prior = readFile(this.lx, path);
    writeFile(this.lx, path, ('error' in prior ? '' : prior.content) + this.logLines.join('\n') + '\n', false, 'terraform');
    this.logLines = [];
  }

  diags(diags: Diag[], sources: Record<string, string> = {}) {
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');
    if (warnings.length) this.print(...renderDiags(warnings, sources));
    if (errors.length) this.error(...renderDiags(errors, sources));
  }
}

function fsSource(lx: LinuxState): Source {
  return {
    list: (dir) => {
      const prefix = dir === '/' ? '/' : dir + '/';
      const names = new Set<string>();
      for (const key of Object.keys(lx.fs)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest && !rest.includes('/') && lx.fs[key].type !== 'dir') names.add(rest);
      }
      return [...names].sort();
    },
    read: (path) => {
      const r = readFile(lx, path);
      return 'error' in r ? undefined : r.content;
    },
  };
}

function snapshotSource(files: Record<string, string>): Source {
  return {
    list: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1)).sort(),
    read: (path) => files[path],
  };
}

// ---------------------------------------------------------------------------
// flags

interface Flags {
  bool: Set<string>;
  values: Record<string, string[]>;
  positional: string[];
  unknown: string[];
}

function parseFlags(args: string[], boolNames: string[], valueNames: string[]): Flags {
  const f: Flags = { bool: new Set(), values: {}, positional: [], unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') {
      f.positional.push(a);
      continue;
    }
    const m = /^--?([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/s.exec(a);
    if (!m) {
      f.unknown.push(a);
      continue;
    }
    const [, name, value] = m;
    if (boolNames.includes(name)) {
      if (value === undefined || value === 'true') f.bool.add(name);
      else if (value === 'false') f.bool.add(`no-${name}`);
    } else if (valueNames.includes(name)) {
      const v = value ?? args[++i];
      if (v === undefined) f.unknown.push(a);
      else (f.values[name] ??= []).push(v);
    } else f.unknown.push(a);
  }
  return f;
}

function flagError(io: Io, cmd: string, flag: string): never {
  io.error(`Error parsing command-line flags: flag provided but not defined: ${flag.split('=')[0]}`, '', `For more help on using this command, run:`, `  terraform ${cmd} -help`);
  throw new Exit(1);
}

// ---------------------------------------------------------------------------
// backend selection

interface BackendChoice {
  backend: Backend;
  type: 'local' | 'http' | 'cloud';
  config: Record<string, Val>;
}

function literalBody(body: { attrs: Record<string, { expr: import('./hcl').Expr; pos: import('./hcl').Pos }>; blocks: Array<{ type: string; body: unknown }> }, io: Io, sources: Record<string, string>): Record<string, Val> | null {
  const out: Record<string, Val> = {};
  for (const [k, a] of Object.entries(body.attrs)) {
    try {
      out[k] = evaluate(a.expr, {
        lookup: (_r, _n, pos) => {
          throw new DiagError([{ severity: 'error', summary: 'Variables not allowed', detail: 'Variables may not be used here.', pos }]);
        },
        arity: () => 1,
        readFile: () => undefined,
      });
    } catch (e) {
      if (e instanceof DiagError) {
        io.diags(e.diags, sources);
        return null;
      }
      throw e;
    }
  }
  for (const b of body.blocks as Array<{ type: string; body: typeof body }>) {
    const inner = literalBody(b.body, io, sources);
    if (!inner) return null;
    out[b.type] = inner;
  }
  return out;
}

function benvOf(io: Io): BackendEnv {
  return { lx: io.lx, cloud: io.lx.cloud, cwd: io.cwd, env: io.env };
}

function makeBackend(io: Io, type: string, config: Record<string, Val>): Backend | { error: string } {
  if (type === 'local') return localBackend(benvOf(io), config);
  if (type === 'http') return httpBackend(benvOf(io), config);
  if (type === 'cloud') return cloudBackend(benvOf(io), config);
  return { error: `Unsupported backend type "${type}". NetLab simulates the local and http backends and the cloud block (HCP Terraform).` };
}

/** The configured backend, checked against what init recorded. */
function selectBackend(io: Io, forValidate = false): BackendChoice {
  const loaded = loadModuleDir(fsSource(io.lx), io.cwd, '.');
  const cfg = loaded.config;
  if (loaded.errors.length) {
    io.diags(loaded.errors, cfg.files);
    throw new Exit(1);
  }
  const rec = readBackendRecord(io.lx, io.cwd);
  const wantType = cfg.cloud ? 'cloud' : cfg.backend?.type ?? 'local';
  const wantBody = cfg.cloud?.body ?? cfg.backend?.body;
  const fileConfig = wantBody ? literalBody(wantBody, io, cfg.files) : {};
  if (!fileConfig) throw new Exit(1);
  if (!forValidate) {
    const needInit = (reason: string) => {
      if (wantType === 'cloud' || rec?.type === 'cloud') {
        io.error(...renderDiags([{ severity: 'error', summary: 'HCP Terraform or Terraform Enterprise initialization required', detail: `HCP Terraform or Terraform Enterprise initialization required: please run "terraform init"\n\nReason: ${reason}\n\nChanges to the HCP Terraform configuration block require reinitialization, to discover any changes to the available workspaces.\n\nTo re-initialize, run:\n  terraform init\n\nTerraform has not yet made changes to your existing configuration or state.` }], {}));
      } else {
        io.error(...renderDiags([{ severity: 'error', summary: 'Backend initialization required, please run "terraform init"', detail: `Reason: ${reason}\n\nThe "backend" is the interface that Terraform uses to store state, perform operations, etc. If this message is showing up, it means that the Terraform configuration you're using is using a custom configuration for the Terraform backend.\n\nChanges to backend configurations require reinitialization. This allows Terraform to set up the new configuration, copy existing state, etc. Please run "terraform init" with either the "-reconfigure" or "-migrate-state" flags to use the current configuration.\n\nIf the change reason above is incorrect, please verify your configuration hasn't changed and try again. At this point, no changes to your existing configuration or state have been made.` }], {}));
      }
      throw new Exit(1);
    };
    if (wantType !== 'local' && !rec) needInit(wantType === 'cloud' ? 'Initial configuration of HCP Terraform or Terraform Enterprise.' : `Initial configuration of the requested backend "${wantType}"`);
    if (rec && wantType === 'local' && !cfg.backend && rec.type !== 'local') needInit(`Unsetting the previously set backend "${rec.type}"`);
    if (rec && wantType !== 'local' && rec.type !== wantType) needInit(`Backend type changed from "${rec.type}" to "${wantType}"`);
    if (rec && rec.type === wantType && wantType !== 'local' && rec.hash !== backendHash(wantType, fileConfig)) needInit(wantType === 'cloud' ? 'HCP Terraform configuration block has changed.' : 'Backend configuration block has changed');
  }
  const config = rec && rec.type === wantType ? { ...fileConfig, ...rec.config } : fileConfig;
  const b = makeBackend(io, wantType, config);
  if ('error' in b) {
    io.error(...renderDiags([{ severity: 'error', summary: wantType === 'cloud' ? b.error.split('\n')[0] : 'Failed to get existing workspaces', detail: wantType === 'cloud' ? b.error.split('\n').slice(2).join('\n') : b.error }], {}));
    throw new Exit(1);
  }
  return { backend: b, type: wantType as BackendChoice['type'], config };
}

function readStateOrFail(io: Io, backend: Backend, ws: string): StateFile | null {
  const s = backend.read(ws);
  if (s && 'error' in s) {
    io.error(...renderDiags([{ severity: 'error', summary: s.error.split(':')[0], detail: s.error.slice(s.error.indexOf(':') + 1).trim() }], {}));
    throw new Exit(1);
  }
  return s;
}

function lockOrFail(io: Io, backend: Backend, ws: string, operation: string, skip: boolean): () => void {
  if (skip) return () => undefined;
  const who = `${io.lx.user}@${io.lx.hostname}`;
  const r = backend.lock(ws, operation, who);
  if (r.error) {
    io.error(...renderDiags([{ severity: 'error', summary: 'Error acquiring the state lock', detail: `Error message: ${r.error}\n\nTerraform acquires a state lock to protect the state from being written by multiple users at the same time. Please resolve the issue above and try again. For most commands, you can disable locking with the "-lock=false" flag, but this is not recommended.` }], {}));
    throw new Exit(1);
  }
  if (r.held) {
    const l = r.held;
    io.error(
      ...renderDiags(
        [
          {
            severity: 'error',
            summary: 'Error acquiring the state lock',
            detail: `Error message: HTTP remote state already locked: ID=${l.ID}\nLock Info:\n  ID:        ${l.ID}\n  Path:      ${l.Path}\n  Operation: ${l.Operation}\n  Who:       ${l.Who}\n  Version:   ${l.Version}\n  Created:   ${l.Created}\n  Info:      ${l.Info}\n\n\nTerraform acquires a state lock to protect the state from being written by multiple users at the same time. Please resolve the issue above and try again. For most commands, you can disable locking with the "-lock=false" flag, but this is not recommended.`,
          },
        ],
        {},
      ),
    );
    throw new Exit(1);
  }
  return () => {
    if (r.lock) backend.unlock(ws, r.lock.ID);
  };
}

function writeStateOrFail(io: Io, backend: Backend, ws: string, state: StateFile) {
  const e = backend.write(ws, state);
  if (e) {
    io.error(...renderDiags([{ severity: 'error', summary: 'Failed to save state', detail: e }], {}));
    throw new Exit(1);
  }
}

// ---------------------------------------------------------------------------
// run options

function runOptions(io: Io, f: Flags, mode: RunOptions['mode']): RunOptions {
  const cliVars: RunOptions['cliVars'] = [];
  for (const v of f.values.var ?? []) {
    const idx = v.indexOf('=');
    if (idx <= 0) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Invalid -var option', detail: `The given -var option "${v}" is not correctly specified. It must be a variable name and value separated an equals sign, like -var="key=value".` }], {}));
      throw new Exit(1);
    }
    cliVars.push({ name: v.slice(0, idx), value: v.slice(idx + 1) });
  }
  const input = !f.bool.has('no-input') && io.env.TF_INPUT !== '0' && io.env.TF_INPUT !== 'false';
  return {
    mode: f.bool.has('destroy') ? 'destroy' : f.bool.has('refresh-only') ? 'refresh-only' : mode,
    refresh: !f.bool.has('no-refresh'),
    targets: f.values.target ?? [],
    replace: f.values.replace ?? [],
    cliVars,
    varFiles: f.values['var-file'] ?? [],
    input,
    ask: input ? (lines) => io.ask(lines) : undefined,
    generateConfigOut: f.values['generate-config-out']?.[0],
  };
}

function runEnv(io: Io, workspace: string, src: Source = fsSource(io.lx), envOverride?: Record<string, string>): RunEnv {
  return {
    lx: io.lx,
    cloud: io.lx.cloud,
    cwd: io.cwd,
    env: envOverride ?? io.env,
    src,
    workspace,
    out: (line) => io.print(line),
    log: (level, line) => io.log(level, line),
  };
}

function logPreamble(io: Io, args: string[]) {
  io.log('INFO', `Terraform version: ${TF_VERSION}`);
  io.log('DEBUG', 'using github.com/hashicorp/go-tfe v1.74.1');
  io.log('DEBUG', 'using github.com/hashicorp/hcl/v2 v2.23.0');
  io.log('INFO', 'Go runtime version: go1.24.0');
  io.log('INFO', `CLI args: []string{${['terraform', ...args].map((a) => JSON.stringify(a)).join(', ')}}`);
  io.log('DEBUG', `Attempting to open CLI config file: /home/${io.lx.user}/.terraformrc`);
  io.log('DEBUG', "File doesn't exist.");
  io.log('INFO', `CLI command args: []string{${args.map((a) => JSON.stringify(a)).join(', ')}}`);
}

interface Recorded {
  command: string;
  args: string[];
  code: number;
  dir: string;
  workspace: string;
  add?: number;
  change?: number;
  destroy?: number;
  imported?: number;
  noChanges?: boolean;
  remote?: boolean;
}

function record(io: Io, r: Recorded) {
  const runs = (io.lx.terraformRuns ??= []);
  runs.push(r);
  if (runs.length > 200) runs.shift();
}

// ---------------------------------------------------------------------------
// entry point

export function terraformCommand(lx: LinuxState, args: string[], env: Record<string, string>, cwd: string, answers: string[] = [], stdin = ''): TfResult {
  let dir = cwd;
  let rest = [...args];
  while (rest[0]?.startsWith('-chdir=') || rest[0] === '-chdir') {
    const v = rest[0] === '-chdir' ? rest[1] : rest[0].slice(7);
    rest = rest.slice(rest[0] === '-chdir' ? 2 : 1);
    dir = normalizePath(cwd, v ?? '.', `/home/${lx.user}`);
    if (!getNode(lx, dir) || getNode(lx, dir)!.type !== 'dir') {
      return { out: [], err: [`Error handling -chdir option: chdir ${v}: no such file or directory`], code: 1 };
    }
  }
  const io = new Io(lx, dir, env, rest, answers, stdin);
  const [sub = '', ...subArgs] = rest;
  let code = 0;
  try {
    logPreamble(io, rest);
    code = dispatch(io, sub, subArgs);
  } catch (e) {
    if (e instanceof Ask) {
      io.flushLog();
      return { out: io.out.slice(0), err: io.err, code: 0, pending: { kind: 'terraform', argv: args, cwd, env: { ...env }, answers: [...answers], printed: io.out.length, prompt: e.prompt, masked: e.masked } };
    }
    if (e instanceof NeedInput) {
      io.flushLog();
      return { out: io.out, err: io.err, code: 1 };
    }
    if (e instanceof Exit) code = e.code;
    else if (e instanceof DiagError) {
      io.diags(e.diags);
      code = 1;
    } else throw e;
  }
  io.flushLog();
  return { out: io.out, err: io.err, code };
}

/** Continue a command that stopped at a question. */
export function resumeTerraform(lx: LinuxState, pending: TfPending, answer: string): TfResult {
  if (pending.console) return consoleLine(lx, pending, answer);
  const answers = [...pending.answers, answer];
  const r = terraformCommand(lx, pending.argv, pending.env, pending.cwd, answers);
  const out = r.out.slice(pending.printed);
  if (r.pending) return { ...r, out, pending: { ...r.pending, printed: r.pending.printed } };
  return { ...r, out };
}

const HELP = [
  'Usage: terraform [global options] <subcommand> [args]',
  '',
  'The available commands for execution are listed below.',
  'The primary workflow commands are given first, followed by',
  'less common or more advanced commands.',
  '',
  'Main commands:',
  '  init          Prepare your working directory for other commands',
  '  validate      Check whether the configuration is valid',
  '  plan          Show changes required by the current configuration',
  '  apply         Create or update infrastructure',
  '  destroy       Destroy previously-created infrastructure',
  '',
  'All other commands:',
  '  console       Try Terraform expressions at an interactive command prompt',
  '  fmt           Reformat your configuration in the standard style',
  '  force-unlock  Release a stuck lock on the current workspace',
  '  get           Install or upgrade remote Terraform modules',
  '  import        Associate existing infrastructure with a Terraform resource',
  '  login         Obtain and save credentials for a remote host',
  '  logout        Remove locally-stored credentials for a remote host',
  '  output        Show output values from your root module',
  '  providers     Show the providers required for this configuration',
  '  refresh       Update the state to match remote systems',
  '  show          Show the current state or a saved plan',
  '  state         Advanced state management',
  '  taint         Mark a resource instance as not fully functional',
  '  untaint       Remove the \'tainted\' state from a resource instance',
  '  version       Show the current Terraform version',
  '  workspace     Workspace management',
  '',
  'Global options (use these before the subcommand, if any):',
  '  -chdir=DIR    Switch to a different working directory before executing the',
  '                given subcommand.',
  '  -help         Show this help output, or the help for a specified subcommand.',
  '  -version      An alias for the "version" subcommand.',
];

function dispatch(io: Io, sub: string, args: string[]): number {
  if (args.includes('-help') || args.includes('--help') || args.includes('-h')) return subHelp(io, sub);
  switch (sub) {
    case '':
    case '-help':
    case '--help':
    case '-h':
    case 'help':
      io.print(...HELP);
      return sub ? 0 : 127;
    case 'version':
    case '-version':
    case '--version':
    case '-v':
      return versionCmd(io);
    case 'init':
      return initCmd(io, args);
    case 'get':
      return getCmd(io, args);
    case 'validate':
      return validateCmd(io, args);
    case 'fmt':
      return fmtCmd(io, args);
    case 'plan':
      return planCmd(io, args);
    case 'apply':
      return applyCmd(io, args, false);
    case 'destroy':
      return applyCmd(io, args, true);
    case 'refresh':
      return refreshCmd(io, args);
    case 'output':
      return outputCmd(io, args);
    case 'show':
      return showCmd(io, args);
    case 'state':
      return stateCmd(io, args);
    case 'import':
      return importCmd(io, args);
    case 'taint':
    case 'untaint':
      return taintCmd(io, args, sub === 'taint');
    case 'workspace':
    case 'env':
      return workspaceCmd(io, args);
    case 'force-unlock':
      return forceUnlockCmd(io, args);
    case 'providers':
      return providersCmd(io);
    case 'console':
      return consoleCmd(io);
    case 'login':
      return loginCmd(io, args);
    case 'logout':
      return logoutCmd(io, args);
    case 'graph':
    case 'test':
    case 'modules':
    case 'metadata':
      io.error(`NetLab does not simulate "terraform ${sub}". The labs use init, validate, fmt, plan, apply, destroy, output, show, state, import, workspace, console and login.`);
      return 1;
    default: {
      const near = closest(sub, ['init', 'plan', 'apply', 'destroy', 'validate', 'fmt', 'output', 'show', 'state', 'import', 'workspace', 'console', 'providers', 'version', 'login', 'logout', 'refresh', 'taint', 'untaint', 'get', 'force-unlock']);
      io.error(`Terraform has no command named "${sub}".${near ? ` Did you mean "${near}"?` : ''}`, '', 'To see all of Terraform\'s top-level commands, run:', '  terraform -help', '');
      return 1;
    }
  }
}

function subHelp(io: Io, sub: string): number {
  const help: Record<string, string[]> = {
    plan: ['Usage: terraform [global options] plan [options]', '', '  Generates a speculative execution plan, showing what actions Terraform', '  would take to apply the current configuration.', '', 'Plan Customization Options:', '  -destroy            Select the "destroy" planning mode.', '  -refresh-only       Select the "refresh only" planning mode.', '  -refresh=false      Skip checking for external changes to remote objects.', '  -replace=resource   Force replacement of a particular resource instance.', '  -target=resource    Limit the planning operation to only the given module,', '                      resource, or resource instance.', '  -var \'foo=bar\'      Set a value for one of the input variables.', '  -var-file=filename  Load variable values from the given file.', '', 'Other Options:', '  -detailed-exitcode  Return 0 (no changes), 1 (error) or 2 (changes).', '  -generate-config-out=path  Write HCL for resources in import blocks.', '  -input=true         Ask for input for variables if not directly set.', '  -lock=false         Don\'t hold a state lock during the operation.', '  -out=path           Write a plan file to the given path.'],
    apply: ['Usage: terraform [global options] apply [options] [PLAN]', '', '  Creates or updates infrastructure according to Terraform configuration', '  files in the current directory.', '', 'Options:', '  -auto-approve       Skip interactive approval of plan before applying.', '  -input=true         Ask for input for variables if not directly set.', '  -lock=false         Don\'t hold a state lock during the operation.', '', '  Also accepts every planning option terraform plan does.'],
    init: ['Usage: terraform [global options] init [options]', '', '  Initialize a new or existing Terraform working directory by creating', '  initial files, loading any remote state, downloading modules, etc.', '', 'Options:', '  -backend=false          Disable backend or HCP Terraform initialization.', '  -backend-config=path    Partial backend configuration (key=value).', '  -force-copy             Suppress prompts about copying state data.', '  -migrate-state          Reconfigure a backend, and attempt to migrate any', '                          existing state.', '  -reconfigure            Reconfigure a backend, ignoring any saved configuration.', '  -upgrade                Install the latest module and provider versions allowed', '                          within configured constraints.'],
    state: ['Usage: terraform [global options] state <subcommand> [options] [args]', '', 'Subcommands:', '    list                List resources in the state', '    mv                  Move an item in the state', '    pull                Pull current state and output to stdout', '    rm                  Remove instances from the state', '    show                Show a resource in the state'],
    workspace: ['Usage: terraform [global options] workspace', '', '  new, list, show, select and delete Terraform workspaces.', '', 'Subcommands:', '    delete    Delete a workspace', '    list      List Workspaces', '    new       Create a new workspace', '    select    Select a workspace', '    show      Show the name of the current workspace'],
    output: ['Usage: terraform [global options] output [options] [NAME]', '', '  Reads an output variable from a Terraform state file and prints', '  the value. With no additional arguments, output will display all', '  the outputs for the root module.', '', 'Options:', '  -json   Machine readable output will be printed in JSON format.', '  -raw    For value types that can be automatically converted to a', '          string, will print the raw string directly.'],
    fmt: ['Usage: terraform [global options] fmt [options] [target...]', '', '  Rewrites all Terraform configuration files to a canonical format.', '', 'Options:', '  -list=false    Don\'t list files whose formatting differs', '  -write=false   Don\'t write to source files', '  -diff          Display diffs of formatting changes', '  -check         Check if the input is formatted. Exit status will be 0 if all', '                 input is properly formatted and 3 otherwise.', '  -recursive     Also process files in subdirectories.'],
  };
  io.print(...(help[sub] ?? HELP));
  return 0;
}

// ---------------------------------------------------------------------------
// version, providers

function versionCmd(io: Io): number {
  io.print(`Terraform v${TF_VERSION}`, 'on linux_amd64');
  const lock = readLock(io.lx, io.cwd);
  if (!('error' in lock)) {
    for (const e of Object.values(lock as Record<string, LockEntry>).sort((a, b) => a.source.localeCompare(b.source))) {
      if (isProviderInstalled(io.lx, io.cwd, e.source, e.version)) io.print(`+ provider registry.terraform.io/${e.source} v${e.version}`);
    }
  }
  return 0;
}

function providersCmd(io: Io): number {
  const loaded = loadTree(runEnv(io, 'default'));
  if (!loaded.tree) {
    io.diags(loaded.diags, loaded.sources);
    return 1;
  }
  io.print('', 'Providers required by configuration:', '.');
  const lines: string[] = [];
  const walkTree = (t: typeof loaded.tree, prefix: string) => {
    const items: Array<{ text: string; child?: typeof t }> = [];
    const req = new Map<string, string[]>();
    for (const rp of Object.values(t!.config.requiredProviders)) req.set(rp.source, rp.version ? [rp.version] : []);
    for (const r of Object.values(t!.config.resources)) {
      const src = t!.config.requiredProviders[r.provider.name]?.source ?? (r.provider.name === 'terraform' ? '' : `hashicorp/${r.provider.name}`);
      if (src && !req.has(src)) req.set(src, []);
    }
    for (const [src, c] of req) items.push({ text: `provider[registry.terraform.io/${src}]${c.length ? ' ' + c.join(', ') : ''}` });
    for (const [name, child] of Object.entries(t!.children)) items.push({ text: `module.${name}`, child });
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${it.text}`);
      if (it.child) walkTree(it.child, prefix + (last ? '    ' : '│   '));
    });
  };
  walkTree(loaded.tree, '');
  io.print(...lines, '');
  try {
    const choice = selectBackend(io);
    const ws = currentWorkspace(io.lx, io.cwd, io.env);
    const s = choice.backend.read(ws);
    if (s && !('error' in s) && s.resources.length) {
      io.print('Providers required by state:', '');
      for (const p of [...new Set(s.resources.map((r) => r.provider))].sort()) io.print(`    ${p.replace(/"/g, '')}`, '');
    }
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    io.err = [];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// init and get

const INIT_PROBLEM = ['Terraform encountered problems during initialisation, including problems', 'with the configuration, described below.', '', 'The Terraform configuration must be valid before initialization so that', 'Terraform can determine which modules and providers need to be installed.', ''];

function installModules(io: Io, upgrade: boolean): boolean {
  const src = fsSource(io.lx);
  const root = loadModuleDir(src, io.cwd, '.');
  if (root.errors.length) {
    io.print(...INIT_PROBLEM);
    io.diags(root.errors, root.config.files);
    return false;
  }
  const previous = readModules(io.lx, io.cwd);
  const records: ModuleRecord[] = [{ Key: '', Source: '', Dir: '.' }];
  let ok = true;
  const visit = (cfg: typeof root.config, keyPrefix: string, depth: number) => {
    if (depth > 6) return;
    for (const call of Object.values(cfg.modules)) {
      const key = keyPrefix ? `${keyPrefix}.${call.name}` : call.name;
      if (isLocalSource(call.source)) {
        const dir = normalizePath(cfg.dir, call.source, '/');
        const rel = dir === io.cwd ? '.' : dir.startsWith(io.cwd + '/') ? dir.slice(io.cwd.length + 1) : call.source;
        const loaded = loadModuleDir(src, dir, rel);
        if (!getNode(io.lx, dir)) {
          io.print(...INIT_PROBLEM);
          io.error(...renderDiags([{ severity: 'error', summary: 'Unreadable module directory', detail: `Unable to evaluate directory symlink: lstat ${call.source.replace(/^\.\//, '')}: no such file or directory`, pos: call.pos }], root.config.files));
          ok = false;
          continue;
        }
        io.print(`- ${key} in ${rel}`);
        records.push({ Key: key, Source: call.source, Dir: rel });
        if (loaded.errors.length) {
          io.diags(loaded.errors, loaded.config.files);
          ok = false;
          continue;
        }
        visit(loaded.config, key, depth + 1);
        continue;
      }
      const versions = REGISTRY_MODULES[call.source.replace(/^registry\.terraform\.io\//, '')];
      if (!versions) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Module not found', detail: `The module address "${call.source}" could not be resolved.\n\nIf you intended this as a path relative to the current module, use "./${call.source}" instead. The "./" prefix indicates that the address is a relative filesystem path.`, pos: call.pos }], root.config.files));
        ok = false;
        continue;
      }
      const source = call.source.replace(/^registry\.terraform\.io\//, '');
      const prev = previous.find((p) => p.Key === key && p.Source === call.source);
      let version = prev?.Version && !upgrade && satisfies(prev.Version, call.version) ? prev.Version : newestMatching(Object.keys(versions), call.version ? [call.version] : []);
      if (!version) {
        const newest = Object.keys(versions).sort(cmpVersion).pop();
        io.error(...renderDiags([{ severity: 'error', summary: 'Unresolvable module version constraint', detail: `There is no available version of module "${call.name}" (${call.pos.file}:${call.pos.line}) which matches the given version constraint. The newest available version is ${newest}.`, pos: call.pos }], root.config.files));
        ok = false;
        continue;
      }
      if (prev?.Version === version && getNode(io.lx, `${dataDir(io.cwd)}/modules/${key}`)) {
        io.print(`- ${key} in .terraform/modules/${key}`);
      } else {
        io.print(`Downloading registry.terraform.io/${source} ${version} for ${key}...`, `- ${key} in .terraform/modules/${key}`);
        installRegistryModule(io.lx, io.cwd, key, version, source);
      }
      records.push({ Key: key, Source: call.source, Version: version, Dir: `.terraform/modules/${key}` });
      const loaded = loadModuleDir(src, `${dataDir(io.cwd)}/modules/${key}`, `.terraform/modules/${key}`);
      visit(loaded.config, key, depth + 1);
      void version;
      version = undefined;
    }
  };
  visit(root.config, '', 0);
  if (ok) writeModules(io.lx, io.cwd, records);
  return ok;
}

function getCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['update'], []);
  if (f.unknown.length) flagError(io, 'get', f.unknown[0]);
  return installModules(io, f.bool.has('update')) ? 0 : 1;
}

function initCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['upgrade', 'reconfigure', 'migrate-state', 'force-copy', 'backend', 'input', 'get'], ['backend-config', 'lockfile']);
  if (f.unknown.length) flagError(io, 'init', f.unknown[0]);
  const src = fsSource(io.lx);
  const root = loadModuleDir(src, io.cwd, '.');
  if (Object.keys(root.config.files).length === 0) {
    io.print('Terraform initialized in an empty directory!', '', 'The directory has no Terraform configuration files. You may begin working', 'with Terraform immediately by creating Terraform configuration files.');
    return 0;
  }
  if (root.errors.length) {
    io.print(...INIT_PROBLEM);
    io.diags(root.errors, root.config.files);
    return 1;
  }
  const cfg = root.config;
  const upgrade = f.bool.has('upgrade');

  // backend
  const isCloud = Boolean(cfg.cloud);
  if (!f.bool.has('no-backend')) {
    io.print(isCloud ? 'Initializing HCP Terraform...' : 'Initializing the backend...');
    const wantType = isCloud ? 'cloud' : cfg.backend?.type ?? 'local';
    const fileConfig = literalBody((cfg.cloud ?? cfg.backend)?.body ?? { attrs: {}, blocks: [] }, io, cfg.files);
    if (!fileConfig) return 1;
    const partial: Record<string, Val> = {};
    for (const kv of f.values['backend-config'] ?? []) {
      const i = kv.indexOf('=');
      if (i > 0) partial[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const merged = { ...fileConfig, ...partial };
    const rec = readBackendRecord(io.lx, io.cwd);
    const prevType = rec?.type ?? 'local';
    const hash = backendHash(wantType, fileConfig);
    const changed = rec ? rec.type !== wantType || rec.hash !== hash || Object.keys(partial).length > 0 : wantType !== 'local';
    if (wantType !== 'local' && !['http', 'cloud'].includes(wantType)) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Unsupported backend type', detail: `There is no backend type named "${wantType}" in NetLab. The labs use the local and http backends and the cloud block for HCP Terraform.`, pos: cfg.backend?.pos }], cfg.files));
      return 1;
    }
    const target = makeBackend(io, wantType, merged);
    if ('error' in target) {
      if (isCloud) io.error(...renderDiags([{ severity: 'error', summary: target.error.split('\n')[0], detail: target.error.split('\n').slice(2).join('\n') }], {}));
      else io.error(...renderDiags([{ severity: 'error', summary: 'Error configuring the backend', detail: target.error }], {}));
      return 1;
    }
    if (changed) {
      if (rec && rec.type !== 'local' && !f.bool.has('migrate-state') && !f.bool.has('reconfigure') && !(prevType === wantType && !rec)) {
        io.error(
          ...renderDiags(
            [
              {
                severity: 'error',
                summary: 'Backend configuration changed',
                detail: `A change in the backend configuration has been detected, which may require migrating existing state.\n\nIf you wish to attempt automatic migration of the state, use "terraform init -migrate-state".\nIf you wish to store the current configuration with no changes to the state, use "terraform init -reconfigure".`,
              },
            ],
            {},
          ),
        );
        return 1;
      }
      // Existing state in the previous backend, to offer to copy.
      const prevBackend = makeBackend(io, prevType, rec?.config ?? {});
      const ws = currentWorkspace(io.lx, io.cwd, io.env);
      const prevState = !('error' in prevBackend) && !f.bool.has('reconfigure') ? prevBackend.read(prevType === 'cloud' ? ws : ws) : null;
      const hasPrev = prevState && !('error' in prevState) && prevState.resources.length > 0;
      if (hasPrev) {
        const existing = target.read(ws);
        const existingHas = existing && !('error' in existing) && existing.resources.length > 0;
        let copy = f.bool.has('force-copy');
        if (!copy) {
          if (isCloud) {
            io.print(`Migrating from backend "${prevType}" to HCP Terraform.`);
            copy = io.ask(['Do you wish to proceed?', '  As part of migrating to HCP Terraform, Terraform can optionally copy your', '  current workspace state to the configured HCP Terraform workspace.', '', '  Answer "yes" to copy the latest state snapshot to the configured', '  HCP Terraform workspace.', '', '  Answer "no" to ignore the existing state and just activate the configured', '  HCP Terraform workspace with its existing state, if any.', '', '  Should Terraform migrate your existing state?', '']) === 'yes';
          } else {
            copy =
              io.ask([
                'Do you want to copy existing state to the new backend?',
                `  Pre-existing state was found while migrating the previous "${prevType}" backend to the`,
                `  newly configured "${wantType}" backend. ${existingHas ? `An existing non-empty state already exists in` : `No existing state was found in the newly`}`,
                `  configured "${wantType}" backend. Do you want to copy this state to the new "${wantType}"`,
                '  backend? Enter "yes" to copy and "no" to start with an empty state.',
                '',
              ]) === 'yes';
          }
        }
        if (copy) {
          const e = target.write(ws, { ...(prevState as StateFile), serial: (prevState as StateFile).serial });
          if (e) {
            io.error(e);
            return 1;
          }
        }
        io.print('');
      }
      writeBackendRecord(io.lx, io.cwd, wantType === 'local' && !cfg.backend ? null : { type: wantType, config: merged, hash });
      if (wantType !== 'local' || cfg.backend) {
        if (isCloud) {
          const s = cloudSettings(merged, io.env);
          const org = hcpOrg(benvOf(io), s) as HcpOrg;
          if (s.name && !org.workspaces[s.name]) {
            org.workspaces[s.name] = { name: s.name, project: s.project ?? 'Default Project', tags: [], vars: {}, runs: 0 };
          }
          if (s.name) selectWorkspace(io.lx, io.cwd, s.name);
        } else io.print(`Successfully configured the backend "${wantType}"! Terraform will automatically`, 'use this backend unless the backend configuration changes.');
      }
    } else if (!getNode(io.lx, dataDir(io.cwd))) {
      makeDir(io.lx, dataDir(io.cwd), true);
    }
  }

  // modules
  const hasModules = Object.keys(cfg.modules).length > 0;
  if (hasModules && !f.bool.has('no-get')) {
    io.print('Initializing modules...');
    if (!installModules(io, upgrade)) return 1;
  }

  // providers
  io.print('Initializing provider plugins...');
  const env = runEnv(io, currentWorkspace(io.lx, io.cwd, io.env));
  const loaded = loadTree(env);
  if (!loaded.tree) {
    io.diags(loaded.diags, loaded.sources);
    return 1;
  }
  if (loaded.diags.length) {
    io.diags(loaded.diags, loaded.sources);
    return 1;
  }
  const needed = requiredProviders(loaded.tree);
  const lockRead = readLock(io.lx, io.cwd);
  if ('error' in lockRead) {
    io.error(lockRead.error as string);
    return 1;
  }
  const lock = { ...(lockRead as Record<string, LockEntry>) };
  const hadLock = Object.keys(lock).length > 0;
  let failed = false;
  const sources = Object.keys(needed).sort();
  for (const source of sources) {
    const req = needed[source];
    const def = PROVIDERS[source] ?? providerFor(source);
    const constraint = req.constraints.join(', ');
    const locked = lock[source];
    if (!def) {
      const type = source.split('/').pop()!;
      const alt = Object.keys(PROVIDERS).find((k) => k.endsWith('/' + type) && k !== source);
      io.error(
        ...renderDiags(
          [
            {
              severity: 'error',
              summary: 'Failed to query available provider packages',
              detail: `Could not retrieve the list of available versions for provider ${source}: provider registry registry.terraform.io does not have a provider named registry.terraform.io/${source}${alt ? `\n\nDid you intend to use ${alt}? If so, you must specify that source address in each module which requires that provider. To see which modules are currently depending on ${source}, run the following command:\n    terraform providers` : ''}`,
            },
          ],
          {},
        ),
      );
      failed = true;
      continue;
    }
    if (locked && !upgrade) {
      if (!req.constraints.every((c) => satisfies(locked.version, c))) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Failed to query available provider packages', detail: `Could not retrieve the list of available versions for provider ${source}: locked provider registry.terraform.io/${source} ${locked.version} does not match configured version constraint ${constraint}; must use terraform init -upgrade to allow selection of new versions` }], {}));
        failed = true;
        continue;
      }
      io.print(`- Reusing previous version of ${source} from the dependency lock file`);
      if (isProviderInstalled(io.lx, io.cwd, source, locked.version)) io.print(`- Using previously-installed ${source} v${locked.version}`);
      else {
        io.print(`- Installing ${source} v${locked.version}...`, `- Installed ${source} v${locked.version} (${def.namespace === 'hashicorp' ? 'signed by HashiCorp' : 'self-signed, key ID 7A3F2C91D0E4B865'})`);
        installProvider(io.lx, io.cwd, source, locked.version);
      }
      if (locked.constraints !== (constraint || undefined)) lock[source] = { ...locked, constraints: constraint || undefined };
      continue;
    }
    io.print(`- Finding ${constraint ? `${source} versions matching "${constraint}"` : `latest version of ${source}`}...`);
    const version = newestMatching(def.versions, req.constraints);
    if (!version) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Failed to query available provider packages', detail: `Could not retrieve the list of available versions for provider ${source}: no available releases match the given constraints ${constraint}` }], {}));
      failed = true;
      continue;
    }
    if (isProviderInstalled(io.lx, io.cwd, source, version)) io.print(`- Using previously-installed ${source} v${version}`);
    else {
      io.print(`- Installing ${source} v${version}...`, `- Installed ${source} v${version} (${def.namespace === 'hashicorp' ? 'signed by HashiCorp' : 'self-signed, key ID 7A3F2C91D0E4B865'})`);
      installProvider(io.lx, io.cwd, source, version);
    }
    lock[source] = { source, version, constraints: constraint || undefined, hashes: providerHashes(source, version) };
  }
  for (const k of Object.keys(lock)) if (!needed[k]) delete lock[k];
  if (failed) return 1;
  if (sources.some((s) => (PROVIDERS[s] ?? providerFor(s))?.namespace !== 'hashicorp')) {
    io.print('', 'Partner and community providers are signed by their developers.', "If you'd like to know more about provider signing, you can read about it here:", 'https://developer.hashicorp.com/terraform/cli/plugins/signing');
  }
  const before = canonical(plain(lockRead as unknown as Val));
  writeLock(io.lx, io.cwd, lock);
  if (!hadLock) {
    io.print('', 'Terraform has created a lock file .terraform.lock.hcl to record the provider', 'selections it made above. Include this file in your version control repository', 'so that Terraform can guarantee to make the same selections by default when', 'you run "terraform init" in the future.');
  } else if (before !== canonical(plain(lock as unknown as Val))) {
    io.print('', 'Terraform has made some changes to the provider dependency selections recorded', 'in the .terraform.lock.hcl file. Review those changes and commit them to your', 'version control system if they represent changes you intended to make.');
  }
  if (isCloud) {
    io.print('', 'HCP Terraform has been successfully initialized!', '', 'You may now begin working with HCP Terraform. Try running "terraform plan" to', 'see any changes that are required for your infrastructure.', '', 'If you ever set or change modules or Terraform Settings, run "terraform init"', 'again to reinitialize your working directory.');
  } else {
    io.print('', 'Terraform has been successfully initialized!', '', 'You may now begin working with Terraform. Try running "terraform plan" to see', 'any changes that are required for your infrastructure. All Terraform commands', 'should now work.', '', 'If you ever set or change modules or backend configuration for Terraform,', 'rerun this command to reinitialize your working directory. If you forget, other', 'commands will detect it and remind you to do so if necessary.');
  }
  record(io, { command: 'init', args: io.argv.slice(1), code: 0, dir: io.cwd, workspace: currentWorkspace(io.lx, io.cwd, io.env) });
  return 0;
}

// ---------------------------------------------------------------------------
// validate and fmt

function validateCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['json', 'no-color'], []);
  if (f.unknown.length) flagError(io, 'validate', f.unknown[0]);
  const env = runEnv(io, 'default');
  const outcome = plan(env, { mode: 'normal', refresh: false, targets: [], replace: [], cliVars: [], varFiles: [], input: false, validateOnly: true }, null);
  const warnings = outcome.warnings;
  if (outcome.diags.length) {
    io.diags([...warnings, ...outcome.diags], outcome.sources);
    record(io, { command: 'validate', args, code: 1, dir: io.cwd, workspace: 'default' });
    return 1;
  }
  if (warnings.length) {
    io.print(...renderDiags(warnings, outcome.sources));
    io.print('Success! The configuration is valid, but there were some', 'validation warnings as shown above.', '');
  } else io.print('Success! The configuration is valid.', '');
  record(io, { command: 'validate', args, code: 0, dir: io.cwd, workspace: 'default' });
  return 0;
}

function fmtCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['check', 'diff', 'recursive', 'write', 'list', 'no-color'], []);
  if (f.unknown.length) flagError(io, 'fmt', f.unknown[0]);
  const targets = f.positional.length ? f.positional : ['.'];
  const files: string[] = [];
  for (const t of targets) {
    const p = normalizePath(io.cwd, t, `/home/${io.lx.user}`);
    const node = getNode(io.lx, p);
    if (!node) {
      io.error(...renderDiags([{ severity: 'error', summary: 'No file or directory at ' + t, detail: `There is no file or directory at ${t}.` }], {}));
      return 2;
    }
    if (node.type !== 'dir') files.push(p);
    else {
      for (const key of Object.keys(io.lx.fs).sort()) {
        if (!key.startsWith(p === '/' ? '/' : p + '/')) continue;
        const rest = key.slice(p.length + 1);
        if (rest.split('/').some((seg) => seg.startsWith('.'))) continue;
        if (!f.bool.has('recursive') && rest.includes('/')) continue;
        if (io.lx.fs[key].type === 'file' && /\.(tf|tfvars)$/.test(key)) files.push(key);
      }
    }
  }
  const check = f.bool.has('check');
  const write = !check && !f.bool.has('no-write');
  let unformatted = 0;
  for (const path of files) {
    const r = readFile(io.lx, path);
    if ('error' in r) continue;
    const display = path.startsWith(io.cwd + '/') ? path.slice(io.cwd.length + 1) : path;
    try {
      parseHcl(r.content, display);
    } catch (e) {
      if (e instanceof DiagError) {
        io.error(...renderDiags(e.diags, { [display]: r.content }));
        return 2;
      }
      throw e;
    }
    const formatted = formatHcl(r.content);
    if (formatted === r.content) continue;
    unformatted++;
    if (!f.bool.has('no-list')) io.print(display);
    if (f.bool.has('diff')) io.print(...unifiedDiff(display, r.content, formatted));
    if (write) writeFile(io.lx, path, formatted, false, 'terraform');
  }
  record(io, { command: 'fmt', args, code: check && unformatted ? 3 : 0, dir: io.cwd, workspace: 'default' });
  return check && unformatted ? 3 : 0;
}

// ---------------------------------------------------------------------------
// plan, apply, destroy

interface PlanFile {
  format: 'netlab-tfplan';
  version: 1;
  workspace: string;
  lineage: string | null;
  serial: number;
  opts: Pick<RunOptions, 'mode' | 'targets' | 'replace' | 'cliVars' | 'varFiles' | 'refresh'>;
  env: Record<string, string>;
  files: Record<string, string>;
}

function wrapText(text: string, width = 78): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function snapshot(io: Io, run: Run, opts: RunOptions): Record<string, string> {
  const files: Record<string, string> = {};
  const src = fsSource(io.lx);
  for (const t of allTrees(run.tree)) {
    for (const name of src.list(t.config.dir)) if (/\.(tf|tfvars)$/.test(name)) files[`${t.config.dir}/${name}`] = src.read(`${t.config.dir}/${name}`) ?? '';
  }
  for (const vf of opts.varFiles) {
    const p = normalizePath(io.cwd, vf, `/home/${io.lx.user}`);
    const c = src.read(p);
    if (c !== undefined) files[p] = c;
  }
  return files;
}

/** Remote runs in HCP Terraform: the header, then the plan with the workspace's variables. */
function remotePreamble(io: Io, org: HcpOrg, wsName: string, op: 'plan' | 'apply' | 'destroy') {
  const ws = org.workspaces[wsName];
  if (ws) ws.runs += 1;
  const runId = `run-${btoa(hexHash(wsName + (ws?.runs ?? 0) + io.lx.clock, 12)).replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`;
  io.print(
    `Running ${op === 'destroy' ? 'apply' : op} in HCP Terraform. Output will stream here. Pressing Ctrl-C`,
    `will stop streaming the logs, but will not stop the ${op === 'plan' ? 'plan' : 'apply'} running remotely.`,
    '',
    `Preparing the remote ${op === 'plan' ? 'plan' : 'apply'}...`,
    '',
    'To view this run in a browser, visit:',
    `https://${org.hostname}/app/${org.organization}/${wsName}/runs/${runId}`,
    '',
    'Waiting for the plan to start...',
    '',
    `Terraform v${TF_VERSION}`,
    'on linux_amd64',
    'Initializing plugins and modules...',
  );
}

function policyCheck(io: Io, org: HcpOrg, wsName: string, run: Run): boolean {
  const ws = org.workspaces[wsName];
  const sets = org.policySets.filter((s) => !s.projects || (ws && s.projects.includes(ws.project)));
  const policies = sets.flatMap((s) => s.policies.map((p) => ({ set: s.name, p })));
  if (!policies.length) return true;
  const creates = [...run.changes.values()].filter((c) => c.mode === 'managed' && ['create', 'update', 'replace'].includes(c.action) && c.after);
  const results = policies.map(({ set, p }) => ({ set, p, failures: evaluatePolicy(p, creates) }));
  const hard = results.some((r) => r.failures.length && r.p.enforcement === 'hard-mandatory');
  const anyFail = results.some((r) => r.failures.length);
  io.print('', '------------------------------------------------------------------------', '', 'Organization policy check:', '', `Sentinel Result: ${anyFail ? 'false' : 'true'}`, '');
  if (anyFail) io.print('This result means that Sentinel policies returned false and the protected', 'behavior is not allowed by Sentinel policies.', '');
  else io.print('This result means that Sentinel policies returned true and the protected', 'behavior is allowed by Sentinel policies.', '');
  io.print(`${results.length} policies evaluated.`, '');
  results.forEach((r, i) => {
    io.print(`## Policy ${i + 1}: ${r.set}/${r.p.name}.sentinel (${r.p.enforcement})`, '', `Result: ${r.failures.length ? 'false' : 'true'}`, '');
    if (r.failures.length) io.print(`FALSE - ${r.p.name}.sentinel:1:1 - Rule "main"`, ...r.failures.map((x) => `  ${x}`), '');
    else io.print(`TRUE - ${r.p.name}.sentinel:1:1 - Rule "main"`, '');
  });
  if (hard) {
    io.error(...renderDiags([{ severity: 'error', summary: 'Organization policy check hard failed.', detail: '' }], {}));
    ws && (ws.runs += 0);
    return false;
  }
  if (anyFail) io.print('Organization policy check soft failed; advisory results are shown above.', '');
  return true;
}

function evaluatePolicy(p: HcpPolicy, changes: Run['changes'] extends Map<string, infer C> ? C[] : never): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const a = c.after!;
    if (p.rule === 'allowed-instance-sizes' && c.type === 'netcloud_instance') {
      const size = (a.size ?? a.machine_type) as Val;
      if (typeof size === 'string' && !(p.sizes ?? []).includes(size)) out.push(`${c.addr}: size "${size}" is not one of the allowed sizes: ${(p.sizes ?? []).join(', ')}`);
    }
    if (p.rule === 'required-tags' && ['netcloud_instance', 'netcloud_network', 'netcloud_bucket'].includes(c.type)) {
      const tags = isObj(a.tags ?? null) ? (a.tags as Record<string, Val>) : {};
      const missing = (p.tags ?? []).filter((t) => !(t in tags));
      if (missing.length) out.push(`${c.addr}: missing required tag${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')}`);
    }
  }
  return out;
}

interface PlanContext {
  choice: BackendChoice;
  ws: string;
  prior: StateFile | null;
  env: RunEnv;
  opts: RunOptions;
  remote?: { org: HcpOrg; name: string };
  unlock: () => void;
}

function planContext(io: Io, f: Flags, mode: RunOptions['mode'], operation: string): PlanContext {
  const choice = selectBackend(io);
  const ws = currentWorkspace(io.lx, io.cwd, io.env);
  let env = runEnv(io, ws);
  const opts = runOptions(io, f, mode);
  let remote: PlanContext['remote'];
  if (choice.type === 'cloud') {
    const s = cloudSettings(choice.config, io.env);
    const org = hcpOrg(benvOf(io), s) as HcpOrg;
    const name = s.name ?? ws;
    const w = org.workspaces[name];
    if (!w) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Currently selected workspace does not exist', detail: `The workspace "${name}" was not found in the organization "${org.organization}". Run "terraform workspace list" to see the workspaces this configuration can use, and "terraform workspace select" to choose one.` }], {}));
      throw new Exit(1);
    }
    const remoteEnv: Record<string, string> = { HOME: `/home/${io.lx.user}` };
    for (const [k, v] of Object.entries(w.vars)) if (v.category === 'env') remoteEnv[k] = v.value;
    env = runEnv(io, name, fsSource(io.lx), remoteEnv);
    opts.remoteVars = w.vars;
    opts.cliVars = opts.cliVars;
    opts.input = false;
    opts.ask = undefined;
    remote = { org, name };
  }
  const prior = readStateOrFail(io, choice.backend, ws);
  const unlock = lockOrFail(io, choice.backend, ws, operation, f.bool.has('no-lock'));
  return { choice, ws, prior, env, opts, remote, unlock };
}

/** A command that cannot even start (no backend, a held lock) still counts as having been run. */
function contextOrRecord(io: Io, f: Flags, mode: RunOptions['mode'], operation: string, command: string, args: string[]): PlanContext {
  try {
    return planContext(io, f, mode, operation);
  } catch (e) {
    if (e instanceof Exit) record(io, { command, args, code: e.code, dir: io.cwd, workspace: currentWorkspace(io.lx, io.cwd, io.env) });
    throw e;
  }
}

function doPlan(io: Io, pc: PlanContext): Run | null {
  let outcome = plan(pc.env, pc.opts, pc.prior);
  if (outcome.regenerated) {
    const file = outcome.run!.generated!.file;
    outcome = plan(pc.env, { ...pc.opts, generateConfigOut: undefined }, pc.prior);
    if (!outcome.diags.length) {
      pc.opts.generateConfigOut = file;
    }
  }
  if (outcome.diags.length) {
    io.diags([...outcome.warnings, ...outcome.diags], outcome.sources);
    return null;
  }
  return outcome.run!;
}

function planCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['destroy', 'refresh-only', 'refresh', 'input', 'lock', 'detailed-exitcode', 'no-color', 'compact-warnings'], ['var', 'var-file', 'target', 'replace', 'out', 'generate-config-out', 'lock-timeout', 'parallelism']);
  if (f.unknown.length) flagError(io, 'plan', f.unknown[0]);
  const pc = contextOrRecord(io, f, 'normal', 'OperationTypePlan', 'plan', args);
  const rec: Recorded = { command: 'plan', args, code: 1, dir: io.cwd, workspace: pc.ws, remote: Boolean(pc.remote) };
  try {
    if (pc.remote) remotePreamble(io, pc.remote.org, pc.remote.name, 'plan');
    if (pc.opts.generateConfigOut && pc.remote) {
      io.error('Error: -generate-config-out is not supported for remote runs in NetLab.');
      return 1;
    }
    const run = doPlan(io, pc);
    if (!run) {
      record(io, rec);
      return 1;
    }
    if (pc.opts.generateConfigOut) {
      io.print(...renderDiags([{ severity: 'warning', summary: 'Config generation is experimental', detail: 'Generating configuration during import is currently experimental, and the generated configuration format may change in future versions.' }], {}));
    }
    const r = renderPlan(run, { destroy: pc.opts.mode === 'destroy', refreshOnly: pc.opts.mode === 'refresh-only' });
    io.print(...r.lines);
    const warnings = [...run.warnings, ...run.checkWarnings];
    if (warnings.length) io.print('', ...renderDiags(warnings, run.sources));
    if (pc.remote && !policyCheck(io, pc.remote.org, pc.remote.name, run)) {
      record(io, rec);
      return 1;
    }
    if (pc.opts.generateConfigOut) {
      io.print('', RULE, '', ...wrapText(`Terraform has generated configuration and written it to ${pc.opts.generateConfigOut}. Please review the configuration and edit it as necessary before adding it to version control.`));
    }
    const out = f.values.out?.[0];
    if (!r.empty || out) {
      if (out) {
        const pf: PlanFile = {
          format: 'netlab-tfplan',
          version: 1,
          workspace: pc.ws,
          lineage: pc.prior?.lineage ?? null,
          serial: pc.prior?.serial ?? 0,
          opts: { mode: pc.opts.mode, targets: pc.opts.targets, replace: pc.opts.replace, cliVars: pc.opts.cliVars, varFiles: pc.opts.varFiles, refresh: pc.opts.refresh },
          env: Object.fromEntries(Object.entries(io.env).filter(([k]) => k.startsWith('TF_VAR_'))),
          files: snapshot(io, run, pc.opts),
        };
        const p = normalizePath(io.cwd, out, `/home/${io.lx.user}`);
        const e = writeFile(io.lx, p, JSON.stringify(pf) + '\n', false, 'terraform');
        if (e) {
          io.error(`Error: Failed to write plan file: ${e.error}`);
          return 1;
        }
        if (!pc.remote) io.print(...planNote(out));
      } else if (!r.empty && !pc.remote) io.print(...planNote());
    }
    const changes = [...run.changes.values()];
    rec.add = changes.filter((c) => c.action === 'create' || c.action === 'replace').length;
    rec.change = changes.filter((c) => c.action === 'update').length;
    rec.destroy = changes.filter((c) => c.action === 'delete' || c.action === 'replace').length;
    rec.imported = changes.filter((c) => c.importId !== undefined).length;
    rec.noChanges = r.empty;
    rec.code = f.bool.has('detailed-exitcode') ? (r.empty ? 0 : 2) : 0;
    record(io, rec);
    return rec.code;
  } finally {
    pc.unlock();
  }
}

function applyCmd(io: Io, args: string[], destroy: boolean): number {
  const f = parseFlags(args, ['auto-approve', 'destroy', 'refresh-only', 'refresh', 'input', 'lock', 'no-color', 'compact-warnings'], ['var', 'var-file', 'target', 'replace', 'lock-timeout', 'parallelism', 'state', 'state-out', 'backup']);
  if (f.unknown.length) flagError(io, destroy ? 'destroy' : 'apply', f.unknown[0]);
  const cmd = destroy ? 'destroy' : 'apply';
  if (destroy) f.bool.add('destroy');
  const planPath = f.positional[0];
  let planFile: PlanFile | undefined;
  if (planPath) {
    const r = readFile(io.lx, normalizePath(io.cwd, planPath, `/home/${io.lx.user}`));
    if ('error' in r) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Failed to load "' + planPath + '" as a plan file', detail: `Error: stat ${planPath}: no such file or directory` }], {}));
      return 1;
    }
    try {
      planFile = JSON.parse(r.content);
      if (planFile?.format !== 'netlab-tfplan') throw new Error('not a plan');
    } catch {
      io.error(...renderDiags([{ severity: 'error', summary: `Failed to load "${planPath}" as a plan file`, detail: 'zip: not a valid zip file\n\nIf you intended to apply a configuration directory, use -chdir to switch to it before running apply.' }], {}));
      return 1;
    }
    if (f.values.var || f.values['var-file']) {
      io.error(...renderDiags([{ severity: 'error', summary: "Can't set variables when applying a saved plan", detail: 'The -var and -var-file options cannot be used when applying a saved plan file, because a saved plan includes the variable values that were set when it was created.' }], {}));
      return 1;
    }
  }
  const pc = contextOrRecord(io, f, destroy ? 'destroy' : 'normal', 'OperationTypeApply', cmd, args);
  const rec: Recorded = { command: cmd, args, code: 1, dir: io.cwd, workspace: pc.ws, remote: Boolean(pc.remote) };
  try {
    if (planFile) {
      if ((planFile.lineage ?? null) !== (pc.prior?.lineage ?? null) && pc.prior !== null && planFile.lineage !== null) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Saved plan is stale', detail: 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.' }], {}));
        record(io, rec);
        return 1;
      }
      if ((planFile.serial ?? 0) !== (pc.prior?.serial ?? 0)) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Saved plan is stale', detail: 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.' }], {}));
        record(io, rec);
        return 1;
      }
      pc.env = { ...pc.env, src: snapshotSource(planFile.files), env: { ...pc.env.env, ...planFile.env } };
      Object.assign(pc.opts, planFile.opts, { input: false, ask: undefined });
    }
    if (pc.remote) remotePreamble(io, pc.remote.org, pc.remote.name, destroy ? 'destroy' : 'apply');
    // A saved plan is applied without printing it again.
    const printPlan = !planFile;
    const outputLines: string[] = [];
    const saved = io.out.length;
    const run = doPlan(io, pc);
    if (!run) {
      record(io, rec);
      return 1;
    }
    const r = renderPlan(run, { destroy: pc.opts.mode === 'destroy', refreshOnly: pc.opts.mode === 'refresh-only', forApply: true });
    if (printPlan) io.print(...r.lines);
    else io.out.length = saved;
    const warnings = [...run.warnings, ...run.checkWarnings];
    if (warnings.length && printPlan) io.print('', ...renderDiags(warnings, run.sources));
    if (pc.remote && !policyCheck(io, pc.remote.org, pc.remote.name, run)) {
      record(io, rec);
      return 1;
    }
    void outputLines;
    const empty = r.empty && !(pc.opts.mode === 'normal' && hasChanges(run));
    if (!empty && !planFile && !f.bool.has('auto-approve')) {
      if (!pc.opts.input && !pc.remote) {
        io.error(...renderDiags([{ severity: 'error', summary: 'No approval given', detail: `${destroy ? 'Destroy' : 'Apply'} requires approval, but interactive input is disabled (-input=false). Use -auto-approve to ${destroy ? 'destroy' : 'apply'} without asking.` }], {}));
        record(io, rec);
        return 1;
      }
      const inWs = pc.ws !== 'default' && !pc.remote ? ` in workspace "${pc.ws}"` : '';
      const question =
        pc.opts.mode === 'destroy'
          ? ['', `Do you really want to destroy all resources${inWs}?`, '  Terraform will destroy all your managed infrastructure, as shown above.', "  There is no undo. Only 'yes' will be accepted to confirm.", '']
          : pc.opts.mode === 'refresh-only'
            ? ['', 'Would you like to update the Terraform state to reflect these detected changes?', '  Terraform will write these changes to the state without modifying any real infrastructure.', "  There is no undo. Only 'yes' will be accepted to confirm.", '']
            : ['', `Do you want to perform these actions${inWs}?`, '  Terraform will perform the actions described above.', "  Only 'yes' will be accepted to approve.", ''];
      const answer = io.ask(question);
      if (answer !== 'yes') {
        io.error('', pc.opts.mode === 'destroy' ? 'Destroy cancelled.' : 'Apply cancelled.');
        record(io, rec);
        return 1;
      }
    } else if (!empty || printPlan) io.print('');
    const next = apply(run);
    const stateChanged = canonical(plain(next.resources as unknown as Val)) !== canonical(plain((pc.prior?.resources ?? []) as unknown as Val)) || canonical(plain(next.outputs as unknown as Val)) !== canonical(plain((pc.prior?.outputs ?? {}) as unknown as Val)) || !pc.prior;
    if (stateChanged) writeStateOrFail(io, pc.choice.backend, pc.ws, pc.prior && !stateChanged ? pc.prior : next);
    if (run.diags.length) {
      io.diags(run.diags, run.sources);
      record(io, { ...rec, add: run.applied.added, change: run.applied.changed, destroy: run.applied.destroyed });
      return 1;
    }
    const a = run.applied;
    if (pc.opts.mode === 'destroy') io.print('', `Destroy complete! Resources: ${a.destroyed} destroyed.`);
    else io.print('', `Apply complete! Resources: ${a.imported ? `${a.imported} imported, ` : ''}${a.added} added, ${a.changed} changed, ${a.destroyed} destroyed.`);
    if (pc.opts.mode !== 'destroy' && Object.keys(next.outputs).length) io.print('', 'Outputs:', '', ...renderOutputs(next.outputs));
    record(io, { ...rec, code: 0, add: a.added, change: a.changed, destroy: a.destroyed, imported: a.imported, noChanges: empty });
    return 0;
  } finally {
    pc.unlock();
  }
}

function refreshCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['input', 'lock', 'no-color'], ['var', 'var-file', 'target']);
  if (f.unknown.length) flagError(io, 'refresh', f.unknown[0]);
  const pc = planContext(io, f, 'refresh-only', 'OperationTypeRefresh');
  try {
    const run = doPlan(io, pc);
    if (!run) return 1;
    const next = apply(run);
    writeStateOrFail(io, pc.choice.backend, pc.ws, next);
    if (Object.keys(next.outputs).length) io.print('', 'Outputs:', '', ...renderOutputs(next.outputs));
    record(io, { command: 'refresh', args, code: 0, dir: io.cwd, workspace: pc.ws });
    return 0;
  } finally {
    pc.unlock();
  }
}

// ---------------------------------------------------------------------------
// output and show

function currentState(io: Io): { state: StateFile | null; choice: BackendChoice; ws: string } {
  const choice = selectBackend(io);
  const ws = currentWorkspace(io.lx, io.cwd, io.env);
  return { state: readStateOrFail(io, choice.backend, ws), choice, ws };
}

function outputCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['json', 'raw', 'no-color'], ['state']);
  if (f.unknown.length) flagError(io, 'output', f.unknown[0]);
  const { state } = currentState(io);
  const outputs = state?.outputs ?? {};
  const name = f.positional[0];
  record(io, { command: 'output', args, code: 0, dir: io.cwd, workspace: currentWorkspace(io.lx, io.cwd, io.env) });
  if (f.bool.has('json')) {
    if (name) {
      if (!outputs[name]) return outputMissing(io, name);
      io.print(JSON.stringify(outputs[name].value));
      return 0;
    }
    const j: Record<string, unknown> = {};
    for (const [k, o] of Object.entries(outputs)) j[k] = { sensitive: Boolean(o.sensitive), type: o.type, value: o.value };
    io.print(...JSON.stringify(j, null, 2).split('\n'));
    return 0;
  }
  if (name) {
    const o = outputs[name];
    if (!o) return outputMissing(io, name);
    if (f.bool.has('raw')) {
      const v = o.value;
      if (typeof v === 'object' && v !== null) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Unsupported value for raw output', detail: `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is ${typeName(v)}.\n\nUse the -json option for machine-readable representations of output values that have complex types.` }], {}));
        return 1;
      }
      io.print(String(v));
      return 0;
    }
    if (o.sensitive) {
      io.print('<sensitive>');
      return 0;
    }
    io.print(...renderValue(o.value));
    return 0;
  }
  if (!Object.keys(outputs).length) {
    io.print(...renderDiags([{ severity: 'warning', summary: 'No outputs found', detail: 'The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform show` command to view the current state.' }], {}));
    return 0;
  }
  io.print(...renderOutputs(outputs));
  return 0;
}

function outputMissing(io: Io, name: string): number {
  io.error(...renderDiags([{ severity: 'error', summary: `Output "${name}" not found`, detail: "The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won't be updated with new output variables until that command is run." }], {}));
  return 1;
}

function showCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['json', 'no-color'], []);
  if (f.unknown.length) flagError(io, 'show', f.unknown[0]);
  const target = f.positional[0];
  if (target) {
    const r = readFile(io.lx, normalizePath(io.cwd, target, `/home/${io.lx.user}`));
    if ('error' in r) {
      io.error(...renderDiags([{ severity: 'error', summary: 'No such file or directory', detail: `File ${target} does not exist.` }], {}));
      return 1;
    }
    let pf: PlanFile | undefined;
    try {
      pf = JSON.parse(r.content);
    } catch {
      pf = undefined;
    }
    if (pf?.format === 'netlab-tfplan') {
      const choice = selectBackend(io);
      const prior = readStateOrFail(io, choice.backend, pf.workspace);
      const env: RunEnv = { ...runEnv(io, pf.workspace, snapshotSource(pf.files)), out: () => undefined };
      const outcome = plan(env, { ...pf.opts, input: false }, prior);
      if (outcome.diags.length || !outcome.run) {
        io.diags(outcome.diags, outcome.sources);
        return 1;
      }
      io.print(...renderPlan(outcome.run, { destroy: pf.opts.mode === 'destroy', refreshOnly: pf.opts.mode === 'refresh-only' }).lines.slice(1));
      record(io, { command: 'show', args, code: 0, dir: io.cwd, workspace: pf.workspace });
      return 0;
    }
    const s = parseState(r.content, target);
    if ('error' in s) {
      io.error(...renderDiags([{ severity: 'error', summary: `Failed to read the given file as a state or plan file`, detail: `State read error: ${s.error}` }], {}));
      return 1;
    }
    printState(io, s, f.bool.has('json'));
    return 0;
  }
  const { state } = currentState(io);
  record(io, { command: 'show', args, code: 0, dir: io.cwd, workspace: currentWorkspace(io.lx, io.cwd, io.env) });
  if (!state || (!state.resources.length && !Object.keys(state.outputs).length)) {
    if (f.bool.has('json')) io.print(JSON.stringify({ format_version: '1.0' }));
    else io.print('No state.');
    return 0;
  }
  printState(io, state, f.bool.has('json'));
  return 0;
}

function printState(io: Io, state: StateFile, json: boolean) {
  const insts = [...flatten(state).values()];
  if (json) {
    const resources = insts.map((i) => ({ address: i.addr, mode: i.mode, type: i.type, name: i.name, ...(i.key !== undefined ? { index: i.key } : {}), provider_name: i.provider.replace(/^provider\["|"\]$/g, ''), schema_version: 0, values: i.attrs, sensitive_values: {} }));
    const outputs = Object.fromEntries(Object.entries(state.outputs).map(([k, o]) => [k, { sensitive: Boolean(o.sensitive), value: o.value, type: o.type }]));
    io.print(JSON.stringify({ format_version: '1.0', terraform_version: TF_VERSION, values: { outputs, root_module: { resources } } }));
    return;
  }
  for (const i of insts) io.print(...renderInstance(i), '');
  if (Object.keys(state.outputs).length) io.print('', 'Outputs:', '', ...renderOutputs(state.outputs));
}

// ---------------------------------------------------------------------------
// state subcommands

function matches(addr: string, pattern: string): boolean {
  return addr === pattern || addr.startsWith(pattern + '[') || addr.startsWith(pattern + '.');
}

function stateCmd(io: Io, args: string[]): number {
  const [sub = '', ...rest] = args;
  const f = parseFlags(rest, ['dry-run', 'lock', 'backup'], ['id', 'state', 'lock-timeout']);
  if (!['list', 'show', 'mv', 'rm', 'pull'].includes(sub)) {
    if (sub === 'push' || sub === 'replace-provider' || sub === 'identities') io.error(`NetLab does not simulate "terraform state ${sub}".`);
    else io.print(...(subHelp(io, 'state') ? [] : []));
    return sub ? 1 : 0;
  }
  if (f.unknown.length) flagError(io, `state ${sub}`, f.unknown[0]);
  const { state, choice, ws } = currentState(io);
  const insts = flatten(state);
  record(io, { command: `state ${sub}`, args: rest, code: 0, dir: io.cwd, workspace: ws });
  switch (sub) {
    case 'list': {
      if (!state) {
        io.error(...renderDiags([{ severity: 'error', summary: 'No state file was found!', detail: 'State management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.' }], {}));
        return 1;
      }
      const addrs = [...insts.values()].filter((i) => (!f.positional.length || f.positional.some((p) => matches(i.addr, p))) && (!f.values.id || i.attrs.id === f.values.id[0])).map((i) => i.addr);
      io.print(...addrs);
      return 0;
    }
    case 'show': {
      const addr = f.positional[0];
      const inst = addr ? insts.get(addr) : undefined;
      if (!inst) {
        if (addr && [...insts.keys()].some((k) => k.startsWith(addr + '['))) {
          io.error(...renderDiags([{ severity: 'error', summary: 'Multiple instances found for the given address', detail: `This command requires that the address references one specific instance. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.` }], {}));
          return 1;
        }
        io.error(`No instance found for the given address!`, '', 'This command requires that the address references one specific instance.', 'To view the available instances, use "terraform state list". Please modify', 'the address to reference a specific instance.');
        return 1;
      }
      io.print(...renderInstance(inst));
      return 0;
    }
    case 'pull':
      if (state) io.print(...stateJson(state).replace(/\n$/, '').split('\n'));
      return 0;
    case 'rm': {
      if (!f.positional.length) {
        io.error('Error: At least one address is required.');
        return 1;
      }
      const unlock = lockOrFail(io, choice.backend, ws, 'OperationTypeInvalid', f.bool.has('no-lock'));
      try {
        let removed = 0;
        for (const p of f.positional) {
          const hits = [...insts.values()].filter((i) => matches(i.addr, p));
          if (!hits.length) {
            io.error(...renderDiags([{ severity: 'error', summary: 'Invalid target address', detail: `No matching objects found. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.` }], {}));
            return 1;
          }
          for (const h of hits) {
            io.print(`${f.bool.has('dry-run') ? 'Would remove' : 'Removed'} ${h.addr}`);
            if (!f.bool.has('dry-run')) insts.delete(h.addr);
            removed++;
          }
        }
        if (!f.bool.has('dry-run')) {
          writeStateOrFail(io, choice.backend, ws, buildState({ ...state!, serial: state!.serial + 1 }, insts, outputsOf(state!)));
          io.print(`Successfully removed ${removed} resource instance(s).`);
        } else io.print(`Would have removed ${removed} items.`);
        return 0;
      } finally {
        unlock();
      }
    }
    case 'mv': {
      const [from, to] = f.positional;
      if (!from || !to) {
        io.error('Exactly two arguments expected.', '', 'Usage: terraform [global options] state mv [options] SOURCE DESTINATION');
        return 1;
      }
      const src = parseAddress(from);
      const dst = parseAddress(to);
      if (!src || !dst) {
        io.error(...renderDiags([{ severity: 'error', summary: 'Invalid address', detail: `Invalid address "${!src ? from : to}".` }], {}));
        return 1;
      }
      const unlock = lockOrFail(io, choice.backend, ws, 'OperationTypeInvalid', f.bool.has('no-lock'));
      try {
        const moves: Array<[string, string]> = [];
        if (src.moduleOnly) {
          for (const i of insts.values()) if (i.module === src.module || i.module.startsWith(src.module + '.')) moves.push([i.addr, dst.module + i.addr.slice(src.module.length)]);
        } else if (src.key === undefined) {
          for (const i of insts.values()) if (i.module === src.module && i.mode === src.mode && i.type === src.type && i.name === src.name) moves.push([i.addr, instanceAddr(dst.module, dst.mode, dst.type, dst.name, dst.key ?? i.key)]);
        } else if (insts.has(from)) moves.push([from, to]);
        if (!moves.length) {
          io.error(...renderDiags([{ severity: 'error', summary: 'Invalid source address', detail: `Cannot move ${from}: does not match anything in the current state.` }], {}));
          return 1;
        }
        for (const [a, b] of moves) {
          const pa = parseAddress(a)!;
          const pb = parseAddress(b)!;
          if (!pa.moduleOnly && !pb.moduleOnly && pa.type !== pb.type) {
            io.error(...renderDiags([{ severity: 'error', summary: 'Invalid state move request', detail: `Cannot move ${a} to ${b}: resource types don't match.` }], {}));
            return 1;
          }
          if (insts.has(b)) {
            io.error(...renderDiags([{ severity: 'error', summary: 'Invalid target address', detail: `Cannot move to ${b}: there is already a resource instance at that address in the current state.\n\nOne common cause of this error is incorrectly-specified count or for_each argument. Ensure that the configured count or for_each argument matches the desired number of instances.` }], {}));
            return 1;
          }
        }
        for (const [a, b] of moves) {
          io.print(`${f.bool.has('dry-run') ? 'Would move' : 'Move'} "${a}" to "${b}"`);
          if (f.bool.has('dry-run')) continue;
          const i = insts.get(a)!;
          const p = parseAddress(b)!;
          insts.delete(a);
          insts.set(b, { ...i, addr: b, module: p.module, type: p.type, name: p.name, key: p.key });
        }
        if (!f.bool.has('dry-run')) {
          writeStateOrFail(io, choice.backend, ws, buildState({ ...state!, serial: state!.serial + 1 }, insts, outputsOf(state!)));
          io.print(`Successfully moved ${moves.length} object(s).`);
        }
        return 0;
      } finally {
        unlock();
      }
    }
  }
  return 0;
}

function outputsOf(state: StateFile): Record<string, { value: Val; sensitive: boolean }> {
  return Object.fromEntries(Object.entries(state.outputs ?? {}).map(([k, o]) => [k, { value: o.value, sensitive: Boolean(o.sensitive) }]));
}

function taintCmd(io: Io, args: string[], taint: boolean): number {
  const f = parseFlags(args, ['allow-missing', 'lock'], ['lock-timeout']);
  const addr = f.positional[0];
  if (!addr) {
    io.error('The taint command expects exactly one argument.');
    return 1;
  }
  const { state, choice, ws } = currentState(io);
  const insts = flatten(state);
  const inst = insts.get(addr);
  if (!inst) {
    io.error(...renderDiags([{ severity: 'error', summary: 'No such resource instance', detail: `There is no resource instance in the state with the address ${addr}. If the resource configuration has just been added, you must run "terraform apply" first to create the object before using ${taint ? 'taint' : 'untaint'}.` }], {}));
    return 1;
  }
  if (!taint && inst.status !== 'tainted') {
    io.error(...renderDiags([{ severity: 'error', summary: 'Resource instance is not tainted', detail: `Resource instance ${addr} is not currently tainted, and so it cannot be untainted.` }], {}));
    return 1;
  }
  insts.set(addr, { ...inst, status: taint ? 'tainted' : undefined });
  writeStateOrFail(io, choice.backend, ws, buildState({ ...state!, serial: state!.serial + 1 }, insts, outputsOf(state!)));
  io.print(taint ? `Resource instance ${addr} has been marked as tainted.` : `Resource instance ${addr} has been successfully untainted.`);
  record(io, { command: taint ? 'taint' : 'untaint', args, code: 0, dir: io.cwd, workspace: ws });
  return 0;
}

// ---------------------------------------------------------------------------
// import

function importCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['input', 'lock', 'no-color'], ['var', 'var-file', 'lock-timeout']);
  if (f.unknown.length) flagError(io, 'import', f.unknown[0]);
  const [addr, id] = f.positional;
  if (!addr || !id) {
    io.error('The import command expects two arguments.', 'Usage: terraform [global options] import [options] ADDR ID');
    return 1;
  }
  const p = parseAddress(addr);
  if (!p || p.moduleOnly || p.mode !== 'managed') {
    io.error(...renderDiags([{ severity: 'error', summary: 'Invalid address', detail: `"${addr}" is not a valid resource instance address.` }], {}));
    return 1;
  }
  const pc = contextOrRecord(io, f, 'normal', 'OperationTypeImport', 'import', args);
  const rec: Recorded = { command: 'import', args, code: 1, dir: io.cwd, workspace: pc.ws };
  try {
    const outcome = prepareRun(pc.env, pc.opts, pc.prior);
    if (outcome.diags.length || !outcome.run) {
      io.diags(outcome.diags, outcome.sources);
      record(io, rec);
      return 1;
    }
    const run = outcome.run;
    const tree = allTrees(run.tree).find((t) => t.key === p.module);
    const rc = tree?.config.resources[`${p.type}.${p.name}`];
    if (!tree || !rc) {
      io.error(...renderDiags([{ severity: 'error', summary: `resource address "${addr}" does not exist in the configuration.`, detail: `Before importing this resource, please create its configuration in ${p.module || 'the root module'}. For example:\n\nresource "${p.type}" "${p.name}" {\n  # (resource arguments)\n}` }], {}));
      record(io, rec);
      return 1;
    }
    if ((rc.count || rc.forEach) && p.key === undefined) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Index value required', detail: `This resource uses ${rc.count ? 'count' : 'for_each'}, so the address must include an instance key, like ${addr}[${rc.count ? '0' : '"name"'}].` }], {}));
      record(io, rec);
      return 1;
    }
    if (run.insts.has(addr)) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Resource already managed by Terraform', detail: `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.` }], {}));
      record(io, rec);
      return 1;
    }
    const ctx = getProvider(run, tree, rc, addr);
    const source = tree.config.requiredProviders[rc.provider.name]?.source ?? run.tree.config.requiredProviders[rc.provider.name]?.source ?? `hashicorp/${rc.provider.name}`;
    const def = PROVIDERS[source] ?? providerFor(source)!;
    const rdef = def.resources(ctx.version)[p.type];
    if (!rdef?.import) {
      io.error(...renderDiags([{ severity: 'error', summary: `resource ${p.type} doesn't support import`, detail: '' }], {}));
      record(io, rec);
      return 1;
    }
    io.print(`${addr}: Importing from ID "${id}"...`, `${addr}: Import prepared!`, `  Prepared ${p.type} for import`, `${addr}: Refreshing state... [id=${id}]`);
    const got = rdef.import(id, ctx);
    if (!got) {
      io.error(...renderDiags([{ severity: 'error', summary: 'Cannot import non-existent remote object', detail: `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.` }], {}));
      record(io, rec);
      return 1;
    }
    const insts = new Map(run.insts);
    const inst: Inst = { addr, module: p.module, mode: 'managed', type: p.type, name: p.name, key: p.key, provider: providerAddr(source) + (rc.provider.alias ? `.${rc.provider.alias}` : ''), attrs: got, deps: [], sensitive: Object.entries(rdef.attrs).filter(([, d]) => d.sensitive).map(([k]) => k) };
    insts.set(addr, inst);
    const base = pc.prior ?? run.prior;
    writeStateOrFail(io, pc.choice.backend, pc.ws, buildState({ ...base, serial: base.serial + 1 }, insts, pc.prior ? outputsOf(pc.prior) : {}));
    io.print('', 'Import successful!', '', 'The resources that were imported are shown above. These resources are now in', 'your Terraform state and will henceforth be managed by Terraform.', '');
    record(io, { ...rec, code: 0, imported: 1 });
    return 0;
  } finally {
    pc.unlock();
  }
}

// ---------------------------------------------------------------------------
// workspaces and locks

function workspaceCmd(io: Io, args: string[]): number {
  const [sub = '', ...rest] = args;
  const f = parseFlags(rest, ['force', 'or-create', 'lock'], ['state', 'lock-timeout']);
  const choice = selectBackend(io);
  const b = choice.backend;
  const current = currentWorkspace(io.lx, io.cwd, io.env);
  record(io, { command: `workspace ${sub}`, args: rest, code: 0, dir: io.cwd, workspace: current });
  const notSupported = () => {
    io.error(...renderDiags([{ severity: 'error', summary: 'Workspaces not supported', detail: choice.type === 'cloud' ? 'The cloud block names a single workspace, so there is only one. Use workspaces { tags = [...] } to work with several.' : `The "${choice.type}" backend does not support workspaces.` }], {}));
    return 1;
  };
  switch (sub) {
    case 'show':
      io.print(current);
      return 0;
    case 'list': {
      const names = b.workspaces();
      if (!names.includes(current) && b.supportsWorkspaces && choice.type !== 'cloud') names.push(current);
      io.print(...names.map((n) => `${n === current ? '*' : ' '} ${n}`), '');
      return 0;
    }
    case 'new': {
      const name = f.positional[0];
      if (!name) {
        io.error('Expected a single argument: NAME.');
        return 1;
      }
      if (!b.supportsWorkspaces) return notSupported();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        io.error(`The workspace name "${name}" is not allowed. The name must contain only URL safe`, 'characters, and no path separators.');
        return 1;
      }
      if (b.workspaces().includes(name)) {
        io.error(`Workspace "${name}" already exists`);
        return 1;
      }
      const e = b.createWorkspace(name);
      if (e) {
        io.error(e);
        return 1;
      }
      selectWorkspace(io.lx, io.cwd, name);
      io.print(`Created and switched to workspace "${name}"!`, '', "You're now on a new, empty workspace. Workspaces isolate their state,", 'so if you run "terraform plan" Terraform will not see any existing state', 'for this configuration.');
      return 0;
    }
    case 'select': {
      const name = f.positional[0];
      if (!name) {
        io.error('Expected a single argument: NAME.');
        return 1;
      }
      if (!b.workspaces().includes(name)) {
        if (f.bool.has('or-create') && b.supportsWorkspaces) {
          b.createWorkspace(name);
          selectWorkspace(io.lx, io.cwd, name);
          io.print(`Created and switched to workspace "${name}"!`);
          return 0;
        }
        io.error('', `Workspace "${name}" doesn't exist.`, '', 'You can create this workspace with the "new" subcommand', 'or include the "-or-create" flag with the "select" subcommand.');
        return 1;
      }
      selectWorkspace(io.lx, io.cwd, name);
      io.print(`Switched to workspace "${name}".`);
      return 0;
    }
    case 'delete': {
      const name = f.positional[0];
      if (!name) {
        io.error('Expected a single argument: NAME.');
        return 1;
      }
      if (!b.supportsWorkspaces) return notSupported();
      if (name === 'default') {
        io.error(`Can't delete default state`);
        return 1;
      }
      if (!b.workspaces().includes(name)) {
        io.error(`Workspace "${name}" doesn't exist.`);
        return 1;
      }
      if (name === current) {
        io.error(`Workspace "${name}" is your active workspace.`, '', 'You cannot delete the currently active workspace. Please switch', 'to another workspace and try again.');
        return 1;
      }
      const s = b.read(name);
      const live = s && !('error' in s) ? [...flatten(s).values()].filter((i) => i.mode === 'managed') : [];
      if (live.length && !f.bool.has('force')) {
        io.error(`Workspace "${name}" is currently tracking the following resource instances:`, ...live.map((i) => `  - ${i.addr}`), '', 'Deleting this workspace would cause Terraform to lose track of any associated', 'remote objects, which would then require you to delete them manually outside', 'of Terraform. You should destroy these objects with Terraform before deleting', 'the workspace.', '', 'If you want to delete this workspace anyway, and have Terraform forget about', 'these managed objects, use the -force option to disable this safety check.');
        return 1;
      }
      b.deleteWorkspace(name);
      io.print(`Deleted workspace "${name}"!`);
      return 0;
    }
    default:
      subHelp(io, 'workspace');
      return sub ? 1 : 0;
  }
}

function forceUnlockCmd(io: Io, args: string[]): number {
  const f = parseFlags(args, ['force'], []);
  const id = f.positional[0];
  if (!id) {
    io.error('Expected a single argument: LOCK_ID');
    return 1;
  }
  const choice = selectBackend(io);
  const ws = currentWorkspace(io.lx, io.cwd, io.env);
  if (choice.type === 'local') {
    io.error(...renderDiags([{ severity: 'error', summary: 'Local state cannot be unlocked by another process', detail: '' }], {}));
    return 1;
  }
  if (!f.bool.has('force')) {
    const a = io.ask(['Do you really want to force-unlock?', '  Terraform will remove the lock on the remote state.', '  This will allow local Terraform commands to modify this state, even though it', "  may still be in use. Only 'yes' will be accepted to confirm.", '']);
    if (a !== 'yes') {
      io.print('force-unlock cancelled.');
      return 1;
    }
  }
  const r = choice.backend.unlock(ws, id);
  record(io, { command: 'force-unlock', args, code: r === 'ok' ? 0 : 1, dir: io.cwd, workspace: ws });
  if (r === 'ok') {
    io.print('Terraform state has been successfully unlocked!', '', 'The state has been unlocked, and Terraform commands should now be able to', 'obtain a new lock on the remote state.');
    return 0;
  }
  const why = r === 'mismatch' ? `lock ID "${id}" does not match existing lock` : r === 'none' ? 'no lock to release' : 'this backend does not support unlocking';
  io.error(...renderDiags([{ severity: 'error', summary: 'Failed to unlock state', detail: `Failed to unlock state: ${why}` }], {}));
  return 1;
}

// ---------------------------------------------------------------------------
// login, logout

function credentialsPath(io: Io): string {
  return `/home/${io.lx.user}/.terraform.d/credentials.tfrc.json`;
}

function loginCmd(io: Io, args: string[]): number {
  const host = args.find((a) => !a.startsWith('-')) ?? 'app.terraform.io';
  const org = io.lx.cloud?.hcp;
  if (!org || org.hostname !== host) {
    io.error(...renderDiags([{ severity: 'error', summary: 'Service discovery failed for ' + host, detail: `Failed to request discovery document: Get "https://${host}/.well-known/terraform.json": dial tcp: lookup ${host}: no such host.` }], {}));
    return 1;
  }
  const path = credentialsPath(io);
  const proceed = io.ask([`Terraform will request an API token for ${host} using your browser.`, '', 'If login is successful, Terraform will store the token in plain text in', 'the following file for use by subsequent commands:', `    ${path}`, '', 'Do you want to proceed?', "  Only 'yes' will be accepted to confirm.", '']);
  if (proceed !== 'yes') {
    io.error(...renderDiags([{ severity: 'error', summary: 'Login cancelled', detail: '' }], {}));
    return 1;
  }
  const token = io.ask(
    ['', '---------------------------------------------------------------------------------', '', `Terraform must now open a web browser to the tokens page for ${host}.`, '', 'If a browser does not open this automatically, open the following URL to proceed:', `    https://${host}/app/settings/tokens?source=terraform-login`, '', '', '---------------------------------------------------------------------------------', '', 'Generate a token using your browser, and copy-paste it into this prompt.', '', 'Terraform will store the token in plain text in the following file', 'for use by subsequent commands:', `    ${path}`, '', `Token for ${host}:`],
    '  Enter a value: ',
    true,
  );
  if (token.trim() !== org.token) {
    io.error(...renderDiags([{ severity: 'error', summary: `Token is invalid: unauthorized`, detail: '' }], {}));
    record(io, { command: 'login', args, code: 1, dir: io.cwd, workspace: 'default' });
    return 1;
  }
  const dir = `/home/${io.lx.user}/.terraform.d`;
  if (!getNode(io.lx, dir)) makeDir(io.lx, dir, true);
  writeFile(io.lx, path, JSON.stringify({ credentials: { [host]: { token: token.trim() } } }, null, 2) + '\n', false, 'terraform');
  const node = getNode(io.lx, path);
  if (node) node.mode = 0o600;
  io.print('', `Retrieved token for user ${io.lx.user}`, '', '', '---------------------------------------------------------------------------------', '', '   Welcome to HCP Terraform!', '', '   Documentation: terraform.io/docs/cloud', '');
  record(io, { command: 'login', args, code: 0, dir: io.cwd, workspace: 'default' });
  return 0;
}

function logoutCmd(io: Io, args: string[]): number {
  const host = args.find((a) => !a.startsWith('-')) ?? 'app.terraform.io';
  const path = credentialsPath(io);
  if (!getNode(io.lx, path)) {
    io.print(`No credentials for ${host} are stored.`);
    return 0;
  }
  removeNode(io.lx, path, false);
  io.print(`Removing the stored credentials for ${host} from the following file:`, `    ${path}`, '', `Success! Terraform has removed the stored API token for ${host}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// console

function consoleCmd(io: Io): number {
  selectBackend(io);
  return 0;
}

function consoleLine(lx: LinuxState, pending: TfPending, line: string): TfResult {
  const text = line.trim();
  if (text === 'exit' || text === 'exit()') return { out: [], err: [], code: 0 };
  const keep = { ...pending };
  if (!text) return { out: [], err: [], code: 0, pending: keep };
  const io = new Io(lx, pending.cwd, pending.env, ['console'], [], '');
  try {
    const choice = selectBackend(io);
    const ws = currentWorkspace(lx, pending.cwd, pending.env);
    const state = readStateOrFail(io, choice.backend, ws);
    const s = stateScope(runEnv(io, ws), state);
    if (!s.scope) {
      io.diags(s.diags);
      return { out: io.out, err: io.err, code: 1, pending: keep };
    }
    const expr = parseExpression(text);
    const marks = { sensitive: false, ephemeral: false };
    const v = evaluate(expr, s.scope, marks);
    io.print(...(marks.sensitive ? ['(sensitive value)'] : renderValue(v)));
  } catch (e) {
    if (e instanceof DiagError) io.error(...renderDiags(e.diags, { '<console-input>': text }));
    else if (e instanceof Exit) {
      /* already reported */
    } else throw e;
  }
  return { out: io.out, err: io.err, code: 0, pending: keep };
}

/** Wrap terraformCommand so that `terraform console` opens an interactive session. */
export function runTerraform(lx: LinuxState, args: string[], env: Record<string, string>, cwd: string, stdin = ''): TfResult {
  if (args[0] === 'console' || (args[0]?.startsWith('-chdir') && args.includes('console'))) {
    const io = new Io(lx, cwd, env, args, [], '');
    try {
      selectBackend(io);
    } catch (e) {
      if (e instanceof Exit) return { out: io.out, err: io.err, code: 1 };
      throw e;
    }
    record(io, { command: 'console', args: args.slice(1), code: 0, dir: cwd, workspace: currentWorkspace(lx, cwd, env) });
    if (stdin) {
      const lines = stdin.replace(/\n$/, '').split('\n');
      const out: string[] = [];
      const err: string[] = [];
      const pending: TfPending = { kind: 'terraform', argv: args, cwd, env: { ...env }, answers: [], printed: 0, prompt: '> ', console: true };
      for (const l of lines) {
        const r = consoleLine(lx, pending, l);
        out.push(...r.out);
        err.push(...r.err);
      }
      return { out, err, code: 0 };
    }
    return { out: [], err: [], code: 0, pending: { kind: 'terraform', argv: args, cwd, env: { ...env }, answers: [], printed: 0, prompt: '> ', console: true } };
  }
  return terraformCommand(lx, args, env, cwd, [], stdin);
}

export type { CloudAccount };
