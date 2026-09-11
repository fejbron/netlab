import type { Lab } from '../types';
import { linuxSite } from './linux-site';

const MODULE = 'linux-admin';
const W = 'web1';
const RUNAWAY = { user: 'student', cmd: 'python3 /home/student/runaway.py' };

export const linuxAdminLabs: Lab[] = [
  {
    id: 'lx-07-become-root',
    moduleId: MODULE,
    order: 1,
    title: 'Become Root, Carefully',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'See what an ordinary user cannot do, escalate with sudo, and come back down.',
    scenario:
      'Some files and commands belong to the administrator. Try cat /etc/shadow as student and read the refusal. Open a root shell with sudo -i, notice the prompt change to #, confirm who you are with whoami, read /etc/shadow, and leave the root shell with exit.\n\nThen refresh the package index with a single sudo command instead of a whole root shell: sudo apt update. Prefer that style: one privileged command at a time.',
    concepts: ['Permission denied', 'sudo and sudo -i', 'The # prompt', 'Least privilege'],
    hints: ['cat /etc/shadow says Permission denied. sudo -i opens a root shell.', 'whoami prints root; cat /etc/shadow now works; exit returns to student.', 'sudo apt update runs just that command as root.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'denied', label: 'See a permission denied as student', checks: [{ type: 'shell-output', device: W, pattern: 'Permission denied' }] },
      { id: 'root', label: 'Open a root shell', checks: [{ type: 'command', device: W, pattern: '^sudo (-i|-s|su -?)$' }, { type: 'shell-output', device: W, pattern: '^root:\\$6\\$', label: 'Read /etc/shadow as root' }] },
      { id: 'exit', label: 'Leave the root shell', checks: [{ type: 'command', device: W, pattern: '^(exit|logout)$' }] },
      { id: 'apt', label: 'Run one command with sudo', checks: [{ type: 'command', device: W, pattern: '^sudo apt(-get)? update$' }] },
    ],
  },
  {
    id: 'lx-08-users-and-groups',
    moduleId: MODULE,
    order: 2,
    title: 'Users and Groups',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Create a group and a user with a home directory, bash and a password, and add an existing user to the group.',
    scenario:
      'A new engineer, alice, joins the devops team; bob is already on the server.\n\nCreate the group devops. Create alice with a home directory, /bin/bash as her shell and devops as a supplementary group, then set her password with passwd. Add bob to devops without removing him from his other groups. Confirm with id alice and getent-style reading of /etc/group.',
    concepts: ['groupadd', 'useradd -m -s -G', 'passwd', 'usermod -aG (the a matters)', 'id and /etc/group'],
    hints: ['sudo groupadd devops.', 'sudo useradd -m -s /bin/bash -G devops alice, then sudo passwd alice and type the password twice.', 'sudo usermod -aG devops bob. Without -a the -G list replaces his groups. id alice shows uid, gid and groups.'],
    createState: () => linuxSite({ users: [{ name: 'bob', groups: ['users'] }] }),
    objectives: [
      { id: 'group', label: 'Create the devops group', checks: [{ type: 'linux-group', device: W, name: 'devops' }] },
      { id: 'alice', label: 'Create alice properly', checks: [{ type: 'linux-user', device: W, name: 'alice', shell: '/bin/bash', home: '/home/alice', groups: ['devops'] }, { type: 'file', device: W, path: '/home/alice', kind: 'dir', owner: 'alice', label: 'alice has a home directory' }, { type: 'linux-user', device: W, name: 'alice', hasPassword: true, label: 'alice has a password' }] },
      { id: 'bob', label: 'Add bob to devops without losing his groups', checks: [{ type: 'linux-user', device: W, name: 'bob', groups: ['devops', 'users'] }] },
      { id: 'verify', label: 'Verify with id', checks: [{ type: 'command', device: W, pattern: '^id alice$' }] },
    ],
  },
  {
    id: 'lx-09-run-a-web-server',
    moduleId: MODULE,
    order: 3,
    title: 'Run a Web Server',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Start and enable nginx with systemd, confirm it listens, publish a page, and fetch it from a PC.',
    scenario:
      'nginx is installed on web1 but not running. Check it with systemctl status, then start it and make it start at boot in one command. Confirm with ss that something listens on TCP port 80.\n\nReplace the default page: write <h1>Welcome to NetLab on web1</h1> into /var/www/html/index.html (that directory belongs to root). Then open the PC-A console and fetch http://192.168.1.50 with curl.',
    concepts: ['systemctl status / enable --now', 'ss -tlnp', 'Writing a root-owned file with sudo tee', 'Testing a service from another host'],
    hints: ['systemctl status nginx shows inactive (dead). sudo systemctl enable --now nginx starts and enables it.', 'ss -tlnp lists listening TCP sockets; look for :80.', 'echo "<h1>Welcome to NetLab on web1</h1>" | sudo tee /var/www/html/index.html writes as root. On PC-A: curl http://192.168.1.50.'],
    createState: () => linuxSite({ services: { nginx: { active: false, enabled: false } } }),
    objectives: [
      { id: 'status', label: 'Check the service first', checks: [{ type: 'command', device: W, pattern: '^(sudo )?systemctl status nginx' }] },
      { id: 'run', label: 'nginx runs now and at boot', checks: [{ type: 'service', device: W, name: 'nginx', active: true, enabled: true }] },
      { id: 'listen', label: 'Confirm it listens on port 80', checks: [{ type: 'command', device: W, pattern: '^(sudo )?ss\\b' }] },
      { id: 'page', label: 'Publish the page', checks: [{ type: 'file', device: W, path: '/var/www/html/index.html', contains: 'NetLab on web1' }] },
      { id: 'fetch', label: 'Fetch it from PC-A', checks: [{ type: 'command', device: 'PC-A', pattern: '^curl\\b.*192\\.168\\.1\\.50' }] },
    ],
  },
  {
    id: 'lx-10-processes-and-logs',
    moduleId: MODULE,
    order: 4,
    title: 'Processes and Logs',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Find a runaway process and stop it, then read service and application logs.',
    scenario:
      'web1 is sluggish. Someone left a script running. List all processes, find the one running runaway.py, and stop it.\n\nThen read the journal for the ssh service with journalctl, and count the ERROR lines in /var/log/app.log.',
    concepts: ['ps aux and grep', 'kill and pkill', 'journalctl -u', 'System and application logs'],
    hints: ['ps aux | grep runaway shows the PID in the second column.', 'kill <pid> (or pkill -f runaway). ps again to confirm it is gone.', 'journalctl -u ssh and grep -c ERROR /var/log/app.log.'],
    createState: () => linuxSite({ processes: [RUNAWAY] }),
    objectives: [
      { id: 'ps', label: 'List the processes', checks: [{ type: 'command', device: W, pattern: '^(ps\\b|top$|pgrep\\b)' }] },
      { id: 'kill', label: 'Stop the runaway script', checks: [{ type: 'process', device: W, pattern: 'runaway\\.py', running: false }] },
      { id: 'journal', label: 'Read the ssh journal', checks: [{ type: 'command', device: W, pattern: '^(sudo )?journalctl\\b.*ssh' }] },
      { id: 'errors', label: 'Count application errors', checks: [{ type: 'command', device: W, pattern: '^grep\\b.*ERROR.*app\\.log' }] },
    ],
  },
  {
    id: 'lx-11-network-from-the-host',
    moduleId: MODULE,
    order: 5,
    title: 'The Network From the Host',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Read addresses and routes on the server, test reachability, and call the router API with curl.',
    scenario:
      'Check web1 the way you would on a real server. Show its addresses with ip addr and its routing table with ip route. Ping the gateway 192.168.1.1 and the remote server SRV2 at 192.168.2.50.\n\nR1 exposes a RESTCONF API. From web1, read its interface list: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces',
    concepts: ['ip addr, ip route', 'ping -c', 'Default gateway', 'curl against a device API'],
    hints: ['ip addr (or ip -br addr) and ip route.', 'ping -c 3 192.168.1.1 and ping -c 3 192.168.2.50; -c stops after a count.', 'The curl command is in the scenario; -k accepts the self-signed certificate.'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'ip', label: 'Read addresses and routes', checks: [{ type: 'command', device: W, pattern: '^ip\\b.*\\ba(ddr(ess)?)?\\b' }, { type: 'command', device: W, pattern: '^ip\\b.*\\br(oute)?\\b' }] },
      { id: 'ping', label: 'Reach the gateway and the remote server', checks: [{ type: 'ping', device: W, target: '192.168.1.1', success: true }, { type: 'ping', device: W, target: '192.168.2.50', success: true }] },
      { id: 'api', label: 'Read the router API from web1', checks: [{ type: 'api-request', device: 'R1', method: 'GET', path: 'ietf-interfaces:interfaces', status: 200, label: 'R1 answered GET .../ietf-interfaces:interfaces with 200 OK' }] },
    ],
  },
  {
    id: 'lx-12-exam-bring-up-the-server',
    moduleId: MODULE,
    order: 6,
    title: 'Exam: Bring Up the Branch Server',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Name the server, create the web team, install and publish a web server, clean up a stray process, and prove it from the network.',
    scenario:
      'A fresh server needs to become the branch web server.\n\nSet its hostname to branch-web1. Create the group webteam and the user carol (home directory, /bin/bash, member of webteam, with a password). Install nginx, make sure it is running and enabled, and publish a page containing the word Branch at /var/www/html/index.html. Stop the runaway.py process someone left behind. Prove the result: ping the gateway from the server and fetch the page from PC-A.',
    concepts: ['Synthesis', 'hostnamectl', 'Users and groups', 'apt and systemd', 'Processes', 'Verification from another host'],
    hints: [],
    isExam: true,
    createState: () => linuxSite({ processes: [RUNAWAY] }),
    objectives: [
      { id: 'hostname', label: 'Hostname is branch-web1', checks: [{ type: 'linux-hostname', device: W, equals: 'branch-web1' }] },
      { id: 'team', label: 'webteam and carol', checks: [{ type: 'linux-group', device: W, name: 'webteam' }, { type: 'linux-user', device: W, name: 'carol', shell: '/bin/bash', home: '/home/carol', groups: ['webteam'], hasPassword: true }] },
      { id: 'nginx', label: 'nginx installed, running and enabled', checks: [{ type: 'package', device: W, name: 'nginx' }, { type: 'service', device: W, name: 'nginx', active: true, enabled: true }] },
      { id: 'page', label: 'Branch page published', checks: [{ type: 'file', device: W, path: '/var/www/html/index.html', contains: 'Branch' }] },
      { id: 'proc', label: 'Runaway process stopped', checks: [{ type: 'process', device: W, pattern: 'runaway\\.py', running: false }] },
      { id: 'proof', label: 'Proven from the network', checks: [{ type: 'ping', device: W, target: '192.168.1.1', success: true }, { type: 'command', device: 'PC-A', pattern: '^curl\\b.*192\\.168\\.1\\.50' }] },
    ],
  },
];
