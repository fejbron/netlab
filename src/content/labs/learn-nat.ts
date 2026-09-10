import { buildNetwork, createRouter, createSwitch, type NetworkState, type RouterOptions } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-nat';

/**
 * Branch LAN 192.168.10.0/24 (PC-A .10, PC-B .11, SRV1 .20) - SW1 - R1 g0/0
 * R1 g0/1 203.0.113.2/30 --- ISP g0/0 203.0.113.1 | ISP lo0 8.8.8.8 | ISP g0/1 - NET-PC 198.51.100.10
 * The ISP routes the whole 203.0.113.0/24 toward R1 and knows nothing about 192.168.10.0/24.
 */
export function natEdge(nat?: RouterOptions['nat'], roles?: boolean): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { description: 'Branch LAN', ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false, natRole: roles ? 'inside' : undefined },
      'g0/1': { description: 'Link to ISP', ipAddress: '203.0.113.2', subnetMask: '255.255.255.252', shutdown: false, natRole: roles ? 'outside' : undefined },
    },
    staticRoutes: [{ destination: '0.0.0.0', mask: '0.0.0.0', nextHop: '203.0.113.1' }],
    nat,
  });
  const isp = createRouter({
    hostname: 'ISP',
    interfaces: {
      'g0/0': { description: 'Customer link', ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false },
      'g0/1': { description: 'Internet host', ipAddress: '198.51.100.1', subnetMask: '255.255.255.0', shutdown: false },
      lo0: { description: 'Public DNS (simulated)', ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' },
    },
    staticRoutes: [{ destination: '203.0.113.0', mask: '255.255.255.0', nextHop: '203.0.113.2' }],
  });
  const sw = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'PC-A' }, 'g0/2': { description: 'PC-B' }, 'g0/3': { description: 'SRV1' }, 'g0/8': { description: 'Uplink to R1' } } });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, isp, sw],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
      { id: 'PC-B', ip: '192.168.10.11', mask: '255.255.255.0', gateway: '192.168.10.1' },
      { id: 'SRV1', ip: '192.168.10.20', mask: '255.255.255.0', gateway: '192.168.10.1', kind: 'server' },
      { id: 'NET-PC', ip: '198.51.100.10', mask: '255.255.255.0', gateway: '198.51.100.1' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SRV1', 'SW1:g0/3'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'ISP:g0/0'], ['ISP:g0/1', 'NET-PC']],
  });
}

export const learnNatLabs: Lab[] = [
  {
    id: 'nat-01-static-nat',
    moduleId: MODULE,
    order: 1,
    title: 'Static NAT: Publish the Server',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Map one private server to one public address so the outside world can reach it.',
    scenario:
      'SRV1 (192.168.10.20) must be reachable from the internet, but the ISP only routes the public block 203.0.113.0/24 to you and drops anything private. Try it first: from NET-PC, ping 203.0.113.10 and watch it fail.\n\nOn R1, create a static translation from 192.168.10.20 to 203.0.113.10, mark g0/0 as the inside interface and g0/1 as the outside interface, then prove that NET-PC can reach 203.0.113.10. Look at the translation table afterwards.',
    concepts: ['Inside local vs inside global', 'ip nat inside source static', 'ip nat inside / outside', 'show ip nat translations'],
    hints: [
      'From NET-PC: ping 203.0.113.10. Nobody answers for that address yet.',
      'ip nat inside source static 192.168.10.20 203.0.113.10 creates the one-to-one mapping.',
      'NAT does nothing until interfaces have roles: interface g0/0, ip nat inside; interface g0/1, ip nat outside.',
      'Ping again from NET-PC, then show ip nat translations on R1 shows the static entry and the ICMP flow.',
    ],
    createState: () => natEdge(),
    objectives: [
      { id: 'before', label: 'See the failure first', checks: [{ type: 'ping', device: 'NET-PC', target: '203.0.113.10', label: 'NET-PC pinged 203.0.113.10' }] },
      { id: 'static', label: 'Create the static translation', checks: [{ type: 'nat-static', local: '192.168.10.20', global: '203.0.113.10' }] },
      { id: 'roles', label: 'Assign NAT interface roles', checks: [{ type: 'nat-role', interface: 'g0/0', role: 'inside' }, { type: 'nat-role', interface: 'g0/1', role: 'outside' }] },
      { id: 'prove', label: 'The internet reaches SRV1', checks: [{ type: 'ping', device: 'NET-PC', target: '203.0.113.10', success: true, label: 'ping 203.0.113.10 from NET-PC succeeds' }] },
      { id: 'table', label: 'Read the translation table', checks: [{ type: 'command', pattern: '^(do )?show ip nat translations$' }] },
    ],
  },
  {
    id: 'nat-02-pat-overload',
    moduleId: MODULE,
    order: 2,
    title: 'PAT: Everyone Shares One Address',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Let a whole LAN reach the internet through the single public address on the outside interface.',
    scenario:
      'The branch has one public address, the one on R1 g0/1, and twenty PCs. Try ping 8.8.8.8 from PC-A: the request gets out but the reply never comes back, because the ISP cannot route 192.168.10.0/24.\n\nConfigure Port Address Translation: an access list that selects the LAN, a translation rule that overloads the g0/1 address, and the inside/outside roles. Then prove that PC-A and PC-B both reach 8.8.8.8 and look at the translations.',
    concepts: ['PAT / overload', 'access-list selecting inside hosts', 'interface overload', 'Translation table with ports'],
    hints: [
      'From PC-A, ping 8.8.8.8 times out: replies are addressed to a private source the ISP drops.',
      'access-list 1 permit 192.168.10.0 0.0.0.255 selects who gets translated.',
      'ip nat inside source list 1 interface g0/1 overload. Then interface g0/0, ip nat inside; interface g0/1, ip nat outside.',
      'Ping 8.8.8.8 from PC-A and PC-B. show ip nat translations lists both, distinguished only by port.',
    ],
    createState: () => natEdge(),
    objectives: [
      { id: 'before', label: 'See the failure first', checks: [{ type: 'ping', device: 'PC-A', target: '8.8.8.8', label: 'PC-A pinged 8.8.8.8' }] },
      { id: 'acl', label: 'Select the LAN with access-list 1', checks: [{ type: 'acl-entry', name: '1', action: 'permit', src: '192.168.10.0 0.0.0.255', label: 'access-list 1 permit 192.168.10.0 0.0.0.255' }] },
      { id: 'rule', label: 'Overload the outside interface', checks: [{ type: 'nat-dynamic', acl: '1', interface: 'g0/1', overload: true, label: 'ip nat inside source list 1 interface g0/1 overload' }] },
      { id: 'roles', label: 'Assign NAT interface roles', checks: [{ type: 'nat-role', interface: 'g0/0', role: 'inside' }, { type: 'nat-role', interface: 'g0/1', role: 'outside' }] },
      { id: 'prove', label: 'Both PCs reach the internet', checks: [{ type: 'ping', device: 'PC-A', target: '8.8.8.8', success: true, label: 'PC-A pings 8.8.8.8' }, { type: 'ping', device: 'PC-B', target: '8.8.8.8', success: true, label: 'PC-B pings 8.8.8.8' }] },
      { id: 'table', label: 'Read the translation table', checks: [{ type: 'nat-translations', min: 2 }, { type: 'command', pattern: '^(do )?show ip nat translations$' }] },
    ],
  },
  {
    id: 'nat-03-dynamic-pool',
    moduleId: MODULE,
    order: 3,
    title: 'Dynamic NAT: When the Pool Runs Dry',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Translate from a small pool of public addresses, watch a third host get nothing, then fix it with overload.',
    scenario:
      'The ISP gave the branch two spare public addresses, 203.0.113.20 and 203.0.113.21. Build dynamic NAT: pool PUBLIC with those two addresses (netmask 255.255.255.0), access-list 1 for the LAN, and a translation rule using the pool. Interface roles are already set.\n\nPing 8.8.8.8 from PC-A, PC-B and then SRV1. The third one fails: a pool without overload hands out one whole address per host. Fix the rule by adding overload and prove SRV1 gets through.',
    concepts: ['ip nat pool', 'Dynamic NAT vs PAT', 'Pool exhaustion', 'overload on a pool'],
    hints: [
      'ip nat pool PUBLIC 203.0.113.20 203.0.113.21 netmask 255.255.255.0.',
      'access-list 1 permit 192.168.10.0 0.0.0.255, then ip nat inside source list 1 pool PUBLIC.',
      'PC-A and PC-B get one address each. SRV1 times out: show ip nat translations shows both addresses taken.',
      'ip nat inside source list 1 pool PUBLIC overload replaces the rule, then ping again from SRV1.',
    ],
    createState: () => natEdge(undefined, true),
    objectives: [
      { id: 'pool', label: 'Define the pool', checks: [{ type: 'nat-pool', name: 'PUBLIC', start: '203.0.113.20', end: '203.0.113.21' }] },
      { id: 'acl', label: 'Select the LAN', checks: [{ type: 'acl-entry', name: '1', action: 'permit', src: '192.168.10.0 0.0.0.255', label: 'access-list 1 permit 192.168.10.0 0.0.0.255' }] },
      { id: 'two', label: 'Two hosts get translated', checks: [{ type: 'ping', device: 'PC-A', target: '8.8.8.8', success: true, label: 'PC-A pings 8.8.8.8' }, { type: 'ping', device: 'PC-B', target: '8.8.8.8', success: true, label: 'PC-B pings 8.8.8.8' }] },
      { id: 'dry', label: 'See the pool run dry', checks: [{ type: 'ping', device: 'SRV1', target: '8.8.8.8', success: false, label: 'SRV1 failed to ping 8.8.8.8 while the pool was exhausted' }] },
      { id: 'fix', label: 'Overload the pool', checks: [{ type: 'nat-dynamic', acl: '1', pool: 'PUBLIC', overload: true, label: 'ip nat inside source list 1 pool PUBLIC overload' }, { type: 'ping', device: 'SRV1', target: '8.8.8.8', success: true, label: 'SRV1 pings 8.8.8.8' }] },
    ],
  },
  {
    id: 'nat-04-exam-internet-edge',
    moduleId: MODULE,
    order: 4,
    title: 'Exam: Internet Edge',
    difficulty: 'Advanced',
    estimatedMinutes: 15,
    isExam: true,
    description: 'Combine a published server with PAT for the LAN on one edge router.',
    scenario:
      'Build the branch internet edge on R1:\n\n- SRV1 (192.168.10.20) is published as 203.0.113.10 with static NAT\n- All other LAN hosts (192.168.10.0/24) share the g0/1 address with PAT, selected by access-list 1\n- g0/0 is the inside interface, g0/1 the outside interface\n- Save\n\nProve it: NET-PC pings 203.0.113.10; PC-A and PC-B ping 8.8.8.8. No hints are available.',
    concepts: ['Synthesis', 'Static NAT', 'PAT'],
    hints: [],
    createState: () => natEdge(),
    objectives: [
      { id: 'static', label: 'Published server', checks: [{ type: 'nat-static', local: '192.168.10.20', global: '203.0.113.10' }] },
      { id: 'pat', label: 'PAT for the LAN', checks: [{ type: 'acl-entry', name: '1', action: 'permit', src: '192.168.10.0 0.0.0.255', label: 'access-list 1 permit 192.168.10.0 0.0.0.255' }, { type: 'nat-dynamic', acl: '1', interface: 'g0/1', overload: true, label: 'ip nat inside source list 1 interface g0/1 overload' }] },
      { id: 'roles', label: 'Interface roles', checks: [{ type: 'nat-role', interface: 'g0/0', role: 'inside' }, { type: 'nat-role', interface: 'g0/1', role: 'outside' }] },
      { id: 'prove', label: 'Traffic in both directions', checks: [{ type: 'ping', device: 'NET-PC', target: '203.0.113.10', success: true, label: 'NET-PC pings 203.0.113.10' }, { type: 'ping', device: 'PC-A', target: '8.8.8.8', success: true, label: 'PC-A pings 8.8.8.8' }, { type: 'ping', device: 'PC-B', target: '8.8.8.8', success: true, label: 'PC-B pings 8.8.8.8' }] },
      { id: 'save', label: 'Save R1', checks: [{ type: 'saved' }] },
    ],
  },
];
