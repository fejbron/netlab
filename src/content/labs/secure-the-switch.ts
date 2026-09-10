import { createSwitch } from '../../engine';
import type { Lab } from '../types';
import { office } from './meet-the-cli';

const MODULE = 'secure-the-switch';

function accessSwitch(hostname = 'Access-SW1') {
  return createSwitch({
    hostname,
    ports: 8,
    neighbors: [
      { port: 'g0/1', name: 'Sales-PC', ip: '192.168.10.11', mask: '255.255.255.0' },
      { port: 'g0/2', name: 'HR-PC', ip: '192.168.20.11', mask: '255.255.255.0' },
      { port: 'g0/8', name: 'Core-SW', kind: 'switch' },
    ],
    interfaces: {
      'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales laptop' },
      'g0/2': { mode: 'access', accessVlan: 20, description: 'HR workstation' },
      'g0/8': { mode: 'trunk', description: 'Uplink to Core-SW' },
    },
    vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
  });
}

const UNUSED_PORTS = ['g0/3', 'g0/4', 'g0/5', 'g0/6', 'g0/7'];

export const secureTheSwitchLabs: Lab[] = [
  {
    id: 'sec-01-encrypt-the-passwords',
    moduleId: MODULE,
    order: 1,
    title: 'Encrypt the Passwords',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Replace a plain-text enable password with a secret and hide the remaining passwords in the config.',
    scenario:
      'An auditor ran show running-config on this switch and read every password in clear text. The enable password is cisco and the line passwords are just as visible.\n\nLog in with the existing enable password, configure an enable secret of S3cret!, turn on the password encryption service, then look at the running configuration again to see what changed.',
    concepts: ['enable secret vs enable password', 'service password-encryption', 'Type 5 and type 7 passwords'],
    hints: [
      'Type enable, then the current password cisco when prompted.',
      'enable secret S3cret! stores an irreversible hash. The old enable password stays but the secret wins.',
      'service password-encryption scrambles the line passwords (type 7) in the running config.',
      'end and show running-config: the secret shows as "5" and the line passwords as "7".',
    ],
    createState: () => {
      const s = office('Branch-SW1');
      s.enablePassword = 'cisco';
      s.lines.con = { password: 'conpass', login: true };
      s.lines.vty = { password: 'vtypass', login: true };
      return s;
    },
    objectives: [
      { id: 'login', label: 'Enter privileged mode with the existing password', checks: [{ type: 'mode', mode: 'privileged', label: 'Reach Branch-SW1#' }] },
      { id: 'secret', label: 'Configure the enable secret', checks: [{ type: 'enable-secret', equals: 'S3cret!', label: 'Enable secret is S3cret!' }] },
      { id: 'encrypt', label: 'Turn on password encryption', checks: [{ type: 'password-encryption' }] },
      { id: 'verify', label: 'Inspect the result', checks: [{ type: 'command', pattern: '^(do )?show running-config$' }] },
    ],
  },
  {
    id: 'sec-02-remote-access-ssh',
    moduleId: MODULE,
    order: 2,
    title: 'Remote Access With SSH',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Turn a console-only switch into one you can administer securely over the network.',
    scenario:
      'The branch switch can only be managed from the console port in the closet. Build the SSH stack so the team can reach it remotely:\n\n- Domain name lab.local\n- RSA keys of at least 2048 bits\n- SSH version 2 only\n- Local user netadmin, privilege 15, secret N3t-adm1n\n- VTY lines that use the local database and accept SSH only\n\nFinish by checking the SSH status.',
    concepts: ['ip domain-name', 'crypto key generate rsa', 'ip ssh version 2', 'login local', 'transport input ssh'],
    hints: [
      'RSA keys need a hostname and a domain name first: ip domain-name lab.local.',
      'crypto key generate rsa modulus 2048 creates the key pair.',
      'ip ssh version 2 restricts the switch to SSHv2.',
      'username netadmin privilege 15 secret N3t-adm1n, then line vty 0 4, login local, transport input ssh.',
      'end and show ip ssh should say SSH Enabled - version 2.0.',
    ],
    createState: () => office('Branch-SW1'),
    objectives: [
      { id: 'domain', label: 'Set the domain name', checks: [{ type: 'domain-name', equals: 'lab.local', label: 'Domain name is lab.local' }] },
      { id: 'keys', label: 'Generate RSA keys', checks: [{ type: 'ssh-ready' }] },
      { id: 'v2', label: 'Require SSH version 2', checks: [{ type: 'command', pattern: '^ip ssh version 2$' }] },
      { id: 'user', label: 'Create the netadmin account', checks: [{ type: 'user', username: 'netadmin', privilege: 15, secret: true, label: 'netadmin exists with privilege 15 and a secret' }] },
      { id: 'vty', label: 'Lock the VTY lines to SSH with local login', checks: [{ type: 'line', line: 'vty', login: 'local', label: 'VTY lines use login local' }, { type: 'line', line: 'vty', transportInput: 'ssh', label: 'VTY transport input is ssh' }] },
      { id: 'verify', label: 'Check SSH status', checks: [{ type: 'command', pattern: '^(do )?show ip ssh$' }] },
    ],
  },
  {
    id: 'sec-03-park-unused-ports',
    moduleId: MODULE,
    order: 3,
    title: 'Park the Unused Ports',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Move every unused port into a parking VLAN and shut it down, using interface range to do it in one pass.',
    scenario:
      'Anyone who walks into the closet can plug a laptop into an empty port and land in VLAN 1. The hardening standard says unused ports must be shut down and assigned to VLAN 999 named UNUSED.\n\nPorts g0/3 through g0/7 are free. Use interface range so you configure all five at once, then verify with show interfaces status.',
    concepts: ['interface range', 'Parking VLAN', 'shutdown', 'Access-layer hardening'],
    hints: [
      'Create the parking VLAN first: vlan 999, name UNUSED.',
      'interface range g0/3 - 7 selects all five ports. The prompt becomes (config-if-range)#.',
      'switchport mode access, switchport access vlan 999, then shutdown apply to every port in the range.',
      'end and show interfaces status: the five ports show disabled with VLAN 999.',
    ],
    createState: () => accessSwitch(),
    objectives: [
      { id: 'vlan', label: 'Create VLAN 999 named UNUSED', checks: [{ type: 'vlan-exists', id: 999, name: 'UNUSED' }] },
      { id: 'park', label: 'Assign the unused ports to VLAN 999', checks: UNUSED_PORTS.map((p) => ({ type: 'interface' as const, name: p, mode: 'access' as const, accessVlan: 999, label: `${p} is an access port in VLAN 999` })) },
      { id: 'shut', label: 'Shut the unused ports down', checks: UNUSED_PORTS.map((p) => ({ type: 'interface' as const, name: p, shutdown: true, label: `${p} is shut down` })) },
      { id: 'keep', label: 'Leave the live ports alone', checks: [{ type: 'interface', name: 'g0/1', shutdown: false, accessVlan: 10, label: 'g0/1 still serves Sales' }, { type: 'interface', name: 'g0/8', shutdown: false, mode: 'trunk', label: 'g0/8 is still the trunk' }] },
      { id: 'verify', label: 'Verify with show interfaces status', checks: [{ type: 'command', pattern: '^(do )?show interfaces status$' }] },
    ],
  },
  {
    id: 'sec-04-exam-harden-the-switch',
    moduleId: MODULE,
    order: 4,
    title: 'Exam: Harden the Access Switch',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Apply the full hardening standard to a factory-default access switch.',
    scenario:
      'Apply the hardening standard to this switch:\n\n- Hostname Secure-SW1 and a MOTD banner containing the word Authorized\n- Enable secret H4rden! and password encryption turned on\n- Console password c0nsole with login\n- Local user admin, privilege 15, secret Adm1n-Sec; VTY lines use local login and accept SSH only\n- Domain lab.local, 2048-bit RSA keys, SSH version 2\n- Unused ports g0/3 through g0/7 shut down\n- Save the configuration\n\nNo hints are available.',
    concepts: ['Synthesis', 'Device hardening'],
    hints: [],
    createState: () => accessSwitch('Switch'),
    objectives: [
      { id: 'identity', label: 'Identity and banner', checks: [{ type: 'hostname', equals: 'Secure-SW1' }, { type: 'banner', contains: 'Authorized', label: 'MOTD banner contains Authorized' }] },
      { id: 'secrets', label: 'Privileged access', checks: [{ type: 'enable-secret', equals: 'H4rden!' }, { type: 'password-encryption' }] },
      { id: 'console', label: 'Console line', checks: [{ type: 'line', line: 'con', password: 'c0nsole', login: true, label: 'Console password c0nsole with login' }] },
      { id: 'remote', label: 'Remote access', checks: [{ type: 'user', username: 'admin', privilege: 15, secret: true }, { type: 'line', line: 'vty', login: 'local', transportInput: 'ssh', label: 'VTY lines use login local and SSH only' }] },
      { id: 'ssh', label: 'SSH stack', checks: [{ type: 'domain-name', equals: 'lab.local' }, { type: 'ssh-ready' }, { type: 'command', pattern: '^ip ssh version 2$' }] },
      { id: 'ports', label: 'Unused ports shut down', checks: UNUSED_PORTS.map((p) => ({ type: 'interface' as const, name: p, shutdown: true, label: `${p} is shut down` })) },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
];
