/**
 * Moving changes around as text: format-patch writes commits out as email-style
 * patches, apply puts a diff into the working tree or index, and am turns patches
 * back into commits with their original authors. filter-branch rewrites history
 * wholesale, which is how you take a file out of every commit.
 */
import { getNode, listDir, makeDir, normalizePath, removeNode, writeFile } from '../linux/fs';
import { diffOfCommit } from './common';
import { diffStat, statLines, unifiedDiff } from './diff';
import { EPOCH, has, type Io, parseFlags, rfcDate, type GitEnv } from './io';
import type { Oid, Person, TreeEntry } from './objects';
import { createCommit, firstLine, GitError, identity } from './ops';
import {
  buildTree,
  deleteRef,
  head,
  indexMap,
  listRefs,
  logRef,
  moveHead,
  put,
  readCommit,
  readIndex,
  readRef,
  slurp,
  treeFiles,
  writeIndex,
  writeRef,
  type IndexEntry,
  type Repo,
} from './repo';
import { commitsIn, isRangeSpec, parseRange } from './more';
import { resolveRev, shortId, walk } from './revs';
import { blobFor, checkoutTree, readBlob, removeGitFile, putGitFile, removeWorkingFile, statusOf, writeWorkingFile } from './worktree';

// ---------------------------------------------------------------------------
// format-patch

function slug(subject: string): string {
  return (
    subject
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52)
      .replace(/-+$/, '') || 'patch'
  );
}

export function cmdFormatPatch(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  let commits: Oid[];
  const count = f.values.n ? Number(f.values.n) : null;
  if (count) {
    const h = head(repo).oid;
    commits = h ? walk(repo, [h], { firstParent: true }).slice(0, count).reverse() : [];
  } else {
    const spec = f.rest[0];
    if (!spec) throw new GitError('fatal: name a range, as in: git format-patch main or git format-patch -1');
    // A single revision means "since": everything on HEAD that it does not have.
    commits = commitsIn(repo, parseRange(repo, [isRangeSpec(spec) ? spec : `${spec}..HEAD`])).reverse();
  }
  commits = commits.filter((oid) => (readCommit(repo, oid)?.parents.length ?? 0) <= 1);
  const outDir = normalizePath(env.cwd, f.values.o ?? f.values['output-directory'] ?? '.', `/home/${env.lx.user}`);
  if (!getNode(env.lx, outDir)) makeDir(env.lx, outDir, true);
  const total = commits.length;
  commits.forEach((oid, i) => {
    const commit = readCommit(repo, oid)!;
    const [subject, ...bodyLines] = commit.message.replace(/\n+$/, '').split('\n');
    const body = bodyLines.join('\n').replace(/^\n+/, '');
    const files = diffOfCommit(repo, oid);
    const tag = total > 1 || has(f, 'numbered') ? `[PATCH ${i + 1}/${total}]` : '[PATCH]';
    const text = [
      `From ${oid} Mon Sep 17 00:00:00 2001`,
      `From: ${commit.author.name} <${commit.author.email}>`,
      `Date: ${rfcDate(commit.author.when)}`,
      `Subject: ${tag} ${subject}`,
      '',
      ...(body ? [body, ''] : []),
      '---',
      ...statLines(files.map(diffStat)),
      '',
      ...files.flatMap((file) => unifiedDiff(file)),
      '-- ',
      '2.43.0',
      '',
    ].join('\n');
    const name = `${String(i + 1).padStart(4, '0')}-${slug(subject)}.patch`;
    if (has(f, 'stdout')) {
      io.print(...text.replace(/\n$/, '').split('\n'));
      return;
    }
    writeFile(env.lx, `${outDir}/${name}`, text, false, 'git');
    io.print(f.values.o ?? f.values['output-directory'] ? `${(f.values.o ?? f.values['output-directory']).replace(/\/$/, '')}/${name}` : name);
  });
}

// ---------------------------------------------------------------------------
// reading patches

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface FilePatch {
  oldPath: string | null;
  newPath: string | null;
  newMode?: string;
  hunks: PatchHunk[];
}

/** Parse the diff part of a patch: one entry per file, each with its hunks. */
export function parsePatch(text: string): FilePatch[] {
  const lines = text.split('\n');
  const out: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: PatchHunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, hunks: [] };
      out.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ')) {
      current.oldPath = null;
      current.newMode = line.slice('new file mode '.length).trim();
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.newPath = null;
      continue;
    }
    if (line.startsWith('--- ') && !hunk) {
      if (line.includes('/dev/null')) current.oldPath = null;
      continue;
    }
    if (line.startsWith('+++ ') && !hunk) {
      if (line.includes('/dev/null')) current.newPath = null;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunk = { oldStart: Number(header[1]), oldCount: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newCount: header[4] === undefined ? 1 : Number(header[4]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    // A hunk holds exactly the lines its header counts; anything after is not part of it
    // (a format-patch signature starts "-- ", which would otherwise read as a removal).
    const counted = (h: PatchHunk) => ({
      old: h.lines.filter((l) => !l.startsWith('+')).length,
      new: h.lines.filter((l) => !l.startsWith('-')).length,
    });
    if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '')) {
      const c = counted(hunk);
      if (c.old < hunk.oldCount || c.new < hunk.newCount) {
        // An empty context line can lose its leading space in transit.
        hunk.lines.push(line === '' ? ' ' : line);
        continue;
      }
    }
    if (line.startsWith('\\ No newline')) continue;
    // "-- " ends a format-patch body; anything else ends the hunk.
    if (line === '-- ') break;
    hunk = null;
  }
  return out;
}

export class PatchError extends Error {
  constructor(
    public path: string,
    public line: number,
  ) {
    super(`patch failed: ${path}:${line}`);
  }
}

/** Apply hunks to text, finding each hunk near where it says it goes, as git apply does. */
export function applyHunks(original: string, hunks: PatchHunk[], path: string, reverse = false): string {
  const lines = original === '' ? [] : original.replace(/\n$/, '').split('\n');
  let offset = 0;
  for (const h of hunks) {
    const remove = h.lines.filter((l) => !l.startsWith(reverse ? '-' : '+')).map((l) => l.slice(1));
    const add = h.lines.filter((l) => !l.startsWith(reverse ? '+' : '-')).map((l) => l.slice(1));
    const start = (reverse ? h.newStart : h.oldStart) - 1 + offset;
    const matchesAt = (at: number) => at >= 0 && at + remove.length <= lines.length && remove.every((l, k) => lines[at + k] === l);
    let at = -1;
    const expected = remove.length === 0 ? Math.max(0, start + 1) : Math.max(0, start);
    for (let d = 0; d <= lines.length; d++) {
      if (matchesAt(expected - d)) {
        at = expected - d;
        break;
      }
      if (matchesAt(expected + d)) {
        at = expected + d;
        break;
      }
    }
    if (at < 0) throw new PatchError(path, (reverse ? h.newStart : h.oldStart));
    lines.splice(at, remove.length, ...add);
    offset += add.length - remove.length;
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------------------
// apply

interface ApplyTarget {
  read(path: string): string | null;
  write(path: string, content: string, mode: string): void;
  remove(path: string): void;
}

function workingTarget(repo: Repo): ApplyTarget {
  return {
    read: (p) => slurp(repo.lx, `${repo.root}/${p}`),
    write: (p, content, mode) => writeWorkingFile(repo, p, content, mode),
    remove: (p) => removeWorkingFile(repo, p),
  };
}

function indexTarget(repo: Repo, entries: IndexEntry[]): ApplyTarget {
  const map = new Map(entries.filter((e) => e.stage === 0).map((e) => [e.path, e]));
  return {
    read: (p) => {
      const e = map.get(p);
      return e ? readBlob(repo, e.oid) : null;
    },
    write: (p, content, mode) => {
      const oid = blobFor(repo, content);
      const at = entries.findIndex((e) => e.path === p && e.stage === 0);
      if (at >= 0) entries[at] = { ...entries[at], oid, mode };
      else entries.push({ mode, oid, stage: 0, path: p });
      map.set(p, { mode, oid, stage: 0, path: p });
    },
    remove: (p) => {
      const at = entries.findIndex((e) => e.path === p && e.stage === 0);
      if (at >= 0) entries.splice(at, 1);
      map.delete(p);
    },
  };
}

/** Work out what a patch does to a target, without changing anything yet. */
function planPatch(patches: FilePatch[], target: ApplyTarget, reverse: boolean): Array<{ path: string; content: string | null; mode: string }> {
  const plan: Array<{ path: string; content: string | null; mode: string }> = [];
  for (const p of patches) {
    const from = reverse ? p.newPath : p.oldPath;
    const to = reverse ? p.oldPath : p.newPath;
    const path = (to ?? from)!;
    if (from === null) {
      if (target.read(path) !== null) throw new GitError(`error: ${path}: already exists in working directory`);
      plan.push({ path, content: applyHunks('', p.hunks, path, reverse), mode: p.newMode ?? '100644' });
      continue;
    }
    const current = target.read(from);
    if (current === null) throw new GitError(`error: ${from}: No such file or directory`);
    if (to === null) {
      plan.push({ path: from, content: null, mode: '100644' });
      continue;
    }
    try {
      plan.push({ path: to, content: applyHunks(current, p.hunks, from, reverse), mode: p.newMode ?? '100644' });
      if (to !== from) plan.push({ path: from, content: null, mode: '100644' });
    } catch (e) {
      if (e instanceof PatchError) throw new GitError(`error: patch failed: ${e.path}:${e.line}\nerror: ${e.path}: patch does not apply`);
      throw e;
    }
  }
  return plan;
}

function carryOut(plan: ReturnType<typeof planPatch>, target: ApplyTarget): void {
  for (const step of plan) {
    if (step.content === null) target.remove(step.path);
    else target.write(step.path, step.content, step.mode);
  }
}

export function cmdApply(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const file = f.rest[0];
  if (!file) throw new GitError('usage: git apply [<options>] [<patch>...]');
  const text = slurp(env.lx, normalizePath(env.cwd, file, `/home/${env.lx.user}`));
  if (text === null) throw new GitError(`error: can't open patch '${file}': No such file or directory`);
  const patches = parsePatch(text);
  if (!patches.length) throw new GitError(`error: No valid patches in input (allow with "--allow-empty")`);
  const reverse = has(f, 'R', 'reverse');
  if (has(f, 'stat')) {
    io.print(...statLines(patches.map((p) => ({ path: (p.newPath ?? p.oldPath)!, added: p.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0), removed: p.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0) }))));
    return;
  }
  const cached = has(f, 'cached');
  const index = has(f, 'index');
  const entries = readIndex(repo);
  const target = cached ? indexTarget(repo, entries) : workingTarget(repo);
  const plan = planPatch(patches, target, reverse);
  if (has(f, 'check')) return;
  carryOut(plan, target);
  if (cached) writeIndex(repo, entries);
  if (index) {
    const idx = indexTarget(repo, entries);
    carryOut(plan, idx);
    writeIndex(repo, entries);
  }
  if (has(f, 'v', 'verbose')) for (const p of patches) io.err.push(`Checking patch ${(p.newPath ?? p.oldPath)!}...`, `Applied patch ${(p.newPath ?? p.oldPath)!} cleanly.`);
}

// ---------------------------------------------------------------------------
// am

interface Mail {
  author: Person;
  subject: string;
  body: string;
  diff: string;
}

function parseMail(text: string): Mail {
  const lines = text.split('\n');
  let name = 'Unknown';
  let email = '';
  let when = 0;
  let subject = '';
  let i = 0;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i];
    const from = /^From: (.*?) <([^>]*)>/.exec(line);
    if (from) {
      name = from[1];
      email = from[2];
    }
    if (line.startsWith('Date: ')) {
      const t = Date.parse(line.slice(6));
      if (!Number.isNaN(t)) when = Math.round(t / 1000) - EPOCH;
    }
    if (line.startsWith('Subject: ')) subject = line.slice(9).replace(/^\[PATCH[^\]]*\]\s*/, '');
  }
  const rest = lines.slice(i + 1).join('\n');
  const split = rest.search(/^---$/m);
  const body = (split >= 0 ? rest.slice(0, split) : rest).trim();
  const diffStart = rest.search(/^diff --git /m);
  return { author: { name, email, when, tz: '+0000' }, subject, body, diff: diffStart >= 0 ? rest.slice(diffStart) : '' };
}

const AM_DIR = 'rebase-apply';

function amApplyOne(repo: Repo, mail: Mail): void {
  const entries = readIndex(repo);
  const patches = parsePatch(mail.diff);
  const plan = planPatch(patches, workingTarget(repo), false);
  carryOut(plan, workingTarget(repo));
  carryOut(plan, indexTarget(repo, entries));
  writeIndex(repo, entries);
  commitIndex(repo, mail);
}

function commitIndex(repo: Repo, mail: Mail): void {
  const h = head(repo);
  const files = new Map<string, TreeEntry>();
  for (const e of indexMap(readIndex(repo)).values()) files.set(e.path, { mode: e.mode, name: e.path.split('/').pop()!, oid: e.oid });
  const tree = buildTree(repo, files);
  const message = mail.body ? `${mail.subject}\n\n${mail.body}\n` : `${mail.subject}\n`;
  const oid = createCommit(repo, { tree, parents: h.oid ? [h.oid] : [], message, author: mail.author });
  moveHead(repo, oid);
  logRef(repo, h.branch ?? 'HEAD', h.oid, oid, identity(repo).name, `am: ${mail.subject}`, repo.lx.clock);
}

export function cmdAm(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const state = slurp(repo.lx, `${repo.gitDir}/${AM_DIR}/queue`);
  if (has(f, 'abort')) {
    if (state === null) throw new GitError('fatal: Resolve operation not in progress, we are not resuming.');
    const orig = slurp(repo.lx, `${repo.gitDir}/${AM_DIR}/orig-head`)?.trim();
    if (orig) {
      moveHead(repo, orig);
      checkoutTree(repo, readCommit(repo, orig)?.tree ?? null);
    }
    for (const n of ['queue', 'orig-head', 'current']) removeGitFile(repo, `${AM_DIR}/${n}`);
    return;
  }
  let queue: string[];
  if (has(f, 'continue', 'resolved', 'skip')) {
    if (state === null) throw new GitError('fatal: Resolve operation not in progress, we are not resuming.');
    queue = state.split('\n').filter(Boolean);
    const current = slurp(repo.lx, `${repo.gitDir}/${AM_DIR}/current`) ?? '';
    if (has(f, 'skip')) checkoutTree(repo, readCommit(repo, head(repo).oid!)?.tree ?? null);
    else {
      const mail = parseMail(current);
      if (!statusOf(repo).staged.length) throw new GitError('No changes - did you forget to use \'git add\'?\nIf there is nothing left to stage, chances are that something else\nalready introduced the same changes; you might want to skip this patch.');
      io.print(`Applying: ${mail.subject}`);
      commitIndex(repo, mail);
    }
  } else {
    if (state !== null) throw new GitError('error: previous rebase directory .git/rebase-apply still exists but mbox given.');
    if (statusOf(repo).staged.length) throw new GitError('error: Dirty index: cannot apply patches (dirty: staged changes)');
    const files = f.rest.flatMap((spec) => {
      const abs = normalizePath(env.cwd, spec, `/home/${env.lx.user}`);
      const node = getNode(env.lx, abs);
      if (!node) throw new GitError(`fatal: could not open '${spec}' for reading: No such file or directory`);
      return node.type === 'dir' ? listDir(env.lx, abs).filter((n) => n.endsWith('.patch')).map((n) => `${abs}/${n}`) : [abs];
    });
    if (!files.length) throw new GitError('fatal: no patches given; name the .patch files, as in: git am 0001-*.patch');
    queue = files.map((p) => slurp(env.lx, p) ?? '');
    putGitFile(repo, `${AM_DIR}/orig-head`, (head(repo).oid ?? '') + '\n');
  }
  for (let i = 0; i < queue.length; i++) {
    const mail = parseMail(queue[i]);
    io.print(`Applying: ${mail.subject}`);
    try {
      amApplyOne(repo, mail);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      // Keep the rest, so --continue and --skip can pick up where this stopped.
      putGitFile(repo, `${AM_DIR}/current`, queue[i]);
      putGitFile(repo, `${AM_DIR}/queue`, queue.slice(i + 1).join('\n'));
      io.fail(
        128,
        ...e.message.split('\n'),
        `Patch failed at ${String(i + 1).padStart(4, '0')} ${mail.subject}`,
        "hint: Use 'git am --show-current-patch=diff' to see the failed patch",
        'When you have resolved this problem, run "git am --continue".',
        'If you prefer to skip this patch, run "git am --skip" instead.',
        'To restore the original branch and stop patching, run "git am --abort".',
      );
      return;
    }
  }
  for (const n of ['queue', 'orig-head', 'current']) removeGitFile(repo, `${AM_DIR}/${n}`);
}

// ---------------------------------------------------------------------------
// filter-branch

const FILTER_WARNING = [
  'WARNING: git-filter-branch has a glut of gotchas generating mangled history',
  '\t rewrites.  Hit Ctrl-C before proceeding to abort, then use an',
  "\t alternative filtering tool such as 'git filter-repo'",
  '\t (https://github.com/newren/git-filter-repo/) instead.  See the',
  '\t filter-branch manual page for more details; to squelch this warning,',
  '\t set FILTER_BRANCH_SQUELCH_WARNING=1.',
];

/** Parents before children, so every commit's parents are rewritten before it is. */
function topoOrder(repo: Repo, tips: Oid[]): Oid[] {
  const seen = new Set<Oid>();
  const out: Oid[] = [];
  const visit = (oid: Oid) => {
    if (seen.has(oid)) return;
    seen.add(oid);
    for (const p of readCommit(repo, oid)?.parents ?? []) visit(p);
    out.push(oid);
  };
  for (const t of tips) visit(t);
  return out;
}

export function cmdFilterBranch(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  if (!env.run) throw new GitError('fatal: filter-branch needs a shell to run its filters in');
  if (env.env.FILTER_BRANCH_SQUELCH_WARNING !== '1') io.err.push(...FILTER_WARNING);
  const indexFilter = f.values['index-filter'];
  const treeFilter = f.values['tree-filter'];
  const msgFilter = f.values['msg-filter'];
  const unsupported = ['env-filter', 'parent-filter', 'commit-filter', 'tag-name-filter', 'subdirectory-filter'].find((o) => f.values[o] !== undefined);
  if (unsupported) throw new GitError(`fatal: --${unsupported} is not simulated; NetLab supports --index-filter, --tree-filter and --msg-filter`);
  if (!indexFilter && !treeFilter && !msgFilter) throw new GitError('usage: git filter-branch [--index-filter <cmd>] [--tree-filter <cmd>] [--msg-filter <cmd>] [--prune-empty] [-f] [-- <rev-list options>]');
  if (statusOf(repo).staged.length || statusOf(repo).unstaged.length) throw new GitError('Cannot rewrite branches: You have unstaged changes.');
  if (listRefs(repo, 'refs/original').length && !has(f, 'f', 'force')) {
    throw new GitError('Cannot create a new backup.\nA previous backup already exists in refs/original/\nForce overwriting the backup with -f');
  }

  // Which refs to rewrite: the current branch, or --all.
  const revs = [...f.rest, ...f.paths];
  const refs = revs.includes('--all') || has(f, 'all') || f.paths.includes('--all') ? listRefs(repo, 'refs/heads').map((r) => r.name) : [head(repo).branch ?? 'HEAD'];
  const tips = refs.map((r) => readRef(repo, r)!).filter(Boolean);
  const order = topoOrder(repo, tips);
  const scratch = `${repo.gitDir}/filter-branch/t`;
  const savedIndex = readIndex(repo);
  const mapped = new Map<Oid, Oid | null>();

  order.forEach((oid, n) => {
    const commit = readCommit(repo, oid)!;
    let tree = commit.tree;
    if (treeFilter) {
      // Write the commit's files out, run the command there, read them back.
      if (getNode(repo.lx, scratch)) removeNode(repo.lx, scratch, true, 'git');
      makeDir(repo.lx, scratch, true);
      for (const [path, entry] of treeFiles(repo, tree)) {
        const full = `${scratch}/${path}`;
        const dir = full.slice(0, full.lastIndexOf('/'));
        if (!getNode(repo.lx, dir)) makeDir(repo.lx, dir, true);
        writeFile(repo.lx, full, readBlob(repo, entry.oid) ?? '', false, 'git');
        const node = getNode(repo.lx, full);
        if (node) node.mode = entry.mode === '100755' ? 0o755 : 0o644;
      }
      env.run!(treeFilter, scratch);
      const files = new Map<string, TreeEntry>();
      const walkDir = (dir: string, prefix: string) => {
        for (const name of listDir(repo.lx, dir)) {
          const full = `${dir}/${name}`;
          const node = getNode(repo.lx, full);
          if (!node) continue;
          if (node.type === 'dir') walkDir(full, `${prefix}${name}/`);
          else files.set(`${prefix}${name}`, { mode: node.mode & 0o100 ? '100755' : '100644', name, oid: blobFor(repo, node.content) });
        }
      };
      walkDir(scratch, '');
      tree = buildTree(repo, files);
    }
    if (indexFilter) {
      // Put the commit's tree in the index, let the command change the index, keep the result.
      writeIndex(
        repo,
        [...treeFiles(repo, tree)].map(([path, e]) => ({ mode: e.mode, oid: e.oid, stage: 0, path })),
      );
      env.run!(indexFilter, repo.root);
      const files = new Map<string, TreeEntry>();
      for (const e of indexMap(readIndex(repo)).values()) files.set(e.path, { mode: e.mode, name: e.path.split('/').pop()!, oid: e.oid });
      tree = buildTree(repo, files);
    }
    let message = commit.message;
    if (msgFilter) {
      const file = `${repo.gitDir}/filter-branch/message`;
      put(repo.lx, file, commit.message);
      const r = env.run!(`${msgFilter} < ${file}`, repo.root);
      message = r.out.join('\n') + '\n';
    }
    const parents = commit.parents.map((p) => (mapped.has(p) ? mapped.get(p) : p)).filter((p): p is Oid => Boolean(p));
    // --prune-empty drops a commit whose rewrite changes nothing.
    if (has(f, 'prune-empty') && parents.length <= 1 && tree === (parents[0] ? readCommit(repo, parents[0])?.tree : null)) {
      mapped.set(oid, parents[0] ?? null);
      return;
    }
    const unchanged = tree === commit.tree && message === commit.message && parents.join() === commit.parents.join();
    const created = unchanged ? oid : createCommit(repo, { tree, parents, message, author: commit.author, when: commit.committer.when });
    mapped.set(oid, created);
    io.err.push(`Rewrite ${oid} (${n + 1}/${order.length}) (0 seconds passed, remaining 0 predicted)`);
  });

  writeIndex(repo, savedIndex);
  if (getNode(repo.lx, `${repo.gitDir}/filter-branch`)) removeNode(repo.lx, `${repo.gitDir}/filter-branch`, true, 'git');
  io.err.push('');
  for (const ref of refs) {
    const old = readRef(repo, ref);
    if (!old) continue;
    const now = mapped.get(old) ?? old;
    if (now === old) {
      io.err.push(`WARNING: Ref '${ref}' is unchanged`);
      continue;
    }
    // The old history is kept under refs/original, which is how you undo a filter-branch.
    writeRef(repo, `refs/original/${ref}`, old);
    writeRef(repo, ref, now);
    logRef(repo, ref, old, now, identity(repo).name, 'filter-branch: rewrite', repo.lx.clock);
    io.print(`Ref '${ref}' was rewritten`);
  }
  const h = head(repo);
  if (h.oid) checkoutTree(repo, readCommit(repo, h.oid)?.tree ?? null);
  void deleteRef;
  void firstLine;
  void shortId;
  void resolveRev;
}
