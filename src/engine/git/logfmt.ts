/**
 * The parts of `git log` that shape its output: the lanes `--graph` draws, the
 * placeholders `--format` expands, and the preset `--pretty` styles.
 */
import { readCommit, type Repo } from './repo';
import type { Commit, Oid } from './objects';
import { decorations } from './common';
import { shortId } from './revs';
import { formatDate } from './io';

/** Everything up to the first blank line of a message. */
function subject(message: string): string {
  return message.split('\n\n')[0].replace(/\n/g, ' ').trim();
}

function body(message: string): string {
  const at = message.indexOf('\n\n');
  return at < 0 ? '' : message.slice(at + 2).replace(/\n$/, '');
}

/** "3 minutes ago", measured against the lab clock. */
export function relativeDate(when: number, now: number): string {
  const s = Math.max(0, now - when);
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return `${s} second${s === 1 ? '' : 's'} ago`;
}

/** Expand one `--format` string for one commit. Colours are accepted and dropped. */
export function expandFormat(repo: Repo, oid: Oid, commit: Commit, format: string): string {
  const now = repo.lx.clock;
  const person = (who: 'a' | 'c', key: string): string | null => {
    const p = who === 'a' ? commit.author : commit.committer;
    switch (key) {
      case 'n': return p.name;
      case 'e': return p.email;
      case 'd': case 'D': return formatDate(p.when);
      case 'r': return relativeDate(p.when, now);
      case 't': return String(p.when);
      case 's': return formatDate(p.when).split(' ').slice(0, 3).join(' ');
      default: return null;
    }
  };
  const simple: Record<string, () => string> = {
    H: () => oid,
    h: () => shortId(repo, oid),
    T: () => commit.tree,
    t: () => shortId(repo, commit.tree),
    P: () => commit.parents.join(' '),
    p: () => commit.parents.map((p) => shortId(repo, p)).join(' '),
    s: () => subject(commit.message),
    b: () => body(commit.message),
    B: () => commit.message.replace(/\n$/, ''),
    d: () => decorations(repo, oid),
    D: () => decorations(repo, oid).replace(/^ \(|\)$/g, ''),
  };
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const next = format[i + 1];
    if (next === '%') { out += '%'; i += 1; continue; }
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 'C') {
      // %C(red), %Cred, %Cgreen, %Cblue, %Creset: colour only, so nothing to print.
      const m = /^C\([^)]*\)/.exec(format.slice(i + 1)) ?? /^C(red|green|blue|reset)/.exec(format.slice(i + 1));
      if (m) { i += m[0].length; continue; }
    }
    if ((next === 'a' || next === 'c') && i + 2 < format.length) {
      const value = person(next, format[i + 2]);
      if (value !== null) { out += value; i += 2; continue; }
    }
    if (next && simple[next]) { out += simple[next](); i += 1; continue; }
    out += ch;
  }
  return out;
}

/**
 * The lines one commit prints under `--pretty=<style>` (or `--format`). Returns null
 * for the default medium style, which the caller already knows how to print.
 */
export function prettyLines(repo: Repo, oid: Oid, pretty: string | undefined): string[] | null {
  if (!pretty || pretty === 'medium') return null;
  const commit = readCommit(repo, oid)!;
  const custom = /^t?format:([\s\S]*)$/.exec(pretty);
  if (custom) return expandFormat(repo, oid, commit, custom[1]).split('\n');
  const msg = commit.message.replace(/\n$/, '').split('\n').map((l) => `    ${l}`);
  const merge = commit.parents.length > 1 ? [`Merge: ${commit.parents.map((p) => shortId(repo, p)).join(' ')}`] : [];
  const who = (label: string, p: Commit['author']) => `${label}${p.name} <${p.email}>`;
  switch (pretty) {
    case 'oneline':
      return [`${oid}${decorations(repo, oid)} ${subject(commit.message)}`];
    case 'short':
      return [`commit ${oid}${decorations(repo, oid)}`, ...merge, who('Author: ', commit.author), '', `    ${subject(commit.message)}`, ''];
    case 'full':
      return [`commit ${oid}${decorations(repo, oid)}`, ...merge, who('Author: ', commit.author), who('Commit: ', commit.committer), '', ...msg, ''];
    case 'fuller':
      return [
        `commit ${oid}${decorations(repo, oid)}`,
        ...merge,
        who('Author:     ', commit.author),
        `AuthorDate: ${formatDate(commit.author.when)}`,
        who('Commit:     ', commit.committer),
        `CommitDate: ${formatDate(commit.committer.when)}`,
        '',
        ...msg,
        '',
      ];
    case 'raw':
      return [
        `commit ${oid}`,
        `tree ${commit.tree}`,
        ...commit.parents.map((p) => `parent ${p}`),
        `author ${commit.author.name} <${commit.author.email}> ${commit.author.when} +0000`,
        `committer ${commit.committer.name} <${commit.committer.email}> ${commit.committer.when} +0000`,
        '',
        ...msg,
        '',
      ];
    default:
      // Anything else is a format string without the prefix, as git allows.
      return expandFormat(repo, oid, commit, pretty).split('\n');
  }
}

/**
 * Draws the lanes of `--graph`. Each column holds the commit that lane is waiting
 * for; a commit takes its lane, its first parent inherits it, and further parents
 * open new lanes to the right. Lanes that end up waiting for the same commit fold
 * back together.
 */
export class Graph {
  private lanes: (Oid | null)[] = [];

  constructor(private readonly repo: Repo, private readonly firstParent = false) {}

  private static bars(count: number): string {
    return Array.from({ length: count }, () => '|').join(' ');
  }

  /** Lines for one commit: its row, then its remaining text beside the lanes. */
  row(oid: Oid, text: string[]): string[] {
    let col = this.lanes.indexOf(oid);
    if (col < 0) {
      col = this.lanes.indexOf(null);
      if (col < 0) col = this.lanes.push(oid) - 1;
      else this.lanes[col] = oid;
    }
    const commit = readCommit(this.repo, oid);
    const parents = (this.firstParent ? commit?.parents.slice(0, 1) : commit?.parents) ?? [];
    const out: string[] = [];
    const [first = '', ...rest] = text;

    // The lanes after this commit: its first parent takes its place, and each
    // further parent opens a lane just to its right.
    const next = [...this.lanes];
    next[col] = parents[0] ?? null;
    let opened = 0;
    for (const p of parents.slice(1)) {
      if (next.includes(p)) continue;
      next.splice(col + 1 + opened, 0, p);
      opened++;
    }
    const star = this.lanes.map((_, i) => (i === col ? '*' : '|')).join(' ');
    out.push(`${star}${'  '.repeat(opened)} ${first}`.trimEnd());
    if (opened) {
      // The new lane branches off on the line under the merge; lanes to its right shift over.
      const width = next.length * 2 - 1;
      const branch = this.lanes.map((_, i) => (i < col ? '|' : i === col ? '|' + '\\'.repeat(opened) : '\\')).join(' ').padEnd(width);
      const [second, ...others] = rest;
      out.push(second === undefined ? branch.trimEnd() : `${branch} ${second}`.trimEnd());
      for (const line of others) out.push(`${Graph.bars(next.length)} ${line}`.trimEnd());
    } else {
      for (const line of rest) out.push(`${Graph.bars(Math.max(1, next.length))} ${line}`.trimEnd());
    }
    this.lanes = next;

    // Lanes waiting for the same commit meet: the right-hand one folds in.
    for (let i = this.lanes.length - 1; i > 0; i--) {
      const target = this.lanes[i];
      if (!target) continue;
      const earlier = this.lanes.indexOf(target);
      if (earlier < i) {
        out.push(`${Graph.bars(i)}/`.replace(/\| \/$/, '|/'));
        this.lanes.splice(i, 1);
      }
    }
    // A lane whose history ended closes; the rest shift left.
    for (let i = this.lanes.length - 1; i >= 0; i--) {
      if (this.lanes[i] !== null) continue;
      if (i < this.lanes.length - 1) out.push(`${Graph.bars(i)}${i ? ' ' : ''}${this.lanes.slice(i + 1).map(() => '/').join(' ')}`);
      this.lanes.splice(i, 1);
    }
    return out;
  }
}
