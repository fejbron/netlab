import { createSwitch } from '../../engine';
import type { Lab } from '../types';

/** The small branch-office topology most beginner labs share. */
export function office(hostname = 'Switch') {
  return createSwitch({
    hostname,
    ports: 4,
    neighbors: [
      { port: 'g0/1', name: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0' },
      { port: 'g0/2', name: 'PC-B', ip: '192.168.1.20', mask: '255.255.255.0' },
    ],
    interfaces: {
      'g0/1': { description: 'Admin PC' },
      'g0/2': { description: 'Test PC' },
      'g0/4': { shutdown: true },
    },
  });
}

const MODULE = 'meet-the-cli';

export const meetTheCliLabs: Lab[] = [
  {
    id: 'cli-01-first-contact',
    moduleId: MODULE,
    order: 1,
    title: 'First Contact',
    difficulty: 'Beginner',
    estimatedMinutes: 5,
    description: 'Connect to a new switch, enter privileged mode, and explore the command landscape.',
    scenario:
      'A brand-new switch just arrived on your desk. Before making any changes, your team lead asks you to connect to it, enter privileged mode, and take a quick look around.\n\nYou need to see what commands are available and find the command that lets you enter global configuration mode.',
    concepts: ['CLI prompts', 'Privileged EXEC mode', 'Built-in help'],
    hints: [
      'The prompt Switch> means user EXEC mode. Type enable to move to privileged mode; the prompt changes to Switch#.',
      'Type ? on its own to list every command available in the current mode.',
      'From Switch#, type configure terminal (or conf t) to enter global configuration mode.',
    ],
    createState: () => office(),
    objectives: [
      {
        id: 'enter-privileged',
        label: 'Enter privileged EXEC mode',
        checks: [
          { type: 'command', pattern: '^enable$', label: "Type 'enable'" },
          { type: 'mode', mode: 'privileged', label: 'Reach privileged mode (Switch#)' },
        ],
      },
      {
        id: 'explore-help',
        label: 'Explore the available commands',
        checks: [{ type: 'command', pattern: '^(\\?|help)$', label: "Type '?' or 'help' to see the command list" }],
      },
      {
        id: 'enter-config',
        label: 'Enter global configuration mode',
        checks: [
          { type: 'command', pattern: '^configure terminal$', label: "Type 'configure terminal'" },
          { type: 'mode', mode: 'config', label: 'Reach global configuration mode (Switch(config)#)' },
        ],
      },
    ],
  },
  {
    id: 'cli-02-give-it-a-name',
    moduleId: MODULE,
    order: 2,
    title: 'Give It a Name',
    difficulty: 'Beginner',
    estimatedMinutes: 5,
    description: 'Set the switch hostname and verify it in the running configuration.',
    scenario:
      'The new switch is being prepared for the branch office rack. Your company standard requires every device to carry a descriptive hostname so it can be identified from its prompt and from monitoring tools.\n\nName the switch Branch-SW1 and confirm the change in the running configuration.',
    concepts: ['hostname', 'Device identity', 'Running configuration'],
    hints: [
      'Hostnames are set in global configuration mode: enable, then configure terminal.',
      'Type hostname Branch-SW1. The prompt updates immediately.',
      'Use end to return to privileged mode, then show running-config to confirm the hostname line.',
    ],
    createState: () => office(),
    objectives: [
      {
        id: 'set-hostname',
        label: 'Set the hostname to Branch-SW1',
        checks: [
          { type: 'mode', mode: 'config', label: 'Enter global configuration mode' },
          { type: 'hostname', equals: 'Branch-SW1', label: 'Hostname is Branch-SW1' },
        ],
      },
      {
        id: 'verify',
        label: 'Verify with the running configuration',
        checks: [{ type: 'command', pattern: '^(do )?show running-config$', label: "Run 'show running-config'" }],
      },
    ],
  },
  {
    id: 'cli-03-learning-from-errors',
    moduleId: MODULE,
    order: 3,
    title: 'Learning From Errors',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: "Break the CLI on purpose: trigger the classic error messages, read the ^ marker, and use 'do' from config mode.",
    scenario:
      'Nobody learns the CLI without tripping over its error messages, so your mentor wants you to trip over them now, on a lab switch where mistakes cost nothing.\n\n1. The typo: in privileged mode type shwo running-config. Read where the ^ marker lands.\n2. The half-command: in configuration mode type hostname with nothing after it.\n3. The shortcut that is too short: in privileged mode type sh st and see why the switch refuses.\n4. The wrong room: from configuration mode, run a show command with the do prefix.',
    concepts: ['% Invalid input and the ^ marker', '% Incomplete command', '% Ambiguous command', 'do'],
    hints: [
      'In privileged mode type shwo running-config exactly like that, misspelled.',
      'In config mode type hostname and press Enter with nothing after it.',
      'Back in privileged mode type sh st. It matches both show startup-config and show spanning-tree.',
      'From Switch(config)#, type do show running-config.',
    ],
    createState: () => office(),
    objectives: [
      { id: 'invalid', label: 'Trigger % Invalid input', checks: [{ type: 'error-seen', error: 'invalid', label: "See the ^ marker under a word IOS doesn't know" }] },
      { id: 'incomplete', label: 'Trigger % Incomplete command', checks: [{ type: 'error-seen', error: 'incomplete', label: 'Press Enter on a command that needs more' }] },
      { id: 'ambiguous', label: 'Trigger % Ambiguous command', checks: [{ type: 'error-seen', error: 'ambiguous', label: 'Use a shortcut that matches several commands' }] },
      { id: 'do', label: "Run a show command from config mode with 'do'", checks: [{ type: 'command', pattern: '^do show ', label: "Type 'do show ...' from Switch(config)#" }] },
    ],
  },
  {
    id: 'cli-04-find-your-way-around',
    moduleId: MODULE,
    order: 4,
    title: 'Find Your Way Around',
    difficulty: 'Beginner',
    estimatedMinutes: 5,
    description: 'Practice moving between CLI modes without getting lost.',
    scenario:
      'You are shadowing a senior engineer who wants you to get comfortable with the CLI hierarchy. Move from user mode up through global configuration, drop into interface configuration for g0/1, then into VLAN 10 configuration, and jump straight back to privileged mode with a single command.',
    concepts: ['User EXEC', 'Privileged EXEC', 'Global configuration', 'Interface and VLAN submodes', 'exit vs end'],
    hints: [
      'enable, then configure terminal.',
      'From global config, type interface g0/1. The prompt becomes Switch(config-if)#.',
      'Type exit to return to global config, then vlan 10 to enter VLAN configuration mode.',
      'end jumps from any configuration submode straight back to Switch#.',
    ],
    createState: () => office(),
    objectives: [
      { id: 'priv', label: 'Reach privileged EXEC mode', checks: [{ type: 'mode', mode: 'privileged' }] },
      { id: 'config', label: 'Reach global configuration mode', checks: [{ type: 'mode', mode: 'config' }] },
      { id: 'iface', label: 'Enter interface configuration mode for g0/1', checks: [{ type: 'command', pattern: '^interface g(igabitethernet)?0/1$', label: "Type 'interface g0/1'" }, { type: 'mode', mode: 'interface', label: 'Reach Switch(config-if)#' }] },
      { id: 'vlan', label: 'Enter VLAN 10 configuration mode', checks: [{ type: 'mode', mode: 'vlan', label: 'Reach Switch(config-vlan)#' }] },
      { id: 'end', label: "Return to privileged mode with 'end'", checks: [{ type: 'command', pattern: '^end$' }] },
    ],
  },
  {
    id: 'cli-05-read-the-switch',
    moduleId: MODULE,
    order: 5,
    title: 'Read the Switch',
    difficulty: 'Beginner',
    estimatedMinutes: 5,
    description: 'Use show commands to inspect VLANs, interface status and the running configuration.',
    scenario:
      'A colleague configured a switch for the branch office but left before documenting it. Your job is to read the device without changing anything: which VLANs exist, which ports are up, and what the active configuration contains.',
    concepts: ['show vlan brief', 'show interfaces status', 'show running-config', 'show ip interface brief'],
    hints: [
      'Most show commands need privileged mode. Start with enable.',
      'show vlan brief lists VLANs and the ports assigned to each one.',
      'show interfaces status shows connected, notconnect and disabled ports.',
      'show ip interface brief is the quickest up/down summary for every interface.',
    ],
    createState: () =>
      createSwitch({
        hostname: 'Closet-SW2',
        ports: 6,
        vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
        neighbors: [
          { port: 'g0/1', name: 'Sales-PC', ip: '10.0.10.11', mask: '255.255.255.0' },
          { port: 'g0/2', name: 'HR-PC', ip: '10.0.20.11', mask: '255.255.255.0' },
          { port: 'g0/6', name: 'Core-SW', kind: 'switch' },
        ],
        interfaces: {
          'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales desk' },
          'g0/2': { mode: 'access', accessVlan: 20, description: 'HR desk' },
          'g0/3': { mode: 'access', accessVlan: 10 },
          'g0/5': { shutdown: true },
          'g0/6': { mode: 'trunk', description: 'Uplink to core' },
        },
      }),
    objectives: [
      { id: 'vlans', label: 'Inspect the VLAN table', checks: [{ type: 'command', pattern: '^(do )?show vlan( brief)?$' }] },
      { id: 'status', label: 'Inspect interface status', checks: [{ type: 'command', pattern: '^(do )?show interfaces status$' }] },
      { id: 'run', label: 'Read the running configuration', checks: [{ type: 'command', pattern: '^(do )?show running-config$' }] },
      { id: 'brief', label: 'Check the IP interface summary', checks: [{ type: 'command', pattern: '^(do )?show ip interface brief$' }] },
    ],
  },
  {
    id: 'cli-06-save-your-work',
    moduleId: MODULE,
    order: 6,
    title: 'Save Your Work',
    difficulty: 'Beginner',
    estimatedMinutes: 5,
    description: 'Learn the difference between running and startup configuration, then save your changes.',
    scenario:
      'You have spent the afternoon configuring a switch. A maintenance window tonight includes a power cycle. If you do not copy the running configuration to NVRAM, everything you did will be lost.\n\nSet the hostname to Floor2-SW1, look at the startup configuration before and after saving, and make sure the change survives a reboot.',
    concepts: ['Running configuration', 'Startup configuration', 'NVRAM', 'write memory'],
    hints: [
      'Set the hostname in global configuration mode, then return to privileged mode.',
      'show startup-config before saving reports that no startup config is present.',
      'write memory (or copy running-config startup-config) saves the running config to NVRAM.',
      'Run show startup-config again and confirm the hostname line is there.',
    ],
    createState: () => office(),
    objectives: [
      { id: 'hostname', label: 'Set the hostname to Floor2-SW1', checks: [{ type: 'hostname', equals: 'Floor2-SW1' }] },
      { id: 'inspect', label: 'Inspect the startup configuration', checks: [{ type: 'command', pattern: '^(do )?show startup-config$' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'command', pattern: '^(write( memory)?|copy running-config startup-config)$', label: "Run 'write memory' or 'copy running-config startup-config'" }, { type: 'saved', label: 'Startup config matches the running config' }] },
    ],
  },
  {
    id: 'cli-07-lock-the-door',
    moduleId: MODULE,
    order: 7,
    title: 'Lock the Door',
    difficulty: 'Beginner',
    estimatedMinutes: 7,
    description: 'Set an enable secret and configure passwords on the console and VTY lines.',
    scenario:
      'The branch office switch is about to be moved into the server room. Before it goes live you need basic protection: an enable secret of cisco123, a console password of conpass, and a VTY password of vtypass, with login enabled on both lines.\n\nVerify the result in the running configuration.',
    concepts: ['enable secret', 'line console 0', 'line vty 0 4', 'password and login'],
    hints: [
      'enable secret cisco123 is a global configuration command.',
      'line console 0, then password conpass, then login.',
      'line vty 0 4, then password vtypass, then login.',
      'end, then show running-config to verify all three settings.',
    ],
    createState: () => office('Branch-SW1'),
    objectives: [
      { id: 'secret', label: 'Set the enable secret', checks: [{ type: 'enable-secret', equals: 'cisco123', label: 'Enable secret is cisco123' }] },
      { id: 'console', label: 'Secure the console line', checks: [{ type: 'line', line: 'con', password: 'conpass', label: 'Console password is conpass' }, { type: 'line', line: 'con', login: true, label: 'Console login is enabled' }] },
      { id: 'vty', label: 'Secure the VTY lines', checks: [{ type: 'line', line: 'vty', password: 'vtypass', label: 'VTY password is vtypass' }, { type: 'line', line: 'vty', login: true, label: 'VTY login is enabled' }] },
      { id: 'verify', label: 'Verify in the running configuration', checks: [{ type: 'command', pattern: '^(do )?show running-config$' }] },
    ],
  },
  {
    id: 'cli-08-who-gets-in',
    moduleId: MODULE,
    order: 8,
    title: 'Who Gets In',
    difficulty: 'Beginner',
    estimatedMinutes: 7,
    description: 'Create a local user account and switch the VTY lines to per-user authentication.',
    scenario:
      'Shared passwords are a security risk. Your security team now requires every administrator to log in with their own account. Create a user named admin with privilege level 15 and the secret Adm1n-Lab, make the VTY lines use the local user database, restrict remote access to SSH, and save the configuration.',
    concepts: ['username ... privilege 15 secret', 'login local', 'transport input ssh', 'Saving'],
    hints: [
      'username admin privilege 15 secret Adm1n-Lab in global configuration mode.',
      'line vty 0 4, then login local replaces the shared line password.',
      'Still in line mode, transport input ssh disables Telnet.',
      'Finish with end and write memory.',
    ],
    createState: () => office('Branch-SW1'),
    objectives: [
      { id: 'user', label: 'Create the admin account', checks: [{ type: 'user', username: 'admin', privilege: 15, secret: true, label: 'admin exists with privilege 15 and a secret' }] },
      { id: 'local', label: 'Use local authentication on VTY lines', checks: [{ type: 'line', line: 'vty', login: 'local', label: 'VTY lines use login local' }] },
      { id: 'ssh', label: 'Allow SSH only on VTY lines', checks: [{ type: 'line', line: 'vty', transportInput: 'ssh', label: 'VTY transport input is ssh' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
  {
    id: 'cli-09-exam-first-switch',
    moduleId: MODULE,
    order: 9,
    title: 'Exam: Configure Your First Switch',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    isExam: true,
    description: 'Combine everything from Meet the CLI into one complete baseline configuration.',
    scenario:
      'This is your first solo assignment. A new switch for the remote office is in factory-default state. Build the baseline:\n\n- Hostname Remote-SW1\n- A message-of-the-day banner that contains the word Authorized\n- Enable secret R3mote!\n- Console password c0nsole with login\n- A local user netadmin, privilege 15, secret N3t-adm1n, and VTY lines that use login local\n- Save the configuration so it survives a reboot\n\nNo hints are available. Use what you practised in the previous labs.',
    concepts: ['Synthesis', 'Baseline configuration'],
    hints: [],
    createState: () => office(),
    objectives: [
      { id: 'identity', label: 'Set device identity', checks: [{ type: 'hostname', equals: 'Remote-SW1' }, { type: 'banner', contains: 'Authorized', label: 'MOTD banner contains Authorized' }] },
      { id: 'secret', label: 'Protect privileged mode', checks: [{ type: 'enable-secret', equals: 'R3mote!' }] },
      { id: 'console', label: 'Secure the console', checks: [{ type: 'line', line: 'con', password: 'c0nsole', login: true, label: 'Console password c0nsole with login' }] },
      { id: 'remote', label: 'Secure remote access', checks: [{ type: 'user', username: 'netadmin', privilege: 15, secret: true }, { type: 'line', line: 'vty', login: 'local', label: 'VTY lines use login local' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
];
