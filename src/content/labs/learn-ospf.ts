import { buildNetwork, createRouter } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-ospf';

const NET_LAN1: [string, string, number] = ['192.168.1.0', '0.0.0.255', 0];
const NET_LAN2: [string, string, number] = ['192.168.2.0', '0.0.0.255', 0];
const NET_LINK: [string, string, number] = ['10.0.0.0', '0.0.0.3', 0];

/**
 * PC-A - R1 g0/0 (192.168.1.1) | R1 g0/1 (10.0.0.1) --- (10.0.0.2) R2 g0/1 | R2 g0/0 (192.168.2.1) - PC-B
 * Both routers are addressed. R2 runs OSPF; R1 as requested.
 */
function twoSites(r1: { ospf?: boolean; linkArea?: number; passive?: string[] } = {}) {
  const r1Dev = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: r1.ospf ? { routerId: '1.1.1.1', networks: [NET_LAN1, ['10.0.0.0', '0.0.0.3', r1.linkArea ?? 0]], passiveInterfaces: r1.passive } : undefined,
  });
  const r2Dev = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: { routerId: '2.2.2.2', networks: [NET_LAN2, NET_LINK], passiveInterfaces: ['g0/0'] },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1Dev, r2Dev],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B']],
  });
}

/**
 * R1 (192.168.1.0/24) --10.0.12.0/30-- R2 (192.168.2.0/24) --10.0.23.0/30-- R3 (192.168.3.0/24)
 */
export function chain3(ospf: { R1?: boolean; R2?: boolean; R3?: boolean }, primary = 'R1') {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.12.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: ospf.R1 ? { routerId: '1.1.1.1', networks: [NET_LAN1, ['10.0.12.0', '0.0.0.3', 0]], passiveInterfaces: ['g0/0'] } : undefined,
  });
  const r2 = createRouter({
    hostname: 'R2',
    ports: 3,
    interfaces: {
      'g0/0': { description: 'LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false },
      'g0/1': { description: 'Link to R1', ipAddress: '10.0.12.2', subnetMask: '255.255.255.252', shutdown: false },
      'g0/2': { description: 'Link to R3', ipAddress: '10.0.23.1', subnetMask: '255.255.255.252', shutdown: false },
    },
    ospf: ospf.R2 ? { routerId: '2.2.2.2', networks: [NET_LAN2, ['10.0.12.0', '0.0.0.3', 0], ['10.0.23.0', '0.0.0.3', 0]], passiveInterfaces: ['g0/0'] } : undefined,
  });
  const r3 = createRouter({
    hostname: 'R3',
    interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.3.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.23.2', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: ospf.R3 ? { routerId: '3.3.3.3', networks: [['192.168.3.0', '0.0.0.255', 0], ['10.0.23.0', '0.0.0.3', 0]], passiveInterfaces: ['g0/0'] } : undefined,
  });
  return buildNetwork({
    primary,
    devices: [r1, r2, r3],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' },
      { id: 'PC-C', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B'], ['R2:g0/2', 'R3:g0/1'], ['R3:g0/0', 'PC-C']],
  });
}

export const learnOspfLabs: Lab[] = [
  {
    id: 'os-01-turn-on-ospf',
    moduleId: MODULE,
    order: 1,
    title: 'Turn On OSPF',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Start an OSPF process, advertise your networks, watch a neighbour come up, and let the routers learn routes for you.',
    scenario:
      'Static routes worked for two sites, but the company is about to open five more. Time for a routing protocol. R2 already runs OSPF process 1 with router-id 2.2.2.2 in area 0.\n\nOn R1, start OSPF process 1 with router-id 1.1.1.1 and advertise both of its networks in area 0: the LAN 192.168.1.0/24 and the link 10.0.0.0/30. Confirm the neighbour with R2, look for the O route to 192.168.2.0/24, then ping PC-B from PC-A.',
    concepts: ['router ospf', 'router-id', 'network and wildcard masks', 'show ip ospf neighbor', 'O routes'],
    hints: [
      'router ospf 1 enters (config-router)#. router-id 1.1.1.1 gives the process a stable identity.',
      'Wildcard masks invert subnet masks: network 192.168.1.0 0.0.0.255 area 0 covers the /24.',
      'The /30 link needs network 10.0.0.0 0.0.0.3 area 0.',
      'show ip ospf neighbor should list 2.2.2.2 as FULL. show ip route now has an O route to 192.168.2.0/24.',
    ],
    createState: () => twoSites(),
    objectives: [
      { id: 'process', label: 'Start OSPF process 1 with router-id 1.1.1.1', checks: [{ type: 'ospf', processId: 1, routerId: '1.1.1.1' }] },
      { id: 'networks', label: 'Advertise both networks in area 0', checks: [{ type: 'ospf-network', address: '192.168.1.0', wildcard: '0.0.0.255', area: 0 }, { type: 'ospf-network', address: '10.0.0.0', wildcard: '0.0.0.3', area: 0 }] },
      { id: 'neighbor', label: 'Form a neighbour relationship with R2', checks: [{ type: 'command', pattern: '^(do )?show ip ospf neighbor$' }, { type: 'ospf-neighbors', min: 1, routerId: '2.2.2.2', label: 'R2 (2.2.2.2) is an OSPF neighbour' }] },
      { id: 'route', label: 'Learn the remote LAN through OSPF', checks: [{ type: 'learned-route', destination: '192.168.2.0', mask: '255.255.255.0', source: 'ospf', label: 'O 192.168.2.0/24 is in the routing table' }] },
      { id: 'ping', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'ping 192.168.2.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'os-02-three-routers',
    moduleId: MODULE,
    order: 2,
    title: 'Three Routers, One Area',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Bring the middle router into the OSPF area so the two edge sites can finally see each other.',
    scenario:
      'R1 and R3 both run OSPF in area 0, but they sit on opposite sides of R2, which has no OSPF configuration at all. Without R2 in the area nothing is learned.\n\nConfigure OSPF process 1 on R2 with router-id 2.2.2.2 and advertise all three of its networks: 192.168.2.0/24, 10.0.12.0/30 and 10.0.23.0/30. R2 should end up with two neighbours, R1 should learn 192.168.3.0/24 with a metric of 3, and PC-A should reach PC-C.',
    concepts: ['Transit routers', 'Multiple network statements', 'Metric accumulation', 'show ip route ospf'],
    hints: [
      'On R2: router ospf 1, router-id 2.2.2.2.',
      'Three network statements: 192.168.2.0 0.0.0.255, 10.0.12.0 0.0.0.3 and 10.0.23.0 0.0.0.3, all area 0.',
      'show ip ospf neighbor on R2 lists both 1.1.1.1 and 3.3.3.3.',
      'On R1, show ip route ospf shows 192.168.3.0/24 [110/3]: three Gigabit hops of cost 1.',
    ],
    createState: () => chain3({ R1: true, R3: true }, 'R2'),
    objectives: [
      { id: 'process', label: 'Start OSPF on R2 with router-id 2.2.2.2', checks: [{ type: 'ospf', processId: 1, routerId: '2.2.2.2' }] },
      { id: 'networks', label: 'Advertise all three networks', checks: [{ type: 'ospf-network', address: '192.168.2.0', wildcard: '0.0.0.255', area: 0 }, { type: 'ospf-network', address: '10.0.12.0', wildcard: '0.0.0.3', area: 0 }, { type: 'ospf-network', address: '10.0.23.0', wildcard: '0.0.0.3', area: 0 }] },
      { id: 'neighbors', label: 'Two neighbours on R2', checks: [{ type: 'ospf-neighbors', min: 2 }] },
      { id: 'learned', label: 'R1 learns the far LAN', checks: [{ type: 'learned-route', device: 'R1', destination: '192.168.3.0', mask: '255.255.255.0', source: 'ospf', label: 'R1 has an O route to 192.168.3.0/24' }] },
      { id: 'ping', label: 'PC-A reaches PC-C', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.3.10', success: true, label: 'ping 192.168.3.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'os-03-passive-interfaces',
    moduleId: MODULE,
    order: 3,
    title: 'Quiet on the LAN',
    difficulty: 'Intermediate',
    estimatedMinutes: 6,
    description: 'Stop sending OSPF hellos toward user LANs without removing those networks from OSPF.',
    scenario:
      'Security noticed R1 sending OSPF hello packets onto the user LAN every ten seconds. Nobody on 192.168.1.0/24 should ever become a neighbour, and the hellos leak topology information.\n\nMake g0/0 passive on R1. The LAN must still be advertised (R2 keeps its route), and the neighbour on the R1 to R2 link must stay up. Confirm with show ip protocols.',
    concepts: ['passive-interface', 'Advertising versus neighbouring', 'show ip protocols'],
    hints: [
      'router ospf 1, then passive-interface g0/0.',
      'A passive interface still appears under Routing for Networks; it just sends no hellos.',
      'show ip protocols lists g0/0 under Passive Interface(s). show ip ospf neighbor still shows 2.2.2.2.',
    ],
    createState: () => twoSites({ ospf: true }),
    objectives: [
      { id: 'passive', label: 'Make g0/0 passive', checks: [{ type: 'passive-interface', name: 'g0/0' }] },
      { id: 'still-adjacent', label: 'Keep the neighbour with R2', checks: [{ type: 'ospf-neighbors', min: 1, routerId: '2.2.2.2' }, { type: 'passive-interface', name: 'g0/1', passive: false, label: 'g0/1 is still active' }] },
      { id: 'verify', label: 'Verify with show ip protocols', checks: [{ type: 'command', pattern: '^(do )?show ip protocols$' }] },
      { id: 'reach', label: 'Routing still works', checks: [{ type: 'ping', device: 'PC-B', target: '192.168.1.10', success: true, label: 'ping 192.168.1.10 from PC-B succeeds' }] },
    ],
  },
  {
    id: 'os-04-neighbor-never-forms',
    moduleId: MODULE,
    order: 4,
    title: 'Troubleshoot: The Neighbour That Never Forms',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Both routers run OSPF, yet show ip ospf neighbor is empty. Find the mismatch.',
    scenario:
      'A colleague configured OSPF on R1 and R2 last night and reported "done". This morning PC-A still cannot reach PC-B and neither router lists a neighbour.\n\nCompare the OSPF configuration on both routers. One of the classic neighbour requirements is not met on the R1 to R2 link. Fix it on R1 without touching R2.',
    concepts: ['Neighbour requirements', 'Area mismatch', 'show ip ospf interface brief', 'no network'],
    hints: [
      'show ip ospf neighbor is empty on both routers. show ip ospf interface brief on each router shows which area every interface is in.',
      'R1 put the 10.0.0.0/30 link in area 1. R2 has it in area 0. Neighbours must agree on the area.',
      'In router ospf 1: no network 10.0.0.0 0.0.0.3 area 1, then network 10.0.0.0 0.0.0.3 area 0.',
    ],
    createState: () => twoSites({ ospf: true, linkArea: 1 }),
    objectives: [
      { id: 'inspect', label: 'Inspect the neighbour table', checks: [{ type: 'command', pattern: '^(do )?show ip ospf (neighbor|interface( brief)?)$', label: 'Run show ip ospf neighbor or show ip ospf interface brief' }] },
      { id: 'remove', label: 'Remove the wrong network statement', checks: [{ type: 'ospf-network-absent', address: '10.0.0.0', wildcard: '0.0.0.3', area: 1 }] },
      { id: 'add', label: 'Put the link in area 0', checks: [{ type: 'ospf-network', address: '10.0.0.0', wildcard: '0.0.0.3', area: 0 }] },
      { id: 'neighbor', label: 'Neighbour forms with R2', checks: [{ type: 'ospf-neighbors', min: 1, routerId: '2.2.2.2' }] },
      { id: 'ping', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'ping 192.168.2.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'os-05-default-information-originate',
    moduleId: MODULE,
    order: 5,
    title: 'Advertise the Way Out',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Give the edge router a default route to the ISP and let OSPF hand it to everyone else.',
    scenario:
      'R1 is the edge router: it connects to the ISP at 203.0.113.1 and to R2 over 10.0.0.0/30. R1 and R2 already share an OSPF area, but neither knows how to reach the internet.\n\nAdd a default route on R1 via the ISP, then inject it into OSPF with default-information originate. R2 should learn an O*E2 default and PC-B should reach 8.8.8.8.',
    concepts: ['Default route', 'default-information originate', 'O*E2 external routes'],
    hints: [
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1 on R1.',
      'router ospf 1, then default-information originate. OSPF only advertises the default while R1 actually has one.',
      'On R2, show ip route shows O*E2 0.0.0.0/0 with the gateway of last resort pointing at R1.',
      'From PC-B, ping 8.8.8.8.',
    ],
    createState: () => {
      const r1 = createRouter({
        hostname: 'R1',
        interfaces: { 'g0/0': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { description: 'Link to ISP', ipAddress: '203.0.113.2', subnetMask: '255.255.255.252', shutdown: false } },
        ospf: { routerId: '1.1.1.1', networks: [NET_LINK] },
      });
      const r2 = createRouter({
        hostname: 'R2',
        interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
        ospf: { routerId: '2.2.2.2', networks: [NET_LAN2, NET_LINK], passiveInterfaces: ['g0/0'] },
      });
      const isp = createRouter({
        hostname: 'ISP',
        interfaces: { 'g0/0': { description: 'Customer link', ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { description: 'Public DNS (simulated)', ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' } },
        staticRoutes: [{ destination: '192.168.0.0', mask: '255.255.0.0', nextHop: '203.0.113.2' }, { destination: '10.0.0.0', mask: '255.0.0.0', nextHop: '203.0.113.2' }],
      });
      return buildNetwork({ primary: 'R1', devices: [r1, r2, isp], hosts: [{ id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' }], links: [['R1:g0/0', 'R2:g0/1'], ['R2:g0/0', 'PC-B'], ['R1:g0/1', 'ISP:g0/0']] });
    },
    objectives: [
      { id: 'default', label: 'Add a default route on R1', checks: [{ type: 'route', destination: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.1', label: 'ip route 0.0.0.0 0.0.0.0 203.0.113.1' }] },
      { id: 'originate', label: 'Inject it into OSPF', checks: [{ type: 'default-information-originate' }] },
      { id: 'learned', label: 'R2 learns an external default', checks: [{ type: 'learned-route', device: 'R2', destination: '0.0.0.0', mask: '0.0.0.0', source: 'ospf-external', label: 'R2 has O*E2 0.0.0.0/0' }] },
      { id: 'ping', label: 'PC-B reaches the internet', checks: [{ type: 'ping', device: 'PC-B', target: '8.8.8.8', success: true, label: 'ping 8.8.8.8 from PC-B succeeds' }] },
    ],
  },
  {
    id: 'os-06-exam-ospf-campus',
    moduleId: MODULE,
    order: 6,
    title: 'Exam: OSPF Across the Campus',
    difficulty: 'Advanced',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Bring three addressed routers into one OSPF area with stable router IDs and quiet LANs.',
    scenario:
      'Three routers are addressed and cabled in a line but run no routing protocol. Configure OSPF process 1 in area 0 on all of them:\n\n- Router IDs 1.1.1.1, 2.2.2.2 and 3.3.3.3\n- Every LAN and link advertised\n- LAN interfaces (g0/0 on each router) passive\n- Save all three\n\nProve it: PC-A reaches PC-C and PC-B reaches PC-C. No hints are available.',
    concepts: ['Synthesis', 'Single-area OSPF', 'Passive interfaces'],
    hints: [],
    createState: () => chain3({}),
    objectives: [
      { id: 'r1', label: 'OSPF on R1', checks: [{ type: 'ospf', device: 'R1', processId: 1, routerId: '1.1.1.1' }, { type: 'passive-interface', device: 'R1', name: 'g0/0' }, { type: 'passive-interface', device: 'R1', name: 'g0/1', passive: false, label: 'R1 g0/1 runs OSPF and is active' }] },
      { id: 'r2', label: 'OSPF on R2', checks: [{ type: 'ospf', device: 'R2', processId: 1, routerId: '2.2.2.2' }, { type: 'passive-interface', device: 'R2', name: 'g0/0' }, { type: 'ospf-neighbors', device: 'R2', min: 2, label: 'R2 has two neighbours' }] },
      { id: 'r3', label: 'OSPF on R3', checks: [{ type: 'ospf', device: 'R3', processId: 1, routerId: '3.3.3.3' }, { type: 'passive-interface', device: 'R3', name: 'g0/0' }, { type: 'passive-interface', device: 'R3', name: 'g0/1', passive: false, label: 'R3 g0/1 runs OSPF and is active' }] },
      { id: 'routes', label: 'Routes are learned end to end', checks: [{ type: 'learned-route', device: 'R1', destination: '192.168.3.0', mask: '255.255.255.0', source: 'ospf' }, { type: 'learned-route', device: 'R3', destination: '192.168.1.0', mask: '255.255.255.0', source: 'ospf' }] },
      { id: 'ping', label: 'Hosts reach each other', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.3.10', success: true, label: 'ping 192.168.3.10 from PC-A succeeds' }, { type: 'ping', device: 'PC-B', target: '192.168.3.10', success: true, label: 'ping 192.168.3.10 from PC-B succeeds' }] },
      { id: 'save', label: 'Save all routers', checks: [{ type: 'saved', device: 'R1' }, { type: 'saved', device: 'R2' }, { type: 'saved', device: 'R3' }] },
    ],
  },
];
