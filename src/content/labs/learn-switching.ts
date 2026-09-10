import { createSwitch } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-switching';

function department(hostname = 'Access-SW1') {
  return createSwitch({
    hostname,
    ports: 6,
    neighbors: [
      { port: 'g0/1', name: 'Sales-PC', ip: '192.168.10.11', mask: '255.255.255.0' },
      { port: 'g0/2', name: 'HR-PC', ip: '192.168.20.11', mask: '255.255.255.0' },
      { port: 'g0/6', name: 'Core-SW', kind: 'switch' },
    ],
    interfaces: {
      'g0/1': { description: 'Sales laptop' },
      'g0/2': { description: 'HR workstation' },
      'g0/6': { description: 'Uplink to Core-SW' },
    },
  });
}

export const learnSwitchingLabs: Lab[] = [
  {
    id: 'sw-01-create-vlans',
    moduleId: MODULE,
    order: 1,
    title: 'Create VLANs',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Create and name two VLANs, then confirm them in the VLAN table.',
    scenario:
      'The branch office is splitting its flat network into departments. Create VLAN 10 named SALES and VLAN 20 named HR on the access switch, then confirm both appear in the VLAN table.',
    concepts: ['VLAN database', 'vlan / name', 'show vlan brief'],
    hints: [
      'VLANs are created in global configuration mode with vlan 10.',
      'Inside VLAN configuration mode, name SALES sets the name. Then exit and repeat for VLAN 20.',
      'end, then show vlan brief lists every VLAN with its name and ports.',
    ],
    createState: () => department(),
    objectives: [
      { id: 'v10', label: 'Create VLAN 10 named SALES', checks: [{ type: 'vlan-exists', id: 10, name: 'SALES' }] },
      { id: 'v20', label: 'Create VLAN 20 named HR', checks: [{ type: 'vlan-exists', id: 20, name: 'HR' }] },
      { id: 'verify', label: 'Verify with show vlan brief', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }] },
    ],
  },
  {
    id: 'sw-02-assign-access-ports',
    moduleId: MODULE,
    order: 2,
    title: 'Assign Access Ports',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Place the Sales and HR ports into their VLANs as static access ports.',
    scenario:
      'VLANs 10 and 20 already exist. The Sales laptop is on g0/1 and the HR workstation is on g0/2. Configure both ports as access ports in the right VLAN, then prove it with show vlan brief.',
    concepts: ['switchport mode access', 'switchport access vlan', 'Port assignment'],
    hints: [
      'interface g0/1, then switchport mode access, then switchport access vlan 10.',
      'You can type interface g0/2 directly from (config-if)# to move to the next port.',
      'show vlan brief should list Gi0/1 under VLAN 10 and Gi0/2 under VLAN 20.',
    ],
    createState: () => {
      const s = department();
      s.vlans[10] = { id: 10, name: 'SALES' };
      s.vlans[20] = { id: 20, name: 'HR' };
      return s;
    },
    objectives: [
      { id: 'g1', label: 'Put g0/1 in VLAN 10 as an access port', checks: [{ type: 'interface', name: 'g0/1', mode: 'access', label: 'g0/1 is in access mode' }, { type: 'interface', name: 'g0/1', accessVlan: 10, label: 'g0/1 access VLAN is 10' }] },
      { id: 'g2', label: 'Put g0/2 in VLAN 20 as an access port', checks: [{ type: 'interface', name: 'g0/2', mode: 'access', label: 'g0/2 is in access mode' }, { type: 'interface', name: 'g0/2', accessVlan: 20, label: 'g0/2 access VLAN is 20' }] },
      { id: 'verify', label: 'Verify with show vlan brief', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }] },
    ],
  },
  {
    id: 'sw-03-make-and-undo',
    moduleId: MODULE,
    order: 3,
    title: 'Make and Undo',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: "Create two VLANs, confirm them, then remove them with the 'no' form and confirm they are gone.",
    scenario:
      'A project team asked for VLANs 30 and 40, then cancelled the request an hour later. Create both VLANs, confirm them with show vlan brief, then remove both and confirm they are gone. This is how you learn that almost every IOS command has a no form.',
    concepts: ['The no command', 'Creating and deleting VLANs'],
    hints: [
      'vlan 30 then vlan 40 from global configuration mode create them.',
      'no vlan 30 and no vlan 40 remove them.',
      'Run show vlan brief after each step so you can see the difference.',
    ],
    createState: () => department(),
    objectives: [
      { id: 'create', label: 'Create VLANs 30 and 40', checks: [{ type: 'command', pattern: '^vlan 30$' }, { type: 'command', pattern: '^vlan 40$' }] },
      { id: 'remove', label: 'Remove both VLANs again', checks: [{ type: 'command', pattern: '^no vlan 30$' }, { type: 'command', pattern: '^no vlan 40$' }, { type: 'vlan-absent', id: 30 }, { type: 'vlan-absent', id: 40 }] },
      { id: 'verify', label: 'Verify with show vlan brief', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }] },
    ],
  },
  {
    id: 'sw-04-build-a-trunk',
    moduleId: MODULE,
    order: 4,
    title: 'Build a Trunk',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Turn the uplink into an 802.1Q trunk that carries only the department VLANs with a dedicated native VLAN.',
    scenario:
      'Sales and HR traffic must reach the core switch over g0/6. Configure g0/6 as a trunk, allow only VLANs 10 and 20, create VLAN 99 named NATIVE and use it as the native VLAN, then verify with show interfaces trunk.',
    concepts: ['switchport mode trunk', 'Allowed VLANs', 'Native VLAN', 'show interfaces trunk'],
    hints: [
      'Create VLAN 99 first: vlan 99, name NATIVE.',
      'interface g0/6, switchport mode trunk.',
      'switchport trunk allowed vlan 10,20 then switchport trunk native vlan 99.',
      'end, then show interfaces trunk to see the allowed list and native VLAN.',
    ],
    createState: () => {
      const s = department();
      s.vlans[10] = { id: 10, name: 'SALES' };
      s.vlans[20] = { id: 20, name: 'HR' };
      s.interfaces['GigabitEthernet0/1'].mode = 'access';
      s.interfaces['GigabitEthernet0/1'].accessVlan = 10;
      s.interfaces['GigabitEthernet0/2'].mode = 'access';
      s.interfaces['GigabitEthernet0/2'].accessVlan = 20;
      return s;
    },
    objectives: [
      { id: 'native-vlan', label: 'Create VLAN 99 named NATIVE', checks: [{ type: 'vlan-exists', id: 99, name: 'NATIVE' }] },
      { id: 'trunk', label: 'Make g0/6 a trunk', checks: [{ type: 'interface', name: 'g0/6', mode: 'trunk' }] },
      { id: 'allowed', label: 'Allow only VLANs 10 and 20', checks: [{ type: 'interface', name: 'g0/6', trunkAllowed: [10, 20], label: 'Allowed VLANs are 10,20' }] },
      { id: 'native', label: 'Use VLAN 99 as the native VLAN', checks: [{ type: 'interface', name: 'g0/6', nativeVlan: 99, label: 'Native VLAN is 99' }] },
      { id: 'verify', label: 'Verify with show interfaces trunk', checks: [{ type: 'command', pattern: '^(do )?show interfaces trunk$' }] },
    ],
  },
  {
    id: 'sw-05-fix-the-trunk',
    moduleId: MODULE,
    order: 5,
    title: 'Troubleshoot: The Pruned Trunk',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'HR can reach the core but Sales cannot. Find the two mistakes and repair them without touching what works.',
    scenario:
      'Users in Sales report they cannot reach servers behind the core switch while HR works fine. A contractor configured this switch last night.\n\nInspect the VLAN table and the trunk. Two things are wrong: one access port is in the wrong VLAN, and the trunk does not carry every VLAN it should. Fix both and verify.',
    concepts: ['Troubleshooting flow', 'show vlan brief', 'show interfaces trunk', 'Allowed VLAN lists replace, they do not add'],
    hints: [
      'show vlan brief: the Sales laptop on g0/1 should be in VLAN 10.',
      'show interfaces trunk: look at the Vlans allowed on trunk line for Gi0/6. It shows only 20.',
      'interface g0/1, switchport access vlan 10.',
      'interface g0/6, switchport trunk allowed vlan 10,20 (or switchport trunk allowed vlan add 10).',
    ],
    createState: () => {
      const s = department();
      s.vlans[10] = { id: 10, name: 'SALES' };
      s.vlans[20] = { id: 20, name: 'HR' };
      s.interfaces['GigabitEthernet0/1'].mode = 'access';
      s.interfaces['GigabitEthernet0/1'].accessVlan = 20;
      s.interfaces['GigabitEthernet0/2'].mode = 'access';
      s.interfaces['GigabitEthernet0/2'].accessVlan = 20;
      s.interfaces['GigabitEthernet0/6'].mode = 'trunk';
      s.interfaces['GigabitEthernet0/6'].trunkAllowed = [20];
      return s;
    },
    objectives: [
      { id: 'inspect', label: 'Inspect before changing anything', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }, { type: 'command', pattern: '^(do )?show interfaces trunk$' }] },
      { id: 'port', label: 'Move the Sales port to VLAN 10', checks: [{ type: 'interface', name: 'g0/1', accessVlan: 10, mode: 'access', label: 'g0/1 is an access port in VLAN 10' }] },
      { id: 'trunk', label: 'Allow VLANs 10 and 20 on the trunk', checks: [{ type: 'interface', name: 'g0/6', mode: 'trunk', trunkAllowed: [10, 20], label: 'Gi0/6 trunk allows 10,20' }] },
      { id: 'keep', label: 'Leave HR untouched', checks: [{ type: 'interface', name: 'g0/2', accessVlan: 20, label: 'g0/2 is still in VLAN 20' }] },
    ],
  },
  {
    id: 'sw-06-management-ip',
    moduleId: MODULE,
    order: 6,
    title: 'Give the Switch an Address',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Configure a management IP on VLAN 1, set the default gateway, and prove reachability with ping.',
    scenario:
      'The switch needs to be reachable for monitoring. Assign 192.168.1.2/24 to interface Vlan1, bring the interface up, set the default gateway to 192.168.1.1, then ping the admin PC at 192.168.1.10 from the switch.',
    concepts: ['Switch Virtual Interface (SVI)', 'ip address', 'no shutdown', 'ip default-gateway', 'ping'],
    hints: [
      'interface vlan 1, then ip address 192.168.1.2 255.255.255.0.',
      'The Vlan1 interface is shut down by default. Type no shutdown.',
      'ip default-gateway 192.168.1.1 is a global configuration command.',
      'From privileged mode, ping 192.168.1.10. Five exclamation marks means success.',
    ],
    createState: () =>
      createSwitch({
        hostname: 'Branch-SW1',
        ports: 4,
        neighbors: [
          { port: 'g0/1', name: 'Admin-PC', ip: '192.168.1.10', mask: '255.255.255.0' },
          { port: 'g0/4', name: 'R1', ip: '192.168.1.1', mask: '255.255.255.0', kind: 'router' },
        ],
        interfaces: { 'g0/1': { description: 'Admin PC' }, 'g0/4': { description: 'Router' } },
      }),
    objectives: [
      { id: 'ip', label: 'Address interface Vlan1', checks: [{ type: 'interface', name: 'vlan1', ipAddress: '192.168.1.2', subnetMask: '255.255.255.0', label: 'Vlan1 has 192.168.1.2 255.255.255.0' }] },
      { id: 'up', label: 'Bring Vlan1 up', checks: [{ type: 'interface', name: 'vlan1', shutdown: false, label: 'Vlan1 is not shut down' }] },
      { id: 'gw', label: 'Set the default gateway', checks: [{ type: 'default-gateway', equals: '192.168.1.1' }] },
      { id: 'ping', label: 'Ping the admin PC', checks: [{ type: 'ping', target: '192.168.1.10', success: true, label: 'ping 192.168.1.10 succeeds' }] },
    ],
  },
];
