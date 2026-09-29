/**
 * Grading checks for the Git labs. They read the repository itself — the objects,
 * refs, index and working tree that the learner's commands really wrote — rather
 * than the text those commands printed, so any route to the right history passes.
 *
 * The collaboration checks look at the repository on the server, which is the only
 * honest way to tell whether a push happened.
 */
import type { NetworkState } from '../network';
import { normalizePath, type LinuxState } from '../linux/fs';
import { findRepo, head, listRefs, readCommit, readObject, readRef, treeFiles, type Repo } from './repo';
import { readStash } from './ops';
import { ancestors, mergeBase, resolveRev, walk } from './revs';
import { ignoreRules, readBlob, statusOf } from './worktree';
import { configValue, parseConfig, readConfig } from './repo';
import { remotes, upstreamOf } from './remote';

type Where = { host?: string; dir?: string };

export type GitCheck =
  /** A git command ran, optionally with arguments matching a regex and an exit code. */
  | ({ type: 'git-ran'; subcommand: string; argsPattern?: string; code?: number } & Where)
  /** A repository exists (and is bare, when asked). */
  | ({ type: 'git-repo'; bare?: boolean; exists?: boolean } & Where)
  /** Which branch HEAD is on, or that it is detached. */
  | ({ type: 'git-head'; branch?: string; detached?: boolean; at?: string } & Where)
  /** A branch exists, is gone, or points where another revision does. */
  | ({ type: 'git-branch'; name: string; exists?: boolean; at?: string; mergedInto?: string } & Where)
  /** A tag exists, optionally annotated, optionally on a given revision. */
  | ({ type: 'git-tag'; name: string; exists?: boolean; annotated?: boolean; at?: string } & Where)
  /** Commits reachable from a revision: how many, and whether one says something. */
  | ({ type: 'git-commits'; rev?: string; count?: number; messagePattern?: string; author?: string; absentPattern?: string } & Where)
  /** A file as committed: it is tracked at this revision, and its content matches. */
  | ({ type: 'git-tracked'; path: string; rev?: string; exists?: boolean; contains?: string; absent?: string } & Where)
  /** The working tree state: nothing to commit, or a given number of staged changes. */
  | ({ type: 'git-clean'; staged?: number; untracked?: number; conflicts?: number } & Where)
  /** A remote is configured, optionally with a url matching a regex. */
  | ({ type: 'git-remote'; name: string; urlPattern?: string; exists?: boolean } & Where)
  /** A branch on this repository has been published: the remote's ref matches it. */
  | ({ type: 'git-pushed'; branch: string; remote?: string; upstream?: boolean } & Where)
  /** The shape of history: a linear run, a merge commit, or one commit reaching another. */
  | ({ type: 'git-shape'; rev?: string; linear?: boolean; merges?: number; contains?: string; ancestorOf?: string } & Where)
  /** A config value, from the repository or ~/.gitconfig. */
  | ({ type: 'git-config'; key: string; value?: string; pattern?: string } & Where)
  /** How many entries the stash holds. */
  | ({ type: 'git-stash'; count: number } & Where)
  /** A path is ignored (or is not). */
  | ({ type: 'git-ignored'; path: string; ignored?: boolean } & Where);

export const GIT_CHECKS = new Set(['git-ran', 'git-repo', 'git-head', 'git-branch', 'git-tag', 'git-commits', 'git-tracked', 'git-clean', 'git-remote', 'git-pushed', 'git-shape', 'git-config', 'git-stash', 'git-ignored']);

export const DEFAULT_DIR = '/home/student/project';

function short(path: string): string {
  return path.replace('/home/student', '~');
}

export function describeGit(check: GitCheck, on: string): string {
  const where = check.dir && check.dir !== DEFAULT_DIR ? ` in ${short(check.dir)}` : '';
  switch (check.type) {
    case 'git-ran':
      return `Ran git ${check.subcommand}${check.code === undefined ? '' : check.code === 0 ? ' successfully' : ' and saw it fail'}${on}`;
    case 'git-repo':
      return check.exists === false ? `There is no repository${where}` : `A${check.bare ? ' bare' : ''} repository exists${where}${on}`;
    case 'git-head':
      if (check.detached) return `HEAD is detached${on}`;
      return `The current branch is ${check.branch}${on}`;
    case 'git-branch':
      if (check.exists === false) return `Branch ${check.name} is gone${on}`;
      if (check.mergedInto) return `${check.name} is merged into ${check.mergedInto}${on}`;
      return `Branch ${check.name} exists${check.at ? ` at ${check.at}` : ''}${on}`;
    case 'git-tag':
      if (check.exists === false) return `Tag ${check.name} is gone`;
      return `Tag ${check.name} exists${check.annotated ? ' and is annotated' : ''}${on}`;
    case 'git-commits': {
      if (check.messagePattern) return `A commit message matches ${check.messagePattern}${on}`;
      if (check.absentPattern) return `No commit message matches ${check.absentPattern}${on}`;
      return `${check.rev ?? 'HEAD'} has ${check.count} commit${check.count === 1 ? '' : 's'}${on}`;
    }
    case 'git-tracked':
      if (check.exists === false) return `${check.path} is not in ${check.rev ?? 'HEAD'}${on}`;
      return `${check.path} is committed${check.contains ? ` and contains ${check.contains}` : ''}${on}`;
    case 'git-clean':
      if (check.staged !== undefined) return `${check.staged} change${check.staged === 1 ? ' is' : 's are'} staged${on}`;
      if (check.conflicts !== undefined) return check.conflicts === 0 ? `No conflicts remain${on}` : `${check.conflicts} file${check.conflicts === 1 ? '' : 's'} still conflict${on}`;
      return `The working tree is clean${on}`;
    case 'git-remote':
      return check.exists === false ? `Remote ${check.name} is gone${on}` : `Remote ${check.name} is configured${on}`;
    case 'git-pushed':
      return `${check.branch} is published to ${check.remote ?? 'origin'}${check.upstream ? ' and tracks it' : ''}${on}`;
    case 'git-shape':
      if (check.linear) return `The history of ${check.rev ?? 'HEAD'} is linear${on}`;
      if (check.merges !== undefined) return `${check.rev ?? 'HEAD'} has ${check.merges} merge commit${check.merges === 1 ? '' : 's'}${on}`;
      if (check.ancestorOf) return `${check.contains} is an ancestor of ${check.ancestorOf}${on}`;
      return `${check.contains} is in the history of ${check.rev ?? 'HEAD'}${on}`;
    case 'git-config':
      return `${check.key} is set${check.value ? ` to ${check.value}` : ''}${on}`;
    case 'git-stash':
      return `The stash holds ${check.count} entr${check.count === 1 ? 'y' : 'ies'}${on}`;
    case 'git-ignored':
      return check.ignored === false ? `${check.path} is not ignored${on}` : `${check.path} is ignored${on}`;
  }
}

/** The repository a check is about: a working directory, or a bare one on a server. */
export function repoFor(check: GitCheck, lx: LinuxState): Repo | null {
  const dir = check.dir ?? DEFAULT_DIR;
  return findRepo(lx, normalizePath('/', dir, '/home/student'));
}

function revOf(repo: Repo, text: string | undefined): string | null {
  return resolveRev(repo, text ?? 'HEAD');
}

export function evaluateGit(check: GitCheck, lx: LinuxState, net: NetworkState): boolean {
  if (check.type === 'git-ran') {
    const re = check.argsPattern ? new RegExp(check.argsPattern) : null;
    return (lx.gitRuns ?? []).some((r) => r.command === check.subcommand && (check.code === undefined || r.code === check.code) && (!re || re.test(r.args.join(' '))));
  }
  const repo = repoFor(check, lx);
  if (check.type === 'git-repo') {
    if (check.exists === false) return !repo;
    return Boolean(repo) && (check.bare === undefined || repo!.bare === check.bare);
  }
  if (!repo) return false;

  switch (check.type) {
    case 'git-head': {
      const h = head(repo);
      if (check.detached !== undefined && check.detached !== (h.branch === null)) return false;
      if (check.branch !== undefined && h.branch !== `refs/heads/${check.branch}`) return false;
      if (check.at !== undefined && h.oid !== revOf(repo, check.at)) return false;
      return true;
    }
    case 'git-branch': {
      const oid = readRef(repo, `refs/heads/${check.name}`);
      if (check.exists === false) return oid === null;
      if (!oid) return false;
      if (check.at !== undefined && oid !== revOf(repo, check.at)) return false;
      if (check.mergedInto !== undefined) {
        const into = revOf(repo, check.mergedInto);
        if (!into || !ancestors(repo, into).has(oid)) return false;
      }
      return true;
    }
    case 'git-tag': {
      const oid = readRef(repo, `refs/tags/${check.name}`);
      if (check.exists === false) return oid === null;
      if (!oid) return false;
      if (check.annotated !== undefined && (readObject(repo, oid)?.type === 'tag') !== check.annotated) return false;
      if (check.at !== undefined && resolveRev(repo, check.name) !== revOf(repo, check.at)) return false;
      return true;
    }
    case 'git-commits': {
      const tip = revOf(repo, check.rev);
      const history = tip ? walk(repo, [tip]) : [];
      if (check.count !== undefined && history.length !== check.count) return false;
      if (check.messagePattern !== undefined) {
        const re = new RegExp(check.messagePattern, 'i');
        if (!history.some((oid) => re.test(readCommit(repo, oid)?.message ?? ''))) return false;
      }
      if (check.absentPattern !== undefined) {
        const re = new RegExp(check.absentPattern, 'i');
        if (history.some((oid) => re.test(readCommit(repo, oid)?.message ?? ''))) return false;
      }
      if (check.author !== undefined && !history.some((oid) => (readCommit(repo, oid)?.author.name ?? '').includes(check.author!))) return false;
      return true;
    }
    case 'git-tracked': {
      const tip = revOf(repo, check.rev);
      const files = treeFiles(repo, tip ? (readCommit(repo, tip)?.tree ?? null) : null);
      const entry = files.get(check.path);
      if (check.exists === false) return !entry;
      if (!entry) return false;
      const content = readBlob(repo, entry.oid) ?? '';
      if (check.contains !== undefined && !new RegExp(check.contains).test(content)) return false;
      if (check.absent !== undefined && new RegExp(check.absent).test(content)) return false;
      return true;
    }
    case 'git-clean': {
      const status = statusOf(repo);
      if (check.staged !== undefined) return status.staged.length === check.staged;
      if (check.untracked !== undefined) return status.untracked.length === check.untracked;
      if (check.conflicts !== undefined) return status.conflicts.length === check.conflicts;
      return !status.staged.length && !status.unstaged.length && !status.conflicts.length;
    }
    case 'git-remote': {
      const url = configValue(repo, `remote.${check.name}.url`);
      if (check.exists === false) return url === undefined;
      if (!url) return false;
      return check.urlPattern === undefined || new RegExp(check.urlPattern).test(url);
    }
    case 'git-pushed': {
      const remoteName = check.remote ?? remotes(repo)[0]?.name ?? 'origin';
      const local = readRef(repo, `refs/heads/${check.branch}`);
      if (!local) return false;
      if (check.upstream && !upstreamOf(repo, check.branch)) return false;
      // Look at the repository the remote URL names, wherever it lives.
      const url = configValue(repo, `remote.${remoteName}.url`);
      if (!url) return false;
      const onServer = findServerRepo(net, url);
      return onServer ? readRef(onServer, `refs/heads/${check.branch}`) === local : false;
    }
    case 'git-shape': {
      const tip = revOf(repo, check.rev);
      if (!tip) return false;
      const history = walk(repo, [tip]);
      if (check.linear && history.some((oid) => (readCommit(repo, oid)?.parents.length ?? 0) > 1)) return false;
      if (check.merges !== undefined && history.filter((oid) => (readCommit(repo, oid)?.parents.length ?? 0) > 1).length !== check.merges) return false;
      if (check.contains !== undefined) {
        const wanted = revOf(repo, check.contains);
        if (!wanted) return false;
        if (check.ancestorOf) {
          const of = revOf(repo, check.ancestorOf);
          return Boolean(of) && ancestors(repo, of).has(wanted) && mergeBase(repo, wanted, of!) === wanted;
        }
        if (!history.includes(wanted)) return false;
      }
      return true;
    }
    case 'git-config': {
      const all = { ...globalValues(lx), ...readConfig(repo) };
      const value = all[check.key];
      if (value === undefined) return false;
      if (check.value !== undefined) return value === check.value;
      if (check.pattern !== undefined) return new RegExp(check.pattern).test(value);
      return true;
    }
    case 'git-stash':
      return readStash(repo).length === check.count;
    case 'git-ignored':
      return ignoreRules(repo).test(check.path) === (check.ignored ?? true);
    default:
      return false;
  }
}

/** ~/.gitconfig, which `git config --global` writes, read with the same parser as .git/config. */
function globalValues(lx: LinuxState): Record<string, string> {
  return parseConfig(lx.fs[`/home/${lx.user}/.gitconfig`]?.content ?? '');
}

/** Find the repository a remote URL points at, on whichever host holds it. */
function findServerRepo(net: NetworkState, url: string): Repo | null {
  const at = url.lastIndexOf(':');
  const path = at > 1 ? url.slice(at + 1) : url;
  const hostName = at > 1 ? url.slice(0, at).split('@').pop()! : '';
  for (const host of Object.values(net.hosts)) {
    if (!host.linux) continue;
    if (hostName && host.id !== hostName && host.name !== hostName && host.linux.hostname !== hostName) continue;
    const repo = findRepo(host.linux, path);
    if (repo) return repo;
  }
  return null;
}

/** What the lab page shows: the branches, the current one, and how history looks. */
export function repoSummary(lx: LinuxState, dir: string = DEFAULT_DIR): { branch: string; branches: string[]; commits: number; staged: number; unstaged: number; untracked: number; conflicts: number } | null {
  const repo = findRepo(lx, dir);
  if (!repo) return null;
  const h = head(repo);
  const status = statusOf(repo);
  return {
    branch: h.branch?.replace('refs/heads/', '') ?? (h.oid ? 'HEAD (detached)' : 'main'),
    branches: listRefs(repo, 'refs/heads').map((r) => r.name.replace('refs/heads/', '')),
    commits: h.oid ? walk(repo, [h.oid]).length : 0,
    staged: status.staged.length,
    unstaged: status.unstaged.length,
    untracked: status.untracked.length,
    conflicts: status.conflicts.length,
  };
}
