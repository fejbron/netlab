/**
 * Commands beyond the everyday set: listing and describing history, searching it,
 * annotating it with notes, checking and tidying the object store, archiving a
 * tree, and bisecting to find the commit that broke something.
 */
import { makeDir, normalizePath, removeNode, writeFile } from '../linux/fs';
import { diffOfCommit } from './common';
import { diffStat, statLines } from './diff';
import { EPOCH, formatDate, has, type Io, message, parseFlags, type GitEnv } from './io';
import { encodeObject, entryType, sha1, sortEntries, type Oid, type TreeEntry } from './objects';
import { createCommit, firstLine, GitError, readStash, tick } from './ops';
import {
  allObjects,
  deleteRef,
  gitPath,
  head,
  indexMap,
  listRefs,
  objectPath,
  put,
  readCommit,
  readIndex,
  readObject,
  readReflog,
  readRef,
  readTree,
  setHeadBranch,
  setHeadDetached,
  slurp,
  treeFiles,
  writeObject,
  writeRef,
  type Repo,
} from './repo';
import { ancestors, mergeBase, peel, resolveRev, shortId, walk } from './revs';
import { writeTar } from './tar';
import { checkoutTree, readBlob, removeGitFile, putGitFile } from './worktree';

// ---------------------------------------------------------------------------
// ranges: A..B, A...B, ^A

export interface Range {
  include: Oid[];
  exclude: Oid[];
}

/** Turn revision arguments into commits to include and commits to leave out. */
export function parseRange(repo: Repo, specs: string[]): Range {
  const include: Oid[] = [];
  const exclude: Oid[] = [];
  const need = (text: string): Oid => {
    const oid = resolveRev(repo, text || 'HEAD');
    if (!oid) throw new GitError(`fatal: ambiguous argument '${text}': unknown revision or path not in the working tree.`);
    return oid;
  };
  for (const spec of specs) {
    if (spec.includes('...')) {
      const [a, b] = spec.split('...');
      const left = need(a);
      const right = need(b);
      include.push(left, right);
      const base = mergeBase(repo, left, right);
      if (base) exclude.push(base);
    } else if (spec.includes('..')) {
      const [a, b] = spec.split('..');
      exclude.push(need(a));
      include.push(need(b));
    } else if (spec.startsWith('^')) exclude.push(need(spec.slice(1)));
    else include.push(need(spec));
  }
  return { include, exclude };
}

export function isRangeSpec(spec: string): boolean {
  return spec.includes('..') || spec.startsWith('^');
}

export function commitsIn(repo: Repo, range: Range, opts: { firstParent?: boolean } = {}): Oid[] {
  const excluded = new Set<Oid>();
  for (const oid of range.exclude) for (const a of ancestors(repo, oid)) excluded.add(a);
  return walk(repo, range.include, opts).filter((oid) => !excluded.has(oid));
}

// ---------------------------------------------------------------------------
// rev-list

export function cmdRevList(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const specs = [...f.rest];
  if (has(f, 'all')) for (const r of [...listRefs(repo, 'refs/heads'), ...listRefs(repo, 'refs/tags'), ...listRefs(repo, 'refs/remotes')]) specs.push(r.oid);
  if (!specs.length) throw new GitError('usage: git rev-list [<options>] <commit>... [--] [<path>...]');
  let list = commitsIn(repo, parseRange(repo, specs), { firstParent: has(f, 'first-parent') });
  if (has(f, 'merges')) list = list.filter((oid) => (readCommit(repo, oid)?.parents.length ?? 0) > 1);
  if (has(f, 'no-merges')) list = list.filter((oid) => (readCommit(repo, oid)?.parents.length ?? 0) <= 1);
  const limit = Number(f.values.n ?? f.values['max-count'] ?? 0);
  if (limit > 0) list = list.slice(0, limit);
  if (has(f, 'reverse')) list = list.reverse();
  if (has(f, 'count')) return void io.print(String(list.length));
  for (const oid of list) io.print(has(f, 'oneline') ? `${shortId(repo, oid)} ${firstLine(readCommit(repo, oid)?.message ?? '')}` : oid);
}

// ---------------------------------------------------------------------------
// describe

export function cmdDescribe(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const rev = f.rest[0] ?? 'HEAD';
  const target = resolveRev(repo, rev);
  if (!target) throw new GitError(`fatal: Not a valid object name ${rev}`);
  const abbrev = Number(f.values.abbrev ?? 7);
  const reach = ancestors(repo, target);

  const tags = listRefs(repo, 'refs/tags').map((t) => ({ name: t.name.slice('refs/tags/'.length), ref: t.oid, commit: peel(repo, t.oid), annotated: readObject(repo, t.oid)?.type === 'tag' }));
  const usable = tags.filter((t) => (has(f, 'tags') || t.annotated) && reach.has(t.commit));
  if (!usable.length) {
    if (has(f, 'always')) return void io.print(target.slice(0, Math.max(abbrev, 4)));
    if (!has(f, 'tags') && tags.some((t) => !t.annotated && reach.has(t.commit))) {
      throw new GitError(`fatal: No annotated tags can describe '${target}'.\nHowever, there were unannotated tags: try --tags.`);
    }
    throw new GitError('fatal: No names found, cannot describe anything.');
  }
  // The nearest tag is the one with the fewest commits between it and the target.
  let best = usable[0];
  let bestDistance = Infinity;
  for (const tag of usable) {
    const below = ancestors(repo, tag.commit);
    const distance = [...reach].filter((oid) => !below.has(oid)).length;
    if (distance < bestDistance) {
      best = tag;
      bestDistance = distance;
    }
  }
  if (bestDistance === 0 && !has(f, 'long')) return void io.print(best.name);
  io.print(`${best.name}-${bestDistance}-g${target.slice(0, Math.max(abbrev, 4))}`);
}

// ---------------------------------------------------------------------------
// grep

export function cmdGrep(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args, new Set(['e']));
  const rest = [...f.rest];
  const pattern = f.values.e ?? rest.shift();
  if (pattern === undefined) throw new GitError('fatal: no pattern given');
  const revs = rest.filter((r) => resolveRev(repo, r));
  const pathSpecs = [...f.paths, ...rest.filter((r) => !resolveRev(repo, r))];
  let re: RegExp;
  try {
    const source = has(f, 'F', 'fixed-strings') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    re = new RegExp(has(f, 'w', 'word-regexp') ? `\\b(?:${source})\\b` : source, has(f, 'i', 'ignore-case') ? 'i' : '');
  } catch {
    throw new GitError(`fatal: command line, '${pattern}': Invalid regular expression`);
  }
  const inScope = (path: string) => !pathSpecs.length || pathSpecs.some((p) => path === p || path.startsWith(p.replace(/\/$/, '') + '/'));

  // Each source is a set of files and a prefix for the output: the working tree
  // (tracked files only, as git grep does), or a named revision.
  const sources: Array<{ prefix: string; files: Array<[string, string]> }> = [];
  if (revs.length) {
    for (const rev of revs) {
      const oid = resolveRev(repo, rev)!;
      const files: Array<[string, string]> = [];
      for (const [path, entry] of treeFiles(repo, readCommit(repo, oid)?.tree ?? null)) if (inScope(path)) files.push([path, readBlob(repo, entry.oid) ?? '']);
      sources.push({ prefix: `${rev}:`, files });
    }
  } else {
    const files: Array<[string, string]> = [];
    for (const path of indexMap(readIndex(repo)).keys()) {
      if (!inScope(path)) continue;
      const content = slurp(repo.lx, `${repo.root}/${path}`);
      if (content !== null) files.push([path, content]);
    }
    sources.push({ prefix: '', files });
  }

  // Paths print relative to where the command ran, as git does.
  const here = env.cwd.startsWith(repo.root) ? env.cwd.slice(repo.root.length).replace(/^\//, '') : '';
  const shown = (path: string) => (here && path.startsWith(here + '/') ? path.slice(here.length + 1) : here ? `${'../'.repeat(here.split('/').length)}${path}` : path);

  let matched = false;
  for (const source of sources) {
    for (const [path, content] of source.files.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const lines = content.replace(/\n$/, '').split('\n');
      const hits = lines.map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => re.test(line) !== has(f, 'v', 'invert-match'));
      if (!hits.length) continue;
      matched = true;
      const name = source.prefix + shown(path);
      if (has(f, 'l', 'files-with-matches', 'name-only')) io.print(name);
      else if (has(f, 'c', 'count')) io.print(`${name}:${hits.length}`);
      else for (const hit of hits) io.print(`${name}:${has(f, 'n', 'line-number') ? `${hit.n}:` : ''}${hit.line}`);
    }
  }
  if (!matched) io.code = 1;
}

// ---------------------------------------------------------------------------
// notes

const NOTES_REF = 'refs/notes/commits';

function notesTree(repo: Repo): Map<string, TreeEntry> {
  const tip = readRef(repo, NOTES_REF);
  const tree = tip ? (readCommit(repo, tip)?.tree ?? null) : null;
  return new Map((tree ? (readTree(repo, tree) ?? []) : []).map((e) => [e.name, e]));
}

/** The note attached to a commit, if there is one. `git log` shows it too. */
export function noteFor(repo: Repo, oid: Oid): string | null {
  const entry = notesTree(repo).get(oid);
  return entry ? readBlob(repo, entry.oid) : null;
}

function writeNotes(repo: Repo, entries: Map<string, TreeEntry>, why: string): void {
  const tree = writeObject(repo, { type: 'tree', entries: sortEntries([...entries.values()]) });
  const parent = readRef(repo, NOTES_REF);
  const oid = createCommit(repo, { tree, parents: parent ? [parent] : [], message: `Notes added by 'git notes ${why}'` });
  writeRef(repo, NOTES_REF, oid);
}

export function cmdNotes(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] && ['add', 'append', 'show', 'list', 'remove', 'edit', 'copy'].includes(f.rest[0]) ? f.rest[0] : 'list';
  const revArg = f.rest[0] === action ? f.rest[1] : f.rest[0];
  const target = resolveRev(repo, revArg ?? 'HEAD');
  if (!target) throw new GitError(`error: failed to resolve '${revArg}' as a valid ref.`);
  const entries = notesTree(repo);
  const text = message(f);

  switch (action) {
    case 'list': {
      if (revArg) {
        const entry = entries.get(target);
        if (!entry) throw new GitError(`error: no note found for object ${target}.`);
        return void io.print(entry.oid);
      }
      for (const entry of entries.values()) io.print(`${entry.oid} ${entry.name}`);
      return;
    }
    case 'show': {
      const note = noteFor(repo, target);
      if (note === null) throw new GitError(`error: no note found for object ${target}.`);
      return void io.print(...note.replace(/\n$/, '').split('\n'));
    }
    case 'add':
    case 'append': {
      if (!text) throw new GitError('hint: NetLab has no editor, so the note has to be given with -m.\nfatal: no note message given');
      const existing = entries.get(target);
      if (action === 'add' && existing && !has(f, 'f', 'force')) {
        throw new GitError(`error: Cannot add notes. Found existing notes for object ${target}. Use '-f' to overwrite existing notes`);
      }
      const before = existing && action === 'append' ? (readBlob(repo, existing.oid) ?? '').replace(/\n$/, '') + '\n\n' : '';
      const blob = writeObject(repo, { type: 'blob', content: `${before}${text}\n` });
      entries.set(target, { mode: '100644', name: target, oid: blob });
      writeNotes(repo, entries, action);
      if (existing && action === 'add') io.err.push(`Overwriting existing notes for object ${target}`);
      return;
    }
    case 'remove': {
      if (!entries.has(target)) throw new GitError(`error: Object ${target} has no note`);
      entries.delete(target);
      writeNotes(repo, entries, 'remove');
      io.print(`Removing note for object ${target}`);
      return;
    }
    case 'edit':
      throw new GitError('hint: NetLab has no editor. Replace the note with: git notes add -f -m "..."\nfatal: git notes edit needs an editor');
    case 'copy': {
      const to = resolveRev(repo, f.rest[2] ?? 'HEAD');
      const from = entries.get(target);
      if (!from || !to) throw new GitError(`error: missing notes on source object ${target}. Cannot copy.`);
      entries.set(to, { ...from, name: to });
      writeNotes(repo, entries, 'copy');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// the object store: what is reachable, and checking and tidying it

/** Every object a repository can still reach, from refs, HEAD, the stash and (unless expired) the reflogs. */
export function reachableObjects(repo: Repo, opts: { reflogs?: boolean } = {}): Set<Oid> {
  const tips = new Set<Oid>();
  for (const prefix of ['refs/heads', 'refs/tags', 'refs/remotes', 'refs/notes', 'refs/original', 'refs/bisect']) for (const r of listRefs(repo, prefix)) tips.add(r.oid);
  const h = head(repo).oid;
  if (h) tips.add(h);
  for (const name of ['ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'FETCH_HEAD']) {
    const text = slurp(repo.lx, `${repo.gitDir}/${name}`)?.trim().split(/\s+/)[0];
    if (text && /^[0-9a-f]{40}$/.test(text)) tips.add(text);
  }
  for (const entry of readStash(repo)) tips.add(entry.oid);
  if (opts.reflogs !== false) {
    const logRefs = ['HEAD', ...listRefs(repo, 'refs/heads').map((r) => r.name)];
    for (const ref of logRefs) for (const e of readReflog(repo, ref)) if (/^[0-9a-f]{40}$/.test(e.to) && !/^0+$/.test(e.to)) tips.add(e.to);
  }

  const out = new Set<Oid>();
  const addTree = (oid: Oid) => {
    if (out.has(oid)) return;
    out.add(oid);
    for (const e of readTree(repo, oid) ?? []) {
      if (e.mode === '040000') addTree(e.oid);
      else if (e.mode !== '160000') out.add(e.oid);
    }
  };
  for (const tip of tips) {
    let oid: Oid = tip;
    // Follow annotated tags down to what they name.
    for (let i = 0; i < 10; i++) {
      const o = readObject(repo, oid);
      if (o?.type !== 'tag') break;
      out.add(oid);
      oid = o.tag.object;
    }
    for (const c of walk(repo, [oid])) {
      out.add(c);
      const commit = readCommit(repo, c);
      if (commit) addTree(commit.tree);
    }
  }
  return out;
}

function removeObject(repo: Repo, oid: Oid): void {
  const path = objectPath(repo, oid);
  if (repo.lx.fs[path]) removeNode(repo.lx, path, false, 'git');
}

export function cmdCountObjects(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const all = allObjects(repo);
  const bytes = all.reduce((n, oid) => n + (repo.lx.fs[objectPath(repo, oid)]?.content.length ?? 0), 0);
  const kb = Math.ceil(bytes / 1024);
  if (!has(f, 'v', 'verbose')) return void io.print(`${all.length} objects, ${kb} kilobytes`);
  io.print(`count: ${all.length}`, `size: ${kb}`, 'in-pack: 0', 'packs: 0', 'size-pack: 0', 'prune-packable: 0', 'garbage: 0', 'size-garbage: 0');
}

export function cmdFsck(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const all = allObjects(repo);
  const present = new Set(all);
  let problems = 0;
  io.err.push(`Checking object directories: 100% (256/256), done.`);
  for (const oid of all) {
    const stored = repo.lx.fs[objectPath(repo, oid)]?.content ?? '';
    // The id is the hash of the stored bytes; anything else means the file was changed.
    if (sha1(stored) !== oid) {
      io.print(`error: hash mismatch for ${objectPath(repo, oid).replace(`${repo.root}/`, '')} (expected ${oid})`);
      problems++;
      continue;
    }
    const object = readObject(repo, oid);
    if (!object) {
      io.print(`error: unable to parse object ${oid}`);
      problems++;
      continue;
    }
    if (object.type === 'tree') {
      for (const e of object.entries) {
        if (e.mode === '160000' || present.has(e.oid)) continue;
        io.print(`broken link from    tree ${oid}`, `              to    ${entryType(e.mode)} ${e.oid}`, `missing ${entryType(e.mode)} ${e.oid}`);
        problems++;
      }
    }
    if (object.type === 'commit') {
      for (const ref of [object.commit.tree, ...object.commit.parents]) {
        if (present.has(ref)) continue;
        io.print(`broken link from  commit ${oid}`, `              to  ${ref === object.commit.tree ? 'tree' : 'commit'} ${ref}`, `missing ${ref === object.commit.tree ? 'tree' : 'commit'} ${ref}`);
        problems++;
      }
    }
  }
  // Unreachable objects are fine; the ones nothing else points at are "dangling".
  const reachable = reachableObjects(repo, { reflogs: !has(f, 'no-reflogs') });
  const unreachable = all.filter((oid) => !reachable.has(oid));
  const pointedAt = new Set<Oid>();
  for (const oid of unreachable) {
    const o = readObject(repo, oid);
    if (o?.type === 'commit') {
      pointedAt.add(o.commit.tree);
      for (const p of o.commit.parents) pointedAt.add(p);
    } else if (o?.type === 'tree') for (const e of o.entries) pointedAt.add(e.oid);
    else if (o?.type === 'tag') pointedAt.add(o.tag.object);
  }
  for (const oid of unreachable.sort()) {
    const type = readObject(repo, oid)?.type ?? 'blob';
    if (has(f, 'unreachable')) io.print(`unreachable ${type} ${oid}`);
    else if (!pointedAt.has(oid)) io.print(`dangling ${type} ${oid}`);
  }
  if (problems) io.code = 2;
}

export function cmdPrune(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const reachable = reachableObjects(repo);
  for (const oid of allObjects(repo)) {
    if (reachable.has(oid)) continue;
    if (has(f, 'n', 'dry-run')) io.print(`${oid} ${readObject(repo, oid)?.type ?? 'blob'}`);
    else removeObject(repo, oid);
  }
}

export function cmdGc(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const all = allObjects(repo);
  const reachable = reachableObjects(repo);
  const prune = f.values.prune;
  let removed = 0;
  // Unreachable objects survive a gc for two weeks unless --prune=now says otherwise.
  // Everything in a lab is minutes old, so only --prune=now removes anything.
  if (prune === 'now' || prune === 'all') {
    for (const oid of all) {
      if (reachable.has(oid)) continue;
      removeObject(repo, oid);
      removed++;
    }
  }
  const kept = all.length - removed;
  io.err.push(`Enumerating objects: ${kept}, done.`, `Counting objects: 100% (${kept}/${kept}), done.`, `Writing objects: 100% (${kept}/${kept}), done.`, `Total ${kept} (delta 0), reused 0 (delta 0), pack-reused 0`);
  io.err.push('NetLab keeps objects loose and uncompressed so they stay readable: nothing was packed.');
}

/** `git reflog expire`: forget where refs used to point, which is what lets gc delete lost commits. */
export function reflogExpire(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  if (f.values.expire !== 'now' && f.values['expire-unreachable'] !== 'now') {
    io.err.push('NetLab only supports --expire=now: every entry in a lab is younger than the default 90 days.');
    return;
  }
  const refs = has(f, 'all') ? ['HEAD', ...listRefs(repo, 'refs/heads').map((r) => r.name), ...listRefs(repo, 'refs/remotes').map((r) => r.name)] : f.rest.filter((r) => r !== 'expire').map((r) => (r === 'HEAD' ? r : `refs/heads/${r}`));
  for (const ref of refs) {
    const path = gitPath(repo, `logs/${ref}`);
    if (repo.lx.fs[path]) writeFile(repo.lx, path, '', false, 'git');
  }
}

// ---------------------------------------------------------------------------
// archive

export function cmdArchive(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  if (has(f, 'list', 'l')) return void io.print('tar');
  const output = f.values.o ?? f.values.output;
  const format = f.values.format ?? (output?.match(/\.(tar\.gz|tgz|zip|tar)$/)?.[1] ?? 'tar');
  if (format !== 'tar') throw new GitError(`fatal: Unknown archive format '${format}'\nhint: NetLab writes tar archives only: it has no zip or gzip.`);
  const rev = f.rest[0];
  if (!rev) throw new GitError('usage: git archive [<options>] <tree-ish> [<path>...]');
  const oid = resolveRev(repo, rev);
  if (!oid) throw new GitError(`fatal: not a valid object name: ${rev}`);
  const commit = readCommit(repo, oid);
  const prefix = f.values.prefix ?? '';
  const only = [...f.rest.slice(1), ...f.paths];
  const files = treeFiles(repo, commit?.tree ?? oid);
  const mtime = EPOCH + (commit?.committer.when ?? 0);

  const entries: Parameters<typeof writeTar>[0] = [];
  const dirs = new Set<string>();
  if (prefix.endsWith('/')) dirs.add(prefix.slice(0, -1));
  for (const [path, entry] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.mode === '160000') continue;
    if (only.length && !only.some((p) => path === p || path.startsWith(p.replace(/\/$/, '') + '/'))) continue;
    const parts = (prefix + path).split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) {
        dirs.add(dir);
        entries.push({ name: dir, content: '', mode: 0o755, mtime, type: 'dir' });
      }
    }
    entries.push({ name: prefix + path, content: readBlob(repo, entry.oid) ?? '', mode: entry.mode === '100755' ? 0o755 : 0o644, mtime, type: 'file' });
  }
  const data = writeTar(entries);
  if (output) {
    const path = normalizePath(env.cwd, output, `/home/${env.lx.user}`);
    const e = writeFile(env.lx, path, data, false, 'git');
    if (e) throw new GitError(`fatal: could not create archive file '${output}': ${e.error}`);
    return;
  }
  // Redirected to a file, the lines join back into exactly these bytes.
  io.print(...data.split('\n'));
}

// ---------------------------------------------------------------------------
// bisect

const BISECT = 'BISECT_LOG';

function bisectState(repo: Repo): { start: string | null; bad: Oid | null; good: Oid[]; skip: Oid[] } {
  const start = slurp(repo.lx, `${repo.gitDir}/BISECT_START`)?.trim() ?? null;
  return {
    start,
    bad: readRef(repo, 'refs/bisect/bad'),
    good: listRefs(repo, 'refs/bisect').filter((r) => r.name.startsWith('refs/bisect/good-')).map((r) => r.oid),
    skip: listRefs(repo, 'refs/bisect').filter((r) => r.name.startsWith('refs/bisect/skip-')).map((r) => r.oid),
  };
}

function bisectLog(repo: Repo, line: string): void {
  const before = slurp(repo.lx, `${repo.gitDir}/${BISECT}`) ?? '';
  put(repo.lx, `${repo.gitDir}/${BISECT}`, before + line + '\n');
}

/** Pick the next commit to test, or report the first bad one. */
function bisectNext(io: Io, repo: Repo): 'done' | 'testing' | 'waiting' {
  const state = bisectState(repo);
  if (!state.bad || !state.good.length) {
    if (!state.bad && !state.good.length) return 'waiting';
    io.print(state.bad ? 'status: waiting for good commit(s), bad commit known' : 'status: waiting for bad commit, 1 good commit known');
    return 'waiting';
  }
  const goodSide = new Set<Oid>();
  for (const g of state.good) for (const a of ancestors(repo, g)) goodSide.add(a);
  // Suspects: reachable from the bad commit, not from any good one.
  const suspects = walk(repo, [state.bad]).filter((oid) => !goodSide.has(oid));
  const testable = suspects.filter((oid) => oid !== state.bad && !state.skip.includes(oid));
  if (!testable.length) {
    const only = suspects.filter((oid) => !state.skip.includes(oid));
    if (only.length === 1 || !testable.length) {
      const first = state.bad;
      const commit = readCommit(repo, first)!;
      io.print(`${first} is the first bad commit`, `commit ${first}`, `Author: ${commit.author.name} <${commit.author.email}>`, `Date:   ${formatDate(commit.author.when)}`, '');
      for (const line of commit.message.replace(/\n$/, '').split('\n')) io.print(`    ${line}`);
      io.print('');
      io.print(...statLines(diffOfCommit(repo, first).map(diffStat)));
      bisectLog(repo, `# first bad commit: [${first}] ${firstLine(commit.message)}`);
      return 'done';
    }
  }
  // The best test halves the suspects: the one whose own ancestry among them is closest to half.
  const set = new Set(suspects);
  let best = testable[0];
  let bestScore = Infinity;
  for (const oid of testable) {
    const below = [...ancestors(repo, oid)].filter((a) => set.has(a)).length;
    const score = Math.abs(suspects.length / 2 - below);
    if (score < bestScore) {
      best = oid;
      bestScore = score;
    }
  }
  const left = Math.max(0, Math.floor((suspects.length - 1) / 2));
  const steps = Math.max(0, Math.ceil(Math.log2(Math.max(1, suspects.length))) - 1);
  checkoutTree(repo, readCommit(repo, best)!.tree);
  setHeadDetached(repo, best);
  io.print(`Bisecting: ${left} revision${left === 1 ? '' : 's'} left to test after this (roughly ${steps} step${steps === 1 ? '' : 's'})`, `[${best}] ${firstLine(readCommit(repo, best)?.message ?? '')}`);
  return 'testing';
}

function markBisect(repo: Repo, kind: 'good' | 'bad' | 'skip', rev: string): Oid {
  const oid = resolveRev(repo, rev);
  if (!oid) throw new GitError(`fatal: Needed a single revision\nBad rev input: ${rev}`);
  if (kind === 'bad') writeRef(repo, 'refs/bisect/bad', oid);
  else writeRef(repo, `refs/bisect/${kind}-${oid}`, oid);
  bisectLog(repo, `git bisect ${kind} ${oid}`);
  return oid;
}

export function cmdBisect(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] ?? 'help';
  const terms = { bad: f.values['term-new'] ?? 'bad', good: f.values['term-old'] ?? 'good' };
  const state = bisectState(repo);
  const requireStarted = () => {
    if (!state.start) throw new GitError("You need to start by \"git bisect start\"\n\nYou then need to give me at least one good and one bad revision.\n(You can use \"git bisect bad\" and \"git bisect good\" for that.)");
  };
  switch (action) {
    case 'start': {
      if (state.start) cmdBisect(new (io.constructor as new () => Io)(), repo, env, ['reset']);
      const h = head(repo);
      put(repo.lx, `${repo.gitDir}/BISECT_START`, (h.branch?.replace('refs/heads/', '') ?? h.oid ?? '') + '\n');
      put(repo.lx, `${repo.gitDir}/BISECT_TERMS`, `${terms.bad}\n${terms.good}\n`);
      put(repo.lx, `${repo.gitDir}/${BISECT}`, 'git bisect start\n');
      const [bad, ...goods] = f.rest.slice(1);
      if (bad) markBisect(repo, 'bad', bad);
      for (const g of goods) markBisect(repo, 'good', g);
      if (bad && goods.length) bisectNext(io, repo);
      else io.print(bad ? 'status: waiting for good commit(s), bad commit known' : 'status: waiting for both good and bad commits');
      return;
    }
    case 'bad':
    case 'new':
    case 'good':
    case 'old':
    case 'skip': {
      requireStarted();
      const kind = action === 'new' ? 'bad' : action === 'old' ? 'good' : (action as 'good' | 'bad' | 'skip');
      const revs = f.rest.slice(1).length ? f.rest.slice(1) : ['HEAD'];
      for (const rev of revs) markBisect(repo, kind, rev);
      bisectNext(io, repo);
      return;
    }
    case 'log':
      requireStarted();
      return void io.print(...(slurp(repo.lx, `${repo.gitDir}/${BISECT}`) ?? '').replace(/\n$/, '').split('\n'));
    case 'visualize':
    case 'view': {
      requireStarted();
      const goodSide = new Set<Oid>();
      for (const g of state.good) for (const a of ancestors(repo, g)) goodSide.add(a);
      for (const oid of walk(repo, state.bad ? [state.bad] : [])) if (!goodSide.has(oid)) io.print(`${shortId(repo, oid)} ${firstLine(readCommit(repo, oid)?.message ?? '')}`);
      return;
    }
    case 'reset': {
      if (!state.start) return void io.print('We are not bisecting.');
      const back = f.rest[1] ?? state.start;
      const branchOid = readRef(repo, `refs/heads/${back}`);
      const target = branchOid ?? resolveRev(repo, back);
      if (target) {
        checkoutTree(repo, readCommit(repo, target)!.tree);
        if (branchOid) setHeadBranch(repo, `refs/heads/${back}`);
        else setHeadDetached(repo, target);
      }
      for (const r of listRefs(repo, 'refs/bisect')) deleteRef(repo, r.name);
      for (const name of ['BISECT_START', 'BISECT_TERMS', BISECT, 'BISECT_EXPECTED_REV']) removeGitFile(repo, name);
      io.print(`Previous HEAD position was ${shortId(repo, head(repo).oid ?? target ?? '')} ${firstLine(readCommit(repo, head(repo).oid ?? '')?.message ?? '')}`, branchOid ? `Switched to branch '${back}'` : `HEAD is now at ${shortId(repo, target ?? '')}`);
      return;
    }
    case 'run': {
      requireStarted();
      const script = f.rest.slice(1).join(' ');
      if (!script) throw new GitError('error: "git bisect run" requires a command to run');
      io.print(`running  '${script}'`);
      // Run the command at each candidate: exit 0 is good, 125 is skip, 1-127 is bad.
      for (let guard = 0; guard < 64; guard++) {
        if (!env.run) throw new GitError('fatal: bisect run needs a shell to run the command in');
        const r = env.run(script, repo.root);
        io.print(...r.out, ...r.err);
        const kind = r.code === 0 ? 'good' : r.code === 125 ? 'skip' : r.code < 128 ? 'bad' : null;
        if (!kind) throw new GitError(`bisect run failed:\nexit code ${r.code} from '${script}' is < 0 or >= 128`);
        markBisect(repo, kind, 'HEAD');
        const next = bisectNext(io, repo);
        if (next !== 'testing') {
          if (next === 'done') io.print('bisect found first bad commit');
          return;
        }
        io.print(`running  '${script}'`);
      }
      throw new GitError('bisect run: gave up after 64 steps');
    }
    case 'terms':
      return void io.print(`Your current terms are ${terms.good} for the old state`, `and ${terms.bad} for the new state.`);
    default:
      io.print(
        'usage: git bisect [help|start|bad|good|new|old|terms|skip|reset|visualize|view|replay|log|run]',
        '',
        'git bisect start [<bad> [<good>...]]   start bisecting',
        'git bisect bad|good [<rev>]           mark a commit',
        'git bisect skip [<rev>...]             leave a commit out of the search',
        'git bisect run <cmd>...                let a command decide good or bad',
        'git bisect log                         show what has been marked',
        'git bisect reset [<commit>]            finish, and go back',
      );
  }
  void makeDir;
  void tick;
  void encodeObject;
  void putGitFile;
}
