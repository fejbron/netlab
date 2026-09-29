/**
 * Helpers several git commands share: naming the current branch, turning typed
 * paths into repository paths, and computing the files a commit changed.
 */
import { getNode, normalizePath, type LinuxState } from '../linux/fs';
import type { DiffFile } from './diff';
import type { GitEnv } from './io';
import type { Oid } from './objects';
import { GitError } from './ops';
import { configValue, head, indexMap, listRefs, parseConfig, readCommit, readIndex, slurp, treeFiles, type Repo } from './repo';
import { remotes, type RemoteContext } from './remote';
import { resolveRev, shortId, walk } from './revs';
import { readBlob } from './worktree';

/** ~/.gitconfig, which `git config --global` writes and every repository reads. */
export function globalConfig(lx: LinuxState): Record<string, string> {
  return parseConfig(slurp(lx, `/home/${lx.user}/.gitconfig`) ?? '');
}

export function ctxOf(env: GitEnv): RemoteContext {
  return { lx: env.lx, network: env.network, node: env.node, cwd: env.cwd };
}

export function branchLabel(repo: Repo): string {
  const h = head(repo);
  if (h.branch) return h.branch.replace('refs/heads/', '');
  return h.oid ? `HEAD detached at ${shortId(repo, h.oid)}` : 'HEAD';
}

/** A path as typed, turned into one relative to the repository root. */
export function toRepoPath(repo: Repo, env: GitEnv, spec: string): string {
  if (spec === '.' || spec === '-A' || spec === '--all') {
    const rel = env.cwd.startsWith(repo.root) ? env.cwd.slice(repo.root.length).replace(/^\//, '') : '';
    return rel === '' ? '.' : rel;
  }
  const abs = normalizePath(env.cwd, spec, `/home/${env.lx.user}`);
  return abs.startsWith(repo.root + '/') ? abs.slice(repo.root.length + 1) : spec;
}

/** The `(HEAD -> main, origin/main, tag: v1.0)` part of a log line. */
export function decorations(repo: Repo, oid: Oid): string {
  const h = head(repo);
  const names: string[] = [];
  if (h.oid === oid) names.push(h.branch ? `HEAD -> ${h.branch.replace('refs/heads/', '')}` : 'HEAD');
  for (const { name, oid: at } of listRefs(repo, 'refs/heads')) {
    if (at !== oid) continue;
    const short = name.replace('refs/heads/', '');
    if (h.branch === name) continue;
    names.push(short);
  }
  for (const { name, oid: at } of listRefs(repo, 'refs/tags')) if (at === oid || resolveRev(repo, name) === oid) names.push(`tag: ${name.replace('refs/tags/', '')}`);
  for (const { name, oid: at } of listRefs(repo, 'refs/remotes')) if (at === oid) names.push(name.replace('refs/remotes/', ''));
  return names.length ? ` (${names.join(', ')})` : '';
}

/** Has this path ever been in the history, or is it in the working tree now? */
export function everTracked(repo: Repo, path: string): boolean {
  if (getNode(repo.lx, `${repo.root}/${path}`)) return true;
  if (indexMap(readIndex(repo)).has(path)) return true;
  const h = head(repo);
  return h.oid ? walk(repo, [h.oid]).some((oid) => [...treeFiles(repo, readCommit(repo, oid)?.tree ?? null).keys()].some((p) => p === path || p.startsWith(path + '/'))) : false;
}

/** Did this commit change any of these paths, compared with its first parent? */
export function touches(repo: Repo, oid: Oid, paths: string[]): boolean {
  const commit = readCommit(repo, oid);
  if (!commit) return false;
  const after = treeFiles(repo, commit.tree);
  const before = treeFiles(repo, commit.parents[0] ? (readCommit(repo, commit.parents[0])?.tree ?? null) : null);
  const wanted = (p: string) => paths.some((spec) => p === spec || p.startsWith(spec + '/'));
  for (const [path, entry] of after) if (wanted(path) && before.get(path)?.oid !== entry.oid) return true;
  for (const [path] of before) if (wanted(path) && !after.has(path)) return true;
  return false;
}

export function diffOfCommit(repo: Repo, oid: Oid): DiffFile[] {
  const commit = readCommit(repo, oid)!;
  const before = treeFiles(repo, commit.parents[0] ? (readCommit(repo, commit.parents[0])?.tree ?? null) : null);
  const after = treeFiles(repo, commit.tree);
  return filesBetween(repo, before, after);
}

export function filesBetween(repo: Repo, before: Map<string, { mode: string; oid: string }>, after: Map<string, { mode: string; oid: string }>): DiffFile[] {
  const out: DiffFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
    out.push({
      path,
      before: a ? (readBlob(repo, a.oid) ?? '') : null,
      after: b ? (readBlob(repo, b.oid) ?? '') : null,
      oldMode: a?.mode,
      newMode: b?.mode,
      oldOid: a?.oid,
      newOid: b?.oid,
    });
  }
  return out;
}

export function remoteUrl(repo: Repo, name: string): string {
  const url = configValue(repo, `remote.${name}.url`);
  if (!url) throw new GitError(`fatal: '${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.`);
  return url;
}

export function defaultRemote(repo: Repo): string {
  const branch = head(repo).branch?.replace('refs/heads/', '');
  return (branch && configValue(repo, `branch.${branch}.remote`)) ?? remotes(repo)[0]?.name ?? 'origin';
}
