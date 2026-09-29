import type { Lab } from '../types';
import { gitSite, SERVER, serverUrl } from './git-site';

const MODULE = 'git-workflow';

const APP = `def main():
    print("hello")
`;

const URL = serverUrl('acme');

export const gitWorkflowLabs: Lab[] = [
  {
    id: 'git-21-a-history-worth-reading',
    moduleId: MODULE,
    order: 1,
    title: 'A History Worth Reading',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Take a branch of messy commits and shape it into something a reviewer can follow, before anybody sees it.',
    scenario:
      'History is a document. The person who reads it most is you, six months from now, trying to work out why a line exists. This lab is about the tidying that happens between finishing work and sharing it.\n\nThe branch feature/login has five commits: "wip", "more", "oops forgot file", "fix test" and "actually fix test". Nothing is wrong with the code; the record is just unusable. It has not been pushed, so it is yours to reshape.\n\nThere are two sensible pieces of work in there: the login function itself, and its tests. Squash the five into two commits that say so. The move you know is git reset --soft, taking the branch back to where it started and committing in two deliberate steps — stage the login file, commit it, stage the test file, commit that.\n\nWrite the messages properly. A good message is a short line in the imperative ("Add login with a password check"), because it completes the sentence "applying this commit will...". Add a second paragraph when the *why* is not obvious from the diff.\n\nThen rebase onto main so it applies cleanly, and check your work with git log --oneline main..feature/login, which lists exactly the commits you are proposing. Two commits, two clear messages, in order. That is what reviewable means.',
    concepts: ['History as a document', 'Squashing into meaningful commits', 'Imperative commit messages', 'Rebase before sharing', 'main..branch'],
    hints: [
      'git log --oneline main..feature/login to see what you are proposing.',
      'git reset --soft main takes the branch back while keeping every change staged.',
      'git restore --staged test_login.py, commit the login file, then add the test file and commit it.',
      'git rebase main, then read the log once more.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        prepare: [
          'git init',
          'git add app.py',
          'git commit -m "Add the application"',
          'git switch -c feature/login',
          "printf 'def login(user, password):\\n    return password == \"letmein\"\\n' > login.py",
          'git add login.py',
          'git commit -m "wip"',
          "printf 'def login(user, password):\\n    if not user:\\n        return False\\n    return password == \"letmein\"\\n' > login.py",
          'git commit -am "more"',
          "printf 'def test_login():\\n    assert login(\"a\", \"letmein\")\\n' > test_login.py",
          'git add test_login.py',
          'git commit -m "oops forgot file"',
          "printf 'def test_login():\\n    assert login(\"a\", \"letmein\")\\n    assert not login(\"\", \"letmein\")\\n' > test_login.py",
          'git commit -am "fix test"',
          "printf 'def test_login():\\n    assert login(\"a\", \"letmein\") is True\\n    assert login(\"\", \"letmein\") is False\\n' > test_login.py",
          'git commit -am "actually fix test"',
        ],
      }),
    objectives: [
      {
        id: 'shape',
        label: 'Two commits instead of five',
        checks: [
          { type: 'git-commits', rev: 'feature/login', count: 3 },
          { type: 'git-commits', rev: 'feature/login', absentPattern: 'wip|oops|actually fix', label: 'None of the scrappy messages are left' },
        ],
      },
      {
        id: 'separate',
        label: 'The code and its tests are separate commits',
        checks: [
          { type: 'git-tracked', path: 'login.py', rev: 'feature/login~1', contains: 'def login' },
          { type: 'git-tracked', path: 'test_login.py', rev: 'feature/login~1', exists: false, label: 'The first commit is the login code alone' },
          { type: 'git-tracked', path: 'test_login.py', rev: 'feature/login', contains: 'def test_login' },
        ],
      },
      {
        id: 'messages',
        label: 'Messages that say what the commit does',
        checks: [
          { type: 'git-commits', rev: 'feature/login', messagePattern: 'login' },
          { type: 'git-commits', rev: 'feature/login', messagePattern: 'test' },
        ],
      },
      {
        id: 'content',
        label: 'The final state of the code is unchanged',
        checks: [
          { type: 'git-tracked', path: 'login.py', rev: 'feature/login', contains: 'if not user' },
          { type: 'git-tracked', path: 'test_login.py', rev: 'feature/login', contains: 'is False' },
          { type: 'git-clean' },
        ],
      },
    ],
  },
  {
    id: 'git-22-feature-branch-workflow',
    moduleId: MODULE,
    order: 2,
    title: 'The Feature Branch Workflow',
    difficulty: 'Advanced',
    estimatedMinutes: 22,
    description: 'Run one whole change through the loop a team actually uses: branch, work, publish, catch up, merge, tidy.',
    scenario:
      'Everything you have learned, in the order a working day uses it. The repository is shared, Sam is working in it too, and you have a feature to deliver.\n\nStart from a main that matches the server: git switch main and git pull. Branch for the work: git switch -c feature/search. Make the change in two sensible commits — the search function, then its test.\n\nPublish the branch with git push -u origin feature/search. Publishing a branch is how a team sees work in progress; on a service like GitHub this is the point where you would open a pull request, which NetLab does not simulate.\n\nWhile you were working, Sam pushed to main. Catch your branch up: git fetch, then git rebase origin/main, so your two commits sit on top of their work and merge cleanly. Your branch is published, but only you are working on it, so rebasing it is fine — and because you rewrote it, the push needs --force-with-lease, which refuses if somebody else has pushed to your branch since you last looked. It is the safer relative of --force.\n\nThen deliver: switch to main, pull, merge your branch with --no-ff so the history records that a feature landed, push, and delete the branch locally and on the server with git push origin --delete feature/search.\n\nFinish with git log --oneline --graph. The shape of that graph is your team\'s process, written down.',
    concepts: ['The feature branch loop', 'Publishing work in progress', 'Rebasing onto origin/main', '--force-with-lease', 'Merging with --no-ff', 'Deleting a published branch'],
    hints: [
      'git switch main && git pull, then git switch -c feature/search.',
      'Two commits: search.py, then test_search.py.',
      'git push -u origin feature/search, then git fetch && git rebase origin/main.',
      'git push --force-with-lease, then merge into main with --no-ff, push, and delete the branch both places.',
    ],
    createState: () =>
      gitSite({
        files: { 'app.py': APP },
        bare: ['acme'],
        prepare: ['git init', 'git add app.py', 'git commit -m "Add the application"', `git remote add origin ${URL}`, 'git push -u origin main'],
        prepareOther: ['cd ~', `git clone ${URL} acme`, 'cd acme', "printf '# Acme\\n\\nA tool.\\n' > README.md", 'git add README.md', 'git commit -m "Add a README"', 'git push'],
      }),
    objectives: [
      {
        id: 'branch',
        label: 'Two clear commits, made on a feature branch',
        checks: [
          { type: 'git-ran', subcommand: 'switch', argsPattern: '-c\\s+feature/search|feature/search', code: 0 },
          { type: 'git-tracked', path: 'search.py', rev: 'main' },
          { type: 'git-tracked', path: 'test_search.py', rev: 'main' },
          { type: 'git-commits', rev: 'main', messagePattern: 'search' },
        ],
      },
      {
        id: 'publish',
        label: 'Publish the branch before merging it',
        checks: [{ type: 'git-ran', subcommand: 'push', argsPattern: 'feature/search', code: 0 }],
      },
      {
        id: 'catch-up',
        label: "Rebase onto Sam's work and publish again",
        checks: [
          { type: 'git-ran', subcommand: 'rebase', code: 0 },
          { type: 'git-tracked', path: 'README.md', rev: 'main', label: "Sam's README is in the history" },
          { type: 'git-ran', subcommand: 'push', argsPattern: '--force-with-lease|--force|-f', code: 0 },
        ],
      },
      {
        id: 'deliver',
        label: 'Merge it into main and publish that',
        checks: [
          { type: 'git-head', branch: 'main' },
          { type: 'git-tracked', path: 'search.py', rev: 'main' },
          { type: 'git-shape', rev: 'main', merges: 1 },
          { type: 'git-pushed', branch: 'main' },
        ],
      },
      {
        id: 'tidy',
        label: 'Delete the branch, here and on the server',
        checks: [
          { type: 'git-branch', name: 'feature/search', exists: false },
          { type: 'git-branch', host: SERVER, dir: '/srv/git/acme.git', name: 'feature/search', exists: false, label: 'The branch is gone from the server too' },
        ],
      },
    ],
  },
];
