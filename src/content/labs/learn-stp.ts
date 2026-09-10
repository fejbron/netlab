import { buildNetwork, createSwitch, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-stp';

/**
 * Triangle of switches, every inter-switch link a trunk:
 *   SW1 g0/7 --- g0/7 SW2
 *   SW2 g0/8 --- g0/8 SW3
 *   SW3 g0/7 --- g0/8 SW1
 * PC-A (VLAN 10) on SW1 g0/1, PC-B (VLAN 20) on SW2 g0/1, PC-C (VLAN 10) on SW3 g0/1.
 * The bridge MACs make SW3 (the smallest access switch in the closet) win the default election.
 */
function triangle(opts: { priority?: Record<string, Record<number, number>>; sw1?: Record<string, object>; mode?: 'pvst' | 'rapid-pvst'; sw3Priority?: Record<number, number> } = {}): NetworkState {
  const mk = (hostname: string, mac: string, role: string, extra: Record<string, object> = {}, priority?: Record<number, number>) =>
    createSwitch({
      hostname,
      mac,
      ports: 8,
      stpMode: opts.mode,
      stpPriority: priority,
      vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
      interfaces: {
        'g0/1': { mode: 'access', accessVlan: hostname === 'SW2' ? 20 : 10, description: role },
        'g0/7': { mode: 'trunk', description: hostname === 'SW1' ? 'Trunk to SW2' : hostname === 'SW2' ? 'Trunk to SW1' : 'Trunk to SW1' },
        'g0/8': { mode: 'trunk', description: hostname === 'SW1' ? 'Trunk to SW3' : hostname === 'SW2' ? 'Trunk to SW3' : 'Trunk to SW2' },
        ...extra,
      },
    });
  return buildNetwork({
    primary: 'SW1',
    devices: [
      mk('SW1', '0011.2233.0c01', 'Sales PC', opts.sw1, opts.priority?.SW1),
      mk('SW2', '0011.2233.0b02', 'HR PC', {}, opts.priority?.SW2),
      mk('SW3', '0011.2233.0a03', 'Sales PC', {}, opts.priority?.SW3 ?? opts.sw3Priority),
    ],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.11', mask: '255.255.255.0' },
      { id: 'PC-B', ip: '192.168.20.11', mask: '255.255.255.0' },
      { id: 'PC-C', ip: '192.168.10.12', mask: '255.255.255.0' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW2:g0/1'], ['PC-C', 'SW3:g0/1'], ['SW1:g0/7', 'SW2:g0/7'], ['SW2:g0/8', 'SW3:g0/8'], ['SW3:g0/7', 'SW1:g0/8']],
  });
}

export const learnStpLabs: Lab[] = [
  {
    id: 'stp-01-find-the-root',
    moduleId: MODULE,
    order: 1,
    title: 'Find the Root Bridge',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Read show spanning-tree on three looped switches: who is root, which port is blocked, and why.',
    scenario:
      'Three switches are cabled in a triangle so that any one link can fail without cutting anyone off. A triangle is a loop, and without spanning tree a single broadcast would circle forever. Spanning tree elects one root bridge and blocks one port to break the loop.\n\nNobody has set a priority, so the election was decided by MAC address. On SW1, run show spanning-tree vlan 10 and read the Root ID section. Then use show spanning-tree vlan 10 on SW2 and SW3 as well to find which switch says "This bridge is the root" and which port on which switch is Altn BLK. Nothing needs to be configured in this lab: run the show commands on all three switches, and run show spanning-tree (all VLANs) on SW1.',
    concepts: ['Root bridge election', 'Bridge ID = priority + MAC', 'Root, designated and alternate ports', 'show spanning-tree'],
    hints: [
      'show spanning-tree vlan 10 on SW1. Under Root ID, Address is the root\'s MAC; under Bridge ID, Address is this switch\'s MAC. If they differ, this switch is not the root.',
      'Compare the Bridge ID priorities: all three are 32778 (32768 + VLAN 10), so the lowest MAC wins. SW3 ends in 0a03, the lowest.',
      'On SW1 the port with Role Altn and Sts BLK is the blocked one. SW1 and SW2 are both one hop from SW3; SW2 has the lower MAC, so SW1 blocks its side of the SW1-SW2 link.',
      'Run show spanning-tree without a VLAN on SW1 to see the VLAN 1, 10 and 20 instances together.',
    ],
    createState: () => triangle(),
    objectives: [
      { id: 'sw1', label: 'Inspect VLAN 10 on SW1', checks: [{ type: 'command', device: 'SW1', pattern: '^(do )?show spanning-tree vlan 10$', label: 'show spanning-tree vlan 10 on SW1' }] },
      { id: 'sw2', label: 'Inspect VLAN 10 on SW2', checks: [{ type: 'command', device: 'SW2', pattern: '^(do )?show spanning-tree( vlan 10)?$', label: 'show spanning-tree on SW2' }] },
      { id: 'sw3', label: 'Inspect VLAN 10 on the root', checks: [{ type: 'command', device: 'SW3', pattern: '^(do )?show spanning-tree( vlan 10)?$', label: 'show spanning-tree on SW3' }, { type: 'stp-root', device: 'SW3', vlan: 10, label: 'SW3 is the root for VLAN 10' }] },
      { id: 'all', label: 'See every VLAN instance on SW1', checks: [{ type: 'command', device: 'SW1', pattern: '^(do )?show spanning-tree$', label: 'show spanning-tree on SW1' }, { type: 'stp-port', interface: 'g0/7', vlan: 10, role: 'Altn', state: 'BLK', label: 'SW1 g0/7 is the alternate (blocked) port' }] },
    ],
  },
  {
    id: 'stp-02-choose-the-root',
    moduleId: MODULE,
    order: 2,
    title: 'Choose the Root Bridge',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Lower the priority on the distribution switch so it becomes root, and make SW2 the backup root.',
    scenario:
      'The election picked SW3, a small access switch at the end of a corridor, as the root of every VLAN. That is the wrong place for the centre of the tree: the beefiest switch with the most uplinks should be root, so that traffic takes the shortest paths.\n\nOn SW1, make it the root for VLANs 1, 10 and 20 with the spanning-tree vlan ... root primary macro (or an explicit priority of 24576 or lower). Then on SW2 set the secondary root (priority 28672) for the same VLANs. Verify on SW1 that the Root ID section now reports "This bridge is the root" and see which port moved to BLK.',
    concepts: ['spanning-tree vlan N root primary / secondary', 'spanning-tree vlan N priority', 'Priority increments of 4096', 'Root placement'],
    hints: [
      'conf t, then spanning-tree vlan 1,10,20 root primary. IOS sets priority 24576 for those VLANs.',
      'Priorities must be multiples of 4096. spanning-tree vlan 1,10,20 priority 4096 also works.',
      'On SW2: spanning-tree vlan 1,10,20 root secondary sets 28672, so SW2 takes over if SW1 dies.',
      'show spanning-tree vlan 10 on SW1: Root ID priority is now 24586 (24576 + 10) and the switch says it is the root. The blocked port has moved to the SW2-SW3 link.',
    ],
    createState: () => triangle(),
    objectives: [
      { id: 'primary', label: 'SW1 becomes root for VLANs 1, 10 and 20', checks: [{ type: 'stp-priority', vlan: 1, max: 24576, label: 'VLAN 1 priority is 24576 or lower on SW1' }, { type: 'stp-priority', vlan: 10, max: 24576, label: 'VLAN 10 priority is 24576 or lower on SW1' }, { type: 'stp-priority', vlan: 20, max: 24576, label: 'VLAN 20 priority is 24576 or lower on SW1' }, { type: 'stp-root', vlan: 10, label: 'SW1 is the root for VLAN 10' }, { type: 'stp-root', vlan: 20, label: 'SW1 is the root for VLAN 20' }] },
      { id: 'secondary', label: 'SW2 becomes the secondary root', checks: [{ type: 'stp-priority', device: 'SW2', vlan: 1, priority: 28672, label: 'VLAN 1 priority is 28672 on SW2' }, { type: 'stp-priority', device: 'SW2', vlan: 10, priority: 28672, label: 'VLAN 10 priority is 28672 on SW2' }, { type: 'stp-priority', device: 'SW2', vlan: 20, priority: 28672, label: 'VLAN 20 priority is 28672 on SW2' }] },
      { id: 'verify', label: 'Verify the new tree', checks: [{ type: 'command', pattern: '^(do )?show spanning-tree( vlan \\d+)?$', label: 'show spanning-tree on SW1' }, { type: 'stp-port', interface: 'g0/7', vlan: 10, role: 'Desg', state: 'FWD', label: 'SW1 g0/7 now forwards' }, { type: 'stp-port', interface: 'g0/8', vlan: 10, role: 'Desg', state: 'FWD', label: 'SW1 g0/8 now forwards' }] },
      { id: 'ping', label: 'Traffic still flows', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.12', success: true, label: 'PC-A pings PC-C' }] },
    ],
  },
  {
    id: 'stp-03-portfast-bpduguard',
    moduleId: MODULE,
    order: 3,
    title: 'PortFast and BPDU Guard',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Make user ports come up instantly and shut them down if a switch is ever plugged in.',
    scenario:
      'Every time a PC boots, spanning tree makes its port listen and learn for 30 seconds before forwarding, so the user sees "no network" while DHCP times out. PortFast skips that wait on ports that only ever connect to end devices. But a PortFast port that receives a BPDU means someone plugged a switch into a user port, which is how accidental loops start; BPDU guard err-disables the port the instant that happens.\n\nOn SW1, enable PortFast and BPDU guard on g0/1 (the Sales PC). Also enable rapid-pvst mode, the faster modern version of per-VLAN spanning tree, on SW1. Check show spanning-tree vlan 10: g0/1 should show as P2p Edge.',
    concepts: ['spanning-tree portfast', 'spanning-tree bpduguard enable', 'Edge ports', 'spanning-tree mode rapid-pvst'],
    hints: [
      'conf t, interface g0/1, spanning-tree portfast. IOS prints a warning: that is normal.',
      'Still on g0/1: spanning-tree bpduguard enable.',
      'Back in global config: spanning-tree mode rapid-pvst. show spanning-tree now says "protocol rstp".',
      'Never put PortFast on a trunk to another switch; BPDU guard there would err-disable your uplink.',
    ],
    createState: () => triangle({ priority: { SW1: { 1: 24576, 10: 24576, 20: 24576 } } }),
    objectives: [
      { id: 'portfast', label: 'PortFast on g0/1', checks: [{ type: 'stp-port', interface: 'g0/1', portfast: true, label: 'g0/1 has spanning-tree portfast' }] },
      { id: 'guard', label: 'BPDU guard on g0/1', checks: [{ type: 'stp-port', interface: 'g0/1', bpduGuard: true, label: 'g0/1 has spanning-tree bpduguard enable' }, { type: 'interface', name: 'g0/1', errDisabled: false, label: 'g0/1 is still up (no switch behind it)' }] },
      { id: 'rapid', label: 'Rapid PVST+ on SW1', checks: [{ type: 'stp-mode', mode: 'rapid-pvst' }] },
      { id: 'uplinks', label: 'Uplinks untouched', checks: [{ type: 'stp-port', interface: 'g0/7', portfast: false, label: 'g0/7 has no PortFast' }, { type: 'stp-port', interface: 'g0/8', portfast: false, label: 'g0/8 has no PortFast' }, { type: 'command', pattern: '^(do )?show spanning-tree( vlan \\d+)?$', label: 'show spanning-tree on SW1' }] },
    ],
  },
  {
    id: 'stp-04-err-disabled-uplink',
    moduleId: MODULE,
    order: 4,
    title: 'Troubleshoot: The Uplink BPDU Guard Killed',
    difficulty: 'Advanced',
    estimatedMinutes: 10,
    description: 'An uplink is err-disabled and one link failure would now cut off the Sales floor. Find out why and recover it.',
    scenario:
      'Last night someone "hardened" SW1 by enabling BPDU guard on every port, including the trunk to SW3. SW3 sends BPDUs like every switch, so the moment the command landed, g0/8 went err-disabled. Traffic still flows because the SW1-SW2 link unblocked, but the ring has lost its redundancy.\n\nOn SW1, read show interfaces status and show spanning-tree vlan 10, remove BPDU guard from g0/8, then bounce the port with shutdown / no shutdown to clear the err-disabled state. Finish with g0/8 back as a forwarding trunk (root port towards SW3) and PortFast plus BPDU guard left in place only on g0/1.',
    concepts: ['err-disabled recovery', 'BPDU guard on uplinks', 'shutdown / no shutdown', 'Reading show spanning-tree after a failure'],
    hints: [
      'show interfaces status: g0/8 says err-disabled. show spanning-tree vlan 10 no longer lists it at all.',
      'show running-config: interface g0/8 carries spanning-tree bpduguard enable. Remove it with no spanning-tree bpduguard.',
      'A port stays err-disabled until it is bounced: shutdown, then no shutdown.',
      'After the bounce, show spanning-tree vlan 10 shows g0/8 as Root FWD again (SW3 is the root) and g0/7 returns to Altn BLK.',
    ],
    createState: () => triangle({ sw1: { 'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales PC', portfast: true, bpduGuard: true }, 'g0/8': { mode: 'trunk', description: 'Trunk to SW3', bpduGuard: true } } }),
    objectives: [
      { id: 'inspect', label: 'Inspect the failure', checks: [{ type: 'command', pattern: '^(do )?show (interfaces status|spanning-tree( vlan \\d+)?)$', label: 'Run show interfaces status or show spanning-tree' }] },
      { id: 'remove', label: 'Remove BPDU guard from the uplink', checks: [{ type: 'stp-port', interface: 'g0/8', bpduGuard: false, label: 'g0/8 no longer has BPDU guard' }] },
      { id: 'recover', label: 'Recover the port', checks: [{ type: 'interface', name: 'g0/8', errDisabled: false, shutdown: false, label: 'g0/8 is up again' }, { type: 'stp-port', interface: 'g0/8', vlan: 10, role: 'Root', state: 'FWD', label: 'g0/8 is the root port towards SW3' }] },
      { id: 'keep', label: 'Keep the user port protected', checks: [{ type: 'stp-port', interface: 'g0/1', portfast: true, bpduGuard: true, label: 'g0/1 keeps PortFast and BPDU guard' }] },
      { id: 'ping', label: 'Redundancy restored', checks: [{ type: 'stp-port', interface: 'g0/7', vlan: 10, role: 'Altn', state: 'BLK', label: 'g0/7 is back to blocking (the loop is closed again)' }, { type: 'ping', device: 'PC-A', target: '192.168.10.12', success: true, label: 'PC-A pings PC-C' }] },
    ],
  },
  {
    id: 'stp-05-exam-design-the-tree',
    moduleId: MODULE,
    order: 5,
    title: 'Exam: Design the Tree',
    difficulty: 'Advanced',
    estimatedMinutes: 15,
    description: 'Place the root, protect the edge, and steer VLAN 20 over the other uplink.',
    isExam: true,
    scenario:
      'The campus triangle needs a deliberate spanning-tree design on all three switches:\n\n- SW1 is the primary root for VLANs 1 and 10; SW2 is the primary root for VLAN 20 (so HR traffic takes the SW2 uplinks). Use priority 24576 for the primary roles.\n- SW1 is the secondary root (28672) for VLAN 20 and SW2 is the secondary root (28672) for VLANs 1 and 10.\n- All three switches run rapid-pvst.\n- Every g0/1 user port gets PortFast and BPDU guard.\n- Save all three switches.\n\nPC-A must still reach PC-C and PC-B must reach the HR gateway at 192.168.20.1 on SW3\'s management SVI. No hints are available.',
    concepts: ['Synthesis', 'Per-VLAN root placement', 'Rapid PVST+', 'Edge port protection'],
    hints: [],
    createState: () => {
      const net = triangle();
      const sw3 = net.devices['SW3'];
      sw3.interfaces['Vlan20'] = { name: 'Vlan20', shutdown: false, connected: true, mode: 'access', accessVlan: 1, trunkAllowed: 'all', nativeVlan: 1, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0', description: 'HR gateway' };
      return net;
    },
    objectives: [
      { id: 'sw1', label: 'SW1 roots', checks: [{ type: 'stp-priority', device: 'SW1', vlan: 1, priority: 24576 }, { type: 'stp-priority', device: 'SW1', vlan: 10, priority: 24576 }, { type: 'stp-priority', device: 'SW1', vlan: 20, priority: 28672 }, { type: 'stp-root', device: 'SW1', vlan: 10, label: 'SW1 is root for VLAN 10' }] },
      { id: 'sw2', label: 'SW2 roots', checks: [{ type: 'stp-priority', device: 'SW2', vlan: 20, priority: 24576 }, { type: 'stp-priority', device: 'SW2', vlan: 1, priority: 28672 }, { type: 'stp-priority', device: 'SW2', vlan: 10, priority: 28672 }, { type: 'stp-root', device: 'SW2', vlan: 20, label: 'SW2 is root for VLAN 20' }] },
      { id: 'mode', label: 'Rapid PVST+ everywhere', checks: [{ type: 'stp-mode', device: 'SW1', mode: 'rapid-pvst' }, { type: 'stp-mode', device: 'SW2', mode: 'rapid-pvst' }, { type: 'stp-mode', device: 'SW3', mode: 'rapid-pvst' }] },
      { id: 'edge', label: 'Protected user ports', checks: [{ type: 'stp-port', device: 'SW1', interface: 'g0/1', portfast: true, bpduGuard: true }, { type: 'stp-port', device: 'SW2', interface: 'g0/1', portfast: true, bpduGuard: true }, { type: 'stp-port', device: 'SW3', interface: 'g0/1', portfast: true, bpduGuard: true }] },
      { id: 'reach', label: 'Connectivity', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.12', success: true, label: 'PC-A pings PC-C' }, { type: 'ping', device: 'PC-B', target: '192.168.20.1', success: true, label: 'PC-B pings the HR gateway on SW3' }] },
      { id: 'save', label: 'Save all switches', checks: [{ type: 'saved', device: 'SW1' }, { type: 'saved', device: 'SW2' }, { type: 'saved', device: 'SW3' }] },
    ],
  },
];
