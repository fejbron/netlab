/**
 * Entry points for the simulated Linux hosts: one line typed at the prompt in, output
 * lines out. Multi-line commands (heredocs, loops) and passwd prompts keep a pending
 * state on the host so the terminal can show a continuation or masked prompt.
 */
import type { HostState, NetworkState } from '../network';
import { findUser, homeOf, writeFile, type LinuxState } from './fs';
import { runLine, type PendingPython } from './shell';

export type { LinuxState, LinuxSpec, FsNode, LinuxUser, LinuxGroup, LinuxService, LinuxProcess, PythonRun } from './fs';
export { createLinuxState, normalizePath, listDir, getNode, readFile, modeString, octal } from './fs';
export type { PendingPython, CmdResult } from './shell';
export { Shell, runLine, globToRegex } from './shell';
export { COMMANDS as LINUX_COMMANDS, LINUX_COMMAND_NAMES } from './commands';
export { serveHttp, testNginx, loadNginx, makeCertificate, makePrivateKey, parseCertificate, resolveName } from './web';
export type { HttpRequest, HttpResponse, WebRequestRecord } from './web';

export interface LinuxExecResult {
  network: NetworkState;
  output: string[];
  /** The shell wants python3 to run; the UI executes it and calls applyPythonResult. */
  pending?: PendingPython;
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Text files the script created or changed, by absolute path. */
  files: Record<string, string>;
}

function shortCwd(lx: LinuxState): string {
  const home = homeOf(lx);
  if (lx.cwd === home) return '~';
  if (lx.cwd.startsWith(home + '/')) return '~' + lx.cwd.slice(home.length);
  return lx.cwd;
}

export function linuxPrompt(host: HostState): string {
  const lx = host.linux!;
  if (lx.pending?.kind === 'password') return lx.pending.stage === 'new' ? 'New password: ' : 'Retype new password: ';
  if (lx.pending?.kind === 'script') return '> ';
  return `${lx.user}@${lx.hostname}:${shortCwd(lx)}${lx.user === 'root' ? '#' : '$'} `;
}

/** True while the host expects a password rather than a command (terminal should mask input). */
export function linuxMaskedInput(host: HostState): boolean {
  return host.linux?.pending?.kind === 'password';
}

const MAX_OUTPUT_MEMORY = 600;

function remember(lx: LinuxState, lines: string[]) {
  lx.outputs.push(...lines);
  if (lx.outputs.length > MAX_OUTPUT_MEMORY) lx.outputs.splice(0, lx.outputs.length - MAX_OUTPUT_MEMORY);
}

function handlePassword(lx: LinuxState, line: string): string[] {
  const p = lx.pending!;
  if (p.kind !== 'password') return [];
  if (p.stage === 'new') {
    lx.pending = { kind: 'password', user: p.user, stage: 'retype', first: line };
    return [];
  }
  lx.pending = undefined;
  if (line !== p.first) return ['Sorry, passwords do not match.', 'passwd: Authentication token manipulation error', 'passwd: password unchanged'];
  if (line.length < 6 && lx.user !== 'root') return ['Bad: new password is too simple', 'passwd: Authentication token manipulation error', 'passwd: password unchanged'];
  const u = findUser(lx, p.user);
  if (u) {
    u.password = line;
    u.locked = false;
  }
  return ['passwd: password updated successfully'];
}

/** Execute one line typed at a Linux host. Returns a new network; the input is never mutated. */
export function executeLinux(prev: NetworkState, hostId: string, rawLine: string): LinuxExecResult {
  const network = structuredClone(prev);
  const h = network.hosts[hostId];
  const lx = h?.linux;
  if (!h || !lx) throw new Error(`No Linux host "${hostId}" in network`);
  if (lx.pending?.kind === 'password') {
    const output = handlePassword(lx, rawLine);
    remember(lx, output);
    return { network, output };
  }
  const line = rawLine.replace(/\s+$/, '');
  if (lx.pending?.kind === 'script') {
    const text = lx.pending.text + '\n' + line;
    lx.pending = undefined;
    return finish(network, h, lx, text, line);
  }
  if (!line.trim()) return { network, output: [] };
  h.commandHistory.push(line.trim());
  lx.history.push(line.trim());
  if (lx.history.length > 500) lx.history.shift();
  return finish(network, h, lx, line, line);
}

function finish(network: NetworkState, h: HostState, lx: LinuxState, text: string, line: string): LinuxExecResult {
  const r = runLine({ state: lx, network, hostId: h.id }, text);
  if ('incomplete' in r) {
    lx.pending = { kind: 'script', text };
    return { network, output: [] };
  }
  const output = [...r.out, ...r.err];
  remember(lx, output);
  void line;
  return r.pending ? { network, output, pending: r.pending } : { network, output };
}

/** Fold the result of an asynchronous python3 run back into the network. */
export function applyPythonResult(prev: NetworkState, hostId: string, pending: PendingPython, result: PythonResult): LinuxExecResult {
  const network = structuredClone(prev);
  const h = network.hosts[hostId];
  const lx = h?.linux;
  if (!h || !lx) throw new Error(`No Linux host "${hostId}" in network`);
  const savedUser = lx.user;
  lx.user = pending.user;
  const output: string[] = [];
  try {
    const home = homeOf(lx, pending.user);
    for (const [path, content] of Object.entries(result.files)) {
      if (pending.files[path] === content) continue;
      if (!(path.startsWith(home + '/') || path.startsWith(pending.cwd + '/') || path.startsWith('/tmp/'))) continue;
      const e = writeFile(lx, path, content, false, 'python3');
      if (e) output.push(e.error);
    }
    const stdout = result.stdout.replace(/\n$/, '');
    if (pending.redirect) {
      const e = writeFile(lx, pending.redirect.path, result.stdout, pending.redirect.append, 'bash');
      if (e) output.push(e.error);
    } else if (stdout !== '' || result.stdout.length) output.push(...(stdout === '' ? [] : stdout.split('\n')));
    if (result.stderr) output.push(...result.stderr.replace(/\n$/, '').split('\n'));
  } finally {
    lx.user = savedUser;
  }
  lx.pythonRuns.push({ file: pending.argv[0] === '-c' ? undefined : pending.argv[0], stdout: result.stdout, exitCode: result.exitCode });
  lx.lastExit = result.exitCode;
  remember(lx, output);
  return { network, output };
}
