import type { Lab } from '../types';
import { DEV, gitSite, WORK } from './git-site';

const MODULE = 'git-basics';

const REPORT = `# Quarterly report

Sales were up.
`;

export const gitBasicsLabs: Lab[] = [
  {
    id: 'git-01-first-repository',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Repository',
    difficulty: 'Beginner',
    estimatedMinutes: 12,
    description: 'Tell git who you are, turn a directory into a repository, and record your first commit.',
    scenario:
      'A repository is a directory with a .git directory inside it. That is the whole trick: everything git knows about your project — every version of every file, every branch, every message — lives in that one directory, on your machine, with no server involved.\n\nYou are in ~/project, which holds one file and no history. Before you can commit, git needs to know who is making the commit, because a commit records an author. Set your name and email with git config --global, which writes them to ~/.gitconfig and applies to every repository you make from now on.\n\nThen run git init, and look at what appeared: ls -a shows .git, and cat .git/HEAD shows that HEAD points at a branch called main that does not exist yet. Stage the file with git add, and commit it with git commit -m and a message that says what changed.\n\nFinish with git log. One commit, with your name on it, and an id that is a SHA-1 of its content. That id is how git will refer to this state of the project forever.',
    concepts: ['Repositories are local', 'git config --global', 'git init', 'The .git directory', 'git add and git commit', 'Commit ids'],
    hints: [
      'git config --global user.name "Your Name" and git config --global user.email "you@example.com"',
      'git init, then ls -a to see the .git directory appear.',
      'git add report.md stages the file; git status shows it under "Changes to be committed".',
      'git commit -m "Add the quarterly report"',
    ],
    createState: () => gitSite({ noIdentity: true, files: { 'report.md': REPORT } }),
    objectives: [
      {
        id: 'identity',
        label: 'Tell git who you are',
        checks: [
          { type: 'git-config', key: 'user.name' },
          { type: 'git-config', key: 'user.email', pattern: '@' },
        ],
      },
      {
        id: 'init',
        label: 'Turn the directory into a repository',
        checks: [
          { type: 'git-repo' },
          { type: 'file', device: DEV, path: `${WORK}/.git/HEAD`, contains: 'ref: refs/heads/' },
        ],
      },
      {
        id: 'commit',
        label: 'Record the first commit',
        checks: [
          { type: 'git-commits', count: 1 },
          { type: 'git-tracked', path: 'report.md', contains: 'Quarterly report' },
          { type: 'git-clean' },
        ],
      },
      { id: 'look', label: 'Read the log', checks: [{ type: 'git-ran', subcommand: 'log', code: 0 }] },
    ],
  },
  {
    id: 'git-02-the-three-states',
    moduleId: MODULE,
    order: 2,
    title: 'Working Tree, Staging Area, Commit',
    difficulty: 'Beginner',
    estimatedMinutes: 16,
    description: 'See the three places a change can be, and move changes between them deliberately.',
    scenario:
      'Nearly every confusing thing about git comes from not knowing which of three places a change is in. The working tree is the files you edit. The staging area (the index) is what will go into the next commit. The commit is the recorded snapshot.\n\nThe repository has one commit. Make two different changes: add a new line to report.md, and create a new file notes.md. Run git status and read it as three groups — changes staged, changes not staged, and files git has never heard of.\n\nNow stage only the change to report.md with git add report.md. Run git status again, and git diff, which shows what is *not* staged, and git diff --staged, which shows what *is*. Two commands, two different answers, and the difference between them is the staging area.\n\nCommit just that change. Then notice notes.md is still untracked: the commit you made contains only what you staged. Stage and commit it separately, with its own message. Two commits, each one thing — which is what makes a history worth reading later.',
    concepts: ['Working tree, index, HEAD', 'git status as three groups', 'git diff vs git diff --staged', 'Staging deliberately', 'One idea per commit'],
    hints: [
      "echo 'Costs were down.' >> report.md",
      'git add report.md, then compare git diff with git diff --staged.',
      'git commit -m "Note that costs were down"',
      'git add notes.md, then commit it with its own message.',
    ],
    createState: () =>
      gitSite({
        files: { 'report.md': REPORT },
        prepare: ['git init', 'git add report.md', 'git commit -m "Add the quarterly report"'],
      }),
    objectives: [
      {
        id: 'inspect',
        label: 'Look at all three states at once',
        checks: [
          { type: 'git-ran', subcommand: 'status', code: 0 },
          { type: 'git-ran', subcommand: 'diff', code: 0 },
        ],
      },
      {
        id: 'first',
        label: 'Commit only the report change',
        checks: [
          { type: 'git-tracked', path: 'report.md', contains: 'Costs were down' },
          { type: 'git-tracked', path: 'notes.md', rev: 'HEAD~1', exists: false, label: 'The first new commit did not include notes.md' },
        ],
      },
      {
        id: 'second',
        label: 'Commit the notes as their own change',
        checks: [
          { type: 'git-tracked', path: 'notes.md' },
          { type: 'git-commits', count: 3 },
          { type: 'git-clean' },
        ],
      },
    ],
  },
  {
    id: 'git-03-read-the-history',
    moduleId: MODULE,
    order: 3,
    title: 'Read the History',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Find your way around a history you did not write: log, show, and naming a commit relative to HEAD.',
    scenario:
      'You have inherited a repository with a handful of commits. Before changing anything, learn to read it.\n\nStart with git log, which prints every commit newest first, with its author, date and message. It is verbose; git log --oneline is the form people actually use, one line per commit. Add --stat to see which files each commit touched.\n\nThen learn how to name a commit. HEAD is where you are now. HEAD~1 is its parent, HEAD~2 its grandparent. A commit id works too, and you only need the first few characters. Use git show HEAD~2 to read one commit in full: its message and the exact diff it introduced.\n\nFinally, compare two points in time with git diff HEAD~3 HEAD, which shows everything that changed across three commits at once. Notice what git log does not tell you: it shows the message somebody wrote, not what they were thinking. That is why the message matters.',
    concepts: ['git log and --oneline', '--stat', 'HEAD, HEAD~1, HEAD~2', 'git show', 'Diffing two commits'],
    hints: ['git log --oneline', 'git log --stat -n 2', 'git show HEAD~2', 'git diff HEAD~3 HEAD'],
    createState: () =>
      gitSite({
        files: { 'report.md': REPORT },
        prepare: [
          'git init',
          'git add report.md',
          'git commit -m "Add the quarterly report"',
          "echo 'Costs were down.' >> report.md",
          'git commit -am "Note that costs were down"',
          "printf 'alpha\\nbeta\\n' > team.md",
          'git add team.md',
          'git commit -m "List the team"',
          "echo 'gamma' >> team.md",
          'git commit -am "Add gamma to the team"',
        ],
      }),
    objectives: [
      { id: 'oneline', label: 'Read the history one line at a time', checks: [{ type: 'git-ran', subcommand: 'log', argsPattern: '--oneline', code: 0 }] },
      { id: 'stat', label: 'See which files each commit touched', checks: [{ type: 'git-ran', subcommand: 'log', argsPattern: '--stat', code: 0 }] },
      { id: 'show', label: 'Read one older commit in full', checks: [{ type: 'git-ran', subcommand: 'show', argsPattern: 'HEAD~|[0-9a-f]{4,}', code: 0 }] },
      { id: 'range', label: 'Compare two points in the history', checks: [{ type: 'git-ran', subcommand: 'diff', argsPattern: 'HEAD~\\d+\\s+HEAD|HEAD~\\d+\\.\\.', code: 0 }] },
    ],
  },
  {
    id: 'git-04-ignore-what-does-not-belong',
    moduleId: MODULE,
    order: 4,
    title: 'Keep Junk Out of History',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Write a .gitignore, and get a file out of the repository that should never have been committed.',
    scenario:
      'Build output, logs and secrets do not belong in a repository. Once committed they are in the history forever, so the habit worth forming is to stop them before the first commit.\n\nThe working tree has collected debug.log, a build/ directory and a config file called secrets.env. None of them should be tracked. Write .gitignore listing the patterns: *.log for the logs, build/ for the whole directory, and secrets.env by name. Then run git status and watch them disappear from the untracked list — and notice that .gitignore itself *should* be committed, because everyone working on the project wants the same rules.\n\nThere is a catch, and it is the one that bites people. Somebody already committed notes.tmp before the ignore rules existed, and .gitignore does not apply to files git is already tracking. Remove it from the repository while keeping it on disk with git rm --cached notes.tmp, add it to .gitignore, and commit.\n\nIt is worth being honest about what that does and does not achieve: notes.tmp is gone from the *next* commit, but it is still in the old ones. Removing something from history entirely is a much bigger operation, which is why not committing it in the first place matters.',
    concepts: ['.gitignore patterns', 'Why .gitignore is committed', 'git rm --cached', 'Ignore rules do not apply to tracked files', 'What is committed stays in history'],
    hints: [
      "printf '*.log\\nbuild/\\nsecrets.env\\n' > .gitignore",
      'git status should stop mentioning debug.log, build/ and secrets.env.',
      'git rm --cached notes.tmp takes it out of the repository but leaves the file alone.',
      'Add notes.tmp to .gitignore too, then commit .gitignore and the removal together.',
    ],
    createState: () =>
      gitSite({
        files: {
          'report.md': REPORT,
          'notes.tmp': 'scratch thoughts\n',
          'debug.log': 'lots of noise\n',
          'build/app.js': 'compiled output\n',
          'secrets.env': 'API_TOKEN=nlc_7f3a9e2b41c8d05e\n',
        },
        prepare: ['git init', 'git add report.md notes.tmp', 'git commit -m "Add the report and some notes"'],
      }),
    objectives: [
      {
        id: 'ignore',
        label: 'Write the ignore rules',
        checks: [
          { type: 'git-ignored', path: 'debug.log' },
          { type: 'git-ignored', path: 'build/app.js' },
          { type: 'git-ignored', path: 'secrets.env' },
          { type: 'git-ignored', path: 'report.md', ignored: false, label: 'The report is still tracked, not ignored' },
        ],
      },
      { id: 'commit-rules', label: 'Commit .gitignore so everyone gets the rules', checks: [{ type: 'git-tracked', path: '.gitignore', contains: '\\*\\.log', label: 'The committed .gitignore has a rule for log files' }] },
      {
        id: 'untrack',
        label: 'Stop tracking the file that slipped in',
        checks: [
          { type: 'git-tracked', path: 'notes.tmp', exists: false },
          { type: 'file', device: DEV, path: `${WORK}/notes.tmp`, contains: 'scratch thoughts', label: 'notes.tmp is still on disk' },
          { type: 'git-tracked', path: 'notes.tmp', rev: 'HEAD~1', label: 'It is still in the older commit, as git history always is' },
        ],
      },
      { id: 'clean', label: 'Leave the working tree clean', checks: [{ type: 'git-clean' }] },
    ],
  },
  {
    id: 'git-05-inside-git',
    moduleId: MODULE,
    order: 5,
    title: 'Look Inside .git',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Open the object store and see that a commit is just a small file pointing at a tree of files.',
    scenario:
      'Git stops being magic the moment you look inside it. Everything you have made so far is a handful of files under .git, and you can read all of them.\n\nStart with the refs. cat .git/HEAD says which branch you are on; cat .git/refs/heads/main is the commit id that branch points at. A branch is a file containing forty characters. That is all it is, which is why making one is instant.\n\nNow follow the id. git cat-file -t <id> says what kind of object it is, and git cat-file -p <id> prints it. A commit names a tree, its parents, its author and its message. Print the tree and you get the list of files with their own ids. Print a file id and you get the file content back.\n\nTry the reverse: git hash-object report.md gives you the id git *would* store that content under, and it is the same id already in the tree, because the id is a hash of the content. Two files with the same content are one object.\n\nFinish by finding the objects on disk with find .git/objects -type f. NetLab stores them uncompressed so you can read them; real git compresses them and packs them together, which is the one difference between this and the repository on your laptop.',
    concepts: ['A branch is a file holding a commit id', 'Objects: blob, tree, commit', 'git cat-file -t and -p', 'Content addressing with git hash-object', 'Where objects live on disk'],
    hints: [
      'cat .git/HEAD, then cat .git/refs/heads/main',
      'git cat-file -p HEAD shows the commit, including the tree line.',
      'git cat-file -p <tree id> lists the files, each with its own id.',
      'git hash-object report.md should print an id you have already seen.',
    ],
    createState: () =>
      gitSite({
        files: { 'report.md': REPORT },
        prepare: ['git init', 'git add report.md', 'git commit -m "Add the quarterly report"'],
      }),
    objectives: [
      {
        id: 'refs',
        label: 'Read HEAD and the branch file',
        checks: [
          { type: 'command', device: DEV, pattern: '(cat|less|more)\\s+\\.git/HEAD', label: 'Run cat .git/HEAD' },
          { type: 'command', device: DEV, pattern: '(cat|less|more)\\s+\\.git/refs/heads/', label: 'Read the branch file under .git/refs/heads' },
        ],
      },
      {
        id: 'objects',
        label: 'Walk from the commit down to the file content',
        checks: [
          { type: 'git-ran', subcommand: 'cat-file', argsPattern: '-t', code: 0 },
          { type: 'git-ran', subcommand: 'cat-file', argsPattern: '-p', code: 0 },
        ],
      },
      { id: 'hash', label: 'Hash a file yourself', checks: [{ type: 'git-ran', subcommand: 'hash-object', code: 0 }] },
      { id: 'find', label: 'Find the objects on disk', checks: [{ type: 'command', device: DEV, pattern: 'find\\s+\\.git/objects|ls\\s+.*\\.git/objects', label: 'List the files under .git/objects' }] },
    ],
  },
];
