import type { Lab } from '../types';
import { anSite, CONTROL, WORK } from './an-site';

const MODULE = 'an-basics';

export const anBasicsLabs: Lab[] = [
  {
    id: 'an-01-control-node',
    moduleId: MODULE,
    order: 1,
    title: 'Build a Control Node',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Install Ansible on the workstation, see which configuration it is using, and write an ansible.cfg of your own.',
    scenario:
      'Ansible is agentless: nothing is installed on the machines you manage. Everything lives on one control node, which connects to the others over SSH and runs Python there. That is the whole architecture, and it is why a fresh laptop can manage a fleet ten minutes after you open it.\n\nops1 is that workstation, and Ansible is not on it yet. Install the ansible package, then run ansible --version and read what it prints: the version, and — importantly — which config file it found. With no config anywhere, that line says None.\n\nAnsible looks for a configuration in a fixed order: $ANSIBLE_CONFIG, ./ansible.cfg in the directory you run from, ~/.ansible.cfg, then /etc/ansible/ansible.cfg. The first one wins outright; settings are not merged. Create ~/ansible/ansible.cfg with a [defaults] section that points inventory at inventory.ini and turns host_key_checking off, then run ansible --version again from ~/ansible and watch the config file line change.',
    concepts: ['Agentless architecture', 'Control node and managed nodes', 'ansible.cfg search order', 'ansible --version', 'ansible-config dump'],
    hints: [
      'sudo apt install ansible',
      'ansible --version prints "config file = None" until it finds one.',
      "Write the file with a heredoc:\ncat > ansible.cfg <<'EOF'\n[defaults]\ninventory = inventory.ini\nhost_key_checking = False\nEOF",
      'ansible-config dump --only-changed shows the settings that differ from the defaults.',
    ],
    createState: () => anSite({ noAnsible: true, noKeys: true, inventory: false, config: false }),
    objectives: [
      {
        id: 'install',
        label: 'Install Ansible',
        checks: [
          { type: 'package', device: CONTROL, name: 'ansible', installed: true },
          { type: 'command', device: CONTROL, pattern: 'ansible --version', label: 'Run ansible --version' },
        ],
      },
      {
        id: 'config',
        label: 'Write an ansible.cfg',
        checks: [
          { type: 'file', device: CONTROL, path: `${WORK}/ansible.cfg`, contains: '[defaults]' },
          { type: 'an-source', path: 'ansible.cfg', pattern: '^\\s*inventory\\s*=\\s*inventory\\.ini', label: 'ansible.cfg sets inventory = inventory.ini' },
          { type: 'an-source', path: 'ansible.cfg', pattern: '^\\s*[Hh]ost_key_checking\\s*=\\s*([Ff]alse|[Nn]o|0)', label: 'ansible.cfg turns host_key_checking off' },
        ],
      },
      {
        id: 'confirm',
        label: 'Confirm Ansible is reading it',
        checks: [{ type: 'command', device: CONTROL, pattern: 'ansible-config\\s+(dump|view)', label: 'Run ansible-config dump --only-changed' }],
      },
    ],
  },
  {
    id: 'an-02-reach-the-fleet',
    moduleId: MODULE,
    order: 2,
    title: 'Reach the Fleet',
    difficulty: 'Beginner',
    estimatedMinutes: 12,
    description: 'Create an SSH key, copy it to three managed nodes, and prove Ansible can reach all of them without a password.',
    scenario:
      'Ansible logs in over SSH as you. If you would have to type a password, so would Ansible — for every host, on every task. The fix is the ordinary one: a key pair on the control node, and its public half in each managed node\'s authorized_keys.\n\nGenerate a key with ssh-keygen -t rsa. Accept the default path and leave the passphrase empty (a passphrase is better practice, but then you need an agent, which this simulator does not run). Then copy it to web1, web2 and db1 with ssh-copy-id student@<host>; each asks for that account\'s password once, which is "student", and never again.\n\nAn inventory has been written for you at ~/ansible/inventory.ini. Prove the whole thing works with ansible all -m ping, which is not an ICMP ping: it logs in, runs a tiny Python module, and expects "pong" back. Three SUCCESS lines mean the plumbing is finished.',
    concepts: ['SSH key authentication', 'ssh-keygen and ssh-copy-id', 'authorized_keys', 'The ping module', 'UNREACHABLE versus FAILED'],
    hints: [
      "ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa",
      'ssh-copy-id student@web1, then the same for web2 and db1. The password is "student".',
      'ansible all -m ping',
      'A host you have not copied the key to answers UNREACHABLE with "Permission denied", not FAILED: Ansible never got in at all.',
    ],
    createState: () => anSite({ noKeys: true }),
    objectives: [
      {
        id: 'key',
        label: 'Create a key pair',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/.ssh/id_rsa.pub', contains: 'ssh-rsa' },
          { type: 'file', device: CONTROL, path: '/home/student/.ssh/id_rsa', mode: '600' },
        ],
      },
      {
        id: 'copy',
        label: 'Trust it on all three nodes',
        checks: [
          { type: 'file', device: 'web1', path: '/home/student/.ssh/authorized_keys', contains: 'ssh-rsa' },
          { type: 'file', device: 'web2', path: '/home/student/.ssh/authorized_keys', contains: 'ssh-rsa' },
          { type: 'file', device: 'db1', path: '/home/student/.ssh/authorized_keys', contains: 'ssh-rsa' },
        ],
      },
      {
        id: 'ping',
        label: 'Ping the whole inventory',
        checks: [
          { type: 'an-ran', module: 'ping', code: 0 },
          { type: 'an-stats', host: 'web1', ok: 1, unreachable: 0 },
          { type: 'an-stats', host: 'db1', ok: 1, unreachable: 0 },
        ],
      },
    ],
  },
  {
    id: 'an-03-inventory',
    moduleId: MODULE,
    order: 3,
    title: 'Write an Inventory',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Group hosts, nest groups inside a parent, give a group a variable, and select hosts with patterns.',
    scenario:
      'The inventory is the list of machines Ansible knows about, and the groups you put them in are how you say "all the web servers" instead of naming machines one at a time. Right now ~/ansible/inventory.ini lists three hosts and nothing else.\n\nRewrite it. Put web1 and web2 in a group called web, db1 in a group called db, and make a parent group called production whose children are web and db. Then give the web group a variable: under [web:vars], set http_port=8080. Group variables belong to every host in the group, and you will use this one in the next module.\n\nCheck your work with the tool rather than by eye. ansible-inventory --graph draws the tree, ansible-inventory --host web1 prints everything that host would inherit, and ansible web --list-hosts shows which machines a pattern selects. Finish by proving the parent group works: ansible production -m ping should reach all three.',
    concepts: ['INI inventory', 'Groups and children', 'Group variables', 'Host patterns', 'ansible-inventory'],
    hints: [
      "cat > inventory.ini <<'EOF' ... EOF writes the whole file in one go.",
      'A child group is declared as [production:children] followed by the group names, one per line.',
      'Group variables go under [web:vars] as key=value lines.',
      'ansible-inventory --graph, then ansible-inventory --host web1',
    ],
    createState: () => anSite({ inventory: 'web1\nweb2\ndb1\n' }),
    objectives: [
      {
        id: 'groups',
        label: 'Group the servers',
        checks: [
          { type: 'an-inventory', host: 'web1', group: 'web' },
          { type: 'an-inventory', host: 'web2', group: 'web' },
          { type: 'an-inventory', host: 'db1', group: 'db' },
        ],
      },
      {
        id: 'children',
        label: 'Nest them under production',
        checks: [
          { type: 'an-inventory', host: 'web1', group: 'production' },
          { type: 'an-inventory', host: 'db1', group: 'production' },
        ],
      },
      { id: 'vars', label: 'Give the web group a variable', checks: [{ type: 'an-inventory', host: 'web1', vars: { http_port: 8080 } }] },
      {
        id: 'inspect',
        label: 'Inspect the inventory with the tool',
        checks: [{ type: 'command', device: CONTROL, pattern: 'ansible-inventory\\s+.*(--graph|--host|--list)', label: 'Run ansible-inventory --graph or --host' }],
      },
      { id: 'ping', label: 'Reach the parent group', checks: [{ type: 'an-ran', module: 'ping', code: 0 }, { type: 'an-stats', host: 'db1', unreachable: 0 }] },
    ],
  },
  {
    id: 'an-04-ad-hoc',
    moduleId: MODULE,
    order: 4,
    title: 'Ad Hoc Commands',
    difficulty: 'Beginner',
    estimatedMinutes: 14,
    description: 'Do one-off work across the fleet without writing a playbook: read uptime, gather a fact, and install a package with privilege escalation.',
    scenario:
      'Not every job deserves a file. When you want to know something right now, or change one thing once, an ad hoc command does it: ansible <pattern> -m <module> -a "<arguments>".\n\nStart by reading: ansible all -a "uptime" runs the command module (the default, which is why -m is optional) on every host. Then gather one fact instead of all of them with ansible web1 -m setup -a "filter=ansible_distribution" — facts are what Ansible discovers about a machine, and you will use them constantly.\n\nNow change something. Install chrony on the db group with the package module. That needs root, so add -b (become). Notice what Ansible reports: CHANGED the first time, SUCCESS the second, because the module checks before it acts. That is idempotency, and it is the difference between Ansible and a shell script.\n\nFinally, be honest about the shell: ansible db -b -a "systemctl is-active chrony" works, but the command module has no idea what it did, so it always says CHANGED. Prefer a real module whenever one exists.',
    concepts: ['Ad hoc commands', 'The command module as the default', 'become (-b)', 'Idempotency', 'Facts with the setup module'],
    hints: [
      'ansible all -a "uptime"',
      'ansible web1 -m setup -a "filter=ansible_distribution"',
      'ansible db -m package -a "name=chrony state=present" -b',
      'Run the install twice and compare CHANGED with SUCCESS.',
    ],
    createState: () => anSite(),
    objectives: [
      { id: 'read', label: 'Read something from every host', checks: [{ type: 'an-ran', module: 'command', code: 0 }, { type: 'command', device: CONTROL, pattern: 'ansible\\s+all\\s+.*uptime', label: 'Run ansible all -a "uptime"' }] },
      { id: 'fact', label: 'Gather a single fact', checks: [{ type: 'an-ran', module: 'setup', code: 0 }] },
      {
        id: 'install',
        label: 'Install chrony on the database server',
        checks: [
          { type: 'an-ran', module: 'package', code: 0 },
          { type: 'package', device: 'db1', name: 'chrony', installed: true },
          { type: 'package', device: 'web1', name: 'chrony', installed: false, label: 'The pattern only touched the db group: web1 does not have chrony' },
        ],
      },
      { id: 'again', label: 'Prove it is idempotent', checks: [{ type: 'an-stats', host: 'db1', changed: 0, failed: 0, label: 'The last run against db1 reported changed=0' }] },
    ],
  },
  {
    id: 'an-05-read-the-docs',
    moduleId: MODULE,
    order: 5,
    title: 'Look It Up',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Use ansible-doc to find a module and its options, then use what you found — the skill the exam actually tests.',
    scenario:
      'Nobody memorises module options, and the exam does not expect you to: the documentation is on the machine. ansible-doc -l lists every module available to you, and ansible-doc <module> prints its options and an example you can paste.\n\nYou need to add a line to a file on every web server without rewriting the file. Find the module: ansible-doc -l | grep -i line. Read it: ansible-doc lineinfile, and note the path, line and regexp options.\n\nThen use it. Add the line "MAINTAINER=platform-team" to /etc/environment on the web group, as an ad hoc command with become. Check it landed with ansible web -a "grep MAINTAINER /etc/environment".\n\nOne detail worth carrying forward: ansible-doc names modules in full, as ansible.builtin.lineinfile. The short name works, but the fully qualified name is what you will see in other people\'s playbooks, and it is unambiguous when two collections have a module of the same name.',
    concepts: ['ansible-doc', 'Fully qualified collection names', 'lineinfile', 'Finding the right module'],
    hints: [
      'ansible-doc -l | grep -i line',
      'ansible-doc lineinfile',
      'ansible web -b -m lineinfile -a "path=/etc/environment line=MAINTAINER=platform-team"',
      'ansible web -a "grep MAINTAINER /etc/environment"',
    ],
    createState: () => anSite(),
    objectives: [
      { id: 'find', label: 'Find the module in the documentation', checks: [{ type: 'command', device: CONTROL, pattern: 'ansible-doc', label: 'Run ansible-doc' }] },
      {
        id: 'use',
        label: 'Add the line on both web servers',
        checks: [
          { type: 'an-ran', module: 'lineinfile', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/environment', contains: 'MAINTAINER=platform-team' },
          { type: 'file', device: 'web2', path: '/etc/environment', contains: 'MAINTAINER=platform-team' },
        ],
      },
      { id: 'verify', label: 'Check it from the control node', checks: [{ type: 'command', device: CONTROL, pattern: 'ansible\\s+web\\s+.*grep', label: 'Run ansible web -a "grep MAINTAINER /etc/environment"' }] },
    ],
  },
];

