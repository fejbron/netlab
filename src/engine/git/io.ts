/**
 * What every git subcommand shares: where output goes, how arguments are read,
 * and how the lab clock turns into a date.
 */
import type { NetworkState } from '../network';
import type { LinuxState } from '../linux/fs';

export interface GitEnv {
  lx: LinuxState;
  network: NetworkState;
  node: string;
  cwd: string;
  env: Record<string, string>;
  /**
   * Run shell source in a directory, for the commands that call out to one. It is
   * passed in by the shell itself: importing the shell here would close a cycle,
   * because the shell imports every command, git included.
   */
  run?: (text: string, cwd: string) => { out: string[]; err: string[]; code: number };
}

/** The lab clock counts from a fixed point, so dates in the log look like dates. */
export const EPOCH = 1790000000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(when: number): string {
  const d = new Date((EPOCH + when) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

/** The date `git format-patch` writes into a patch header. */
export function rfcDate(when: number): string {
  const d = new Date((EPOCH + when) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

export class Io {
  out: string[] = [];
  err: string[] = [];
  code = 0;
  print(...lines: string[]) {
    this.out.push(...lines);
  }
  fail(code: number, ...lines: string[]) {
    this.err.push(...lines);
    this.code = code;
  }
}

export interface Flags {
  bool: Set<string>;
  values: Record<string, string>;
  rest: string[];
  /** Everything after a literal `--`, which is always paths. */
  paths: string[];
}

export const VALUE_FLAGS = new Set(['m', 'message', 'b', 'c', 'C', 'n', 'max-count', 'author', 'grep', 'set-upstream-to', 'onto', 'git-dir', 'source', 'o', 'output', 'prefix', 'format', 'branch', 'depth', 'X', 'strategy-option', 'B', 'orphan', 'contains', 'merged', 'no-merged', 'term-old', 'term-new', 'index-filter', 'tree-filter', 'msg-filter', 'reference', 'origin', 'match', 'abbrev', 'since', 'until', 'upload-pack']);

export function parseFlags(args: string[], valueFlags = VALUE_FLAGS): Flags {
  const f: Flags = { bool: new Set(), values: {}, rest: [], paths: [] };
  let afterDashDash = false;
  // A value flag takes the next argument unless that argument is itself a flag.
  const takes = (next: string | undefined) => next !== undefined && (next === '-' || !next.startsWith('-'));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (afterDashDash) {
      f.paths.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) f.values[body.slice(0, eq)] = body.slice(eq + 1);
      else if (valueFlags.has(body) && takes(args[i + 1])) f.values[body] = args[++i];
      else f.bool.add(body);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const letters = arg.slice(1);
      // `git log -3` is `git log -n 3`.
      if (/^\d+$/.test(letters)) {
        f.values.n = letters;
        continue;
      }
      // -m"text" and -mtext both appear in the wild.
      if (valueFlags.has(letters[0]) && letters.length > 1 && !/^[a-zA-Z]+$/.test(letters.slice(1))) {
        f.values[letters[0]] = letters.slice(1);
        continue;
      }
      for (let k = 0; k < letters.length; k++) {
        const letter = letters[k];
        if (valueFlags.has(letter) && k === letters.length - 1 && takes(args[i + 1])) f.values[letter] = args[++i];
        else f.bool.add(letter);
      }
      continue;
    }
    f.rest.push(arg);
  }
  return f;
}

export function message(f: Flags): string | undefined {
  return f.values.m ?? f.values.message;
}

export function has(f: Flags, ...names: string[]): boolean {
  return names.some((n) => f.bool.has(n));
}
