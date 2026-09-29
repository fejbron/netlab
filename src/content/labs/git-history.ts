import type { Lab } from '../types';
import { DEV, gitSite, WORK } from './git-site';

const MODULE = 'git-history';

const APP = `def main():
    print("hello")
`;

export const gitHistoryLabs: Lab[] = [
  {
    id: 'git-10-undo-with-reset',
    moduleId: MODULE,
    order: 1,
    title: 'Reset: Soft, Mixed and Hard',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Move a branch backwards three different ways, and understand exactly what each one keeps.',
    scenario:
      'git reset moves the branch you are on to another commit. What makes it confusing is that it can also change the staging area and the working tree, and the three modes decide how far it goes.\n\nThe last commit here is a mistake: it says "wip" and contains half an idea. Undo it three ways, looking at git status and cat app.py after each — and between the first two, put the commit back with git commit -am "wip", because each reset undoes the commit on top and you want the same one to practise on.\n\ngit reset --soft HEAD~1 moves the branch back but leaves both the staging area and your files alone, so the change is staged, ready to be committed again with a better message. That is the safest reset and the one to reach for when you only want to redo the commit.\n\ngit reset HEAD~1 (the default, --mixed) moves the branch and clears the staging area, leaving the change in your files as unstaged work.\n\ngit reset --hard HEAD~1 moves the branch and throws the change away entirely. Your edits are gone from disk. It is the only one of the three that loses work, and it is why --hard has a reputation.\n\nRedo the commit properly at the end, with a message that says what it does. You will meet the way back from a bad --hard in the next lab but one.',
    concepts: ['reset moves the current branch', '--soft keeps the change staged', '--mixed unstages it', '--hard discards it', 'Which of the three loses work'],
    hints: [
      'git log --oneline to see what you are undoing.',
      'git reset --soft HEAD~1, then git status: the change is still staged. git commit -am "wip" puts it back.',
      'git reset HEAD~1 unstages it; commit it back again, then git reset --hard HEAD~1 removes it from the file too.',
      'Stage and commit again with a real message.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          "printf 'def main():\\n    print(\"hello\")\\n\\ndef goodbye():\\n    print(\"bye\")\\n' > app.py",
          'git commit -am "wip"',
        ],
      }),
    objectives: [
      {
        id: 'soft',
        label: 'Undo the commit but keep the change staged',
        checks: [{ type: 'git-ran', subcommand: 'reset', argsPattern: '--soft', code: 0 }],
      },
      { id: 'mixed', label: 'Unstage it with a plain reset', checks: [{ type: 'git-ran', subcommand: 'reset', argsPattern: '^(?!.*--soft)(?!.*--hard).*HEAD~', code: 0 }] },
      { id: 'hard', label: 'Throw it away with --hard', checks: [{ type: 'git-ran', subcommand: 'reset', argsPattern: '--hard', code: 0 }] },
      {
        id: 'redo',
        label: 'Redo the work with a message worth reading',
        checks: [
          { type: 'git-commits', count: 2 },
          { type: 'git-commits', absentPattern: '^wip$', label: 'No commit is called just "wip"' },
          { type: 'git-tracked', path: 'app.py', contains: 'goodbye' },
          { type: 'git-clean' },
        ],
      },
    ],
  },
  {
    id: 'git-11-revert-safely',
    moduleId: MODULE,
    order: 2,
    title: 'Revert: Undo Without Rewriting',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Take back a change that is already public, by adding a commit that undoes it rather than erasing it.',
    scenario:
      'A commit two back broke the build, and it has already been shared with other people. Reset is the wrong tool here: it rewrites the branch, and everyone who has that commit would have to deal with the mess. Revert is the right tool.\n\ngit revert <commit> works out what that commit changed, applies the opposite, and records a new commit saying so. The history keeps both: the mistake and the correction. Nothing anybody has is invalidated.\n\nFind the offending commit with git log --oneline — it is the one that says "Speed up the parser". Revert it, keeping the message git offers. Then look at git log: three commits before, four now. Read app.py to confirm the code is back to what it was, and use git show HEAD to see that the revert commit is an ordinary commit whose diff happens to be the reverse of another.\n\nThe rule of thumb worth keeping: rewrite history that only you have, revert history that other people have.',
    concepts: ['revert adds a commit, reset moves a branch', 'Public versus private history', 'Reading a revert in the log', 'git show on the revert'],
    hints: ['git log --oneline to find the commit id.', 'git revert <id>', 'git log --oneline shows the revert commit on top.', 'cat app.py to confirm the change is undone.'],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          "printf 'def main():\\n    print(\"hello\")\\n\\ndef parse(text):\\n    return text.split()[0]\\n' > app.py",
          'git commit -am "Speed up the parser"',
          "printf 'README for the tool\\n' > README.md",
          'git add README.md',
          'git commit -m "Add a README"',
        ],
      }),
    objectives: [
      { id: 'find', label: 'Find the commit that broke it', checks: [{ type: 'git-ran', subcommand: 'log', code: 0 }] },
      {
        id: 'revert',
        label: 'Revert it',
        checks: [
          { type: 'git-commits', messagePattern: 'Revert "Speed up the parser"' },
          { type: 'git-commits', count: 4, label: 'The history grew rather than shrank' },
        ],
      },
      {
        id: 'result',
        label: 'The change is undone, and the record is intact',
        checks: [
          { type: 'git-tracked', path: 'app.py', absent: 'def parse' },
          { type: 'git-commits', messagePattern: 'Speed up the parser', label: 'The original commit is still in the history' },
          { type: 'git-tracked', path: 'README.md', label: 'The later work is untouched' },
        ],
      },
    ],
  },
  {
    id: 'git-12-reflog-rescue',
    moduleId: MODULE,
    order: 3,
    title: 'The Reflog Finds What You Lost',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Recover two commits from a branch you deleted by accident, using the log of where HEAD has been.',
    scenario:
      'Somebody deleted the branch feature/export with git branch -D, and it had two commits on it that nothing else points at. They are not in git log, because log only shows what a branch or tag can reach. They are not gone, though.\n\nEvery time HEAD moves — a commit, a switch, a merge, a reset — git writes a line to .git/logs/HEAD. That is the reflog, and it remembers commits that nothing points at any more. Run git reflog and read it from the top: each line has a short id, a name like HEAD@{2}, and what happened.\n\nFind the entry from before the deletion. The id beside it is the tip of the branch that was deleted. Prove it with git show <id>, then bring it back by making a branch there: git branch feature/export <id>, or git switch -c feature/export <id> to go there at the same time.\n\nCheck git log --oneline on the recovered branch: both commits are there, with their original ids, because nothing was ever rewritten — only unreferenced. Git deletes unreferenced objects eventually, but not for weeks, which is why the reflog rescues so many bad afternoons.',
    concepts: ['The reflog records where HEAD has been', 'Unreferenced is not deleted', 'HEAD@{n}', 'Recovering by pointing a branch at a commit', 'Why log cannot show it'],
    hints: [
      'git reflog',
      'Look for the line just before the branch was deleted; the short id is on the left.',
      'git show <id> to confirm it is the right commit.',
      'git branch feature/export <id>',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          'git switch -c feature/export',
          "printf 'def export_csv(rows):\\n    return \"\\\\n\".join(rows)\\n' > export.py",
          'git add export.py',
          'git commit -m "Add CSV export"',
          "printf 'def export_csv(rows):\\n    return \"\\\\n\".join(rows)\\n\\ndef export_json(rows):\\n    return str(rows)\\n' > export.py",
          'git commit -am "Add JSON export"',
          'git switch main',
          'git branch -D feature/export',
        ],
      }),
    objectives: [
      { id: 'reflog', label: 'Read the reflog', checks: [{ type: 'git-ran', subcommand: 'reflog', code: 0 }] },
      {
        id: 'recover',
        label: 'Bring the branch back',
        checks: [
          { type: 'git-branch', name: 'feature/export' },
          { type: 'git-commits', rev: 'feature/export', count: 3 },
          { type: 'git-tracked', path: 'export.py', rev: 'feature/export', contains: 'export_json' },
        ],
      },
      {
        id: 'intact',
        label: 'Both commits came back, not just the last one',
        checks: [
          { type: 'git-commits', rev: 'feature/export', messagePattern: 'Add CSV export' },
          { type: 'git-commits', rev: 'feature/export', messagePattern: 'Add JSON export' },
        ],
      },
    ],
  },
  {
    id: 'git-13-stash-and-find',
    moduleId: MODULE,
    order: 4,
    title: 'Stash, and Find When It Changed',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Put half-finished work aside to deal with something urgent, then use the history to find when a line appeared.',
    scenario:
      'You are halfway through an edit when something urgent arrives on another branch. You do not want to commit work that is not finished, and you cannot switch with it in the way.\n\ngit stash takes everything not committed, saves it, and leaves you with a clean working tree. git stash list shows what you have saved. Do the urgent work — here, a one-line fix on main, committed properly — and then git stash pop puts your half-finished edit back and removes it from the stash.\n\nThe second half of this lab is the other thing history is for: answering "when did this happen, and why?". A line in app.py sets a timeout to 1 second and nobody remembers why. Find out with git log -p app.py, which shows every commit that touched the file along with its diff, or git blame app.py, which shows the commit, author and date for every line.\n\nOnce you have the commit id, git show <id> gives you the message the author wrote. Whether that message is any use is entirely down to whether they thought about the person reading it later — which is the whole argument for writing decent commit messages.',
    concepts: ['git stash, list, pop', 'A clean tree lets you switch', 'git log -p on one file', 'git blame', 'Why messages matter'],
    hints: [
      'git stash, then git status to see the tree is clean.',
      'Fix the typo in README.md, commit it, then git stash pop.',
      'git blame app.py shows who last touched each line.',
      'git show <id> reads the message behind the change.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          "printf 'def main():\\n    print(\"hello\")\\n\\nTIMEOUT = 30\\n' > app.py",
          'git commit -am "Add a request timeout"',
          "printf 'The tol\\n' > README.md",
          'git add README.md',
          'git commit -m "Add a README"',
          "printf 'def main():\\n    print(\"hello\")\\n\\nTIMEOUT = 1\\n' > app.py",
          'git commit -am "Drop the timeout to 1s while chasing the flaky test"',
        ],
        edits: { 'app.py': 'def main():\n    print("hello, world")\n\nTIMEOUT = 1\n' },
      }),
    objectives: [
      {
        id: 'stash',
        label: 'Put the unfinished edit aside',
        checks: [{ type: 'git-ran', subcommand: 'stash', code: 0 }],
      },
      {
        id: 'urgent',
        label: 'Do the urgent fix and commit it',
        checks: [
          { type: 'git-tracked', path: 'README.md', contains: 'tool' },
          { type: 'git-commits', count: 5 },
        ],
      },
      {
        id: 'restore',
        label: 'Bring the unfinished work back',
        checks: [
          { type: 'file', device: DEV, path: `${WORK}/app.py`, contains: 'hello, world' },
          { type: 'git-stash', count: 0 },
        ],
      },
      {
        id: 'investigate',
        label: 'Find out when the timeout changed',
        checks: [{ type: 'git-ran', subcommand: 'blame', code: 0 }, { type: 'git-ran', subcommand: 'show', code: 0 }],
      },
    ],
  },
];
