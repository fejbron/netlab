import type { Lab } from '../types';
import { anSite, CONTROL, INVENTORY } from './an-site';

const MODULE = 'an-exams';

/** The playbook a colleague left behind: it works, once, and it should not be trusted. */
const INHERITED = `---
- hosts: web1
  become: true
  vars:
    db_password: hunter2
  tasks:
    - name: install nginx
      ansible.builtin.shell: apt-get install -y nginx

    - name: make the app directory
      ansible.builtin.shell: mkdir -p /srv/app

    - name: write the app config
      ansible.builtin.shell: echo "password = {{ db_password }}" > /srv/app/app.conf

    - name: restart nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
`;

const HANDOVER = `Handover notes
==============

deploy.yml is the playbook we use for the web tier. Things I never got to:

* It only ever runs against web1. web2 has been configured by hand and drifts.
* It uses shell for everything, so every run reports changed and we cannot tell
  a real change from noise.
* The database password is in the playbook, and the playbook is in Git.
* nginx is restarted on every run, which we have to do out of hours because of it.

- Sam
`;

export const anExamLabs: Lab[] = [
  {
    id: 'an-25-exam-build-the-fleet',
    moduleId: MODULE,
    order: 1,
    title: 'Exam: Build the Fleet',
    difficulty: 'Advanced',
    estimatedMinutes: 45,
    isExam: true,
    description: 'Automate a three-server environment from a written specification: inventory, a role, templates, secrets, accounts and scheduled work.',
    scenario:
      'You have three servers and a specification. Build it with Ansible, and make sure a second run is silent.\n\nInventory. web1 and web2 are in a group called web, db1 is in a group called db, and both are children of a group called production. The web group has http_port set to 8080.\n\nA baseline for every host. Create a group called platform and a user called deploy in it, with /bin/bash as its shell. Install chrony, and make sure it is started and enabled. Schedule a cron entry for root called "nightly cleanup" that runs /usr/local/bin/cleanup.sh at 02:30, and deploy that script (mode 0755) so there is something to run.\n\nThe web tier. Package the web work as a role called webserver under roles/: it installs nginx, renders templates/site.conf.j2 into /etc/nginx/conf.d/site.conf listening on {{ http_port }}, publishes a landing page naming the host, and starts and enables the service. The template task must notify a handler that restarts nginx, so a run that changes nothing restarts nothing.\n\nSecrets. The database credentials live in vars/secrets.yml as db_user and db_password, encrypted with Ansible Vault using the password "netlab-vault". The db host gets /etc/app.conf, mode 0640, containing those values. Put the vault password in a file called vault-pass and name it in ansible.cfg as vault_password_file, so the playbook runs without a flag — and so an automated check can run it too.\n\nOne playbook, site.yml, does all of it. Run it, then run it again: every host must report changed=0.',
    concepts: ['Inventory design', 'Roles', 'Templates', 'Handlers', 'Vault', 'Users and groups', 'Scheduled tasks', 'Idempotency'],
    hints: [],
    createState: () => anSite({ inventory: 'web1\nweb2\ndb1\n', config: '[defaults]\ninventory = inventory.ini\nhost_key_checking = False\n' }),
    objectives: [
      {
        id: 'inventory',
        label: 'Build the inventory',
        checks: [
          { type: 'an-inventory', host: 'web1', group: 'web' },
          { type: 'an-inventory', host: 'db1', group: 'db' },
          { type: 'an-inventory', host: 'web2', group: 'production' },
          { type: 'an-inventory', host: 'web1', vars: { http_port: 8080 } },
        ],
      },
      {
        id: 'baseline',
        label: 'Apply the baseline to every host',
        checks: [
          { type: 'linux-group', device: 'db1', name: 'platform', exists: true },
          { type: 'linux-user', device: 'db1', name: 'deploy', groups: ['platform'], shell: '/bin/bash' },
          { type: 'service', device: 'web2', name: 'chrony', active: true, enabled: true },
        ],
      },
      {
        id: 'cron',
        label: 'Schedule the nightly cleanup',
        checks: [
          { type: 'file', device: 'web1', path: '/usr/local/bin/cleanup.sh', mode: '755' },
          { type: 'file', device: 'db1', path: '/var/spool/cron/crontabs/root', contains: '#Ansible: nightly cleanup' },
          { type: 'file', device: 'db1', path: '/var/spool/cron/crontabs/root', contains: '30 2 \\* \\* \\*' },
        ],
      },
      {
        id: 'role',
        label: 'Package the web tier as a role',
        checks: [
          { type: 'an-role', name: 'webserver', files: ['tasks/main.yml', 'handlers/main.yml', 'templates/site.conf.j2'] },
          { type: 'an-source', path: 'site.yml', pattern: 'roles:|include_role|import_role', label: 'site.yml uses the role' },
          { type: 'an-source', path: 'roles/webserver/tasks/main.yml', pattern: 'notify:', label: 'The template task notifies the handler' },
        ],
      },
      {
        id: 'web',
        label: 'Configure both web servers',
        checks: [
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8080' },
          { type: 'file', device: 'web2', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8080' },
          { type: 'file', device: 'web2', path: '/var/www/html/index.html', contains: 'web2' },
          { type: 'service', device: 'web2', name: 'nginx', active: true, enabled: true },
        ],
      },
      {
        id: 'secrets',
        label: 'Keep the credentials encrypted',
        checks: [
          { type: 'an-vaulted', path: 'vars/secrets.yml', password: 'netlab-vault' },
          { type: 'an-source', path: 'ansible.cfg', pattern: 'vault_password_file\\s*=', label: 'ansible.cfg names the vault password file' },
          { type: 'file', device: 'db1', path: '/etc/app.conf', contains: 'password', mode: '640' },
          { type: 'an-source', path: 'site.yml', pattern: 'hunter2|s3cret', absent: true, label: 'No password is written in site.yml' },
        ],
      },
      { id: 'again', label: 'The whole thing is idempotent', checks: [{ type: 'an-idempotent', playbook: 'site.yml' }] },
    ],
  },
  {
    id: 'an-26-exam-inherit-a-playbook',
    moduleId: MODULE,
    order: 2,
    title: 'Exam: Inherit a Playbook',
    difficulty: 'Advanced',
    estimatedMinutes: 40,
    isExam: true,
    description: 'Take over a playbook that works once, and make it something you would schedule: real modules, both servers, a handler, and no secret in Git.',
    scenario:
      'Sam has left, and deploy.yml is yours. Read handover.md first, then open the playbook. It does work — that is what makes it dangerous.\n\nFix four things, and prove each one.\n\nIt runs against one host. Point it at the web group, so web2 stops drifting.\n\nIt uses shell for everything. Replace the shell tasks with the modules that do the same jobs: package for nginx, file for the /srv/app directory, and copy (or template) for /srv/app/app.conf. Shell tasks report changed every run and tell you nothing; the modules check first, and the recap becomes information rather than noise.\n\nThe database password is in the file. Move db_user and db_password into vars/secrets.yml, load it with vars_files, and encrypt it with ansible-vault using the password "netlab-vault". Put that password in a file called vault-pass and name it in ansible.cfg as vault_password_file, so the playbook still runs with no extra flags. The rendered /srv/app/app.conf should still contain the credentials, with mode 0640.\n\nnginx restarts on every run. Make the restart a handler, notified only by the task that writes the configuration.\n\nWhen you are finished, run the playbook with the vault password and then run it again. The second run must report changed=0 on both web servers, and no handler should fire.',
    concepts: ['Refactoring shell into modules', 'Idempotency as a property you can test', 'Handlers', 'Vault', 'Host patterns'],
    hints: [],
    createState: () => anSite({ inventory: INVENTORY, files: { 'deploy.yml': INHERITED, 'handover.md': HANDOVER } }),
    objectives: [
      {
        id: 'read',
        label: 'Read the handover notes',
        checks: [{ type: 'command', device: CONTROL, pattern: '(cat|less|more|head)\\s+handover\\.md', label: 'Read handover.md' }],
      },
      {
        id: 'both',
        label: 'Run against both web servers',
        checks: [
          { type: 'an-source', path: 'deploy.yml', pattern: 'hosts:\\s*web\\s*$', label: 'The play targets the web group' },
          { type: 'an-stats', host: 'web2', playbook: 'deploy.yml', failed: 0, unreachable: 0, label: 'web2 is in the run' },
        ],
      },
      {
        id: 'modules',
        label: 'Replace shell with real modules',
        checks: [
          { type: 'an-source', path: 'deploy.yml', pattern: 'ansible\\.builtin\\.shell|ansible\\.builtin\\.command', absent: true, label: 'No shell or command tasks remain' },
          { type: 'package', device: 'web2', name: 'nginx', installed: true },
          { type: 'file', device: 'web2', path: '/srv/app', kind: 'dir' },
        ],
      },
      {
        id: 'secret',
        label: 'Get the password out of Git',
        checks: [
          { type: 'an-source', path: 'deploy.yml', pattern: 'hunter2', absent: true, label: 'The password is no longer in deploy.yml' },
          { type: 'an-vaulted', path: 'vars/secrets.yml', password: 'netlab-vault' },
          { type: 'an-source', path: 'ansible.cfg', pattern: 'vault_password_file\\s*=', label: 'ansible.cfg names the vault password file' },
          { type: 'file', device: 'web1', path: '/srv/app/app.conf', contains: 'hunter2', mode: '640' },
        ],
      },
      {
        id: 'handler',
        label: 'Restart only when the configuration changes',
        checks: [
          { type: 'an-source', path: 'deploy.yml', pattern: 'handlers:', label: 'deploy.yml has a handlers section' },
          { type: 'an-source', path: 'deploy.yml', pattern: 'notify:', label: 'A task notifies the handler' },
          { type: 'service', device: 'web1', name: 'nginx', active: true },
        ],
      },
      { id: 'again', label: 'The second run is silent', checks: [{ type: 'an-idempotent', playbook: 'deploy.yml' }] },
    ],
  },
];
