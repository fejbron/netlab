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
  {
    id: 'sw-07-who-is-plugged-in',
    moduleId: MODULE,
    order: 7,
    title: 'Who Is Plugged In',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Use the MAC address table to find which port a device is on, then label that port.',
    scenario:
      'The office manager bought a network printer and plugged it in somewhere in the closet. Its label says MAC address 0011.22aa.0003.\n\nUse the MAC address table to find the port the printer is on, confirm the port is up, and give that port the description Printer so the next person does not have to hunt for it.',
    concepts: ['show mac address-table', 'MAC learning', 'show interfaces status', 'Descriptions'],
    hints: [
      'show mac address-table lists every learned MAC with the port it was learned on.',
      'show interfaces status confirms the port is connected.',
      'interface g0/3, description Printer.',
    ],
    createState: () =>
      createSwitch({
        hostname: 'Access-SW1',
        ports: 6,
        neighbors: [
          { port: 'g0/1', name: 'Sales-PC', ip: '192.168.10.11', mask: '255.255.255.0' },
          { port: 'g0/2', name: 'HR-PC', ip: '192.168.10.12', mask: '255.255.255.0' },
          { port: 'g0/3', name: 'Printer', ip: '192.168.10.50', mask: '255.255.255.0', kind: 'server' },
          { port: 'g0/6', name: 'Core-SW', kind: 'switch' },
        ],
        interfaces: { 'g0/1': { description: 'Sales laptop' }, 'g0/2': { description: 'HR workstation' }, 'g0/6': { mode: 'trunk', description: 'Uplink to Core-SW' } },
      }),
    objectives: [
      { id: 'mac', label: 'Read the MAC address table', checks: [{ type: 'command', pattern: '^(do )?show mac address-table$' }] },
      { id: 'status', label: 'Confirm the port is connected', checks: [{ type: 'command', pattern: '^(do )?show interfaces status$' }] },
      { id: 'desc', label: 'Describe the printer port', checks: [{ type: 'interface', name: 'g0/3', description: 'Printer', label: 'g0/3 description is Printer' }] },
    ],
  },
  {
    id: 'sw-08-native-vlan-mismatch',
    moduleId: MODULE,
    order: 8,
    title: 'Troubleshoot: Native VLAN Mismatch',
    difficulty: 'Intermediate',
    estimatedMinutes: 7,
    description: 'The core switch logs a native VLAN mismatch on the uplink. Align this side of the trunk with the design.',
    scenario:
      'The core switch keeps logging %CDP-4-NATIVE_VLAN_MISMATCH on the link to this access switch. The network design says every trunk uses VLAN 99, named NATIVE, as its native VLAN. The core side is already correct.\n\nInspect the trunk on g0/6, create the missing VLAN, and set the native VLAN so both ends agree.',
    concepts: ['Native VLAN', 'Untagged frames', 'show interfaces trunk', 'switchport trunk native vlan'],
    hints: [
      'show interfaces trunk shows the native VLAN for Gi0/6. It is still 1.',
      'Create the VLAN first: vlan 99, name NATIVE.',
      'interface g0/6, switchport trunk native vlan 99.',
    ],
    createState: () => {
      const s = department();
      s.vlans[10] = { id: 10, name: 'SALES' };
      s.vlans[20] = { id: 20, name: 'HR' };
      s.interfaces['GigabitEthernet0/1'].mode = 'access';
      s.interfaces['GigabitEthernet0/1'].accessVlan = 10;
      s.interfaces['GigabitEthernet0/2'].mode = 'access';
      s.interfaces['GigabitEthernet0/2'].accessVlan = 20;
      s.interfaces['GigabitEthernet0/6'].mode = 'trunk';
      return s;
    },
    objectives: [
      { id: 'inspect', label: 'Inspect the trunk first', checks: [{ type: 'command', pattern: '^(do )?show interfaces trunk$' }] },
      { id: 'vlan', label: 'Create VLAN 99 named NATIVE', checks: [{ type: 'vlan-exists', id: 99, name: 'NATIVE' }] },
      { id: 'native', label: 'Set the native VLAN on the trunk to 99', checks: [{ type: 'interface', name: 'g0/6', mode: 'trunk', nativeVlan: 99, label: 'Gi0/6 is a trunk with native VLAN 99' }] },
    ],
  },
  {
    id: 'sw-09-management-vlan',
    moduleId: MODULE,
    order: 9,
    title: 'Management VLAN',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Put the switch management address in a dedicated VLAN and prove it can reach the management PC.',
    scenario:
      'Security policy says switches must not be managed from the user VLANs. VLAN 99 (MGMT) already exists and the management PC on g0/5 is in it at 10.0.99.10.\n\nCreate interface Vlan99 with 10.0.99.2/24, make sure it is up, set the default gateway to 10.0.99.1, then ping the management PC.',
    concepts: ['Management VLAN', 'SVI', 'ip default-gateway', 'ping'],
    hints: [
      'interface vlan 99 creates the SVI. Then ip address 10.0.99.2 255.255.255.0.',
      'New SVIs come up automatically, but no shutdown never hurts.',
      'ip default-gateway 10.0.99.1 is a global configuration command.',
      'ping 10.0.99.10 from privileged mode.',
    ],
    createState: () =>
      createSwitch({
        hostname: 'Access-SW1',
        ports: 6,
        vlans: [{ id: 10, name: 'SALES' }, { id: 99, name: 'MGMT' }],
        neighbors: [
          { port: 'g0/1', name: 'Sales-PC', ip: '192.168.10.11', mask: '255.255.255.0' },
          { port: 'g0/5', name: 'Mgmt-PC', ip: '10.0.99.10', mask: '255.255.255.0' },
          { port: 'g0/6', name: 'Core-SW', kind: 'switch' },
        ],
        interfaces: {
          'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales laptop' },
          'g0/5': { mode: 'access', accessVlan: 99, description: 'Management PC' },
          'g0/6': { mode: 'trunk', description: 'Uplink to Core-SW' },
        },
      }),
    objectives: [
      { id: 'svi', label: 'Address interface Vlan99', checks: [{ type: 'interface', name: 'vlan99', ipAddress: '10.0.99.2', subnetMask: '255.255.255.0', label: 'Vlan99 has 10.0.99.2 255.255.255.0' }] },
      { id: 'up', label: 'Keep Vlan99 up', checks: [{ type: 'interface', name: 'vlan99', shutdown: false, label: 'Vlan99 is not shut down' }] },
      { id: 'gw', label: 'Set the default gateway', checks: [{ type: 'default-gateway', equals: '10.0.99.1' }] },
      { id: 'ping', label: 'Ping the management PC', checks: [{ type: 'ping', target: '10.0.99.10', success: true, label: 'ping 10.0.99.10 succeeds' }] },
    ],
  },
  {
    id: 'sw-10-trunk-cleanup',
    moduleId: MODULE,
    order: 10,
    title: 'Trunk Cleanup',
    difficulty: 'Intermediate',
    estimatedMinutes: 6,
    description: 'Two departments moved out. Remove their VLANs from the trunk and from the VLAN database.',
    scenario:
      'VLANs 30 (MARKETING) and 40 (LEGAL) belonged to teams that moved to another building. Their VLANs are still allowed on the uplink trunk and still exist on this switch.\n\nRemove both VLANs from the allowed list on g0/6 without disturbing VLANs 10 and 20, delete them from the VLAN database, and verify the trunk.',
    concepts: ['switchport trunk allowed vlan remove', 'no vlan', 'Change without disruption'],
    hints: [
      'show interfaces trunk shows the current allowed list: 10,20,30,40.',
      'interface g0/6, switchport trunk allowed vlan remove 30,40 keeps 10 and 20 untouched.',
      'Back in global config: no vlan 30, no vlan 40.',
    ],
    createState: () => {
      const s = department();
      s.vlans[10] = { id: 10, name: 'SALES' };
      s.vlans[20] = { id: 20, name: 'HR' };
      s.vlans[30] = { id: 30, name: 'MARKETING' };
      s.vlans[40] = { id: 40, name: 'LEGAL' };
      s.interfaces['GigabitEthernet0/1'].mode = 'access';
      s.interfaces['GigabitEthernet0/1'].accessVlan = 10;
      s.interfaces['GigabitEthernet0/2'].mode = 'access';
      s.interfaces['GigabitEthernet0/2'].accessVlan = 20;
      s.interfaces['GigabitEthernet0/6'].mode = 'trunk';
      s.interfaces['GigabitEthernet0/6'].trunkAllowed = [10, 20, 30, 40];
      return s;
    },
    objectives: [
      { id: 'trunk', label: 'Allow only VLANs 10 and 20 on the trunk', checks: [{ type: 'interface', name: 'g0/6', mode: 'trunk', trunkAllowed: [10, 20], label: 'Gi0/6 allows exactly 10,20' }] },
      { id: 'delete', label: 'Delete VLANs 30 and 40', checks: [{ type: 'vlan-absent', id: 30 }, { type: 'vlan-absent', id: 40 }] },
      { id: 'keep', label: 'Keep VLANs 10 and 20', checks: [{ type: 'vlan-exists', id: 10, name: 'SALES' }, { type: 'vlan-exists', id: 20, name: 'HR' }] },
      { id: 'verify', label: 'Verify with show interfaces trunk', checks: [{ type: 'command', pattern: '^(do )?show interfaces trunk$' }] },
    ],
  },
  {
    id: 'sw-11-exam-department-switch',
    moduleId: MODULE,
    order: 11,
    title: 'Exam: Department Switch Build',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Build a complete access switch from factory default: VLANs, access ports, a trunk, a management SVI, and save.',
    scenario:
      'A new access switch arrives for the Sales and HR floor. Build it from the design sheet:\n\n- Hostname Dept-SW1\n- VLAN 10 SALES, VLAN 20 HR, VLAN 99 MGMT\n- g0/1 static access in VLAN 10, g0/2 static access in VLAN 20\n- g0/8 trunk to the core carrying only VLANs 10, 20 and 99, native VLAN 99\n- Interface Vlan99 with 10.0.99.5/24, up, default gateway 10.0.99.1\n- Save the configuration\n\nNo hints are available.',
    concepts: ['Synthesis', 'VLANs', 'Trunking', 'Management SVI'],
    hints: [],
    createState: () =>
      createSwitch({
        ports: 8,
        neighbors: [
          { port: 'g0/1', name: 'Sales-PC', ip: '192.168.10.11', mask: '255.255.255.0' },
          { port: 'g0/2', name: 'HR-PC', ip: '192.168.20.11', mask: '255.255.255.0' },
          { port: 'g0/8', name: 'Core-SW', kind: 'switch' },
        ],
      }),
    objectives: [
      { id: 'hostname', label: 'Set the hostname', checks: [{ type: 'hostname', equals: 'Dept-SW1' }] },
      { id: 'vlans', label: 'Create the three VLANs', checks: [{ type: 'vlan-exists', id: 10, name: 'SALES' }, { type: 'vlan-exists', id: 20, name: 'HR' }, { type: 'vlan-exists', id: 99, name: 'MGMT' }] },
      { id: 'access', label: 'Configure the access ports', checks: [{ type: 'interface', name: 'g0/1', mode: 'access', accessVlan: 10, label: 'g0/1 is access in VLAN 10' }, { type: 'interface', name: 'g0/2', mode: 'access', accessVlan: 20, label: 'g0/2 is access in VLAN 20' }] },
      { id: 'trunk', label: 'Configure the uplink trunk', checks: [{ type: 'interface', name: 'g0/8', mode: 'trunk', trunkAllowed: [10, 20, 99], nativeVlan: 99, label: 'g0/8 trunks 10,20,99 with native 99' }] },
      { id: 'mgmt', label: 'Configure management access', checks: [{ type: 'interface', name: 'vlan99', ipAddress: '10.0.99.5', subnetMask: '255.255.255.0', shutdown: false, label: 'Vlan99 is 10.0.99.5/24 and up' }, { type: 'default-gateway', equals: '10.0.99.1' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
];
