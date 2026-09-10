import { buildNetwork, createRouter } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-ospf';

/**
 * PC-A - R1 (area 1) --10.0.12.0/30-- R2 (ABR) --10.0.23.0/30 area 0-- R3 (ABR) --10.0.34.0/30-- R4 (area 2) - PC-D
 * R2 and R3 also carry loopbacks 2.2.2.2 and 3.3.3.3 in area 0.
 * `cfg` decides which routers are pre-configured; a missing entry starts that router without OSPF.
 */
export function fourAreas(cfg: { R1?: 'area1'; R2?: 'abr' | 'all-area1'; R3?: 'abr'; R4?: 'area2' } = {}, primary = 'R1') {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'LAN (area 1)', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.12.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: cfg.R1 === 'area1' ? { routerId: '1.1.1.1', networks: [['192.168.1.0', '0.0.0.255', 1], ['10.0.12.0', '0.0.0.3', 1]], passiveInterfaces: ['g0/0'] } : undefined,
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { description: 'Link to R1 (area 1)', ipAddress: '10.0.12.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { description: 'Link to R3 (area 0)', ipAddress: '10.0.23.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { ipAddress: '2.2.2.2', subnetMask: '255.255.255.255', shutdown: false } },
    ospf: cfg.R2 ? { routerId: '2.2.2.2', networks: [['10.0.12.0', '0.0.0.3', 1], ['10.0.23.0', '0.0.0.3', cfg.R2 === 'abr' ? 0 : 1], ['2.2.2.2', '0.0.0.0', cfg.R2 === 'abr' ? 0 : 1]] } : undefined,
  });
  const r3 = createRouter({
    hostname: 'R3',
    interfaces: { 'g0/0': { description: 'Link to R2 (area 0)', ipAddress: '10.0.23.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { description: 'Link to R4 (area 2)', ipAddress: '10.0.34.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { ipAddress: '3.3.3.3', subnetMask: '255.255.255.255', shutdown: false } },
    ospf: cfg.R3 ? { routerId: '3.3.3.3', networks: [['10.0.23.0', '0.0.0.3', 0], ['10.0.34.0', '0.0.0.3', 2], ['3.3.3.3', '0.0.0.0', 0]] } : undefined,
  });
  const r4 = createRouter({
    hostname: 'R4',
    interfaces: { 'g0/0': { description: 'Link to R3', ipAddress: '10.0.34.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { description: 'LAN (area 2)', ipAddress: '192.168.4.1', subnetMask: '255.255.255.0', shutdown: false } },
    ospf: cfg.R4 ? { routerId: '4.4.4.4', networks: [['10.0.34.0', '0.0.0.3', 2], ['192.168.4.0', '0.0.0.255', 2]], passiveInterfaces: ['g0/1'] } : undefined,
  });
  return buildNetwork({
    primary,
    devices: [r1, r2, r3, r4],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-D', ip: '192.168.4.10', mask: '255.255.255.0', gateway: '192.168.4.1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/0'], ['R2:g0/1', 'R3:g0/0'], ['R3:g0/1', 'R4:g0/0'], ['R4:g0/1', 'PC-D']],
  });
}

export const multiAreaOspfLabs: Lab[] = [
  {
    id: 'os-07-join-a-second-area',
    moduleId: MODULE,
    order: 7,
    title: 'Join a Second Area',
    difficulty: 'Advanced',
    estimatedMinutes: 10,
    description: 'Put R1 into area 1 behind an area border router and read inter-area routes marked O IA.',
    scenario:
      "The campus has outgrown one area. The core (R2 and R3) is the backbone, area 0. R1's site is area 1 and R4's site is area 2. R2 and R3 are area border routers (ABRs): each has one foot in area 0 and one in a non-backbone area, and they pass on what they know between areas.\n\nR1 runs no OSPF yet. Configure process 1 with router-id 1.1.1.1 and advertise both of its networks in area 1 (the link 10.0.12.0/30 must be in the same area as R2's side of it). Make g0/0 passive. Then look at show ip route: routes from other areas appear with the code O IA, and 192.168.4.0/24 in area 2 should be among them. Prove it with a ping from PC-A to PC-D.",
    concepts: ['Areas and the backbone', 'Area border routers', 'O versus O IA routes', 'network ... area N'],
    hints: [
      'conf t, router ospf 1, router-id 1.1.1.1, network 192.168.1.0 0.0.0.255 area 1, network 10.0.12.0 0.0.0.3 area 1, passive-interface g0/0.',
      'show ip ospf neighbor: R2 (2.2.2.2) must be FULL. If not, compare areas with show ip ospf interface brief.',
      'show ip route: 10.0.23.0/30, 2.2.2.2, 3.3.3.3, 10.0.34.0/30 and 192.168.4.0/24 are all O IA, learned through the ABR R2.',
      'PC-A: ping 192.168.4.10.',
    ],
    createState: () => fourAreas({ R2: 'abr', R3: 'abr', R4: 'area2' }),
    objectives: [
      { id: 'process', label: 'OSPF process 1, router-id 1.1.1.1', checks: [{ type: 'ospf', processId: 1, routerId: '1.1.1.1' }] },
      { id: 'area1', label: 'Both networks in area 1', checks: [{ type: 'ospf-network', address: '192.168.1.0', wildcard: '0.0.0.255', area: 1 }, { type: 'ospf-network', address: '10.0.12.0', wildcard: '0.0.0.3', area: 1 }, { type: 'passive-interface', name: 'g0/0' }] },
      { id: 'neighbor', label: 'Adjacent with the ABR', checks: [{ type: 'ospf-neighbors', min: 1, routerId: '2.2.2.2' }] },
      { id: 'ia', label: 'Inter-area routes appear', checks: [{ type: 'command', pattern: '^(do )?show ip route( ospf)?$', label: 'show ip route on R1' }, { type: 'learned-route', destination: '10.0.23.0', mask: '255.255.255.252', source: 'ospf-ia', label: 'O IA 10.0.23.0/30 (the backbone link)' }, { type: 'learned-route', destination: '192.168.4.0', mask: '255.255.255.0', source: 'ospf-ia', label: 'O IA 192.168.4.0/24 (area 2)' }] },
      { id: 'ping', label: 'PC-A reaches PC-D across three areas', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.4.10', success: true, label: 'ping 192.168.4.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'os-08-area-without-a-backbone',
    moduleId: MODULE,
    order: 8,
    title: 'Troubleshoot: The Area Without a Backbone',
    difficulty: 'Advanced',
    estimatedMinutes: 10,
    description: 'R2 was configured entirely in area 1 and the core adjacency never formed. Turn R2 into a proper ABR.',
    scenario:
      "After a rushed change, R1 can reach R2 but nothing beyond it. R2's neighbour table only lists R1, and R3 (the backbone) shows no neighbour on its link towards R2.\n\nOSPF areas must match on both ends of a link, and every non-backbone area must touch area 0 through an ABR. On R2, find the network statements that put the link to R3 and Loopback0 into area 1, and move them into area 0 so R2 becomes the area border router again. Then confirm R1 learns 192.168.4.0/24 as O IA and PC-A reaches PC-D.",
    concepts: ['Area mismatch', 'ABR requirements', 'no network ... area', 'show ip ospf neighbor / interface brief'],
    hints: [
      "On R2: show ip ospf neighbor lists only 1.1.1.1. show ip ospf interface brief shows g0/1 in area 1; R3's g0/0 is in area 0.",
      'router ospf 1, no network 10.0.23.0 0.0.0.3 area 1, network 10.0.23.0 0.0.0.3 area 0.',
      'Move the loopback too: no network 2.2.2.2 0.0.0.0 area 1, network 2.2.2.2 0.0.0.0 area 0.',
      "show ip ospf neighbor on R2 now lists 1.1.1.1 and 3.3.3.3. R1's table gains O IA routes; PC-A: ping 192.168.4.10.",
    ],
    createState: () => fourAreas({ R1: 'area1', R2: 'all-area1', R3: 'abr', R4: 'area2' }, 'R2'),
    objectives: [
      { id: 'inspect', label: 'Inspect R2', checks: [{ type: 'command', pattern: '^(do )?show ip (ospf (neighbor|interface( brief)?)|route( ospf)?|protocols)$', label: 'Run show ip ospf neighbor, show ip ospf interface brief or show ip route on R2' }] },
      { id: 'link', label: 'Move the R3 link into area 0', checks: [{ type: 'ospf-network-absent', address: '10.0.23.0', wildcard: '0.0.0.3', area: 1 }, { type: 'ospf-network', address: '10.0.23.0', wildcard: '0.0.0.3', area: 0 }] },
      { id: 'loopback', label: 'Move Loopback0 into area 0', checks: [{ type: 'ospf-network-absent', address: '2.2.2.2', wildcard: '0.0.0.0', area: 1 }, { type: 'ospf-network', address: '2.2.2.2', wildcard: '0.0.0.0', area: 0 }] },
      { id: 'neighbors', label: 'R2 is adjacent in both areas', checks: [{ type: 'ospf-neighbors', min: 2, label: 'R2 has neighbours 1.1.1.1 and 3.3.3.3' }, { type: 'ospf-neighbors', device: 'R3', min: 1, routerId: '2.2.2.2', label: 'R3 sees R2 as a neighbour' }] },
      { id: 'ia', label: 'Inter-area routes reach R1', checks: [{ type: 'learned-route', device: 'R1', destination: '192.168.4.0', mask: '255.255.255.0', source: 'ospf-ia', label: 'R1 has O IA 192.168.4.0/24' }, { type: 'learned-route', device: 'R4', destination: '192.168.1.0', mask: '255.255.255.0', source: 'ospf-ia', label: 'R4 has O IA 192.168.1.0/24' }] },
      { id: 'ping', label: 'End to end', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.4.10', success: true, label: 'ping 192.168.4.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'os-09-exam-multi-area-campus',
    moduleId: MODULE,
    order: 9,
    title: 'Exam: Multi-Area Campus',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Build a three-area OSPF network from scratch on four routers with two ABRs.',
    scenario:
      "Four addressed routers, no routing. Build multi-area OSPF process 1:\n\n- Router IDs 1.1.1.1 to 4.4.4.4\n- Area 0 (backbone): the R2-R3 link 10.0.23.0/30 and the loopbacks 2.2.2.2 and 3.3.3.3\n- Area 1: R1's LAN 192.168.1.0/24 and the R1-R2 link 10.0.12.0/30\n- Area 2: the R3-R4 link 10.0.34.0/30 and R4's LAN 192.168.4.0/24\n- LAN interfaces passive (R1 g0/0, R4 g0/1)\n- Save all four routers\n\nR1 must learn 192.168.4.0/24 as O IA, R4 must learn 192.168.1.0/24 as O IA, and PC-A must ping PC-D. No hints are available.",
    concepts: ['Synthesis', 'Multi-area OSPF', 'ABR placement', 'Passive interfaces'],
    hints: [],
    createState: () => fourAreas({}),
    objectives: [
      { id: 'r1', label: 'R1 in area 1', checks: [{ type: 'ospf', device: 'R1', processId: 1, routerId: '1.1.1.1' }, { type: 'ospf-network', device: 'R1', address: '192.168.1.0', wildcard: '0.0.0.255', area: 1 }, { type: 'ospf-network', device: 'R1', address: '10.0.12.0', wildcard: '0.0.0.3', area: 1 }, { type: 'passive-interface', device: 'R1', name: 'g0/0' }] },
      { id: 'r2', label: 'R2 is an ABR (areas 1 and 0)', checks: [{ type: 'ospf', device: 'R2', processId: 1, routerId: '2.2.2.2' }, { type: 'ospf-network', device: 'R2', address: '10.0.12.0', wildcard: '0.0.0.3', area: 1 }, { type: 'ospf-network', device: 'R2', address: '10.0.23.0', wildcard: '0.0.0.3', area: 0 }, { type: 'ospf-network', device: 'R2', address: '2.2.2.2', wildcard: '0.0.0.0', area: 0 }, { type: 'ospf-neighbors', device: 'R2', min: 2 }] },
      { id: 'r3', label: 'R3 is an ABR (areas 0 and 2)', checks: [{ type: 'ospf', device: 'R3', processId: 1, routerId: '3.3.3.3' }, { type: 'ospf-network', device: 'R3', address: '10.0.23.0', wildcard: '0.0.0.3', area: 0 }, { type: 'ospf-network', device: 'R3', address: '10.0.34.0', wildcard: '0.0.0.3', area: 2 }, { type: 'ospf-network', device: 'R3', address: '3.3.3.3', wildcard: '0.0.0.0', area: 0 }, { type: 'ospf-neighbors', device: 'R3', min: 2 }] },
      { id: 'r4', label: 'R4 in area 2', checks: [{ type: 'ospf', device: 'R4', processId: 1, routerId: '4.4.4.4' }, { type: 'ospf-network', device: 'R4', address: '10.0.34.0', wildcard: '0.0.0.3', area: 2 }, { type: 'ospf-network', device: 'R4', address: '192.168.4.0', wildcard: '0.0.0.255', area: 2 }, { type: 'passive-interface', device: 'R4', name: 'g0/1' }] },
      { id: 'routes', label: 'Inter-area routes both ways', checks: [{ type: 'learned-route', device: 'R1', destination: '192.168.4.0', mask: '255.255.255.0', source: 'ospf-ia', label: 'R1 has O IA 192.168.4.0/24' }, { type: 'learned-route', device: 'R4', destination: '192.168.1.0', mask: '255.255.255.0', source: 'ospf-ia', label: 'R4 has O IA 192.168.1.0/24' }, { type: 'learned-route', device: 'R1', destination: '3.3.3.3', mask: '255.255.255.255', source: 'ospf-ia', label: 'R1 has O IA 3.3.3.3/32' }] },
      { id: 'ping', label: 'Hosts reach each other', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.4.10', success: true, label: 'ping 192.168.4.10 from PC-A succeeds' }, { type: 'ping', device: 'PC-D', target: '192.168.1.10', success: true, label: 'ping 192.168.1.10 from PC-D succeeds' }] },
      { id: 'save', label: 'Save all routers', checks: [{ type: 'saved', device: 'R1' }, { type: 'saved', device: 'R2' }, { type: 'saved', device: 'R3' }, { type: 'saved', device: 'R4' }] },
    ],
  },
];
