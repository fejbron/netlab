import { buildNetwork, createRouter, createSwitch, type NetworkState } from '../../engine';
import type { Lab } from '../types';
import { chain3 } from './learn-ospf';

const MODULE = 'ccna-exams';

const UNUSED = ['g0/3', 'g0/4', 'g0/5', 'g0/6', 'g0/7'];

/**
 * Sales/HR campus behind a router-on-a-stick, plus a remote site over OSPF:
 *   PC-A (VLAN 10), PC-B (VLAN 20) - SW1 g0/8 --- R1 g0/0 | R1 g0/1 --10.0.0.0/30-- R2 g0/1 | R2 g0/0 - PC-C (192.168.30.0/24)
 * `faults` injects the troubleshooting-marathon problems into an otherwise working network.
 */
function campus(opts: { r1Configured: boolean; faults?: boolean }): NetworkState {
  const sw = createSwitch({
    hostname: 'SW1',
    ports: 8,
    vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }, ...(opts.faults ? [{ id: 30, name: 'GUEST' }] : [])],
    interfaces: {
      'g0/1': { mode: 'access', accessVlan: opts.faults ? 30 : 10, description: 'Sales PC' },
      'g0/2': { mode: 'access', accessVlan: 20, description: 'HR PC' },
      'g0/8': { mode: 'trunk', description: 'Trunk to R1', trunkAllowed: opts.faults ? [10] : 'all' },
    },
  });
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: opts.r1Configured
      ? {
          'g0/0': { description: 'Trunk to SW1', shutdown: false },
          'g0/0.10': { encapsulation: { vlan: 10, native: false }, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0' },
          'g0/0.20': { encapsulation: { vlan: 20, native: false }, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0' },
          'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: Boolean(opts.faults) },
        }
      : { 'g0/0': { description: 'Trunk to SW1' }, 'g0/1': { description: 'Link to R2' } },
    ospf: opts.r1Configured ? { routerId: '1.1.1.1', networks: [['192.168.10.0', '0.0.0.255', 0], ['192.168.20.0', '0.0.0.255', 0], ['10.0.0.0', '0.0.0.3', 0]], passiveInterfaces: ['g0/0.10', 'g0/0.20'] } : undefined,
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.30.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: { routerId: '2.2.2.2', networks: opts.faults ? [['10.0.0.0', '0.0.0.3', 0]] : [['192.168.30.0', '0.0.0.255', 0], ['10.0.0.0', '0.0.0.3', 0]], passiveInterfaces: ['g0/0'] },
  });
  return buildNetwork({
    primary: opts.faults ? 'SW1' : 'R1',
    devices: [sw, r1, r2],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
      { id: 'PC-B', ip: '192.168.20.10', mask: '255.255.255.0', gateway: '192.168.20.1' },
      { id: 'PC-C', ip: '192.168.30.10', mask: '255.255.255.0', gateway: '192.168.30.1' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-C']],
  });
}

export const ccnaExamLabs: Lab[] = [
  {
    id: 'ex-01-two-switch-vlan-campus',
    moduleId: MODULE,
    order: 1,
    title: 'Exam: Two-Switch VLAN Campus',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Build matching VLANs on two switches, trunk them together with a dedicated native VLAN, and add management addresses.',
    scenario:
      'Two factory-default switches serve one floor. PC-A and PC-C are Sales; PC-B and PC-D are HR. Build the switching layer from the design sheet:\n\n- On both switches: VLAN 10 SALES, VLAN 20 HR, VLAN 99 MGMT\n- SW1 g0/1 and SW2 g0/1 static access in VLAN 10; SW1 g0/2 and SW2 g0/2 static access in VLAN 20\n- g0/8 on both switches: trunk carrying VLANs 10, 20 and 99, native VLAN 99\n- Management: SW1 interface Vlan99 10.0.99.1/24, SW2 interface Vlan99 10.0.99.2/24, both up\n- Save both switches\n\nProve it: PC-A pings PC-C (192.168.10.12), PC-B pings PC-D (192.168.20.12), and SW1 pings SW2 at 10.0.99.2. No hints are available.',
    concepts: ['VLANs', 'Trunking', 'Native VLAN', 'Management SVI'],
    hints: [],
    createState: () =>
      buildNetwork({
        primary: 'SW1',
        devices: [createSwitch({ hostname: 'SW1', ports: 8 }), createSwitch({ hostname: 'SW2', ports: 8 })],
        hosts: [
          { id: 'PC-A', ip: '192.168.10.11', mask: '255.255.255.0' },
          { id: 'PC-B', ip: '192.168.20.11', mask: '255.255.255.0' },
          { id: 'PC-C', ip: '192.168.10.12', mask: '255.255.255.0' },
          { id: 'PC-D', ip: '192.168.20.12', mask: '255.255.255.0' },
        ],
        links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['PC-C', 'SW2:g0/1'], ['PC-D', 'SW2:g0/2'], ['SW1:g0/8', 'SW2:g0/8']],
      }),
    objectives: [
      { id: 'vlans', label: 'VLANs on both switches', checks: [...['SW1', 'SW2'].flatMap((d) => [{ type: 'vlan-exists' as const, device: d, id: 10, name: 'SALES', label: `${d}: VLAN 10 SALES` }, { type: 'vlan-exists' as const, device: d, id: 20, name: 'HR', label: `${d}: VLAN 20 HR` }, { type: 'vlan-exists' as const, device: d, id: 99, name: 'MGMT', label: `${d}: VLAN 99 MGMT` }])] },
      { id: 'access', label: 'Access ports', checks: ['SW1', 'SW2'].flatMap((d) => [{ type: 'interface' as const, device: d, name: 'g0/1', mode: 'access' as const, accessVlan: 10, label: `${d} g0/1 is access in VLAN 10` }, { type: 'interface' as const, device: d, name: 'g0/2', mode: 'access' as const, accessVlan: 20, label: `${d} g0/2 is access in VLAN 20` }]) },
      { id: 'trunk', label: 'Trunk between the switches', checks: ['SW1', 'SW2'].flatMap((d) => [{ type: 'interface' as const, device: d, name: 'g0/8', mode: 'trunk' as const, nativeVlan: 99, label: `${d} g0/8 is a trunk with native VLAN 99` }, { type: 'trunk-allows' as const, device: d, name: 'g0/8', vlans: [10, 20, 99], label: `${d} g0/8 carries VLANs 10, 20 and 99` }]) },
      { id: 'mgmt', label: 'Management addresses', checks: [{ type: 'interface', device: 'SW1', name: 'vlan99', ipAddress: '10.0.99.1', subnetMask: '255.255.255.0', shutdown: false, label: 'SW1 Vlan99 is 10.0.99.1/24 and up' }, { type: 'interface', device: 'SW2', name: 'vlan99', ipAddress: '10.0.99.2', subnetMask: '255.255.255.0', shutdown: false, label: 'SW2 Vlan99 is 10.0.99.2/24 and up' }] },
      { id: 'ping', label: 'Connectivity', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.12', success: true, label: 'PC-A pings PC-C' }, { type: 'ping', device: 'PC-B', target: '192.168.20.12', success: true, label: 'PC-B pings PC-D' }, { type: 'ping', device: 'SW1', target: '10.0.99.2', success: true, label: 'SW1 pings SW2 management address' }] },
      { id: 'save', label: 'Save both switches', checks: [{ type: 'saved', device: 'SW1' }, { type: 'saved', device: 'SW2' }] },
    ],
  },
  {
    id: 'ex-02-static-routing-three-sites',
    moduleId: MODULE,
    order: 2,
    title: 'Exam: Static Routing Across Three Sites',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Give three addressed routers complete static reachability in every direction.',
    scenario:
      'Three sites are cabled in a line and every interface is addressed, but no router knows about any LAN except its own:\n\n- R1: LAN 192.168.1.0/24, link to R2 10.0.12.0/30\n- R2: LAN 192.168.2.0/24, links 10.0.12.0/30 (R1) and 10.0.23.0/30 (R3)\n- R3: LAN 192.168.3.0/24, link to R2 10.0.23.0/30\n\nAdd static routes so every LAN can reach every other LAN. R1 and R3 each need routes to two remote LANs; R2 needs routes to both edge LANs. Prove it with pings from PC-A to PC-C, PC-C to PC-B and PC-B to PC-A, then save all three routers. No hints are available.',
    concepts: ['Static routes', 'Return paths', 'Transit routers'],
    hints: [],
    createState: () => chain3({}),
    objectives: [
      { id: 'r1', label: 'R1 routes', checks: [{ type: 'route', device: 'R1', destination: '192.168.2.0', mask: '255.255.255.0', via: '10.0.12.2' }, { type: 'route', device: 'R1', destination: '192.168.3.0', mask: '255.255.255.0', via: '10.0.12.2' }] },
      { id: 'r2', label: 'R2 routes', checks: [{ type: 'route', device: 'R2', destination: '192.168.1.0', mask: '255.255.255.0', via: '10.0.12.1' }, { type: 'route', device: 'R2', destination: '192.168.3.0', mask: '255.255.255.0', via: '10.0.23.2' }] },
      { id: 'r3', label: 'R3 routes', checks: [{ type: 'route', device: 'R3', destination: '192.168.1.0', mask: '255.255.255.0', via: '10.0.23.1' }, { type: 'route', device: 'R3', destination: '192.168.2.0', mask: '255.255.255.0', via: '10.0.23.1' }] },
      { id: 'ping', label: 'Reachability', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.3.10', success: true, label: 'PC-A pings PC-C' }, { type: 'ping', device: 'PC-C', target: '192.168.2.10', success: true, label: 'PC-C pings PC-B' }, { type: 'ping', device: 'PC-B', target: '192.168.1.10', success: true, label: 'PC-B pings PC-A' }] },
      { id: 'save', label: 'Save all routers', checks: [{ type: 'saved', device: 'R1' }, { type: 'saved', device: 'R2' }, { type: 'saved', device: 'R3' }] },
    ],
  },
  {
    id: 'ex-03-intervlan-routing-ospf',
    moduleId: MODULE,
    order: 3,
    title: 'Exam: Inter-VLAN Routing and OSPF',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Route between two VLANs on a stick and share them with a remote site over OSPF.',
    scenario:
      'SW1 is finished: Sales (VLAN 10) and HR (VLAN 20) are assigned and g0/8 trunks to R1 g0/0. R2 at the remote site is finished too: 192.168.30.0/24 behind it, 10.0.0.2/30 toward R1, OSPF process 1 with router-id 2.2.2.2 in area 0.\n\nR1 is factory default. Configure it:\n\n- g0/0 up, with g0/0.10 (dot1Q 10, 192.168.10.1/24) and g0/0.20 (dot1Q 20, 192.168.20.1/24)\n- g0/1 10.0.0.1/30, up\n- OSPF process 1, router-id 1.1.1.1, all three networks in area 0\n- Save\n\nProve it: PC-A pings PC-C (192.168.30.10) and PC-B pings PC-A. No hints are available.',
    concepts: ['Router on a stick', 'OSPF', 'Synthesis'],
    hints: [],
    createState: () => campus({ r1Configured: false }),
    objectives: [
      { id: 'roas', label: 'Router on a stick', checks: [{ type: 'interface', name: 'g0/0', shutdown: false, label: 'g0/0 is up' }, { type: 'interface', name: 'g0/0.10', encapsulation: 10, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', label: 'g0/0.10: dot1Q 10, 192.168.10.1/24' }, { type: 'interface', name: 'g0/0.20', encapsulation: 20, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0', label: 'g0/0.20: dot1Q 20, 192.168.20.1/24' }] },
      { id: 'wan', label: 'Link to R2', checks: [{ type: 'interface', name: 'g0/1', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false, label: 'g0/1 is 10.0.0.1/30 and up' }] },
      { id: 'ospf', label: 'OSPF on R1', checks: [{ type: 'ospf', processId: 1, routerId: '1.1.1.1' }, { type: 'ospf-network', address: '192.168.10.0', wildcard: '0.0.0.255', area: 0 }, { type: 'ospf-network', address: '192.168.20.0', wildcard: '0.0.0.255', area: 0 }, { type: 'ospf-network', address: '10.0.0.0', wildcard: '0.0.0.3', area: 0 }, { type: 'learned-route', destination: '192.168.30.0', mask: '255.255.255.0', source: 'ospf', label: 'R1 learns 192.168.30.0/24 via OSPF' }] },
      { id: 'ping', label: 'Reachability', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.30.10', success: true, label: 'PC-A pings PC-C' }, { type: 'ping', device: 'PC-B', target: '192.168.10.10', success: true, label: 'PC-B pings PC-A' }] },
      { id: 'save', label: 'Save R1', checks: [{ type: 'saved' }] },
    ],
  },
  {
    id: 'ex-04-troubleshooting-marathon',
    moduleId: MODULE,
    order: 4,
    title: 'Exam: Troubleshooting Marathon',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Four independent faults across a switch and two routers. Find and fix every one without breaking what works.',
    scenario:
      'This network worked yesterday. Today: PC-A cannot reach anything, PC-B cannot reach PC-A, and nobody can reach PC-C at the remote site.\n\nThe design: Sales is VLAN 10 (192.168.10.0/24) on SW1 g0/1, HR is VLAN 20 (192.168.20.0/24) on SW1 g0/2, SW1 g0/8 trunks to R1 which routes between the VLANs on subinterfaces, R1 g0/1 links to R2 over 10.0.0.0/30, and OSPF area 0 carries 192.168.30.0/24 from R2.\n\nThere are four faults spread across SW1, R1 and R2. Use show commands on every device, fix each fault at its source, and verify with pings from PC-A to PC-B, PC-A to PC-C and PC-C to PC-B. No hints are available.',
    concepts: ['Structured troubleshooting', 'VLAN assignment', 'Trunk pruning', 'Interface state', 'OSPF network statements'],
    hints: [],
    createState: () => campus({ r1Configured: true, faults: true }),
    objectives: [
      { id: 'vlan', label: 'PC-A is back in the Sales VLAN', checks: [{ type: 'interface', device: 'SW1', name: 'g0/1', accessVlan: 10, label: 'SW1 g0/1 is in VLAN 10' }] },
      { id: 'trunk', label: 'The trunk carries both VLANs', checks: [{ type: 'trunk-allows', device: 'SW1', name: 'g0/8', vlans: [10, 20], label: 'SW1 g0/8 allows VLANs 10 and 20' }] },
      { id: 'link', label: 'The R1 to R2 link is up', checks: [{ type: 'interface', device: 'R1', name: 'g0/1', shutdown: false, label: 'R1 g0/1 is no longer shut down' }] },
      { id: 'ospf', label: 'R2 advertises its LAN', checks: [{ type: 'ospf-network', device: 'R2', address: '192.168.30.0', wildcard: '0.0.0.255', area: 0, label: 'R2 has network 192.168.30.0 0.0.0.255 area 0' }] },
      { id: 'keep', label: 'Nothing else changed', checks: [{ type: 'interface', device: 'SW1', name: 'g0/2', accessVlan: 20, label: 'SW1 g0/2 is still in VLAN 20' }, { type: 'ospf', device: 'R1', processId: 1, routerId: '1.1.1.1', label: 'R1 OSPF is intact' }] },
      { id: 'ping', label: 'Everything reachable again', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.20.10', success: true, label: 'PC-A pings PC-B' }, { type: 'ping', device: 'PC-A', target: '192.168.30.10', success: true, label: 'PC-A pings PC-C' }, { type: 'ping', device: 'PC-C', target: '192.168.20.10', success: true, label: 'PC-C pings PC-B' }] },
    ],
  },
  {
    id: 'ex-05-secure-branch',
    moduleId: MODULE,
    order: 5,
    title: 'Exam: Secure the Branch',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Harden a working branch switch and router to the company standard without breaking connectivity.',
    scenario:
      'The branch works: PC-A (192.168.1.10) sits on SW1 and reaches its gateway R1 at 192.168.1.1. Apply the hardening standard to both devices:\n\nSW1: enable secret Sw1tch!, domain lab.local, 2048-bit RSA keys, SSH version 2, user admin privilege 15 secret Adm1n-Sw, VTY lines with login local and SSH only, unused ports g0/3 to g0/7 shut down.\n\nR1: enable secret R0uter!, a MOTD banner containing Authorized, service password-encryption, domain lab.local, 2048-bit RSA keys, SSH version 2, user admin privilege 15 secret Adm1n-Rt, VTY lines with login local and SSH only.\n\nSave both devices and confirm PC-A still pings 192.168.1.1. No hints are available.',
    concepts: ['Device hardening', 'SSH', 'Unused ports', 'Change without disruption'],
    hints: [],
    createState: () =>
      buildNetwork({
        primary: 'SW1',
        devices: [
          createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'PC-A' }, 'g0/8': { description: 'Uplink to R1' } } }),
          createRouter({ hostname: 'R1', interfaces: { 'g0/0': { description: 'Branch LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false } } }),
        ],
        hosts: [{ id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }],
        links: [['PC-A', 'SW1:g0/1'], ['SW1:g0/8', 'R1:g0/0']],
      }),
    objectives: [
      { id: 'sw-secrets', label: 'SW1 secrets and SSH', checks: [{ type: 'enable-secret', device: 'SW1', equals: 'Sw1tch!' }, { type: 'domain-name', device: 'SW1', equals: 'lab.local' }, { type: 'ssh-ready', device: 'SW1' }, { type: 'command', device: 'SW1', pattern: '^ip ssh version 2$', label: 'SW1: ip ssh version 2' }, { type: 'user', device: 'SW1', username: 'admin', privilege: 15, secret: true }, { type: 'line', device: 'SW1', line: 'vty', login: 'local', transportInput: 'ssh', label: 'SW1 VTY lines: login local, SSH only' }] },
      { id: 'sw-ports', label: 'SW1 unused ports shut down', checks: UNUSED.map((p) => ({ type: 'interface' as const, device: 'SW1', name: p, shutdown: true, label: `SW1 ${p} is shut down` })) },
      { id: 'rt', label: 'R1 hardening', checks: [{ type: 'enable-secret', device: 'R1', equals: 'R0uter!' }, { type: 'banner', device: 'R1', contains: 'Authorized' }, { type: 'password-encryption', device: 'R1' }, { type: 'domain-name', device: 'R1', equals: 'lab.local' }, { type: 'ssh-ready', device: 'R1' }, { type: 'command', device: 'R1', pattern: '^ip ssh version 2$', label: 'R1: ip ssh version 2' }, { type: 'user', device: 'R1', username: 'admin', privilege: 15, secret: true }, { type: 'line', device: 'R1', line: 'vty', login: 'local', transportInput: 'ssh', label: 'R1 VTY lines: login local, SSH only' }] },
      { id: 'keep', label: 'Connectivity preserved', checks: [{ type: 'interface', device: 'SW1', name: 'g0/1', shutdown: false, label: 'SW1 g0/1 still serves PC-A' }, { type: 'interface', device: 'SW1', name: 'g0/8', shutdown: false, label: 'SW1 g0/8 still links to R1' }, { type: 'ping', device: 'PC-A', target: '192.168.1.1', success: true, label: 'PC-A pings R1' }] },
      { id: 'save', label: 'Save both devices', checks: [{ type: 'saved', device: 'SW1' }, { type: 'saved', device: 'R1' }] },
    ],
  },
  {
    id: 'ex-06-final-capstone',
    moduleId: MODULE,
    order: 6,
    title: 'Exam: Final Capstone',
    difficulty: 'Advanced',
    estimatedMinutes: 40,
    isExam: true,
    description: 'From factory default to a working, routed, internet-connected campus: switching, router on a stick, OSPF, a default route, and the basics of hardening.',
    scenario:
      'Everything except the ISP is factory default. Build the whole network:\n\nSW1: VLAN 10 SALES and VLAN 20 HR; g0/1 access VLAN 10 (PC-A), g0/2 access VLAN 20 (PC-B); g0/8 trunk to R1; enable secret Capst0ne!\n\nR1: g0/0 up with g0/0.10 (dot1Q 10, 192.168.10.1/24) and g0/0.20 (dot1Q 20, 192.168.20.1/24); g0/1 10.0.0.1/30 to R2; OSPF process 1, router-id 1.1.1.1, area 0 for all networks; enable secret Capst0ne!\n\nR2: g0/1 10.0.0.2/30 to R1; g0/0 203.0.113.2/30 to the ISP; OSPF process 1, router-id 2.2.2.2, network 10.0.0.0/30 in area 0; default route to the ISP at 203.0.113.1 injected with default-information originate; enable secret Capst0ne!\n\nSave all three devices. Prove it: PC-A pings PC-B, and both PC-A and PC-B ping 8.8.8.8. No hints are available.',
    concepts: ['Capstone', 'VLANs and trunks', 'Router on a stick', 'OSPF', 'Default routes', 'Hardening'],
    hints: [],
    createState: () => {
      const sw = createSwitch({ hostname: 'SW1', ports: 8 });
      const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { description: 'Trunk to SW1' }, 'g0/1': { description: 'Link to R2' } } });
      const r2 = createRouter({ hostname: 'R2', interfaces: { 'g0/0': { description: 'Link to ISP' }, 'g0/1': { description: 'Link to R1' } } });
      const isp = createRouter({
        hostname: 'ISP',
        interfaces: { 'g0/0': { description: 'Customer link', ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { description: 'Public DNS (simulated)', ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' } },
        staticRoutes: [{ destination: '192.168.0.0', mask: '255.255.0.0', nextHop: '203.0.113.2' }, { destination: '10.0.0.0', mask: '255.0.0.0', nextHop: '203.0.113.2' }],
      });
      return buildNetwork({
        primary: 'SW1',
        devices: [sw, r1, r2, isp],
        hosts: [
          { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
          { id: 'PC-B', ip: '192.168.20.10', mask: '255.255.255.0', gateway: '192.168.20.1' },
        ],
        links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'ISP:g0/0']],
      });
    },
    objectives: [
      { id: 'sw', label: 'SW1 switching', checks: [{ type: 'vlan-exists', device: 'SW1', id: 10, name: 'SALES' }, { type: 'vlan-exists', device: 'SW1', id: 20, name: 'HR' }, { type: 'interface', device: 'SW1', name: 'g0/1', mode: 'access', accessVlan: 10, label: 'SW1 g0/1 is access in VLAN 10' }, { type: 'interface', device: 'SW1', name: 'g0/2', mode: 'access', accessVlan: 20, label: 'SW1 g0/2 is access in VLAN 20' }, { type: 'interface', device: 'SW1', name: 'g0/8', mode: 'trunk', label: 'SW1 g0/8 is a trunk' }, { type: 'trunk-allows', device: 'SW1', name: 'g0/8', vlans: [10, 20], label: 'SW1 g0/8 carries VLANs 10 and 20' }] },
      { id: 'r1', label: 'R1 router on a stick', checks: [{ type: 'interface', device: 'R1', name: 'g0/0', shutdown: false, label: 'R1 g0/0 is up' }, { type: 'interface', device: 'R1', name: 'g0/0.10', encapsulation: 10, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', label: 'R1 g0/0.10: dot1Q 10, 192.168.10.1/24' }, { type: 'interface', device: 'R1', name: 'g0/0.20', encapsulation: 20, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0', label: 'R1 g0/0.20: dot1Q 20, 192.168.20.1/24' }, { type: 'interface', device: 'R1', name: 'g0/1', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false, label: 'R1 g0/1 is 10.0.0.1/30 and up' }] },
      { id: 'r2', label: 'R2 addressing', checks: [{ type: 'interface', device: 'R2', name: 'g0/1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false, label: 'R2 g0/1 is 10.0.0.2/30 and up' }, { type: 'interface', device: 'R2', name: 'g0/0', ipAddress: '203.0.113.2', subnetMask: '255.255.255.252', shutdown: false, label: 'R2 g0/0 is 203.0.113.2/30 and up' }] },
      { id: 'ospf', label: 'OSPF between R1 and R2', checks: [{ type: 'ospf', device: 'R1', processId: 1, routerId: '1.1.1.1' }, { type: 'ospf', device: 'R2', processId: 1, routerId: '2.2.2.2' }, { type: 'ospf-neighbors', device: 'R1', min: 1, routerId: '2.2.2.2', label: 'R1 and R2 are neighbours' }, { type: 'learned-route', device: 'R2', destination: '192.168.10.0', mask: '255.255.255.0', source: 'ospf', label: 'R2 learns 192.168.10.0/24' }, { type: 'learned-route', device: 'R2', destination: '192.168.20.0', mask: '255.255.255.0', source: 'ospf', label: 'R2 learns 192.168.20.0/24' }] },
      { id: 'internet', label: 'Default route to the ISP', checks: [{ type: 'route', device: 'R2', destination: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.1', label: 'R2: ip route 0.0.0.0 0.0.0.0 203.0.113.1' }, { type: 'default-information-originate', device: 'R2' }, { type: 'learned-route', device: 'R1', destination: '0.0.0.0', mask: '0.0.0.0', source: 'ospf-external', label: 'R1 learns O*E2 0.0.0.0/0' }] },
      { id: 'secrets', label: 'Enable secrets', checks: [{ type: 'enable-secret', device: 'SW1', equals: 'Capst0ne!' }, { type: 'enable-secret', device: 'R1', equals: 'Capst0ne!' }, { type: 'enable-secret', device: 'R2', equals: 'Capst0ne!' }] },
      { id: 'ping', label: 'End-to-end reachability', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.20.10', success: true, label: 'PC-A pings PC-B' }, { type: 'ping', device: 'PC-A', target: '8.8.8.8', success: true, label: 'PC-A pings 8.8.8.8' }, { type: 'ping', device: 'PC-B', target: '8.8.8.8', success: true, label: 'PC-B pings 8.8.8.8' }] },
      { id: 'save', label: 'Save all three devices', checks: [{ type: 'saved', device: 'SW1' }, { type: 'saved', device: 'R1' }, { type: 'saved', device: 'R2' }] },
    ],
  },
];
