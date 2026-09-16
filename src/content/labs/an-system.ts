import type { Lab } from '../types';
import { anSite, CONTROL } from './an-site';

const MODULE = 'an-system';

export const anSystemLabs: Lab[] = [
  {
    id: 'an-14-packages-and-services',
    moduleId: MODULE,
    order: 1,
    title: 'Packages and Services',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Install and remove software and control services with the right modules — and meet the module that refuses to run here, honestly.',
    scenario:
      'Nearly every real playbook starts with packages and services, so the modules are worth knowing properly.\n\nWrite baseline.yml over all hosts. Install chrony and htop in one task with a list (the name option takes a list, which is faster and clearer than a loop). Make sure chrony is started and enabled. Then remove a package that should not be on a server: state: absent for telnet, which is not installed, so the task should report ok rather than changed — the modules check first.\n\nA word on choosing a module. ansible.builtin.package is generic: it picks apt here and dnf on Red Hat, so the same play works on both. ansible.builtin.apt is Debian-specific and has extra options such as update_cache. Use package unless you need something only apt has.\n\nNow be deliberately wrong. Add a task that uses ansible.builtin.dnf to install httpd, run the play, and read the error. NetLab\'s managed nodes run Ubuntu; dnf is a Red Hat package manager and there is nothing here for it to talk to, so the module says so instead of pretending. Delete that task, run the play again, and finish with a green recap. If you are preparing for EX294, remember that the exam is on RHEL: dnf, firewalld and storage modules are real there, and this simulator says plainly where its ground stops.',
    concepts: ['package versus apt', 'A list of package names in one task', 'state: absent', 'service: started and enabled', 'What the simulator does not simulate'],
    hints: [
      'name: can take a list:\n  name:\n    - chrony\n    - htop',
      'A package that is already absent reports ok, not changed.',
      'Add the dnf task, run the play, and read the error before deleting it.',
      'ansible all -a "systemctl is-enabled chrony"',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'install',
        label: 'Install the baseline packages everywhere',
        checks: [
          { type: 'an-ran', playbook: 'baseline.yml', code: 0 },
          { type: 'package', device: 'web1', name: 'chrony', installed: true },
          { type: 'package', device: 'db1', name: 'htop', installed: true },
        ],
      },
      {
        id: 'service',
        label: 'Start and enable the time service',
        checks: [
          { type: 'service', device: 'web1', name: 'chrony', active: true, enabled: true },
          { type: 'service', device: 'db1', name: 'chrony', active: true, enabled: true },
        ],
      },
      { id: 'absent', label: 'Make sure telnet is not installed', checks: [{ type: 'an-source', path: 'baseline.yml', pattern: 'state:\\s*absent', label: 'A task uses state: absent' }] },
      {
        id: 'honest',
        label: 'Meet the module that is not simulated, then remove it',
        checks: [
          { type: 'an-ran', playbook: 'baseline.yml', code: 2, label: 'A run of baseline.yml failed' },
          { type: 'an-source', path: 'baseline.yml', pattern: 'dnf', absent: true, label: 'The dnf task is gone again' },
          { type: 'an-idempotent', playbook: 'baseline.yml' },
        ],
      },
    ],
  },
  {
    id: 'an-15-users-and-groups',
    moduleId: MODULE,
    order: 2,
    title: 'Users, Groups and Keys',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    description: 'Create a service account across the fleet with a hashed password, the right groups, and an SSH key it can log in with.',
    scenario:
      'Accounts are the classic thing to get wrong by hand: created on three servers out of four, with a different shell on each. A play fixes that.\n\nWrite accounts.yml over all hosts. Create a group called platform, then a user called deploy: shell /bin/bash, a member of platform and sudo, with append: true so you do not wipe any group it is already in. Give it a password with the password_hash filter — "{{ \'Deploy-2026\' | password_hash(\'sha512\') }}" — never a plain-text password, and never a hash you pasted from somewhere.\n\nThere is a subtlety worth knowing, even though you will not be bitten by it here. On a real system, password_hash without a salt generates a new salt on every run, so the hash differs each time and the user task reports changed forever. The fix is a fixed salt as the second argument: password_hash(\'sha512\', \'netlabsalt\'). NetLab\'s filter is deterministic, so the play settles either way — write the salt anyway, because the machine you meet next will not be this one.\n\nThen give the account a key. Use ansible.posix.authorized_key with the control node\'s public key, read on the control node with the lookup plugin: "{{ lookup(\'file\', \'/home/student/.ssh/id_rsa.pub\') }}". That collection has to be installed first: ansible-galaxy collection install ansible.posix.\n\nFinally, remove an account that should be gone: state: absent for a user called olduser. Run the play twice and confirm the second run is entirely green.',
    concepts: ['user and group modules', 'append: true', 'password_hash with a salt', 'lookup("file", ...)', 'ansible.posix.authorized_key', 'state: absent for accounts'],
    hints: [
      'ansible-galaxy collection install ansible.posix',
      "password: \"{{ 'Deploy-2026' | password_hash('sha512', 'netlabsalt') }}\"",
      "key: \"{{ lookup('file', '/home/student/.ssh/id_rsa.pub') }}\"",
      'Run the play twice: without a fixed salt the user task never settles.',
    ],
    createState: () => anSite({ nodes: { web1: { users: [{ name: 'olduser', shell: '/bin/bash' }] }, web2: { users: [{ name: 'olduser', shell: '/bin/bash' }] }, db1: { users: [{ name: 'olduser', shell: '/bin/bash' }] } } }),
    objectives: [
      {
        id: 'group',
        label: 'Create the platform group everywhere',
        checks: [
          { type: 'linux-group', device: 'web1', name: 'platform', exists: true },
          { type: 'linux-group', device: 'db1', name: 'platform', exists: true },
        ],
      },
      {
        id: 'user',
        label: 'Create the deploy account',
        checks: [
          { type: 'linux-user', device: 'web1', name: 'deploy', groups: ['platform', 'sudo'], shell: '/bin/bash' },
          { type: 'linux-user', device: 'db1', name: 'deploy', groups: ['platform'] },
        ],
      },
      {
        id: 'key',
        label: 'Install its SSH key',
        checks: [
          { type: 'an-collection', name: 'ansible.posix' },
          { type: 'file', device: 'web1', path: '/home/deploy/.ssh/authorized_keys', contains: 'ssh-rsa' },
        ],
      },
      {
        id: 'remove',
        label: 'Remove the old account',
        checks: [
          { type: 'linux-user', device: 'web1', name: 'olduser', exists: false },
          { type: 'linux-user', device: 'db1', name: 'olduser', exists: false },
        ],
      },
      { id: 'again', label: 'Run it twice with no changes', checks: [{ type: 'an-idempotent', playbook: 'accounts.yml' }] },
    ],
  },
  {
    id: 'an-16-scheduled-tasks',
    moduleId: MODULE,
    order: 3,
    title: 'Scheduled Tasks',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Deploy a maintenance script and the cron entry that runs it, and remove one that should no longer run.',
    scenario:
      'A cron entry written by hand is invisible: nobody knows which server has it or who added it. The cron module names each entry it manages, which makes it both idempotent and removable.\n\nWrite maintenance.yml over all hosts. Deploy a script to /usr/local/bin/cleanup.sh with copy (mode 0755) that removes files under /tmp older than seven days. Then add a cron entry called "nightly cleanup" that runs it at 02:30 every day as root.\n\nLook at what the module wrote: ansible all -b -a "cat /var/spool/cron/crontabs/root". Each entry is preceded by a "#Ansible: <name>" marker, and that marker is how the module finds its own entry again instead of adding a second copy.\n\nNow remove one. db1 has an old entry called "legacy report" left by someone who has moved on. Add a task with state: absent and the same name, and watch it disappear from db1 while the other hosts report ok — removing something that is not there is not a change.\n\nRun the play twice and confirm it settles.',
    concepts: ['cron module', 'The #Ansible marker', 'state: absent for cron entries', 'Deploying a script with mode'],
    hints: [
      'copy with mode: "0755" makes the script executable.',
      'cron: name, minute: "30", hour: "2", job, user: root',
      'ansible all -b -a "cat /var/spool/cron/crontabs/root"',
      'The removal task needs the same name: as the entry it removes.',
    ],
    createState: () =>
      anSite({
        nodes: { db1: { files: { '/var/spool/cron/crontabs/root': '#Ansible: legacy report\n0 6 * * * /usr/local/bin/report.sh\n' } } },
      }),
    objectives: [
      {
        id: 'script',
        label: 'Deploy the cleanup script',
        checks: [
          { type: 'file', device: 'web1', path: '/usr/local/bin/cleanup.sh', mode: '755' },
          { type: 'file', device: 'db1', path: '/usr/local/bin/cleanup.sh', contains: '/tmp' },
        ],
      },
      {
        id: 'cron',
        label: 'Schedule it for 02:30',
        checks: [
          { type: 'file', device: 'web1', path: '/var/spool/cron/crontabs/root', contains: '#Ansible: nightly cleanup' },
          { type: 'file', device: 'web1', path: '/var/spool/cron/crontabs/root', contains: '30 2 * * *' },
        ],
      },
      { id: 'remove', label: 'Remove the legacy entry from db1', checks: [{ type: 'file', device: 'db1', path: '/var/spool/cron/crontabs/root', notContains: 'legacy report' }] },
      { id: 'again', label: 'Run it twice with no changes', checks: [{ type: 'an-idempotent', playbook: 'maintenance.yml' }] },
    ],
  },
  {
    id: 'an-17-firewall',
    moduleId: MODULE,
    order: 4,
    title: 'Firewall Rules',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Install a collection, open the ports the web servers need, and close everything else.',
    scenario:
      'Firewall rules are where the RHCE objectives and this simulator part company, so read this before you start. On Red Hat the module is ansible.posix.firewalld and the service is firewalld. NetLab\'s managed nodes run Ubuntu, where the firewall is ufw and the module is community.general.ufw. The thinking is identical — declare the rules you want, let the module reconcile them — but the module name and options differ, and the exam will use firewalld.\n\nThe ufw module lives in a collection that is not installed, so start there: ansible-galaxy collection install community.general. Check it landed with ansible-galaxy collection list.\n\nWrite firewall.yml over the web group. Install ufw, allow 22/tcp and 80/tcp, set the default incoming policy to deny, and enable the firewall. Order matters in the real world: allow SSH before you enable the firewall, or you lock yourself out of the machine you are configuring. That is not a hypothetical; it is the classic way to lose a server.\n\nRun the play, confirm with ansible web -b -a "ufw status", and run it again to check it settles.',
    concepts: ['Collections and where they come from', 'community.general.ufw', 'Rule order and locking yourself out', 'firewalld on Red Hat versus ufw here'],
    hints: [
      'ansible-galaxy collection install community.general',
      'Use the fully qualified name in the task: community.general.ufw.',
      'rule: allow with port: "22" and proto: tcp, then state: enabled at the end.',
      'ansible web -b -a "ufw status"',
    ],
    createState: () => anSite(),
    objectives: [
      { id: 'collection', label: 'Install the collection', checks: [{ type: 'an-collection', name: 'community.general' }] },
      {
        id: 'rules',
        label: 'Allow SSH and HTTP',
        checks: [
          { type: 'an-ran', playbook: 'firewall.yml', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/ufw/user.rules', contains: '22' },
          { type: 'file', device: 'web1', path: '/etc/ufw/user.rules', contains: '80' },
        ],
      },
      {
        id: 'enable',
        label: 'Turn the firewall on',
        checks: [
          { type: 'service', device: 'web1', name: 'ufw', active: true },
          { type: 'service', device: 'web2', name: 'ufw', active: true },
        ],
      },
      { id: 'again', label: 'Run it twice with no changes', checks: [{ type: 'an-idempotent', playbook: 'firewall.yml' }] },
    ],
  },
  {
    id: 'an-18-scripts-around-ansible',
    moduleId: MODULE,
    order: 5,
    title: 'Scripts Around Ansible',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Wrap ad hoc commands in a small shell script, so a routine check is one word instead of four commands.',
    scenario:
      'Ansible does not replace shell scripting; it gives it something better to call. A short script that runs a few ad hoc commands is often the right tool for a check you run every morning, and EX294 asks for exactly this.\n\nWrite ~/ansible/fleet-check.sh, make it executable, and have it take a host pattern as its first argument, defaulting to all when none is given. It should print a heading, then run three ad hoc commands against that pattern: -m ping, -a "uptime", and -a "df -h /" — and exit non-zero if the ping fails, so a cron job or CI step can act on it.\n\nRun it with no arguments, then with web, and check the exit status with echo $?.\n\nThe habit to take away: a script decides when and what to check; Ansible decides how to reach the machines. Keep the logic in the script small and let the modules do the work, and you will not end up reinventing Ansible in Bash.',
    concepts: ['Shell scripts calling ansible', 'Positional parameters and defaults', 'Exit codes', 'Ad hoc commands in automation'],
    hints: [
      'pattern="${1:-all}" gives the argument a default.',
      'chmod +x fleet-check.sh',
      'if ! ansible "$pattern" -m ping; then exit 1; fi',
      './fleet-check.sh web, then echo $?',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'write',
        label: 'Write the script',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/ansible/fleet-check.sh', executable: true },
          { type: 'an-source', path: 'fleet-check.sh', pattern: 'ansible\\b', label: 'The script runs ansible' },
          { type: 'an-source', path: 'fleet-check.sh', pattern: '\\$\\{1:-|\\$1', label: 'The script takes a host pattern as an argument' },
        ],
      },
      {
        id: 'run',
        label: 'Run it against the whole fleet',
        checks: [
          { type: 'command', device: CONTROL, pattern: '\\./fleet-check\\.sh', label: 'Run ./fleet-check.sh' },
          { type: 'an-ran', module: 'ping', code: 0 },
        ],
      },
      {
        id: 'pattern',
        label: 'Run it against one group',
        checks: [{ type: 'command', device: CONTROL, pattern: '\\./fleet-check\\.sh\\s+web', label: 'Run ./fleet-check.sh web' }],
      },
    ],
  },
];
