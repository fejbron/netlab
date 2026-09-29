import type { Lab } from '../types';
import { gitSite, serverUrl } from './git-site';

const MODULE = 'git-rewrite';

const APP = `def main():
    print("hello")
`;

export const gitRewriteLabs: Lab[] = [
  {
    id: 'git-18-rebase-a-branch',
    moduleId: MODULE,
    order: 1,
    title: 'Rebase',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Replay your branch on top of a main that has moved, and see that the commits are new ones.',
    scenario:
      'Your branch started three commits ago, and main has moved on since. You have two ways to catch up. Merging brings main into your branch and records that both happened. Rebasing replays your commits on top of main as if you had started today, leaving a straight line.\n\nYou are on feature/report, which has two commits. Run git log --oneline --all --graph first and look at the fork. Then run git rebase main.\n\nGit takes each of your commits in turn and applies it on top of main. Look at the log again: your two commits are there, in order, on top of main\'s work — but their ids have changed. They are new commits with the same messages and changes. That is the essential fact about rebasing: it does not move commits, it copies them.\n\nThat is also why the rule exists. Because the old commits still exist and the new ones are different objects, anybody who already had your branch now has commits that yours no longer match. Rebase your own unpublished work freely; think twice once somebody else has it.\n\nFinish by merging into main, which is now a fast-forward, because that is the point: the branch was made to fit.',
    concepts: ['Rebase replays commits', 'New commits, new ids', 'A straight-line history', 'Fast-forward afterwards', 'When not to rebase'],
    hints: [
      'git log --oneline --all --graph to see the fork first.',
      'git rebase main',
      'Compare the ids before and after: they are different commits.',
      'git switch main && git merge feature/report should be a fast-forward.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          'git switch -c feature/report',
          "printf 'def report():\\n    return \"summary\"\\n' > report.py",
          'git add report.py',
          'git commit -m "Add a report module"',
          "printf 'def report():\\n    return \"summary\"\\n\\ndef csv():\\n    return \"a,b\"\\n' > report.py",
          'git commit -am "Add CSV output to the report"',
          'git switch main',
          "printf 'The tool\\n' > README.md",
          'git add README.md',
          'git commit -m "Add a README"',
          'git switch feature/report',
        ],
      }),
    objectives: [
      { id: 'look', label: 'Look at the fork before changing anything', checks: [{ type: 'git-ran', subcommand: 'log', argsPattern: '--graph|--all', code: 0 }] },
      {
        id: 'rebase',
        label: 'Replay the branch onto main',
        checks: [
          { type: 'git-ran', subcommand: 'rebase', code: 0 },
          { type: 'git-shape', rev: 'feature/report', linear: true },
          { type: 'git-shape', rev: 'feature/report', contains: 'main', ancestorOf: 'feature/report', label: "main's commit is now in the branch's history" },
        ],
      },
      {
        id: 'intact',
        label: 'Both commits survived the replay',
        checks: [
          { type: 'git-commits', rev: 'feature/report', messagePattern: 'Add a report module' },
          { type: 'git-commits', rev: 'feature/report', messagePattern: 'Add CSV output' },
          { type: 'git-commits', rev: 'feature/report', count: 4 },
        ],
      },
      {
        id: 'ff',
        label: 'Merge it as a fast-forward',
        checks: [
          { type: 'git-branch', name: 'feature/report', mergedInto: 'main' },
          { type: 'git-shape', rev: 'main', linear: true, merges: 0 },
        ],
      },
    ],
  },
  {
    id: 'git-19-amend-and-squash',
    moduleId: MODULE,
    order: 2,
    title: 'Amend and Squash',
    difficulty: 'Advanced',
    estimatedMinutes: 18,
    description: 'Turn three scrappy commits into one worth reading, then fix it up with the file you forgot.',
    scenario:
      'Two tools for tidying your own work before anybody sees it.\n\nThe branch has three commits on top of the first one, called "wip", "wip again" and "fix teh test". They tell a reader nothing, and they are not published, so they are yours to reshape.\n\nFirst, squash. The move that does not need an interactive rebase is one you already know: git reset --soft HEAD~3 takes the branch back three commits while keeping every change staged, and a single git commit -m then records all of it as one commit. Check with git log --oneline: two commits, and the second says what the work actually is.\n\nSecond, amend. You forgot notes.md, which belongs with that work, and the message could be better now you have seen the whole thing. Stage the file and run git commit --amend -m "a better message". Amend does not edit a commit: it builds a new one from the current index and moves the branch to it. The log still shows two commits, but the last one has a different id, and the old one is now unreferenced — which is exactly why amending work other people already have is rude.\n\nNetLab has no editor, so git rebase -i is not simulated; it says so and points at these two commands, which is what it would have done for you anyway.',
    concepts: ['git commit --amend', 'Amend replaces a commit', 'reset --soft to squash', 'Messages are for the next reader'],
    hints: [
      'git log --oneline to see what you are about to squash.',
      'git reset --soft HEAD~3',
      'git commit -m "Add the parser and its tests"',
      'git add notes.md, then git commit --amend -m "Add the parser, its tests and the release notes"',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          "printf 'def parse(t):\\n    return t.split()\\n' > parser.py",
          'git add parser.py',
          'git commit -m "wip"',
          "printf 'def parse(t):\\n    return t.split(\",\")\\n' > parser.py",
          'git commit -am "wip again"',
          "printf 'def test_parse():\\n    assert parse(\"a,b\") == [\"a\", \"b\"]\\n' > test_parser.py",
          'git add test_parser.py',
          'git commit -m "fix teh test"',
          "printf 'Release notes\\n\\n- csv parsing\\n' > notes.md",
        ],
      }),
    objectives: [
      {
        id: 'squash',
        label: 'Turn the three scrappy commits into one',
        checks: [
          { type: 'git-commits', absentPattern: '^wip' },
          { type: 'git-commits', absentPattern: 'fix teh test' },
          { type: 'git-commits', count: 2 },
        ],
      },
      {
        id: 'amend',
        label: 'Add the file you forgot, and fix the message',
        checks: [
          { type: 'git-ran', subcommand: 'commit', argsPattern: '--amend', code: 0 },
          { type: 'git-tracked', path: 'notes.md', contains: 'csv parsing' },
        ],
      },
      {
        id: 'content',
        label: 'Nothing was lost in the tidying',
        checks: [
          { type: 'git-tracked', path: 'parser.py', contains: 'split\\(","\\)', label: 'The parser still splits on a comma' },
          { type: 'git-tracked', path: 'test_parser.py', contains: 'test_parse' },
          { type: 'git-clean' },
        ],
      },
    ],
  },
  {
    id: 'git-20-cherry-pick',
    moduleId: MODULE,
    order: 3,
    title: 'Cherry-pick, and the Cost of Rewriting',
    difficulty: 'Advanced',
    estimatedMinutes: 18,
    description: 'Take one commit from a branch that is not ready, then see what rewriting published history does to somebody else.',
    scenario:
      'A branch called big-refactor is nowhere near finished, but one commit on it fixes a crash that users are hitting now. You want that commit on main and nothing else.\n\ngit cherry-pick <commit> applies the change that commit made, on top of wherever you are, as a new commit. Find the fix with git log --oneline big-refactor, switch to main, and cherry-pick it. Check with git log that main has the fix and none of the refactor.\n\nThe second half of the lab is a demonstration worth watching. main is published, and Sam has already pulled it. Rewrite it anyway: amend the message of the commit you just cherry-picked. Your main and the server\'s main have now diverged, and a plain push is refused. Force it with git push --force, which is the only way to make the server accept a rewritten branch.\n\nNow look at what that did to Sam: on the dev2 tab, git pull produces a mess — a merge between two versions of the same work, or a conflict about a change they already had. Their copy of the old commit did not disappear when you rewrote yours.\n\nThat is the whole argument. Rewriting is a good tool for work nobody has seen, and an expensive one for work they have.',
    concepts: ['git cherry-pick', 'Taking one commit, not a branch', 'Rewriting published history', 'git push --force and its cost'],
    hints: [
      'git log --oneline big-refactor to find the fix.',
      'git switch main && git cherry-pick <id>',
      'git commit --amend -m "..." then git push, which is refused; then git push --force.',
      'On dev2: git pull, and read what it has to do.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        bare: ['acme'],
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          `git remote add origin ${serverUrl('acme')}`,
          'git push -u origin main',
          'git switch -c big-refactor',
          "printf 'class App:\\n    def run(self):\\n        print(\"hello\")\\n' > app.py",
          'git commit -am "Start turning the app into a class"',
          "printf 'class App:\\n    def run(self):\\n        if not self.ready:\\n            return\\n        print(\"hello\")\\n' > app.py",
          'git commit -am "Fix the crash when the app is not ready"',
          "printf 'class App:\\n    def run(self):\\n        if not self.ready:\\n            return\\n        print(\"hello\")\\n\\n    def stop(self):\\n        pass\\n' > app.py",
          'git commit -am "Sketch the stop method"',
          'git switch main',
        ],
        prepareOther: ['cd ~', `git clone ${serverUrl('acme')} acme`],
      }),
    objectives: [
      {
        id: 'pick',
        label: 'Take just the fix onto main',
        checks: [
          { type: 'git-ran', subcommand: 'cherry-pick', code: 0 },
          { type: 'git-commits', rev: 'main', messagePattern: 'crash' },
          { type: 'git-tracked', path: 'app.py', rev: 'main', absent: 'def stop', label: 'The unfinished refactor did not come with it' },
        ],
      },
      {
        id: 'rewrite',
        label: 'Rewrite the published branch',
        checks: [
          { type: 'git-ran', subcommand: 'commit', argsPattern: '--amend', code: 0 },
          { type: 'git-ran', subcommand: 'push', code: 1, label: 'A plain push was refused' },
          { type: 'git-ran', subcommand: 'push', argsPattern: '--force|-f', code: 0 },
          { type: 'git-pushed', branch: 'main' },
        ],
      },
      {
        id: 'cost',
        label: "See what it did to Sam's copy",
        checks: [{ type: 'git-ran', host: 'dev2', subcommand: 'pull', code: 0 }],
      },
    ],
  },
];
