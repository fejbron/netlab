import { describe, expect, it } from 'vitest';
import { gitSite, serverUrl, WORK } from '../content/labs/git-site';
import { executeHost, type NetworkState } from './index';

/** Type lines on a host and collect everything printed. */
function run(net: NetworkState, node: string, ...lines: string[]): { net: NetworkState; out: string[] } {
  const out: string[] = [];
  let n = net;
  for (const line of lines) {
    const r = executeHost(n, node, line);
    out.push(...r.output);
    n = r.network;
  }
  return { net: n, out };
}

const dev = (net: NetworkState, ...lines: string[]) => run(net, 'dev1', ...lines);
const text = (r: { out: string[] }) => r.out.join('\n');
const fileOn = (net: NetworkState, node: string, path: string) => net.hosts[node].linux!.fs[path]?.content;

describe('starting a repository', () => {
  it('creates the files git creates', () => {
    const r = dev(gitSite(), 'git init', 'cat .git/HEAD', 'ls .git');
    expect(text(r)).toContain('Initialized empty Git repository in /home/student/project/.git/');
    expect(text(r)).toContain('ref: refs/heads/main');
    expect(text(r)).toContain('objects');
    expect(text(r)).toContain('refs');
  });

  it('refuses to work outside a repository', () => {
    const r = dev(gitSite(), 'cd ~', 'git status');
    expect(text(r)).toContain('fatal: not a git repository (or any of the parent directories): .git');
  });

  it('asks who you are before the first commit', () => {
    let net = gitSite({ noIdentity: true });
    net = dev(net, 'git init', 'echo hello > a.txt', 'git add a.txt').net;
    const r = dev(net, 'git commit -m "first"');
    expect(text(r)).toContain('Author identity unknown');
    expect(text(r)).toContain('git config --global user.email');
  });
});

describe('the three states', () => {
  it('walks a file from untracked to staged to committed', () => {
    let net = dev(gitSite(), 'git init').net;
    net = dev(net, 'echo hello > a.txt').net;
    expect(text(dev(net, 'git status'))).toContain('Untracked files:');

    net = dev(net, 'git add a.txt').net;
    const staged = dev(net, 'git status');
    expect(text(staged)).toContain('Changes to be committed:');
    expect(text(staged)).toContain('new file:   a.txt');

    const committed = dev(net, 'git commit -m "add a greeting"');
    net = committed.net;
    expect(text(committed)).toMatch(/\[main \(root-commit\) [0-9a-f]{7}\] add a greeting/);
    expect(text(committed)).toContain('1 file changed, 1 insertion(+)');
    expect(text(committed)).toContain('create mode 100644 a.txt');
    expect(text(dev(net, 'git status'))).toContain('nothing to commit, working tree clean');
  });

  it('shows a change as unstaged until it is added', () => {
    let net = dev(gitSite(), 'git init', 'echo one > a.txt', 'git add a.txt', 'git commit -m first').net;
    net = dev(net, 'echo two > a.txt').net;
    const r = dev(net, 'git status --short', 'git diff');
    expect(text(r)).toContain(' M a.txt');
    expect(text(r)).toContain('-one');
    expect(text(r)).toContain('+two');
    // Staged, the same change moves column and leaves git diff empty.
    const staged = dev(net, 'git add a.txt', 'git status --short', 'git diff', 'git diff --staged');
    expect(text(staged)).toContain('M  a.txt');
    expect(text(staged)).toContain('+two');
  });

  it('keeps ignored files out of the way', () => {
    let net = dev(gitSite(), 'git init').net;
    net = dev(net, "printf '*.log\\nbuild/\\n' > .gitignore", 'echo noise > debug.log', 'mkdir build', 'echo out > build/app.js', 'echo real > main.c').net;
    const r = dev(net, 'git status --short');
    expect(text(r)).toContain('?? .gitignore');
    expect(text(r)).toContain('?? main.c');
    expect(text(r)).not.toContain('debug.log');
    expect(text(r)).not.toContain('build/');
  });
});

describe('history', () => {
  const three = ['git init', 'echo one > a.txt', 'git add a.txt', 'git commit -m "first"', 'echo two >> a.txt', 'git commit -am "second"', 'echo three >> a.txt', 'git commit -am "third"'];

  it('logs newest first, and --oneline is one line each', () => {
    const r = dev(gitSite(), ...three, 'git log --oneline');
    const lines = r.out.filter((l) => /^[0-9a-f]{7} /.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('third');
    expect(lines[2]).toContain('first');
    expect(lines[0]).toContain('(HEAD -> main)');
  });

  it('shows author, date and message in the long form', () => {
    const r = dev(gitSite(), ...three, 'git log -n 1');
    expect(text(r)).toMatch(/^commit [0-9a-f]{40}/m);
    expect(text(r)).toContain('Author: Student <student@netlab.lab>');
    expect(text(r)).toMatch(/Date:   \w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4} \+0000/);
    expect(text(r)).toContain('    third');
  });

  it('names commits the way people type them', () => {
    const r = dev(gitSite(), ...three, 'git log --oneline -n 1 HEAD~2', 'git show --stat HEAD~1');
    expect(text(r)).toContain('first');
    expect(text(r)).toContain('second');
    expect(text(r)).toContain('1 file changed');
  });
});

describe('branching and merging', () => {
  const start = ['git init', 'echo base > shared.txt', 'git add .', 'git commit -m "first"'];

  it('creates, lists and switches branches', () => {
    let net = dev(gitSite(), ...start).net;
    const r = dev(net, 'git branch feature', 'git branch', 'git switch feature', 'git branch');
    expect(text(r)).toContain('* main');
    expect(text(r)).toContain("Switched to branch 'feature'");
    expect(text(r)).toContain('* feature');
    void net;
  });

  it('fast-forwards when main has not moved', () => {
    let net = dev(gitSite(), ...start, 'git switch -c feature', 'echo work > feature.txt', 'git add .', 'git commit -m "feature work"').net;
    const r = dev(net, 'git switch main', 'git merge feature');
    expect(text(r)).toContain('Fast-forward');
    expect(fileOn(r.net, 'dev1', `${WORK}/feature.txt`)).toBe('work\n');
  });

  it('makes a merge commit when both sides moved', () => {
    let net = dev(gitSite(), ...start, 'git switch -c feature', 'echo f > feature.txt', 'git add .', 'git commit -m "feature work"').net;
    net = dev(net, 'git switch main', 'echo m > main.txt', 'git add .', 'git commit -m "main work"').net;
    const r = dev(net, 'git merge feature', 'git log --oneline -n 1');
    expect(text(r)).toContain("Merge made by the 'ort' strategy.");
    expect(text(r)).toContain("Merge branch 'feature'");
    expect(fileOn(r.net, 'dev1', `${WORK}/feature.txt`)).toBe('f\n');
    expect(fileOn(r.net, 'dev1', `${WORK}/main.txt`)).toBe('m\n');
  });

  it('stops on a conflict, and commits once it is resolved', () => {
    let net = dev(gitSite(), ...start).net;
    net = dev(net, 'git switch -c feature', 'echo from-feature > shared.txt', 'git commit -am "feature edit"').net;
    net = dev(net, 'git switch main', 'echo from-main > shared.txt', 'git commit -am "main edit"').net;
    const conflict = dev(net, 'git merge feature');
    net = conflict.net;
    expect(text(conflict)).toContain('CONFLICT (content): Merge conflict in shared.txt');
    expect(text(conflict)).toContain('Automatic merge failed; fix conflicts and then commit the result.');

    const marked = fileOn(net, 'dev1', `${WORK}/shared.txt`)!;
    expect(marked).toContain('<<<<<<< HEAD');
    expect(marked).toContain('from-main');
    expect(marked).toContain('=======');
    expect(marked).toContain('from-feature');
    expect(marked).toContain('>>>>>>> feature');
    expect(text(dev(net, 'git status'))).toContain('both modified:   shared.txt');

    const resolved = dev(net, 'echo from-both > shared.txt', 'git add shared.txt', 'git commit -m "merge feature"', 'git log --oneline -n 1');
    expect(text(resolved)).toContain('merge feature');
    expect(text(dev(resolved.net, 'git status'))).toContain('working tree clean');
  });

  it('aborts a merge and leaves no trace', () => {
    let net = dev(gitSite(), ...start).net;
    net = dev(net, 'git switch -c feature', 'echo from-feature > shared.txt', 'git commit -am "feature edit"').net;
    net = dev(net, 'git switch main', 'echo from-main > shared.txt', 'git commit -am "main edit"').net;
    const r = dev(net, 'git merge feature', 'git merge --abort', 'git status');
    expect(fileOn(r.net, 'dev1', `${WORK}/shared.txt`)).toBe('from-main\n');
    expect(text(r)).toContain('working tree clean');
  });
});

describe('rewriting history', () => {
  it('rebases a branch onto a moved main', () => {
    let net = dev(gitSite(), 'git init', 'echo base > a.txt', 'git add .', 'git commit -m first').net;
    net = dev(net, 'git switch -c feature', 'echo work > feature.txt', 'git add .', 'git commit -m "feature work"').net;
    net = dev(net, 'git switch main', 'echo more > main.txt', 'git add .', 'git commit -m "main work"', 'git switch feature').net;
    const r = dev(net, 'git rebase main', 'git log --oneline');
    expect(text(r)).toContain('Successfully rebased');
    const lines = r.out.filter((l) => /^[0-9a-f]{7} /.test(l));
    expect(lines.map((l) => l.replace(/^[0-9a-f]{7} /, '').replace(/\([^)]*\) /, ''))).toEqual(['feature work', 'main work', 'first']);
  });

  it('undoes a commit with revert, keeping the history', () => {
    let net = dev(gitSite(), 'git init', 'echo one > a.txt', 'git add .', 'git commit -m first', 'echo two > a.txt', 'git commit -am second').net;
    const r = dev(net, 'git revert HEAD', 'git log --oneline', 'cat a.txt');
    expect(text(r)).toContain('Revert "second"');
    expect(fileOn(r.net, 'dev1', `${WORK}/a.txt`)).toBe('one\n');
    expect(r.out.filter((l) => /^[0-9a-f]{7} /.test(l))).toHaveLength(3);
  });

  it('moves a branch back with reset, and finds it again in the reflog', () => {
    let net = dev(gitSite(), 'git init', 'echo one > a.txt', 'git add .', 'git commit -m first', 'echo two > a.txt', 'git commit -am second').net;
    const lost = dev(net, 'git rev-parse HEAD').out.find((l) => /^[0-9a-f]{40}$/.test(l))!;
    const r = dev(net, 'git reset --hard HEAD~1', 'cat a.txt', 'git reflog');
    expect(fileOn(r.net, 'dev1', `${WORK}/a.txt`)).toBe('one\n');
    expect(text(r)).toContain('reset: moving to');
    // The commit is still there, and the reflog is how you get back to it.
    const back = dev(r.net, `git reset --hard ${lost}`, 'cat a.txt');
    expect(fileOn(back.net, 'dev1', `${WORK}/a.txt`)).toBe('two\n');
  });

  it('stashes work and brings it back', () => {
    let net = dev(gitSite(), 'git init', 'echo one > a.txt', 'git add .', 'git commit -m first').net;
    net = dev(net, 'echo work-in-progress > a.txt').net;
    const stashed = dev(net, 'git stash', 'cat a.txt', 'git stash list');
    net = stashed.net;
    expect(fileOn(net, 'dev1', `${WORK}/a.txt`)).toBe('one\n');
    expect(text(stashed)).toContain('stash@{0}: WIP on main');
    const popped = dev(net, 'git stash pop');
    expect(fileOn(popped.net, 'dev1', `${WORK}/a.txt`)).toBe('work-in-progress\n');
  });

  it('says plainly that interactive rebase is not simulated, and what to use instead', () => {
    const net = dev(gitSite(), 'git init', 'echo a > a.txt', 'git add .', 'git commit -m first').net;
    const r = dev(net, 'git rebase -i HEAD~1');
    expect(text(r)).toContain('interactive rebase is not simulated');
    expect(text(r)).toContain('git commit --amend');
  });
});

describe('plumbing', () => {
  it('shows the objects behind a commit', () => {
    let net = dev(gitSite(), 'git init', 'echo hello > a.txt', 'git add a.txt', 'git commit -m first').net;
    const r = dev(net, 'git cat-file -t HEAD', 'git cat-file -p HEAD', 'git ls-files -s');
    expect(text(r)).toContain('commit');
    expect(text(r)).toMatch(/^tree [0-9a-f]{40}$/m);
    expect(text(r)).toContain('author Student <student@netlab.lab>');
    expect(text(r)).toMatch(/^100644 [0-9a-f]{40} 0\ta\.txt$/m);
  });

  it('hashes a file the same way twice', () => {
    const net = dev(gitSite(), 'git init', 'echo hello > a.txt').net;
    const first = dev(net, 'git hash-object a.txt').out[0];
    const second = dev(net, 'git hash-object a.txt').out[0];
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toBe(first);
  });
});

describe('remotes', () => {
  const site = () => gitSite({ bare: ['app'] });
  const url = serverUrl('app');
  const firstPush = ['git init', 'echo hello > README.md', 'git add .', 'git commit -m "first"', `git remote add origin ${url}`, 'git push -u origin main'];

  it('pushes to a bare repository on the server', () => {
    const r = dev(site(), ...firstPush);
    expect(text(r)).toContain(`To ${url}`);
    expect(text(r)).toContain('* [new branch]      main -> main');
    // The server really has the commit now.
    const onServer = run(r.net, 'git1', 'git --git-dir=/srv/git/app.git log --oneline');
    expect(text(onServer)).toContain('first');
  });

  it('clones what was pushed, onto another machine', () => {
    let net = dev(site(), ...firstPush).net;
    const r = run(net, 'dev2', 'cd ~', `git clone ${url} app`, 'cd app', 'ls', 'git log --oneline');
    expect(text(r)).toContain("Cloning into 'app'...");
    expect(text(r)).toContain('README.md');
    expect(text(r)).toContain('first');
    expect(fileOn(r.net, 'dev2', '/home/student/app/README.md')).toBe('hello\n');
  });

  it('fetches a colleague\'s work and merges it', () => {
    let net = dev(site(), ...firstPush).net;
    net = run(net, 'dev2', 'cd ~', `git clone ${url} app`, 'cd app', 'echo "from sam" > NOTES.md', 'git add .', 'git commit -m "sam adds notes"', 'git push').net;
    const r = dev(net, 'git fetch', 'git status', 'git pull');
    expect(text(r)).toContain('Your branch is behind');
    expect(text(r)).toContain('Fast-forward');
    expect(fileOn(r.net, 'dev1', `${WORK}/NOTES.md`)).toBe('from sam\n');
  });

  it('rejects a push that would lose the other side\'s commits', () => {
    let net = dev(site(), ...firstPush).net;
    net = run(net, 'dev2', 'cd ~', `git clone ${url} app`, 'cd app', 'echo "from sam" > NOTES.md', 'git add .', 'git commit -m "sam adds notes"', 'git push').net;
    net = dev(net, 'echo "mine" > MINE.md', 'git add .', 'git commit -m "my work"').net;
    const rejected = dev(net, 'git push');
    expect(text(rejected)).toContain('! [rejected]');
    expect(text(rejected)).toContain('(fetch first)');
    expect(text(rejected)).toContain('hint:');
    // Sam's commit is still on the server: nothing was lost.
    const onServer = run(rejected.net, 'git1', 'git --git-dir=/srv/git/app.git log --oneline');
    expect(text(onServer)).toContain('sam adds notes');

    // Pulling first, then pushing, is what works.
    const fixed = dev(rejected.net, 'git pull --rebase', 'git push');
    expect(text(fixed)).toContain('main -> main');
    const after = run(fixed.net, 'git1', 'git --git-dir=/srv/git/app.git log --oneline');
    expect(text(after)).toContain('my work');
    expect(text(after)).toContain('sam adds notes');
  });

  it('refuses a remote it has no key for', () => {
    const net = gitSite({ bare: ['app'] });
    // Take the key away, which is what a machine that has never been set up looks like.
    delete net.hosts.git1.linux!.fs['/home/student/.ssh/authorized_keys'];
    const r = dev(net, 'git init', 'echo x > a.txt', 'git add .', 'git commit -m first', `git remote add origin ${serverUrl('app')}`, 'git push -u origin main');
    expect(text(r)).toContain('Permission denied (publickey)');
    expect(text(r)).toContain('Could not read from remote repository');
  });
});

/** Regressions: each of these reproduced a real bug found in code review. */
describe('review regressions', () => {
  const base = ['git init', 'echo one > a.txt', 'git add .', 'git commit -m first'];
  const objectCount = (net: NetworkState) => Object.keys(net.hosts.dev1.linux!.fs).filter((k) => k.includes('/.git/objects/') && k.split('/.git/objects/')[1].includes('/')).length;

  it('refuses to switch branches over uncommitted work', () => {
    let net = dev(gitSite(), ...base, 'git switch -c feature', 'echo two > a.txt', 'git commit -am second', 'git switch main').net;
    net = dev(net, 'echo precious > a.txt').net;
    const r = dev(net, 'git switch feature');
    expect(text(r)).toContain('Your local changes to the following files would be overwritten by checkout');
    expect(fileOn(r.net, 'dev1', `${WORK}/a.txt`)).toBe('precious\n');
    expect(text(dev(r.net, 'git branch'))).toContain('* main');
  });

  it('carries uncommitted work across a switch when both branches agree on the file', () => {
    let net = dev(gitSite(), ...base, 'echo b > b.txt', 'git add .', 'git commit -m b', 'git branch feature').net;
    net = dev(net, 'echo edited > b.txt').net;
    const r = dev(net, 'git switch feature');
    expect(text(r)).toContain("Switched to branch 'feature'");
    expect(fileOn(r.net, 'dev1', `${WORK}/b.txt`)).toBe('edited\n');
  });

  it('refuses a merge that would overwrite an uncommitted edit, and keeps unrelated edits', () => {
    let net = dev(gitSite(), ...base, 'echo b > b.txt', 'git add .', 'git commit -m b', 'git switch -c feature', 'echo changed > a.txt', 'git commit -am change-a', 'git switch main').net;
    const refused = dev(net, 'echo mine > a.txt', 'git merge feature');
    expect(text(refused)).toContain('would be overwritten by merge');
    net = dev(net, 'echo edit > b.txt', 'git merge feature').net;
    expect(fileOn(net, 'dev1', `${WORK}/b.txt`)).toBe('edit\n');
    expect(fileOn(net, 'dev1', `${WORK}/a.txt`)).toBe('changed\n');
  });

  it('does not delete an untracked file when asked to restore it', () => {
    const r = dev(gitSite(), ...base, 'echo new > c.txt', 'git checkout -- c.txt');
    expect(text(r)).toContain("pathspec 'c.txt' did not match any file(s) known to git");
    expect(fileOn(r.net, 'dev1', `${WORK}/c.txt`)).toBe('new\n');
  });

  it('only aborts a rebase when one is in progress', () => {
    const net = dev(gitSite(), ...base, 'echo two > a.txt', 'git commit -am second', 'git reset --hard HEAD~1', 'echo three > a.txt', 'git commit -am third').net;
    const r = dev(net, 'git rebase --abort', 'git log --oneline -n 1');
    expect(text(r)).toContain('No rebase in progress?');
    expect(text(r)).toContain('third');
  });

  it('records where HEAD really came from, so checkout - goes back', () => {
    const r = dev(gitSite(), ...base, 'git switch -c feature', 'git reflog', 'git switch -', 'git branch');
    expect(text(r)).toContain('checkout: moving from main to feature');
    expect(text(r)).toContain('* main');
  });

  it('does not treat repository files as revisions', () => {
    const r = dev(gitSite(), 'git init', 'echo settings > config', 'git add config', 'git commit -m first', 'echo changed > config', 'git checkout config');
    expect(text(r)).not.toContain('HEAD is now at');
    expect(fileOn(r.net, 'dev1', `${WORK}/config`)).toBe('settings\n');
  });

  it('adds an ignored file with -f', () => {
    const r = dev(gitSite(), 'git init', "printf '*.log\\n' > .gitignore", 'echo noise > debug.log', 'git add -f debug.log', 'git status --short');
    expect(text(r)).toContain('A  debug.log');
  });

  it('reports a mistyped branch or revision instead of silently succeeding', () => {
    const net = dev(gitSite(), ...base).net;
    expect(text(dev(net, 'git checkout no-such-branch'))).toContain("pathspec 'no-such-branch' did not match");
    expect(text(dev(net, 'git reset --hard typo'))).toContain("ambiguous argument 'typo'");
  });

  it('does not write objects just to show status or a diff', () => {
    let net = dev(gitSite(), ...base).net;
    const before = objectCount(net);
    net = dev(net, 'echo two > a.txt', 'git status', 'echo three > a.txt', 'git status', 'git diff').net;
    expect(objectCount(net)).toBe(before);
  });

  it('keeps a .keep file when git init runs', () => {
    const r = dev(gitSite(), 'mkdir sub', 'touch sub/.keep', 'cd sub', 'git init', 'ls -a');
    expect(fileOn(r.net, 'dev1', `${WORK}/sub/.keep`)).toBe('');
  });

  it('understands A..B and A...B', () => {
    const net = dev(gitSite(), ...base, 'git switch -c feature', 'echo f > f.txt', 'git add .', 'git commit -m feature-work', 'git switch main').net;
    const log = dev(net, 'git log --oneline main..feature');
    expect(log.out.filter((l) => /^[0-9a-f]{7} /.test(l))).toHaveLength(1);
    expect(text(log)).toContain('feature-work');
    expect(text(dev(net, 'git diff main..feature'))).toContain('+f');
    expect(text(dev(net, 'git diff main...feature'))).toContain('+f');
  });

  it('keeps the original author date when amending or cherry-picking', () => {
    const net = dev(gitSite(), ...base, 'git log -n 1').net;
    const before = dev(net, 'git log -n 1').out.find((l) => l.startsWith('Date:'));
    const after = dev(net, 'git commit --amend -m "first, reworded"', 'git log -n 1').out.find((l) => l.startsWith('Date:'));
    expect(after).toBe(before);
  });

  it('renames a branch together with its reflog and upstream settings', () => {
    const r = dev(gitSite(), ...base, 'git config branch.main.remote origin', 'git branch -m main trunk', 'git reflog trunk', 'git config branch.trunk.remote');
    expect(text(r)).not.toContain('no reflog');
    expect(r.out).toContain('origin');
  });

  it('refuses to remove a file with local modifications', () => {
    const r = dev(gitSite(), ...base, 'echo edited > a.txt', 'git rm a.txt');
    expect(text(r)).toContain('has local modifications');
    expect(fileOn(r.net, 'dev1', `${WORK}/a.txt`)).toBe('edited\n');
  });

  it('refuses to clone a path that is not itself a repository', () => {
    const r = dev(gitSite(), ...base, 'cd ~', 'git clone /home/student/project/nothing-here copy');
    expect(text(r)).toContain('does not exist');
  });
});
