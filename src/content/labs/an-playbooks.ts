import type { Lab } from '../types';
import { anSite, CONTROL } from './an-site';

const MODULE = 'an-playbooks';

export const anPlaybookLabs: Lab[] = [
  {
    id: 'an-06-first-playbook',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Playbook',
    difficulty: 'Beginner',
    estimatedMinutes: 16,
    description: 'Write a play that installs, starts and configures a web server, run it, then run it again and watch it change nothing.',
    scenario:
      'An ad hoc command is a sentence. A playbook is the written-down version of how a machine should be, and it can be reviewed, committed and run again next year.\n\nWrite ~/ansible/web.yml. A playbook is a YAML list of plays; each play names the hosts it targets and the tasks to run on them. Your play should target the web group, become root, and do three things with three modules: install nginx with ansible.builtin.package, start and enable it with ansible.builtin.service, and write /var/www/html/index.html with ansible.builtin.copy, using content rather than a source file.\n\nRun it with ansible-playbook web.yml and read the output top to bottom: the play name, a Gathering Facts task you did not write, then your tasks, each reporting per host, and finally the PLAY RECAP.\n\nNow run it a second time. Every task should say ok, and the recap should say changed=0. That is the whole point: a playbook describes a destination, not a journey, so running it twice is safe. Finish with ansible-playbook web.yml --check, which reports what a run would do without doing it.',
    concepts: ['Plays and tasks', 'YAML structure', 'Modules: package, service, copy', 'PLAY RECAP', 'Idempotency', 'Check mode'],
    hints: [
      "Write the file with a heredoc: cat > web.yml <<'EOF' ... EOF. Two-space indentation, and a dash in front of each list item.",
      'A play needs at least hosts: and tasks:. become: true makes every task run through sudo.',
      'ansible-playbook web.yml',
      'Run it twice and compare the recaps.',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'write',
        label: 'Write the playbook',
        checks: [
          { type: 'an-yaml', path: 'web.yml' },
          { type: 'an-source', path: 'web.yml', pattern: 'hosts:\\s*web', label: 'The play targets the web group' },
          { type: 'an-source', path: 'web.yml', pattern: 'become:\\s*(true|yes)', label: 'The play becomes root' },
        ],
      },
      {
        id: 'run',
        label: 'Run it, and see the work happen',
        checks: [
          { type: 'an-ran', playbook: 'web.yml', code: 0 },
          { type: 'package', device: 'web1', name: 'nginx', installed: true },
          { type: 'service', device: 'web2', name: 'nginx', active: true, enabled: true },
          { type: 'file', device: 'web1', path: '/var/www/html/index.html', exists: true },
        ],
      },
      { id: 'again', label: 'Run it again: nothing changes', checks: [{ type: 'an-idempotent', playbook: 'web.yml' }] },
      { id: 'check', label: 'Try it in check mode', checks: [{ type: 'an-ran', playbook: 'web.yml', check: true }] },
    ],
  },
  {
    id: 'an-07-variables',
    moduleId: MODULE,
    order: 2,
    title: 'Variables and Where They Come From',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Set a value for a group, override it for one host, and override it again on the command line — then see which one won.',
    scenario:
      'The same play should configure both web servers, but web2 serves on a different port. Hard-coding either value is wrong; a variable is the answer, and the question becomes where to put it.\n\nAnsible looks in many places and applies a fixed precedence. Three of them matter today, weakest first: group_vars/<group>.yml applies to every host in a group, host_vars/<host>.yml applies to one host and beats the group, and -e on the command line beats everything.\n\nCreate group_vars/web.yml with http_port: 8080 and a second variable, web_message, set to "Served by the platform team". Create host_vars/web2.yml with http_port: 8081. Then write ports.yml: a play over the web group that writes /etc/nginx/conf.d/port.conf containing "listen {{ http_port }};" and /var/www/html/index.html containing the message and the port.\n\nRun it and check both hosts: web1 should have 8080 and web2 8081. Then run it once more with an extra variable, and confirm the page changed on both — the command line beats the files, which is exactly why -e is for one-offs and not for configuration.\n\nOne catch worth meeting now: -e takes key=value pairs separated by spaces, so -e "web_message=Maintenance window" sets the message to just "Maintenance". A value containing a space has to be JSON: -e \'{"web_message": "Maintenance window"}\'.',
    concepts: ['group_vars and host_vars', 'Variable precedence', 'Jinja2 substitution with {{ }}', 'Extra variables with -e'],
    hints: [
      'mkdir -p group_vars host_vars',
      'group_vars/web.yml is plain YAML: http_port: 8080 on its own line.',
      'Quote a value that starts with a variable: content: "{{ web_message }}\\n" — bare {{ }} at the start of a YAML value is a syntax error.',
      'ansible-playbook ports.yml -e \'{"web_message": "Maintenance window"}\'',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'group',
        label: 'Set the group variables',
        checks: [
          { type: 'an-yaml', path: 'group_vars/web.yml' },
          { type: 'an-inventory', host: 'web1', vars: { http_port: 8080 } },
        ],
      },
      { id: 'host', label: 'Override the port for web2', checks: [{ type: 'an-inventory', host: 'web2', vars: { http_port: 8081 } }] },
      {
        id: 'apply',
        label: 'Use them in a play',
        checks: [
          { type: 'an-ran', playbook: 'ports.yml', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/port.conf', contains: 'listen 8080' },
          { type: 'file', device: 'web2', path: '/etc/nginx/conf.d/port.conf', contains: 'listen 8081' },
        ],
      },
      {
        id: 'extra',
        label: 'Beat them both from the command line',
        checks: [
          { type: 'command', device: CONTROL, pattern: 'ansible-playbook\\s+ports\\.yml\\s+.*-e', label: 'Run ansible-playbook ports.yml with -e' },
          { type: 'file', device: 'web1', path: '/var/www/html/index.html', contains: 'Maintenance window' },
          { type: 'file', device: 'web2', path: '/var/www/html/index.html', contains: 'Maintenance window' },
        ],
      },
    ],
  },
  {
    id: 'an-08-facts',
    moduleId: MODULE,
    order: 3,
    title: 'Facts',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'See what Ansible discovers about a machine before it does anything, and write a play that uses it.',
    scenario:
      'The first task in every play you have run so far is one you did not write: Gathering Facts. Ansible logs in and asks the machine about itself — distribution, addresses, memory, service manager — and puts the answers in variables you can use.\n\nLook at them first: ansible web1 -m setup lists everything, and ansible web1 -m setup -a "filter=ansible_distribution*" narrows it down. Facts are available both as ansible_facts["distribution"] and as the flat ansible_distribution; the flat form is older but is what you will see most often.\n\nNow use them. Write facts.yml, a play over all hosts that writes /etc/motd from the copy module, containing the hostname, the distribution and version, and the primary IPv4 address — all from facts, so the same play produces a different file on each machine.\n\nFinally, add a debug task that prints ansible_facts["default_ipv4"]["address"] with the var: form, and run the play with -v to see the values. When you do not need facts, gather_facts: false makes a play noticeably faster; that is a real optimisation, not a trick.',
    concepts: ['Fact gathering', 'The setup module', 'ansible_facts versus flat fact names', 'debug with var and msg', 'gather_facts: false'],
    hints: [
      'ansible web1 -m setup -a "filter=ansible_distribution*"',
      'In a template or a string, facts are just variables: {{ ansible_hostname }}.',
      'The address is {{ ansible_default_ipv4.address }}.',
      'ansible-playbook facts.yml -v',
    ],
    createState: () => anSite(),
    objectives: [
      { id: 'look', label: 'Look at the facts', checks: [{ type: 'an-ran', module: 'setup', code: 0 }] },
      {
        id: 'use',
        label: 'Write a per-host /etc/motd from facts',
        checks: [
          { type: 'an-ran', playbook: 'facts.yml', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/motd', contains: 'web1' },
          { type: 'file', device: 'web1', path: '/etc/motd', contains: '192.168.1.51' },
          { type: 'file', device: 'db1', path: '/etc/motd', contains: 'Ubuntu' },
        ],
      },
      { id: 'debug', label: 'Print a fact with debug', checks: [{ type: 'an-task', task: 'Show the address', status: 'ok' }] },
      { id: 'idempotent', label: 'The play is idempotent', checks: [{ type: 'an-idempotent', playbook: 'facts.yml' }] },
    ],
  },
  {
    id: 'an-09-loops-and-conditions',
    moduleId: MODULE,
    order: 4,
    title: 'Loops, Conditions and Registered Results',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Install a list of packages with one task, run a task only on the database server, and capture a command’s output into a variable.',
    scenario:
      'Three things turn a list of tasks into a program: repeating a task over a list, skipping a task when it does not apply, and using the result of one task in the next.\n\nWrite tools.yml. First, one task that installs curl, git and htop using loop, with "{{ item }}" as the package name — one task, three packages, and the recap counts it once.\n\nSecond, a task that runs only on the database server. Use when: with a condition; "inventory_hostname in groups[\'db\']" and "\'db\' in group_names" both work. Have it create /etc/db-tuning.conf with copy. Watch web1 and web2 report skipping.\n\nThird, register. Run a command with ansible.builtin.command (uptime is fine), register its result as uptime_out, and print uptime_out.stdout with debug. A command task always reports changed, which is noise: add changed_when: false, because reading something is not a change. That single line is the difference between a playbook that is honest about what it did and one that cries wolf.',
    concepts: ['loop and item', 'when: conditions', 'group_names and groups', 'register', 'changed_when'],
    hints: [
      'loop is a list under the task, at the same indentation as the module name.',
      "when: \"'db' in group_names\"",
      'register: uptime_out, then debug: var: uptime_out.stdout',
      'Add changed_when: false to the command task so it reports ok.',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'loop',
        label: 'Install three packages in one task',
        checks: [
          { type: 'an-source', path: 'tools.yml', pattern: 'loop:', label: 'tools.yml uses loop' },
          { type: 'package', device: 'web1', name: 'git', installed: true },
          { type: 'package', device: 'web1', name: 'htop', installed: true },
          { type: 'package', device: 'db1', name: 'git', installed: true },
        ],
      },
      {
        id: 'when',
        label: 'Do the database-only work',
        checks: [
          { type: 'file', device: 'db1', path: '/etc/db-tuning.conf', exists: true },
          { type: 'file', device: 'web1', path: '/etc/db-tuning.conf', exists: false, label: 'web1 skipped the database task' },
          { type: 'an-stats', host: 'web1', skipped: 1, label: 'The recap shows web1 skipping one task' },
        ],
      },
      {
        id: 'register',
        label: 'Capture and print a command result',
        checks: [
          { type: 'an-source', path: 'tools.yml', pattern: 'register:', label: 'A task registers its result' },
          { type: 'an-source', path: 'tools.yml', pattern: 'changed_when:\\s*(false|no)', label: 'The command task is marked changed_when: false' },
          { type: 'an-idempotent', playbook: 'tools.yml' },
        ],
      },
    ],
  },
  {
    id: 'an-10-handlers-and-errors',
    moduleId: MODULE,
    order: 5,
    title: 'Handlers and Failures',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    description: 'Restart a service only when its configuration actually changed, and decide for yourself what counts as a failure.',
    scenario:
      'Two habits separate a playbook you can run in production from one you cannot.\n\nThe first is handlers. Restarting nginx on every run is disruptive and dishonest; restarting it only when its configuration changed is right. Write nginx.yml: a play over the web group that installs nginx, writes /etc/nginx/conf.d/site.conf with copy, and notifies a handler called "restart nginx" that restarts the service. Handlers live in a handlers: section, run once at the end of the play, and only if something notified them. Run the play twice: the first run restarts, the second does not even mention the handler.\n\nThe second is error handling. Add a second play over all hosts that tries to read /etc/app-license, a file that does not exist. On its own that fails the host and stops the play. Wrap it in a block with a rescue that writes a placeholder license with copy, so the play recovers, and an always that prints a message either way. Also add a task running "grep -c ERROR /var/log/app.log" with failed_when: false, because grep exits 1 when it finds nothing and that is not an error here.\n\nRun it: the recap should show rescued=1 and failed=0. A play that plans for failure is a play you can schedule.',
    concepts: ['notify and handlers', 'Handlers run once, at the end', 'block / rescue / always', 'failed_when and ignore_errors'],
    hints: [
      'notify: restart nginx goes on the task; the handler with that exact name goes under handlers:.',
      'block:, rescue: and always: are lists of tasks, indented under the block task.',
      'failed_when: false keeps a non-zero exit from failing the host.',
      'Run the playbook twice and look for RUNNING HANDLER.',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'handler',
        label: 'Restart only when the configuration changed',
        checks: [
          { type: 'an-source', path: 'nginx.yml', pattern: 'handlers:', label: 'nginx.yml has a handlers section' },
          { type: 'an-task', task: 'restart nginx', status: 'changed', host: 'web1', label: 'The handler ran on web1' },
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', exists: true },
        ],
      },
      {
        id: 'rescue',
        label: 'Recover from the missing licence',
        checks: [
          { type: 'an-task', task: 'Install a placeholder licence', host: 'db1', status: 'changed', label: 'The rescue ran on db1' },
          { type: 'an-stats', host: 'db1', failed: 0, label: 'db1 finished the play without failing' },
          { type: 'file', device: 'db1', path: '/etc/app-license', exists: true },
        ],
      },
      { id: 'quiet', label: 'Stop grep from failing the play', checks: [{ type: 'an-source', path: 'nginx.yml', pattern: 'failed_when:', label: 'A task sets failed_when' }] },
      { id: 'again', label: 'Run it twice: the handler stays quiet', checks: [{ type: 'an-idempotent', playbook: 'nginx.yml' }] },
    ],
  },
];
