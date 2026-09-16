import { describe, expect, it } from 'vitest';
import { anSite, WORK } from '../content/labs/an-site';
import { executeHost, type NetworkState } from './index';
import { parseYaml } from './ansible/yaml';
import { condition, renderTemplate, template } from './ansible/jinja';
import { loadInventory, selectHosts } from './ansible/inventory';

/** Type lines on ops1 and return the new network plus everything printed. */
function run(net: NetworkState, ...lines: string[]): { net: NetworkState; out: string[] } {
  const out: string[] = [];
  let n = net;
  for (const line of lines) {
    const r = executeHost(n, 'ops1', line);
    out.push(...r.output);
    n = r.network;
  }
  return { net: n, out };
}

/** Write a file on ops1 without fighting shell quoting. */
function put(net: NetworkState, path: string, content: string): NetworkState {
  const lx = net.hosts.ops1.linux!;
  const full = path.startsWith('/') ? path : `${WORK}/${path}`;
  lx.fs[full] = { type: 'file', content, owner: 'student', group: 'student', mode: 0o644, mtime: 0 };
  return net;
}

describe('yaml', () => {
  it('parses a playbook, including block scalars and folded when:', () => {
    const doc = parseYaml(
      [
        '---',
        '- name: Configure web servers',
        '  hosts: web',
        '  become: true',
        '  vars:',
        '    packages: [nginx, curl]',
        '    motd: |',
        '      Hello',
        '      There',
        '  tasks:',
        '    - name: Install packages',
        '      ansible.builtin.package:',
        '        name: "{{ packages }}"',
        '        state: present',
        '      notify: restart nginx',
        '    - name: Long when',
        '      debug:',
        '        msg: hi',
        '      when: ansible_facts.os_family == "Debian"',
        '        and packages | length > 1',
      ].join('\n'),
    ) as any;
    expect(doc[0].hosts).toBe('web');
    expect(doc[0].vars.packages).toEqual(['nginx', 'curl']);
    expect(doc[0].vars.motd).toBe('Hello\nThere\n');
    expect(doc[0].tasks[1].when).toBe('ansible_facts.os_family == "Debian" and packages | length > 1');
  });

  it('reports the line of a syntax error', () => {
    expect(() => parseYaml(['- name: one', '  tasks:', '   - debug:', '        msg: a', '     bad'].join('\n'))).toThrow();
  });
});

describe('jinja', () => {
  const ctx = { vars: { packages: ['nginx', 'curl'], host: { name: 'web1', port: 80 } } as any };

  it('substitutes, filters and tests', () => {
    expect(template('{{ packages }}', ctx)).toEqual(['nginx', 'curl']);
    expect(template('server {{ host.name }}:{{ host.port }}', ctx)).toBe('server web1:80');
    expect(template("{{ nope | default('fallback') }}", ctx)).toBe('fallback');
    expect(template("{{ packages | join(', ') | upper }}", ctx)).toBe('NGINX, CURL');
    expect(condition('packages | length == 2 and host.name is defined', ctx)).toBe(true);
    expect(condition('host.missing is defined', ctx)).toBe(false);
  });

  it('renders loops and conditionals in a template file', () => {
    const tpl = ['{% for p in packages %}', 'name={{ p }} idx={{ loop.index }}', '{% endfor %}', '{% if host.port == 80 %}plain{% else %}tls{% endif %}'].join('\n');
    expect(renderTemplate(tpl, ctx)).toBe(['name=nginx idx=1', 'name=curl idx=2', 'plain'].join('\n'));
  });
});

describe('inventory', () => {
  it('reads groups, children and host patterns', () => {
    const net = anSite();
    const inv = loadInventory(net.hosts.ops1.linux!, `${WORK}/inventory.ini`, WORK);
    expect(selectHosts(inv, 'web')).toEqual(['web1', 'web2']);
    expect(selectHosts(inv, 'production')).toEqual(['web1', 'web2', 'db1']);
    expect(selectHosts(inv, 'all:!db')).toEqual(['web1', 'web2']);
    expect(selectHosts(inv, 'web*')).toEqual(['web1', 'web2']);
    expect(selectHosts(inv, 'production:&db')).toEqual(['db1']);
  });
});

describe('ad-hoc commands', () => {
  it('pings every managed node', () => {
    const { out } = run(anSite(), 'ansible all -m ping');
    expect(out.filter((l) => /SUCCESS =>/.test(l))).toHaveLength(3);
    expect(out.join('\n')).toContain('"ping": "pong"');
  });

  it('reports UNREACHABLE for a node that does not trust the key', () => {
    const { out } = run(anSite({ withoutKey: ['db1'] }), 'ansible all -m ping');
    expect(out.join('\n')).toMatch(/db1.*UNREACHABLE/);
    expect(out.join('\n')).toContain('Permission denied');
  });

  it('runs a command module and shows its output', () => {
    const { out } = run(anSite(), 'ansible web -a "hostname"');
    expect(out.join('\n')).toContain('web1 | CHANGED | rc=0 >>');
    expect(out).toContain('web2');
  });
});

describe('playbooks', () => {
  const PLAY = `---
- name: Set up the web servers
  hosts: web
  become: true
  vars:
    page: Hello from NetLab
  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present

    - name: Start nginx
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

    - name: Publish the page
      ansible.builtin.copy:
        content: "{{ page }}\\n"
        dest: /var/www/html/index.html
        owner: root
        mode: '0644'
`;

  it('runs, reports a recap, and is idempotent on a second run', () => {
    let net = put(anSite(), 'site.yml', PLAY);
    const first = run(net, 'ansible-playbook site.yml');
    net = first.net;
    expect(first.out.join('\n')).toContain('PLAY [Set up the web servers]');
    expect(first.out.join('\n')).toContain('TASK [Gathering Facts]');
    expect(first.out.join('\n')).toMatch(/changed: \[web1\]/);
    expect(first.out.join('\n')).toContain('PLAY RECAP');
    const recap = first.out.find((l) => l.startsWith('web1'))!;
    // Installing nginx starts and enables it, so the service task has nothing to do.
    expect(recap).toMatch(/ok=4\s+changed=2/);
    expect(recap).toMatch(/unreachable=0\s+failed=0/);

    const second = run(net, 'ansible-playbook site.yml');
    expect(second.out.find((l) => l.startsWith('web1'))!).toMatch(/ok=4\s+changed=0/);
    expect(second.out.join('\n')).not.toMatch(/changed: \[/);
  });

  it('really changed the managed nodes', () => {
    const net = put(anSite(), 'site.yml', PLAY);
    const after = run(net, 'ansible-playbook site.yml').net;
    const web1 = after.hosts.web1.linux!;
    expect(web1.packages).toContain('nginx');
    expect(web1.services.nginx?.active).toBe(true);
    expect(web1.fs['/var/www/html/index.html']?.content).toBe('Hello from NetLab\n');
    expect(after.hosts.db1.linux!.packages).not.toContain('nginx');
  });

  it('runs handlers once, at the end of the play', () => {
    const play = `---
- name: Handler demo
  hosts: web1
  become: true
  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present
      notify: restart nginx

    - name: Configure nginx
      ansible.builtin.copy:
        content: "# managed\\n"
        dest: /etc/nginx/conf.d/lab.conf
      notify: restart nginx

  handlers:
    - name: restart nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
`;
    const { out } = run(put(anSite(), 'handlers.yml', play), 'ansible-playbook handlers.yml');
    const text = out.join('\n');
    expect(text).toContain('RUNNING HANDLER [restart nginx]');
    expect(text.match(/RUNNING HANDLER \[restart nginx\]/g)).toHaveLength(1);
    expect(text.indexOf('RUNNING HANDLER')).toBeGreaterThan(text.indexOf('TASK [Configure nginx]'));
  });

  it('check mode changes nothing, and hits the limitation real check mode has', () => {
    const net = put(anSite(), 'site.yml', PLAY);
    const r = run(net, 'ansible-playbook site.yml --check');
    expect(r.out.join('\n')).toMatch(/changed: \[web1\]/);
    // The package was never really installed, so the service task cannot find it: the
    // same thing --check does on a real host that has not been built yet.
    expect(r.out.join('\n')).toContain('Could not find the requested service nginx');
    expect(r.net.hosts.web1.linux!.packages).not.toContain('nginx');
    expect(r.net.hosts.web1.linux!.fs['/var/www/html/index.html']).toBeUndefined();
  });

  it('check mode on a host that is already built reports no changes', () => {
    const net = put(anSite(), 'site.yml', PLAY);
    const built = run(net, 'ansible-playbook site.yml').net;
    const r = run(built, 'ansible-playbook site.yml --check');
    expect(r.out.find((l) => l.startsWith('web1'))!).toMatch(/changed=0\s+unreachable=0\s+failed=0/);
  });

  it('stops the play for a host whose task failed', () => {
    const play = `---
- name: Failure demo
  hosts: web
  tasks:
    - name: Read a file that is not there
      ansible.builtin.command: cat /etc/nope.conf

    - name: Never reached
      ansible.builtin.debug:
        msg: unreachable code
`;
    const { out } = run(put(anSite(), 'fail.yml', play), 'ansible-playbook fail.yml');
    const text = out.join('\n');
    expect(text).toMatch(/fatal: \[web1\]: FAILED!/);
    expect(text).not.toContain('unreachable code');
    expect(out.find((l) => l.startsWith('web1'))!).toMatch(/failed=1/);
  });

  it('reports a YAML error with the file and line, and runs nothing', () => {
    const { out, net } = run(put(anSite(), 'broken.yml', '---\n- hosts: web\n  tasks:\n   - name: bad\n     debug:\n    msg: oops\n'), 'ansible-playbook broken.yml');
    expect(out.join('\n')).toMatch(/ERROR!/);
    expect(out.join('\n')).toContain('broken.yml');
    expect(net.hosts.ops1.linux!.ansibleRuns ?? []).toHaveLength(0);
  });
});

describe('variables and facts', () => {
  it('gathers facts from the real host state', () => {
    const { out } = run(anSite(), 'ansible web1 -m setup -a "filter=ansible_hostname"');
    expect(out.join('\n')).toContain('"ansible_hostname": "web1"');
  });

  it('takes group_vars and host_vars into account, host_vars winning', () => {
    let net = anSite();
    net = put(net, 'group_vars/web.yml', 'greeting: from the group\nport: 80\n');
    net = put(net, 'host_vars/web2.yml', 'greeting: from the host\n');
    net = put(net, 'vars.yml', '---\n- hosts: web\n  tasks:\n    - debug:\n        msg: "{{ greeting }} on {{ port }}"\n');
    const { out } = run(net, 'ansible-playbook vars.yml');
    expect(out.join('\n')).toContain('"msg": "from the group on 80"');
    expect(out.join('\n')).toContain('"msg": "from the host on 80"');
  });

  it('-e beats everything else', () => {
    let net = anSite();
    net = put(net, 'group_vars/web.yml', 'greeting: group\n');
    net = put(net, 'vars.yml', '---\n- hosts: web1\n  vars:\n    greeting: play\n  tasks:\n    - debug:\n        msg: "{{ greeting }}"\n');
    const { out } = run(net, 'ansible-playbook vars.yml -e greeting=extra');
    expect(out.join('\n')).toContain('"msg": "extra"');
  });
});

describe('templates and vault', () => {
  it('renders a template onto the managed node', () => {
    let net = anSite();
    net = put(net, 'templates/motd.j2', 'Welcome to {{ ansible_facts.hostname }} ({{ ansible_facts.default_ipv4.address }})\n');
    net = put(net, 'motd.yml', '---\n- hosts: web1\n  become: true\n  tasks:\n    - ansible.builtin.template:\n        src: templates/motd.j2\n        dest: /etc/motd\n');
    const after = run(net, 'ansible-playbook motd.yml').net;
    expect(after.hosts.web1.linux!.fs['/etc/motd']?.content).toBe('Welcome to web1 (192.168.1.51)\n');
  });

  it('encrypts a file, refuses to run without the password, and decrypts it in the play', () => {
    let net = put(anSite(), 'secrets.yml', 'db_password: s3cret\n');
    net = put(net, 'vaultpass', 'openthedoor\n');
    net = put(net, 'show.yml', '---\n- hosts: web1\n  vars_files:\n    - secrets.yml\n  tasks:\n    - debug:\n        msg: "{{ db_password }}"\n');
    const enc = run(net, 'ansible-vault encrypt secrets.yml --vault-password-file vaultpass');
    net = enc.net;
    expect(enc.out.join('\n')).toContain('Encryption successful');
    expect(net.hosts.ops1.linux!.fs[`${WORK}/secrets.yml`]?.content).toMatch(/^\$ANSIBLE_VAULT;1\.1;AES256/);

    const without = run(net, 'ansible-playbook show.yml');
    expect(without.out.join('\n')).toMatch(/ERROR!.*vault/i);

    const with_ = run(net, 'ansible-playbook show.yml --vault-password-file vaultpass');
    expect(with_.out.join('\n')).toContain('"msg": "s3cret"');
  });
});

describe('roles and collections', () => {
  it('creates a skeleton, runs the role, and lists it', () => {
    let net = run(anSite(), 'ansible-galaxy init roles/webserver').net;
    const lx = net.hosts.ops1.linux!;
    expect(lx.fs[`${WORK}/roles/webserver/tasks/main.yml`]).toBeTruthy();
    expect(lx.fs[`${WORK}/roles/webserver/defaults/main.yml`]).toBeTruthy();
    net = put(net, 'roles/webserver/defaults/main.yml', '---\nweb_root: /srv/www\n');
    net = put(
      net,
      'roles/webserver/tasks/main.yml',
      '---\n- name: Make the web root\n  ansible.builtin.file:\n    path: "{{ web_root }}"\n    state: directory\n\n- name: Publish\n  ansible.builtin.copy:\n    content: "role page\\n"\n    dest: "{{ web_root }}/index.html"\n',
    );
    net = put(net, 'site.yml', '---\n- hosts: web1\n  become: true\n  roles:\n    - webserver\n');
    const r = run(net, 'ansible-playbook site.yml');
    expect(r.out.join('\n')).toContain('TASK [webserver : Publish]');
    expect(r.net.hosts.web1.linux!.fs['/srv/www/index.html']?.content).toBe('role page\n');
  });

  it('installs a collection from the simulated galaxy', () => {
    const r = run(anSite(), 'ansible-galaxy collection install community.general', 'ansible-galaxy collection list');
    expect(r.out.join('\n')).toContain('community.general');
  });
});

describe('network devices', () => {
  const INV = `[web]
web1

[routers]
R1 ansible_network_os=cisco.ios.ios ansible_user=netops ansible_password=Aut0mate! ansible_connection=network_cli
`;

  it('needs the collection installed before cisco.ios modules resolve', () => {
    let net = anSite({ inventory: INV });
    net = put(net, 'net.yml', '---\n- hosts: routers\n  gather_facts: false\n  tasks:\n    - cisco.ios.ios_facts:\n');
    expect(run(net, 'ansible-playbook net.yml').out.join('\n')).toContain("couldn't resolve module/action 'cisco.ios.ios_facts'");
    const r = run(net, 'ansible-galaxy collection install cisco.ios', 'ansible-playbook net.yml');
    expect(r.out.join('\n')).toMatch(/ok: \[R1\]/);
  });

  it('gathers facts and configures a Cisco device, idempotently', () => {
    let net = anSite({ inventory: INV, prepare: ['ansible-galaxy collection install cisco.ios'] });
    net = put(
      net,
      'net.yml',
      ['---', '- hosts: routers', '  gather_facts: false', '  tasks:', '    - cisco.ios.ios_config:', '        lines:', '          - description Uplink to the core', '        parents: interface GigabitEthernet0/1', ''].join('\n'),
    );
    const first = run(net, 'ansible-playbook net.yml');
    expect(first.out.join('\n')).toMatch(/changed: \[R1\]/);
    expect(first.net.devices.R1.interfaces['GigabitEthernet0/1'].description).toBe('Uplink to the core');
    const second = run(first.net, 'ansible-playbook net.yml');
    expect(second.out.find((l) => l.startsWith('R1'))!).toMatch(/changed=0/);
  });

  it('refuses config-mode commands in ios_command, like the real module', () => {
    let net = anSite({ inventory: INV, prepare: ['ansible-galaxy collection install cisco.ios'] });
    net = put(net, 'bad.yml', '---\n- hosts: routers\n  gather_facts: false\n  tasks:\n    - cisco.ios.ios_command:\n        commands:\n          - configure terminal\n');
    const { out } = run(net, 'ansible-playbook bad.yml');
    expect(out.join('\n')).toContain('Please use ios_config instead');
  });
});

describe('honesty about what is not simulated', () => {
  it('says so when a play reaches for a RHEL-only module', () => {
    const net = put(anSite(), 'rhel.yml', '---\n- hosts: web1\n  become: true\n  tasks:\n    - ansible.builtin.dnf:\n        name: httpd\n        state: present\n');
    const { out } = run(net, 'ansible-playbook rhel.yml');
    expect(out.join('\n')).toMatch(/dnf/);
    expect(out.join('\n')).toMatch(/Ubuntu|apt|package/);
  });
});

describe('ssh', () => {
  it('generates a key, copies it, and then logs in without a password', () => {
    const start = anSite({ noKeys: true });
    const a = run(start, 'ssh student@web1 hostname');
    expect(a.net.hosts.ops1.linux!.pending).toMatchObject({ kind: 'ssh', prompt: "student@web1's password: ", masked: true });
    const b = run(a.net, 'student');
    expect(b.out).toContain('web1');

    const c = run(b.net, "ssh-keygen -t rsa -N '' -f /home/student/.ssh/id_rsa -q", 'ssh-copy-id student@web1', 'student', 'ssh student@web1 hostname');
    expect(c.out.join('\n')).toContain('Number of key(s) added: 1');
    expect(c.out).toContain('web1');
    expect(c.out.join('\n')).not.toContain("student@web1's password:");
  });
});
