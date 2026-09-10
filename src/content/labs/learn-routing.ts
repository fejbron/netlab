import { buildNetwork, createRouter, createSwitch } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-routing';

/**
 * Two sites joined by a point-to-point link:
 *   PC-A (192.168.1.10) - R1 g0/0 | R1 g0/1 (10.0.0.1) --- (10.0.0.2) R2 g0/1 | R2 g0/0 - PC-B (192.168.2.10)
 * R2 is fully configured unless a lab says otherwise; R1 is the learner's device.
 */
function twoSites(opts: { r1Lan?: boolean; r1Wan?: boolean; r1Route?: boolean; r2Route?: boolean; r2Ready?: boolean } = {}) {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { description: 'LAN', ...(opts.r1Lan ? { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false } : {}) },
      'g0/1': { description: 'Link to R2', ...(opts.r1Wan ? { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } : {}) },
    },
    staticRoutes: opts.r1Route ? [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }] : [],
  });
  const ready = opts.r2Ready ?? true;
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: {
      'g0/0': { description: 'LAN', ...(ready ? { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false } : {}) },
      'g0/1': { description: 'Link to R1', ...(ready ? { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } : {}) },
    },
    staticRoutes: (opts.r2Route ?? true) ? [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }] : [],
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' },
    ],
    links: [
      ['PC-A', 'R1:g0/0'],
      ['R1:g0/1', 'R2:g0/1'],
      ['R2:g0/0', 'PC-B'],
    ],
  });
}

export const learnRoutingLabs: Lab[] = [
  {
    id: 'rt-01-meet-the-router',
    moduleId: MODULE,
    order: 1,
    title: 'Meet the Router',
    difficulty: 'Beginner',
    estimatedMinutes: 7,
    description: 'Bring up a router LAN interface, address it, and read your first routing table.',
    scenario:
      'A new router arrived for the branch. Unlike a switch, its ports are shut down out of the box and nothing works until you address them.\n\nLook at the interfaces, give g0/0 the LAN address 192.168.1.1/24, bring it up, then read the routing table and ping PC-A at 192.168.1.10.',
    concepts: ['Routed interfaces', 'ip address', 'no shutdown', 'Connected and local routes', 'show ip route'],
    hints: [
      'show ip interface brief shows every port administratively down. That is normal on a router.',
      'interface g0/0, ip address 192.168.1.1 255.255.255.0, no shutdown.',
      'show ip route now lists a C (connected) route for 192.168.1.0/24 and an L (local) route for the address itself.',
      'ping 192.168.1.10 from privileged mode.',
    ],
    createState: () => twoSites(),
    objectives: [
      { id: 'look', label: 'Inspect the interfaces', checks: [{ type: 'command', pattern: '^(do )?show ip interface brief$' }] },
      { id: 'address', label: 'Address and enable g0/0', checks: [{ type: 'interface', name: 'g0/0', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', label: 'g0/0 is 192.168.1.1 255.255.255.0' }, { type: 'interface', name: 'g0/0', shutdown: false, label: 'g0/0 is no longer shut down' }] },
      { id: 'table', label: 'Read the routing table', checks: [{ type: 'command', pattern: '^(do )?show ip route$' }] },
      { id: 'ping', label: 'Ping PC-A', checks: [{ type: 'ping', target: '192.168.1.10', success: true, label: 'ping 192.168.1.10 succeeds' }] },
    ],
  },
  {
    id: 'rt-02-connect-two-routers',
    moduleId: MODULE,
    order: 2,
    title: 'Connect Two Routers',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Address the point-to-point link to R2 with a /30 and prove the routers can reach each other.',
    scenario:
      'R1 already serves its LAN. The link to R2 uses the tiny network 10.0.0.0/30; R2 already has 10.0.0.2 on its side.\n\nConfigure g0/1 on R1 with 10.0.0.1 255.255.255.252, bring it up, confirm the connected route appears, and ping R2.',
    concepts: ['/30 point-to-point links', 'Subnet masks', 'Connected routes', 'ping'],
    hints: [
      'A /30 is 255.255.255.252: two usable addresses, one per router.',
      'interface g0/1, ip address 10.0.0.1 255.255.255.252, no shutdown.',
      'show ip route should now show 10.0.0.0/30 as directly connected.',
      'ping 10.0.0.2 tests the link.',
    ],
    createState: () => twoSites({ r1Lan: true }),
    objectives: [
      { id: 'address', label: 'Address and enable g0/1', checks: [{ type: 'interface', name: 'g0/1', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false, label: 'g0/1 is 10.0.0.1/30 and up' }] },
      { id: 'table', label: 'Confirm the connected route', checks: [{ type: 'command', pattern: '^(do )?show ip route' }] },
      { id: 'ping', label: 'Ping R2', checks: [{ type: 'ping', target: '10.0.0.2', success: true, label: 'ping 10.0.0.2 succeeds' }] },
    ],
  },
  {
    id: 'rt-03-first-static-route',
    moduleId: MODULE,
    order: 3,
    title: 'Your First Static Route',
    difficulty: 'Beginner',
    estimatedMinutes: 8,
    description: 'Teach R1 how to reach the remote LAN, then prove it from a PC.',
    scenario:
      'Both routers are addressed and the link works, yet PC-A cannot reach PC-B at 192.168.2.10. R1 has no idea where 192.168.2.0/24 lives.\n\nTry the ping from PC-A first to see the failure. Then add a static route on R1 pointing 192.168.2.0/24 at R2 (10.0.0.2), verify the S route in the table, and ping PC-B from PC-A again. R2 already knows the way back.',
    concepts: ['ip route', 'Next hop', 'Static routes in show ip route', 'Testing from the host'],
    hints: [
      'Open the PC-A tab and run ping 192.168.2.10. It times out because R1 drops the packet.',
      'On R1: ip route 192.168.2.0 255.255.255.0 10.0.0.2 in global configuration mode.',
      'show ip route now shows S 192.168.2.0/24 [1/0] via 10.0.0.2.',
      'Back on PC-A, ping 192.168.2.10 now gets replies.',
    ],
    createState: () => twoSites({ r1Lan: true, r1Wan: true }),
    objectives: [
      { id: 'before', label: 'See the failure from PC-A', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', label: 'PC-A pinged 192.168.2.10' }] },
      { id: 'route', label: 'Add the static route on R1', checks: [{ type: 'route', destination: '192.168.2.0', mask: '255.255.255.0', via: '10.0.0.2', label: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' }] },
      { id: 'verify', label: 'Verify the routing table', checks: [{ type: 'command', pattern: '^(do )?show ip route' }] },
      { id: 'after', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'ping 192.168.2.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'rt-04-missing-return-route',
    moduleId: MODULE,
    order: 4,
    title: 'Troubleshoot: Missing Return Route',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Packets reach the remote LAN but replies never come home. Find the router that is missing a route.',
    scenario:
      'Users on the R1 side complain PC-B is unreachable. You have console access to both routers.\n\nR1 looks right: it has a route to 192.168.2.0/24 and can ping R2. Use traceroute and the routing tables on both routers to work out why the reply cannot return, then fix it on the right device. Do not touch anything that already works.',
    concepts: ['Return path', 'traceroute', 'Reading two routing tables', 'Fixing the right device'],
    hints: [
      'From PC-A, tracert 192.168.2.10 reaches R1 and R2 but the destination never answers.',
      'On R1, show ip route lists the static route to 192.168.2.0/24. On R2, show ip route has no route to 192.168.1.0/24.',
      'On R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1.',
      'Re-test from PC-A: ping 192.168.2.10.',
    ],
    createState: () => twoSites({ r1Lan: true, r1Wan: true, r1Route: true, r2Route: false }),
    objectives: [
      { id: 'inspect', label: 'Inspect both routing tables', checks: [{ type: 'command', pattern: '^(do )?show ip route', device: 'R1', label: 'show ip route on R1' }, { type: 'command', pattern: '^(do )?show ip route', device: 'R2', label: 'show ip route on R2' }] },
      { id: 'fix', label: 'Add the return route on R2', checks: [{ type: 'route', device: 'R2', destination: '192.168.1.0', mask: '255.255.255.0', via: '10.0.0.1', label: 'R2 has ip route 192.168.1.0 255.255.255.0 10.0.0.1' }] },
      { id: 'keep', label: 'Leave R1 as it was', checks: [{ type: 'route', device: 'R1', destination: '192.168.2.0', mask: '255.255.255.0', via: '10.0.0.2', label: 'R1 still routes 192.168.2.0/24 via 10.0.0.2' }] },
      { id: 'verify', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'ping 192.168.2.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'rt-05-default-route',
    moduleId: MODULE,
    order: 5,
    title: 'Default Route to the ISP',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Send everything you do not know about to the ISP with a single default route.',
    scenario:
      'The branch connects to an ISP router at 203.0.113.1 on g0/1. The ISP announces nothing to you and expects a default route pointing at it; it already knows how to reach your LAN.\n\nAddress g0/1 with 203.0.113.2/30, add a default route via the ISP, and prove it works by pinging the public DNS server 8.8.8.8 from PC-A. Then check where the gateway of last resort points.',
    concepts: ['Default route 0.0.0.0/0', 'Gateway of last resort', 'S* in show ip route'],
    hints: [
      'interface g0/1, ip address 203.0.113.2 255.255.255.252, no shutdown.',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1 matches every destination that has no better route.',
      'show ip route: the header now says Gateway of last resort is 203.0.113.1 to network 0.0.0.0.',
      'From PC-A: ping 8.8.8.8.',
    ],
    createState: () => {
      const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { description: 'LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to ISP' } } });
      const isp = createRouter({
        hostname: 'ISP',
        interfaces: {
          'g0/0': { description: 'Customer link', ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false },
          'lo0': { description: 'Public DNS (simulated)', ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' },
        },
        staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '203.0.113.2' }],
      });
      return buildNetwork({ primary: 'R1', devices: [r1, isp], hosts: [{ id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }], links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'ISP:g0/0']] });
    },
    objectives: [
      { id: 'address', label: 'Address the ISP link', checks: [{ type: 'interface', name: 'g0/1', ipAddress: '203.0.113.2', subnetMask: '255.255.255.252', shutdown: false, label: 'g0/1 is 203.0.113.2/30 and up' }] },
      { id: 'default', label: 'Add a default route via the ISP', checks: [{ type: 'route', destination: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.1', label: 'ip route 0.0.0.0 0.0.0.0 203.0.113.1' }] },
      { id: 'verify', label: 'Check the gateway of last resort', checks: [{ type: 'command', pattern: '^(do )?show ip route' }] },
      { id: 'ping', label: 'PC-A reaches 8.8.8.8', checks: [{ type: 'ping', device: 'PC-A', target: '8.8.8.8', success: true, label: 'ping 8.8.8.8 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'rt-06-router-on-a-stick',
    moduleId: MODULE,
    order: 6,
    title: 'Router on a Stick',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Route between two VLANs with dot1Q subinterfaces on a single router port.',
    scenario:
      'Sales (VLAN 10) and HR (VLAN 20) share switch SW1. The switch is done: access ports are assigned and g0/8 is a trunk up to R1 g0/0. The two departments still cannot talk because nothing routes between the VLANs.\n\nOn R1, bring up g0/0, then create subinterface g0/0.10 with encapsulation dot1Q 10 and 192.168.10.1/24, and g0/0.20 with dot1Q 20 and 192.168.20.1/24. Finish by pinging PC-B from PC-A.',
    concepts: ['Inter-VLAN routing', 'Subinterfaces', 'encapsulation dot1Q', 'Trunk to a router'],
    hints: [
      'The physical port needs no address, but it must be up: interface g0/0, no shutdown.',
      'interface g0/0.10, encapsulation dot1q 10, ip address 192.168.10.1 255.255.255.0.',
      'interface g0/0.20, encapsulation dot1q 20, ip address 192.168.20.1 255.255.255.0.',
      'show ip route shows both VLAN subnets as connected. Then ping 192.168.20.10 from PC-A.',
    ],
    createState: () => {
      const sw = createSwitch({
        hostname: 'SW1',
        ports: 8,
        vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
        interfaces: {
          'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales PC' },
          'g0/2': { mode: 'access', accessVlan: 20, description: 'HR PC' },
          'g0/8': { mode: 'trunk', description: 'Trunk to R1' },
        },
      });
      const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { description: 'Trunk to SW1' } } });
      return buildNetwork({
        primary: 'R1',
        devices: [r1, sw],
        hosts: [
          { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
          { id: 'PC-B', ip: '192.168.20.10', mask: '255.255.255.0', gateway: '192.168.20.1' },
        ],
        links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0']],
      });
    },
    objectives: [
      { id: 'phys', label: 'Bring up the physical port', checks: [{ type: 'interface', name: 'g0/0', shutdown: false, label: 'g0/0 is no longer shut down' }] },
      { id: 'sub10', label: 'Create the VLAN 10 subinterface', checks: [{ type: 'interface', name: 'g0/0.10', encapsulation: 10, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', label: 'g0/0.10 uses dot1Q 10 with 192.168.10.1/24' }] },
      { id: 'sub20', label: 'Create the VLAN 20 subinterface', checks: [{ type: 'interface', name: 'g0/0.20', encapsulation: 20, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0', label: 'g0/0.20 uses dot1Q 20 with 192.168.20.1/24' }] },
      { id: 'ping', label: 'Sales reaches HR', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.20.10', success: true, label: 'ping 192.168.20.10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'rt-07-exam-branch-connectivity',
    moduleId: MODULE,
    order: 7,
    title: 'Exam: Branch Connectivity',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Configure both routers from scratch so two LANs can reach each other, and save both.',
    scenario:
      'Two factory-default routers connect the head office and a branch:\n\n- R1: g0/0 192.168.1.1/24 (LAN), g0/1 10.0.0.1/30 (link to R2)\n- R2: g0/0 192.168.2.1/24 (LAN), g0/1 10.0.0.2/30 (link to R1)\n- A static route on each router to the other LAN\n- Save both configurations\n\nProve it works with a ping from PC-A (192.168.1.10) to PC-B (192.168.2.10). No hints are available.',
    concepts: ['Synthesis', 'Addressing', 'Static routing both ways'],
    hints: [],
    createState: () => twoSites({ r2Ready: false, r2Route: false }),
    objectives: [
      { id: 'r1', label: 'Address R1', checks: [{ type: 'interface', device: 'R1', name: 'g0/0', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false, label: 'R1 g0/0 is 192.168.1.1/24 and up' }, { type: 'interface', device: 'R1', name: 'g0/1', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false, label: 'R1 g0/1 is 10.0.0.1/30 and up' }] },
      { id: 'r2', label: 'Address R2', checks: [{ type: 'interface', device: 'R2', name: 'g0/0', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false, label: 'R2 g0/0 is 192.168.2.1/24 and up' }, { type: 'interface', device: 'R2', name: 'g0/1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false, label: 'R2 g0/1 is 10.0.0.2/30 and up' }] },
      { id: 'routes', label: 'Static routes both ways', checks: [{ type: 'route', device: 'R1', destination: '192.168.2.0', mask: '255.255.255.0', via: '10.0.0.2', label: 'R1 routes 192.168.2.0/24 via 10.0.0.2' }, { type: 'route', device: 'R2', destination: '192.168.1.0', mask: '255.255.255.0', via: '10.0.0.1', label: 'R2 routes 192.168.1.0/24 via 10.0.0.1' }] },
      { id: 'ping', label: 'End-to-end reachability', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'ping 192.168.2.10 from PC-A succeeds' }] },
      { id: 'save', label: 'Save both routers', checks: [{ type: 'saved', device: 'R1', label: 'R1 configuration saved' }, { type: 'saved', device: 'R2', label: 'R2 configuration saved' }] },
    ],
  },
];
