import type { Lab } from '../types';
import { DEV, gitSite, serverUrl, WORK } from './git-site';

const MODULE = 'git-exams';

const URL = serverUrl('acme');

const APP = `def main():
    print("hello")
`;

const HANDOVER = `Handover notes
==============

The repository is in a state. Things I know about:

* There is a secrets.env in the history, and it should never have been committed.
  It is still on disk because we need it, but git should not be tracking it, and
  there is no .gitignore at all.
* A branch called feature/rates was deleted by accident yesterday. It had two
  commits on it. Nobody wrote the ids down.
* The commit that says "temporarily disable the rate limiter" is on main and was
  pushed weeks ago. It needs undoing, but other people have it.
* main here is behind the server, and I have one unfinished edit in app.py that
  I do not want to lose.

- Alex
`;

export const gitExamLabs: Lab[] = [
  {
    id: 'git-23-exam-ship-a-feature',
    moduleId: MODULE,
    order: 1,
    title: 'Exam: Ship a Feature',
    difficulty: 'Advanced',
    estimatedMinutes: 40,
    isExam: true,
    description: 'Take one change from an empty branch to merged and published, on a repository somebody else is also pushing to.',
    scenario:
      'A shared repository, a colleague who pushes while you work, and one feature to deliver. Nothing here is new; putting it together is the exam.\n\nWork on dev1, in ~/project, which is a clone of the shared repository. Deliver a currency conversion feature:\n\nOne. Start from an up-to-date main, and make a branch called feature/convert.\n\nTwo. Write convert.py with a convert function, and test_convert.py with a test for it, as two separate commits whose messages say what they do. Neither message may contain the word "wip".\n\nThree. Publish the branch to origin, with the upstream set so a plain git push works afterwards.\n\nFour. Sam has pushed to main in the meantime. Bring your branch up to date with their work by rebasing onto origin/main, so your two commits sit on top and the branch stays a straight line. Publish the rebased branch.\n\nFive. Merge the feature into main with a merge commit (--no-ff), so the history records that a feature landed, and push main.\n\nSix. Tidy up: no feature/convert branch should remain, locally or on the server, and the working tree must be clean.\n\nA second run of git log --oneline --graph should show the merge, your two commits on one side, and Sam\'s commit in main\'s history.',
    concepts: ['Feature branches', 'Rebasing onto an updated upstream', 'Publishing and force-with-lease', 'Merging with --no-ff', 'Deleting a remote branch'],
    hints: [],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        bare: ['acme'],
        prepare: ['git init', 'git add app.py', 'git commit -m "Add the application"', `git remote add origin ${URL}`, 'git push -u origin main'],
        prepareOther: ['cd ~', `git clone ${URL} acme`, 'cd acme', "printf 'The Acme command line tool.\\n' > README.md", 'git add README.md', 'git commit -m "Add a README"', 'git push'],
      }),
    objectives: [
      {
        id: 'commits',
        label: 'Two commits on a feature branch',
        checks: [
          { type: 'git-tracked', path: 'convert.py', rev: 'main', contains: 'def convert' },
          { type: 'git-tracked', path: 'test_convert.py', rev: 'main' },
          { type: 'git-commits', absentPattern: '\\bwip\\b', label: 'No commit message is just "wip"' },
        ],
      },
      {
        id: 'published',
        label: 'The branch was published before it was merged',
        checks: [
          { type: 'git-ran', subcommand: 'push', argsPattern: 'feature/convert|-u|--set-upstream', code: 0 },
          { type: 'git-ran', subcommand: 'rebase', code: 0 },
        ],
      },
      {
        id: 'caught-up',
        label: "Sam's work is in the history, and the feature sits on top of it",
        checks: [
          { type: 'git-tracked', path: 'README.md', rev: 'main' },
          { type: 'git-commits', messagePattern: 'Add a README', author: 'Sam' },
        ],
      },
      {
        id: 'merged',
        label: 'Merged into main with a merge commit, and pushed',
        checks: [
          { type: 'git-head', branch: 'main' },
          { type: 'git-shape', rev: 'main', merges: 1 },
          { type: 'git-pushed', branch: 'main' },
        ],
      },
      {
        id: 'tidy',
        label: 'The branch is gone from both places, and the tree is clean',
        checks: [
          { type: 'git-branch', name: 'feature/convert', exists: false },
          { type: 'git-branch', host: 'git1', dir: '/srv/git/acme.git', name: 'feature/convert', exists: false },
          { type: 'git-clean' },
        ],
      },
    ],
  },
  {
    id: 'git-24-exam-rescue-a-repository',
    moduleId: MODULE,
    order: 2,
    title: 'Exam: Rescue a Repository',
    difficulty: 'Advanced',
    estimatedMinutes: 45,
    isExam: true,
    description: 'Inherit a repository with a leaked secret, a deleted branch, a bad public commit and unfinished work, and put all four right.',
    scenario:
      'Alex has left. Read handover.md first, then fix what it describes. Each of the four problems needs a different tool, and choosing the wrong one makes things worse.\n\nOne. secrets.env is tracked, and there is no .gitignore. Stop git tracking it without deleting the file from disk, write a .gitignore that covers secrets.env, *.log and build/, and commit that. Be honest with yourself about what this does not do: the file stays in the old commits.\n\nTwo. The branch feature/rates was deleted and nobody wrote down the ids. Its two commits are still in the repository, and the reflog knows where they were. Bring the branch back, with both commits on it.\n\nThree. The commit whose message mentions the rate limiter is on main and was pushed weeks ago, so rewriting it is not an option. Undo its change in a way that keeps the record, and make sure the rate limiter is back on in app.py.\n\nFour. There is an unfinished edit in app.py that must survive all of this, and main is behind the server. Set the edit aside, bring main up to date with the server, then bring the edit back and commit it with a message that says what it is.\n\nWhen you are done: the working tree is clean, main has your work and the server\'s, feature/rates exists with two commits, secrets.env is on disk but not tracked, and nobody\'s published history has been rewritten.',
    concepts: ['git rm --cached and .gitignore', 'Reflog recovery', 'Revert rather than reset for public commits', 'Stash around a pull', 'Choosing the right undo'],
    hints: [],
    createState: () =>
      gitSite({
        files: { 'app.py': APP, 'handover.md': HANDOVER, 'secrets.env': 'API_TOKEN=nlc_7f3a9e2b41c8d05e\n', 'debug.log': 'noise\n' },
        bare: ['acme'],
        prepare: [
          'git init',
          'git add app.py handover.md secrets.env',
          'git commit -m "Add the application"',
          `git remote add origin ${URL}`,
          'git push -u origin main',
          "printf 'def main():\\n    print(\"hello\")\\n\\nRATE_LIMIT = 100\\n' > app.py",
          'git commit -am "Add a rate limiter"',
          "printf 'def main():\\n    print(\"hello\")\\n\\nRATE_LIMIT = 0\\n' > app.py",
          'git commit -am "temporarily disable the rate limiter"',
          'git push',
          'git switch -c feature/rates',
          "printf 'RATES = {\"usd\": 1.0}\\n' > rates.py",
          'git add rates.py',
          'git commit -m "Add a rates table"',
          "printf 'RATES = {\"usd\": 1.0, \"eur\": 0.92}\\n' > rates.py",
          'git commit -am "Add the euro rate"',
          'git switch main',
          'git branch -D feature/rates',
        ],
        prepareOther: ['cd ~', `git clone ${URL} acme`, 'cd acme', "printf 'The Acme command line tool.\\n' > README.md", 'git add README.md', 'git commit -m "Add a README"', 'git push'],
        edits: { 'app.py': 'def main():\n    print("hello, world")\n\nRATE_LIMIT = 0\n' },
      }),
    objectives: [
      { id: 'read', label: 'Read the handover notes', checks: [{ type: 'command', device: DEV, pattern: '(cat|less|more|head)\\s+handover\\.md', label: 'Read handover.md' }] },
      {
        id: 'secret',
        label: 'Stop tracking the secret, and write the ignore rules',
        checks: [
          { type: 'git-tracked', path: 'secrets.env', exists: false },
          { type: 'file', device: DEV, path: `${WORK}/secrets.env`, contains: 'API_TOKEN', label: 'The file is still on disk' },
          { type: 'git-ignored', path: 'secrets.env' },
          { type: 'git-ignored', path: 'debug.log' },
          { type: 'git-tracked', path: '.gitignore', contains: 'secrets\\.env', label: 'The committed .gitignore covers secrets.env' },
        ],
      },
      {
        id: 'branch',
        label: 'Recover the deleted branch, both commits',
        checks: [
          { type: 'git-branch', name: 'feature/rates' },
          { type: 'git-tracked', path: 'rates.py', rev: 'feature/rates', contains: 'eur' },
          { type: 'git-commits', rev: 'feature/rates', messagePattern: 'Add a rates table' },
        ],
      },
      {
        id: 'revert',
        label: 'Undo the public commit without rewriting it',
        checks: [
          { type: 'git-commits', messagePattern: 'revert' },
          { type: 'git-commits', messagePattern: 'temporarily disable the rate limiter', label: 'The original commit is still in the history' },
          { type: 'git-tracked', path: 'app.py', rev: 'main', contains: 'RATE_LIMIT = 100' },
        ],
      },
      {
        id: 'work',
        label: "Keep the unfinished edit, and take the server's work",
        checks: [
          { type: 'git-tracked', path: 'app.py', rev: 'main', contains: 'hello, world' },
          { type: 'git-tracked', path: 'README.md', rev: 'main' },
          { type: 'git-stash', count: 0 },
        ],
      },
      { id: 'clean', label: 'Leave it clean', checks: [{ type: 'git-clean' }] },
    ],
  },
];
