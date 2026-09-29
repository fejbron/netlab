import { describe, expect, it } from 'vitest';
import { createLinuxState, type LinuxState } from '../linux/fs';
import { mergeText, unifiedDiff } from './diff';
import { decodeObject, encodeObject, objectId, sha1, type GitObject } from './objects';
import { commit, createBranch, merge, rebase, reset } from './ops';
import { findRepo, head, initRepo, readCommit, setConfigValue, setHeadBranch, type Repo } from './repo';
import { mergeBase, resolveRev, walk } from './revs';
import { checkoutTree } from './worktree';
import { stagePaths, statusOf, writeWorkingFile } from './worktree';

function repoAt(dir = '/home/student/project'): { lx: LinuxState; repo: Repo } {
  const lx = createLinuxState({ hostname: 'dev1' }, 'dev1');
  lx.fs[dir] = { type: 'dir', content: '', owner: 'student', group: 'student', mode: 0o755, mtime: 0 };
  lx.user = 'student';
  lx.cwd = dir;
  const repo = initRepo(lx, dir);
  setConfigValue(repo, 'user.name', 'Student');
  setConfigValue(repo, 'user.email', 'student@netlab.lab');
  return { lx, repo };
}

function write(repo: Repo, path: string, content: string) {
  writeWorkingFile(repo, path, content, '100644');
}

function commitFile(repo: Repo, path: string, content: string, message: string) {
  write(repo, path, content);
  stagePaths(repo, [path]);
  return commit(repo, message);
}

describe('objects', () => {
  it('hashes like SHA-1', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1('The quick brown fox jumps over the lazy dog')).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
  });

  it('round-trips every object type', () => {
    const blob = { type: 'blob', content: 'hello\n' } as const;
    expect(decodeObject(encodeObject(blob))).toEqual(blob);
    const tree: GitObject = { type: 'tree', entries: [{ mode: '100644', name: 'a.txt', oid: objectId(blob) }] };
    expect(decodeObject(encodeObject(tree))).toEqual(tree);
    const commitObj: GitObject = {
      type: 'commit',
      commit: { tree: objectId(tree), parents: [], author: { name: 'A', email: 'a@b', when: 100, tz: '+0000' }, committer: { name: 'A', email: 'a@b', when: 100, tz: '+0000' }, message: 'first\n' },
    } as const;
    expect(decodeObject(encodeObject(commitObj))).toEqual(commitObj);
  });

  it('gives the same content the same id, and different content a different one', () => {
    expect(objectId({ type: 'blob', content: 'x' })).toBe(objectId({ type: 'blob', content: 'x' }));
    expect(objectId({ type: 'blob', content: 'x' })).not.toBe(objectId({ type: 'blob', content: 'y' }));
  });
});

describe('a repository on the filesystem', () => {
  it('writes the files a learner can look at', () => {
    const { lx, repo } = repoAt();
    expect(lx.fs['/home/student/project/.git/HEAD']?.content).toBe('ref: refs/heads/main\n');
    expect(lx.fs['/home/student/project/.git/config']?.content).toContain('[core]');
    expect(findRepo(lx, '/home/student/project')?.gitDir).toBe('/home/student/project/.git');
    void repo;
  });

  it('finds the repository from a subdirectory', () => {
    const { lx } = repoAt();
    lx.fs['/home/student/project/src'] = { type: 'dir', content: '', owner: 'student', group: 'student', mode: 0o755, mtime: 0 };
    expect(findRepo(lx, '/home/student/project/src')?.root).toBe('/home/student/project');
    expect(findRepo(lx, '/home/student')).toBeNull();
  });

  it('stores objects where git puts them', () => {
    const { lx, repo } = repoAt();
    const oid = commitFile(repo, 'a.txt', 'hello\n', 'first').oid;
    expect(lx.fs[`/home/student/project/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`]).toBeTruthy();
    expect(lx.fs['/home/student/project/.git/refs/heads/main']?.content.trim()).toBe(oid);
  });
});

describe('status', () => {
  it('separates staged, unstaged and untracked', () => {
    const { repo } = repoAt();
    commitFile(repo, 'a.txt', 'one\n', 'first');
    write(repo, 'a.txt', 'two\n');
    write(repo, 'b.txt', 'new\n');
    stagePaths(repo, ['b.txt']);
    write(repo, 'c.txt', 'never mentioned\n');
    const s = statusOf(repo);
    expect(s.staged).toEqual([{ code: 'A', path: 'b.txt' }]);
    expect(s.unstaged).toEqual([{ code: 'M', path: 'a.txt' }]);
    expect(s.untracked).toEqual(['c.txt']);
  });

  it('honours .gitignore', () => {
    const { repo } = repoAt();
    write(repo, '.gitignore', '*.log\nbuild/\n');
    write(repo, 'debug.log', 'noise\n');
    write(repo, 'build/out.js', 'compiled\n');
    write(repo, 'keep.txt', 'yes\n');
    expect(statusOf(repo).untracked).toEqual(['.gitignore', 'keep.txt']);
  });

  it('reports a staged deletion', () => {
    const { repo } = repoAt();
    commitFile(repo, 'a.txt', 'one\n', 'first');
    repo.lx.fs['/home/student/project/a.txt'] = undefined as never;
    delete repo.lx.fs['/home/student/project/a.txt'];
    stagePaths(repo, ['a.txt']);
    expect(statusOf(repo).staged).toEqual([{ code: 'D', path: 'a.txt' }]);
  });
});

describe('commits and history', () => {
  it('chains commits and refuses an empty one', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'a.txt', 'one\n', 'first');
    expect(first.root).toBe(true);
    const second = commitFile(repo, 'a.txt', 'two\n', 'second');
    expect(readCommit(repo, second.oid)?.parents).toEqual([first.oid]);
    expect(() => commit(repo, 'nothing')).toThrow(/nothing to commit/);
  });

  it('resolves the names people type', () => {
    const { repo } = repoAt();
    const a = commitFile(repo, 'f', '1\n', 'a').oid;
    const b = commitFile(repo, 'f', '2\n', 'b').oid;
    const c = commitFile(repo, 'f', '3\n', 'c').oid;
    expect(resolveRev(repo, 'HEAD')).toBe(c);
    expect(resolveRev(repo, 'HEAD~1')).toBe(b);
    expect(resolveRev(repo, 'HEAD~2')).toBe(a);
    expect(resolveRev(repo, 'main^')).toBe(b);
    expect(resolveRev(repo, c.slice(0, 7))).toBe(c);
    expect(resolveRev(repo, 'nope')).toBeNull();
  });

  it('walks history newest first', () => {
    const { repo } = repoAt();
    const a = commitFile(repo, 'f', '1\n', 'a').oid;
    const b = commitFile(repo, 'f', '2\n', 'b').oid;
    expect(walk(repo, [b])).toEqual([b, a]);
  });
});

describe('branching and merging', () => {
  it('fast-forwards when nothing diverged', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'a.txt', 'one\n', 'first').oid;
    createBranch(repo, 'feature', first);
    setHeadBranch(repo, 'refs/heads/feature');
    const second = commitFile(repo, 'b.txt', 'two\n', 'second').oid;
    setHeadBranch(repo, 'refs/heads/main');
    checkoutTree(repo, readCommit(repo, first)!.tree);
    const outcome = merge(repo, second, 'feature');
    expect(outcome.kind).toBe('fast-forward');
    expect(head(repo).oid).toBe(second);
    expect(repo.lx.fs['/home/student/project/b.txt']?.content).toBe('two\n');
  });

  it('merges two sides that touched different files', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'shared.txt', 'base\n', 'first').oid;
    createBranch(repo, 'feature', first);
    commitFile(repo, 'main-only.txt', 'from main\n', 'on main');
    const mainTip = head(repo).oid!;
    setHeadBranch(repo, 'refs/heads/feature');
    checkoutTree(repo, readCommit(repo, first)!.tree);
    commitFile(repo, 'feature-only.txt', 'from feature\n', 'on feature');
    const featureTip = head(repo).oid!;
    setHeadBranch(repo, 'refs/heads/main');
    checkoutTree(repo, readCommit(repo, mainTip)!.tree);
    const outcome = merge(repo, featureTip, 'feature');
    expect(outcome.kind).toBe('merged');
    expect(readCommit(repo, outcome.oid!)?.parents).toEqual([mainTip, featureTip]);
    expect(repo.lx.fs['/home/student/project/feature-only.txt']?.content).toBe('from feature\n');
    expect(repo.lx.fs['/home/student/project/main-only.txt']?.content).toBe('from main\n');
    expect(mergeBase(repo, mainTip, featureTip)).toBe(first);
  });

  it('leaves conflict markers when both sides changed the same line', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'a.txt', 'hello\n', 'first').oid;
    createBranch(repo, 'feature', first);
    commitFile(repo, 'a.txt', 'hello from main\n', 'main edit');
    const mainTip = head(repo).oid!;
    setHeadBranch(repo, 'refs/heads/feature');
    checkoutTree(repo, readCommit(repo, first)!.tree);
    commitFile(repo, 'a.txt', 'hello from feature\n', 'feature edit');
    const featureTip = head(repo).oid!;
    setHeadBranch(repo, 'refs/heads/main');
    checkoutTree(repo, readCommit(repo, mainTip)!.tree);
    const outcome = merge(repo, featureTip, 'feature');
    expect(outcome.kind).toBe('conflict');
    expect(outcome.conflicts).toEqual(['a.txt']);
    const text = repo.lx.fs['/home/student/project/a.txt']!.content;
    expect(text).toContain('<<<<<<< HEAD');
    expect(text).toContain('hello from main');
    expect(text).toContain('=======');
    expect(text).toContain('hello from feature');
    expect(text).toContain('>>>>>>> feature');
    expect(statusOf(repo).conflicts).toEqual(['a.txt']);
    // Staging the resolution clears the conflict and lets the merge commit land.
    write(repo, 'a.txt', 'hello from both\n');
    stagePaths(repo, ['a.txt']);
    expect(statusOf(repo).conflicts).toEqual([]);
    const done = commit(repo, "Merge branch 'feature'");
    expect(readCommit(repo, done.oid)?.parents).toEqual([mainTip, featureTip]);
  });
});

describe('rebase and reset', () => {
  it('replays commits onto another branch, giving them new ids', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'a.txt', 'one\n', 'first').oid;
    createBranch(repo, 'feature', first);
    commitFile(repo, 'main.txt', 'main work\n', 'main moves on');
    const mainTip = head(repo).oid!;
    setHeadBranch(repo, 'refs/heads/feature');
    checkoutTree(repo, readCommit(repo, first)!.tree);
    const featureCommit = commitFile(repo, 'feature.txt', 'feature work\n', 'feature work').oid;
    const outcome = rebase(repo, mainTip);
    expect(outcome.kind).toBe('ok');
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.applied[0]).not.toBe(featureCommit);
    expect(readCommit(repo, outcome.applied[0])?.parents).toEqual([mainTip]);
    // Both files are present afterwards: the replay kept main's work.
    expect(repo.lx.fs['/home/student/project/main.txt']?.content).toBe('main work\n');
    expect(repo.lx.fs['/home/student/project/feature.txt']?.content).toBe('feature work\n');
  });

  it('reset --hard throws the work away, reset --soft keeps it staged', () => {
    const { repo } = repoAt();
    const first = commitFile(repo, 'a.txt', 'one\n', 'first').oid;
    commitFile(repo, 'a.txt', 'two\n', 'second');
    reset(repo, first, 'soft');
    expect(statusOf(repo).staged).toEqual([{ code: 'M', path: 'a.txt' }]);
    reset(repo, first, 'hard');
    expect(statusOf(repo).staged).toEqual([]);
    expect(repo.lx.fs['/home/student/project/a.txt']?.content).toBe('one\n');
  });
});

describe('diff and three-way merge', () => {
  it('produces a unified diff', () => {
    const out = unifiedDiff({ path: 'a.txt', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' });
    expect(out[0]).toBe('diff --git a/a.txt b/a.txt');
    expect(out).toContain('@@ -1,3 +1,3 @@');
    expect(out).toContain('-two');
    expect(out).toContain('+TWO');
    expect(out).toContain(' one');
  });

  it('takes each side when only one changed, and conflicts when both did', () => {
    expect(mergeText('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n', { ours: 'HEAD', theirs: 'x' })).toEqual({ content: 'a\nB\nc\n', conflicted: false });
    expect(mergeText('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n', { ours: 'HEAD', theirs: 'x' })).toEqual({ content: 'a\nb\nC\n', conflicted: false });
    const both = mergeText('a\nb\nc\n', 'a\nOURS\nc\n', 'a\nTHEIRS\nc\n', { ours: 'HEAD', theirs: 'x' });
    expect(both.conflicted).toBe(true);
    expect(both.content).toContain('<<<<<<< HEAD');
  });

  it('combines edits to different parts of one file', () => {
    const merged = mergeText('one\ntwo\nthree\n', 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n', { ours: 'HEAD', theirs: 'x' });
    expect(merged).toEqual({ content: 'ONE\ntwo\nTHREE\n', conflicted: false });
  });
});
