import type { Lab } from '../types';
import { linuxSite } from './linux-site';

const MODULE = 'linux-scripting';
const W = 'web1';

export const linuxScriptingLabs: Lab[] = [
  {
    id: 'lx-13-variables-and-quotes',
    moduleId: MODULE,
    order: 1,
    title: 'Variables and Quotes',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Set and expand variables, see what single and double quotes do, capture a command, and do arithmetic.',
    scenario:
      'Everything in a script starts with variables. Set site=netlab and print it inside double quotes as "Site: $site". Print the same text in single quotes and notice that $site is not expanded. Capture today\'s date with today=$(date +%F) and print it. Export EDITOR=nano and find it in env. Finally print the result of 7 times 6 with arithmetic expansion.',
    concepts: ['name=value (no spaces)', '"$var" versus \'$var\'', '$(command) substitution', 'export and env', '$(( expression ))'],
    hints: ['site=netlab then echo "Site: $site". Then echo \'Literal: $site\'.', 'today=$(date +%F); echo $today. The date in this lab is 2026-09-11.', 'export EDITOR=nano; env | grep EDITOR; echo $((7*6)).'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'expand', label: 'Expand a variable in double quotes', checks: [{ type: 'shell-output', device: W, pattern: '^Site: netlab$' }] },
      { id: 'literal', label: 'Keep it literal in single quotes', checks: [{ type: 'shell-output', device: W, pattern: '^Literal: \\$site$' }] },
      { id: 'subst', label: 'Capture the date into a variable and print it', checks: [{ type: 'command', device: W, pattern: '=\\$\\(date' }, { type: 'shell-output', device: W, pattern: '^2026-09-11$' }] },
      { id: 'export', label: 'Export EDITOR and find it in the environment', checks: [{ type: 'command', device: W, pattern: '^export EDITOR=' }, { type: 'shell-output', device: W, pattern: '^EDITOR=nano$' }] },
      { id: 'arith', label: 'Do arithmetic', checks: [{ type: 'shell-output', device: W, pattern: '^42$' }, { type: 'command', device: W, pattern: '\\$\\(\\(' }] },
    ],
  },
  {
    id: 'lx-14-your-first-script',
    moduleId: MODULE,
    order: 2,
    title: 'Your First Script',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Write a script with a heredoc, give it a shebang and an argument, make it executable and run it.',
    scenario:
      "There is no text editor in this simulator, so scripts are written with a heredoc:\n\ncat > hello.sh << 'EOF'\n#!/bin/bash\necho \"Hello, $1!\"\nEOF\n\nThe quotes around EOF stop the shell from expanding $1 while you type. Type the four lines (the prompt changes to > until EOF). Then make the script executable and run it as ./hello.sh NetLab.",
    concepts: ['Heredocs', 'The shebang line', 'Positional parameters $1', 'chmod +x and ./script'],
    hints: ["Type cat > hello.sh << 'EOF', press Enter, then each line, then EOF on its own line.", 'cat hello.sh shows what you wrote. chmod +x hello.sh.', './hello.sh NetLab prints Hello, NetLab!'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'file', label: 'hello.sh has a shebang and uses $1', checks: [{ type: 'file', device: W, path: '~/hello.sh', contains: '^#!/bin/(ba)?sh' }, { type: 'file', device: W, path: '~/hello.sh', contains: '\\$1' }] },
      { id: 'exec', label: 'It is executable', checks: [{ type: 'file', device: W, path: '~/hello.sh', executable: true }] },
      { id: 'run', label: 'Run it with an argument', checks: [{ type: 'command', device: W, pattern: '^\\./hello\\.sh \\S+' }, { type: 'shell-output', device: W, pattern: '^Hello, NetLab!$' }] },
    ],
  },
  {
    id: 'lx-15-conditions-and-exit-codes',
    moduleId: MODULE,
    order: 3,
    title: 'Conditions and Exit Codes',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Test for a file with if, print different messages, and exit non-zero so other tools can tell.',
    scenario:
      'Write check.sh that takes a path. If the path is a regular file it prints "<path> exists" and exits 0; otherwise it prints "<path> missing" and exits 1.\n\nRun it against /etc/hosts and against /etc/nothing, and print the exit code of the second run with echo $?.',
    concepts: ['if / then / else / fi', '[ -f path ] and other tests', 'exit codes and $?', 'Quoting "$1"'],
    hints: ["Inside the heredoc: if [ -f \"$1\" ]; then echo \"$1 exists\"; else echo \"$1 missing\"; exit 1; fi", './check.sh /etc/hosts prints exists.', './check.sh /etc/nothing; echo $? prints missing and then 1.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'script', label: 'check.sh uses if and exits 1 when missing', checks: [{ type: 'file', device: W, path: '~/check.sh', contains: 'if \\[' }, { type: 'file', device: W, path: '~/check.sh', contains: 'exit 1' }, { type: 'file', device: W, path: '~/check.sh', executable: true }] },
      { id: 'exists', label: 'Reports an existing file', checks: [{ type: 'shell-output', device: W, pattern: '^/etc/hosts exists$' }] },
      { id: 'missing', label: 'Reports a missing file and exits 1', checks: [{ type: 'shell-output', device: W, pattern: '^/etc/nothing missing$' }, { type: 'command', device: W, pattern: 'echo \\$\\?' }, { type: 'shell-output', device: W, pattern: '^1$', label: 'echo $? printed 1' }] },
    ],
  },
  {
    id: 'lx-16-loops',
    moduleId: MODULE,
    order: 4,
    title: 'Loops',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Loop over files with for and over the lines of a file with while read.',
    scenario:
      'Two loops. First, for every .log file in /var/log print "<file>: <n> lines" using wc -l inside a command substitution. Second, ~/teams.txt lists three team names, one per line: read it line by line with while read and create ~/teams/<name> for each. List ~/teams to confirm.',
    concepts: ['for name in list; do ...; done', 'Globs in loops', 'while read line; do ...; done < file', '$(wc -l < file)'],
    hints: ['for f in /var/log/*.log; do echo "$f: $(wc -l < $f) lines"; done', 'while read t; do mkdir -p ~/teams/$t; done < teams.txt', 'ls ~/teams shows engineering hr sales.'],
    createState: () => linuxSite({ files: { '~/teams.txt': 'sales\nhr\nengineering\n' } }),
    objectives: [
      { id: 'for', label: 'Count lines of every log with a for loop', checks: [{ type: 'command', device: W, pattern: '^for \\w+ in .*\\.log' }, { type: 'shell-output', device: W, pattern: 'auth\\.log: \\d+ lines$' }, { type: 'shell-output', device: W, pattern: 'app\\.log: \\d+ lines$' }] },
      { id: 'while', label: 'Create a directory per team with while read', checks: [{ type: 'command', device: W, pattern: '^while read' }, { type: 'file', device: W, path: '~/teams/sales', kind: 'dir' }, { type: 'file', device: W, path: '~/teams/hr', kind: 'dir' }, { type: 'file', device: W, path: '~/teams/engineering', kind: 'dir' }] },
    ],
  },
  {
    id: 'lx-17-functions',
    moduleId: MODULE,
    order: 5,
    title: 'Functions',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Put reusable pieces in a library file, source it, and return status from a function.',
    scenario:
      'Write ~/lib.sh with two functions. log prints its arguments prefixed with the time in brackets: [09:00:00] message, using $(date +%T) and $*. check_service takes a service name, runs systemctl is-active on it with the output sent to /dev/null, and returns 0 if it is active or 1 if not.\n\nLoad the file with source lib.sh (or . lib.sh), call log hello, and use check_service ssh && echo "ssh is up".',
    concepts: ['name() { ...; }', 'source / .', '$* and $@', 'return codes', 'Sending output to /dev/null'],
    hints: ['log() { echo "[$(date +%T)] $*"; }', 'check_service() { systemctl is-active "$1" > /dev/null && return 0; return 1; }', 'source lib.sh; log hello; check_service ssh && echo "ssh is up"'],
    createState: () => linuxSite(),
    objectives: [
      {
        id: 'lib',
        label: 'lib.sh defines both functions',
        // A regex over file contents cannot be read as an instruction, so each one says
        // in words what it is looking for.
        checks: [
          { type: 'file', device: W, path: '~/lib.sh', contains: 'log\\s*\\(\\)|function log', label: '~/lib.sh defines a function called log' },
          { type: 'file', device: W, path: '~/lib.sh', contains: 'check_service\\s*\\(\\)|function check_service', label: '~/lib.sh defines a function called check_service' },
          { type: 'file', device: W, path: '~/lib.sh', contains: 'return', label: 'and a function returns a value' },
        ],
      },
      { id: 'source', label: 'Load it into the shell', checks: [{ type: 'command', device: W, pattern: '^(source|\\.) (~/)?lib\\.sh$' }] },
      { id: 'log', label: 'log prints a timestamped message', checks: [{ type: 'shell-output', device: W, pattern: '^\\[\\d\\d:\\d\\d:\\d\\d\\] hello$', label: 'Printed a line like [14:32:07] hello' }] },
      { id: 'check', label: 'check_service reports ssh as up', checks: [{ type: 'shell-output', device: W, pattern: '^ssh is up$' }] },
    ],
  },
  {
    id: 'lx-18-text-pipelines',
    moduleId: MODULE,
    order: 6,
    title: 'Text-Processing Pipelines',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Chain grep, awk, sort and uniq into a report, pick columns with cut, and rewrite text with sed.',
    scenario:
      'Build a report of who is attacking SSH. From the "Failed password" lines in /var/log/auth.log, extract the source IP (in the log it is the word after "from"), count how often each appears, sort with the most frequent first, and save the result to ~/attackers.txt.\n\nThen list the users that have bash as their shell: print the name and shell columns of /etc/passwd with cut and filter for bash. Finally show the first three lines of /var/log/app.log with ERROR rewritten as ERR using sed.',
    concepts: ['Pipelines', "awk '{print $N}'", 'sort | uniq -c | sort -rn', 'cut -d -f', "sed 's/old/new/'"],
    hints: ["grep \"Failed password\" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn > ~/attackers.txt", 'cut -d: -f1,7 /etc/passwd | grep bash', "sed 's/ERROR/ERR/' /var/log/app.log | head -3"],
    createState: () => linuxSite(),
    objectives: [
      { id: 'report', label: 'attackers.txt counts source addresses, most frequent first', checks: [{ type: 'file', device: W, path: '~/attackers.txt', contains: '^\\s*3 203\\.0\\.113\\.45' }, { type: 'file', device: W, path: '~/attackers.txt', contains: '^\\s*1 198\\.51\\.100\\.7' }, { type: 'command', device: W, pattern: 'uniq -c' }] },
      { id: 'cut', label: 'List bash users with cut', checks: [{ type: 'command', device: W, pattern: '^cut -d' }, { type: 'shell-output', device: W, pattern: '^student:/bin/bash$' }] },
      { id: 'sed', label: 'Rewrite ERROR with sed', checks: [{ type: 'command', device: W, pattern: "^sed\\b.*s/ERROR/" }, { type: 'shell-output', device: W, pattern: 'ERR disk full' }] },
    ],
  },
  {
    id: 'lx-19-exam-backup-script',
    moduleId: MODULE,
    order: 7,
    title: 'Exam: The Backup Script',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Write a script that validates its argument, copies a directory into a dated backup folder, and reports what it did.',
    scenario:
      'Write ~/backup.sh. Without an argument it prints a usage line starting with "usage:" and exits 1. With a directory argument it creates ~/backup-<today> (today from date +%F, so backup-2026-09-11), copies every file from the given directory into it with a loop, counts them, and prints "Backed up <n> files to <destination>".\n\nMake it executable, run it once without arguments, then run it on ~/docs, which holds three files.',
    concepts: ['Synthesis', 'Argument validation', 'date in a variable', 'for loop over a glob', 'Counting with arithmetic'],
    hints: [],
    isExam: true,
    createState: () => linuxSite({ files: { '~/docs/a.txt': 'A\n', '~/docs/b.txt': 'B\n', '~/docs/c.txt': 'C\n' } }),
    objectives: [
      { id: 'script', label: 'backup.sh validates, loops and is executable', checks: [{ type: 'file', device: W, path: '~/backup.sh', executable: true }, { type: 'file', device: W, path: '~/backup.sh', contains: 'if \\[' }, { type: 'file', device: W, path: '~/backup.sh', contains: 'for \\w+ in' }, { type: 'file', device: W, path: '~/backup.sh', contains: 'exit 1' }] },
      { id: 'usage', label: 'Prints usage without an argument', checks: [{ type: 'shell-output', device: W, pattern: '^usage:' }] },
      { id: 'copied', label: 'Copies the three files into the dated folder', checks: [{ type: 'file', device: W, path: '~/backup-2026-09-11/a.txt', contains: 'A' }, { type: 'file', device: W, path: '~/backup-2026-09-11/b.txt', contains: 'B' }, { type: 'file', device: W, path: '~/backup-2026-09-11/c.txt', contains: 'C' }] },
      { id: 'report', label: 'Reports the count', checks: [{ type: 'shell-output', device: W, pattern: '^Backed up 3 files to ' }] },
    ],
  },
];
