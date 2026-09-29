/**
 * The `git` command. Every subcommand works on the repository in the host's
 * filesystem, so what it prints is derived from the objects and refs that are
 * really there, and a command that would lose work refuses for the same reason
 * git refuses.
 *
 * Commands that would open an editor (`git commit` with no -m, `git rebase -i`)
 * say so rather than pretending: there is no editor in this simulator.
 */
import { getNode, listDir, normalizePath, makeDir, type LinuxState } from '../linux/fs';
import { diffLines, diffStat, statLines, unifiedDiff, type DiffFile } from './diff';
import { entryType, objectId, type Oid } from './objects';
import {
  commit as doCommit,
  createBranch,
  createCommitObject,
  dirtyPaths,
  endRebase,
  pathsChangedBy,
  cherryPick,
  checkoutCommit,
  firstLine,
  GitError,
  identity,
  merge as doMerge,
  rebase as doRebase,
  readStash,
  reset as doReset,
  revert as doRevert,
  stashApply,
  stashDrop,
  stashPush,
  tick,
  type ResetMode,
} from './ops';
import {
  checkedOutElsewhere,
  configValue,
  deleteRef,
  findRepo,
  gitPath,
  head,
  headTree,
  indexMap,
  initRepo,
  listRefs,
  logRef,
  put,
  readCommit,
  readConfig,
  readIndex,
  readObject,
  readReflog,
  readRef,
  setConfigValue,
  setHeadBranch,
  setHeadDetached,
  slurp,
  treeFiles,
  treeFromIndex,
  writeConfig,
  writeIndex,
  writeObject,
  writeRef,
  type Repo,
} from './repo';
import { cloneInto, fetchFrom, isTransportError, openRemote, parseUrl, pushTo, remotes, upstreamOf } from './remote';
import { aheadBehind, isAncestor, mergeBase, resolveRev, shortId, walk } from './revs';
import { formatDate, has, Io, message, parseFlags, VALUE_FLAGS, type GitEnv } from './io';
import { Graph, prettyLines } from './logfmt';

const LOG_FLAGS = new Set([...VALUE_FLAGS, 'S', 'G', 'pretty']);
import { cmdArchive, cmdBisect, cmdCountObjects, cmdDescribe, cmdFsck, cmdGc, cmdGrep, cmdNotes, cmdPrune, cmdRevList, commitsIn, isRangeSpec, noteFor, parseRange, reflogExpire } from './more';
import { cmdAm, cmdApply, cmdFilterBranch, cmdFormatPatch } from './patches';
import { cmdSparseCheckout, cmdSubmodule, cmdWorktree } from './worktrees';
import { branchLabel, ctxOf, decorations, defaultRemote, diffOfCommit, everTracked, filesBetween, globalConfig, remoteUrl, toRepoPath, touches } from './common';
export { formatDate, type GitEnv } from './io';
import { blobFor, blockingChanges, blockingMessage, checkoutTree, ignoreRules, inSparse, isTracked, matchPaths, readBlob, removeGitFile, putGitFile, removeWorkingFile, setIndexTo, stagePaths, statusOf, workingFiles, workingId, writeWorkingFile } from './worktree';

export interface GitResult {
  out: string[];
  err: string[];
  code: number;
}

export interface GitRun {
  command: string;
  args: string[];
  code: number;
  dir: string;
}

export function runGit(env: GitEnv, args: string[]): GitResult {
  const io = new Io();
  // Options before the command belong to git itself: -C <dir>, -c key=value,
  // --git-dir, --version, --help. Everything after it belongs to the command.
  const globals: string[] = [];
  let at = 0;
  for (; at < args.length && args[at].startsWith('-'); at++) {
    const arg = args[at];
    globals.push(arg);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(arg) && at + 1 < args.length) globals.push(args[++at]);
  }
  const command = args[at] ?? '';
  const rest = args.slice(at + 1);
  try {
    for (let k = 0; k < globals.length; k++) {
      if (globals[k] !== '-C') continue;
      const dir = normalizePath(env.cwd, globals[k + 1] ?? '', `/home/${env.lx.user}`);
      if (getNode(env.lx, dir)?.type !== 'dir') throw new GitError(`fatal: cannot change to '${globals[k + 1] ?? ''}': No such file or directory`);
      env = { ...env, cwd: dir };
    }
    dispatch(io, env, command, rest, globals);
  } catch (e) {
    if (e instanceof GitError) {
      io.err.push(...e.message.split('\n'));
      io.code = 128;
    } else throw e;
  }
  recordRun(env, command, args, io.code);
  return { out: io.out, err: io.err, code: io.code };
}

function recordRun(env: GitEnv, command: string, args: string[], code: number): void {
  const runs = (env.lx.gitRuns ??= []);
  runs.push({ command, args, code, dir: env.cwd });
  if (runs.length > 200) runs.shift();
}

function dispatch(io: Io, env: GitEnv, command: string, args: string[], all: string[]): void {
  if (!command || has(parseFlags(all), 'help', 'h') || args[0] === '--help' || (args.length === 1 && args[0] === '-h')) return usage(io);
  if (has(parseFlags(all), 'version')) return void io.print('git version 2.43.0 (NetLab)');
  switch (command) {
    case 'init':
      return cmdInit(io, env, args);
    case 'clone':
      return cmdClone(io, env, args);
    case 'config':
      return cmdConfig(io, env, args);
    case 'status':
      return cmdStatus(io, repoOf(io, env, all), args);
    case 'add':
      return cmdAdd(io, repoOf(io, env, all), env, args);
    case 'rm':
      return cmdRm(io, repoOf(io, env, all), env, args);
    case 'mv':
      return cmdMv(io, repoOf(io, env, all), env, args);
    case 'restore':
      return cmdRestore(io, repoOf(io, env, all), env, args);
    case 'commit':
      return cmdCommit(io, repoOf(io, env, all), args);
    case 'log':
      return cmdLog(io, repoOf(io, env, all), args);
    case 'show':
      return cmdShow(io, repoOf(io, env, all), args);
    case 'diff':
      return cmdDiff(io, repoOf(io, env, all), env, args);
    case 'branch':
      return cmdBranch(io, repoOf(io, env, all), args);
    case 'checkout':
      return cmdCheckout(io, repoOf(io, env, all), env, args);
    case 'switch':
      return cmdSwitch(io, repoOf(io, env, all), args);
    case 'merge':
      return cmdMerge(io, repoOf(io, env, all), args);
    case 'rebase':
      return cmdRebase(io, repoOf(io, env, all), args);
    case 'cherry-pick':
      return cmdCherryPick(io, repoOf(io, env, all), args);
    case 'revert':
      return cmdRevert(io, repoOf(io, env, all), args);
    case 'reset':
      return cmdReset(io, repoOf(io, env, all), env, args);
    case 'stash':
      return cmdStash(io, repoOf(io, env, all), args);
    case 'tag':
      return cmdTag(io, repoOf(io, env, all), args);
    case 'remote':
      return cmdRemote(io, repoOf(io, env, all), args);
    case 'fetch':
      return cmdFetch(io, repoOf(io, env, all), env, args);
    case 'pull':
      return cmdPull(io, repoOf(io, env, all), env, args);
    case 'push':
      return cmdPush(io, repoOf(io, env, all), env, args);
    case 'reflog':
      return cmdReflog(io, repoOf(io, env, all), args);
    case 'ls-files':
      return cmdLsFiles(io, repoOf(io, env, all), args);
    case 'cat-file':
      return cmdCatFile(io, repoOf(io, env, all), args);
    case 'hash-object':
      return cmdHashObject(io, repoOf(io, env, all), env, args);
    case 'rev-parse':
      return cmdRevParse(io, repoOf(io, env, all), args);
    case 'clean':
      return cmdClean(io, repoOf(io, env, all), args);
    case 'blame':
      return cmdBlame(io, repoOf(io, env, all), args);
    case 'shortlog':
      return cmdShortlog(io, repoOf(io, env, all), args);
    case 'rev-list':
      return cmdRevList(io, repoOf(io, env, all), args);
    case 'describe':
      return cmdDescribe(io, repoOf(io, env, all), args);
    case 'grep':
      return cmdGrep(io, repoOf(io, env, all), env, args);
    case 'notes':
      return cmdNotes(io, repoOf(io, env, all), args);
    case 'count-objects':
      return cmdCountObjects(io, repoOf(io, env, all), args);
    case 'fsck':
      return cmdFsck(io, repoOf(io, env, all), args);
    case 'prune':
      return cmdPrune(io, repoOf(io, env, all), args);
    case 'gc':
      return cmdGc(io, repoOf(io, env, all), args);
    case 'archive':
      return cmdArchive(io, repoOf(io, env, all), env, args);
    case 'bisect':
      return cmdBisect(io, repoOf(io, env, all), env, args);
    case 'format-patch':
      return cmdFormatPatch(io, repoOf(io, env, all), env, args);
    case 'apply':
      return cmdApply(io, repoOf(io, env, all), env, args);
    case 'am':
      return cmdAm(io, repoOf(io, env, all), env, args);
    case 'filter-branch':
      return cmdFilterBranch(io, repoOf(io, env, all), env, args);
    case 'worktree':
      return cmdWorktree(io, repoOf(io, env, all), env, args);
    case 'sparse-checkout':
      return cmdSparseCheckout(io, repoOf(io, env, all), args);
    case 'submodule':
      return cmdSubmodule(io, repoOf(io, env, all), env, args);
    case 'ls-tree':
      return cmdLsTree(io, repoOf(io, env, all), args);
    case 'show-ref':
      return cmdShowRef(io, repoOf(io, env, all), args);
    case 'symbolic-ref':
      return cmdSymbolicRef(io, repoOf(io, env, all), args);
    case 'update-ref':
      return cmdUpdateRef(io, repoOf(io, env, all), args);
    case 'write-tree':
      return void io.print(treeFromIndex(repoOf(io, env, all)));
    case 'commit-tree':
      return cmdCommitTree(io, repoOf(io, env, all), args);
    case 'merge-base':
      return cmdMergeBase(io, repoOf(io, env, all), args);
    case 'cherry':
      return cmdCherry(io, repoOf(io, env, all), args);
    case 'range-diff':
    case 'rerere':
    case 'send-email':
    case 'request-pull':
    case 'svn':
    case 'p4':
    case 'instaweb':
    case 'gui':
    case 'citool':
    case 'difftool':
    case 'mergetool':
      throw new GitError(`fatal: 'git ${command}' is not simulated in NetLab${command === 'mergetool' || command === 'difftool' ? ': there is no editor or diff viewer. Resolve conflicts by editing the file, then git add it.' : '.'}`);
    default:
      io.fail(1, `git: '${command}' is not a git command. See 'git --help'.`);
  }
}

function usage(io: Io): void {
  io.print(
    'usage: git [--version] [--help] <command> [<args>]',
    '',
    'The commands this simulator implements:',
    '',
    '   start a working area',
    '     clone     Clone a repository into a new directory',
    '     init      Create an empty Git repository',
    '',
    '   work on the current change',
    '     add       Add file contents to the index',
    '     mv        Move or rename a file',
    '     restore   Restore working tree files',
    '     rm        Remove files from the working tree and from the index',
    '',
    '   examine the history and state',
    '     blame     Show what revision and author last modified each line',
    '     diff      Show changes between commits, commit and working tree, etc',
    '     log       Show commit logs',
    '     show      Show various types of objects',
    '     status    Show the working tree status',
    '',
    '   grow, mark and tweak your common history',
    '     branch    List, create, or delete branches',
    '     checkout  Switch branches or restore working tree files',
    '     commit    Record changes to the repository',
    '     merge     Join two or more development histories together',
    '     rebase    Reapply commits on top of another base tip',
    '     reset     Reset current HEAD to the specified state',
    '     revert    Revert some existing commits',
    '     stash     Stash the changes in a dirty working directory away',
    '     switch    Switch branches',
    '     tag       Create, list, delete or verify a tag object',
    '',
    '   collaborate',
    '     fetch     Download objects and refs from another repository',
    '     pull      Fetch from and integrate with another repository',
    '     push      Update remote refs along with associated objects',
    '     remote    Manage set of tracked repositories',
    '',
    "   plumbing worth knowing: cat-file, hash-object, ls-files, rev-parse, reflog",
  );
}

function repoOf(io: Io, env: GitEnv, args: string[] = []): Repo {
  const gitDir = parseFlags(args).values['git-dir'] ?? env.env.GIT_DIR;
  if (gitDir) {
    const abs = normalizePath(env.cwd, gitDir, `/home/${env.lx.user}`);
    if (!getNode(env.lx, `${abs}/HEAD`)) throw new GitError(`fatal: not a git repository: '${gitDir}'`);
    return { lx: env.lx, root: '', gitDir: abs, commonDir: abs, bare: true };
  }
  const repo = findRepo(env.lx, env.cwd);
  if (!repo) {
    throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
  }
  void io;
  return repo;
}

// ---------------------------------------------------------------------------
// starting a repository

function cmdInit(io: Io, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const target = f.rest[0] ? normalizePath(env.cwd, f.rest[0], `/home/${env.lx.user}`) : env.cwd;
  if (!getNode(env.lx, target)) {
    const e = makeDir(env.lx, target, true);
    if (e) throw new GitError(`fatal: cannot mkdir ${f.rest[0]}: ${e.error}`);
  }
  const bare = has(f, 'bare');
  const existing = findRepo(env.lx, target);
  // Re-running init is safe in git: it keeps HEAD, config and history exactly as they are.
  if (existing && (existing.bare ? existing.gitDir : existing.root) === target) {
    return void io.print(`Reinitialized existing Git repository in ${existing.gitDir}/`);
  }
  const branch = f.values.b ?? f.values['initial-branch'] ?? globalConfig(env.lx)['init.defaultBranch'] ?? 'main';
  const repo = initRepo(env.lx, target, { bare, branch });
  // A repository inherits the identity the learner configured globally.
  const global = globalConfig(env.lx);
  for (const key of ['user.name', 'user.email']) if (global[key]) setConfigValue(repo, key, global[key]);
  io.print(`Initialized empty Git repository in ${bare ? target : `${target}/.git`}/`);
}

function writeGlobalConfig(lx: LinuxState, values: Record<string, string>): void {
  const bySection = new Map<string, Array<[string, string]>>();
  for (const [key, value] of Object.entries(values)) {
    const at = key.lastIndexOf('.');
    const section = key.slice(0, at);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push([key.slice(at + 1), value]);
  }
  const lines: string[] = [];
  for (const [section, entries] of bySection) {
    lines.push(`[${section}]`);
    for (const [name, value] of entries) lines.push(`\t${name} = ${value}`);
  }
  put(lx, `/home/${lx.user}/.gitconfig`, lines.join('\n') + '\n');
}

function cmdConfig(io: Io, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const global = has(f, 'global');
  const repo = global ? null : findRepo(env.lx, env.cwd);
  if (!global && !repo) throw new GitError('fatal: not in a git directory');
  const read = () => (global ? globalConfig(env.lx) : { ...globalConfig(env.lx), ...readConfig(repo!) });

  if (has(f, 'list', 'l')) {
    for (const [key, value] of Object.entries(read())) io.print(`${key}=${value}`);
    return;
  }
  if (f.values.unset || has(f, 'unset')) {
    const key = f.values.unset ?? f.rest[0];
    const values = global ? globalConfig(env.lx) : readConfig(repo!);
    delete values[key];
    if (global) writeGlobalConfig(env.lx, values);
    else writeConfig(repo!, values);
    return;
  }
  const [key, value] = f.rest;
  if (!key) return usage(io);
  if (value === undefined) {
    const found = read()[key];
    if (found === undefined) {
      io.code = 1;
      return;
    }
    io.print(found);
    return;
  }
  if (global) {
    const values = globalConfig(env.lx);
    values[key] = value;
    writeGlobalConfig(env.lx, values);
    // A repository that exists picks the new identity up straight away.
    const local = findRepo(env.lx, env.cwd);
    if (local && (key === 'user.name' || key === 'user.email') && !readConfig(local)[key]) setConfigValue(local, key, value);
  } else setConfigValue(repo!, key, value);
}

function cmdClone(io: Io, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const url = f.rest[0];
  if (!url) throw new GitError('fatal: You must specify a repository to clone.');
  const bare = has(f, 'bare', 'mirror');
  const origin = f.values.origin ?? f.values.o ?? 'origin';
  const base = parseUrl(url).path.replace(/\/$/, '').split('/').pop()!.replace(/\.git$/, '');
  const name = f.rest[1] ?? (bare ? `${base}.git` : base);
  const dir = normalizePath(env.cwd, name, `/home/${env.lx.user}`);
  if (getNode(env.lx, dir) && listDir(env.lx, dir).length) throw new GitError(`fatal: destination path '${name}' already exists and is not an empty directory.`);
  const located = openRemote(ctxOf(env), url);
  if (isTransportError(located)) {
    io.fail(located.code, `Cloning into ${bare ? 'bare repository ' : ''}'${name}'...`, ...located.error);
    return;
  }
  const wanted = f.values.branch ?? f.values.b;
  if (wanted && !readRef(located.repo, `refs/heads/${wanted}`)) {
    throw new GitError(`Cloning into '${name}'...\nfatal: Remote branch ${wanted} not found in upstream ${origin}`);
  }
  io.print(`Cloning into ${bare ? 'bare repository ' : ''}'${name}'...`);
  const result = cloneInto(located.repo, env.lx, dir, origin, url, { branch: wanted, bare });
  setConfigValue(result.repo, `remote.${origin}.url`, url);
  if (!bare) setConfigValue(result.repo, `remote.${origin}.fetch`, `+refs/heads/*:refs/remotes/${origin}/*`);
  const global = globalConfig(env.lx);
  for (const key of ['user.name', 'user.email']) if (global[key]) setConfigValue(result.repo, key, global[key]);
  if (result.branch) {
    setHeadBranch(result.repo, `refs/heads/${result.branch}`);
    if (!bare) {
      setConfigValue(result.repo, `branch.${result.branch}.remote`, origin);
      setConfigValue(result.repo, `branch.${result.branch}.merge`, `refs/heads/${result.branch}`);
      if (!has(f, 'n', 'no-checkout')) checkoutCommit(result.repo, readRef(result.repo, `refs/heads/${result.branch}`)!);
    }
  }
  io.print(`remote: Enumerating objects: ${result.objects}, done.`, `remote: Total ${result.objects} (delta 0), reused 0 (delta 0)`, `Receiving objects: 100% (${result.objects}/${result.objects}), done.`);
  if (f.values.depth !== undefined) io.print('note: NetLab copies the full history; --depth is accepted but every commit is still cloned.');
  if (!result.branch) io.print('warning: You appear to have cloned an empty repository.');
}

// ---------------------------------------------------------------------------
// status

function cmdStatus(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const status = statusOf(repo);
  const h = head(repo);
  const branch = branchLabel(repo);

  // -u<mode> / --untracked-files=<mode>: no, normal (directories collapsed) or all.
  const uArg = args.find((a) => /^-u/.test(a) || a.startsWith('--untracked-files'));
  const uMode = !uArg ? 'normal' : uArg.includes('=') ? uArg.split('=')[1] : uArg.startsWith('-u') && uArg.length > 2 ? uArg.slice(2) : 'all';
  const indexPaths = [...indexMap(readIndex(repo)).keys()];
  const trackedDirs = new Set(indexPaths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  // A directory holding nothing tracked is shown once, as dir/, the way git does.
  const collapse = (paths: string[]) =>
    uMode === 'all'
      ? paths
      : [...new Set(paths.map((p) => {
          const parts = p.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (!trackedDirs.has(dir)) return `${dir}/`;
          }
          return p;
        }))].sort();
  const untracked = uMode === 'no' ? [] : collapse(status.untracked);
  const ignoreMatch = ignoreRules(repo);
  const ignored = has(f, 'ignored') ? collapse([...workingFiles(repo).keys()].filter((p) => !indexPaths.includes(p) && ignoreMatch.test(p))) : [];

  // A staged deletion and a staged addition of the same content is a rename.
  const committed = treeFiles(repo, readCommit(repo, h.oid ?? '')?.tree ?? null);
  const indexNow = indexMap(readIndex(repo));
  const renames = new Map<string, string>();
  for (const added of status.staged.filter((c) => c.code === 'A')) {
    const oid = indexNow.get(added.path)?.oid;
    const gone = status.staged.find((c) => c.code === 'D' && !renames.has(c.path) && committed.get(c.path)?.oid === oid);
    if (gone) renames.set(gone.path, added.path);
  }
  const renamedTo = new Set(renames.values());
  const stagedShown = status.staged.filter((c) => !renames.has(c.path) && !renamedTo.has(c.path));

  const up = h.branch ? upstreamOf(repo, branch) : null;
  const upName = up ? (up.remote === '.' ? up.ref.replace('refs/heads/', '') : `${up.remote}/${up.ref.replace('refs/heads/', '')}`) : null;
  const upOid = up ? (up.remote === '.' ? readRef(repo, up.ref) : readRef(repo, `refs/remotes/${upName}`)) : null;

  if (f.values.porcelain === 'v2' || f.values.porcelain === '2') {
    if (has(f, 'b', 'branch')) {
      io.print(`# branch.oid ${h.oid ?? '(initial)'}`, `# branch.head ${h.branch ? branch : '(detached)'}`);
      if (upName) {
        io.print(`# branch.upstream ${upName}`);
        if (upOid) {
          const { ahead, behind } = aheadBehind(repo, h.oid, upOid);
          io.print(`# branch.ab +${ahead} -${behind}`);
        }
      }
    }
    const zero = '0'.repeat(40);
    const working = workingFiles(repo);
    const stagedCode = new Map(status.staged.map((c) => [c.path, c.code as string]));
    const unstagedCode = new Map(status.unstaged.map((c) => [c.path, c.code as string]));
    for (const path of [...new Set([...stagedCode.keys(), ...unstagedCode.keys()])].sort()) {
      if (status.conflicts.includes(path) || renamedTo.has(path)) continue;
      const was = committed.get(path);
      const now = indexNow.get(path);
      const work = working.get(path);
      if (renames.has(path)) {
        const to = renames.get(path)!;
        const entry = indexNow.get(to)!;
        io.print(`2 R${unstagedCode.get(to) ?? '.'} N... ${was?.mode ?? '000000'} ${entry.mode} ${working.get(to)?.mode ?? '000000'} ${was?.oid ?? zero} ${entry.oid} R100 ${to}\t${path}`);
        continue;
      }
      io.print(`1 ${stagedCode.get(path) ?? '.'}${unstagedCode.get(path) ?? '.'} N... ${was?.mode ?? '000000'} ${now?.mode ?? '000000'} ${work?.mode ?? '000000'} ${was?.oid ?? zero} ${now?.oid ?? zero} ${path}`);
    }
    for (const path of status.conflicts) io.print(`u UU N... ${path}`);
    for (const path of untracked) io.print(`? ${path}`);
    for (const path of ignored) io.print(`! ${path}`);
    return;
  }

  if (has(f, 's', 'short', 'porcelain') || f.values.porcelain !== undefined) {
    if (has(f, 'b', 'branch')) {
      let line = h.branch ? `## ${h.oid ? branch : `No commits yet on ${branch}`}` : '## HEAD (no branch)';
      if (h.branch && upName) {
        line += `...${upName}`;
        if (!upOid) line += ' [gone]';
        else {
          const { ahead, behind } = aheadBehind(repo, h.oid, upOid);
          const state = [ahead ? `ahead ${ahead}` : '', behind ? `behind ${behind}` : ''].filter(Boolean).join(', ');
          if (state) line += ` [${state}]`;
        }
      }
      io.print(line);
    }
    const staged = new Map(stagedShown.map((c) => [c.path, c.code as string]));
    const unstaged = new Map(status.unstaged.map((c) => [c.path, c.code as string]));
    for (const to of renames.values()) staged.set(to, 'R');
    for (const path of [...new Set([...staged.keys(), ...unstaged.keys()])].sort()) {
      if (status.conflicts.includes(path)) continue;
      const from = [...renames.entries()].find(([, to]) => to === path)?.[0];
      io.print(`${staged.get(path) ?? ' '}${unstaged.get(path) ?? ' '} ${from ? `${from} -> ${path}` : path}`);
    }
    for (const path of status.conflicts) io.print(`UU ${path}`);
    for (const path of untracked) io.print(`?? ${path}`);
    for (const path of ignored) io.print(`!! ${path}`);
    return;
  }

  io.print(h.branch ? `On branch ${branch}` : `HEAD detached at ${h.oid ? shortId(repo, h.oid) : 'unknown'}`);
  if (up) {
    const theirs = upOid;
    const { ahead, behind } = aheadBehind(repo, h.oid, theirs);
    const name = upName!;
    if (!theirs) io.print(`Your branch is based on '${name}', but the upstream is gone.`, '  (use "git branch --unset-upstream" to fixup)');
    else if (ahead && behind) io.print(`Your branch and '${name}' have diverged,`, `and have ${ahead} and ${behind} different commits each, respectively.`, '  (use "git pull" if you want to integrate the remote branch with yours)');
    else if (ahead) io.print(`Your branch is ahead of '${name}' by ${ahead} commit${ahead === 1 ? '' : 's'}.`, '  (use "git push" to publish your local commits)');
    else if (behind) io.print(`Your branch is behind '${name}' by ${behind} commit${behind === 1 ? '' : 's'}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)');
    else io.print(`Your branch is up to date with '${name}'.`);
  }
  if (!h.oid) io.print('', 'No commits yet');
  if (readMergeState(repo)) io.print('', 'You have unmerged paths.', '  (fix conflicts and run "git commit")', '  (use "git merge --abort" to abort the merge)');
  const rebasing = slurp(repo.lx, `${repo.gitDir}/rebase-merge/onto`)?.trim();
  if (rebasing) {
    const name = (slurp(repo.lx, `${repo.gitDir}/rebase-merge/head-name`) ?? '').trim().replace('refs/heads/', '');
    io.print(`rebase in progress; onto ${shortId(repo, rebasing)}`, `You are currently rebasing branch '${name}' on '${shortId(repo, rebasing)}'.`);
    io.print(status.conflicts.length ? '  (fix conflicts and then run "git rebase --continue")' : '  (all conflicts fixed: run "git rebase --continue")', '  (use "git rebase --skip" to skip this patch)', '  (use "git rebase --abort" to check out the original branch)');
  }
  if (slurp(repo.lx, `${repo.gitDir}/CHERRY_PICK_HEAD`)) io.print(`You are currently cherry-picking commit ${shortId(repo, slurp(repo.lx, `${repo.gitDir}/CHERRY_PICK_HEAD`)!.trim())}.`, '  (fix conflicts and run "git cherry-pick --continue")', '  (use "git cherry-pick --abort" to cancel the cherry-pick operation)');
  if (slurp(repo.lx, `${repo.gitDir}/REVERT_HEAD`)) io.print(`You are currently reverting commit ${shortId(repo, slurp(repo.lx, `${repo.gitDir}/REVERT_HEAD`)!.trim())}.`, '  (fix conflicts and run "git revert --continue")', '  (use "git revert --abort" to cancel the revert operation)');
  if (slurp(repo.lx, `${repo.gitDir}/BISECT_START`)) io.print(`You are currently bisecting, started from branch '${slurp(repo.lx, `${repo.gitDir}/BISECT_START`)!.trim()}'.`, '  (use "git bisect reset" to get back to the original branch)');

  if (status.staged.length) {
    io.print('', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)');
    for (const c of stagedShown) io.print(`\t${label(c.code)}${c.path}`);
    for (const [from, to] of renames) io.print(`\trenamed:    ${from} -> ${to}`);
  }
  if (status.conflicts.length) {
    io.print('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const path of status.conflicts) io.print(`\tboth modified:   ${path}`);
  }
  if (status.unstaged.length) {
    io.print('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
    for (const c of status.unstaged) io.print(`\t${label(c.code)}${c.path}`);
  }
  if (untracked.length) {
    io.print('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const path of untracked) io.print(`\t${path}`);
  }
  if (ignored.length) {
    io.print('', 'Ignored files:', '  (use "git add -f <file>..." to include in what will be committed)');
    for (const path of ignored) io.print(`\t${path}`);
  }
  if (!status.staged.length && !status.unstaged.length && !status.conflicts.length) {
    if (untracked.length) io.print('', 'nothing added to commit but untracked files present (use "git add" to track)');
    else if (uMode === 'no' && status.untracked.length) io.print('', 'nothing to commit (use -u to show untracked files)');
    else io.print('', 'nothing to commit, working tree clean');
  } else if (!status.staged.length && !status.conflicts.length) {
    io.print('', 'no changes added to commit (use "git add" and/or "git commit -a")');
  }
}

function label(code: 'A' | 'M' | 'D'): string {
  return code === 'A' ? 'new file:   ' : code === 'M' ? 'modified:   ' : 'deleted:    ';
}

function readMergeState(repo: Repo): boolean {
  return Boolean(getNode(repo.lx, `${repo.gitDir}/MERGE_HEAD`));
}

// ---------------------------------------------------------------------------
// staging

function cmdAdd(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  if (has(f, 'p', 'patch', 'i', 'interactive')) {
    throw new GitError('hint: NetLab has no interactive staging, so hunks cannot be picked one by one.\nhint: Stage whole files with git add <file>, or split the change into two files first.\nfatal: interactive add is not simulated');
  }
  const specs = [...f.rest, ...f.paths];
  const all = has(f, 'A', 'all');
  const updateOnly = has(f, 'u', 'update');
  if (!specs.length && !all && !updateOnly) throw new GitError("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?");
  const force = has(f, 'f', 'force');
  const ignore = ignoreRules(repo);
  const tracked = new Set([...indexMap(readIndex(repo)).keys(), ...treeFiles(repo, headTree(repo)).keys()]);
  const chosen = new Set<string>();
  // -A and -u with no paths cover the whole tree, wherever you are in it.
  for (const spec of specs.length ? specs : ['/']) {
    const rel = spec === '/' ? '.' : toRepoPath(repo, env, spec);
    const matched = matchPaths(repo, rel);
    if (!matched.length && !has(f, 'ignore-missing')) throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
    for (const p of matched) chosen.add(p);
  }
  let paths = [...chosen];
  if (updateOnly) paths = paths.filter((p) => tracked.has(p));
  const ignored = paths.filter((p) => !tracked.has(p) && ignore.test(p));
  if (!force) paths = paths.filter((p) => tracked.has(p) || !ignore.test(p));
  // Naming an ignored file outright is refused; sweeping it up with . just skips it.
  const named = specs.filter((sp) => !sp.includes('*') && sp !== '.' && sp !== ':/');
  const namedIgnored = ignored.filter((p) => named.some((sp) => toRepoPath(repo, env, sp) === p || p.startsWith(toRepoPath(repo, env, sp).replace(/\/$/, '') + '/')));
  if (!force && namedIgnored.length) {
    io.fail(1, 'The following paths are ignored by one of your .gitignore files:', ...namedIgnored, 'hint: Use -f if you really want to add them.', 'hint: Turn this message off by running', 'hint: "git config advice.addIgnoredFile false"');
    return;
  }
  if (has(f, 'n', 'dry-run')) {
    for (const p of paths.sort()) io.print(`add '${p}'`);
    return;
  }
  stagePaths(repo, paths.sort());
  if (has(f, 'v', 'verbose')) for (const p of paths.sort()) io.print(`add '${p}'`);
}

function cmdRm(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const cached = has(f, 'cached');
  const force = has(f, 'f', 'force');
  const specs = [...f.rest, ...f.paths];
  if (!specs.length) throw new GitError('usage: git rm [<options>] [--] <file>...');
  const index = indexMap(readIndex(repo));
  const committed = treeFiles(repo, headTree(repo));
  const working = workingFiles(repo);
  const paths: string[] = [];
  for (const spec of specs) {
    const rel = toRepoPath(repo, env, spec);
    const matched = matchPaths(repo, rel).filter((p) => index.has(p));
    if (!matched.length) {
      if (has(f, 'ignore-unmatch')) continue;
      throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
    }
    // A directory needs -r, as it does in git.
    if (!has(f, 'r') && matched.some((p) => p !== rel.replace(/\/$/, ''))) throw new GitError(`fatal: not removing '${spec}' recursively without -r`);
    paths.push(...matched);
  }
  if (!force) {
    // Refuse to lose work: an edit on disk, or a staged change git has nowhere else.
    const modified = paths.filter((p) => working.has(p) && workingId(working.get(p)!) !== index.get(p)?.oid);
    const staged = paths.filter((p) => committed.get(p)?.oid !== index.get(p)?.oid && committed.has(p));
    if (!cached && modified.length) {
      throw new GitError(['error: the following file has local modifications:', ...modified.map((p) => `    ${p}`), '(use --cached to keep the file, or -f to force removal)'].join('\n'));
    }
    if (!cached && staged.length) {
      throw new GitError(['error: the following file has changes staged in the index:', ...staged.map((p) => `    ${p}`), '(use --cached to keep the file, or -f to force removal)'].join('\n'));
    }
  }
  writeIndex(repo, readIndex(repo).filter((e) => !paths.includes(e.path)));
  for (const p of paths) {
    if (!cached) removeWorkingFile(repo, p);
    io.print(`rm '${p}'`);
  }
}

function cmdMv(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const [from, to] = [...f.rest, ...f.paths].map((s) => toRepoPath(repo, env, s));
  if (!from || !to) throw new GitError('usage: git mv <source> <destination>');
  const content = slurp(repo.lx, `${repo.root}/${from}`);
  if (content === null) throw new GitError(`fatal: bad source, source=${from}, destination=${to}`);
  const entry = indexMap(readIndex(repo)).get(from);
  writeWorkingFile(repo, to, content, entry?.mode ?? '100644');
  removeWorkingFile(repo, from);
  stagePaths(repo, [from, to]);
  void io;
}

function cmdRestore(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const specs = [...f.rest, ...f.paths];
  if (!specs.length) throw new GitError('fatal: you must specify path(s) to restore');
  const source = f.values.source ? resolveRev(repo, f.values.source) : null;
  if (f.values.source && !source) throw new GitError(`fatal: could not resolve ${f.values.source}`);
  const sourceFiles = source ? treeFiles(repo, readCommit(repo, source)?.tree ?? null) : null;
  // Only paths git knows about can be restored; an untracked file is left alone.
  const known = (p: string) => isTracked(repo, p) || Boolean(sourceFiles?.has(p));
  const paths: string[] = [];
  for (const spec of specs) {
    const matched = matchPaths(repo, toRepoPath(repo, env, spec)).filter(known);
    const fromSource = sourceFiles ? [...sourceFiles.keys()].filter((p) => p === toRepoPath(repo, env, spec) || p.startsWith(toRepoPath(repo, env, spec).replace(/\/$/, '') + '/')) : [];
    const all = [...new Set([...matched, ...fromSource])];
    if (!all.length) throw new GitError(`error: pathspec '${spec}' did not match any file(s) known to git`);
    paths.push(...all);
  }
  if (has(f, 'staged', 'S')) {
    // Take the files back to what HEAD (or --source) has, leaving the working tree alone.
    const committed = sourceFiles ?? treeFiles(repo, headTree(repo));
    const entries = readIndex(repo).filter((e) => !paths.includes(e.path));
    for (const p of paths) {
      const entry = committed.get(p);
      if (entry) entries.push({ mode: entry.mode, oid: entry.oid, stage: 0, path: p });
    }
    writeIndex(repo, entries);
    if (!has(f, 'worktree', 'W')) return;
  }
  const index = indexMap(readIndex(repo));
  for (const p of paths) {
    const entry = sourceFiles ? sourceFiles.get(p) : index.get(p);
    if (!entry) {
      // Tracked in HEAD but not in the index or the source: restoring means removing it.
      removeWorkingFile(repo, p);
      continue;
    }
    if (entry.mode === '160000') continue;
    writeWorkingFile(repo, p, readBlob(repo, entry.oid) ?? '', entry.mode);
  }
  void io;
}

// ---------------------------------------------------------------------------
// committing

function cmdCommit(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const text = message(f);
  const amend = has(f, 'amend');
  if (!text && !amend) {
    throw new GitError(
      ['hint: There is no editor in NetLab, so a commit message has to be given on the command line.', 'hint: Write it with -m, as in: git commit -m "what changed and why"', 'fatal: no commit message given'].join('\n'),
    );
  }
  if (has(f, 'a', 'all')) {
    const tracked = [...indexMap(readIndex(repo)).keys(), ...treeFiles(repo, headTree(repo)).keys()];
    stagePaths(repo, [...new Set(tracked)]);
  }
  const previous = amend && head(repo).oid ? readCommit(repo, head(repo).oid!) : null;
  const result = doCommit(repo, text ?? previous?.message ?? '', { amend, allowEmpty: has(f, 'allow-empty') });
  const branch = result.branch ? result.branch.replace('refs/heads/', '') : `HEAD detached at ${shortId(repo, result.oid)}`;
  const summary = firstLine(text ?? previous?.message ?? '');
  io.print(`[${branch}${result.root ? ' (root-commit)' : ''} ${shortId(repo, result.oid)}] ${summary}`);
  const bits = [`${result.files} file${result.files === 1 ? '' : 's'} changed`];
  if (result.insertions) bits.push(`${result.insertions} insertion${result.insertions === 1 ? '' : 's'}(+)`);
  if (result.deletions) bits.push(`${result.deletions} deletion${result.deletions === 1 ? '' : 's'}(-)`);
  io.print(' ' + bits.join(', '));
  const before = treeFiles(repo, previous?.tree ?? (readCommit(repo, result.oid)?.parents[0] ? (readCommit(repo, readCommit(repo, result.oid)!.parents[0])?.tree ?? null) : null));
  const after = treeFiles(repo, readCommit(repo, result.oid)!.tree);
  for (const [path, entry] of after) if (!before.has(path)) io.print(` create mode ${entry.mode} ${path}`);
  for (const path of before.keys()) if (!after.has(path)) io.print(` delete mode ${before.get(path)!.mode} ${path}`);
}

// ---------------------------------------------------------------------------
// history

function cmdLog(io: Io, repo: Repo, args: string[]): void {
  // -Sneedle and -Gpattern can be glued to their flag, as git allows.
  const spread = args.flatMap((a) => (/^-[SG]../.test(a) ? [a.slice(0, 2), a.slice(2)] : [a]));
  const f = parseFlags(spread, LOG_FLAGS);
  const h = head(repo);
  const tips: Oid[] = [];
  // An argument is a revision if git can resolve it, and a path if the repository
  // has ever held it. Anything that is neither is the mistake git complains about.
  const paths: string[] = [...f.paths];
  const excluded = new Set<Oid>();
  for (const rev of f.rest) {
    if (isRangeSpec(rev)) {
      const range = parseRange(repo, [rev]);
      tips.push(...range.include);
      for (const x of range.exclude) for (const a of walk(repo, [x])) excluded.add(a);
      continue;
    }
    const oid = resolveRev(repo, rev);
    if (oid) {
      tips.push(oid);
      continue;
    }
    if (everTracked(repo, rev)) {
      paths.push(rev);
      continue;
    }
    throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  }
  if (has(f, 'all')) for (const r of [...listRefs(repo, 'refs/heads'), ...listRefs(repo, 'refs/remotes')]) tips.push(r.oid);
  if (!tips.length) {
    if (!h.oid) throw new GitError(`fatal: your current branch '${branchLabel(repo)}' does not have any commits yet`);
    tips.push(h.oid);
  }
  let history = walk(repo, tips, { firstParent: has(f, 'first-parent') }).filter((oid) => !excluded.has(oid));
  const limit = Number(f.values.n ?? f.values['max-count'] ?? 0);
  if (f.values.author) history = history.filter((oid) => readCommit(repo, oid)?.author.name.includes(f.values.author) || readCommit(repo, oid)?.author.email.includes(f.values.author));
  if (f.values.grep) history = history.filter((oid) => readCommit(repo, oid)?.message.includes(f.values.grep));
  if (paths.length) history = history.filter((oid) => touches(repo, oid, paths));
  // -S counts a string's occurrences; -G looks for a changed line matching a pattern.
  if (f.values.S !== undefined) {
    const needle = f.values.S;
    const count = (text: string | null) => (text && needle ? text.split(needle).length - 1 : 0);
    history = history.filter((oid) => diffOfCommit(repo, oid).some((file) => count(file.before) !== count(file.after)));
  }
  if (f.values.G !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(f.values.G);
    } catch {
      throw new GitError(`fatal: invalid regex given to -G: '${f.values.G}'`);
    }
    history = history.filter((oid) =>
      diffOfCommit(repo, oid).some((file) => diffLines((file.before ?? '').split('\n'), (file.after ?? '').split('\n')).some((l) => l.kind !== ' ' && pattern.test(l.text))),
    );
  }
  if (has(f, 'reverse')) history = history.reverse();
  if (limit > 0) history = has(f, 'reverse') ? history.slice(-limit) : history.slice(0, limit);

  const graph = has(f, 'graph') ? new Graph(repo, has(f, 'first-parent')) : null;
  const pretty = has(f, 'oneline') ? undefined : (f.values.pretty ?? f.values.format);
  const emit = (oid: Oid, lines: string[]) => io.print(...(graph ? graph.row(oid, lines) : lines));
  for (const oid of history) {
    const commit = readCommit(repo, oid)!;
    if (has(f, 'oneline')) {
      emit(oid, [`${shortId(repo, oid)}${decorations(repo, oid)} ${firstLine(commit.message)}`]);
      continue;
    }
    const lines = prettyLines(repo, oid, pretty) ?? [
      `commit ${oid}${decorations(repo, oid)}`,
      ...(commit.parents.length > 1 ? [`Merge: ${commit.parents.map((p) => shortId(repo, p)).join(' ')}`] : []),
      `Author: ${commit.author.name} <${commit.author.email}>`,
      `Date:   ${formatDate(commit.author.when)}`,
      '',
      ...commit.message.replace(/\n$/, '').split('\n').map((line) => `    ${line}`),
      '',
    ];
    const note = has(f, 'no-notes') || (pretty && /format:|^%|oneline/.test(pretty)) ? null : noteFor(repo, oid);
    if (note !== null) lines.push('Notes:', ...note.replace(/\n$/, '').split('\n').map((line) => `    ${line}`), '');
    if (has(f, 'stat', 'p', 'patch')) {
      const files = diffOfCommit(repo, oid).filter((file) => !paths.length || paths.some((p) => file.path === p || file.path.startsWith(p + '/')));
      if (has(f, 'stat')) lines.push(...statLines(files.map(diffStat)));
      else for (const file of files) lines.push(...unifiedDiff(file));
      lines.push('');
    }
    emit(oid, lines);
  }
}

function cmdShow(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const rev = f.rest[0] ?? 'HEAD';
  const oid = resolveRev(repo, rev);
  if (!oid) throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  // An annotated tag is an object in its own right: show who tagged it and why,
  // then the commit it points at, as git does.
  const tagRef = readRef(repo, `refs/tags/${rev}`);
  const tagObject = tagRef ? readObject(repo, tagRef) : null;
  if (tagObject?.type === 'tag') {
    const t = tagObject.tag;
    io.print(`tag ${t.tag}`, `Tagger: ${t.tagger.name} <${t.tagger.email}>`, `Date:   ${formatDate(t.tagger.when)}`, '');
    for (const line of t.message.replace(/\n$/, '').split('\n')) io.print(line);
    io.print('');
  }
  const object = readObject(repo, oid);
  if (object?.type === 'blob') return void io.print(...object.content.replace(/\n$/, '').split('\n'));
  if (object?.type === 'tree') return void io.print(`tree ${rev}`, '', ...object.entries.map((e) => (e.mode === '040000' ? `${e.name}/` : e.name)));
  const commit = readCommit(repo, oid);
  if (!commit) throw new GitError(`fatal: bad object ${rev}`);
  io.print(`commit ${oid}${decorations(repo, oid)}`);
  if (commit.parents.length > 1) io.print(`Merge: ${commit.parents.map((p) => shortId(repo, p)).join(' ')}`);
  io.print(`Author: ${commit.author.name} <${commit.author.email}>`, `Date:   ${formatDate(commit.author.when)}`, '');
  for (const line of commit.message.replace(/\n$/, '').split('\n')) io.print(`    ${line}`);
  io.print('');
  const files = diffOfCommit(repo, oid);
  if (has(f, 'stat')) io.print(...statLines(files.map(diffStat)));
  else for (const file of files) io.print(...unifiedDiff(file));
}

function cmdDiff(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  // A..B compares the two ends; A...B compares B with where the two last agreed.
  const revs: Oid[] = [];
  const pathSpecs = [...f.paths];
  for (const arg of f.rest) {
    if (arg.includes('...')) {
      const [a, b] = arg.split('...');
      const left = resolveRev(repo, a || 'HEAD');
      const right = resolveRev(repo, b || 'HEAD');
      if (!left || !right) throw new GitError(`fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.`);
      revs.push(mergeBase(repo, left, right) ?? left, right);
    } else if (arg.includes('..')) {
      const [a, b] = arg.split('..');
      const left = resolveRev(repo, a || 'HEAD');
      const right = resolveRev(repo, b || 'HEAD');
      if (!left || !right) throw new GitError(`fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.`);
      revs.push(left, right);
    } else {
      const oid = resolveRev(repo, arg);
      if (oid) revs.push(oid);
      else if (isTracked(repo, toRepoPath(repo, env, arg)) || matchPaths(repo, toRepoPath(repo, env, arg)).length) pathSpecs.push(arg);
      else throw new GitError(`fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
  }
  const staged = has(f, 'staged', 'cached');
  const index = indexMap(readIndex(repo));
  const working = workingFiles(repo);
  const fromIndex = () => new Map([...index].map(([p, e]) => [p, { mode: e.mode, oid: e.oid }]));
  const fromWorking = (only?: (p: string) => boolean) => new Map([...working].filter(([p]) => !only || only(p)).map(([p, file]) => [p, { mode: file.mode, oid: workingId(file) }]));
  const treeOf = (oid: Oid) => treeFiles(repo, readCommit(repo, oid)?.tree ?? null);

  let before: Map<string, { mode: string; oid: string }>;
  let after: Map<string, { mode: string; oid: string }>;
  let afterIsWorking = false;
  if (revs.length >= 2) {
    before = treeOf(revs[0]);
    after = treeOf(revs[1]);
  } else if (revs.length === 1) {
    before = treeOf(revs[0]);
    afterIsWorking = !staged;
    after = staged ? fromIndex() : fromWorking((p) => index.has(p) || before.has(p));
  } else if (staged) {
    before = treeFiles(repo, headTree(repo));
    after = fromIndex();
  } else {
    before = fromIndex();
    afterIsWorking = true;
    // A file a sparse checkout left out is not a deletion.
    after = fromWorking((p) => index.has(p));
    for (const [p, e] of index) if (!working.has(p) && (!inSparse(repo, p) || e.mode === '160000')) after.set(p, { mode: e.mode, oid: e.oid });
  }
  let files = filesBetween(repo, before, after);
  // The working-tree side is read from disk: its blobs were never stored.
  if (afterIsWorking) {
    for (const file of files) {
      const w = working.get(file.path);
      if (w && w.mode !== '160000') file.after = w.content;
    }
  }
  if (pathSpecs.length) {
    const wanted = new Set(pathSpecs.flatMap((sp) => matchPaths(repo, toRepoPath(repo, env, sp))));
    files = files.filter((file) => wanted.has(file.path) || pathSpecs.some((sp) => file.path.startsWith(toRepoPath(repo, env, sp).replace(/\/$/, '') + '/')));
  }
  if (has(f, 'w', 'ignore-all-space')) files = files.filter((file) => (file.before ?? '').replace(/\s+/g, '') !== (file.after ?? '').replace(/\s+/g, ''));
  const renames = detectRenames(files);
  if (has(f, 'exit-code', 'quiet')) io.code = files.length ? 1 : 0;
  if (has(f, 'quiet')) return;
  if (has(f, 'stat')) return void io.print(...statLines(files.map(diffStat)));
  if (has(f, 'shortstat')) return void io.print(...statLines(files.map(diffStat)).slice(-1));
  if (has(f, 'name-only')) return void io.print(...renames.map((r) => r.to ?? r.file.path));
  if (has(f, 'name-status')) {
    for (const r of renames) {
      if (r.from) io.print(`R100\t${r.from}\t${r.to}`);
      else io.print(`${r.file.before === null ? 'A' : r.file.after === null ? 'D' : 'M'}\t${r.file.path}`);
    }
    return;
  }
  for (const r of renames) {
    if (r.from) {
      io.print(`diff --git a/${r.from} b/${r.to}`, 'similarity index 100%', `rename from ${r.from}`, `rename to ${r.to}`);
      continue;
    }
    const lines = unifiedDiff(r.file, 3, { ignoreSpace: has(f, 'w', 'ignore-all-space', 'b', 'ignore-space-change') });
    io.print(...(has(f, 'word-diff') ? wordDiff(lines) : lines));
  }
}

/**
 * Pair a deleted file with an added file of identical content: that is a rename, and
 * git shows it as one. Renames with edits (similarity below 100%) are not detected.
 */
export function detectRenames(files: DiffFile[]): Array<{ file: DiffFile; from?: string; to?: string }> {
  const deleted = files.filter((f) => f.after === null && f.before !== null);
  const added = files.filter((f) => f.before === null && f.after !== null);
  const pairs = new Map<DiffFile, DiffFile>();
  const taken = new Set<DiffFile>();
  for (const d of deleted) {
    const match = added.find((a) => !taken.has(a) && a.newOid === d.oldOid && a.newMode === d.oldMode);
    if (!match) continue;
    taken.add(match);
    pairs.set(d, match);
  }
  const out: Array<{ file: DiffFile; from?: string; to?: string }> = [];
  for (const file of files) {
    if (taken.has(file)) continue;
    const to = pairs.get(file);
    out.push(to ? { file: to, from: file.path, to: to.path } : { file });
  }
  return out;
}

/** --word-diff: runs of removed and added lines become one line with [-old-]{+new+}. */
function wordDiff(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('-') || line.startsWith('---')) {
      if (line.startsWith('+') && !line.startsWith('+++')) out.push(`{+${line.slice(1)}+}`);
      else out.push(line.startsWith(' ') ? line.slice(1) : line);
      i++;
      continue;
    }
    const removed: string[] = [];
    while (i < lines.length && lines[i].startsWith('-') && !lines[i].startsWith('---')) removed.push(lines[i++].slice(1));
    const added: string[] = [];
    while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) added.push(lines[i++].slice(1));
    const words = (text: string) => text.split(/(\s+)/).filter((w) => w !== '');
    const a = words(removed.join(' '));
    const b = words(added.join(' '));
    const ops = diffLines(a, b);
    let text = '';
    for (const op of ops) text += op.kind === ' ' ? op.text : op.kind === '-' ? `[-${op.text}-]` : `{+${op.text}+}`;
    out.push(text.replace(/-\]\[-/g, '').replace(/\+\}\{\+/g, ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// branches

function cmdBranch(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const h = head(repo);
  const del = f.values.d ?? f.values.D ?? f.values.delete;
  if (del || has(f, 'd', 'D', 'delete')) {
    const name = del ?? f.rest[0];
    if (!name) throw new GitError('fatal: branch name required');
    const ref = `refs/heads/${name}`;
    const oid = readRef(repo, ref);
    if (!oid) throw new GitError(`error: branch '${name}' not found.`);
    if (h.branch === ref) throw new GitError(`error: Cannot delete branch '${name}' checked out at '${repo.root}'`);
    const force = has(f, 'D') || f.values.D !== undefined;
    if (!force && h.oid && mergeBase(repo, oid, h.oid) !== oid) {
      io.fail(1, `error: The branch '${name}' is not fully merged.`, `If you are sure you want to delete it, run 'git branch -D ${name}'.`);
      return;
    }
    deleteRef(repo, ref);
    io.print(`Deleted branch ${name} (was ${shortId(repo, oid)}).`);
    return;
  }
  if (has(f, 'm', 'M') || f.values.m) {
    const names = [f.values.m, ...f.rest].filter(Boolean) as string[];
    const [from, to] = names.length > 1 ? names : [h.branch?.replace('refs/heads/', '') ?? '', names[0]];
    const oid = readRef(repo, `refs/heads/${from}`);
    if (!oid) throw new GitError(`error: refname refs/heads/${from} not found`);
    if (readRef(repo, `refs/heads/${to}`) && !has(f, 'M')) throw new GitError(`fatal: a branch named '${to}' already exists`);
    writeRef(repo, `refs/heads/${to}`, oid);
    deleteRef(repo, `refs/heads/${from}`);
    if (h.branch === `refs/heads/${from}`) setHeadBranch(repo, `refs/heads/${to}`);
    // The reflog and the upstream settings belong to the branch, so they move with it.
    const oldLog = gitPath(repo, `logs/refs/heads/${from}`);
    if (repo.lx.fs[oldLog]) {
      put(repo.lx, gitPath(repo, `logs/refs/heads/${to}`), repo.lx.fs[oldLog].content);
      removeGitFile(repo, `logs/refs/heads/${from}`);
    }
    logRef(repo, `refs/heads/${to}`, oid, oid, identity(repo).name, `Branch: renamed refs/heads/${from} to refs/heads/${to}`, repo.lx.clock);
    const config = readConfig(repo);
    let moved = false;
    for (const key of Object.keys(config)) {
      if (!key.startsWith(`branch.${from}.`)) continue;
      config[`branch.${to}.` + key.slice(`branch.${from}.`.length)] = config[key];
      delete config[key];
      moved = true;
    }
    if (moved) writeConfig(repo, config);
    return;
  }
  const current = h.branch?.replace('refs/heads/', '') ?? null;
  if (has(f, 'show-current')) {
    if (current) io.print(current);
    return;
  }
  // -u / --set-upstream-to <remote>/<branch> [<branch>], and --unset-upstream [<branch>].
  const upstreamTo = f.values['set-upstream-to'] ?? f.values.u;
  if (upstreamTo !== undefined || has(f, 'u', 'set-upstream-to')) {
    const target = upstreamTo ?? f.rest.shift();
    const branch = f.rest[0] ?? current;
    if (!target) throw new GitError('fatal: option `set-upstream-to\' requires a value');
    if (!branch) throw new GitError('fatal: could not set upstream of HEAD to ' + target + ' when it does not point to any branch.');
    if (!readRef(repo, `refs/heads/${branch}`)) throw new GitError(`fatal: branch '${branch}' does not exist`);
    const tracking = listRefs(repo, 'refs/remotes').find((r) => r.name === `refs/remotes/${target}`);
    if (!tracking) throw new GitError(`error: the requested upstream branch '${target}' does not exist`);
    const [remoteName, ...rest] = target.split('/');
    setConfigValue(repo, `branch.${branch}.remote`, remoteName);
    setConfigValue(repo, `branch.${branch}.merge`, `refs/heads/${rest.join('/')}`);
    io.print(`branch '${branch}' set up to track '${target}'.`);
    return;
  }
  if (has(f, 'unset-upstream')) {
    const branch = f.rest[0] ?? current;
    if (!branch || !upstreamOf(repo, branch)) throw new GitError(`fatal: branch '${branch ?? 'HEAD'}' has no upstream information`);
    const config = readConfig(repo);
    delete config[`branch.${branch}.remote`];
    delete config[`branch.${branch}.merge`];
    writeConfig(repo, config);
    return;
  }
  // -c / -C copy a branch; the copy keeps the upstream settings.
  if (f.values.c !== undefined || f.values.C !== undefined || has(f, 'c', 'C', 'copy')) {
    const names = [f.values.c ?? f.values.C, ...f.rest].filter(Boolean) as string[];
    const [from, to] = names.length > 1 ? names : [current ?? '', names[0]];
    const oid = readRef(repo, `refs/heads/${from}`);
    if (!to) throw new GitError('fatal: branch name required');
    if (!oid) throw new GitError(`error: refname refs/heads/${from} not found`);
    if (readRef(repo, `refs/heads/${to}`) && f.values.C === undefined && !has(f, 'C')) throw new GitError(`fatal: a branch named '${to}' already exists`);
    createBranch(repo, to, oid);
    const up = upstreamOf(repo, from);
    if (up) {
      setConfigValue(repo, `branch.${to}.remote`, up.remote);
      setConfigValue(repo, `branch.${to}.merge`, up.ref);
    }
    return;
  }
  if (f.rest.length && !has(f, 'l', 'list', 'contains', 'merged', 'no-merged') && f.values.contains === undefined && f.values.merged === undefined && f.values['no-merged'] === undefined) {
    const [name, start] = f.rest;
    const exists = readRef(repo, `refs/heads/${name}`);
    if (exists && !has(f, 'f', 'force')) throw new GitError(`fatal: a branch named '${name}' already exists`);
    if (exists && current === name) throw new GitError(`fatal: cannot force update the branch '${name}' used by worktree at '${repo.root}'`);
    if (!/^[^\s~^:?*[\\]+$/.test(name) || name.startsWith('-') || name.endsWith('.lock') || name.includes('..')) throw new GitError(`fatal: '${name}' is not a valid branch name`);
    const at = start ? resolveRev(repo, start) : h.oid;
    if (!at) throw new GitError(start ? `fatal: not a valid object name: '${start}'` : 'fatal: Not a valid object name: \'HEAD\'.');
    if (exists) writeRef(repo, `refs/heads/${name}`, at);
    else createBranch(repo, name, at);
    // Starting from a remote-tracking branch sets it up as the upstream, unless --no-track.
    const tracking = start && !has(f, 'no-track') ? listRefs(repo, 'refs/remotes').find((r) => r.name === `refs/remotes/${start}`) : undefined;
    if (tracking || (has(f, 't', 'track') && start)) {
      const remoteBranch = tracking ? start! : null;
      if (remoteBranch) {
        const [remoteName, ...rest] = remoteBranch.split('/');
        setConfigValue(repo, `branch.${name}.remote`, remoteName);
        setConfigValue(repo, `branch.${name}.merge`, `refs/heads/${rest.join('/')}`);
        io.print(`branch '${name}' set up to track '${remoteBranch}'.`);
      } else if (readRef(repo, `refs/heads/${start}`)) {
        setConfigValue(repo, `branch.${name}.remote`, '.');
        setConfigValue(repo, `branch.${name}.merge`, `refs/heads/${start}`);
        io.print(`branch '${name}' set up to track '${start}'.`);
      }
    }
    return;
  }

  // Listing: filter by --contains / --merged / --no-merged and by -l patterns.
  const commitFor = (flag: string): Oid | null => {
    const value = f.values[flag] ?? (has(f, flag) ? 'HEAD' : undefined);
    if (value === undefined) return null;
    const oid = resolveRev(repo, value);
    if (!oid) throw new GitError(`error: malformed object name ${value}`);
    return oid;
  };
  const contains = commitFor('contains');
  const merged = commitFor('merged');
  const notMerged = commitFor('no-merged');
  const patterns = has(f, 'l', 'list') ? f.rest : [];
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const keep = (short: string, oid: Oid) =>
    (!contains || isAncestor(repo, contains, oid)) &&
    (!merged || isAncestor(repo, oid, merged)) &&
    (!notMerged || !isAncestor(repo, oid, notMerged)) &&
    (!patterns.length || patterns.some((p) => glob(p).test(short)));

  const verbose = has(f, 'v', 'vv');
  const locals = listRefs(repo, 'refs/heads').map((r) => ({ ...r, short: r.name.replace('refs/heads/', '') })).filter((r) => keep(r.short, r.oid));
  const remoteRefs = has(f, 'a', 'all', 'r', 'remotes')
    ? listRefs(repo, 'refs/remotes').map((r) => ({ ...r, short: r.name.replace('refs/remotes/', '') })).filter((r) => !r.short.endsWith('/HEAD') && keep(r.short, r.oid))
    : [];
  const detached = !h.branch && h.oid && !has(f, 'r', 'remotes') && keep('HEAD', h.oid) ? `(HEAD detached at ${shortId(repo, h.oid)})` : null;
  const width = Math.max(0, ...locals.map((r) => r.short.length), ...(detached ? [detached.length] : []), ...(has(f, 'a', 'all') ? remoteRefs.map((r) => `remotes/${r.short}`.length) : []));
  const describe = (label: string, oid: Oid, track = '') =>
    verbose ? `${label.padEnd(width)} ${shortId(repo, oid)} ${track}${firstLine(readCommit(repo, oid)?.message ?? '')}` : label;
  if (!has(f, 'r', 'remotes')) {
    if (detached) io.print(`* ${describe(detached, h.oid!)}`);
    for (const { short, oid, name } of locals) {
      let track = '';
      const up = args.includes('-vv') || has(f, 'vv') ? upstreamOf(repo, short) : null;
      if (up) {
        const upName = up.remote === '.' ? up.ref.replace('refs/heads/', '') : `${up.remote}/${up.ref.replace('refs/heads/', '')}`;
        const upOid = up.remote === '.' ? readRef(repo, up.ref) : readRef(repo, `refs/remotes/${upName}`);
        if (!upOid) track = `[${upName}: gone] `;
        else {
          const { ahead, behind } = aheadBehind(repo, oid, upOid);
          const state = [ahead ? `ahead ${ahead}` : '', behind ? `behind ${behind}` : ''].filter(Boolean).join(', ');
          track = `[${upName}${state ? `: ${state}` : ''}] `;
        }
      }
      io.print(`${h.branch === name ? '*' : ' '} ${describe(short, oid, track)}`);
    }
  }
  for (const { short, oid } of remoteRefs) {
    const label = has(f, 'r', 'remotes') ? short : `remotes/${short}`;
    io.print(`  ${describe(label, oid)}`);
  }
}

/** The name git writes in the reflog for where HEAD was: a branch, or a commit id. */
function whereHead(repo: Repo): string {
  const h = head(repo);
  return h.branch ? h.branch.replace('refs/heads/', '') : (h.oid ?? 'HEAD');
}

/**
 * Move HEAD to a commit, the way checkout does: refuse if uncommitted work would be
 * lost, carry it along when the two commits agree on those files, and record the
 * move in the reflog under the name HEAD had before it moved.
 */
function moveTo(repo: Repo, oid: Oid, to: { branch?: string; label: string }): void {
  const tree = readCommit(repo, oid)?.tree ?? null;
  const blocked = blockingMessage(blockingChanges(repo, tree), 'checkout');
  if (blocked) throw new GitError(blocked);
  if (to.branch) {
    const elsewhere = checkedOutElsewhere(repo, `refs/heads/${to.branch}`);
    if (elsewhere) throw new GitError(`fatal: '${to.branch}' is already used by worktree at '${elsewhere}'`);
  }
  const from = whereHead(repo);
  const before = head(repo).oid;
  checkoutTree(repo, tree, { carry: true });
  if (to.branch) setHeadBranch(repo, `refs/heads/${to.branch}`);
  else setHeadDetached(repo, oid);
  logRef(repo, 'HEAD', before, oid, identity(repo).name, `checkout: moving from ${from} to ${to.label}`, repo.lx.clock);
}

function switchTo(io: Io, repo: Repo, target: string, opts: { create?: boolean; startPoint?: string; force?: boolean; noTrack?: boolean } = {}): void {
  const h = head(repo);
  if (opts.create) {
    if (readRef(repo, `refs/heads/${target}`) && !opts.force) throw new GitError(`fatal: a branch named '${target}' already exists`);
    if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.startsWith('-') || target.includes('..') || target.endsWith('/') || target.endsWith('.lock')) {
      throw new GitError(`fatal: '${target}' is not a valid branch name`);
    }
    const at = opts.startPoint ? resolveRev(repo, opts.startPoint) : h.oid;
    if (!at) throw new GitError(opts.startPoint ? `fatal: '${opts.startPoint}' is not a commit and a branch '${target}' cannot be created from it` : "fatal: Not a valid object name: 'HEAD'.");
    // Refuse before creating anything, so a refused switch leaves no stray branch.
    const blocked = blockingMessage(blockingChanges(repo, readCommit(repo, at)?.tree ?? null), 'checkout');
    if (blocked) throw new GitError(blocked);
    const existed = readRef(repo, `refs/heads/${target}`);
    if (existed) {
      if (h.branch !== `refs/heads/${target}` && checkedOutElsewhere(repo, `refs/heads/${target}`)) throw new GitError(`fatal: '${target}' is already used by another worktree`);
      writeRef(repo, `refs/heads/${target}`, at);
      logRef(repo, `refs/heads/${target}`, existed, at, identity(repo).name, `branch: Reset to ${opts.startPoint ?? 'HEAD'}`, repo.lx.clock);
    } else createBranch(repo, target, at);
    // Starting from a remote-tracking branch makes it the new branch's upstream.
    const tracking = opts.startPoint && !opts.noTrack ? listRefs(repo, 'refs/remotes').find((r) => r.name === `refs/remotes/${opts.startPoint}`) : undefined;
    moveTo(repo, at, { branch: target, label: target });
    if (tracking) {
      const [remoteName, ...rest] = opts.startPoint!.split('/');
      setConfigValue(repo, `branch.${target}.remote`, remoteName);
      setConfigValue(repo, `branch.${target}.merge`, `refs/heads/${rest.join('/')}`);
      io.print(`branch '${target}' set up to track '${opts.startPoint}'.`);
    }
    io.print(existed ? `Switched to and reset branch '${target}'` : `Switched to a new branch '${target}'`);
    return;
  }
  const ref = `refs/heads/${target}`;
  const branchOid = readRef(repo, ref);
  if (branchOid) {
    if (h.branch === ref) return void io.print(`Already on '${target}'`);
    moveTo(repo, branchOid, { branch: target, label: target });
    io.print(`Switched to branch '${target}'`);
    const up = upstreamOf(repo, target);
    if (up) {
      const theirs = readRef(repo, `refs/remotes/${up.remote}/${up.ref.replace('refs/heads/', '')}`);
      const { ahead, behind } = aheadBehind(repo, branchOid, theirs);
      const name = `${up.remote}/${up.ref.replace('refs/heads/', '')}`;
      if (ahead && !behind) io.print(`Your branch is ahead of '${name}' by ${ahead} commit${ahead === 1 ? '' : 's'}.`, '  (use "git push" to publish your local commits)');
      else if (behind && !ahead) io.print(`Your branch is behind '${name}' by ${behind} commit${behind === 1 ? '' : 's'}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)');
      else if (!ahead && !behind && theirs) io.print(`Your branch is up to date with '${name}'.`);
    }
    return;
  }
  // A remote branch name checks out a local branch that follows it.
  const remoteRef = listRefs(repo, 'refs/remotes').find((r) => r.name === `refs/remotes/${target}`);
  const asLocal = listRefs(repo, 'refs/remotes').find((r) => r.name.endsWith(`/${target}`) && !r.name.endsWith('/HEAD'));
  if (!remoteRef && asLocal) {
    const remoteName = asLocal.name.replace('refs/remotes/', '').split('/')[0];
    const blocked = blockingMessage(blockingChanges(repo, readCommit(repo, asLocal.oid)?.tree ?? null), 'checkout');
    if (blocked) throw new GitError(blocked);
    createBranch(repo, target, asLocal.oid);
    setConfigValue(repo, `branch.${target}.remote`, remoteName);
    setConfigValue(repo, `branch.${target}.merge`, `refs/heads/${target}`);
    moveTo(repo, asLocal.oid, { branch: target, label: target });
    io.print(`branch '${target}' set up to track '${remoteName}/${target}'.`, `Switched to a new branch '${target}'`);
    return;
  }
  const oid = resolveRev(repo, target);
  if (!oid) throw new GitError(`error: pathspec '${target}' did not match any file(s) known to git`);
  moveTo(repo, oid, { label: target });
  io.print(
    'Note: switching to \'' + target + "'.",
    '',
    'You are in \'detached HEAD\' state. You can look around, make experimental',
    'changes and commit them, and you can discard any commits you make in this',
    'state without impacting any branches by switching back to a branch.',
    '',
    `HEAD is now at ${shortId(repo, oid)} ${firstLine(readCommit(repo, oid)?.message ?? '')}`,
  );
}

function cmdCheckout(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  if (f.values.orphan) return startOrphan(io, repo, f.values.orphan, false);
  const create = f.values.b ?? f.values.B;
  if (create) return switchTo(io, repo, create, { create: true, startPoint: f.rest[0], force: f.values.B !== undefined, noTrack: has(f, 'no-track') });
  if (!f.paths.length && f.rest.length && !resolveRev(repo, f.rest[0]) && !readRef(repo, `refs/heads/${f.rest[0]}`) && !listRefs(repo, 'refs/remotes').some((r) => r.name.endsWith(`/${f.rest[0]}`))) {
    const tracked = matchPaths(repo, toRepoPath(repo, env, f.rest[0])).filter((p) => isTracked(repo, p));
    if (!tracked.length) throw new GitError(`error: pathspec '${f.rest[0]}' did not match any file(s) known to git`);
  }
  if (f.paths.length || (f.rest.length && !resolveRev(repo, f.rest[0]) && !listRefs(repo, 'refs/remotes').some((r) => r.name.endsWith(`/${f.rest[0]}`)))) {
    // `git checkout -- <path>` throws away changes to those files, and
    // `git checkout <commit> -- <path>` takes them from that commit instead.
    const source = f.rest.length && resolveRev(repo, f.rest[0]) ? f.rest[0] : null;
    const specs = f.paths.length ? f.paths : f.rest;
    return cmdRestore(io, repo, env, source ? [`--source=${source}`, '--worktree', ...specs] : specs);
  }
  const target = f.rest[0];
  if (!target) throw new GitError('fatal: you must specify a branch or commit');
  if (target === '-') {
    const previous = previousBranch(repo);
    if (!previous) throw new GitError('fatal: no previous branch');
    return switchTo(io, repo, previous);
  }
  switchTo(io, repo, target);
}

function previousBranch(repo: Repo): string | null {
  const entries = readReflog(repo, 'HEAD');
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(entries[i].message);
    if (m) return m[1];
  }
  return null;
}

/** A branch with no history yet: HEAD names it, and the next commit is a root. */
function startOrphan(io: Io, repo: Repo, name: string, clear: boolean): void {
  if (readRef(repo, `refs/heads/${name}`)) throw new GitError(`fatal: a branch named '${name}' already exists`);
  // git switch --orphan starts from an empty tree; git checkout --orphan keeps the files staged.
  if (clear) {
    const blocked = blockingMessage(blockingChanges(repo, null), 'checkout');
    if (blocked) throw new GitError(blocked);
    checkoutTree(repo, null);
  }
  setHeadBranch(repo, `refs/heads/${name}`);
  io.print(`Switched to a new branch '${name}'`);
}

function cmdSwitch(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  if (f.values.orphan) return startOrphan(io, repo, f.values.orphan, true);
  const create = f.values.c ?? f.values.C;
  if (create) return switchTo(io, repo, create, { create: true, startPoint: f.rest[0], force: f.values.C !== undefined, noTrack: has(f, 'no-track') });
  const target = f.rest[0];
  if (!target) throw new GitError('fatal: missing branch or commit argument');
  if (target === '-') {
    const previous = previousBranch(repo);
    if (!previous) throw new GitError('fatal: no previous branch');
    return switchTo(io, repo, previous);
  }
  if (has(f, 'detach')) {
    const oid = resolveRev(repo, target);
    if (!oid) throw new GitError(`fatal: invalid reference: ${target}`);
    checkoutCommit(repo, oid);
    setHeadDetached(repo, oid);
    io.print(`HEAD is now at ${shortId(repo, oid)} ${firstLine(readCommit(repo, oid)?.message ?? '')}`);
    return;
  }
  switchTo(io, repo, target);
}

// ---------------------------------------------------------------------------
// merging and replaying

/** Refuse a merge that would overwrite uncommitted work, as git does. */
function guardMerge(repo: Repo, theirOid: Oid): void {
  const theirTree = readCommit(repo, theirOid)?.tree ?? null;
  const ours = treeFiles(repo, headTree(repo));
  const theirs = treeFiles(repo, theirTree);
  const dirty = dirtyPaths(repo);
  const touched = [...dirty].filter((p) => ours.get(p)?.oid !== theirs.get(p)?.oid).sort();
  const untracked = statusOf(repo).untracked.filter((p) => theirs.has(p) && !ours.has(p)).sort();
  const blocked = blockingMessage({ dirty: touched, untracked }, 'merge');
  if (blocked) throw new GitError(blocked);
}

function cmdMerge(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  if (has(f, 'abort')) {
    const merging = slurp(repo.lx, `${repo.gitDir}/MERGE_HEAD`);
    if (!merging) throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
    removeGitFile(repo, 'MERGE_HEAD');
    removeGitFile(repo, 'MERGE_MSG');
    checkoutTree(repo, headTree(repo));
    return;
  }
  if (has(f, 'continue')) {
    if (!slurp(repo.lx, `${repo.gitDir}/MERGE_HEAD`)) throw new GitError('fatal: There is no merge in progress (MERGE_HEAD missing).');
    const msg = (slurp(repo.lx, `${repo.gitDir}/MERGE_MSG`) ?? 'Merge').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    const result = doCommit(repo, msg, {});
    io.print(`[${branchLabel(repo)} ${shortId(repo, result.oid)}] ${firstLine(msg)}`);
    return;
  }
  const name = f.rest[0];
  if (!name) throw new GitError('fatal: No commit specified and merge.defaultToUpstream not set.');
  const oid = resolveRev(repo, name);
  if (!oid) throw new GitError(`merge: ${name} - not something we can merge`);
  if (slurp(repo.lx, `${repo.gitDir}/MERGE_HEAD`)) throw new GitError('error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.');
  guardMerge(repo, oid);
  const option = f.values.X ?? f.values['strategy-option'];
  if (option !== undefined && option !== 'ours' && option !== 'theirs') throw new GitError(`fatal: unknown strategy option: -X${option}`);
  const before = head(repo).oid;
  const outcome = doMerge(repo, oid, name, {
    noFastForward: has(f, 'no-ff'),
    ffOnly: has(f, 'ff-only'),
    squash: has(f, 'squash'),
    noCommit: has(f, 'no-commit'),
    favor: option as 'ours' | 'theirs' | undefined,
    message: message(f),
  });
  switch (outcome.kind) {
    case 'up-to-date':
      io.print('Already up to date.');
      return;
    case 'fast-forward':
      io.print(`Updating ${shortId(repo, before!)}..${shortId(repo, oid)}`, 'Fast-forward');
      io.print(...statLines(filesBetween(repo, treeFiles(repo, readCommit(repo, before!)?.tree ?? null), treeFiles(repo, readCommit(repo, oid)?.tree ?? null)).map(diffStat)));
      return;
    case 'merged':
      io.print(`Merge made by the 'ort' strategy.`);
      io.print(...statLines(filesBetween(repo, treeFiles(repo, readCommit(repo, before!)?.tree ?? null), treeFiles(repo, headTree(repo))).map(diffStat)));
      return;
    case 'squashed':
      io.print('Squash commit -- not updating HEAD', 'Automatic merge went well; stopped before committing as requested');
      return;
    case 'stopped':
      io.print('Automatic merge went well; stopped before committing as requested');
      return;
    case 'conflict':
      for (const p of outcome.conflicts) io.print(`Auto-merging ${p}`);
      for (const p of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${p}`);
      io.fail(1, has(f, 'squash') ? 'Squash commit -- not updating HEAD' : 'Automatic merge failed; fix conflicts and then commit the result.');
      return;
  }
}


function cmdRebase(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const inProgress = Boolean(slurp(repo.lx, `${repo.gitDir}/rebase-merge/orig-head`));
  if (has(f, 'i', 'interactive')) {
    throw new GitError(
      [
        'hint: Interactive rebase needs an editor, and NetLab has none.',
        'hint: The pieces it would give you are here as separate commands:',
        'hint:   move commits to a new base  git rebase --onto <newbase> <upstream> <branch>',
        'hint:   reword the last message     git commit --amend -m "..."',
        'hint:   squash the last two         git reset --soft HEAD~2 && git commit -m "..."',
        'hint:   drop or reorder commits     git cherry-pick the ones you want onto a new branch',
        'fatal: interactive rebase is not simulated',
      ].join('\n'),
    );
  }
  if (has(f, 'abort', 'quit')) {
    if (!inProgress) throw new GitError('fatal: No rebase in progress?');
    const orig = slurp(repo.lx, `${repo.gitDir}/rebase-merge/orig-head`)!.trim();
    const headName = slurp(repo.lx, `${repo.gitDir}/rebase-merge/head-name`)?.trim() ?? 'HEAD';
    if (has(f, 'abort')) {
      checkoutTree(repo, readCommit(repo, orig)?.tree ?? null);
      if (headName.startsWith('refs/')) {
        writeRef(repo, headName, orig);
        setHeadBranch(repo, headName);
      } else setHeadDetached(repo, orig);
    }
    endRebase(repo);
    return;
  }
  if (has(f, 'continue', 'skip')) {
    if (!inProgress) throw new GitError('fatal: No rebase in progress?');
    const stopped = slurp(repo.lx, `${repo.gitDir}/REBASE_HEAD`)?.trim();
    if (has(f, 'skip')) checkoutTree(repo, headTree(repo));
    else {
      if (statusOf(repo).conflicts.length) throw new GitError(['You must edit all merge conflicts and then', 'mark them as resolved using git add'].join('\n'));
      if (stopped) {
        const original = readCommit(repo, stopped)!;
        doCommit(repo, original.message, { allowEmpty: false, author: original.author });
      }
    }
    const todo = (slurp(repo.lx, `${repo.gitDir}/rebase-merge/todo`) ?? '').split('\n').filter(Boolean);
    removeGitFile(repo, 'REBASE_HEAD');
    for (let i = 0; i < todo.length; i++) {
      const oid = todo[i];
      const outcome = cherryPick(repo, oid);
      removeGitFile(repo, 'CHERRY_PICK_HEAD');
      if (outcome.kind === 'conflict') {
        putGitFile(repo, 'REBASE_HEAD', oid + '\n');
        putGitFile(repo, 'rebase-merge/todo', todo.slice(i + 1).join('\n'));
        for (const p of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${p}`);
        io.fail(1, `error: could not apply ${shortId(repo, oid)}... ${firstLine(readCommit(repo, oid)?.message ?? '')}`, 'hint: Resolve all conflicts manually, mark them as resolved with', 'hint: "git add", then run "git rebase --continue".');
        return;
      }
    }
    const headName = slurp(repo.lx, `${repo.gitDir}/rebase-merge/head-name`)?.trim() ?? 'HEAD';
    endRebase(repo);
    io.print(`Successfully rebased and updated ${headName}.`);
    return;
  }
  if (inProgress) throw new GitError('fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)');
  // A rebase starts from a clean tree: there is nowhere to put local changes meanwhile.
  const status = statusOf(repo);
  if (status.unstaged.length || status.staged.length) {
    throw new GitError(['error: cannot rebase: You have ' + (status.unstaged.length ? 'unstaged changes.' : 'uncommitted changes.'), 'error: Please commit or stash them.'].join('\n'));
  }
  // git rebase [--onto <newbase>] <upstream> [<branch>]
  const newbase = f.values.onto;
  const upstreamName = f.rest[0];
  if (!upstreamName) throw new GitError('fatal: No upstream configured for the current branch; name one, as in: git rebase main');
  const upstream = resolveRev(repo, upstreamName);
  if (!upstream) throw new GitError(`fatal: invalid upstream '${upstreamName}'`);
  const onto = newbase ? resolveRev(repo, newbase) : upstream;
  if (!onto) throw new GitError(`fatal: Does not point to a valid commit '${newbase}'`);
  if (f.rest[1]) switchTo(new Io(), repo, f.rest[1]);
  const outcome = doRebase(repo, onto, { label: upstreamName, upstream: newbase ? upstream : undefined });
  if (outcome.kind === 'up-to-date') return void io.print(`Current branch ${branchLabel(repo)} is up to date.`);
  if (outcome.kind === 'conflict') {
    for (const p of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${p}`);
    io.fail(1, `error: could not apply ${shortId(repo, outcome.stoppedAt!)}... ${firstLine(readCommit(repo, outcome.stoppedAt!)?.message ?? '')}`, 'hint: Resolve all conflicts manually, mark them as resolved with', 'hint: "git add", then run "git rebase --continue".');
    return;
  }
  io.print(`Successfully rebased and updated ${head(repo).branch ?? 'HEAD'}.`);
}

/** Refuse to apply a commit over files that have uncommitted changes of their own. */
function guardApply(repo: Repo, oid: Oid, what: string): void {
  const dirty = dirtyPaths(repo);
  if (pathsChangedBy(repo, oid).some((p) => dirty.has(p))) {
    throw new GitError(`error: your local changes would be overwritten by ${what}.\nhint: commit your changes or stash them to proceed.\nfatal: ${what} failed`);
  }
}

/** The commits named on the command line, oldest first for a range. */
function commitsFrom(repo: Repo, specs: string[]): Oid[] {
  const out: Oid[] = [];
  for (const spec of specs) {
    if (isRangeSpec(spec)) out.push(...commitsIn(repo, parseRange(repo, [spec])).reverse());
    else {
      const oid = resolveRev(repo, spec);
      if (!oid) throw new GitError(`fatal: bad revision '${spec}'`);
      out.push(oid);
    }
  }
  return out;
}

function cmdCherryPick(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const picking = slurp(repo.lx, `${repo.gitDir}/CHERRY_PICK_HEAD`)?.trim();
  if (has(f, 'abort')) {
    if (!picking) throw new GitError('error: no cherry-pick or revert in progress\nfatal: cherry-pick failed');
    removeGitFile(repo, 'CHERRY_PICK_HEAD');
    removeGitFile(repo, 'sequencer/todo');
    checkoutTree(repo, headTree(repo));
    return;
  }
  if (has(f, 'skip')) {
    if (!picking) throw new GitError('error: no cherry-pick or revert in progress');
    removeGitFile(repo, 'CHERRY_PICK_HEAD');
    checkoutTree(repo, headTree(repo));
  }
  let todo: Oid[];
  if (has(f, 'continue', 'skip')) {
    if (has(f, 'continue')) {
      if (!picking) throw new GitError('error: no cherry-pick or revert in progress');
      if (statusOf(repo).conflicts.length) throw new GitError('error: Committing is not possible because you have unmerged files.');
      const original = readCommit(repo, picking)!;
      removeGitFile(repo, 'CHERRY_PICK_HEAD');
      const result = doCommit(repo, original.message, { author: original.author });
      io.print(`[${branchLabel(repo)} ${shortId(repo, result.oid)}] ${firstLine(original.message)}`);
    }
    todo = (slurp(repo.lx, `${repo.gitDir}/sequencer/todo`) ?? '').split('\n').filter(Boolean);
    removeGitFile(repo, 'sequencer/todo');
  } else {
    if (!f.rest.length) throw new GitError('usage: git cherry-pick [<options>] <commit-ish>...');
    todo = commitsFrom(repo, f.rest);
  }
  for (let i = 0; i < todo.length; i++) {
    const oid = todo[i];
    guardApply(repo, oid, 'cherry-pick');
    const original = readCommit(repo, oid)!;
    if (original.parents.length > 1) throw new GitError(`error: commit ${oid} is a merge but no -m option was given.\nfatal: cherry-pick failed`);
    const outcome = cherryPick(repo, oid, { noCommit: has(f, 'n', 'no-commit'), recordOrigin: has(f, 'x') });
    if (outcome.kind === 'conflict') {
      if (i + 1 < todo.length) putGitFile(repo, 'sequencer/todo', todo.slice(i + 1).join('\n'));
      for (const p of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${p}`);
      io.fail(1, `error: could not apply ${shortId(repo, oid)}... ${firstLine(original.message)}`, 'hint: After resolving the conflicts, mark them with', 'hint: "git add", then run "git cherry-pick --continue".');
      return;
    }
    const created = outcome.applied[0];
    if (created) io.print(`[${branchLabel(repo)} ${shortId(repo, created)}] ${firstLine(readCommit(repo, created)?.message ?? '')}`);
  }
}

function cmdRevert(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const reverting = slurp(repo.lx, `${repo.gitDir}/REVERT_HEAD`)?.trim();
  if (has(f, 'abort')) {
    if (!reverting) throw new GitError('error: no cherry-pick or revert in progress\nfatal: revert failed');
    removeGitFile(repo, 'REVERT_HEAD');
    removeGitFile(repo, 'sequencer/todo');
    checkoutTree(repo, headTree(repo));
    return;
  }
  let todo: Oid[];
  if (has(f, 'continue', 'skip')) {
    if (!reverting) throw new GitError('error: no cherry-pick or revert in progress');
    if (has(f, 'continue')) {
      if (statusOf(repo).conflicts.length) throw new GitError(['error: Committing is not possible because you have unmerged files.', 'hint: Fix them up in the work tree, and then use "git add" as appropriate.'].join('\n'));
      const original = readCommit(repo, reverting)!;
      removeGitFile(repo, 'REVERT_HEAD');
      const result = doCommit(repo, `Revert "${firstLine(original.message)}"\n\nThis reverts commit ${reverting}.\n`, {});
      io.print(`[${branchLabel(repo)} ${shortId(repo, result.oid)}] Revert "${firstLine(original.message)}"`);
    } else {
      removeGitFile(repo, 'REVERT_HEAD');
      checkoutTree(repo, headTree(repo));
    }
    todo = (slurp(repo.lx, `${repo.gitDir}/sequencer/todo`) ?? '').split('\n').filter(Boolean);
    removeGitFile(repo, 'sequencer/todo');
  } else {
    if (!f.rest.length) throw new GitError('usage: git revert [<options>] <commit-ish>...');
    // A range is reverted newest first, so each revert applies cleanly on the last.
    todo = f.rest.flatMap((spec) => (isRangeSpec(spec) ? commitsIn(repo, parseRange(repo, [spec])) : [resolveRev(repo, spec) ?? spec]));
    for (const oid of todo) if (!/^[0-9a-f]{40}$/.test(oid) || !readCommit(repo, oid)) throw new GitError(`fatal: bad revision '${oid}'`);
  }
  for (let i = 0; i < todo.length; i++) {
    const oid = todo[i];
    guardApply(repo, oid, 'revert');
    if ((readCommit(repo, oid)?.parents.length ?? 0) > 1) throw new GitError(`error: commit ${oid} is a merge but no -m option was given.\nfatal: revert failed`);
    const outcome = doRevert(repo, oid, { noCommit: has(f, 'n', 'no-commit') });
    if (outcome.kind === 'conflict') {
      if (i + 1 < todo.length) putGitFile(repo, 'sequencer/todo', todo.slice(i + 1).join('\n'));
      for (const p of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${p}`);
      io.fail(1, `error: could not revert ${shortId(repo, oid)}... ${firstLine(readCommit(repo, oid)?.message ?? '')}`, 'hint: After resolving the conflicts, mark them with', 'hint: "git add", then run "git revert --continue".');
      return;
    }
    const created = outcome.applied[0];
    if (created) io.print(`[${branchLabel(repo)} ${shortId(repo, created)}] ${firstLine(readCommit(repo, created)?.message ?? '')}`);
  }
}

function cmdReset(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const mode: ResetMode = has(f, 'hard') ? 'hard' : has(f, 'soft') ? 'soft' : 'mixed';
  // The first argument is a commit if it resolves; everything else is a path.
  let rev = 'HEAD';
  const rest = [...f.rest];
  if (rest.length && resolveRev(repo, rest[0]) && !isTracked(repo, toRepoPath(repo, env, rest[0]))) rev = rest.shift()!;
  const specs = [...f.paths, ...rest];
  for (const spec of rest) {
    if (!isTracked(repo, toRepoPath(repo, env, spec)) && !matchPaths(repo, toRepoPath(repo, env, spec)).some((p) => isTracked(repo, p))) {
      throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
  }
  const oid = resolveRev(repo, rev);
  if (!oid) throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  if (specs.length) {
    if (mode === 'hard') throw new GitError('fatal: Cannot do hard reset with paths.');
    if (mode === 'soft') throw new GitError('fatal: Cannot do soft reset with paths.');
    // Resetting paths only unstages them, back to what the commit has.
    cmdRestore(io, repo, env, ['--staged', `--source=${oid}`, ...specs]);
    const status = statusOf(repo);
    if (status.unstaged.length) {
      io.print('Unstaged changes after reset:');
      for (const c of status.unstaged) io.print(`${c.code}\t${c.path}`);
    }
    return;
  }
  doReset(repo, oid, mode);
  if (mode === 'hard') io.print(`HEAD is now at ${shortId(repo, oid)} ${firstLine(readCommit(repo, oid)?.message ?? '')}`);
  else if (mode === 'mixed') {
    const status = statusOf(repo);
    if (status.unstaged.length) {
      io.print('Unstaged changes after reset:');
      for (const c of status.unstaged) io.print(`${c.code}\t${c.path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// stash and tags

function cmdStash(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0] ?? 'push';
  switch (action) {
    case 'push':
    case 'save': {
      const entry = stashPush(repo, message(f) ?? (action === 'save' ? f.rest.slice(1).join(' ') || undefined : undefined), { untracked: has(f, 'u', 'include-untracked', 'a', 'all') });
      if (!entry) return void io.print('No local changes to save');
      io.print(`Saved working directory and index state ${entry.message}`);
      return;
    }
    case 'list': {
      readStash(repo).forEach((entry, i) => io.print(`stash@{${i}}: ${entry.message}`));
      return;
    }
    case 'pop':
    case 'apply':
    case 'branch': {
      const at = stashIndex(action === 'branch' ? f.rest[2] : f.rest[1]);
      const entry = readStash(repo)[at];
      if (!entry) throw new GitError(`error: ${f.rest[1] ?? 'stash@{0}'} is not a valid reference`);
      if (action === 'branch') {
        const name = f.rest[1];
        if (!name) throw new GitError('fatal: No branch name specified');
        const base = readCommit(repo, entry.oid)!.parents[0];
        switchTo(io, repo, name, { create: true, startPoint: base });
      } else {
        // Refuse to write over files that have uncommitted changes of their own.
        const stashed = pathsChangedBy(repo, entry.oid);
        const dirty = dirtyPaths(repo);
        const clash = stashed.filter((p) => dirty.has(p));
        if (clash.length) {
          throw new GitError(['error: Your local changes to the following files would be overwritten by merge:', ...clash.map((p) => `\t${p}`), 'Please commit your changes or stash them before you merge.', 'Aborting', 'The stash entry is kept in case you need it again.'].join('\n'));
        }
      }
      const result = stashApply(repo, at, action !== 'apply');
      if (!result) throw new GitError(`error: ${f.rest[1] ?? 'stash@{0}'} is not a valid reference`);
      cmdStatus(io, repo, ['--short']);
      if (result.conflicts.length) {
        io.fail(1, ...result.conflicts.map((p) => `CONFLICT (content): Merge conflict in ${p}`), 'The stash entry is kept in case you need it again.');
        return;
      }
      if (action !== 'apply') io.print(`Dropped refs/stash@{${at}} (${entry.oid})`);
      return;
    }
    case 'drop': {
      const at = stashIndex(f.rest[1]);
      const entry = readStash(repo)[at];
      if (!entry || !stashDrop(repo, at)) throw new GitError(`error: ${f.rest[1] ?? 'stash@{0}'} is not a valid reference`);
      io.print(`Dropped refs/stash@{${at}} (${entry.oid})`);
      return;
    }
    case 'clear': {
      while (readStash(repo).length) stashDrop(repo, 0);
      return;
    }
    case 'show': {
      const entry = readStash(repo)[stashIndex(f.rest[1])];
      if (!entry) throw new GitError('error: No stash entries found.');
      const commit = readCommit(repo, entry.oid)!;
      const before = treeFiles(repo, commit.parents[0] ? (readCommit(repo, commit.parents[0])?.tree ?? null) : null);
      const files = filesBetween(repo, before, treeFiles(repo, commit.tree));
      if (has(f, 'p', 'patch')) for (const file of files) io.print(...unifiedDiff(file));
      else io.print(...statLines(files.map(diffStat)));
      return;
    }
    default:
      throw new GitError(`error: unknown subcommand: \`${action}'`);
  }
}

function stashIndex(text: string | undefined): number {
  const m = /stash@\{(\d+)\}/.exec(text ?? '');
  return m ? Number(m[1]) : 0;
}

function cmdTag(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const del = f.values.d ?? f.values.delete;
  if (del || has(f, 'd', 'delete')) {
    const name = del ?? f.rest[0];
    const oid = readRef(repo, `refs/tags/${name}`);
    if (!oid) throw new GitError(`error: tag '${name}' not found.`);
    deleteRef(repo, `refs/tags/${name}`);
    io.print(`Deleted tag '${name}' (was ${shortId(repo, oid)})`);
    return;
  }
  const name = f.rest[0];
  const listing = !name || has(f, 'l', 'list') || f.values.contains !== undefined || has(f, 'contains') || f.values.n !== undefined || (has(f, 'n') && !name);
  if (listing) {
    // Patterns are shell globs; -n<num> adds that many lines of each tag's message.
    const patterns = f.rest;
    const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const within = f.values.contains ?? (has(f, 'contains') ? 'HEAD' : undefined);
    const target = within !== undefined ? resolveRev(repo, within) : null;
    if (within !== undefined && !target) throw new GitError(`error: malformed object name ${within}`);
    const lines = f.values.n !== undefined ? Number(f.values.n) || 1 : has(f, 'n') ? 1 : 0;
    for (const { name: ref, oid } of listRefs(repo, 'refs/tags')) {
      const short = ref.replace('refs/tags/', '');
      if (patterns.length && !patterns.some((p) => glob(p).test(short))) continue;
      if (target && !isAncestor(repo, target, resolveRev(repo, ref) ?? oid)) continue;
      if (!lines) {
        io.print(short);
        continue;
      }
      const o = readObject(repo, oid);
      const text = o?.type === 'tag' ? o.tag.message : (readCommit(repo, oid)?.message ?? '');
      const [first, ...more] = text.replace(/\n$/, '').split('\n');
      io.print(`${short.padEnd(15)} ${first}`, ...more.slice(0, lines - 1).map((l) => `${' '.repeat(16)}${l}`));
    }
    return;
  }
  if (!/^[^\s~^:?*[\\]+$/.test(name) || name.startsWith('-') || name.includes('..')) throw new GitError(`fatal: '${name}' is not a valid tag name.`);
  const existing = readRef(repo, `refs/tags/${name}`);
  if (existing && !has(f, 'f', 'force')) throw new GitError(`fatal: tag '${name}' already exists`);
  const at = resolveRev(repo, f.rest[1] ?? 'HEAD');
  if (!at) throw new GitError(`fatal: Failed to resolve '${f.rest[1]}' as a valid ref.`);
  if (existing) io.print(`Updated tag '${name}' (was ${shortId(repo, existing)})`);
  if (has(f, 'a', 'annotate') || message(f)) {
    const text = message(f);
    if (!text) throw new GitError('hint: NetLab has no editor, so an annotated tag needs -m.\nfatal: no tag message given');
    const when = tick(repo);
    const oid = writeObject(repo, { type: 'tag', tag: { object: at, type: 'commit', tag: name, tagger: { ...identity(repo), when }, message: text.endsWith('\n') ? text : text + '\n' } });
    writeRef(repo, `refs/tags/${name}`, oid);
    return;
  }
  writeRef(repo, `refs/tags/${name}`, at);
}

// ---------------------------------------------------------------------------
// remotes

function cmdRemote(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const action = f.rest[0];
  if (!action) {
    for (const { name, url } of remotes(repo)) io.print(...(has(f, 'v', 'verbose') ? [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`] : [name]));
    return;
  }
  const needRemote = (name: string | undefined) => {
    if (!name || !configValue(repo, `remote.${name}.url`)) throw new GitError(`error: No such remote: '${name ?? ''}'`);
    return name;
  };
  if (action === 'rename') {
    const from = needRemote(f.rest[1]);
    const to = f.rest[2];
    if (!to) throw new GitError('usage: git remote rename <old> <new>');
    if (configValue(repo, `remote.${to}.url`)) throw new GitError(`error: remote ${to} already exists.`);
    const config = readConfig(repo);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith(`remote.${from}.`)) next[`remote.${to}.${key.slice(`remote.${from}.`.length)}`] = key.endsWith('.fetch') ? value.replace(`refs/remotes/${from}/`, `refs/remotes/${to}/`) : value;
      else if (/^branch\..+\.remote$/.test(key) && value === from) next[key] = to;
      else next[key] = value;
    }
    writeConfig(repo, next);
    for (const { name: ref, oid } of listRefs(repo, `refs/remotes/${from}`)) {
      writeRef(repo, `refs/remotes/${to}/${ref.slice(`refs/remotes/${from}/`.length)}`, oid);
      deleteRef(repo, ref);
    }
    return;
  }
  if (action === 'get-url') {
    io.print(configValue(repo, `remote.${needRemote(f.rest[1])}.url`)!);
    return;
  }
  if (action === 'show') {
    const name = needRemote(f.rest[1]);
    const url = configValue(repo, `remote.${name}.url`)!;
    const tracked = listRefs(repo, `refs/remotes/${name}`).map((r) => r.name.slice(`refs/remotes/${name}/`.length)).filter((b) => b !== 'HEAD');
    const headOid = readRef(repo, `refs/remotes/${name}/HEAD`);
    const headBranch = headOid ? tracked.find((b) => readRef(repo, `refs/remotes/${name}/${b}`) === headOid && b === 'main') ?? tracked.find((b) => readRef(repo, `refs/remotes/${name}/${b}`) === headOid) : undefined;
    io.print(`* remote ${name}`, `  Fetch URL: ${url}`, `  Push  URL: ${url}`, `  HEAD branch: ${headBranch ?? '(unknown)'}`);
    if (tracked.length) io.print(`  Remote branch${tracked.length === 1 ? '' : 'es'}:`, ...tracked.map((b) => `    ${b} tracked`));
    const pulls = listRefs(repo, 'refs/heads')
      .map((r) => r.name.replace('refs/heads/', ''))
      .map((b) => ({ b, up: upstreamOf(repo, b) }))
      .filter(({ up }) => up?.remote === name);
    if (pulls.length) io.print(`  Local branch${pulls.length === 1 ? '' : 'es'} configured for 'git pull':`, ...pulls.map(({ b, up }) => `    ${b} merges with remote ${up!.ref.replace('refs/heads/', '')}`));
    return;
  }
  if (action === 'prune') {
    // Offline in git would need the network too; ask the remote which branches it still has.
    throw new GitError(`fatal: use 'git fetch --prune ${f.rest[1] ?? 'origin'}' in NetLab to drop remote-tracking branches that are gone.`);
  }
  if (action === 'add') {
    const [, name, url] = f.rest;
    if (!name || !url) throw new GitError('usage: git remote add <name> <url>');
    if (configValue(repo, `remote.${name}.url`)) throw new GitError(`error: remote ${name} already exists.`);
    setConfigValue(repo, `remote.${name}.url`, url);
    setConfigValue(repo, `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
    return;
  }
  if (action === 'remove' || action === 'rm') {
    const name = f.rest[1];
    const config = readConfig(repo);
    if (!config[`remote.${name}.url`]) throw new GitError(`error: No such remote: '${name}'`);
    for (const key of Object.keys(config)) if (key.startsWith(`remote.${name}.`)) delete config[key];
    // Branches that tracked it lose their upstream, as in git.
    for (const key of Object.keys(config)) {
      const m = /^branch\.(.+)\.remote$/.exec(key);
      if (m && config[key] === name) {
        delete config[key];
        delete config[`branch.${m[1]}.merge`];
      }
    }
    writeConfig(repo, config);
    for (const { name: ref } of listRefs(repo, `refs/remotes/${name}`)) deleteRef(repo, ref);
    return;
  }
  if (action === 'set-url') {
    const [, name, url] = f.rest;
    if (!configValue(repo, `remote.${name}.url`)) throw new GitError(`error: No such remote '${name}'`);
    setConfigValue(repo, `remote.${name}.url`, url);
    return;
  }
  if (action === '-v' || has(f, 'v', 'verbose')) {
    for (const { name, url } of remotes(repo)) io.print(`${name}\t${url} (fetch)`, `${name}\t${url} (push)`);
    return;
  }
  throw new GitError(`error: Unknown subcommand: ${action}`);
}

function cmdFetch(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const prune = has(f, 'prune', 'p') || configValue(repo, 'fetch.prune') === 'true';
  const names = has(f, 'all') ? remotes(repo).map((r) => r.name) : [f.rest[0] ?? defaultRemote(repo)];
  for (const name of names) {
    const url = remoteUrl(repo, name);
    if (has(f, 'all')) io.print(`Fetching ${name}`);
    const located = openRemote(ctxOf(env), url);
    if (isTransportError(located)) return void io.fail(located.code, ...located.error);
    const { updates, objects } = fetchFrom(repo, located.repo, name, { branch: has(f, 'all') ? undefined : f.rest[1], tags: has(f, 'no-tags') ? false : undefined, prune });
    reportFetch(io, repo, name, url, updates, objects);
  }
}

function reportFetch(io: Io, repo: Repo, name: string, url: string, updates: ReturnType<typeof fetchFrom>['updates'], objects: number): void {
  const changed = updates.filter((u) => u.kind !== 'up-to-date');
  if (!changed.length) return;
  if (changed.some((u) => u.kind !== 'pruned')) io.err.push(`remote: Enumerating objects: ${objects}, done.`);
  io.err.push(`From ${url}`);
  for (const u of changed) {
    if (u.kind === 'pruned') io.err.push(` - [deleted]         (none)     -> ${name}/${u.branch}`);
    else if (u.kind === 'new') io.err.push(` * [new branch]      ${u.branch}     -> ${name}/${u.branch}`);
    else if (u.kind === 'forced') io.err.push(` + ${shortId(repo, u.from!)}...${shortId(repo, u.to)} ${u.branch} -> ${name}/${u.branch}  (forced update)`);
    else io.err.push(`   ${shortId(repo, u.from!)}..${shortId(repo, u.to)}  ${u.branch}     -> ${name}/${u.branch}`);
  }
}

function cmdPull(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const current = head(repo).branch?.replace('refs/heads/', '') ?? null;
  const upstream = current ? upstreamOf(repo, current) : null;
  const name = f.rest[0] ?? (upstream && upstream.remote !== '.' ? upstream.remote : defaultRemote(repo));
  // With no branch named, pull what this branch tracks; failing that, its namesake.
  const branch = f.rest[1] ?? (upstream && upstream.remote === name ? upstream.ref.replace('refs/heads/', '') : current ?? 'main');
  const url = remoteUrl(repo, name);
  const located = openRemote(ctxOf(env), url);
  if (isTransportError(located)) return void io.fail(located.code, ...located.error);
  const { updates, objects } = fetchFrom(repo, located.repo, name, {});
  reportFetch(io, repo, name, url, updates, objects);
  const theirs = readRef(repo, `refs/remotes/${name}/${branch}`);
  if (!theirs) throw new GitError(`fatal: couldn't find remote ref ${branch}`);
  const rebase = has(f, 'rebase', 'r') || (!has(f, 'no-rebase') && configValue(repo, 'pull.rebase') === 'true');
  if (rebase) {
    const outcome = doRebase(repo, theirs, { label: `${name}/${branch}` });
    if (outcome.kind === 'conflict') {
      for (const path of outcome.conflicts) io.err.push(`CONFLICT (content): Merge conflict in ${path}`);
      io.fail(1, 'error: could not apply ' + shortId(repo, outcome.stoppedAt!), 'hint: Resolve all conflicts manually, mark them as resolved with', 'hint: "git add", then run "git rebase --continue".');
      return;
    }
    io.print(`Successfully rebased and updated refs/heads/${current ?? branch}.`);
    return;
  }
  const passThrough = ['ff-only', 'no-ff', 'squash', 'no-commit', 'ff'].filter((flag) => has(f, flag)).map((flag) => `--${flag}`);
  if (!passThrough.length && configValue(repo, 'pull.ff') === 'only') passThrough.push('--ff-only');
  cmdMerge(io, repo, [...passThrough, `${name}/${branch}`]);
}

function cmdPush(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  const h = head(repo);
  const current = h.branch?.replace('refs/heads/', '') ?? null;
  const upstream = current ? upstreamOf(repo, current) : null;
  const name = f.rest[0] ?? (upstream && upstream.remote !== '.' ? upstream.remote : defaultRemote(repo));
  const url = remoteUrl(repo, name);
  const located = openRemote(ctxOf(env), url);
  if (isTransportError(located)) return void io.fail(located.code, ...located.error);

  // Refspecs: <src>[:<dst>], a leading + to force that one ref, :<dst> to delete.
  const refspecs = f.rest.slice(1);
  const deletes: string[] = has(f, 'delete', 'd') ? [...refspecs] : refspecs.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
  if (deletes.length) {
    io.err.push(`To ${url}`);
    for (const target of deletes) {
      const ref = target.startsWith('refs/') ? target : readRef(located.repo, `refs/tags/${target}`) && !readRef(located.repo, `refs/heads/${target}`) ? `refs/tags/${target}` : `refs/heads/${target}`;
      if (!readRef(located.repo, ref)) throw new GitError(`error: unable to delete '${target}': remote ref does not exist\nerror: failed to push some refs to '${url}'`);
      deleteRef(located.repo, ref);
      if (ref.startsWith('refs/heads/')) deleteRef(repo, `refs/remotes/${name}/${ref.slice('refs/heads/'.length)}`);
      io.err.push(` - [deleted]         ${target}`);
    }
    if (has(f, 'delete', 'd')) return;
  }

  const force = has(f, 'force', 'f');
  const lease = f.values['force-with-lease'] !== undefined || has(f, 'force-with-lease');
  const specs: Array<{ local: string; remote: string; force?: boolean; expect?: Oid | null; src: string; branch?: string }> = [];
  const addSpec = (text: string) => {
    const plus = text.startsWith('+');
    const body = plus ? text.slice(1) : text;
    const [srcText, dstText] = body.includes(':') ? body.split(':') : [body, undefined];
    const src = srcText === 'HEAD' || srcText === '@' ? current : srcText;
    let local: string | null = null;
    let kind: 'heads' | 'tags' = 'heads';
    if (srcText === 'HEAD' || srcText === '@') {
      if (!h.oid) throw new GitError('error: src refspec HEAD does not match any');
      local = h.oid;
    } else if (readRef(repo, `refs/heads/${srcText}`)) local = `refs/heads/${srcText}`;
    else if (readRef(repo, `refs/tags/${srcText}`)) {
      local = `refs/tags/${srcText}`;
      kind = 'tags';
    } else if (srcText.startsWith('refs/') && readRef(repo, srcText)) {
      local = srcText;
      if (srcText.startsWith('refs/tags/')) kind = 'tags';
    } else local = resolveRev(repo, srcText);
    if (!local) throw new GitError(`error: src refspec ${srcText} does not match any\nerror: failed to push some refs to '${url}'`);
    const dstName = dstText ?? (srcText === 'HEAD' || srcText === '@' ? current : srcText.replace(/^refs\/(heads|tags)\//, ''));
    if (!dstName) throw new GitError('fatal: You are not currently on a branch.');
    if (/^[0-9a-f]{4,40}$/.test(srcText) && !dstText) throw new GitError(`error: The destination you provided is not a full refname (i.e.,\nstarting with "refs/"). A commit id needs a destination: git push ${name} ${srcText}:refs/heads/<branch>`);
    const remoteRef = dstName.startsWith('refs/') ? dstName : `refs/${kind}/${dstName}`;
    const branch = remoteRef.startsWith('refs/heads/') ? remoteRef.slice('refs/heads/'.length) : undefined;
    const expect = lease && branch ? readRef(repo, `refs/remotes/${name}/${branch}`) : undefined;
    specs.push({ local, remote: remoteRef, force: plus, expect, src: src ?? srcText, branch: local.startsWith('refs/heads/') ? local.slice('refs/heads/'.length) : srcText === 'HEAD' ? (current ?? undefined) : undefined });
  };
  for (const spec of refspecs) if (!spec.startsWith(':')) addSpec(spec);
  if (has(f, 'all', 'branches')) for (const { name: ref } of listRefs(repo, 'refs/heads')) addSpec(ref.slice('refs/heads/'.length));
  if (has(f, 'tags')) for (const { name: ref } of listRefs(repo, 'refs/tags')) addSpec(ref);
  if (!specs.length && !refspecs.length && !has(f, 'tags', 'all', 'branches')) {
    // No refspec: the current branch, to the branch it tracks (or its own name).
    if (!current) throw new GitError('fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push ' + name + ' HEAD:<name-of-remote-branch>');
    const dst = upstream && upstream.remote === name ? upstream.ref.replace('refs/heads/', '') : current;
    addSpec(`${current}:${dst}`);
  }
  if (!specs.length) return void io.err.push('Everything up-to-date');

  const { results, objects } = pushTo(repo, located.repo, name, specs, { force, dryRun: has(f, 'dry-run') });
  if (results.every((r) => r.kind === 'up-to-date')) return void io.err.push('Everything up-to-date');
  io.err.push(`Enumerating objects: ${objects}, done.`, `To ${url}`);
  let failed = false;
  let stale = false;
  for (const [i, result] of results.entries()) {
    const what = result.tag ? 'tag' : 'branch';
    const arrow = `${specs[i].src.replace(/^refs\/(heads|tags)\//, '')} -> ${result.branch}`;
    if (result.kind === 'up-to-date') continue;
    if (result.kind === 'rejected') {
      failed = true;
      stale ||= result.reason === 'stale info';
      io.err.push(` ! [rejected]        ${arrow} (${result.reason === 'non-fast-forward' ? 'fetch first' : result.reason})`);
      continue;
    }
    if (result.kind === 'new') io.err.push(` * [new ${what}]      ${arrow}`);
    else if (result.kind === 'forced') io.err.push(` + ${shortId(repo, result.from!)}...${shortId(repo, result.to)} ${arrow} (forced update)`);
    else io.err.push(`   ${shortId(repo, result.from!)}..${shortId(repo, result.to)}  ${arrow}`);
  }
  if (has(f, 'u', 'set-upstream') && !has(f, 'dry-run')) {
    for (const [i, result] of results.entries()) {
      const local = specs[i].branch;
      if (result.kind === 'rejected' || result.tag || !local) continue;
      setConfigValue(repo, `branch.${local}.remote`, name);
      setConfigValue(repo, `branch.${local}.merge`, result.ref);
      io.err.push(`branch '${local}' set up to track '${name}/${result.branch}'.`);
    }
  }
  if (failed) {
    const hints = stale
      ? []
      : results.some((r) => r.kind === 'rejected' && r.reason === 'already exists')
        ? ['hint: Updates were rejected because the tag already exists in the remote.']
        : [
            'hint: Updates were rejected because the remote contains work that you do',
            'hint: not have locally. This is usually caused by another repository pushing',
            'hint: to the same ref. If you want to integrate the remote changes, use',
            "hint: 'git pull' before pushing again.",
          ];
    io.fail(1, `error: failed to push some refs to '${url}'`, ...hints);
  }
}

// ---------------------------------------------------------------------------
// plumbing and the rest

function cmdReflog(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  if (f.rest[0] === 'expire') return reflogExpire(io, repo, args.slice(1));
  if (f.rest[0] === 'exists') {
    const ref = f.rest[1] ?? 'HEAD';
    io.code = readReflog(repo, ref.startsWith('refs/') || ref === 'HEAD' ? ref : `refs/heads/${ref}`).length ? 0 : 1;
    return;
  }
  const which = f.rest.filter((r) => r !== 'show')[0] ?? 'HEAD';
  const ref = which === 'HEAD' ? 'HEAD' : `refs/heads/${which}`;
  const entries = readReflog(repo, ref);
  if (!entries.length) throw new GitError(`fatal: no reflog for '${which}'`);
  entries
    .slice()
    .reverse()
    .forEach((entry, i) => io.print(`${shortId(repo, entry.to)} ${which}@{${i}}: ${entry.message}`));
}

function cmdLsFiles(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  for (const entry of readIndex(repo)) {
    if (has(f, 's', 'stage')) io.print(`${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}`);
    else if (entry.stage === 0) io.print(entry.path);
  }
}

function cmdCatFile(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const name = f.rest[f.rest.length - 1];
  const oid = name ? (resolveRev(repo, name) ?? name) : '';
  const object = readObject(repo, oid);
  if (!object) throw new GitError(`fatal: Not a valid object name ${name ?? ''}`);
  if (has(f, 't')) return void io.print(object.type);
  if (has(f, 's')) return void io.print(String(bodyOf(object).length));
  if (has(f, 'p')) return void io.print(...bodyOf(object).replace(/\n$/, '').split('\n'));
  io.print(...bodyOf(object).replace(/\n$/, '').split('\n'));
}

function bodyOf(object: NonNullable<ReturnType<typeof readObject>>): string {
  switch (object.type) {
    case 'blob':
      return object.content;
    case 'tree':
      return object.entries.map((e) => `${e.mode} ${entryType(e.mode)} ${e.oid}\t${e.name}`).join('\n') + '\n';
    case 'commit':
      return [`tree ${object.commit.tree}`, ...object.commit.parents.map((p) => `parent ${p}`), `author ${object.commit.author.name} <${object.commit.author.email}> ${object.commit.author.when} +0000`, `committer ${object.commit.committer.name} <${object.commit.committer.email}> ${object.commit.committer.when} +0000`, '', object.commit.message].join('\n');
    case 'tag':
      return [`object ${object.tag.object}`, `type ${object.tag.type}`, `tag ${object.tag.tag}`, `tagger ${object.tag.tagger.name} <${object.tag.tagger.email}> ${object.tag.tagger.when} +0000`, '', object.tag.message].join('\n');
  }
}

function cmdHashObject(io: Io, repo: Repo, env: GitEnv, args: string[]): void {
  const f = parseFlags(args);
  for (const spec of [...f.rest, ...f.paths]) {
    const content = slurp(env.lx, normalizePath(env.cwd, spec, `/home/${env.lx.user}`));
    if (content === null) throw new GitError(`fatal: could not open '${spec}' for reading`);
    io.print(has(f, 'w') ? blobFor(repo, content) : objectId({ type: 'blob', content }));
  }
}

function cmdRevParse(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  if (has(f, 'git-dir')) return void io.print(repo.gitDir);
  if (has(f, 'show-toplevel')) return void io.print(repo.root);
  if (has(f, 'abbrev-ref')) {
    const h = head(repo);
    const name = f.rest[0] ?? 'HEAD';
    if (name === 'HEAD') return void io.print(h.branch ? h.branch.replace('refs/heads/', '') : 'HEAD');
  }
  for (const name of f.rest) {
    const oid = resolveRev(repo, name);
    if (!oid) throw new GitError(`fatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`);
    io.print(has(f, 'short') ? shortId(repo, oid) : oid);
  }
}

function cmdClean(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const status = statusOf(repo);
  if (!has(f, 'f', 'force') && !has(f, 'n', 'dry-run')) {
    throw new GitError('fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean');
  }
  for (const path of status.untracked) {
    if (has(f, 'n', 'dry-run')) io.print(`Would remove ${path}`);
    else {
      removeWorkingFile(repo, path);
      io.print(`Removing ${path}`);
    }
  }
}

function cmdBlame(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const path = [...f.rest, ...f.paths][0];
  if (!path) throw new GitError('fatal: no path given');
  const history = walk(repo, [head(repo).oid!].filter(Boolean));
  const content = treeFiles(repo, headTree(repo)).get(path);
  if (!content) throw new GitError(`fatal: no such path ${path} in HEAD`);
  const lines = (readBlob(repo, content.oid) ?? '').replace(/\n$/, '').split('\n');
  // Walk backwards through history: the newest commit whose version still holds the
  // line is the one that introduced it.
  const owner = new Array<Oid>(lines.length).fill(history[0]);
  for (let i = 0; i < lines.length; i++) {
    for (const oid of history) {
      const at = treeFiles(repo, readCommit(repo, oid)!.tree).get(path);
      const text = at ? (readBlob(repo, at.oid) ?? '') : '';
      if (text.replace(/\n$/, '').split('\n')[i] === lines[i]) owner[i] = oid;
      else break;
    }
  }
  lines.forEach((line, i) => {
    const commit = readCommit(repo, owner[i])!;
    io.print(`${shortId(repo, owner[i])} (${commit.author.name} ${formatDate(commit.author.when).slice(4, 24)} ${String(i + 1).padStart(2)}) ${line}`);
  });
}

function cmdShortlog(io: Io, repo: Repo, args: string[]): void {
  void args;
  const counts = new Map<string, number>();
  for (const oid of walk(repo, [head(repo).oid!].filter(Boolean))) {
    const name = readCommit(repo, oid)!.author.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) io.print(`${name} (${n}):`);
}


// ---------------------------------------------------------------------------
// more plumbing

function cmdLsTree(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const rev = f.rest[0];
  if (!rev) throw new GitError('usage: git ls-tree [<options>] <tree-ish> [<path>...]');
  const oid = resolveRev(repo, rev);
  if (!oid) throw new GitError(`fatal: Not a valid object name ${rev}`);
  const tree = readCommit(repo, oid)?.tree ?? oid;
  const paths = f.rest.slice(1);
  const recursive = has(f, 'r');
  const print = (entries: Array<{ mode: string; oid: Oid; path: string }>) => {
    for (const e of entries) {
      if (paths.length && !paths.some((p) => e.path === p || e.path.startsWith(p.replace(/\/$/, '') + '/'))) continue;
      io.print(has(f, 'name-only') ? e.path : `${e.mode} ${entryType(e.mode)} ${e.oid}\t${e.path}`);
    }
  };
  if (recursive) return print([...treeFiles(repo, tree)].map(([path, e]) => ({ mode: e.mode, oid: e.oid, path })));
  const object = readObject(repo, tree);
  if (object?.type !== 'tree') throw new GitError(`fatal: not a tree object`);
  print(object.entries.map((e) => ({ mode: e.mode, oid: e.oid, path: e.name })));
}

function cmdShowRef(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const prefixes = has(f, 'heads') ? ['refs/heads'] : has(f, 'tags') ? ['refs/tags'] : ['refs/heads', 'refs/remotes', 'refs/tags', 'refs/notes'];
  const refs = prefixes.flatMap((p) => listRefs(repo, p)).filter((r) => !f.rest.length || f.rest.some((n) => r.name === n || r.name.endsWith(`/${n}`)));
  if (!refs.length) io.code = 1;
  for (const r of refs) io.print(`${r.oid} ${r.name}`);
}

function cmdSymbolicRef(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const [name, target] = f.rest;
  if (name !== 'HEAD') throw new GitError(`fatal: ref ${name ?? ''} is not a symbolic ref`);
  if (target) {
    if (!target.startsWith('refs/')) throw new GitError(`fatal: Refusing to point HEAD outside of refs/`);
    setHeadBranch(repo, target);
    return;
  }
  const h = head(repo);
  if (!h.branch) throw new GitError('fatal: ref HEAD is not a symbolic ref');
  io.print(has(f, 'short') ? h.branch.replace('refs/heads/', '') : h.branch);
}

function cmdUpdateRef(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const [name, value, oldValue] = f.rest;
  if (!name) throw new GitError('usage: git update-ref [<options>] <refname> <new-val> [<old-val>]');
  if (has(f, 'd')) {
    deleteRef(repo, name);
    return;
  }
  const oid = value ? resolveRev(repo, value) : null;
  if (!oid) throw new GitError(`fatal: ${value}: not a valid SHA1`);
  if (oldValue && readRef(repo, name) !== resolveRev(repo, oldValue)) throw new GitError(`fatal: update_ref failed for ref '${name}': cannot lock ref '${name}': is at ${readRef(repo, name)} but expected ${oldValue}`);
  const before = readRef(repo, name);
  if (name === 'HEAD') moveHeadTo(repo, oid);
  else writeRef(repo, name, oid);
  logRef(repo, name, before, oid, identity(repo).name, message(f) ?? 'update-ref', repo.lx.clock);
  void io;
}

function moveHeadTo(repo: Repo, oid: Oid): void {
  const h = head(repo);
  if (h.branch) writeRef(repo, h.branch, oid);
  else setHeadDetached(repo, oid);
}

function cmdCommitTree(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args, new Set(['m', 'p']));
  const tree = f.rest[0] ? resolveRev(repo, f.rest[0]) ?? f.rest[0] : '';
  if (readObject(repo, tree)?.type !== 'tree') throw new GitError(`fatal: not a valid object name ${f.rest[0] ?? ''}`);
  // -p may repeat; parseFlags keeps the last, so read the parents from the raw arguments.
  const parents: Oid[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-p' && args[i + 1]) parents.push(resolveRev(repo, args[++i]) ?? args[i]);
  const text = f.values.m;
  if (!text) throw new GitError('hint: NetLab has no editor, so give the message with -m.\nfatal: no commit message given');
  io.print(createCommitObject(repo, tree, parents, text));
}

function cmdMergeBase(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const [a, b] = f.rest.map((r) => resolveRev(repo, r));
  if (!a || !b) throw new GitError('usage: git merge-base [-a] <commit> <commit>...');
  if (has(f, 'is-ancestor')) {
    io.code = walk(repo, [b]).includes(a) ? 0 : 1;
    return;
  }
  const base = mergeBase(repo, a, b);
  if (!base) {
    io.code = 1;
    return;
  }
  io.print(base);
}

function cmdCherry(io: Io, repo: Repo, args: string[]): void {
  const f = parseFlags(args);
  const upstream = resolveRev(repo, f.rest[0] ?? '@{u}') ?? resolveRev(repo, 'origin/main');
  const tip = resolveRev(repo, f.rest[1] ?? 'HEAD');
  if (!upstream || !tip) throw new GitError('fatal: Could not find a tracked remote branch, please specify <upstream> manually.');
  // A commit whose change is already upstream (by content) is marked -, the rest +.
  const theirs = new Set(commitsIn(repo, { include: [upstream], exclude: [tip] }).map((oid) => patchKey(repo, oid)));
  for (const oid of commitsIn(repo, { include: [tip], exclude: [upstream] }).reverse()) {
    const mark = theirs.has(patchKey(repo, oid)) ? '-' : '+';
    io.print(has(f, 'v') ? `${mark} ${oid} ${firstLine(readCommit(repo, oid)?.message ?? '')}` : `${mark} ${oid}`);
  }
}

function patchKey(repo: Repo, oid: Oid): string {
  return diffOfCommit(repo, oid).map((file) => `${file.path}:${file.before ?? ''}:${file.after ?? ''}`).join('|');
}

// Re-exported for the grader, which reads the same repository the commands write.
export { findRepo, head, listRefs, readCommit, readRef, statusOf, setIndexTo, writeWorkingFile, checkoutTree, blobFor, treeFiles };
