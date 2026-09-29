/**
 * Several working trees for one repository, working trees that hold only part of
 * the project, and repositories nested inside a repository.
 *
 * A linked worktree is laid out as git lays it out: the new directory holds a .git
 * file naming .git/worktrees/<name> in the main repository, which keeps that
 * worktree's own HEAD and index and points back at the shared objects and refs.
 */
import { getNode, listDir, makeDir, normalizePath, removeNode } from '../linux/fs';
import { has, type Io, parseFlags, type GitEnv } from './io';
import { createBranch, firstLine, GitError } from './ops';
import {
  checkedOutElsewhere,
  configValue,
  findRepo,
  gitPath,
  head,
  indexMap,
  put,
  readCommit,
  readConfig,
  readIndex,
  readRef,
  setConfigValue,
  setHeadBranch,
  setHeadDetached,
  slurp,
  writeConfig,
  type Repo,
} from './repo';
import { cloneInto, isTransportError, openRemote } from './remote';
import { resolveRev, shortId } from './revs';
import { checkoutTree, GITLINK, reapplySparse, stagePaths, statusOf, submoduleHead } from './worktree';

// ---------------------------------------------------------------------------
// worktree

interface Linked {
  name: string;
  path: string;
  dir: string;
}

function linkedWorktrees(repo: Repo): Linked[] {
  const base = `${repo.commonDir}/worktrees`;
  if (!getNode(repo.lx, base)) return [];
  return listDir(repo.lx, base).map((name) => {
    const dir = `${base}/${name}`;
    const gitdir = slurp(repo.lx, `${dir}/gitdir`)?.trim() ?? '';
    return { name, path: gitdir.replace(/\/\.git$/, ''), dir };
  });
}

function describeHead(text: string): string {
  if (text.startsWith('ref: ')) return `[${text.slice(5).replace('refs/heads/', '')}]`;
  return '(detached HEAD)';
}

export function cmdWorktree(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] ?? 'list';
  const mainRoot = repo.commonDir.replace(/\/\.git$/, '');
  switch (action) {
    case 'add': {
      const pathArg = f.rest[1];
      if (!pathArg) throw new GitError('usage: git worktree add [-b <new-branch>] <path> [<commit-ish>]');
      const path = normalizePath(env.cwd, pathArg, `/home/${env.lx.user}`);
      if (getNode(env.lx, path) && listDir(env.lx, path).length) throw new GitError(`fatal: '${pathArg}' already exists`);
      const newBranch = f.values.b ?? f.values.B;
      const commitish = f.rest[2];
      let branch: string | null = null;
      let at: string | null;
      if (newBranch) {
        at = resolveRev(repo, commitish ?? 'HEAD');
        if (!at) throw new GitError(`fatal: invalid reference: ${commitish}`);
        if (readRef(repo, `refs/heads/${newBranch}`) && !f.values.B) throw new GitError(`fatal: a branch named '${newBranch}' already exists`);
        createBranch(repo, newBranch, at);
        branch = newBranch;
      } else if (commitish && readRef(repo, `refs/heads/${commitish}`)) {
        branch = commitish;
        at = readRef(repo, `refs/heads/${commitish}`);
      } else if (commitish) {
        at = resolveRev(repo, commitish);
        if (!at) throw new GitError(`fatal: invalid reference: ${commitish}`);
      } else {
        // With no branch named, git makes one called after the directory.
        const name = path.split('/').pop()!;
        at = head(repo).oid;
        if (!at) throw new GitError('fatal: invalid reference: HEAD');
        if (!has(f, 'detach')) {
          if (!readRef(repo, `refs/heads/${name}`)) createBranch(repo, name, at);
          branch = name;
        }
      }
      if (has(f, 'detach')) branch = null;
      if (branch) {
        const elsewhere = checkedOutElsewhere({ ...repo, gitDir: `${repo.commonDir}/worktrees/.none` }, `refs/heads/${branch}`) ?? (head({ ...repo, gitDir: repo.commonDir }).branch === `refs/heads/${branch}` ? mainRoot : null);
        if (elsewhere) throw new GitError(`fatal: '${branch}' is already used by worktree at '${elsewhere}'`);
      }
      let name = path.split('/').pop()!;
      while (getNode(env.lx, `${repo.commonDir}/worktrees/${name}`)) name += '1';
      const dir = `${repo.commonDir}/worktrees/${name}`;
      makeDir(env.lx, dir, true);
      put(env.lx, `${dir}/commondir`, '../..\n');
      put(env.lx, `${dir}/gitdir`, `${path}/.git\n`);
      put(env.lx, `${dir}/HEAD`, branch ? `ref: refs/heads/${branch}\n` : `${at}\n`);
      if (!getNode(env.lx, path)) makeDir(env.lx, path, true);
      put(env.lx, `${path}/.git`, `gitdir: ${dir}\n`);
      const linked: Repo = { lx: env.lx, root: path, gitDir: dir, commonDir: repo.commonDir, bare: false };
      checkoutTree(linked, readCommit(repo, at!)?.tree ?? null);
      io.print(branch ? (newBranch || !commitish ? `Preparing worktree (new branch '${branch}')` : `Preparing worktree (checking out '${branch}')`) : `Preparing worktree (detached HEAD ${shortId(repo, at!)})`);
      io.print(`HEAD is now at ${shortId(repo, at!)} ${firstLine(readCommit(repo, at!)?.message ?? '')}`);
      return;
    }
    case 'list': {
      const rows: Array<[string, string, string]> = [];
      const mainHead = slurp(env.lx, `${repo.commonDir}/HEAD`)?.trim() ?? '';
      const mainOid = mainHead.startsWith('ref: ') ? readRef(repo, mainHead.slice(5)) : mainHead;
      rows.push([mainRoot, mainOid ? shortId(repo, mainOid) : '0000000', describeHead(mainHead)]);
      for (const w of linkedWorktrees(repo)) {
        const text = slurp(env.lx, `${w.dir}/HEAD`)?.trim() ?? '';
        const oid = text.startsWith('ref: ') ? readRef(repo, text.slice(5)) : text;
        rows.push([w.path, oid ? shortId(repo, oid) : '0000000', describeHead(text) + (getNode(env.lx, w.path) ? '' : ' prunable')]);
      }
      if (has(f, 'porcelain')) {
        for (const [p, , label] of rows) io.print(`worktree ${p}`, label.startsWith('[') ? `branch refs/heads/${label.slice(1, -1)}` : 'detached', '');
        return;
      }
      const width = Math.max(...rows.map((r) => r[0].length));
      for (const [p, oid, label] of rows) io.print(`${p.padEnd(width)}  ${oid} ${label}`);
      return;
    }
    case 'remove': {
      const pathArg = f.rest[1];
      if (!pathArg) throw new GitError('usage: git worktree remove [--force] <worktree>');
      const path = normalizePath(env.cwd, pathArg, `/home/${env.lx.user}`);
      const w = linkedWorktrees(repo).find((x) => x.path === path);
      if (!w) throw new GitError(`fatal: '${pathArg}' is not a working tree`);
      const linked: Repo = { lx: env.lx, root: path, gitDir: w.dir, commonDir: repo.commonDir, bare: false };
      if (getNode(env.lx, path) && !has(f, 'f', 'force')) {
        const s = statusOf(linked);
        if (s.staged.length || s.unstaged.length || s.untracked.length) throw new GitError(`fatal: '${pathArg}' contains modified or untracked files, use --force to delete it`);
      }
      if (getNode(env.lx, path)) removeNode(env.lx, path, true, 'git');
      removeNode(env.lx, w.dir, true, 'git');
      return;
    }
    case 'prune': {
      for (const w of linkedWorktrees(repo)) {
        if (getNode(env.lx, w.path)) continue;
        if (has(f, 'v', 'verbose', 'n', 'dry-run')) io.print(`Removing worktrees/${w.name}: gitdir file points to non-existent location`);
        if (!has(f, 'n', 'dry-run')) removeNode(env.lx, w.dir, true, 'git');
      }
      return;
    }
    case 'move': {
      const [, fromArg, toArg] = f.rest;
      if (!fromArg || !toArg) throw new GitError('usage: git worktree move <worktree> <new-path>');
      const from = normalizePath(env.cwd, fromArg, `/home/${env.lx.user}`);
      const to = normalizePath(env.cwd, toArg, `/home/${env.lx.user}`);
      const w = linkedWorktrees(repo).find((x) => x.path === from);
      if (!w) throw new GitError(`fatal: '${fromArg}' is not a working tree`);
      if (getNode(env.lx, to)) throw new GitError(`fatal: '${toArg}' already exists`);
      // Move every file under the old path to the new one, then repoint the links.
      for (const key of Object.keys(env.lx.fs).filter((k) => k === from || k.startsWith(from + '/')).sort()) {
        env.lx.fs[to + key.slice(from.length)] = env.lx.fs[key];
        delete env.lx.fs[key];
      }
      put(env.lx, `${w.dir}/gitdir`, `${to}/.git\n`);
      return;
    }
    default:
      throw new GitError(`usage: git worktree add [<options>] <path> [<commit-ish>]\n   or: git worktree list [<options>]\n   or: git worktree move <worktree> <new-path>\n   or: git worktree prune [<options>]\n   or: git worktree remove [<options>] <worktree>`);
  }
}

// ---------------------------------------------------------------------------
// sparse-checkout

function sparseFile(repo: Repo): string {
  return gitPath(repo, 'info/sparse-checkout');
}

function readSparse(repo: Repo): string[] {
  return (slurp(repo.lx, sparseFile(repo)) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '/*' && l !== '!/*/')
    .map((l) => l.replace(/^\//, '').replace(/\/$/, ''));
}

function writeSparse(repo: Repo, dirs: string[]): void {
  // Cone mode, written the way git writes it: the top level, then each directory.
  const lines = ['/*', '!/*/', ...[...new Set(dirs)].sort().map((d) => `/${d}/`)];
  put(repo.lx, sparseFile(repo), lines.join('\n') + '\n');
}

export function cmdSparseCheckout(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] ?? 'list';
  const dirs = f.rest.slice(1).map((d) => d.replace(/^\.?\//, '').replace(/\/$/, ''));
  const reapply = () => reapplySparse(repo);
  switch (action) {
    case 'init':
    case 'set':
    case 'add': {
      if (!head(repo).oid) throw new GitError('fatal: sparse-checkout needs at least one commit');
      const s = statusOf(repo);
      if (s.staged.length || s.unstaged.length) throw new GitError('error: cannot change sparse-checkout while you have uncommitted changes.\nerror: Please commit or stash them.');
      setConfigValue(repo, 'core.sparseCheckout', 'true');
      setConfigValue(repo, 'core.sparseCheckoutCone', 'true');
      const current = action === 'add' ? readSparse(repo) : [];
      writeSparse(repo, [...current, ...dirs]);
      reapply();
      return;
    }
    case 'list': {
      if (configValue(repo, 'core.sparseCheckout') !== 'true') throw new GitError('fatal: this worktree is not sparse');
      for (const d of readSparse(repo)) io.print(d);
      return;
    }
    case 'disable': {
      const config = readConfig(repo);
      delete config['core.sparseCheckout'];
      delete config['core.sparseCheckoutCone'];
      writeConfig(repo, config);
      // Everything comes back.
      reapplySparse(repo);
      return;
    }
    case 'reapply':
      reapply();
      return;
    default:
      throw new GitError(`usage: git sparse-checkout (init | list | set | add | reapply | disable) [<options>]`);
  }
}

// ---------------------------------------------------------------------------
// submodule

interface SubmoduleSpec {
  name: string;
  path: string;
  url: string;
}

/** Parse .gitmodules, which is committed so that everyone gets the same list. */
function readGitmodules(repo: Repo): SubmoduleSpec[] {
  const text = slurp(repo.lx, `${repo.root}/.gitmodules`) ?? '';
  const out: SubmoduleSpec[] = [];
  let current: SubmoduleSpec | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[submodule "([^"]+)"\]$/.exec(line);
    if (header) {
      current = { name: header[1], path: header[1], url: '' };
      out.push(current);
      continue;
    }
    const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (current && kv) {
      if (kv[1] === 'path') current.path = kv[2];
      if (kv[1] === 'url') current.url = kv[2];
    }
  }
  return out;
}

function writeGitmodules(repo: Repo, specs: SubmoduleSpec[]): void {
  const text = specs.map((s) => `[submodule "${s.name}"]\n\tpath = ${s.path}\n\turl = ${s.url}\n`).join('');
  put(repo.lx, `${repo.root}/.gitmodules`, text);
}

export function cmdSubmodule(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] ?? 'status';
  if (repo.bare) throw new GitError('fatal: this operation must be run in a work tree');
  const specs = readGitmodules(repo);
  const gitlinks = [...indexMap(readIndex(repo)).values()].filter((e) => e.mode === GITLINK);
  const selected = (paths: string[]) => (paths.length ? specs.filter((s) => paths.includes(s.path)) : specs);

  const cloneSub = (spec: SubmoduleSpec, url: string): Repo => {
    const dir = `${repo.root}/${spec.path}`;
    const located = openRemote({ lx: env.lx, network: env.network, node: env.node, cwd: repo.root }, url);
    if (isTransportError(located)) throw new GitError([`Cloning into '${dir}'...`, ...located.error, `fatal: clone of '${url}' into submodule path '${dir}' failed`].join('\n'));
    if (getNode(env.lx, dir) && listDir(env.lx, dir).length) throw new GitError(`fatal: '${spec.path}' already exists and is not a valid git repo`);
    io.print(`Cloning into '${dir}'...`);
    const { repo: sub, branch } = cloneInto(located.repo, env.lx, dir, 'origin', url);
    setConfigValue(sub, 'remote.origin.url', url);
    setConfigValue(sub, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    if (branch) {
      setHeadBranch(sub, `refs/heads/${branch}`);
      checkoutTree(sub, readCommit(sub, readRef(sub, `refs/heads/${branch}`)!)?.tree ?? null);
    }
    return sub;
  };

  switch (action) {
    case 'add': {
      const url = f.rest[1];
      if (!url) throw new GitError('usage: git submodule add [-b <branch>] [--name <name>] <repository> [<path>]');
      const path = f.rest[2] ?? url.replace(/\/$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '');
      if (specs.some((s) => s.path === path)) throw new GitError(`fatal: '${path}' already exists in the index`);
      const spec = { name: path, path, url };
      cloneSub(spec, url);
      writeGitmodules(repo, [...specs, spec]);
      setConfigValue(repo, `submodule.${spec.name}.url`, url);
      setConfigValue(repo, `submodule.${spec.name}.active`, 'true');
      stagePaths(repo, ['.gitmodules', path]);
      return;
    }
    case 'status': {
      for (const e of gitlinks) {
        const at = submoduleHead(repo, e.path);
        const prefix = at === null ? '-' : at !== e.oid ? '+' : ' ';
        const sub = at ? findRepo(env.lx, `${repo.root}/${e.path}`) : null;
        const described = sub && at ? ` (${head(sub).branch?.replace('refs/heads/', 'heads/') ?? shortId(sub, at)})` : '';
        io.print(`${prefix}${at ?? e.oid} ${e.path}${described}`);
      }
      return;
    }
    case 'init': {
      for (const spec of selected(f.rest.slice(1))) {
        if (configValue(repo, `submodule.${spec.name}.url`)) continue;
        setConfigValue(repo, `submodule.${spec.name}.url`, spec.url);
        setConfigValue(repo, `submodule.${spec.name}.active`, 'true');
        io.print(`Submodule '${spec.name}' (${spec.url}) registered for path '${spec.path}'`);
      }
      return;
    }
    case 'sync': {
      for (const spec of selected(f.rest.slice(1))) {
        setConfigValue(repo, `submodule.${spec.name}.url`, spec.url);
        const sub = findRepo(env.lx, `${repo.root}/${spec.path}`);
        if (sub && sub.root === `${repo.root}/${spec.path}`) setConfigValue(sub, 'remote.origin.url', spec.url);
        io.print(`Synchronizing submodule url for '${spec.path}'`);
      }
      return;
    }
    case 'update': {
      if (has(f, 'init')) cmdSubmodule({ print: () => undefined, fail: () => undefined, out: [], err: [], code: 0 } as unknown as Io, repo, env, ['init', ...f.rest.slice(1)]);
      for (const spec of selected(f.rest.slice(1))) {
        const url = configValue(repo, `submodule.${spec.name}.url`);
        if (!url) continue;
        const link = gitlinks.find((e) => e.path === spec.path);
        if (!link) continue;
        let sub = findRepo(env.lx, `${repo.root}/${spec.path}`);
        if (!sub || sub.root !== `${repo.root}/${spec.path}`) sub = cloneSub(spec, url);
        // --remote follows the submodule's own branch; otherwise, the commit the superproject recorded.
        const target = has(f, 'remote') ? (readRef(sub, 'refs/remotes/origin/main') ?? link.oid) : link.oid;
        if (head(sub).oid === target) continue;
        if (!readCommit(sub, target)) throw new GitError(`fatal: Unable to find current revision in submodule path '${spec.path}'`);
        checkoutTree(sub, readCommit(sub, target)?.tree ?? null);
        setHeadDetached(sub, target);
        io.print(`Submodule path '${spec.path}': checked out '${target}'`);
      }
      return;
    }
    case 'deinit': {
      const paths = f.rest.slice(1);
      if (!paths.length && !has(f, 'all')) throw new GitError("fatal: Use '--all' if you really want to deinitialize all submodules");
      for (const spec of has(f, 'all') ? specs : selected(paths)) {
        const dir = `${repo.root}/${spec.path}`;
        const sub = findRepo(env.lx, dir);
        if (sub && sub.root === dir && !has(f, 'f', 'force')) {
          const s = statusOf(sub);
          if (s.staged.length || s.unstaged.length) throw new GitError(`error: the following file has local modifications:\n    ${spec.path}\n(use --cached to keep the file, or -f to force removal)\nfatal: Submodule work tree '${spec.path}' contains local modifications; use '-f' to discard them`);
        }
        if (getNode(env.lx, dir)) {
          removeNode(env.lx, dir, true, 'git');
          makeDir(env.lx, dir, true);
          io.print(`Cleared directory '${spec.path}'`);
        }
        const config = readConfig(repo);
        for (const key of Object.keys(config)) if (key.startsWith(`submodule.${spec.name}.`)) delete config[key];
        writeConfig(repo, config);
        io.print(`Submodule '${spec.name}' (${spec.url}) unregistered for path '${spec.path}'`);
      }
      return;
    }
    case 'foreach': {
      const command = f.rest.slice(1).join(' ');
      if (!command) throw new GitError('usage: git submodule foreach <command>');
      if (!env.run) throw new GitError('fatal: submodule foreach needs a shell to run the command in');
      for (const spec of specs) {
        const dir = `${repo.root}/${spec.path}`;
        const sub = findRepo(env.lx, dir);
        if (!sub || sub.root !== dir) continue;
        io.print(`Entering '${spec.path}'`);
        const r = env.run(command, dir);
        io.print(...r.out, ...r.err);
        if (r.code !== 0) throw new GitError(`fatal: run_command returned non-zero status for ${spec.path}\n.`);
      }
      return;
    }
    default:
      throw new GitError('usage: git submodule [--quiet] [add | status | init | deinit | update | sync | foreach] [<options>] [<path>...]');
  }
}

