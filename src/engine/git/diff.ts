/**
 * Line diffing, unified output, and the three-way merge that both `git merge` and
 * `git rebase` use. The diff is a plain longest-common-subsequence over lines,
 * which produces the same hunks as git for the ordinary edits a lab makes.
 */

export interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { kind: ' ' | '-' | '+'; text: string };

/** Longest common subsequence over lines, as a list of keep/remove/add operations. */
export function diffLines(before: string[], after: string[], key: (line: string) => string = (l) => l): Op[] {
  const n = before.length;
  const m = after.length;
  const bk = before.map(key);
  const ak = after.map(key);
  // table[i][j] = length of the LCS of before[i:] and after[j:]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = bk[i] === ak[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (bk[i] === ak[j]) {
      ops.push({ kind: ' ', text: after[j] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: '-', text: before[i] });
      i++;
    } else {
      ops.push({ kind: '+', text: after[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', text: before[i++] });
  while (j < m) ops.push({ kind: '+', text: after[j++] });
  return ops;
}

/** Group the operations into hunks with `context` unchanged lines around each change. */
export function hunks(before: string[], after: string[], context = 3, key?: (line: string) => string): Hunk[] {
  const ops = diffLines(before, after, key);
  const changed = ops.map((o) => o.kind !== ' ');
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  }
  const out: Hunk[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].kind !== '+') beforeLine++;
      if (ops[i].kind !== '-') afterLine++;
      i++;
      continue;
    }
    const hunk: Hunk = { beforeStart: beforeLine, beforeCount: 0, afterStart: afterLine, afterCount: 0, lines: [] };
    while (i < ops.length && keep[i]) {
      const op = ops[i];
      hunk.lines.push(op.kind + op.text);
      if (op.kind !== '+') {
        hunk.beforeCount++;
        beforeLine++;
      }
      if (op.kind !== '-') {
        hunk.afterCount++;
        afterLine++;
      }
      i++;
    }
    out.push(hunk);
  }
  return out;
}

export interface DiffFile {
  path: string;
  /** Null when the file is being created or deleted. */
  before: string | null;
  after: string | null;
  oldMode?: string;
  newMode?: string;
  oldOid?: string;
  newOid?: string;
}

/** A unified diff for one file, in git's own layout. */
export function unifiedDiff(file: DiffFile, context = 3, opts: { ignoreSpace?: boolean } = {}): string[] {
  if (file.oldMode === '160000' || file.newMode === '160000') {
    file = { ...file, before: file.oldOid && file.oldMode === '160000' ? `Subproject commit ${file.oldOid}\n` : file.before, after: file.newOid && file.newMode === '160000' ? `Subproject commit ${file.newOid}\n` : file.after };
  }
  const before = splitLines(file.before ?? '');
  const after = splitLines(file.after ?? '');
  if (file.before === file.after && file.oldMode === file.newMode) return [];
  const a = file.before === null ? '/dev/null' : `a/${file.path}`;
  const b = file.after === null ? '/dev/null' : `b/${file.path}`;
  const out = [`diff --git a/${file.path} b/${file.path}`];
  if (file.before === null) out.push(`new file mode ${file.newMode ?? '100644'}`);
  else if (file.after === null) out.push(`deleted file mode ${file.oldMode ?? '100644'}`);
  else if (file.oldMode && file.newMode && file.oldMode !== file.newMode) out.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`);
  if (file.oldOid && file.newOid) out.push(`index ${file.oldOid.slice(0, 7)}..${file.newOid.slice(0, 7)}${file.oldMode === file.newMode ? ` ${file.newMode}` : ''}`);
  const parts = hunks(before, after, context, opts.ignoreSpace ? (l) => l.replace(/\s+/g, '') : undefined);
  if (!parts.length) return out;
  out.push(`--- ${a}`, `+++ ${b}`);
  for (const h of parts) {
    out.push(`@@ -${h.beforeCount === 0 ? h.beforeStart - 1 : h.beforeStart},${h.beforeCount} +${h.afterCount === 0 ? h.afterStart - 1 : h.afterStart},${h.afterCount} @@`);
    out.push(...h.lines);
  }
  if (file.after !== null && file.after !== '' && !file.after.endsWith('\n')) out.push('\\ No newline at end of file');
  return out;
}

export interface DiffStat {
  path: string;
  added: number;
  removed: number;
}

export function diffStat(file: DiffFile): DiffStat {
  const ops = diffLines(splitLines(file.before ?? ''), splitLines(file.after ?? ''));
  return { path: file.path, added: ops.filter((o) => o.kind === '+').length, removed: ops.filter((o) => o.kind === '-').length };
}

/** The `N files changed, N insertions(+), N deletions(-)` line, and the bars above it. */
export function statLines(stats: DiffStat[]): string[] {
  if (!stats.length) return [];
  const width = Math.max(...stats.map((s) => s.path.length));
  const out = stats.map((s) => {
    const total = s.added + s.removed;
    const bar = '+'.repeat(Math.min(s.added, 40)) + '-'.repeat(Math.min(s.removed, 40));
    return ` ${s.path.padEnd(width)} | ${String(total).padStart(1)} ${bar}`;
  });
  const added = stats.reduce((n, s) => n + s.added, 0);
  const removed = stats.reduce((n, s) => n + s.removed, 0);
  const bits = [`${stats.length} file${stats.length === 1 ? '' : 's'} changed`];
  if (added) bits.push(`${added} insertion${added === 1 ? '' : 's'}(+)`);
  if (removed) bits.push(`${removed} deletion${removed === 1 ? '' : 's'}(-)`);
  out.push(' ' + bits.join(', '));
  return out;
}

// ---------------------------------------------------------------------------
// three-way merge

export interface MergeResult {
  content: string;
  conflicted: boolean;
}

/**
 * Merge `ours` and `theirs` against their common `base`. Runs of lines that only
 * one side changed are taken from that side; a run both sides changed differently
 * becomes a conflict, written with the markers git uses.
 */
export function mergeText(base: string, ours: string, theirs: string, labels: { ours: string; theirs: string; favor?: 'ours' | 'theirs' }): MergeResult {
  if (ours === theirs) return { content: ours, conflicted: false };
  if (base === ours) return { content: theirs, conflicted: false };
  if (base === theirs) return { content: ours, conflicted: false };

  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  const ourOps = diffLines(baseLines, ourLines);
  const theirOps = diffLines(baseLines, theirLines);

  // Walk both diffs together over the base, collecting each side's replacement text.
  let conflicted = false;
  const out: string[] = [];
  let oi = 0;
  let ti = 0;
  const takeChanges = (ops: Op[], at: number): { added: string[]; removed: number; next: number } => {
    const added: string[] = [];
    let removed = 0;
    let i = at;
    while (i < ops.length && ops[i].kind !== ' ') {
      if (ops[i].kind === '+') added.push(ops[i].text);
      else removed++;
      i++;
    }
    return { added, removed, next: i };
  };

  while (oi < ourOps.length || ti < theirOps.length) {
    const ourAt = ourOps[oi];
    const theirAt = theirOps[ti];
    if (ourAt?.kind === ' ' && theirAt?.kind === ' ') {
      out.push(ourAt.text);
      oi++;
      ti++;
      continue;
    }
    // One side's diff has run out: the rest of the other side is all there is left.
    if (!ourAt || !theirAt) {
      const rest = ourAt ? ourOps : theirOps;
      let at = ourAt ? oi : ti;
      while (at < rest.length) {
        if (rest[at].kind !== '-') out.push(rest[at].text);
        at++;
      }
      break;
    }
    const startedAt = { oi, ti };
    const ours2 = takeChanges(ourOps, oi);
    const theirs2 = takeChanges(theirOps, ti);
    const sameChange = ours2.added.join('\n') === theirs2.added.join('\n') && ours2.removed === theirs2.removed;
    if (sameChange) {
      out.push(...ours2.added);
    } else if (!ours2.added.length && ours2.removed === 0) {
      out.push(...theirs2.added);
    } else if (!theirs2.added.length && theirs2.removed === 0) {
      out.push(...ours2.added);
    } else {
      if (labels.favor === 'ours') out.push(...ours2.added);
      else if (labels.favor === 'theirs') out.push(...theirs2.added);
      else {
        conflicted = true;
        out.push(`<<<<<<< ${labels.ours}`, ...ours2.added, '=======', ...theirs2.added, `>>>>>>> ${labels.theirs}`);
      }
    }
    // Skip the base lines both sides consumed, so the walk stays in step.
    const skip = Math.max(ours2.removed, theirs2.removed);
    let skipped = 0;
    oi = ours2.next;
    ti = theirs2.next;
    while (skipped < skip - ours2.removed && oi < ourOps.length && ourOps[oi].kind === ' ') {
      oi++;
      skipped++;
    }
    skipped = 0;
    while (skipped < skip - theirs2.removed && ti < theirOps.length && theirOps[ti].kind === ' ') {
      ti++;
      skipped++;
    }
    // Neither side moved: take one operation from each so the walk always terminates.
    if (oi === startedAt.oi && ti === startedAt.ti) {
      oi++;
      ti++;
    }
  }
  const text = out.join('\n');
  return { content: text === '' ? '' : text + '\n', conflicted };
}
