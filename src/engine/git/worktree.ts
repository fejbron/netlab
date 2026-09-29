/**
 * The working tree, the index and the comparisons between them that `git status`
 * reports: what is staged for the next commit, what is changed but not staged,
 * and what git has never been told about.
 */
import { getNode, makeDir, parentPath, removeNode, writeFile, type LinuxState } from '../linux/fs';
import { objectId, type Oid, type TreeEntry } from './objects';
import { configValue, findRepo, gitPath, head, headTree, indexMap, put, readIndex, slurp, treeFiles, walkFiles, writeIndex, writeObject, type IndexEntry, type Repo } from './repo';

/** Store content as a blob and return its id. Use hashBlob when nothing should be written. */
export function blobFor(repo: Repo, content: string): Oid {
  return writeObject(repo, { type: 'blob', content });
}

/** The id content would have as a blob, without storing it: status and diff only look. */
export function hashBlob(content: string): Oid {
  return objectId({ type: 'blob', content });
}

/** A submodule is recorded in the tree as a commit id with this mode, called a gitlink. */
export const GITLINK = '160000';

/** The commit a submodule's own HEAD is at, or null when the directory holds no repository. */
export function submoduleHead(repo: Repo, path: string): Oid | null {
  const dir = `${repo.root}/${path}`;
  if (!getNode(repo.lx, `${dir}/.git`)) return null;
  const sub = findRepo(repo.lx, dir);
  return sub && sub.root === dir ? head(sub).oid : null;
}

// ---------------------------------------------------------------------------
// sparse checkout

/** The directories a cone-mode sparse checkout includes, or null when it is off. */
export function sparseDirs(repo: Repo): string[] | null {
  if (configValue(repo, 'core.sparseCheckout') !== 'true') return null;
  const text = slurp(repo.lx, gitPath(repo, 'info/sparse-checkout')) ?? '';
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '/*' && l !== '!/*/')
    .map((l) => l.replace(/^\//, '').replace(/\/$/, '').replace(/\/\*$/, ''))
    .filter(Boolean);
}

/** In cone mode the top-level files are always present, plus everything under the chosen directories. */
export function inSparse(repo: Repo, path: string, dirs = sparseDirs(repo)): boolean {
  if (!dirs) return true;
  if (!path.includes('/')) return true;
  return dirs.some((d) => path === d || path.startsWith(d + '/'));
}

export function modeOf(lx: LinuxState, path: string): string {
  const node = getNode(lx, path, false);
  if (!node) return '100644';
  if (node.type === 'link') return '120000';
  return node.mode & 0o100 ? '100755' : '100644';
}

/** Every file in the working tree, by path relative to the root. */
export function workingFiles(repo: Repo): Map<string, { content: string; mode: string }> {
  const out = new Map<string, { content: string; mode: string }>();
  if (repo.bare) return out;
  for (const rel of walkFiles(repo.lx, repo.root)) {
    const full = `${repo.root}/${rel}`;
    // A directory holding its own repository is a submodule: git records the commit
    // it is at, not its files. Its "content" here is that commit id.
    if (getNode(repo.lx, full)?.type === 'dir') {
      const sub = submoduleHead(repo, rel);
      if (sub) out.set(rel, { content: sub, mode: GITLINK });
      continue;
    }
    const content = slurp(repo.lx, full);
    if (content === null) continue;
    out.set(rel, { content, mode: modeOf(repo.lx, full) });
  }
  return out;
}

/** The id git would compare a working file against: a blob hash, or a submodule's commit. */
export function workingId(file: { content: string; mode: string }): Oid {
  return file.mode === GITLINK ? file.content : hashBlob(file.content);
}

// ---------------------------------------------------------------------------
// .gitignore

function globToRe(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface IgnoreRules {
  test(path: string): boolean;
}

/** .gitignore support: comments, negation with !, directory rules and * globs. */
export function ignoreRules(repo: Repo): IgnoreRules {
  const text = repo.bare ? null : slurp(repo.lx, `${repo.root}/.gitignore`);
  const rules = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const body = negated ? line.slice(1) : line;
      const dirOnly = body.endsWith('/');
      const cleaned = (dirOnly ? body.slice(0, -1) : body).replace(/^\//, '');
      return { negated, dirOnly, anchored: body.startsWith('/') || cleaned.includes('/'), re: globToRe(cleaned), raw: cleaned };
    });
  return {
    test(path: string): boolean {
      let ignored = false;
      for (const rule of rules) {
        const segments = path.split('/');
        const hit = rule.anchored
          ? rule.re.test(path) || (rule.dirOnly && path.startsWith(rule.raw + '/')) || segments.slice(0, -1).join('/') === rule.raw
          : segments.some((s, i) => rule.re.test(s) && (!rule.dirOnly || i < segments.length - 1));
        if (hit) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

// ---------------------------------------------------------------------------
// status

export interface Change {
  /** 'A' added, 'M' modified, 'D' deleted. */
  code: 'A' | 'M' | 'D';
  path: string;
}

export interface Status {
  staged: Change[];
  unstaged: Change[];
  untracked: string[];
  conflicts: string[];
}

export function statusOf(repo: Repo): Status {
  const entries = readIndex(repo);
  const index = indexMap(entries);
  const conflicts = [...new Set(entries.filter((e) => e.stage > 0).map((e) => e.path))].sort();
  const committed = treeFiles(repo, headTree(repo));
  const working = workingFiles(repo);
  const ignore = ignoreRules(repo);

  const staged: Change[] = [];
  for (const [path, entry] of index) {
    const was = committed.get(path);
    if (!was) staged.push({ code: 'A', path });
    else if (was.oid !== entry.oid || was.mode !== entry.mode) staged.push({ code: 'M', path });
  }
  for (const path of committed.keys()) if (!index.has(path) && !conflicts.includes(path)) staged.push({ code: 'D', path });

  const unstaged: Change[] = [];
  const sparse = sparseDirs(repo);
  for (const [path, entry] of index) {
    const file = working.get(path);
    if (!file) {
      // A file a sparse checkout left out is absent on purpose, not deleted.
      if (!inSparse(repo, path, sparse)) continue;
      // An uninitialised submodule is an empty directory, which is not a change either.
      if (entry.mode === GITLINK) continue;
      unstaged.push({ code: 'D', path });
    } else if (workingId(file) !== entry.oid || file.mode !== entry.mode) unstaged.push({ code: 'M', path });
  }

  const untracked: string[] = [];
  for (const path of working.keys()) {
    if (index.has(path) || conflicts.includes(path)) continue;
    if (ignore.test(path)) continue;
    untracked.push(path);
  }

  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { staged: staged.sort(byPath), unstaged: unstaged.sort(byPath), untracked: untracked.sort(), conflicts };
}

export function isClean(repo: Repo): boolean {
  const s = statusOf(repo);
  return !s.staged.length && !s.unstaged.length && !s.conflicts.length;
}

// ---------------------------------------------------------------------------
// staging

/** Paths in the working tree or the index that a pathspec names. */
export function matchPaths(repo: Repo, spec: string, opts: { includeIndex?: boolean } = {}): string[] {
  const working = [...workingFiles(repo).keys()];
  const tracked = opts.includeIndex === false ? [] : [...indexMap(readIndex(repo)).keys(), ...treeFiles(repo, headTree(repo)).keys()];
  const all = [...new Set([...working, ...tracked])];
  if (spec === '.' || spec === '-A' || spec === '--all' || spec === '*') return all;
  const rel = spec.replace(/^\.\//, '').replace(/\/$/, '');
  const re = spec.includes('*') ? globToRe(rel) : null;
  return all.filter((p) => (re ? re.test(p) || re.test(p.split('/').pop()!) : p === rel || p.startsWith(rel + '/')));
}

/** Stage the current content of these paths; a path that is gone is staged as a deletion. */
export function stagePaths(repo: Repo, paths: string[]): IndexEntry[] {
  const entries = readIndex(repo).filter((e) => e.stage === 0 || !paths.includes(e.path));
  const index = new Map(entries.filter((e) => e.stage === 0).map((e) => [e.path, e]));
  const working = workingFiles(repo);
  for (const path of paths) {
    // Staging a conflicted path resolves it: the stage entries go, one stage-0 entry lands.
    for (const e of [...entries]) if (e.path === path && e.stage > 0) entries.splice(entries.indexOf(e), 1);
    const file = working.get(path);
    if (!file) {
      index.delete(path);
      const at = entries.findIndex((e) => e.path === path && e.stage === 0);
      if (at >= 0) entries.splice(at, 1);
      continue;
    }
    const entry: IndexEntry = { mode: file.mode, oid: file.mode === GITLINK ? file.content : blobFor(repo, file.content), stage: 0, path };
    const at = entries.findIndex((e) => e.path === path && e.stage === 0);
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
  }
  writeIndex(repo, entries);
  return entries;
}

/** Replace the index with exactly these files, as `git read-tree` would. */
export function setIndexTo(repo: Repo, files: Map<string, TreeEntry>): void {
  writeIndex(
    repo,
    [...files].map(([path, e]) => ({ mode: e.mode, oid: e.oid, stage: 0, path })),
  );
}

// ---------------------------------------------------------------------------
// checkout

export function writeWorkingFile(repo: Repo, path: string, content: string, mode: string): void {
  const full = `${repo.root}/${path}`;
  const dir = parentPath(full);
  if (!getNode(repo.lx, dir)) makeDir(repo.lx, dir, true);
  writeFile(repo.lx, full, content, false, 'git');
  const node = getNode(repo.lx, full);
  if (node) node.mode = mode === '100755' ? 0o755 : 0o644;
}

export function removeWorkingFile(repo: Repo, path: string): void {
  const full = `${repo.root}/${path}`;
  if (getNode(repo.lx, full)) removeNode(repo.lx, full, false, 'git');
  // Tidy up directories the file left empty, as git does.
  let dir = parentPath(full);
  while (dir.startsWith(repo.root + '/')) {
    const node = getNode(repo.lx, dir);
    if (!node || node.type !== 'dir') break;
    if (walkFiles(repo.lx, dir).length) break;
    removeNode(repo.lx, dir, true, 'git');
    dir = parentPath(dir);
  }
}

/**
 * Make the working tree and the index match a tree.
 *
 * With `carry`, a path whose index entry already matches the target is left alone,
 * so uncommitted changes to files the two trees agree on travel with you, as they
 * do in git. Callers that carry must have refused first when a change would be
 * overwritten (see blockingChanges). Without it the tree simply wins, which is what
 * reset --hard and the abort commands want.
 */
export function checkoutTree(repo: Repo, treeOid: Oid | null, opts: { carry?: boolean } = {}): void {
  const target = treeFiles(repo, treeOid);
  const entries = readIndex(repo);
  const current = indexMap(entries);
  const sparse = sparseDirs(repo);
  for (const [path, entry] of current) {
    if (target.has(path)) continue;
    if (entry.mode === GITLINK) continue;
    removeWorkingFile(repo, path);
  }
  const kept = new Map<string, IndexEntry>();
  for (const [path, entry] of target) {
    const now = current.get(path);
    if (opts.carry && now && now.oid === entry.oid && now.mode === entry.mode) {
      kept.set(path, now);
      continue;
    }
    // A submodule is a directory git leaves to the submodule; a sparse checkout
    // leaves out what it was told to.
    if (entry.mode === GITLINK) {
      if (!getNode(repo.lx, `${repo.root}/${path}`)) makeDir(repo.lx, `${repo.root}/${path}`, true);
      continue;
    }
    if (!inSparse(repo, path, sparse)) {
      if (getNode(repo.lx, `${repo.root}/${path}`)) removeWorkingFile(repo, path);
      continue;
    }
    writeWorkingFile(repo, path, readBlob(repo, entry.oid) ?? '', entry.mode);
  }
  writeIndex(
    repo,
    [...target].map(([path, e]) => kept.get(path) ?? { mode: e.mode, oid: e.oid, stage: 0, path }),
  );
}

/**
 * What stops HEAD moving to a tree: tracked files with uncommitted changes that the
 * move would overwrite, and untracked files that the target would put something on
 * top of. Git refuses rather than lose either.
 */
export function blockingChanges(repo: Repo, targetTree: Oid | null): { dirty: string[]; untracked: string[] } {
  const status = statusOf(repo);
  const current = treeFiles(repo, headTree(repo));
  const target = treeFiles(repo, targetTree);
  const changed = (p: string) => current.get(p)?.oid !== target.get(p)?.oid || current.get(p)?.mode !== target.get(p)?.mode;
  const dirty = [...new Set([...status.staged, ...status.unstaged].map((c) => c.path))].filter(changed).sort();
  const untracked = status.untracked.filter((p) => target.has(p)).sort();
  return { dirty, untracked };
}

/** The error git prints when local changes would be lost, for a checkout or a merge. */
export function blockingMessage(blocked: { dirty: string[]; untracked: string[] }, action: 'checkout' | 'merge'): string | null {
  const lines: string[] = [];
  if (blocked.dirty.length) {
    lines.push(`error: Your local changes to the following files would be overwritten by ${action}:`, ...blocked.dirty.map((p) => `\t${p}`));
    lines.push(action === 'checkout' ? 'Please commit your changes or stash them before you switch branches.' : 'Please commit your changes or stash them before you merge.');
  }
  if (blocked.untracked.length) {
    lines.push(`error: The following untracked working tree files would be overwritten by ${action}:`, ...blocked.untracked.map((p) => `\t${p}`));
    lines.push(action === 'checkout' ? 'Please move or remove them before you switch branches.' : 'Please move or remove them before you merge.');
  }
  return lines.length ? [...lines, 'Aborting'].join('\n') : null;
}

export function readBlob(repo: Repo, oid: Oid): string | null {
  const stored = slurp(repo.lx, `${repo.commonDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
  if (stored === null) return null;
  const nul = stored.indexOf('\0');
  return nul < 0 ? null : stored.slice(nul + 1);
}

/** Write a file into the repository's git directory (MERGE_HEAD and friends). */
export function putGitFile(repo: Repo, name: string, content: string): void {
  put(repo.lx, `${repo.gitDir}/${name}`, content);
}

export function removeGitFile(repo: Repo, name: string): void {
  if (getNode(repo.lx, `${repo.gitDir}/${name}`)) removeNode(repo.lx, `${repo.gitDir}/${name}`, false, 'git');
}

/** Is this path known to git: staged, or in the commit HEAD points at? */
export function isTracked(repo: Repo, path: string): boolean {
  return indexMap(readIndex(repo)).has(path) || treeFiles(repo, headTree(repo)).has(path);
}

/**
 * Bring the working tree in line with the sparse-checkout rules: write files that
 * are now included and missing, remove excluded files that have no local changes.
 */
export function reapplySparse(repo: Repo): void {
  const dirs = sparseDirs(repo);
  for (const entry of indexMap(readIndex(repo)).values()) {
    if (entry.mode === GITLINK) continue;
    const full = `${repo.root}/${entry.path}`;
    const present = getNode(repo.lx, full);
    if (inSparse(repo, entry.path, dirs)) {
      if (!present) writeWorkingFile(repo, entry.path, readBlob(repo, entry.oid) ?? '', entry.mode);
    } else if (present && hashBlob(slurp(repo.lx, full) ?? '') === entry.oid) removeWorkingFile(repo, entry.path);
  }
}
