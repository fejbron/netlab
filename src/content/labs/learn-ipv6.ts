import { buildNetwork, createRouter, ipv6Config, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-ipv6';

/**
 * PC-A (2001:DB8:1::10/64) - R1 g0/0 | R1 g0/1 --2001:DB8:12::/64-- R2 g0/1 (::2, link-local FE80::2) | R2 g0/0 - PC-B (2001:DB8:2::10/64)
 * R2 lo0 2001:DB8:FFFF::1 stands in for "the internet". IPv4 stays configured so the branch is dual-stack.
 */
function v6Sites(r1: { lan?: boolean; link?: boolean; route?: boolean; routing?: boolean } = {}, r2Ready = true): NetworkState {
  const r1Dev = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { description: 'LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: !r1.lan, ipv6: r1.lan ? ipv6Config('2001:DB8:1::1/64') : undefined },
      'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: !r1.link, ipv6: r1.link ? ipv6Config('2001:DB8:12::1/64') : undefined },
    },
    staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
    ipv6: { unicastRouting: r1.routing ?? false, routes: r1.route ? [['2001:DB8:2::/64', '2001:DB8:12::2']] : [] },
  });
  const r2Dev = createRouter({
    hostname: 'R2',
    interfaces: {
      'g0/0': { description: 'LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false, ipv6: r2Ready ? ipv6Config('2001:DB8:2::1/64') : undefined },
      'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false, ipv6: r2Ready ? ipv6Config('2001:DB8:12::2/64', 'FE80::2') : undefined },
      lo0: { description: 'Internet (simulated)', ipv6: ipv6Config('2001:DB8:FFFF::1/128') },
    },
    staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }],
    ipv6: { unicastRouting: r2Ready, routes: r2Ready ? [['2001:DB8:1::/64', '2001:DB8:12::1']] : [] },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1Dev, r2Dev],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1', ip6: '2001:DB8:1::10/64', gateway6: '2001:DB8:1::1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1', ip6: '2001:DB8:2::10/64', gateway6: '2001:DB8:2::1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B']],
  });
}

export const learnIpv6Labs: Lab[] = [
  {
    id: 'v6-01-first-addresses',
    moduleId: MODULE,
    order: 1,
    title: 'Your First IPv6 Addresses',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Enable IPv6 routing, address a LAN interface with a /64, and see the link-local address appear on its own.',
    scenario:
      'The branch is going dual-stack. PC-A already has 2001:DB8:1::10/64 with gateway 2001:DB8:1::1, but R1 knows nothing about IPv6.\n\nEnable IPv6 routing on R1, give g0/0 the address 2001:DB8:1::1/64, bring it up, and look at show ipv6 interface brief: the interface also gets a link-local address you never typed. Prove it by pinging PC-A from R1.',
    concepts: ['ipv6 unicast-routing', 'Global unicast addresses', 'Automatic link-local addresses', 'show ipv6 interface brief'],
    hints: [
      'ipv6 unicast-routing is a global command; without it the router will not forward IPv6.',
      'interface g0/0, ipv6 address 2001:db8:1::1/64, no shutdown.',
      'show ipv6 interface brief lists FE80:: first: the link-local address derived from the MAC.',
      'ping 2001:db8:1::10 from R1.',
    ],
    createState: () => v6Sites(),
    objectives: [
      { id: 'routing', label: 'Enable IPv6 routing', checks: [{ type: 'ipv6-unicast-routing' }] },
      { id: 'address', label: 'Address g0/0', checks: [{ type: 'ipv6-address', interface: 'g0/0', address: '2001:db8:1::1', prefix: 64, label: 'g0/0 has 2001:DB8:1::1/64' }, { type: 'interface', name: 'g0/0', shutdown: false, label: 'g0/0 is no longer shut down' }] },
      { id: 'brief', label: 'Inspect the addresses', checks: [{ type: 'command', pattern: '^(do )?show ipv6 interface brief$' }] },
      { id: 'ping', label: 'Reach PC-A over IPv6', checks: [{ type: 'ping', target: '2001:DB8:1::10', success: true, label: 'ping 2001:DB8:1::10 from R1 succeeds' }] },
    ],
  },
  {
    id: 'v6-02-eui64-link-local',
    moduleId: MODULE,
    order: 2,
    title: 'EUI-64 and Link-Local',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Let the router build its own host portion with EUI-64 and set a readable link-local address by hand.',
    scenario:
      'The link to R2 uses 2001:DB8:12::/64. R2 already has ::2 on its side and the link-local address FE80::2.\n\nOn R1 g0/1, let the router derive its own address from the prefix with EUI-64, set the link-local address to FE80::1 so the neighbour table is readable, bring the interface up, and ping R2 at 2001:DB8:12::2.',
    concepts: ['EUI-64', 'Modified EUI-64 from MAC', 'Manual link-local addresses', 'Link-local scope'],
    hints: [
      'interface g0/1, ipv6 address 2001:db8:12::/64 eui-64. Note the prefix has no host part: the router fills it in.',
      'ipv6 address fe80::1 link-local replaces the automatic link-local.',
      'no shutdown, then show ipv6 interface brief to see the two addresses.',
      'ping 2001:db8:12::2, and try ping fe80::2 as well: link-local works on the directly connected link.',
    ],
    createState: () => v6Sites({ lan: true, routing: true }),
    objectives: [
      { id: 'eui', label: 'EUI-64 address on g0/1', checks: [{ type: 'ipv6-address', interface: 'g0/1', prefix: 64, eui64: true, label: 'g0/1 has a 2001:DB8:12::/64 address built with EUI-64' }] },
      { id: 'll', label: 'Manual link-local address', checks: [{ type: 'ipv6-address', interface: 'g0/1', linkLocal: 'fe80::1', label: 'g0/1 link-local is FE80::1' }] },
      { id: 'up', label: 'Bring the link up', checks: [{ type: 'interface', name: 'g0/1', shutdown: false, label: 'g0/1 is no longer shut down' }, { type: 'command', pattern: '^(do )?show ipv6 interface brief$' }] },
      { id: 'ping', label: 'Reach R2', checks: [{ type: 'ping', target: '2001:DB8:12::2', success: true, label: 'ping 2001:DB8:12::2 succeeds' }] },
    ],
  },
  {
    id: 'v6-03-static-routes',
    moduleId: MODULE,
    order: 3,
    title: 'IPv6 Static Routes',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Connect two IPv6 LANs with a static route and read the IPv6 routing table.',
    scenario:
      'Both routers are fully addressed for IPv6 and R2 already routes 2001:DB8:1::/64 back toward R1, yet PC-A cannot reach PC-B at 2001:DB8:2::10.\n\nSee the failure from PC-A, add a static route on R1 for 2001:DB8:2::/64 via 2001:DB8:12::2, verify it in show ipv6 route, and ping PC-B from PC-A.',
    concepts: ['ipv6 route', 'Prefix notation', 'show ipv6 route', 'Testing from the host'],
    hints: [
      'From PC-A, ping 2001:db8:2::10 fails: R1 has no route for 2001:DB8:2::/64.',
      'ipv6 route 2001:db8:2::/64 2001:db8:12::2 in global configuration.',
      'show ipv6 route shows the S entry with its next hop on the line below.',
    ],
    createState: () => v6Sites({ lan: true, link: true, routing: true }),
    objectives: [
      { id: 'before', label: 'See the failure from PC-A', checks: [{ type: 'ping', device: 'PC-A', target: '2001:DB8:2::10', label: 'PC-A pinged 2001:DB8:2::10' }] },
      { id: 'route', label: 'Add the static route', checks: [{ type: 'route6', prefix: '2001:DB8:2::/64', via: '2001:DB8:12::2', label: 'ipv6 route 2001:DB8:2::/64 2001:DB8:12::2' }] },
      { id: 'verify', label: 'Verify the routing table', checks: [{ type: 'command', pattern: '^(do )?show ipv6 route' }] },
      { id: 'after', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '2001:DB8:2::10', success: true, label: 'ping 2001:DB8:2::10 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'v6-04-default-via-link-local',
    moduleId: MODULE,
    order: 4,
    title: 'Default Route via Link-Local',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Point a default route at a neighbour using only its link-local address, the IPv6 way.',
    scenario:
      'R2 is the way to everything else, including the simulated internet at 2001:DB8:FFFF::1. Its link-local address on the shared link is FE80::2.\n\nAdd a default route on R1 that uses that link-local address as the next hop. IPv6 will refuse it without an exit interface, because link-local addresses are only meaningful on one link. Then prove PC-A can reach 2001:DB8:FFFF::1.',
    concepts: ['::/0 default route', 'Link-local next hops need an interface', 'show ipv6 route'],
    hints: [
      'Try ipv6 route ::/0 fe80::2 first and read the error.',
      'ipv6 route ::/0 g0/1 fe80::2 names the interface the link-local address lives on.',
      'show ipv6 route shows S ::/0 via FE80::2, GigabitEthernet0/1. Then ping 2001:db8:ffff::1 from PC-A.',
    ],
    createState: () => v6Sites({ lan: true, link: true, routing: true, route: true }),
    objectives: [
      { id: 'route', label: 'Default route through g0/1 via FE80::2', checks: [{ type: 'route6', prefix: '::/0', via: 'g0/1', label: '::/0 exits through g0/1' }, { type: 'route6', prefix: '::/0', via: 'fe80::2', label: '::/0 uses next hop FE80::2' }] },
      { id: 'verify', label: 'Verify the routing table', checks: [{ type: 'command', pattern: '^(do )?show ipv6 route' }] },
      { id: 'ping', label: 'PC-A reaches the internet', checks: [{ type: 'ping', device: 'PC-A', target: '2001:DB8:FFFF::1', success: true, label: 'ping 2001:DB8:FFFF::1 from PC-A succeeds' }] },
    ],
  },
  {
    id: 'v6-05-exam-dual-stack',
    moduleId: MODULE,
    order: 5,
    title: 'Exam: Dual-Stack Branch',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Add IPv6 to two working IPv4 routers so both address families reach across the link.',
    scenario:
      'IPv4 already works between the two sites. Add IPv6 on both routers from the plan:\n\n- R1: ipv6 unicast-routing; g0/0 2001:DB8:1::1/64; g0/1 2001:DB8:12::1/64\n- R2: ipv6 unicast-routing; g0/0 2001:DB8:2::1/64; g0/1 2001:DB8:12::2/64\n- Static IPv6 routes on each router to the other LAN\n- Save both\n\nProve it: PC-A pings PC-B at 2001:DB8:2::10, PC-B pings PC-A at 2001:DB8:1::10, and IPv4 still works (PC-A pings 192.168.2.10). No hints are available.',
    concepts: ['Synthesis', 'Dual stack', 'IPv6 static routing'],
    hints: [],
    createState: () => v6Sites({ lan: true, link: true }, false),
    objectives: [
      { id: 'r1', label: 'IPv6 on R1', checks: [{ type: 'ipv6-unicast-routing', device: 'R1' }, { type: 'ipv6-address', device: 'R1', interface: 'g0/0', address: '2001:DB8:1::1', prefix: 64, label: 'R1 g0/0 has 2001:DB8:1::1/64' }, { type: 'ipv6-address', device: 'R1', interface: 'g0/1', address: '2001:DB8:12::1', prefix: 64, label: 'R1 g0/1 has 2001:DB8:12::1/64' }, { type: 'route6', device: 'R1', prefix: '2001:DB8:2::/64', label: 'R1 routes 2001:DB8:2::/64' }] },
      { id: 'r2', label: 'IPv6 on R2', checks: [{ type: 'ipv6-unicast-routing', device: 'R2' }, { type: 'ipv6-address', device: 'R2', interface: 'g0/0', address: '2001:DB8:2::1', prefix: 64, label: 'R2 g0/0 has 2001:DB8:2::1/64' }, { type: 'ipv6-address', device: 'R2', interface: 'g0/1', address: '2001:DB8:12::2', prefix: 64, label: 'R2 g0/1 has 2001:DB8:12::2/64' }, { type: 'route6', device: 'R2', prefix: '2001:DB8:1::/64', label: 'R2 routes 2001:DB8:1::/64' }] },
      { id: 'prove', label: 'Both families reach across', checks: [{ type: 'ping', device: 'PC-A', target: '2001:DB8:2::10', success: true, label: 'PC-A pings PC-B over IPv6' }, { type: 'ping', device: 'PC-B', target: '2001:DB8:1::10', success: true, label: 'PC-B pings PC-A over IPv6' }, { type: 'ping', device: 'PC-A', target: '192.168.2.10', success: true, label: 'PC-A still pings PC-B over IPv4' }] },
      { id: 'save', label: 'Save both routers', checks: [{ type: 'saved', device: 'R1' }, { type: 'saved', device: 'R2' }] },
    ],
  },
];
