import type { Lab } from '../types';
import { DEV, gitSite, WORK } from './git-site';

const MODULE = 'git-branching';

const INDEX = `<!doctype html>
<h1>Acme</h1>
<p>Welcome.</p>
`;

/** A repository with one commit, which most of these labs branch from. */
const START = ['git init', 'git add .', 'git commit -m "Add the landing page"'];

export const gitBranchingLabs: Lab[] = [
  {
    id: 'git-06-branch-and-switch',
    moduleId: MODULE,
    order: 1,
    title: 'Branches',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Make a branch, work on it, and switch back to find your work has not followed you.',
    scenario:
      'A branch is a movable name for a commit. Making one costs nothing: it writes forty characters into a file under .git/refs/heads. That is why git encourages a branch for every piece of work, where older tools made you think hard before starting one.\n\nCreate a branch called pricing and switch to it in one step: git switch -c pricing. (git checkout -b does the same; switch is the newer, clearer command.) Confirm with git branch, which marks the current one with an asterisk.\n\nAdd a pricing page and commit it. Then switch back with git switch main and look: ls does not show pricing.html any more. It has not been deleted — it belongs to a commit that main cannot reach, and switching branches makes the working tree match the branch you are on. Switch back to pricing and it returns.\n\nFinish with git log --oneline --all, which shows both branches at once, and notice the decorations: HEAD -> pricing tells you where you are, main tells you where the other branch stopped.',
    concepts: ['A branch is a pointer', 'git switch -c and git checkout -b', 'The working tree follows the branch', 'git branch', 'log --all'],
    hints: ['git switch -c pricing', 'git add pricing.html && git commit -m "Add a pricing page"', 'git switch main, then ls', 'git log --oneline --all'],
    createState: () => gitSite({ files: { 'index.html': INDEX }, prepare: START }),
    objectives: [
      { id: 'create', label: 'Create the pricing branch', checks: [{ type: 'git-branch', name: 'pricing' }] },
      {
        id: 'work',
        label: 'Commit the pricing page on that branch',
        checks: [
          { type: 'git-tracked', path: 'pricing.html', rev: 'pricing' },
          { type: 'git-tracked', path: 'pricing.html', rev: 'main', exists: false, label: 'main does not have the pricing page' },
        ],
      },
      {
        id: 'switch',
        label: 'Switch between the two and see the difference',
        checks: [
          { type: 'git-ran', subcommand: 'switch', code: 0 },
          { type: 'command', device: DEV, pattern: '^ls', label: 'Run ls to see what each branch holds' },
        ],
      },
      { id: 'see', label: 'See both branches in one log', checks: [{ type: 'git-ran', subcommand: 'log', argsPattern: '--all', code: 0 }] },
    ],
  },
  {
    id: 'git-07-merge-a-branch',
    moduleId: MODULE,
    order: 2,
    title: 'Merging',
    difficulty: 'Beginner',
    estimatedMinutes: 16,
    description: 'Merge a branch that main has not moved past, then one it has, and see why the two look different.',
    scenario:
      'Merging brings the work on one branch into another. What git does depends on whether the target branch has moved.\n\nFirst, the simple case. The branch pricing is ready and main has not changed since it started. Switch to main and run git merge pricing. Git says "Fast-forward": there is nothing to combine, so it just slides main up to the same commit. The history stays a straight line.\n\nNow the other case. Start a branch called about, commit a page on it, then switch back to main and commit a change there too. The two branches have diverged. Merge about into main and git makes a *merge commit*: a commit with two parents, one from each side. git log --oneline shows it, and git show on it lists both parents.\n\nThe question people ask is which is better. A fast-forward keeps history linear and easy to read; a merge commit records that two lines of work happened side by side and were brought together. If you want the record even when a fast-forward is possible, git merge --no-ff forces a merge commit — try it on the last branch here.',
    concepts: ['Fast-forward merge', 'Merge commits have two parents', 'Diverged branches', '--no-ff', 'Reading a merge in the log'],
    hints: [
      'git switch main, then git merge pricing — look for the word Fast-forward.',
      'git switch -c about, commit about.html, then git switch main and commit a change to index.html.',
      'git merge about now has to make a merge commit.',
      'git switch -c contact, commit, then git switch main && git merge --no-ff contact',
    ],
    createState: () =>
      gitSite({
        files: { 'index.html': INDEX },
        prepare: [...START, 'git switch -c pricing', 'printf "<h1>Pricing</h1>\\n" > pricing.html', 'git add pricing.html', 'git commit -m "Add a pricing page"', 'git switch main'],
      }),
    objectives: [
      {
        id: 'ff',
        label: 'Fast-forward the pricing branch into main',
        checks: [
          { type: 'git-tracked', path: 'pricing.html', rev: 'main' },
          { type: 'git-branch', name: 'pricing', mergedInto: 'main' },
          { type: 'git-ran', subcommand: 'merge', argsPattern: 'pricing', code: 0 },
        ],
      },
      {
        id: 'diverge',
        label: 'Make two branches that have both moved',
        checks: [
          { type: 'git-branch', name: 'about' },
          { type: 'git-tracked', path: 'about.html', rev: 'about' },
        ],
      },
      {
        id: 'merge',
        label: 'Merge them, making a merge commit',
        checks: [
          { type: 'git-tracked', path: 'about.html', rev: 'main' },
          { type: 'git-commits', rev: 'main', messagePattern: "Merge branch 'about'" },
        ],
      },
      {
        id: 'noff',
        label: 'Force a merge commit with --no-ff',
        checks: [
          { type: 'git-ran', subcommand: 'merge', argsPattern: '--no-ff', code: 0 },
          { type: 'git-shape', rev: 'main', merges: 2 },
        ],
      },
    ],
  },
  {
    id: 'git-08-resolve-a-conflict',
    moduleId: MODULE,
    order: 3,
    title: 'Resolve a Conflict',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Two branches changed the same line. Read the markers, decide what the file should say, and finish the merge.',
    scenario:
      'A conflict is not a failure. It is git declining to guess which of two changes to the same lines you meant, and handing the decision back to you.\n\nThe branch headline changed the first line of index.html. So did main. Merge headline into main and git stops: "Automatic merge failed; fix conflicts and then commit the result."\n\nOpen index.html. Git has written both versions into the file between markers: <<<<<<< HEAD is your side (main), ======= divides them, and >>>>>>> headline is the incoming side. git status calls the file "both modified" and lists it under "Unmerged paths".\n\nResolve it by editing the file so it says what you actually want — keep one side, the other, or write something new — and delete all three marker lines. Then git add index.html, which is how you tell git the file is settled, and git commit to finish the merge. Git has a message ready, but give your own with -m.\n\nOne habit worth taking away: when a merge goes wrong and you want out, git merge --abort puts everything back the way it was. A conflict is never a point of no return.',
    concepts: ['Conflict markers', 'Unmerged paths in status', 'git add marks a conflict resolved', 'The merge commit finishes the merge', 'git merge --abort'],
    hints: [
      'git merge headline, then cat index.html to see the markers.',
      'Rewrite the file without any <<<<<<<, ======= or >>>>>>> lines.',
      'git add index.html, then git status to see the conflict is gone.',
      'git commit -m "Merge the new headline"',
    ],
    createState: () =>
      gitSite({
        files: { 'index.html': INDEX },
        prepare: [
          ...START,
          'git switch -c headline',
          'printf \'<!doctype html>\\n<h1>Acme: tools that fit</h1>\\n<p>Welcome.</p>\\n\' > index.html',
          'git commit -am "Sharpen the headline"',
          'git switch main',
          'printf \'<!doctype html>\\n<h1>Acme Limited</h1>\\n<p>Welcome.</p>\\n\' > index.html',
          'git commit -am "Use the full company name"',
        ],
      }),
    objectives: [
      { id: 'conflict', label: 'Start the merge and meet the conflict', checks: [{ type: 'git-ran', subcommand: 'merge', argsPattern: 'headline', code: 1 }] },
      {
        id: 'resolve',
        label: 'Resolve the file yourself',
        checks: [
          { type: 'file', device: DEV, path: `${WORK}/index.html`, notContains: '<<<<<<<' },
          { type: 'file', device: DEV, path: `${WORK}/index.html`, notContains: '>>>>>>>' },
          { type: 'git-clean', conflicts: 0 },
        ],
      },
      {
        id: 'finish',
        label: 'Finish the merge with a commit',
        checks: [
          { type: 'git-shape', rev: 'main', merges: 1 },
          { type: 'git-branch', name: 'headline', mergedInto: 'main' },
          { type: 'git-clean' },
        ],
      },
      { id: 'sane', label: 'The committed page has no markers left in it', checks: [{ type: 'git-tracked', path: 'index.html', absent: '<<<<<<<|=======|>>>>>>>' }] },
    ],
  },
  {
    id: 'git-09-tags-and-tidy-branches',
    moduleId: MODULE,
    order: 4,
    title: 'Tags and Tidying Up',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Mark a release with a tag, then delete the branches that have been merged and the one that has not.',
    scenario:
      'Two small jobs that keep a repository pleasant to work in.\n\nFirst, tags. A branch moves as you commit; a tag does not. That makes tags right for marking a release. git tag v1.0 makes a lightweight tag, which is just a name for a commit. git tag -a v1.1 -m "message" makes an annotated tag, which is a real object with an author, a date and a message of its own. Use annotated tags for releases: git show v1.1 then tells you who released it and why.\n\nSecond, tidying. git branch shows four branches, and two of them are finished work already merged into main. git branch -d removes a merged branch and refuses to remove one that is not merged, which is a safety net worth understanding: -d protects you, -D overrides it.\n\nTry it. Delete the two merged branches with -d. Then try to delete experiment, which has a commit main never took, and read the refusal. That commit is only reachable through that branch, so deleting it makes the work very hard to find. Decide deliberately, then delete it with -D.\n\nDeleting a branch never deletes commits that another branch can still reach. That is why tidying up is safe.',
    concepts: ['Lightweight and annotated tags', 'Tags do not move', 'git branch -d versus -D', 'What deleting a branch does and does not remove'],
    hints: [
      'git tag v1.0 marks the current commit.',
      'git tag -a v1.1 -m "Second release" then git show v1.1',
      'git branch -d pricing about',
      'git branch -d experiment fails; read it, then use -D.',
    ],
    createState: () =>
      gitSite({
        files: { 'index.html': INDEX },
        prepare: [
          ...START,
          'git switch -c pricing',
          'printf "<h1>Pricing</h1>\\n" > pricing.html',
          'git add pricing.html',
          'git commit -m "Add a pricing page"',
          'git switch main',
          'git merge pricing',
          'git switch -c about',
          'printf "<h1>About</h1>\\n" > about.html',
          'git add about.html',
          'git commit -m "Add an about page"',
          'git switch main',
          'git merge about',
          'git switch -c experiment',
          'printf "<h1>Wild idea</h1>\\n" > idea.html',
          'git add idea.html',
          'git commit -m "Try a wild idea"',
          'git switch main',
        ],
      }),
    objectives: [
      {
        id: 'tag',
        label: 'Tag the release',
        checks: [
          { type: 'git-tag', name: 'v1.0' },
          { type: 'git-tag', name: 'v1.1', annotated: true },
        ],
      },
      {
        id: 'tidy',
        label: 'Delete the branches that are merged',
        checks: [
          { type: 'git-branch', name: 'pricing', exists: false },
          { type: 'git-branch', name: 'about', exists: false },
        ],
      },
      { id: 'refused', label: 'Meet the refusal on an unmerged branch', checks: [{ type: 'git-ran', subcommand: 'branch', argsPattern: '-d\\s+experiment', code: 1 }] },
      {
        id: 'force',
        label: 'Delete it deliberately',
        checks: [
          { type: 'git-branch', name: 'experiment', exists: false },
          { type: 'git-tracked', path: 'index.html', rev: 'main' },
        ],
      },
    ],
  },
];
