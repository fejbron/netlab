import type { Lab } from '../types';
import { DEV, gitSite, OTHER, serverUrl } from './git-site';

const MODULE = 'git-remotes';

const README = `# Acme tools

A small command line tool.
`;

const URL = serverUrl('acme');

/** dev1 has a repository with a little history, ready to be published. */
const LOCAL = ['git init', 'git add .', 'git commit -m "Add the README"', "printf 'def main():\\n    print(\"hello\")\\n' > app.py", 'git add app.py', 'git commit -m "Add the application"'];

export const gitRemotesLabs: Lab[] = [
  {
    id: 'git-14-publish-a-repository',
    moduleId: MODULE,
    order: 1,
    title: 'Publish Your Work',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Point your repository at a server, push your branch, and see that the commits really arrived.',
    scenario:
      'Everything so far has been local. A remote is another repository your repository knows about, usually one on a server that everybody can reach.\n\nThe server git1 already has an empty repository at /srv/git/acme.git. It is a *bare* repository: no working tree, just the object store and the refs, because nobody edits files there. That is what every shared repository is.\n\nTell your repository about it: git remote add origin ' +
      URL +
      '. The name origin is only a convention, and git remote -v shows what you configured. Then publish your branch with git push -u origin main. The -u sets the upstream, which means that from now on plain git push and git pull know where to go, and git status can tell you when you are ahead or behind.\n\nProve it actually arrived rather than trusting the output: the server tab is a machine you can log into. Run git --git-dir=/srv/git/acme.git log --oneline there, and you should see both commits.\n\nFinish by making one more commit locally and pushing it with a bare git push. The upstream you set is why that works.',
    concepts: ['Remotes and the name origin', 'Bare repositories', 'git push -u and upstream branches', 'Checking the server directly'],
    hints: [
      `git remote add origin ${URL}`,
      'git remote -v to check it.',
      'git push -u origin main',
      'On the git1 tab: git --git-dir=/srv/git/acme.git log --oneline',
    ],
    createState: () => gitSite({ files: { 'README.md': README }, bare: ['acme'], prepare: LOCAL }),
    objectives: [
      { id: 'remote', label: 'Add the remote', checks: [{ type: 'git-remote', name: 'origin', urlPattern: 'acme\\.git' }] },
      {
        id: 'push',
        label: 'Publish main',
        checks: [
          { type: 'git-pushed', branch: 'main', upstream: true },
          { type: 'git-ran', subcommand: 'push', code: 0 },
        ],
      },
      {
        id: 'verify',
        label: 'Check the server has it',
        checks: [{ type: 'command', device: DEV, pattern: 'git1|--git-dir', label: 'Look at the repository on git1' }],
      },
      {
        id: 'again',
        label: 'Push a second commit with a bare git push',
        checks: [
          { type: 'git-commits', count: 3 },
          { type: 'git-pushed', branch: 'main' },
        ],
      },
    ],
  },
  {
    id: 'git-15-clone-and-track',
    moduleId: MODULE,
    order: 2,
    title: 'Clone, and What Tracking Means',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Clone the published repository onto a second machine, and learn to read the remote-tracking branches.',
    scenario:
      'Your colleague Sam works on dev2 and needs the project. Open the dev2 tab — it is a different machine, with its own filesystem and its own copy of everything.\n\nRun git clone ' +
      URL +
      ' there. Cloning gets the whole history, not a snapshot: git log on dev2 shows the same commits with the same ids as on dev1. It also sets up origin and checks out main, so there is nothing else to configure.\n\nNow look at git branch -a. There is main, which is Sam\'s local branch, and remotes/origin/main, which is a *remote-tracking* branch: git\'s record of where main was on the server the last time it looked. It is not live. It only moves when you fetch, pull or push, which is exactly why git status can tell you that you are ahead by two commits without talking to the network.\n\nMake a commit on dev2 and run git status. It says ahead of origin/main by 1. Push it. Then go back to the dev1 tab and run git status there: dev1 still thinks everything is fine, because nothing has told it otherwise. git fetch updates its remote-tracking branch, and now git status says behind by 1. Fetch changes what you know; it does not change your work.',
    concepts: ['git clone brings the whole history', 'Remote-tracking branches', 'Why status works offline', 'git fetch versus git pull'],
    hints: [
      `On the dev2 tab: cd ~ && git clone ${URL}`,
      'git branch -a shows remotes/origin/main alongside main.',
      'Commit on dev2, then git status, then git push.',
      'Back on dev1: git status, then git fetch, then git status again.',
    ],
    createState: () => gitSite({ files: { 'README.md': README }, bare: ['acme'], prepare: [...LOCAL, `git remote add origin ${URL}`, 'git push -u origin main'] }),
    objectives: [
      {
        id: 'clone',
        label: 'Clone onto the second machine',
        checks: [
          { type: 'git-repo', host: OTHER, dir: '/home/student/acme' },
          { type: 'git-commits', host: OTHER, dir: '/home/student/acme', messagePattern: 'Add the application' },
          { type: 'git-tracked', host: OTHER, dir: '/home/student/acme', path: 'app.py' },
        ],
      },
      { id: 'tracking', label: 'Look at the remote-tracking branches', checks: [{ type: 'git-ran', host: OTHER, subcommand: 'branch', argsPattern: '-a|--all', code: 0 }] },
      {
        id: 'push',
        label: "Commit and push Sam's work",
        checks: [
          { type: 'git-commits', host: OTHER, dir: '/home/student/acme', count: 3 },
          { type: 'git-pushed', host: OTHER, dir: '/home/student/acme', branch: 'main' },
        ],
      },
      {
        id: 'fetch',
        label: 'Learn about it on the first machine',
        checks: [
          { type: 'git-ran', subcommand: 'fetch', code: 0 },
          { type: 'git-branch', name: 'main', at: 'origin/main~1', label: 'dev1 knows origin/main has moved ahead of it' },
        ],
      },
    ],
  },
  {
    id: 'git-16-rejected-push',
    moduleId: MODULE,
    order: 3,
    title: 'A Push That Is Refused',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Someone pushed while you were working. Read the refusal, and integrate their work without trampling it.',
    scenario:
      'While you were writing a commit on dev1, Sam pushed one from dev2. Your push is about to be refused, and that refusal is git protecting Sam\'s commit.\n\nCommit your change, then push. Git answers "! [rejected] main -> main (fetch first)" and explains why: the remote has work you do not have. If git accepted your push, the server\'s main would move to your commit and Sam\'s would no longer be on any branch.\n\nThe fix is to bring their work into yours first. Run git pull, which is git fetch followed by git merge: it updates origin/main and merges it into your branch, making a merge commit because both sides moved. Then push again, and it is accepted.\n\nTry the other way too, on the second change you make: git pull --rebase replays your commit on top of theirs instead of merging, which leaves a straight line rather than a merge commit. Teams tend to pick one and stick to it.\n\nThe thing worth never forgetting: git push --force would also have "worked", by deleting Sam\'s commit from the branch. When a push is refused, the answer is to pull, not to force.',
    concepts: ['Non-fast-forward pushes', 'Why git refuses', 'git pull as fetch plus merge', 'git pull --rebase', 'What --force actually does'],
    hints: [
      'git push and read the whole message, hints included.',
      'git pull, then git push.',
      'For the second one: git pull --rebase, then git push.',
      'git log --oneline --graph shows the shape each approach left.',
    ],
    createState: () =>
      gitSite({
        files: { 'README.md': README },
        bare: ['acme'],
        prepare: [...LOCAL, `git remote add origin ${URL}`, 'git push -u origin main'],
        prepareOther: [
          'cd ~',
          `git clone ${URL} acme`,
          'cd acme',
          "printf 'CONTRIBUTING\\n============\\n\\nOpen a branch.\\n' > CONTRIBUTING.md",
          'git add CONTRIBUTING.md',
          'git commit -m "Explain how to contribute"',
          'git push',
        ],
        edits: { 'app.py': 'def main():\n    print("hello")\n\ndef version():\n    return "1.0"\n' },
      }),
    objectives: [
      {
        id: 'rejected',
        label: 'See the push refused',
        checks: [{ type: 'git-ran', subcommand: 'push', code: 1 }],
      },
      {
        id: 'integrate',
        label: 'Bring their work in and publish yours',
        checks: [
          { type: 'git-ran', subcommand: 'pull', code: 0 },
          { type: 'git-pushed', branch: 'main' },
          { type: 'git-tracked', path: 'CONTRIBUTING.md', label: "Sam's file is in your history" },
          { type: 'git-tracked', path: 'app.py', contains: 'def version' },
        ],
      },
      {
        id: 'nothing-lost',
        label: 'Nothing of theirs was lost',
        checks: [{ type: 'git-commits', messagePattern: 'Explain how to contribute', author: 'Sam' }],
      },
      { id: 'rebase', label: 'Try the rebasing form of pull', checks: [{ type: 'git-ran', subcommand: 'pull', argsPattern: '--rebase', code: 0 }] },
    ],
  },
  {
    id: 'git-17-collaborate-on-a-branch',
    moduleId: MODULE,
    order: 4,
    title: 'Two People, One Branch',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'You and Sam both edit the same file and push. Resolve the conflict that arrives through the network.',
    scenario:
      'This is the situation that makes people distrust git, and it is worth doing once slowly.\n\nBoth machines have the project. Both of you are about to change the same lines of app.py: you are adding a --verbose flag, Sam is adding a --quiet one. Sam pushes first, because somebody always does.\n\nOn dev1, commit your change and try to push. Refused, as in the last lab. Run git pull, and this time the merge cannot be done automatically: you both edited the same lines, so git leaves conflict markers in app.py and tells you it failed.\n\nResolve it the same way you did locally: edit app.py so it has both flags, remove every marker, git add app.py, git commit. Nothing about the conflict being Sam\'s work rather than your own branch changes the procedure.\n\nPush. Then, on the dev2 tab, pull and confirm Sam gets your merged version — both flags present. That round trip is the whole of collaboration in git: everyone works locally, everyone merges other people\'s work into their own, and the server is just the place the branches meet.',
    concepts: ['Conflicts arriving from a pull', 'Resolving is the same locally or remotely', 'Push after resolving', 'Both sides end up with the same history'],
    hints: [
      'Commit your change, then git push to see it refused.',
      'git pull leaves the markers in app.py; open it and write the version you want.',
      'git add app.py && git commit, then git push.',
      'On dev2: git pull, then cat app.py.',
    ],
    createState: () =>
      gitSite({
        files: { 'README.md': README },
        bare: ['acme'],
        prepare: [...LOCAL, `git remote add origin ${URL}`, 'git push -u origin main'],
        prepareOther: [
          'cd ~',
          `git clone ${URL} acme`,
          'cd acme',
          "printf 'def main():\\n    print(\"hello\")\\n\\nQUIET = False\\n' > app.py",
          'git commit -am "Add a --quiet flag"',
          'git push',
        ],
        edits: { 'app.py': 'def main():\n    print("hello")\n\nVERBOSE = False\n' },
      }),
    objectives: [
      { id: 'commit', label: 'Commit your change', checks: [{ type: 'git-commits', messagePattern: 'verbose' }] },
      {
        id: 'conflict',
        label: 'Pull, and meet the conflict',
        checks: [
          { type: 'git-ran', subcommand: 'push', code: 1 },
          { type: 'git-ran', subcommand: 'pull', code: 1 },
        ],
      },
      {
        id: 'resolve',
        label: 'Resolve it so both flags survive',
        checks: [
          { type: 'git-tracked', path: 'app.py', contains: 'VERBOSE' },
          { type: 'git-tracked', path: 'app.py', contains: 'QUIET' },
          { type: 'git-tracked', path: 'app.py', absent: '<<<<<<<|>>>>>>>' },
          { type: 'git-clean' },
        ],
      },
      {
        id: 'share',
        label: 'Publish it, and let Sam catch up',
        checks: [
          { type: 'git-pushed', branch: 'main' },
          { type: 'file', device: OTHER, path: '/home/student/acme/app.py', contains: 'VERBOSE' },
          { type: 'file', device: OTHER, path: '/home/student/acme/app.py', contains: 'QUIET' },
        ],
      },
    ],
  },
];

