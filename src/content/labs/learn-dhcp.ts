import { buildNetwork, createRouter, createSwitch, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-dhcp';

/**
 * PC-A, PC-B (DHCP clients) - SW1 - R1 g0/0 (192.168.10.1) | R1 g0/1 (10.0.0.1) --- (10.0.0.2) R2 g0/1
 * R1 and R2 have static routes to each other's networks so relay traffic can flow.
 */
function dhcpSite(opts: { r1Pool?: { defaultRouter: string }; r2Pool?: boolean; leased?: { gateway: string } } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'Sales LAN', ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.0.2' }],
    dhcp: opts.r1Pool ? { pools: [{ name: 'SALES', network: '192.168.10.0', mask: '255.255.255.0', defaultRouter: opts.r1Pool.defaultRouter, dnsServer: '8.8.8.8' }], excluded: [['192.168.10.1', '192.168.10.9']] } : undefined,
    overrides: opts.leased ? { dhcpBindings: [{ ip: '192.168.10.10', mac: '0011.22bb.0001', pool: 'SALES', hostId: 'PC-A' }] } : undefined,
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false }, lo0: { description: 'Test target', ipAddress: '10.99.99.1', subnetMask: '255.255.255.255' } },
    staticRoutes: [{ destination: '192.168.10.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }],
    dhcp: opts.r2Pool ? { pools: [{ name: 'BRANCH-SALES', network: '192.168.10.0', mask: '255.255.255.0', defaultRouter: '192.168.10.1', dnsServer: '8.8.8.8' }], excluded: [['192.168.10.1', '192.168.10.9']] } : undefined,
  });
  const sw = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'PC-A' }, 'g0/2': { description: 'PC-B' }, 'g0/8': { description: 'Uplink to R1' } } });
  const net = buildNetwork({
    primary: 'R1',
    devices: [r1, r2, sw],
    hosts: [
      { id: 'PC-A', dhcp: true },
      { id: 'PC-B', dhcp: true },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1']],
  });
  if (opts.leased) Object.assign(net.hosts['PC-A'], { ip: '192.168.10.10', mask: '255.255.255.0', gateway: opts.leased.gateway, dns: '8.8.8.8', dhcpServer: '192.168.10.1' });
  return net;
}

export const learnDhcpLabs: Lab[] = [
  {
    id: 'dh-01-dhcp-server',
    moduleId: MODULE,
    order: 1,
    title: 'Serve Addresses From the Router',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Build a DHCP pool on R1, protect the addresses you hand out manually, and watch a PC obtain a lease.',
    scenario:
      'The Sales PCs are set to obtain an address automatically, but nothing on the network hands addresses out, so they sit with no IP at all. Try ipconfig /renew on PC-A to see the failure.\n\nOn R1, reserve 192.168.10.1 through 192.168.10.9 for infrastructure, then create pool SALES for 192.168.10.0/24 with default router 192.168.10.1 and DNS server 8.8.8.8. Renew PC-A again: it should receive 192.168.10.10 and be able to ping its gateway. Finish by looking at the binding table.',
    concepts: ['ip dhcp pool', 'network / default-router / dns-server', 'Excluded addresses', 'DORA', 'show ip dhcp binding'],
    hints: [
      'On PC-A, ipconfig /renew reports it cannot contact a DHCP server.',
      'ip dhcp excluded-address 192.168.10.1 192.168.10.9 comes first, so the router never hands out its own address.',
      'ip dhcp pool SALES, network 192.168.10.0 255.255.255.0, default-router 192.168.10.1, dns-server 8.8.8.8.',
      'Back on PC-A: ipconfig /renew, then ping 192.168.10.1. On R1, show ip dhcp binding lists the lease.',
    ],
    createState: () => dhcpSite(),
    objectives: [
      { id: 'fail', label: 'See the failure first', checks: [{ type: 'command', device: 'PC-A', pattern: '^ipconfig /renew$', label: 'PC-A ran ipconfig /renew' }] },
      { id: 'excluded', label: 'Reserve the infrastructure addresses', checks: [{ type: 'dhcp-excluded', from: '192.168.10.1', to: '192.168.10.9' }] },
      { id: 'pool', label: 'Create the SALES pool', checks: [{ type: 'dhcp-pool', name: 'SALES', network: '192.168.10.0', mask: '255.255.255.0', defaultRouter: '192.168.10.1', dnsServer: '8.8.8.8', label: 'Pool SALES: 192.168.10.0/24, default-router 192.168.10.1, dns-server 8.8.8.8' }] },
      { id: 'lease', label: 'PC-A obtains a lease', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, ip: '192.168.10.10', gateway: '192.168.10.1', label: 'PC-A holds 192.168.10.10 from DHCP with gateway 192.168.10.1' }] },
      { id: 'ping', label: 'PC-A reaches its gateway', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.1', success: true }] },
      { id: 'binding', label: 'Inspect the binding table', checks: [{ type: 'command', pattern: '^(do )?show ip dhcp binding$' }] },
    ],
  },
  {
    id: 'dh-02-bindings-and-pool',
    moduleId: MODULE,
    order: 2,
    title: 'Two Clients, One Pool',
    difficulty: 'Intermediate',
    estimatedMinutes: 6,
    description: 'Lease addresses to two PCs, read the binding and pool statistics, and confirm they can talk.',
    scenario:
      'The SALES pool on R1 is ready. Both Sales PCs still need addresses.\n\nRenew PC-A and PC-B, confirm both bindings on R1 with show ip dhcp binding and the utilisation with show ip dhcp pool, then ping PC-B from PC-A using the address PC-B received.',
    concepts: ['Leases', 'show ip dhcp binding', 'show ip dhcp pool', 'Sequential allocation'],
    hints: [
      'ipconfig /renew on PC-A gives 192.168.10.10; on PC-B it gives 192.168.10.11.',
      'show ip dhcp binding on R1 lists both MAC addresses. show ip dhcp pool shows Leased addresses : 2.',
      'From PC-A: ping 192.168.10.11.',
    ],
    createState: () => dhcpSite({ r1Pool: { defaultRouter: '192.168.10.1' } }),
    objectives: [
      { id: 'leases', label: 'Both PCs hold leases', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, inSubnet: { network: '192.168.10.0', mask: '255.255.255.0' }, label: 'PC-A has a DHCP address in 192.168.10.0/24' }, { type: 'host-config', device: 'PC-B', viaDhcp: true, inSubnet: { network: '192.168.10.0', mask: '255.255.255.0' }, label: 'PC-B has a DHCP address in 192.168.10.0/24' }] },
      { id: 'bindings', label: 'Two bindings on R1', checks: [{ type: 'dhcp-bindings', min: 2 }, { type: 'command', pattern: '^(do )?show ip dhcp binding$' }] },
      { id: 'pool', label: 'Check pool utilisation', checks: [{ type: 'command', pattern: '^(do )?show ip dhcp pool$' }] },
      { id: 'ping', label: 'PC-A reaches PC-B', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.11', success: true }] },
    ],
  },
  {
    id: 'dh-03-dhcp-relay',
    moduleId: MODULE,
    order: 3,
    title: 'DHCP Relay Across the Router',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'The pool lives on a remote router. Teach R1 to forward DHCP broadcasts to it.',
    scenario:
      'Head office runs DHCP centrally on R2 (10.0.0.2), which already holds a pool for the Sales subnet 192.168.10.0/24. R1 has no pool of its own, and DHCP discovers are broadcasts that R1 will never forward on its own.\n\nRenew PC-A to see it fail, add ip helper-address 10.0.0.2 on R1 g0/0, renew again, then confirm the lease appears on R2 and that PC-A can reach 10.0.0.2.',
    concepts: ['ip helper-address', 'DHCP relay and giaddr', 'Broadcast to unicast', 'Central DHCP'],
    hints: [
      'ipconfig /renew on PC-A times out: no server on the local segment and nothing relays.',
      'On R1: interface g0/0, ip helper-address 10.0.0.2.',
      'Renew PC-A again. show ip dhcp binding on R2 now shows the lease; ipconfig /all on PC-A shows DHCP Server 10.0.0.2.',
    ],
    createState: () => dhcpSite({ r2Pool: true }),
    objectives: [
      { id: 'fail', label: 'See the failure first', checks: [{ type: 'command', device: 'PC-A', pattern: '^ipconfig /renew$', label: 'PC-A ran ipconfig /renew' }] },
      { id: 'helper', label: 'Relay from g0/0 to R2', checks: [{ type: 'helper-address', interface: 'g0/0', address: '10.0.0.2' }] },
      { id: 'lease', label: 'PC-A leases from R2', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, gateway: '192.168.10.1', inSubnet: { network: '192.168.10.0', mask: '255.255.255.0' }, label: 'PC-A holds a 192.168.10.0/24 lease with gateway 192.168.10.1' }, { type: 'dhcp-bindings', device: 'R2', min: 1, label: 'R2 shows the binding' }] },
      { id: 'ping', label: 'PC-A reaches R2', checks: [{ type: 'ping', device: 'PC-A', target: '10.0.0.2', success: true }] },
    ],
  },
  {
    id: 'dh-04-wrong-gateway',
    moduleId: MODULE,
    order: 4,
    title: 'Troubleshoot: The Gateway DHCP Handed Out',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'PC-A has an address but cannot leave its subnet. The problem is in the pool, not on the PC.',
    scenario:
      'PC-A received an address from R1 this morning, can ping its neighbours, but cannot reach anything past the router, such as R2 at 10.0.0.2.\n\nStart on the PC: ipconfig /all shows what DHCP gave it. Compare with what R1 actually is. Fix the pool on R1, renew the lease on PC-A, and prove it can reach 10.0.0.2. Do not configure a static address on the PC.',
    concepts: ['default-router', 'ipconfig /all', 'Fix the source, not the symptom', 'Lease renewal'],
    hints: [
      'ipconfig /all on PC-A shows Default Gateway 192.168.10.254. R1 g0/0 is 192.168.10.1.',
      'show running-config on R1: the SALES pool says default-router 192.168.10.254.',
      'ip dhcp pool SALES, default-router 192.168.10.1. Then on PC-A: ipconfig /renew and ping 10.0.0.2.',
    ],
    createState: () => dhcpSite({ r1Pool: { defaultRouter: '192.168.10.254' }, leased: { gateway: '192.168.10.254' } }),
    objectives: [
      { id: 'inspect', label: 'Inspect the lease on PC-A', checks: [{ type: 'command', device: 'PC-A', pattern: '^ipconfig( /all)?$', label: 'PC-A ran ipconfig' }] },
      { id: 'fix', label: 'Correct the default router in the pool', checks: [{ type: 'dhcp-pool', name: 'SALES', defaultRouter: '192.168.10.1', label: 'Pool SALES default-router is 192.168.10.1' }] },
      { id: 'renew', label: 'Renew the lease', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, gateway: '192.168.10.1', label: 'PC-A now has gateway 192.168.10.1 from DHCP' }] },
      { id: 'ping', label: 'PC-A reaches R2', checks: [{ type: 'ping', device: 'PC-A', target: '10.0.0.2', success: true }] },
    ],
  },
];
