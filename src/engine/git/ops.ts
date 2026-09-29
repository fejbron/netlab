/**
 * The operations that change history: committing, merging, rebasing, cherry-picking,
 * reverting, resetting and stashing. Each one returns what happened rather than
 * printed text, so the CLI decides the wording and the grader can look at the result.
 */
import type { Commit, Oid, Person, TreeEntry } from './objects';
import { diffStat, mergeText } from './diff';
import {
  buildTree,
  configValue,
  head,
  headTree,
  indexMap,
  logRef,
  moveHead,
  readCommit,
  readIndex,
  treeFiles,
  writeIndex,
  writeObject,
  writeRef,
  type IndexEntry,
  type Repo,
} from './repo';
import { mergeBase, commitsToReplay, shortId } from './revs';
import { blobFor, checkoutTree, readBlob, removeGitFile, putGitFile, removeWorkingFile, setIndexTo, statusOf, writeWorkingFile } from './worktree';

export class GitError extends Error {}

/** Lab time moves a minute per commit, so ids and dates are reproducible. */
export function tick(repo: Repo): number {
  repo.lx.clock += 60;
  return repo.lx.clock;
}

export function identity(repo: Repo): Person {
  const name = configValue(repo, 'user.name');
  const email = configValue(repo, 'user.email');
  if (!name || !email) {
    throw new GitError(
      [
        'Author identity unknown',
        '',
        '*** Please tell me who you are.',
        '',
        'Run',
        '',
        '  git config --global user.email "you@example.com"',
        '  git config --global user.name "Your Name"',
        '',
        'to set your account\'s default identity.',
        '',
        'fatal: unable to auto-detect email address',
      ].join('\n'),
    );
  }
  return { name, email, when: 0, tz: '+0000' };
}

export function createCommit(repo: Repo, opts: { tree: Oid; parents: Oid[]; message: string; when?: number; author?: Person }): Oid {
  const when = opts.when ?? tick(repo);
  const person: Person = opts.author ? { ...opts.author } : { ...identity(repo), when };
  const commit: Commit = { tree: opts.tree, parents: opts.parents, author: person, committer: { ...identity(repo), when }, message: opts.message.endsWith('\n') ? opts.message : opts.message + '\n' };
  return writeObject(repo, { type: 'commit', commit });
}

export interface CommitResult {
  oid: Oid;
  branch: string | null;
  root: boolean;
  files: number;
  insertions: number;
  deletions: number;
}

export function commit(repo: Repo, message: string, opts: { amend?: boolean; allowEmpty?: boolean; author?: Person; resetAuthor?: boolean } = {}): CommitResult {
  const h = head(repo);
  const status = statusOf(repo);
  if (status.conflicts.length) throw new GitError('fatal: Exiting because of an unresolved conflict.');
  const mergeHead = readMergeHead(repo);
  const parents = opts.amend ? (h.oid ? (readCommit(repo, h.oid)?.parents ?? []) : []) : [...(h.oid ? [h.oid] : []), ...mergeHead];
  const tree = buildTreeFromIndex(repo);
  const parentTree = parents[0] ? (readCommit(repo, parents[0])?.tree ?? null) : null;
  if (!opts.allowEmpty && !opts.amend && !mergeHead.length && tree === parentTree) {
    throw new GitError(['On branch ' + (h.branch?.replace('refs/heads/', '') ?? 'HEAD'), 'nothing to commit, working tree clean'].join('\n'));
  }
  // Amending keeps the original author and date unless told to reset them; a commit
  // finished after a pick or a rebase stop keeps the author of the original.
  const author = opts.author ?? (opts.amend && h.oid && !opts.resetAuthor ? readCommit(repo, h.oid)?.author : undefined);
  const oid = createCommit(repo, { tree, parents, message, author });
  moveHead(repo, oid);
  logRef(repo, h.branch ?? 'HEAD', h.oid, oid, identity(repo).name, `commit${opts.amend ? ' (amend)' : parents.length > 1 ? ' (merge)' : parents.length === 0 ? ' (initial)' : ''}: ${firstLine(message)}`, repo.lx.clock);
  if (h.branch) logRef(repo, 'HEAD', h.oid, oid, identity(repo).name, `commit: ${firstLine(message)}`, repo.lx.clock);
  removeGitFile(repo, 'MERGE_HEAD');
  removeGitFile(repo, 'MERGE_MSG');
  putGitFile(repo, 'COMMIT_EDITMSG', message.endsWith('\n') ? message : message + '\n');

  const before = treeFiles(repo, parentTree);
  const after = treeFiles(repo, tree);
  let insertions = 0;
  let deletions = 0;
  const touched = new Set([...before.keys(), ...after.keys()]);
  let files = 0;
  for (const path of touched) {
    const a = before.get(path);
    const b = after.get(path);
    if (a?.oid === b?.oid) continue;
    files++;
    // A submodule's entry reads as one "Subproject commit" line, as in git diff.
    const text = (e: typeof a) => (!e ? null : e.mode === '160000' ? `Subproject commit ${e.oid}\n` : (readBlob(repo, e.oid) ?? ''));
    const stat = diffStat({ path, before: text(a), after: text(b) });
    insertions += stat.added;
    deletions += stat.removed;
  }
  return { oid, branch: h.branch, root: parents.length === 0, files, insertions, deletions };
}

export function firstLine(message: string): string {
  return message.split('\n')[0];
}

function buildTreeFromIndex(repo: Repo): Oid {
  const files = new Map<string, TreeEntry>();
  for (const e of indexMap(readIndex(repo)).values()) files.set(e.path, { mode: e.mode, name: e.path.split('/').pop()!, oid: e.oid });
  return buildTree(repo, files);
}

export function readMergeHead(repo: Repo): Oid[] {
  const text = repo.lx.fs[`${repo.gitDir}/MERGE_HEAD`]?.content;
  return text ? text.trim().split('\n').filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// merging

export interface MergeOutcome {
  kind: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'squashed' | 'stopped';
  oid?: Oid;
  conflicts: string[];
  files: string[];
}

/** Merge one tree into another over their common base, file by file. */
export function mergeTrees(repo: Repo, baseOid: Oid | null, ourOid: Oid | null, theirOid: Oid | null, labels: { ours: string; theirs: string; favor?: 'ours' | 'theirs' }): { entries: IndexEntry[]; conflicts: string[]; files: Map<string, { content: string; mode: string }> } {
  const base = treeFiles(repo, baseOid);
  const ours = treeFiles(repo, ourOid);
  const theirs = treeFiles(repo, theirOid);
  const entries: IndexEntry[] = [];
  const conflicts: string[] = [];
  const files = new Map<string, { content: string; mode: string }>();

  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const text = (e?: TreeEntry) => (e ? (readBlob(repo, e.oid) ?? '') : '');
    if (o?.oid === t?.oid) {
      if (o) {
        entries.push({ mode: o.mode, oid: o.oid, stage: 0, path });
        files.set(path, { content: text(o), mode: o.mode });
      }
      continue;
    }
    if (b?.oid === o?.oid) {
      // Only they changed it.
      if (t) {
        entries.push({ mode: t.mode, oid: t.oid, stage: 0, path });
        files.set(path, { content: text(t), mode: t.mode });
      }
      continue;
    }
    if (b?.oid === t?.oid) {
      // Only we changed it.
      if (o) {
        entries.push({ mode: o.mode, oid: o.oid, stage: 0, path });
        files.set(path, { content: text(o), mode: o.mode });
      }
      continue;
    }
    if ((!o || !t) && labels.favor) {
      const keep = labels.favor === 'ours' ? o : t;
      if (keep) {
        entries.push({ mode: keep.mode, oid: keep.oid, stage: 0, path });
        files.set(path, { content: text(keep), mode: keep.mode });
      }
      continue;
    }
    if (!o || !t) {
      // One side deleted what the other changed: git leaves that to a person.
      conflicts.push(path);
      if (b) entries.push({ mode: b.mode, oid: b.oid, stage: 1, path });
      if (o) entries.push({ mode: o.mode, oid: o.oid, stage: 2, path });
      if (t) entries.push({ mode: t.mode, oid: t.oid, stage: 3, path });
      if (o) files.set(path, { content: text(o), mode: o.mode });
      else if (t) files.set(path, { content: text(t), mode: t.mode });
      continue;
    }
    const merged = mergeText(text(b), text(o), text(t), labels);
    files.set(path, { content: merged.content, mode: o.mode });
    if (merged.conflicted) {
      conflicts.push(path);
      if (b) entries.push({ mode: b.mode, oid: b.oid, stage: 1, path });
      entries.push({ mode: o.mode, oid: o.oid, stage: 2, path });
      entries.push({ mode: t.mode, oid: t.oid, stage: 3, path });
    } else {
      entries.push({ mode: o.mode, oid: blobFor(repo, merged.content), stage: 0, path });
    }
  }
  return { entries, conflicts: conflicts.sort(), files };
}

/** Apply a merge result to the working tree and the index. */
function applyMerge(repo: Repo, result: ReturnType<typeof mergeTrees>, previous: Map<string, TreeEntry>): void {
  const index = indexMap(readIndex(repo));
  for (const [path, entry] of previous) if (!result.files.has(path) && entry.mode !== '160000') removeWorkingFile(repo, path);
  const entries: IndexEntry[] = [];
  const merged = new Map(result.entries.filter((e) => e.stage === 0).map((e) => [e.path, e]));
  for (const [path, file] of result.files) {
    const was = previous.get(path);
    const now = merged.get(path);
    // A path the merge did not change keeps whatever the index and the working tree
    // hold, uncommitted edits included.
    if (was && now && was.oid === now.oid && was.mode === now.mode) continue;
    if (file.mode === '160000') continue;
    writeWorkingFile(repo, path, file.content, file.mode);
  }
  for (const e of result.entries) {
    const was = previous.get(e.path);
    const kept = index.get(e.path);
    if (e.stage === 0 && was && was.oid === e.oid && kept) entries.push(kept);
    else entries.push(e);
  }
  writeIndex(repo, entries);
}

export function merge(
  repo: Repo,
  theirOid: Oid,
  label: string,
  opts: { noFastForward?: boolean; ffOnly?: boolean; squash?: boolean; noCommit?: boolean; favor?: 'ours' | 'theirs'; message?: string } = {},
): MergeOutcome {
  const h = head(repo);
  if (!h.oid) throw new GitError('fatal: Non-fast-forward commit does not make sense into an empty head');
  const base = mergeBase(repo, h.oid, theirOid);
  if (base === theirOid) return { kind: 'up-to-date', conflicts: [], files: [] };
  if (opts.ffOnly && base !== h.oid) throw new GitError('fatal: Not possible to fast-forward, aborting.');

  const ourTree = headTree(repo);
  if (base === h.oid && !opts.noFastForward && !opts.squash) {
    const theirTree = readCommit(repo, theirOid)?.tree ?? null;
    const previous = treeFiles(repo, ourTree);
    const result = mergeTrees(repo, ourTree, theirTree, theirTree, { ours: 'HEAD', theirs: label });
    applyMerge(repo, result, previous);
    moveHead(repo, theirOid);
    logRef(repo, h.branch ?? 'HEAD', h.oid, theirOid, identity(repo).name, `merge ${label}: Fast-forward`, repo.lx.clock);
    return { kind: 'fast-forward', oid: theirOid, conflicts: [], files: [...result.files.keys()] };
  }

  const theirTree = readCommit(repo, theirOid)?.tree ?? null;
  const baseTree = base ? (readCommit(repo, base)?.tree ?? null) : null;
  const previous = treeFiles(repo, ourTree);
  const result = mergeTrees(repo, baseTree, ourTree, theirTree, { ours: 'HEAD', theirs: label, favor: opts.favor });
  applyMerge(repo, result, previous);

  // --squash stages the result and stops: no MERGE_HEAD, so the next commit has one parent.
  if (opts.squash) {
    putGitFile(repo, 'SQUASH_MSG', `Squashed commit of the following:\n\n${walkMessages(repo, h.oid, theirOid)}`);
    return { kind: result.conflicts.length ? 'conflict' : 'squashed', conflicts: result.conflicts, files: [...result.files.keys()] };
  }
  if (result.conflicts.length) {
    putGitFile(repo, 'MERGE_HEAD', theirOid + '\n');
    putGitFile(repo, 'MERGE_MSG', `Merge branch '${label}'\n\n# Conflicts:\n${result.conflicts.map((c) => `#\t${c}`).join('\n')}\n`);
    return { kind: 'conflict', conflicts: result.conflicts, files: [...result.files.keys()] };
  }
  const message = opts.message ?? `Merge branch '${label}'`;
  if (opts.noCommit) {
    putGitFile(repo, 'MERGE_HEAD', theirOid + '\n');
    putGitFile(repo, 'MERGE_MSG', message + '\n');
    return { kind: 'stopped', conflicts: [], files: [...result.files.keys()] };
  }
  const tree = buildTreeFromIndex(repo);
  const oid = createCommit(repo, { tree, parents: [h.oid, theirOid], message });
  moveHead(repo, oid);
  logRef(repo, h.branch ?? 'HEAD', h.oid, oid, identity(repo).name, `merge ${label}: Merge made by the 'ort' strategy.`, repo.lx.clock);
  return { kind: 'merged', oid, conflicts: [], files: [...result.files.keys()] };
}

// ---------------------------------------------------------------------------
// replaying commits: rebase, cherry-pick, revert

export interface ReplayOutcome {
  kind: 'ok' | 'conflict' | 'up-to-date';
  applied: Oid[];
  conflicts: string[];
  stoppedAt?: Oid;
}

/** Apply one commit's change on top of HEAD, three-way against its parent. */
export function applyCommit(repo: Repo, oid: Oid, opts: { reverse?: boolean; label?: string } = {}): { conflicts: string[]; tree: Oid } {
  const commit = readCommit(repo, oid);
  if (!commit) throw new GitError(`fatal: bad object ${oid}`);
  const parentTree = commit.parents[0] ? (readCommit(repo, commit.parents[0])?.tree ?? null) : null;
  const ourTree = headTree(repo);
  const from = opts.reverse ? commit.tree : parentTree;
  const to = opts.reverse ? parentTree : commit.tree;
  const previous = treeFiles(repo, ourTree);
  const result = mergeTrees(repo, from, ourTree, to, { ours: 'HEAD', theirs: opts.label ?? shortId(repo, oid) });
  applyMerge(repo, result, previous);
  return { conflicts: result.conflicts, tree: buildTreeFromIndex(repo) };
}

export function cherryPick(repo: Repo, oid: Oid, opts: { noCommit?: boolean; recordOrigin?: boolean } = {}): ReplayOutcome {
  const h = head(repo);
  const commit = readCommit(repo, oid)!;
  const { conflicts, tree } = applyCommit(repo, oid, { label: firstLine(commit.message) });
  if (conflicts.length) {
    putGitFile(repo, 'CHERRY_PICK_HEAD', oid + '\n');
    return { kind: 'conflict', applied: [], conflicts, stoppedAt: oid };
  }
  // --no-commit leaves the change staged for you to commit however you like.
  if (opts.noCommit) return { kind: 'ok', applied: [], conflicts: [] };
  const message = opts.recordOrigin ? `${commit.message.replace(/\n+$/, '')}\n\n(cherry picked from commit ${oid})\n` : commit.message;
  const created = createCommit(repo, { tree, parents: h.oid ? [h.oid] : [], message, author: commit.author });
  moveHead(repo, created);
  logRef(repo, h.branch ?? 'HEAD', h.oid, created, identity(repo).name, `cherry-pick: ${firstLine(commit.message)}`, repo.lx.clock);
  return { kind: 'ok', applied: [created], conflicts: [] };
}

export function revert(repo: Repo, oid: Oid, opts: { noCommit?: boolean } = {}): ReplayOutcome {
  const h = head(repo);
  const commit = readCommit(repo, oid)!;
  const { conflicts, tree } = applyCommit(repo, oid, { reverse: true, label: `parent of ${shortId(repo, oid)}` });
  if (conflicts.length) {
    putGitFile(repo, 'REVERT_HEAD', oid + '\n');
    return { kind: 'conflict', applied: [], conflicts, stoppedAt: oid };
  }
  if (opts.noCommit) return { kind: 'ok', applied: [], conflicts: [] };
  const message = `Revert "${firstLine(commit.message)}"\n\nThis reverts commit ${oid}.\n`;
  const created = createCommit(repo, { tree, parents: h.oid ? [h.oid] : [], message });
  moveHead(repo, created);
  logRef(repo, h.branch ?? 'HEAD', h.oid, created, identity(repo).name, `revert: ${firstLine(message)}`, repo.lx.clock);
  return { kind: 'ok', applied: [created], conflicts: [] };
}

export function rebase(repo: Repo, ontoOid: Oid, opts: { label?: string; upstream?: Oid } = {}): ReplayOutcome {
  const h = head(repo);
  if (!h.oid) throw new GitError('fatal: No rebase in progress?');
  const base = mergeBase(repo, h.oid, ontoOid);
  if (base === h.oid && !opts.upstream) {
    // Our branch is already contained in the target: just move up to it.
    checkoutCommit(repo, ontoOid);
    moveHead(repo, ontoOid);
    return { kind: 'up-to-date', applied: [], conflicts: [] };
  }
  const todo = commitsToReplay(repo, h.oid, opts.upstream ?? ontoOid);
  if (!todo.length && !opts.upstream) return { kind: 'up-to-date', applied: [], conflicts: [] };
  putGitFile(repo, 'ORIG_HEAD', h.oid + '\n');
  putGitFile(repo, 'rebase-merge/orig-head', h.oid + '\n');
  putGitFile(repo, 'rebase-merge/head-name', (h.branch ?? 'HEAD') + '\n');
  putGitFile(repo, 'rebase-merge/onto', ontoOid + '\n');

  // Start from the target, then replay each of our commits on top of it.
  checkoutCommit(repo, ontoOid);
  moveHead(repo, ontoOid);
  const applied: Oid[] = [];
  for (let i = 0; i < todo.length; i++) {
    const oid = todo[i];
    const commit = readCommit(repo, oid)!;
    const current = head(repo).oid!;
    const { conflicts, tree } = applyCommit(repo, oid, { label: firstLine(commit.message) });
    if (conflicts.length) {
      putGitFile(repo, 'REBASE_HEAD', oid + '\n');
      putGitFile(repo, 'rebase-merge/todo', todo.slice(i + 1).join('\n') + (todo.length > i + 1 ? '\n' : ''));
      return { kind: 'conflict', applied, conflicts, stoppedAt: oid };
    }
    if (tree === (readCommit(repo, current)?.tree ?? null) && commit.parents.length) {
      // The change is already in the target: git drops it and says so.
      continue;
    }
    const created = createCommit(repo, { tree, parents: [current], message: commit.message, author: commit.author });
    moveHead(repo, created);
    applied.push(created);
  }
  const final = head(repo).oid!;
  logRef(repo, h.branch ?? 'HEAD', h.oid, final, identity(repo).name, `rebase (finish): ${opts.label ?? 'refs/heads'}`, repo.lx.clock);
  endRebase(repo);
  return { kind: 'ok', applied, conflicts: [] };
}

// ---------------------------------------------------------------------------
// moving HEAD

export function checkoutCommit(repo: Repo, oid: Oid): void {
  checkoutTree(repo, readCommit(repo, oid)?.tree ?? null);
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export function reset(repo: Repo, oid: Oid, mode: ResetMode): void {
  const h = head(repo);
  const tree = readCommit(repo, oid)?.tree ?? null;
  if (h.oid) putGitFile(repo, 'ORIG_HEAD', h.oid + '\n');
  moveHead(repo, oid);
  logRef(repo, h.branch ?? 'HEAD', h.oid, oid, identity(repo).name, `reset: moving to ${shortId(repo, oid)}`, repo.lx.clock);
  if (h.branch) logRef(repo, 'HEAD', h.oid, oid, identity(repo).name, `reset: moving to ${shortId(repo, oid)}`, repo.lx.clock);
  if (mode === 'soft') return;
  if (mode === 'mixed') {
    setIndexTo(repo, treeFiles(repo, tree));
    return;
  }
  checkoutTree(repo, tree);
  removeGitFile(repo, 'MERGE_HEAD');
}

// ---------------------------------------------------------------------------
// stash

export interface StashEntry {
  oid: Oid;
  message: string;
}

export function readStash(repo: Repo): StashEntry[] {
  const text = repo.lx.fs[`${repo.commonDir}/stash-list`]?.content ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oid, ...rest] = line.split(' ');
      return { oid, message: rest.join(' ') };
    });
}

function writeStash(repo: Repo, entries: StashEntry[]): void {
  putGitFile(repo, 'stash-list', entries.map((e) => `${e.oid} ${e.message}`).join('\n') + (entries.length ? '\n' : ''));
}

/** Save the working tree and index as a commit, then return to a clean HEAD. */
export function stashPush(repo: Repo, message?: string, opts: { untracked?: boolean } = {}): StashEntry | null {
  const status = statusOf(repo);
  const untracked = opts.untracked ? status.untracked : [];
  if (!status.staged.length && !status.unstaged.length && !untracked.length) return null;
  const h = head(repo);
  const working = new Map<string, TreeEntry>();
  for (const [path, file] of workingSnapshot(repo)) working.set(path, { mode: file.mode, name: path.split('/').pop()!, oid: blobFor(repo, file.content) });
  for (const path of untracked) {
    const content = repo.lx.fs[`${repo.root}/${path}`]?.content ?? '';
    working.set(path, { mode: '100644', name: path.split('/').pop()!, oid: blobFor(repo, content) });
  }
  const tree = buildTree(repo, working);
  const branch = h.branch?.replace('refs/heads/', '') ?? 'HEAD';
  const text = message ?? `WIP on ${branch}: ${shortId(repo, h.oid!)} ${firstLine(readCommit(repo, h.oid!)?.message ?? '')}`;
  const oid = createCommit(repo, { tree, parents: h.oid ? [h.oid] : [], message: text });
  writeStash(repo, [{ oid, message: text }, ...readStash(repo)]);
  checkoutCommit(repo, h.oid!);
  for (const path of untracked) removeWorkingFile(repo, path);
  return { oid, message: text };
}

function workingSnapshot(repo: Repo): Map<string, { content: string; mode: string }> {
  const out = new Map<string, { content: string; mode: string }>();
  // Only tracked files are stashed, which is what `git stash` does without -u.
  const index = indexMap(readIndex(repo));
  for (const [path] of index) {
    const content = repo.lx.fs[`${repo.root}/${path}`]?.content;
    if (content !== undefined) out.set(path, { content, mode: index.get(path)!.mode });
  }
  for (const [path, entry] of treeFiles(repo, headTree(repo))) {
    if (!out.has(path) && repo.lx.fs[`${repo.root}/${path}`]?.content !== undefined) out.set(path, { content: repo.lx.fs[`${repo.root}/${path}`]!.content, mode: entry.mode });
  }
  return out;
}

/**
 * Put a stashed change back into the working tree. `drop` is what separates pop
 * from apply: apply leaves the entry on the stack so it can be used again.
 */
export function stashApply(repo: Repo, at = 0, drop = false): { conflicts: string[] } | null {
  const entries = readStash(repo);
  const entry = entries[at];
  if (!entry) return null;
  const stashCommit = readCommit(repo, entry.oid)!;
  const baseTree = stashCommit.parents[0] ? (readCommit(repo, stashCommit.parents[0])?.tree ?? null) : null;
  const ourTree = headTree(repo);
  const previous = treeFiles(repo, ourTree);
  const result = mergeTrees(repo, baseTree, ourTree, stashCommit.tree, { ours: 'Updated upstream', theirs: 'Stashed changes' });
  applyMerge(repo, result, previous);
  if (!result.conflicts.length) {
    if (drop) {
      writeStash(
        repo,
        entries.filter((_, i) => i !== at),
      );
    }
    // Restoring a stash leaves the changes unstaged, as git does.
    setIndexTo(repo, treeFiles(repo, ourTree));
  }
  return { conflicts: result.conflicts };
}

export function stashPop(repo: Repo, at = 0): { conflicts: string[] } | null {
  return stashApply(repo, at, true);
}

export function stashDrop(repo: Repo, at = 0): boolean {
  const entries = readStash(repo);
  if (!entries[at]) return false;
  writeStash(
    repo,
    entries.filter((_, i) => i !== at),
  );
  return true;
}

// ---------------------------------------------------------------------------
// branches

export function createBranch(repo: Repo, name: string, at: Oid): void {
  writeRef(repo, `refs/heads/${name}`, at);
  logRef(repo, `refs/heads/${name}`, null, at, identity(repo).name, `branch: Created from ${shortId(repo, at)}`, repo.lx.clock);
}

/** The one-line summaries of the commits a squash merge is bringing in. */
function walkMessages(repo: Repo, ours: Oid, theirs: Oid): string {
  return commitsToReplay(repo, theirs, ours)
    .reverse()
    .map((oid) => `commit ${oid}\n\n    ${firstLine(readCommit(repo, oid)?.message ?? '')}\n`)
    .join('\n');
}

/** A rebase that finished or was abandoned leaves no state behind. */
export function endRebase(repo: Repo): void {
  for (const name of ['REBASE_HEAD', 'rebase-merge/todo', 'rebase-merge/onto', 'rebase-merge/head-name', 'rebase-merge/orig-head']) removeGitFile(repo, name);
}

/** Paths a commit changed relative to its first parent: what applying it will touch. */
export function pathsChangedBy(repo: Repo, oid: Oid): string[] {
  const commit = readCommit(repo, oid);
  if (!commit) return [];
  const before = treeFiles(repo, commit.parents[0] ? (readCommit(repo, commit.parents[0])?.tree ?? null) : null);
  const after = treeFiles(repo, commit.tree);
  const out: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) if (before.get(path)?.oid !== after.get(path)?.oid) out.push(path);
  return out.sort();
}

/** Uncommitted paths, staged or not. */
export function dirtyPaths(repo: Repo): Set<string> {
  const status = statusOf(repo);
  return new Set([...status.staged, ...status.unstaged, ...status.conflicts.map((path) => ({ path }))].map((c) => c.path));
}

/** Write a commit object and nothing else, as git commit-tree does: no ref moves. */
export function createCommitObject(repo: Repo, tree: Oid, parents: Oid[], message: string): Oid {
  return createCommit(repo, { tree, parents, message });
}
