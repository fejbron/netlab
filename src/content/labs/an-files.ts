import type { Lab } from '../types';
import { anSite, CONTROL } from './an-site';

const MODULE = 'an-files';

const LEGACY_PLAY = `---
- name: Deploy the application settings
  hosts: web
  become: true
  vars:
    db_host: db1
    db_user: appuser
    db_password: hunter2
  tasks:
    - name: Write the application settings
      ansible.builtin.copy:
        content: |
          [database]
          host = {{ db_host }}
          user = {{ db_user }}
          password = {{ db_password }}
        dest: /etc/app.conf
        mode: '0640'
`;

export const anFilesLabs: Lab[] = [
  {
    id: 'an-11-files-and-content',
    moduleId: MODULE,
    order: 1,
    title: 'Files, Directories and Lines',
    difficulty: 'Intermediate',
    estimatedMinutes: 18,
    description: 'Create directories with the right ownership, deploy a file from the control node, and edit one line of a config you did not write.',
    scenario:
      'Most configuration management is files: put this here, with these permissions, owned by this user, and make sure that one line says the right thing.\n\nWrite files.yml for the web group. Use ansible.builtin.file to create /srv/app owned by the deploy group with mode 0750, and state: directory. Create the deploy group first with ansible.builtin.group so the ownership can be set — order matters, because a play runs top to bottom.\n\nNext, deploy a real file. Create files/app.env on the control node holding APP_ENV=production, and copy it to /srv/app/app.env with ansible.builtin.copy and src:, rather than content:. Ansible looks for src next to the playbook and inside a role\'s files/ directory, which is why the convention exists.\n\nFinally, change one line of a file that is not yours. Use ansible.builtin.lineinfile on /etc/ssh/sshd_config with a regexp of "^#?PasswordAuthentication" and the line "PasswordAuthentication no". lineinfile replaces the matching line if it finds one and appends it if it does not, which is why the regexp matters more than the line.\n\nRun it twice. All three tasks should be quiet the second time.',
    concepts: ['file with state: directory', 'copy with src and mode', 'Where Ansible looks for src', 'lineinfile and regexp', 'Task order inside a play'],
    hints: [
      'mkdir -p files, then write files/app.env.',
      'The file module needs state: directory, and owner/group/mode as separate options.',
      'Create the group with ansible.builtin.group before anything tries to own a file with it.',
      'lineinfile: path, regexp and line; the regexp is what makes it idempotent.',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'dir',
        label: 'Create the application directory',
        checks: [
          { type: 'linux-group', device: 'web1', name: 'deploy', exists: true },
          { type: 'file', device: 'web1', path: '/srv/app', kind: 'dir', group: 'deploy', mode: '750' },
        ],
      },
      {
        id: 'copy',
        label: 'Deploy a file from the control node',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/ansible/files/app.env', contains: 'APP_ENV=production' },
          { type: 'file', device: 'web1', path: '/srv/app/app.env', contains: 'APP_ENV=production' },
          { type: 'file', device: 'web2', path: '/srv/app/app.env', contains: 'APP_ENV=production' },
        ],
      },
      {
        id: 'line',
        label: 'Turn off password logins',
        checks: [
          { type: 'file', device: 'web1', path: '/etc/ssh/sshd_config', contains: 'PasswordAuthentication no' },
          { type: 'file', device: 'web1', path: '/etc/ssh/sshd_config', notContains: 'PasswordAuthentication yes' },
        ],
      },
      { id: 'again', label: 'Run it twice with no changes', checks: [{ type: 'an-idempotent', playbook: 'files.yml' }] },
    ],
  },
  {
    id: 'an-12-templates',
    moduleId: MODULE,
    order: 2,
    title: 'Templates',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    description: 'Render one Jinja2 template into a different, correct configuration file on every host.',
    scenario:
      'copy with content: works until the file has to differ per host, or contains a list. Then you want a template: a file with {{ }} substitutions, {% for %} loops and {% if %} conditions, rendered on the control node with that host\'s variables and delivered to the target.\n\nCreate templates/site.conf.j2. It should render an nginx server block that listens on {{ http_port }} (define it in group_vars/web.yml as 8080), sets server_name to the host\'s fully qualified name from facts, and writes a comment line naming every host in the web group using a {% for %} loop over groups[\'web\'].\n\nWrite templates.yml: install nginx, then use ansible.builtin.template with src: templates/site.conf.j2 and dest: /etc/nginx/conf.d/site.conf. Notice what the template module gives you that copy does not: the rendered file is different on web1 and web2 although there is only one source.\n\nRun the play, then look at the result on both hosts with an ad hoc command. Run it again and confirm nothing changes — the template module compares the rendered output with what is already there, not the template with the file.',
    concepts: ['Jinja2 templates', 'template versus copy', '{% for %} and {% if %}', 'Facts and group variables in templates', 'Rendering happens on the control node'],
    hints: [
      'mkdir -p templates group_vars',
      'A template is a plain file; only the {{ }} and {% %} parts are special.',
      "{% for h in groups['web'] %}# member: {{ h }}\n{% endfor %}",
      'ansible web -a "cat /etc/nginx/conf.d/site.conf"',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'template',
        label: 'Write the template',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/ansible/templates/site.conf.j2', contains: '{{' },
          { type: 'an-source', path: 'templates/site.conf.j2', pattern: '\\{%\\s*for\\b', label: 'The template loops over the group' },
        ],
      },
      {
        id: 'render',
        label: 'Render it onto both web servers',
        checks: [
          { type: 'an-ran', playbook: 'templates.yml', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8080' },
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'web1.lab.local' },
          { type: 'file', device: 'web2', path: '/etc/nginx/conf.d/site.conf', contains: 'web2.lab.local' },
        ],
      },
      { id: 'loop', label: 'The loop listed every web server', checks: [{ type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'web2' }] },
      { id: 'again', label: 'Rendering again changes nothing', checks: [{ type: 'an-idempotent', playbook: 'templates.yml' }] },
    ],
  },
  {
    id: 'an-13-vault',
    moduleId: MODULE,
    order: 3,
    title: 'Ansible Vault',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    description: 'Take a password out of a playbook, encrypt it with Vault, and keep the playbook working.',
    scenario:
      'settings.yml deploys /etc/app.conf to the web servers, and the database password is sitting in the play in plain text. It works, it is committed to Git, and it is a problem.\n\nMove the secrets out first. Create vars/secrets.yml holding db_user and db_password, delete those variables from the play, and load the file with vars_files. Run the play and confirm it still works — a refactor before an encryption.\n\nNow encrypt: ansible-vault encrypt vars/secrets.yml. It asks for a password twice; use "netlab-vault". Look at the file afterwards with cat and you will see $ANSIBLE_VAULT;1.1;AES256 and hex. Run the playbook again: it fails, because it cannot read the file. That failure is the feature.\n\nGive it the password. Write the password into a file (vault-pass, and add it to .gitignore in real life) and run ansible-playbook settings.yml --vault-password-file vault-pass. The play works again and the secret never appears on disk in the clear.\n\nFinish by looking at the tools you have: ansible-vault view vars/secrets.yml reads it without decrypting on disk, and ansible-vault encrypt_string --name db_password "s3cret" prints a single encrypted value you can paste into an otherwise readable vars file.',
    concepts: ['vars_files', 'ansible-vault encrypt, view, decrypt, rekey', 'encrypt_string for a single value', '--vault-password-file'],
    hints: [
      'mkdir -p vars, and move db_user and db_password into vars/secrets.yml.',
      'vars_files: is a play-level keyword, a list of files.',
      'ansible-vault encrypt vars/secrets.yml — the password is asked for twice.',
      'echo netlab-vault > vault-pass, then ansible-playbook settings.yml --vault-password-file vault-pass',
    ],
    createState: () => anSite({ files: { 'settings.yml': LEGACY_PLAY } }),
    objectives: [
      {
        id: 'move',
        label: 'Move the secrets into their own file',
        checks: [
          { type: 'an-source', path: 'settings.yml', pattern: 'vars_files:', label: 'settings.yml loads a vars file' },
          { type: 'an-source', path: 'settings.yml', pattern: 'hunter2', absent: true, label: 'The password is no longer in the playbook' },
        ],
      },
      { id: 'encrypt', label: 'Encrypt it', checks: [{ type: 'an-vaulted', path: 'vars/secrets.yml', password: 'netlab-vault' }] },
      {
        id: 'run',
        label: 'Run the play with the vault password',
        checks: [
          { type: 'command', device: CONTROL, pattern: 'ansible-playbook\\s+settings\\.yml\\s+.*(--vault-password-file|--ask-vault-pass)', label: 'Run the playbook with the vault password' },
          { type: 'file', device: 'web1', path: '/etc/app.conf', contains: 'password = hunter2' },
          { type: 'file', device: 'web1', path: '/etc/app.conf', mode: '640' },
        ],
      },
      { id: 'view', label: 'Read the secret without decrypting the file', checks: [{ type: 'command', device: CONTROL, pattern: 'ansible-vault\\s+(view|encrypt_string)', label: 'Run ansible-vault view or encrypt_string' }] },
    ],
  },
];
