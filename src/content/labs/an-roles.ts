import type { Lab } from '../types';
import { anSite, CONTROL } from './an-site';

const MODULE = 'an-roles';

/** The unstructured playbook the first lab refactors into a role. */
const MONOLITH = `---
- name: Set up the web servers
  hosts: web
  become: true
  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present

    - name: Render the server block
      ansible.builtin.template:
        src: templates/site.conf.j2
        dest: /etc/nginx/conf.d/site.conf
        mode: '0644'
      notify: restart nginx

    - name: Publish the landing page
      ansible.builtin.copy:
        content: "Welcome to {{ inventory_hostname }}\\n"
        dest: /var/www/html/index.html
        mode: '0644'

    - name: Start and enable nginx
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: restart nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
`;

const SITE_TEMPLATE = `server {
    listen {{ web_port }};
    server_name {{ ansible_fqdn }};
    root {{ web_root }};
    index index.html;
}
`;

export const anRolesLabs: Lab[] = [
  {
    id: 'an-19-first-role',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Role',
    difficulty: 'Advanced',
    estimatedMinutes: 22,
    description: 'Turn a working playbook into a role with defaults, templates and handlers, and leave the playbook three lines long.',
    scenario:
      'site.yml works, and it is already too long. A role is the unit of reuse: a directory with a fixed layout, so that anyone who opens it knows where the tasks, the defaults, the files and the handlers are.\n\nMake the skeleton with ansible-galaxy init roles/webserver and look at what it created. The directories that matter today are tasks/ (what to do), defaults/ (values a user of the role may override), templates/ and files/ (things to deliver), and handlers/.\n\nMove the work across. tasks/main.yml gets the four tasks, without the play wrapper and one indentation level shallower. handlers/main.yml gets the handler. templates/site.conf.j2 moves from the playbook directory into the role — and once it is there, the task can say src: site.conf.j2 with no path, because Ansible looks inside the role automatically. That search path is the whole reason for the layout.\n\ndefaults/main.yml gets web_port: 8080 and web_root: /var/www/html, so the values the template uses have somewhere sensible to come from.\n\nFinally, replace the body of site.yml with a roles: list naming webserver. Run it: the output now says "TASK [webserver : Install nginx]", which tells you which role each task came from. Run it again and confirm nothing changes.',
    concepts: ['Role directory layout', 'ansible-galaxy init', 'defaults versus vars', 'Automatic search of templates/ and files/', 'roles: in a play'],
    hints: [
      'ansible-galaxy init roles/webserver',
      'mv templates/site.conf.j2 roles/webserver/templates/',
      'In a role, src: site.conf.j2 with no directory is enough.',
      'site.yml becomes a play with hosts:, become: and roles: - webserver.',
    ],
    createState: () => anSite({ files: { 'site.yml': MONOLITH, 'templates/site.conf.j2': SITE_TEMPLATE, 'group_vars/web.yml': '---\nweb_port: 8080\nweb_root: /var/www/html\n' } }),
    objectives: [
      {
        id: 'skeleton',
        label: 'Create the role skeleton',
        checks: [{ type: 'an-role', name: 'webserver', files: ['tasks/main.yml', 'defaults/main.yml', 'handlers/main.yml'] }],
      },
      {
        id: 'move',
        label: 'Move the work into the role',
        checks: [
          { type: 'an-source', path: 'roles/webserver/tasks/main.yml', pattern: 'ansible\\.builtin\\.package', label: 'The role installs nginx' },
          { type: 'an-source', path: 'roles/webserver/handlers/main.yml', pattern: 'restart nginx', label: 'The handler moved into the role' },
          { type: 'file', device: CONTROL, path: '/home/student/ansible/roles/webserver/templates/site.conf.j2', contains: 'listen' },
          { type: 'an-source', path: 'roles/webserver/defaults/main.yml', pattern: 'web_port', label: 'The role has a default for web_port' },
        ],
      },
      {
        id: 'play',
        label: 'Leave the playbook to name the role',
        checks: [
          { type: 'an-source', path: 'site.yml', pattern: 'roles:', label: 'site.yml uses roles:' },
          { type: 'an-source', path: 'site.yml', pattern: 'ansible\\.builtin\\.package', absent: true, label: 'The tasks are no longer in site.yml' },
          { type: 'an-task', task: 'Install nginx', status: 'changed', label: 'The role task ran' },
        ],
      },
      {
        id: 'result',
        label: 'The servers are still configured',
        checks: [
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8080' },
          { type: 'service', device: 'web2', name: 'nginx', active: true, enabled: true },
          { type: 'an-idempotent', playbook: 'site.yml' },
        ],
      },
    ],
  },
  {
    id: 'an-20-reuse-a-role',
    moduleId: MODULE,
    order: 2,
    title: 'Reuse and Parameters',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Run the same role twice with different values, and add a second role that every host gets.',
    scenario:
      'A role earns its keep the second time you use it. The webserver role from the last lab has defaults; now override them per play and prove the role did not need changing.\n\nWrite two plays in site.yml. The first runs webserver against web1 with web_port: 8080. The second runs it against web2 with web_port: 8081 and web_root: /srv/site — and a task in the role has to create that directory, because the role should stand on its own. Add a file task at the top of the role that creates {{ web_root }} with state: directory.\n\nThen write a second role, baseline, that every machine gets: install chrony, start and enable it, and drop a /etc/motd naming the host. Add it to both plays, and to a third play over db1, ahead of anything else. A role listed in roles: runs before the play tasks, which is usually what you want for a baseline.\n\nRun it and read the task names: the role prefix tells you exactly which role each task belongs to. Run it again and confirm every host is quiet — two roles, three plays, still idempotent.',
    concepts: ['Role parameters', 'Running one role with different values', 'Roles run before tasks', 'A role that stands on its own'],
    hints: [
      'A parameterised role entry is a mapping:\n  roles:\n    - role: webserver\n      web_port: 8081',
      'ansible-galaxy init roles/baseline',
      'The role must create web_root itself, or the template task fails on web2.',
      'Run the play twice and compare the recaps.',
    ],
    createState: () =>
      anSite({
        files: { 'templates/site.conf.j2': SITE_TEMPLATE },
        prepare: ['ansible-galaxy init roles/webserver'],
      }),
    objectives: [
      {
        id: 'roles',
        label: 'Build the two roles',
        checks: [
          { type: 'an-role', name: 'webserver', files: ['tasks/main.yml', 'defaults/main.yml', 'templates/site.conf.j2'] },
          { type: 'an-role', name: 'baseline', files: ['tasks/main.yml'] },
        ],
      },
      {
        id: 'params',
        label: 'Run the web role with different values',
        checks: [
          { type: 'file', device: 'web1', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8080' },
          { type: 'file', device: 'web2', path: '/etc/nginx/conf.d/site.conf', contains: 'listen 8081' },
          { type: 'file', device: 'web2', path: '/srv/site', kind: 'dir' },
        ],
      },
      {
        id: 'baseline',
        label: 'Give every host the baseline',
        checks: [
          { type: 'service', device: 'db1', name: 'chrony', active: true, enabled: true },
          { type: 'file', device: 'db1', path: '/etc/motd', contains: 'db1' },
          { type: 'file', device: 'web1', path: '/etc/motd', contains: 'web1' },
        ],
      },
      { id: 'again', label: 'Everything settles on a second run', checks: [{ type: 'an-idempotent', playbook: 'site.yml' }] },
    ],
  },
  {
    id: 'an-21-galaxy',
    moduleId: MODULE,
    order: 3,
    title: 'Roles and Collections from Galaxy',
    difficulty: 'Advanced',
    estimatedMinutes: 18,
    description: 'Declare what your project depends on in requirements.yml, install it, and use somebody else’s role in your playbook.',
    scenario:
      'Most of what you need has been written. Ansible Galaxy distributes two kinds of content: roles, which are what you have been writing, and collections, which bundle modules, plugins and roles together under a namespace such as community.general.\n\nDo it the way a project should. Write requirements.yml listing one role, netlab.motd, and two collections, community.general and ansible.posix. Install the roles with ansible-galaxy role install -r requirements.yml and the collections with ansible-galaxy collection install -r requirements.yml — two commands, because they install to different places. Check both with ansible-galaxy role list and ansible-galaxy collection list.\n\nNow use them. Write site.yml with a play over all hosts that runs the netlab.motd role and passes it motd_owner: the platform team — a role you did not write, configured through its documented variable. Add a task that uses community.general.timezone or ansible.posix.sysctl only if you want to explore; the point is that the collection\'s modules are now resolvable.\n\nRead roles/netlab.motd (installed under ~/.ansible/roles) before you trust it. Somebody else\'s role runs as root on your fleet; reading defaults/main.yml and tasks/main.yml first is not paranoia, it is the job.',
    concepts: ['requirements.yml', 'Roles versus collections', 'ansible-galaxy role install and collection install', 'Where installed content lives', 'Reading a role before running it'],
    hints: [
      'requirements.yml can hold both, under roles: and collections: keys.',
      'ansible-galaxy role install -r requirements.yml',
      'ansible-galaxy collection install -r requirements.yml',
      'cat ~/.ansible/roles/netlab.motd/tasks/main.yml',
    ],
    createState: () => anSite(),
    objectives: [
      {
        id: 'requirements',
        label: 'Declare the dependencies',
        checks: [
          { type: 'an-yaml', path: 'requirements.yml' },
          { type: 'an-source', path: 'requirements.yml', pattern: 'netlab\\.motd', label: 'requirements.yml names the netlab.motd role' },
          { type: 'an-source', path: 'requirements.yml', pattern: 'community\\.general', label: 'requirements.yml names the community.general collection' },
        ],
      },
      {
        id: 'install',
        label: 'Install them',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/.ansible/roles/netlab.motd/tasks/main.yml', exists: true },
          { type: 'an-collection', name: 'community.general' },
          { type: 'an-collection', name: 'ansible.posix' },
        ],
      },
      {
        id: 'use',
        label: 'Use the role you did not write',
        checks: [
          { type: 'an-ran', playbook: 'site.yml', code: 0 },
          { type: 'file', device: 'web1', path: '/etc/motd', contains: 'the platform team' },
          { type: 'file', device: 'db1', path: '/etc/motd', contains: 'Welcome to db1' },
        ],
      },
      { id: 'read', label: 'Read it before you trust it', checks: [{ type: 'command', device: CONTROL, pattern: '(cat|less|more|head)\\s+.*netlab\\.motd', label: 'Read the installed role' }] },
    ],
  },
];
