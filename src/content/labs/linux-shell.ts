import type { Lab } from '../types';
import { linuxSite } from './linux-site';

const MODULE = 'linux-shell';
const W = 'web1';

export const linuxShellLabs: Lab[] = [
  {
    id: 'lx-01-find-your-way',
    moduleId: MODULE,
    order: 1,
    title: 'Find Your Way Around',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Log in to a Linux server, see where you are, list what is there, and read a file and a manual page.',
    scenario:
      'You have a shell on web1, a small Ubuntu server. The prompt tells you who you are (student), which machine you are on (web1) and where you are (~ is your home directory).\n\nFind out exactly where you are with pwd, list your home directory including hidden files in the long format, move to /var/log and list the logs, read /etc/os-release to learn which release this is, and open the manual page for ls. Finish back in your home directory.',
    concepts: ['The prompt', 'pwd, ls, cd', 'Hidden files and long listings', 'cat', 'man and help'],
    hints: ['pwd prints the working directory; ls -la lists everything, one file per line with permissions and owners.', 'cd /var/log then ls. cat /etc/os-release prints the file.', 'man ls shows the manual; help lists everything this shell supports. cd on its own returns home.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'pwd', label: 'Print the working directory', checks: [{ type: 'command', device: W, pattern: '^pwd$' }] },
      { id: 'ls', label: 'List your home directory in long format with hidden files', checks: [{ type: 'command', device: W, pattern: '^ls\\s+-\\w*l', label: 'ls with -l' }, { type: 'command', device: W, pattern: '^ls\\s+-\\w*a', label: 'ls with -a' }] },
      { id: 'cd', label: 'Move to /var/log and list it', checks: [{ type: 'command', device: W, pattern: '^cd /var/log/?$' }, { type: 'command', device: W, pattern: '^ls' }] },
      { id: 'cat', label: 'Read /etc/os-release', checks: [{ type: 'command', device: W, pattern: '^cat /etc/os-release$' }] },
      { id: 'man', label: 'Open a manual page', checks: [{ type: 'command', device: W, pattern: '^(man \\S+|help|\\S+ --help)$', label: 'Run man followed by a command name, or help, or a command with --help' }] },
    ],
  },
  {
    id: 'lx-02-make-files-and-folders',
    moduleId: MODULE,
    order: 2,
    title: 'Make Files and Folders',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Create a project tree, write a file, copy and rename it, and delete a leftover.',
    scenario:
      'Set up a workspace for the NetLab project in your home directory.\n\nCreate ~/projects/netlab/docs in one command, write the line "NetLab project" into ~/projects/netlab/README.md, copy the README into docs, rename that copy to intro.md, and delete the stray ~/old-draft.txt.',
    concepts: ['mkdir -p', 'echo with > redirection', 'cp, mv, rm', 'Relative and absolute paths'],
    hints: ['mkdir -p ~/projects/netlab/docs creates every missing directory on the way.', 'echo "NetLab project" > ~/projects/netlab/README.md writes (or overwrites) the file.', 'cp source destination-directory/ copies; mv old new renames; rm file deletes.'],
    createState: () => linuxSite({ files: { '~/old-draft.txt': 'delete me\n' } }),
    objectives: [
      { id: 'tree', label: 'Create the project tree', checks: [{ type: 'file', device: W, path: '~/projects/netlab/docs', kind: 'dir' }] },
      { id: 'readme', label: 'Write the README', checks: [{ type: 'file', device: W, path: '~/projects/netlab/README.md', contains: 'NetLab project' }] },
      { id: 'copy', label: 'Copy it into docs as intro.md', checks: [{ type: 'file', device: W, path: '~/projects/netlab/docs/intro.md', contains: 'NetLab project' }, { type: 'file', device: W, path: '~/projects/netlab/docs/README.md', exists: false, label: 'docs/README.md was renamed, not left behind' }] },
      { id: 'rm', label: 'Delete the stray draft', checks: [{ type: 'file', device: W, path: '~/old-draft.txt', exists: false }] },
    ],
  },
  {
    id: 'lx-03-read-and-search',
    moduleId: MODULE,
    order: 3,
    title: 'Read and Search Text',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Look at the start and end of a log, count and extract matching lines, and save the matches.',
    scenario:
      'The security team wants to know about failed SSH logins on web1. Everything is in /var/log/auth.log.\n\nRead the first three lines, then the last two. Count the lines that contain "Failed password", save every such line to ~/failed.txt, and count the lines of that file with wc.',
    concepts: ['head and tail', 'grep and grep -c', 'Redirecting output to a file', 'wc -l'],
    hints: ['head -3 /var/log/auth.log and tail -2 /var/log/auth.log.', 'grep -c "Failed password" /var/log/auth.log counts; without -c it prints the lines.', 'Add > ~/failed.txt to save them, then wc -l ~/failed.txt.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'headtail', label: 'Read the start and the end of the log', checks: [{ type: 'command', device: W, pattern: '^head\\b.*auth\\.log' }, { type: 'command', device: W, pattern: '^tail\\b.*auth\\.log' }] },
      { id: 'count', label: 'Count the failed logins', checks: [{ type: 'command', device: W, pattern: '^grep\\b.*-\\w*c.*Failed password|^grep\\b.*Failed password.*\\|\\s*wc -l', label: 'grep -c "Failed password" (or grep | wc -l)' }] },
      { id: 'save', label: 'Save the matching lines to ~/failed.txt', checks: [{ type: 'file', device: W, path: '~/failed.txt', contains: '203\\.0\\.113\\.45' }, { type: 'file', device: W, path: '~/failed.txt', contains: '198\\.51\\.100\\.7' }, { type: 'file', device: W, path: '~/failed.txt', notContains: 'Accepted', label: 'Only failed logins, no accepted ones' }] },
      { id: 'wc', label: 'Count the lines of the file', checks: [{ type: 'command', device: W, pattern: '^wc\\b.*failed\\.txt' }] },
    ],
  },
  {
    id: 'lx-04-permissions',
    moduleId: MODULE,
    order: 4,
    title: 'Permissions and Ownership',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Lock a secret down, make a script executable and run it, and set up a group-shared directory.',
    scenario:
      'Three things are wrong in your home directory. secret.txt holds a database password and is readable by everyone. deploy.sh is a script nobody can run. The devops team needs a directory they can all write to.\n\nLook at the permissions with ls -l. Make secret.txt readable and writable only by you (600). Make deploy.sh executable and run it. Create ~/shared, give it mode 770, and hand its group to devops (that needs sudo).',
    concepts: ['rwx for user, group and others', 'chmod with numbers and with +x', 'chown and groups', 'Executing a script with ./'],
    hints: ['ls -l shows -rw-r--r-- for both files. chmod 600 secret.txt removes group and other access.', 'chmod +x deploy.sh, then ./deploy.sh. Without the x bit bash says Permission denied.', 'mkdir shared; chmod 770 shared; sudo chown :devops shared (the colon means "group only").'],
    createState: () => linuxSite({ groups: ['devops'], files: { '~/secret.txt': 'db_password=Sup3rSecret\n', '~/deploy.sh': '#!/bin/bash\necho "Deploying site to /var/www/html"\n' } }),
    objectives: [
      { id: 'look', label: 'Inspect the permissions', checks: [{ type: 'command', device: W, pattern: '^ls\\s+-\\w*l' }] },
      { id: 'secret', label: 'Lock down secret.txt', checks: [{ type: 'file', device: W, path: '~/secret.txt', mode: '600' }] },
      { id: 'exec', label: 'Make deploy.sh executable and run it', checks: [{ type: 'file', device: W, path: '~/deploy.sh', executable: true }, { type: 'shell-output', device: W, pattern: '^Deploying site to /var/www/html$', label: 'deploy.sh printed its message' }] },
      { id: 'shared', label: 'Create the devops shared directory', checks: [{ type: 'file', device: W, path: '~/shared', kind: 'dir', mode: '770', group: 'devops' }] },
    ],
  },
  {
    id: 'lx-05-links-and-find',
    moduleId: MODULE,
    order: 5,
    title: 'Links and Find',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Point a symbolic link at a log, then locate files by name and type.',
    scenario:
      'You keep typing the path to the application log. Make ~/app.log a symbolic link to /var/log/app.log, confirm where it points with ls -l, and read the ERROR lines through the link.\n\nThen use find to list every .log file under /var/log and every directory under your home.',
    concepts: ['Symbolic links with ln -s', 'find -name and -type', 'Following a link with cat and grep'],
    hints: ['ln -s /var/log/app.log ~/app.log. ls -l ~/app.log shows the arrow to the target.', 'grep ERROR ~/app.log reads through the link.', 'find /var/log -name "*.log" and find ~ -type d.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'link', label: 'Create the symbolic link', checks: [{ type: 'file', device: W, path: '~/app.log', kind: 'link' }, { type: 'file', device: W, path: '~/app.log', contains: 'ERROR disk full', label: 'The link resolves to the application log' }] },
      { id: 'inspect', label: 'Inspect the link', checks: [{ type: 'command', device: W, pattern: '^(ls\\s+-\\w*l.*app\\.log|readlink.*app\\.log)', label: 'Run ls -l on ~/app.log, or readlink on it' }] },
      { id: 'read', label: 'Read the errors through the link', checks: [{ type: 'command', device: W, pattern: '^grep\\b.*ERROR.*~?/?app\\.log' }] },
      { id: 'find', label: 'Find files by name and directories by type', checks: [{ type: 'command', device: W, pattern: '^find\\b.*-name' }, { type: 'command', device: W, pattern: '^find\\b.*-type d' }] },
    ],
  },
  {
    id: 'lx-06-exam-shell-essentials',
    moduleId: MODULE,
    order: 6,
    title: 'Exam: Shell Essentials',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    description: 'Build a report directory from a log with the right permissions, and tidy up, using only the shell.',
    scenario:
      'Produce an error report on web1.\n\nCreate ~/reports/2026. Save every ERROR line of /var/log/app.log into ~/reports/2026/errors.txt and the number of such lines into ~/reports/2026/count.txt. Make errors.txt readable by you and your group only (640). Create a symbolic link ~/latest-errors that points at the errors file. Finally delete ~/old-draft.txt.',
    concepts: ['Synthesis', 'Redirection', 'grep', 'chmod', 'ln -s', 'rm'],
    hints: [],
    isExam: true,
    createState: () => linuxSite({ files: { '~/old-draft.txt': 'delete me\n' } }),
    objectives: [
      { id: 'dir', label: 'Report directory', checks: [{ type: 'file', device: W, path: '~/reports/2026', kind: 'dir' }] },
      { id: 'errors', label: 'errors.txt holds exactly the ERROR lines', checks: [{ type: 'file', device: W, path: '~/reports/2026/errors.txt', contains: 'disk full' }, { type: 'file', device: W, path: '~/reports/2026/errors.txt', contains: 'timeout' }, { type: 'file', device: W, path: '~/reports/2026/errors.txt', notContains: 'INFO|WARN', label: 'No INFO or WARN lines' }] },
      { id: 'count', label: 'count.txt holds the count', checks: [{ type: 'file', device: W, path: '~/reports/2026/count.txt', contains: '^2\\s*$' }] },
      { id: 'mode', label: 'errors.txt is mode 640', checks: [{ type: 'file', device: W, path: '~/reports/2026/errors.txt', mode: '640' }] },
      { id: 'link', label: '~/latest-errors links to the report', checks: [{ type: 'file', device: W, path: '~/latest-errors', kind: 'link' }, { type: 'file', device: W, path: '~/latest-errors', contains: 'disk full', label: 'The link resolves to errors.txt' }] },
      { id: 'tidy', label: 'The old draft is gone', checks: [{ type: 'file', device: W, path: '~/old-draft.txt', exists: false }] },
    ],
  },
];
