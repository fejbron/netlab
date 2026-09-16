import type { Lab } from '../types';
import { anSite, CONTROL, INVENTORY } from './an-site';

const MODULE = 'an-network';

/** The fleet inventory plus the two Cisco devices, for the labs that start with it ready. */
const NET_INVENTORY = `${INVENTORY}
[network]
R1
SW1

[network:vars]
ansible_connection=network_cli
ansible_network_os=cisco.ios.ios
ansible_user=netops
ansible_password=Aut0mate!
ansible_become=true
ansible_become_method=enable
`;

export const anNetworkLabs: Lab[] = [
  {
    id: 'an-22-reach-a-device',
    moduleId: MODULE,
    order: 1,
    title: 'Ansible Meets the Network',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Add a router and a switch to the inventory, install the cisco.ios collection, and read their facts.',
    scenario:
      'Everything so far has been Linux. This module is deliberately outside RHCE: automating network devices is not on EX294, and it is why a large number of people learn Ansible at all.\n\nA network device has no Python, so Ansible cannot copy a module to it and run it there. Instead it uses a different connection plugin, network_cli, which logs in over SSH and types commands the way you would, and the modules run on the control node. That single difference explains the variables you are about to set.\n\nAdd a [network] group to inventory.ini containing R1 and SW1, and a [network:vars] section with ansible_connection=network_cli, ansible_network_os=cisco.ios.ios, ansible_user=netops, ansible_password=Aut0mate!, ansible_become=true and ansible_become_method=enable. The credentials are the ones the devices already have.\n\nThe modules live in a collection that is not installed: ansible-galaxy collection install cisco.ios. Try a play without it first and read the error — "couldn\'t resolve module/action" almost always means a missing collection rather than a typo.\n\nThen write net-facts.yml: a play over the network group with gather_facts: false (the Linux fact gathering makes no sense here), running cisco.ios.ios_facts and then cisco.ios.ios_command with "show ip interface brief", registering the result and printing stdout_lines with debug. Run it with -v and read what came back from each device.',
    concepts: ['network_cli versus the default connection', 'Modules run on the control node', 'ansible_network_os', 'become_method: enable', 'ios_facts and ios_command'],
    hints: [
      '[network:vars] holds one key=value per line, like any other group vars section.',
      'ansible-galaxy collection install cisco.ios',
      'gather_facts: false — the setup module needs Python on the target.',
      'debug: var: out.stdout_lines',
    ],
    createState: () => anSite({ inventory: `${INVENTORY}\n[network]\nR1\nSW1\n` }),
    objectives: [
      {
        id: 'inventory',
        label: 'Describe the devices in the inventory',
        checks: [
          { type: 'an-inventory', host: 'R1', group: 'network', vars: { ansible_connection: 'network_cli', ansible_network_os: 'cisco.ios.ios' } },
          { type: 'an-inventory', host: 'SW1', group: 'network', vars: { ansible_user: 'netops' } },
        ],
      },
      { id: 'collection', label: 'Install the cisco.ios collection', checks: [{ type: 'an-collection', name: 'cisco.ios' }] },
      {
        id: 'facts',
        label: 'Gather facts from both devices',
        checks: [
          { type: 'an-ran', playbook: 'net-facts.yml', code: 0 },
          { type: 'an-task', task: 'Gather the device facts', host: 'R1', status: 'ok' },
          { type: 'an-task', task: 'Gather the device facts', host: 'SW1', status: 'ok' },
        ],
      },
      {
        id: 'command',
        label: 'Run a show command and print it',
        checks: [
          { type: 'an-source', path: 'net-facts.yml', pattern: 'ios_command', label: 'The play uses ios_command' },
          { type: 'an-source', path: 'net-facts.yml', pattern: 'register:', label: 'The output is registered' },
        ],
      },
    ],
  },
  {
    id: 'an-23-configure-a-device',
    moduleId: MODULE,
    order: 2,
    title: 'Configure a Device, Twice',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Push configuration to a router and a switch with ios_config, save it, and prove the second run changes nothing.',
    scenario:
      'ios_config is the workhorse. You give it lines, optionally inside a parents section, and it works out whether the running configuration already says that. Idempotency on a network device is not a nicety: a play that reconfigures an interface every night is a play that will eventually drop a link.\n\nWrite net-config.yml over the network group, with gather_facts: false. Set a description on R1\'s GigabitEthernet0/1 and SW1\'s GigabitEthernet0/8 using lines: and parents: — parents names the section to enter, exactly as you would type "interface GigabitEthernet0/1" first.\n\nAdd two more tasks that apply to both devices: a logging host of 192.168.1.20, and an NTP server of the same address. These are global commands, so they need no parents.\n\nFinish with save_when: modified on the tasks, so the running configuration is copied to startup only when something actually changed. Run the play, then run it again and confirm changed=0 on both devices.\n\nProve it from the other side too: open the R1 tab and run show running-config. The lines are there, applied by the same parser that reads what you type by hand — the device does not know or care that Ansible sent them.',
    concepts: ['ios_config lines and parents', 'Idempotency on network devices', 'save_when', 'The same configuration, typed or automated'],
    hints: [
      'parents: interface GigabitEthernet0/1',
      'lines: is a list, one command per entry.',
      'save_when: modified copies running-config to startup-config only when changed.',
      'Run the play twice, then check with show running-config on R1.',
    ],
    createState: () => anSite({ inventory: NET_INVENTORY, prepare: ['ansible-galaxy collection install cisco.ios'] }),
    objectives: [
      {
        id: 'interfaces',
        label: 'Describe the uplinks',
        checks: [
          { type: 'an-ran', playbook: 'net-config.yml', code: 0 },
          { type: 'interface', device: 'R1', name: 'g0/1', description: 'Link to the branch office' },
          { type: 'interface', device: 'SW1', name: 'g0/8', description: 'Uplink to R1' },
        ],
      },
      {
        id: 'global',
        label: 'Set logging and NTP on both',
        checks: [
          { type: 'syslog', device: 'R1', host: '192.168.1.20' },
          { type: 'syslog', device: 'SW1', host: '192.168.1.20' },
          { type: 'ntp-server', device: 'R1', address: '192.168.1.20' },
          { type: 'ntp-server', device: 'SW1', address: '192.168.1.20' },
        ],
      },
      {
        id: 'saved',
        label: 'Save the configuration',
        checks: [
          { type: 'saved', device: 'R1', label: 'R1 copied the running configuration to startup-config' },
          { type: 'saved', device: 'SW1', label: 'SW1 copied the running configuration to startup-config' },
        ],
      },
      { id: 'again', label: 'A second run changes nothing', checks: [{ type: 'an-idempotent', playbook: 'net-config.yml' }] },
    ],
  },
  {
    id: 'an-24-templated-network-config',
    moduleId: MODULE,
    order: 3,
    title: 'One Template, Every Device',
    difficulty: 'Advanced',
    estimatedMinutes: 22,
    description: 'Describe each device as data, render one template into its configuration, and push it with ios_config.',
    scenario:
      'Writing a task per command stops scaling at about the third device. The pattern that does scale is the one the Linux labs used for nginx: describe the intent as variables, render one template, and let a module apply it.\n\nDescribe the devices as data. In host_vars/R1.yml and host_vars/SW1.yml, give each a banner_text, a list of snmp_communities, and a syslog_host. Keep the shape identical so one template can read both.\n\nWrite templates/base.cfg.j2 rendering a flat list of IOS commands: a banner line, a "snmp-server community <name> ro" line for each community from a {% for %} loop, and a logging host line. Flat means no indentation and no sections — every line applies globally.\n\nThen write net-template.yml over the network group with gather_facts: false, using cisco.ios.ios_config with src: base.cfg.j2. The module renders the template with that host\'s variables, compares the result with the running configuration, and sends only what is missing — which is why the second run reports nothing to do.\n\nRun it, check show running-config on both devices, and run it once more. One template, two very different devices, and a play that is safe to schedule.',
    concepts: ['Intent as data in host_vars', 'One template for many devices', 'ios_config with src', 'Rendering happens on the control node'],
    hints: [
      'mkdir -p host_vars templates',
      'Keep the variable names identical in both host_vars files.',
      '{% for c in snmp_communities %}snmp-server community {{ c }} ro\n{% endfor %}',
      'ios_config: src: base.cfg.j2 — no lines: needed.',
    ],
    createState: () => anSite({ inventory: NET_INVENTORY, prepare: ['ansible-galaxy collection install cisco.ios'] }),
    objectives: [
      {
        id: 'data',
        label: 'Describe both devices as data',
        checks: [
          { type: 'an-yaml', path: 'host_vars/R1.yml' },
          { type: 'an-yaml', path: 'host_vars/SW1.yml' },
          { type: 'an-inventory', host: 'R1', vars: { syslog_host: '192.168.1.20' } },
        ],
      },
      {
        id: 'template',
        label: 'Write one template for both',
        checks: [
          { type: 'file', device: CONTROL, path: '/home/student/ansible/templates/base.cfg.j2', contains: 'snmp-server community' },
          { type: 'an-source', path: 'templates/base.cfg.j2', pattern: '\\{%\\s*for\\b', label: 'The template loops over the communities' },
        ],
      },
      {
        id: 'apply',
        label: 'Push it to both devices',
        checks: [
          { type: 'an-ran', playbook: 'net-template.yml', code: 0 },
          { type: 'snmp-community', device: 'R1', name: 'NetOps-RO', mode: 'ro' },
          { type: 'snmp-community', device: 'SW1', name: 'NetOps-RO', mode: 'ro' },
          { type: 'syslog', device: 'SW1', host: '192.168.1.20' },
        ],
      },
      { id: 'again', label: 'The template is idempotent too', checks: [{ type: 'an-idempotent', playbook: 'net-template.yml' }] },
    ],
  },
];
