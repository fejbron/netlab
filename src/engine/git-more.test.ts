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

const base = ['git init', 'echo one > a.txt', 'git add .', 'git commit -m first'];
/** main and feature diverge from "first", then feature is merged back. */
const merged = [
  ...base,
  'git switch -c feature',
  'echo f > f.txt',
  'git add .',
  'git commit -m "feature work"',
  'git switch main',
  'echo two >> a.txt',
  'git commit -am "main work"',
  'git merge feature -m "Merge feature"',
];
const url = serverUrl('app');
const published = [...base, `git remote add origin ${url}`, 'git push -u origin main'];
const site = () => gitSite({ bare: ['app'] });

describe('git log output', () => {
  it('draws the branch and merge lanes of --graph', () => {
    const r = dev(gitSite(), ...merged);
    const lines = dev(r.net, 'git log --graph --oneline --all').out;
    expect(lines[0]).toMatch(/^\*   [0-9a-f]{7} \(HEAD -> main\) Merge feature$/);
    expect(lines[1]).toBe('|\\');
    expect(lines.some((l) => /^\* \| [0-9a-f]{7} main work$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\| \* [0-9a-f]{7} \(feature\) feature work$/.test(l))).toBe(true);
    expect(lines).toContain('|/');
    expect(lines[lines.length - 1]).toMatch(/^\* [0-9a-f]{7} first$/);
  });

  it('puts full entries beside the lanes', () => {
    const r = dev(gitSite(), ...merged, 'git log --graph -n 1');
    expect(text(r)).toMatch(/\*   commit [0-9a-f]{40} \(HEAD -> main\)\n\|\\  Merge: [0-9a-f]{7} [0-9a-f]{7}\n\| \| Author:/);
  });

  it('expands --format placeholders and --pretty presets', () => {
    const r = dev(gitSite(), ...base);
    expect(text(dev(r.net, 'git log --format="%h|%an|%ae|%s"'))).toMatch(/^[0-9a-f]{7}\|Student\|student@netlab\.lab\|first$/);
    expect(text(dev(r.net, 'git log --pretty=format:"%H %P"'))).toMatch(/^[0-9a-f]{40} $/);
    const short = dev(r.net, 'git log --pretty=short');
    expect(text(short)).toContain('Author: Student');
    expect(text(short)).not.toContain('Date:');
    expect(text(dev(r.net, 'git log --pretty=oneline'))).toMatch(/^[0-9a-f]{40} \(HEAD -> main\) first$/);
  });

  it('finds commits by content with -S and -G', () => {
    const r = dev(gitSite(), ...merged, 'echo password=hunter2 >> a.txt', 'git commit -am config');
    expect(dev(r.net, 'git log -Shunter2 --oneline').out).toEqual([expect.stringMatching(/config$/)]);
    expect(dev(r.net, 'git log -S hunter2 --oneline').out).toHaveLength(1);
    expect(dev(r.net, 'git log -G "^two" --oneline').out).toEqual([expect.stringMatching(/main work$/)]);
  });

  it('lists oldest first with --reverse', () => {
    const r = dev(dev(gitSite(), ...merged).net, 'git log --reverse --oneline');
    expect(r.out[0]).toMatch(/first$/);
    expect(r.out[r.out.length - 1]).toMatch(/Merge feature$/);
  });

  it('counts an appended line as one insertion', () => {
    const r = dev(gitSite(), ...base, 'echo two >> a.txt', 'git commit -am second');
    expect(text(r)).toContain('1 file changed, 1 insertion(+)');
    expect(text(r)).not.toContain('deletion');
  });
});

describe('git itself', () => {
  it('does not mistake a flag containing h for --help', () => {
    const r = dev(gitSite(), ...base, 'git log -Shello --oneline');
    expect(text(r)).not.toContain('usage: git');
  });

  it('runs in another directory with -C', () => {
    const r = dev(gitSite(), ...base, 'cd ~', `git -C ${WORK} log --oneline`);
    expect(text(r)).toMatch(/[0-9a-f]{7} \(HEAD -> main\) first/);
    expect(text(dev(r.net, 'git -C nowhere status'))).toContain("fatal: cannot change to 'nowhere'");
  });

  it('resolves rev:path, @ and @{u}', () => {
    let net = dev(site(), ...published).net;
    expect(text(dev(net, 'git cat-file -p HEAD:a.txt'))).toBe('one');
    expect(text(dev(net, 'git rev-parse @'))).toBe(text(dev(net, 'git rev-parse HEAD')));
    net = dev(net, 'echo two >> a.txt', 'git commit -am second').net;
    expect(text(dev(net, 'git rev-parse @{u}'))).toBe(text(dev(net, 'git rev-parse origin/main')));
    expect(text(dev(net, 'git log --oneline @{u}..HEAD'))).toMatch(/second$/);
  });
});

describe('git branch', () => {
  it('filters with --merged, --no-merged and --contains', () => {
    const r = dev(gitSite(), ...base, 'git branch done', 'git switch -c open', 'echo x > x.txt', 'git add .', 'git commit -m open', 'git switch main');
    expect(dev(r.net, 'git branch --merged').out).toEqual(['  done', '* main']);
    expect(dev(r.net, 'git branch --no-merged').out).toEqual(['  open']);
    expect(dev(r.net, 'git branch --contains open').out).toEqual(['  open']);
  });

  it('shows the current branch, and upstream state with -vv', () => {
    const r = dev(site(), ...published, 'echo two >> a.txt', 'git commit -am second');
    expect(text(dev(r.net, 'git branch --show-current'))).toBe('main');
    expect(text(dev(r.net, 'git branch -vv'))).toMatch(/\* main [0-9a-f]{7} \[origin\/main: ahead 1\] second/);
  });

  it('sets and unsets an upstream', () => {
    let net = dev(site(), ...published, 'git branch topic').net;
    const set = dev(net, 'git branch -u origin/main topic');
    net = set.net;
    expect(text(set)).toContain("branch 'topic' set up to track 'origin/main'.");
    net = dev(net, 'git branch --unset-upstream topic').net;
    expect(text(dev(net, 'git config branch.topic.remote'))).toBe('');
  });

  it('copies and force-moves branches', () => {
    let net = dev(gitSite(), ...base, 'echo two >> a.txt', 'git commit -am second', 'git branch old HEAD~1').net;
    net = dev(net, 'git branch -c old copy').net;
    expect(text(dev(net, 'git rev-parse copy'))).toBe(text(dev(net, 'git rev-parse old')));
    expect(text(dev(net, 'git branch old'))).toContain("a branch named 'old' already exists");
    net = dev(net, 'git branch -f old main').net;
    expect(text(dev(net, 'git rev-parse old'))).toBe(text(dev(net, 'git rev-parse main')));
  });
});

describe('git tag listing', () => {
  it('lists by pattern instead of creating a tag named after it', () => {
    const r = dev(dev(gitSite(), ...base, 'git tag v1.0', 'git tag v1.1', 'git tag v2.0').net, 'git tag -l "v1.*"');
    expect(r.out).toEqual(['v1.0', 'v1.1']);
    expect(fileOn(r.net, 'dev1', `${WORK}/.git/refs/tags/v1.*`)).toBeUndefined();
  });

  it('shows messages with -n and moves a tag with -f', () => {
    let net = dev(gitSite(), ...base, 'git tag -a v1.0 -m "first release"').net;
    expect(text(dev(net, 'git tag -n'))).toMatch(/^v1\.0\s+first release$/);
    net = dev(net, 'echo two >> a.txt', 'git commit -am second').net;
    expect(text(dev(net, 'git tag v1.0'))).toContain("tag 'v1.0' already exists");
    const moved = dev(net, 'git tag -f v1.0');
    expect(text(moved)).toContain("Updated tag 'v1.0'");
  });
});

describe('git remote', () => {
  it('prints URLs with -v', () => {
    const r = dev(site(), ...published, 'git remote -v');
    expect(r.out.slice(-2)).toEqual([`origin\t${url} (fetch)`, `origin\t${url} (push)`]);
  });

  it('renames a remote with its tracking branches and upstreams', () => {
    const r = dev(site(), ...published, 'git remote rename origin upstream', 'git branch -r', 'git config branch.main.remote');
    expect(text(r)).toContain('upstream/main');
    expect(r.out[r.out.length - 1]).toBe('upstream');
  });

  it('describes a remote with show and get-url', () => {
    const r = dev(site(), ...published);
    expect(text(dev(r.net, 'git remote get-url origin'))).toBe(url);
    const show = text(dev(r.net, 'git remote show origin'));
    expect(show).toContain('* remote origin');
    expect(show).toContain('main merges with remote main');
  });
});

describe('fetch, clone, push and pull options', () => {
  it('prunes tracking branches deleted on the server', () => {
    let net = dev(site(), ...published, 'git push origin main:gone').net;
    net = run(net, 'dev2', 'cd ~', `git clone ${url} app`).net;
    net = dev(net, 'git push origin --delete gone').net;
    const fetched = run(net, 'dev2', 'cd ~/app', 'git fetch --prune');
    expect(text(fetched)).toContain('[deleted]');
    const r = run(fetched.net, 'dev2', 'cd ~/app', 'git branch -r');

    expect(text(r)).not.toContain('origin/gone');
  });

  it('clones one branch as the checkout with --branch, and a bare copy with --bare', () => {
    let net = dev(site(), ...published, 'git switch -c dev', 'echo d > d.txt', 'git add .', 'git commit -m dev', 'git push -u origin dev').net;
    const r = run(net, 'dev2', 'cd ~', `git clone --branch dev ${url} app`, 'cd app', 'git branch --show-current', 'ls');
    expect(text(r)).toContain('dev\n');
    expect(text(r)).toContain('d.txt');
    net = r.net;
    const bare = run(net, 'dev2', 'cd ~', `git clone --bare ${url}`, 'ls app.git', 'git --git-dir=app.git branch');
    expect(text(bare)).toContain("Cloning into bare repository 'app.git'...");
    expect(text(bare)).toContain('HEAD');
    expect(text(bare)).toContain('dev');
  });

  it('pushes src:dst refspecs and HEAD', () => {
    const r = dev(site(), ...published, 'git push origin main:release', 'git push origin HEAD:hotfix');
    expect(text(r)).toContain('* [new branch]      main -> release');
    expect(text(r)).toContain('* [new branch]      main -> hotfix');
    const server = run(r.net, 'git1', 'git --git-dir=/srv/git/app.git branch');
    expect(text(server)).toContain('release');
    expect(text(server)).toContain('hotfix');
  });

  it('refuses --force-with-lease when the server moved on without us seeing it', () => {
    let net = dev(site(), ...published).net;
    net = run(net, 'dev2', 'cd ~', `git clone ${url} app`, 'cd app', 'echo theirs >> a.txt', 'git commit -am theirs', 'git push').net;
    net = dev(net, 'git commit --amend -m "rewritten"').net;
    const leased = dev(net, 'git push --force-with-lease');
    expect(text(leased)).toContain('stale info');
    net = dev(leased.net, 'git fetch').net;
    expect(text(dev(net, 'git push --force-with-lease'))).toContain('(forced update)');
  });

  it('pulls the branch this one tracks, even under another name', () => {
    let net = dev(site(), ...published, 'git switch -c local-work', 'git branch -u origin/main').net;
    net = run(net, 'dev2', 'cd ~', `git clone ${url} app`, 'cd app', 'echo more >> a.txt', 'git commit -am more', 'git push').net;
    const r = dev(net, 'git pull', 'git log --oneline -n 1');
    expect(text(r)).toMatch(/more$/);
  });
});

describe('git status options', () => {
  it('shows the branch line with -sb', () => {
    const r = dev(site(), ...published, 'echo two >> a.txt', 'git commit -am second', 'git status -sb');
    expect(r.out[r.out.length - 1]).toBe('## main...origin/main [ahead 1]');
  });

  it('collapses an untracked directory, unless -uall', () => {
    const r = dev(gitSite(), ...base, 'mkdir -p docs/api', 'echo x > docs/api/x.md', 'echo y > docs/y.md');
    expect(dev(r.net, 'git status -s').out).toEqual(['?? docs/']);
    expect(dev(r.net, 'git status -s -uall').out).toEqual(['?? docs/api/x.md', '?? docs/y.md']);
    expect(dev(r.net, 'git status -s -uno').out).toEqual([]);
  });

  it('shows a staged rename as one change', () => {
    const r = dev(gitSite(), ...base, 'git mv a.txt b.txt');
    expect(dev(r.net, 'git status -s').out).toEqual(['R  a.txt -> b.txt']);
    expect(text(dev(r.net, 'git status'))).toContain('renamed:    a.txt -> b.txt');
  });

  it('lists ignored files with --ignored', () => {
    const r = dev(gitSite(), ...base, 'echo "*.log" > .gitignore', 'echo x > debug.log', 'git status -s --ignored');
    expect(r.out).toContain('!! debug.log');
  });

  it('prints porcelain v2', () => {
    const r = dev(dev(gitSite(), ...base, 'echo two >> a.txt', 'echo n > new.txt').net, 'git status --porcelain=v2 --branch');
    expect(r.out[0]).toMatch(/^# branch\.oid [0-9a-f]{40}$/);
    expect(r.out).toContain('# branch.head main');
    expect(r.out.some((l) => /^1 \.M N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} a\.txt$/.test(l))).toBe(true);
    expect(r.out).toContain('? new.txt');
  });
});

describe('switching', () => {
  it('resets an existing branch with switch -C and checkout -B', () => {
    let net = dev(gitSite(), ...base, 'git branch topic', 'echo two >> a.txt', 'git commit -am second').net;
    const r = dev(net, 'git switch -C topic');
    net = r.net;
    expect(text(r)).toContain("Switched to and reset branch 'topic'");
    expect(text(dev(net, 'git rev-parse topic'))).toBe(text(dev(net, 'git rev-parse main')));
    expect(text(dev(net, 'git checkout -B topic main~1'))).toContain("Switched to and reset branch 'topic'");
  });

  it('tracks the remote branch it starts from', () => {
    const r = dev(site(), ...published, 'git switch -c mine origin/main');
    expect(text(r)).toContain("branch 'mine' set up to track 'origin/main'.");
  });

  it('starts an orphan branch with no history', () => {
    const r = dev(gitSite(), ...base, 'git switch --orphan pages', 'ls', 'git status');
    expect(text(r)).toContain("Switched to a new branch 'pages'");
    expect(text(r)).toContain('No commits yet');
    expect(fileOn(r.net, 'dev1', `${WORK}/a.txt`)).toBeUndefined();
  });
});

describe('history tools', () => {
  const three = [...base, 'git tag -a v1.0 -m "release one"', 'echo two >> a.txt', 'git commit -am second', 'echo broken >> a.txt', 'git commit -am "third breaks it"', 'echo four >> a.txt', 'git commit -am fourth'];

  it('counts and lists commits with rev-list', () => {
    const r = dev(gitSite(), ...three);
    expect(text(dev(r.net, 'git rev-list --count HEAD'))).toBe('4');
    expect(dev(r.net, 'git rev-list v1.0..HEAD').out).toHaveLength(3);
  });

  it('names a commit from the nearest tag with describe', () => {
    const r = dev(dev(gitSite(), ...three).net, 'git describe');
    expect(text(r)).toMatch(/^v1\.0-3-g[0-9a-f]{7}$/);
  });

  it('searches tracked files with git grep', () => {
    const r = dev(dev(gitSite(), ...three, 'echo two > untracked.txt').net, 'git grep -n two');
    expect(text(r)).toBe('a.txt:2:two');
  });

  it('attaches a note that log shows', () => {
    const r = dev(gitSite(), ...three, 'git notes add -m "reviewed by Sam"', 'git log -n 1');
    expect(text(r)).toContain('Notes:\n    reviewed by Sam');
  });

  it('finds the first bad commit with bisect run', () => {
    const r = dev(gitSite(), ...three, "printf '#!/bin/bash\\n! grep -q broken a.txt\\n' > test.sh", 'chmod +x test.sh', 'git bisect start HEAD v1.0', 'git bisect run ./test.sh');
    expect(text(r)).toMatch(/[0-9a-f]{40} is the first bad commit/);
    expect(text(r)).toContain('third breaks it');
    const reset = dev(r.net, 'git bisect reset', 'git branch --show-current');
    expect(reset.out[reset.out.length - 1]).toBe('main');
  });

  it('checks and counts the object store', () => {
    const r = dev(gitSite(), ...three);
    expect(text(dev(r.net, 'git fsck'))).not.toContain('missing');
    expect(text(dev(r.net, 'git count-objects'))).toMatch(/^\d+ objects, \d+ kilobytes$/);
  });

  it('archives a tagged tree that tar can read back', () => {
    const r = dev(gitSite(), ...three, 'git archive -o release.tar v1.0', 'tar -tf release.tar', 'mkdir out', 'tar -xf release.tar -C out');
    expect(text(r)).toContain('a.txt');
    expect(fileOn(r.net, 'dev1', `${WORK}/out/a.txt`)).toBe('one\n');
  });

  it('round-trips commits through format-patch and am', () => {
    const r = dev(gitSite(), ...three, 'git format-patch -2 -o patches', 'git switch -c replay main~2', 'git am patches/*.patch', 'git log --oneline -n 2');
    expect(text(r)).toContain('patches/0001-third-breaks-it.patch');
    expect(r.out[r.out.length - 2]).toMatch(/fourth$/);
    expect(r.out[r.out.length - 1]).toMatch(/third breaks it$/);
  });

  it('applies a patch to the working tree with apply', () => {
    const r = dev(gitSite(), ...base, 'echo two >> a.txt', 'git diff > change.patch', 'git restore a.txt', 'git apply --check change.patch', 'git apply change.patch', 'cat a.txt');
    expect(text(r)).toContain('one\ntwo');
  });

  it('removes a file from every commit with filter-branch', () => {
    const r = dev(
      gitSite(),
      'git init',
      'echo code > main.c',
      'echo API_TOKEN=secret > secrets.env',
      'git add .',
      'git commit -m "start with a secret"',
      'echo more >> main.c',
      'git commit -am more',
      "git filter-branch --index-filter 'git rm --cached --ignore-unmatch secrets.env' -- --all",
    );
    expect(text(r)).toContain("Ref 'refs/heads/main' was rewritten");
    expect(text(dev(r.net, 'git log --all --oneline -- secrets.env', 'git ls-tree -r --name-only HEAD~1'))).not.toContain('secrets.env');
  });
});

describe('worktrees, sparse checkouts and submodules', () => {
  it('checks a second branch out beside the first', () => {
    const r = dev(gitSite(), ...base, 'git worktree add ../hotfix', 'git worktree list');
    expect(text(r)).toContain('/home/student/hotfix');
    expect(text(r)).toContain('[hotfix]');
    const there = dev(r.net, 'cd ../hotfix', 'git branch --show-current', 'cat a.txt');
    expect(text(there)).toBe('hotfix\none');
  });

  it('narrows the working tree with sparse-checkout', () => {
    const r = dev(gitSite(), 'git init', 'mkdir -p docs src', 'echo d > docs/d.md', 'echo s > src/s.c', 'echo r > README.md', 'git add .', 'git commit -m start', 'git sparse-checkout set src', 'git status -s');
    expect(fileOn(r.net, 'dev1', `${WORK}/docs/d.md`)).toBeUndefined();
    expect(fileOn(r.net, 'dev1', `${WORK}/src/s.c`)).toBe('s\n');
    expect(r.out.filter((l) => l.startsWith(' D'))).toEqual([]);
    const back = dev(r.net, 'git sparse-checkout disable');
    expect(fileOn(back.net, 'dev1', `${WORK}/docs/d.md`)).toBe('d\n');
  });

  it('adds another repository as a submodule', () => {
    const lib = serverUrl('lib');
    let net = gitSite({ bare: ['lib'] });
    net = dev(net, 'cd ~', 'mkdir lib', 'cd lib', 'git init', 'echo helper > util.sh', 'git add .', 'git commit -m "lib first"', `git remote add origin ${lib}`, 'git push -u origin main').net;
    const r = dev(net, `cd ${WORK}`, ...base, `git submodule add ${lib} vendor/lib`, 'git commit -m "add lib"', 'git submodule status', 'cat .gitmodules');
    expect(text(r)).toMatch(/ [0-9a-f]{40} vendor\/lib/);
    expect(text(r)).toContain('[submodule "vendor/lib"]');
    expect(fileOn(r.net, 'dev1', `${WORK}/vendor/lib/util.sh`)).toBe('helper\n');
  });
});
