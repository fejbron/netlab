/**
 * A repository, kept in the host's filesystem exactly where a learner would look
 * for it: .git/HEAD, .git/config, .git/index, .git/refs/... and .git/objects/...
 * are real files that `cat`, `ls` and `find` can see. Nothing about a repository
 * lives outside the filesystem, so `rm -rf .git` really does destroy it.
 */
import { getNode, listDir, makeDir, normalizePath, parentPath, readFile, removeNode, writeFile, type LinuxState } from '../linux/fs';
import { decodeObject, encodeObject, objectId, sortEntries, type GitObject, type Oid, type TreeEntry } from './objects';

export interface Repo {
  lx: LinuxState;
  /** Absolute path of the working tree, or '' for a bare repository. */
  root: string;
  /** Absolute path of the .git directory (the repository itself when bare). */
  gitDir: string;
  /**
   * Where the shared parts live: objects, refs and config. The same as gitDir except
   * in a linked worktree, whose own .git holds only its HEAD, index and reflog.
   */
  commonDir: string;
  bare: boolean;
}

export interface IndexEntry {
  mode: string;
  oid: Oid;
  /** 0 for an ordinary entry; 1, 2 and 3 are base, ours and theirs during a conflict. */
  stage: number;
  path: string;
}

export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// files

/**
 * The path of a file inside the repository. Refs, objects and config are shared by
 * every worktree of a repository; HEAD, the index and the merge state are not.
 */
export function gitPath(repo: Repo, name: string): string {
  const shared =
    name.startsWith('refs/') ||
    name.startsWith('objects') ||
    name === 'config' ||
    name.startsWith('logs/refs/') ||
    name === 'stash-list' ||
    name.startsWith('info/') ||
    name.startsWith('modules/') ||
    name.startsWith('worktrees') ||
    name === 'description';
  return `${shared ? repo.commonDir : repo.gitDir}/${name}`;
}

/** Write inside the repository, creating the directories it needs. */
export function put(lx: LinuxState, path: string, content: string): void {
  const dir = parentPath(path);
  if (!getNode(lx, dir)) makeDir(lx, dir, true);
  writeFile(lx, path, content, false, 'git');
}

export function slurp(lx: LinuxState, path: string): string | null {
  const node = getNode(lx, path);
  if (!node || node.type === 'dir') return null;
  const r = readFile({ ...lx, user: 'root' }, path);
  return 'error' in r ? null : r.content;
}

/** Every file under a directory, as paths relative to it, ignoring .git. */
export function walkFiles(lx: LinuxState, dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of listDir({ ...lx, user: 'root' }, dir).sort()) {
    if (name === '.git') continue;
    const full = `${dir}/${name}`;
    const node = getNode(lx, full);
    if (!node) continue;
    // A directory with its own .git is a nested repository (a submodule): report the
    // directory itself rather than walking into files that belong to another repository.
    if (node.type === 'dir' && getNode(lx, `${full}/.git`)) out.push(`${prefix}${name}`);
    else if (node.type === 'dir') out.push(...walkFiles(lx, full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// finding and creating

/** The repository that owns `cwd`, found by walking up for a .git directory. */
export function findRepo(lx: LinuxState, cwd: string): Repo | null {
  let dir = normalizePath(cwd, cwd, '/root');
  for (;;) {
    const git = `${dir}/.git`;
    const node = getNode(lx, git);
    if (node?.type === 'dir') return { lx, root: dir, gitDir: git, commonDir: git, bare: false };
    // A linked worktree has a .git file naming its own directory inside the main
    // repository, which in turn names the repository it shares objects with.
    if (node?.type === 'file') {
      const m = /^gitdir:\s*(.+)$/m.exec(node.content);
      if (m) {
        const gitDir = normalizePath(dir, m[1].trim(), '/root');
        const common = slurp(lx, `${gitDir}/commondir`)?.trim();
        const commonDir = common ? normalizePath(gitDir, common, '/root') : gitDir;
        return { lx, root: dir, gitDir, commonDir, bare: false };
      }
    }
    // A bare repository is its own git directory: it holds HEAD and objects directly.
    if (getNode(lx, `${dir}/HEAD`) && getNode(lx, `${dir}/objects`)) return { lx, root: '', gitDir: dir, commonDir: dir, bare: true };
    if (dir === '' || dir === '/') return null;
    dir = parentPath(dir);
  }
}

export function initRepo(lx: LinuxState, dir: string, opts: { bare?: boolean; branch?: string } = {}): Repo {
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const gitDir = opts.bare ? dir : `${dir}/.git`;
  for (const d of ['objects', 'refs/heads', 'refs/tags', 'logs']) makeDir(lx, `${gitDir}/${d}`, true);
  put(lx, `${gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
  put(lx, `${gitDir}/description`, "Unnamed repository; edit this file 'description' to name the repository.\n");
  put(lx, `${gitDir}/config`, `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${opts.bare ? 'true' : 'false'}\n`);
  return { lx, root: opts.bare ? '' : dir, gitDir, commonDir: gitDir, bare: Boolean(opts.bare) };
}

// ---------------------------------------------------------------------------
// objects

export function objectPath(repo: Repo, oid: Oid): string {
  return `${repo.commonDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
}

export function hasObject(repo: Repo, oid: Oid): boolean {
  return Boolean(getNode(repo.lx, objectPath(repo, oid)));
}

export function writeObject(repo: Repo, o: GitObject): Oid {
  const oid = objectId(o);
  if (!hasObject(repo, oid)) put(repo.lx, objectPath(repo, oid), encodeObject(o));
  return oid;
}

/**
 * Decoded objects, keyed by id. An id is the hash of the content, so an object can
 * never change under the cache; the only risk is holding memory for a repository
 * nobody is using any more, which a lab-sized store does not make worth solving.
 */
const objectCache = new Map<Oid, GitObject>();

export function readObject(repo: Repo, oid: Oid): GitObject | null {
  const path = objectPath(repo, oid);
  // The repository has to hold the object: two repositories can build the same id
  // from the same content, and one having it says nothing about the other. The
  // lookup is a single key, so this costs nothing next to decoding it again.
  if (!repo.lx.fs[path]) return null;
  const cached = objectCache.get(oid);
  if (cached) return cached;
  const stored = slurp(repo.lx, path);
  if (stored === null) return null;
  const object = decodeObject(stored);
  if (object) {
    if (objectCache.size > 20000) objectCache.clear();
    objectCache.set(oid, object);
  }
  return object;
}

export function readCommit(repo: Repo, oid: Oid) {
  const o = readObject(repo, oid);
  return o?.type === 'commit' ? o.commit : null;
}

export function readTree(repo: Repo, oid: Oid): TreeEntry[] | null {
  const o = readObject(repo, oid);
  return o?.type === 'tree' ? o.entries : null;
}

/** Every object id in the store, for prefix matching and for push. */
export function allObjects(repo: Repo): Oid[] {
  const prefix = `${repo.commonDir}/objects/`;
  // One pass over the filesystem keys: a listDir per directory is O(files) each,
  // and this is called often enough for that to dominate everything else.
  const out: Oid[] = [];
  for (const key of Object.keys(repo.lx.fs)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.length === 41 && rest[2] === '/') out.push(rest[0] + rest[1] + rest.slice(3));
  }
  return out;
}

// ---------------------------------------------------------------------------
// refs and HEAD

/** Names that are refs: HEAD, anything under refs/, and the pseudo-refs git writes. */
const PSEUDO_REFS = new Set(['HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'FETCH_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_HEAD']);

export function readRef(repo: Repo, name: string): Oid | null {
  // Without this, a file called config or index would resolve as a revision.
  if (!name.startsWith('refs/') && !PSEUDO_REFS.has(name)) return null;
  const text = slurp(repo.lx, gitPath(repo, name));
  if (text === null) return null;
  const value = text.trim();
  return value.startsWith('ref: ') ? readRef(repo, value.slice(5).trim()) : value || null;
}

export function writeRef(repo: Repo, name: string, oid: Oid): void {
  put(repo.lx, gitPath(repo, name), `${oid}\n`);
}

export function deleteRef(repo: Repo, name: string): void {
  const path = gitPath(repo, name);
  if (getNode(repo.lx, path)) removeNode(repo.lx, path, false, 'git');
}

/** Full ref names under a prefix such as 'refs/heads', in name order. */
export function listRefs(repo: Repo, prefix: string): Array<{ name: string; oid: Oid }> {
  const base = `${gitPath(repo, prefix)}/`;
  const out: Array<{ name: string; oid: Oid }> = [];
  for (const key of Object.keys(repo.lx.fs)) {
    if (!key.startsWith(base)) continue;
    if (repo.lx.fs[key].type !== 'file') continue;
    const name = `${prefix}/${key.slice(base.length)}`;
    const oid = readRef(repo, name);
    if (oid) out.push({ name, oid });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What HEAD points at: a branch it follows, or a commit it names directly. */
export function head(repo: Repo): { branch: string | null; oid: Oid | null } {
  const text = slurp(repo.lx, `${repo.gitDir}/HEAD`)?.trim() ?? '';
  if (text.startsWith('ref: ')) {
    const ref = text.slice(5).trim();
    return { branch: ref, oid: readRef(repo, ref) };
  }
  return { branch: null, oid: text || null };
}

export function setHeadBranch(repo: Repo, ref: string): void {
  put(repo.lx, `${repo.gitDir}/HEAD`, `ref: ${ref}\n`);
}

export function setHeadDetached(repo: Repo, oid: Oid): void {
  put(repo.lx, `${repo.gitDir}/HEAD`, `${oid}\n`);
}

/** Move whatever HEAD is on: the branch it follows, or HEAD itself when detached. */
export function moveHead(repo: Repo, oid: Oid): void {
  const h = head(repo);
  if (h.branch) writeRef(repo, h.branch, oid);
  else setHeadDetached(repo, oid);
}

/**
 * The working tree that already has this branch checked out, other than this one.
 * Git allows a branch in one worktree at a time, so the second is refused.
 */
export function checkedOutElsewhere(repo: Repo, ref: string): string | null {
  const heads: Array<{ head: string; where: string }> = [];
  // The main worktree's HEAD lives in the common directory.
  if (repo.gitDir !== repo.commonDir) {
    const main = slurp(repo.lx, `${repo.commonDir}/HEAD`)?.trim() ?? '';
    heads.push({ head: main, where: parentPath(repo.commonDir) });
  }
  const prefix = `${repo.commonDir}/worktrees/`;
  for (const key of Object.keys(repo.lx.fs)) {
    if (!key.startsWith(prefix) || !key.endsWith('/HEAD')) continue;
    const dir = key.slice(0, -'/HEAD'.length);
    if (dir === repo.gitDir || dir.slice(prefix.length).includes('/')) continue;
    const gitdir = slurp(repo.lx, `${dir}/gitdir`)?.trim() ?? '';
    heads.push({ head: repo.lx.fs[key].content.trim(), where: gitdir.replace(/\/\.git$/, '') });
  }
  const found = heads.find((h) => h.head === `ref: ${ref}`);
  return found ? found.where : null;
}

export function branchName(ref: string | null): string | null {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

// ---------------------------------------------------------------------------
// the reflog

/** Append to .git/logs/<ref>, in git's own format, so `git reflog` can read it back. */
export function logRef(repo: Repo, ref: string, from: Oid | null, to: Oid, who: string, message: string, when: number): void {
  const path = gitPath(repo, `logs/${ref}`);
  const before = slurp(repo.lx, path) ?? '';
  const line = `${from ?? '0'.repeat(40)} ${to} ${who} ${when} +0000\t${message}\n`;
  const dir = parentPath(path);
  if (!getNode(repo.lx, dir)) makeDir(repo.lx, dir, true);
  writeFile(repo.lx, path, before + line, false, 'git');
}

export interface ReflogEntry {
  from: Oid;
  to: Oid;
  message: string;
}

export function readReflog(repo: Repo, ref: string): ReflogEntry[] {
  const text = slurp(repo.lx, gitPath(repo, `logs/${ref}`));
  if (text === null) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ids, message = ''] = line.split('\t');
      const parts = ids.split(' ');
      return { from: parts[0], to: parts[1], message };
    });
}

// ---------------------------------------------------------------------------
// config

/** .git/config is a real INI file, so `git config` and `cat .git/config` agree. */
export function readConfig(repo: Repo): Record<string, string> {
  return parseConfig(slurp(repo.lx, gitPath(repo, 'config')) ?? '');
}

/** Parse git's INI dialect: [section], [section "sub"], key = value. */
export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      // [remote "origin"] is the section remote.origin
      const parts = header[1].match(/"([^"]*)"|(\S+)/g) ?? [];
      section = parts.map((p) => p.replace(/"/g, '')).join('.');
      continue;
    }
    const at = line.indexOf('=');
    if (at < 0) continue;
    out[`${section}.${line.slice(0, at).trim()}`] = line.slice(at + 1).trim();
  }
  return out;
}

export function writeConfig(repo: Repo, values: Record<string, string>): void {
  const bySection = new Map<string, Array<[string, string]>>();
  for (const [key, value] of Object.entries(values)) {
    const at = key.lastIndexOf('.');
    const section = key.slice(0, at);
    const name = key.slice(at + 1);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push([name, value]);
  }
  const lines: string[] = [];
  for (const [section, entries] of bySection) {
    const parts = section.split('.');
    lines.push(parts.length > 1 ? `[${parts[0]} "${parts.slice(1).join('.')}"]` : `[${section}]`);
    for (const [name, value] of entries) lines.push(`\t${name} = ${value}`);
  }
  put(repo.lx, gitPath(repo, 'config'), lines.join('\n') + '\n');
}

export function configValue(repo: Repo, key: string): string | undefined {
  return readConfig(repo)[key];
}

export function setConfigValue(repo: Repo, key: string, value: string): void {
  const all = readConfig(repo);
  all[key] = value;
  writeConfig(repo, all);
}

// ---------------------------------------------------------------------------
// the index

export function readIndex(repo: Repo): IndexEntry[] {
  const text = slurp(repo.lx, `${repo.gitDir}/index`);
  if (text === null) return [];
  const out: IndexEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d{6}) ([0-9a-f]{40}) (\d)\t(.*)$/.exec(line);
    if (m) out.push({ mode: m[1], oid: m[2], stage: Number(m[3]), path: m[4] });
  }
  return out;
}

/** Stored in the form `git ls-files -s` prints, sorted by path then stage. */
export function writeIndex(repo: Repo, entries: IndexEntry[]): void {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage - b.stage));
  put(repo.lx, `${repo.gitDir}/index`, sorted.map((e) => `${e.mode} ${e.oid} ${e.stage}\t${e.path}`).join('\n') + (sorted.length ? '\n' : ''));
}

export function indexMap(entries: IndexEntry[]): Map<string, IndexEntry> {
  const m = new Map<string, IndexEntry>();
  for (const e of entries) if (e.stage === 0) m.set(e.path, e);
  return m;
}

export function conflicted(entries: IndexEntry[]): string[] {
  return [...new Set(entries.filter((e) => e.stage > 0).map((e) => e.path))].sort();
}

// ---------------------------------------------------------------------------
// trees

/** Flatten a tree to path → entry, walking subdirectories. */
export function treeFiles(repo: Repo, treeOid: Oid | null, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  if (!treeOid) return out;
  for (const e of readTree(repo, treeOid) ?? []) {
    if (e.mode === '040000') for (const [p, sub] of treeFiles(repo, e.oid, `${prefix}${e.name}/`)) out.set(p, sub);
    else out.set(`${prefix}${e.name}`, e);
  }
  return out;
}

/** Build tree objects from a flat path → entry map, and return the root tree id. */
export function buildTree(repo: Repo, files: Map<string, TreeEntry>): Oid {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { files: [], dirs: new Map() });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push({ ...entry, name: parts[parts.length - 1] });
  }
  const write = (dir: Dir): Oid => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '040000', name, oid: write(sub) });
    return writeObject(repo, { type: 'tree', entries: sortEntries(entries) });
  };
  return write(root);
}

export function treeFromIndex(repo: Repo): Oid {
  const files = new Map<string, TreeEntry>();
  for (const e of indexMap(readIndex(repo)).values()) files.set(e.path, { mode: e.mode, name: e.path.split('/').pop()!, oid: e.oid });
  return buildTree(repo, files);
}

export function headTree(repo: Repo): Oid | null {
  const h = head(repo);
  return h.oid ? (readCommit(repo, h.oid)?.tree ?? null) : null;
}
