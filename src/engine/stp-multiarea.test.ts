import { describe, expect, it } from 'vitest';
import { buildNetwork, createRouter, createSwitch, executeHost, executeOn, ospfNeighbors, ping, routingTable, stpBlockedPorts, stpRoot, stpVlan, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

/**
 * Triangle: SW1 - SW2 - SW3 - SW1, all trunks on g0/7 and g0/8.
 * PC-A on SW1 g0/1, PC-C on SW3 g0/1, both VLAN 10. MACs make SW3 the default root.
 */
function triangle(opts: { priority?: Record<string, Record<number, number>> } = {}): NetworkState {
  const mk = (hostname: string, mac: string) =>
    createSwitch({
      hostname,
      mac,
      ports: 8,
      vlans: [{ id: 10, name: 'SALES' }],
      stpPriority: opts.priority?.[hostname],
      interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 }, 'g0/7': { mode: 'trunk' }, 'g0/8': { mode: 'trunk' } },
    });
  return buildNetwork({
    primary: 'SW1',
    devices: [mk('SW1', '0011.2233.0003'), mk('SW2', '0011.2233.0002'), mk('SW3', '0011.2233.0001')],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.11', mask: '255.255.255.0' },
      { id: 'PC-C', ip: '192.168.10.12', mask: '255.255.255.0' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-C', 'SW3:g0/1'], ['SW1:g0/7', 'SW2:g0/7'], ['SW2:g0/8', 'SW3:g0/8'], ['SW3:g0/7', 'SW1:g0/8']],
  });
}

describe('spanning tree', () => {
  it('elects the lowest bridge id as root and blocks one port in the loop', () => {
    const net = triangle();
    expect(stpRoot(net, 10)).toBe('SW3');
    expect(stpRoot(net, 1)).toBe('SW3');
    const sw3 = stpVlan(net, 'SW3', 10)!;
    expect(sw3.isRoot).toBe(true);
    expect(sw3.ports.map((p) => `${p.name} ${p.role} ${p.state}`)).toEqual(['GigabitEthernet0/1 Desg FWD', 'GigabitEthernet0/7 Desg FWD', 'GigabitEthernet0/8 Desg FWD']);
    // SW1 and SW2 both sit one hop from the root; the SW1-SW2 link must be blocked on the higher bridge id (SW1).
    const sw1 = stpVlan(net, 'SW1', 10)!;
    expect(sw1.rootCost).toBe(4);
    expect(sw1.rootPort).toBe('GigabitEthernet0/8');
    expect(sw1.ports.find((p) => p.name === 'GigabitEthernet0/7')).toMatchObject({ role: 'Altn', state: 'BLK' });
    const sw2 = stpVlan(net, 'SW2', 10)!;
    expect(sw2.rootPort).toBe('GigabitEthernet0/8');
    expect(sw2.ports.find((p) => p.name === 'GigabitEthernet0/7')).toMatchObject({ role: 'Desg', state: 'FWD' });
    expect(stpBlockedPorts(net, 'SW1', 10)).toEqual(new Set(['GigabitEthernet0/7']));
    expect(ping(net, 'PC-A', '192.168.10.12').success).toBe(true);
  });

  it('honours priority and root primary/secondary, and shows it in show spanning-tree', () => {
    const net = run(triangle(), 'en', 'conf t', 'spanning-tree vlan 10 priority 4096', 'end');
    expect(stpRoot(net, 10)).toBe('SW1');
    expect(stpRoot(net, 1)).toBe('SW3');
    const out = executeOn(net, 'SW1', 'show spanning-tree vlan 10').output;
    expect(out[0]).toBe('VLAN0010');
    expect(out).toContain('  Root ID    Priority    4106');
    expect(out).toContain('             This bridge is the root');
    expect(out).toContain('  Bridge ID  Priority    4106  (priority 4096 sys-id-ext 10)');
    expect(out.find((l) => l.startsWith('Gi0/7'))).toBe('Gi0/7               Desg FWD 4         128.7    P2p');
    const sw3 = executeOn(net, 'SW3', 'show spanning-tree vlan 10').output;
    expect(sw3).toContain('             Cost        4');
    expect(sw3).toContain('             Port        7 (GigabitEthernet0/7)');
    expect(sw3.find((l) => l.startsWith('Gi0/8'))).toBe('Gi0/8               Desg FWD 4         128.8    P2p');
    // SW2 and SW3 both sit at cost 4; SW3 has the lower bridge id, so SW2 blocks its side of the SW2-SW3 link.
    expect(executeOn(net, 'SW2', 'show spanning-tree vlan 10').output.find((l) => l.startsWith('Gi0/8'))).toBe('Gi0/8               Altn BLK 4         128.8    P2p');

    const bad = executeOn(run(net, 'conf t'), 'SW1', 'spanning-tree vlan 10 priority 4000');
    expect(bad.output[0]).toBe('% Bridge Priority must be in increments of 4096.');
    const primary = run(triangle(), 'en', 'conf t', 'spanning-tree vlan 1,10 root primary', 'end');
    expect(primary.devices['SW1'].stpPriority).toEqual({ 1: 24576, 10: 24576 });
    expect(stpRoot(primary, 10)).toBe('SW1');
    const secondary = run(primary, 'SW2: en', 'SW2: conf t', 'SW2: spanning-tree vlan 10 root secondary', 'SW2: end');
    expect(secondary.devices['SW2'].stpPriority).toEqual({ 10: 28672 });
    expect(executeOn(secondary, 'SW2', 'show running-config').output).toContain('spanning-tree vlan 10 priority 28672');
    const noRoot = run(secondary, 'SW1: en', 'SW1: conf t', 'SW1: no spanning-tree vlan 10 root', 'SW1: end');
    expect(stpRoot(noRoot, 10)).toBe('SW2');
  });

  it('changes the blocked port when the root moves or a cost is raised', () => {
    const net = run(triangle(), 'SW2: en', 'SW2: conf t', 'SW2: spanning-tree vlan 10 root primary', 'SW2: end');
    expect(stpRoot(net, 10)).toBe('SW2');
    // SW1 and SW3 are one hop from SW2; SW3 has the lower bridge id, so SW1 blocks its port towards SW3.
    expect(stpBlockedPorts(net, 'SW1', 10)).toEqual(new Set(['GigabitEthernet0/8']));
    expect(stpBlockedPorts(net, 'SW3', 10)).toEqual(new Set());
    expect(ping(net, 'PC-A', '192.168.10.12').success).toBe(true);
    // Raise the cost on SW1's root port: its best path now goes through SW3 and the direct link is blocked instead.
    const costly = run(net, 'SW1: en', 'SW1: conf t', 'SW1: int g0/7', 'SW1: spanning-tree cost 20', 'SW1: end');
    expect(stpVlan(costly, 'SW1', 10)!.rootPort).toBe('GigabitEthernet0/8');
    expect(stpBlockedPorts(costly, 'SW1', 10)).toEqual(new Set(['GigabitEthernet0/7']));
    expect(executeOn(costly, 'SW1', 'show running-config').output).toContain(' spanning-tree cost 20');
    expect(ping(costly, 'PC-A', '192.168.10.12').success).toBe(true);
  });

  it('reconverges when a link goes down and marks the mode in the config', () => {
    const net = run(triangle(), 'SW3: en', 'SW3: conf t', 'SW3: int g0/7', 'SW3: shutdown', 'SW3: end');
    expect(stpVlan(net, 'SW1', 10)!.ports.map((p) => `${p.name} ${p.role}`)).toEqual(['GigabitEthernet0/1 Desg', 'GigabitEthernet0/7 Root']);
    expect(stpVlan(net, 'SW1', 10)!.rootCost).toBe(8);
    expect(ping(net, 'PC-A', '192.168.10.12').success).toBe(true);
    const rapid = run(net, 'SW1: en', 'SW1: conf t', 'SW1: spanning-tree mode rapid-pvst', 'SW1: end');
    expect(executeOn(rapid, 'SW1', 'show spanning-tree vlan 10').output[1]).toBe('  Spanning tree enabled protocol rstp');
    expect(executeOn(rapid, 'SW1', 'show running-config').output).toContain('spanning-tree mode rapid-pvst');
    expect(executeOn(rapid, 'SW1', 'show spanning-tree vlan 77').output[0]).toBe('Spanning tree instance(s) for vlan 77 does not exist.');
  });

  it('supports portfast and bpduguard, which err-disables a port facing a switch', () => {
    const net = run(triangle(), 'en', 'conf t', 'int g0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable', 'end');
    const g1 = net.devices['SW1'].interfaces['GigabitEthernet0/1'];
    expect(g1).toMatchObject({ portfast: true, bpduGuard: true });
    expect(g1.errDisabled).toBeFalsy();
    expect(executeOn(net, 'SW1', 'show spanning-tree vlan 10').output.find((l) => l.startsWith('Gi0/1'))).toBe('Gi0/1               Desg FWD 4         128.1    P2p Edge');
    const cfg = executeOn(net, 'SW1', 'show running-config').output;
    expect(cfg).toContain(' spanning-tree portfast');
    expect(cfg).toContain(' spanning-tree bpduguard enable');
    expect(ping(net, 'PC-A', '192.168.10.12').success).toBe(true);
    // The same on a trunk to another switch: BPDU guard shuts the port.
    const guarded = run(triangle(), 'en', 'conf t', 'int g0/8', 'spanning-tree bpduguard enable', 'end');
    const g8 = guarded.devices['SW1'].interfaces['GigabitEthernet0/8'];
    expect(g8.errDisabled).toBe(true);
    expect(executeOn(guarded, 'SW1', 'show interfaces status').output.find((l) => l.startsWith('Gi0/8'))).toContain('err-disabled');
    // Traffic still flows the other way round the triangle.
    expect(ping(guarded, 'PC-A', '192.168.10.12').success).toBe(true);
    const fixed = run(guarded, 'conf t', 'int g0/8', 'no spanning-tree bpduguard', 'shutdown', 'no shutdown', 'end');
    expect(fixed.devices['SW1'].interfaces['GigabitEthernet0/8'].errDisabled).toBeFalsy();
    expect(stpVlan(fixed, 'SW1', 10)!.rootPort).toBe('GigabitEthernet0/8');
  });
});

/**
 * Multi-area chain: R1 (area 1, LAN 192.168.1.0/24) -- R2 (ABR, 10.0.12.0/30 in area 1, 10.0.23.0/30 in area 0)
 *   -- R3 (ABR, 10.0.23.0/30 area 0, 10.0.34.0/30 area 2) -- R4 (area 2, LAN 192.168.4.0/24)
 */
function areas(opts: { r3Area?: number; r4Area?: number } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.12.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: { routerId: '1.1.1.1', networks: [['192.168.1.0', '0.0.0.255', 1], ['10.0.12.0', '0.0.0.3', 1]], passiveInterfaces: ['g0/0'] },
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { ipAddress: '10.0.12.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '10.0.23.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { ipAddress: '2.2.2.2', subnetMask: '255.255.255.255', shutdown: false } },
    ospf: { routerId: '2.2.2.2', networks: [['10.0.12.0', '0.0.0.3', 1], ['10.0.23.0', '0.0.0.3', 0], ['2.2.2.2', '0.0.0.0', 0]] },
  });
  const r3 = createRouter({
    hostname: 'R3',
    interfaces: { 'g0/0': { ipAddress: '10.0.23.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '10.0.34.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: { routerId: '3.3.3.3', networks: [['10.0.23.0', '0.0.0.3', 0], ['10.0.34.0', '0.0.0.3', opts.r3Area ?? 2]] },
  });
  const r4 = createRouter({
    hostname: 'R4',
    interfaces: { 'g0/0': { ipAddress: '10.0.34.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '192.168.4.1', subnetMask: '255.255.255.0', shutdown: false } },
    ospf: { routerId: '4.4.4.4', networks: [['10.0.34.0', '0.0.0.3', opts.r4Area ?? 2], ['192.168.4.0', '0.0.0.255', opts.r4Area ?? 2]], passiveInterfaces: ['g0/1'] },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2, r3, r4],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-D', ip: '192.168.4.10', mask: '255.255.255.0', gateway: '192.168.4.1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/0'], ['R2:g0/1', 'R3:g0/0'], ['R3:g0/1', 'R4:g0/0'], ['R4:g0/1', 'PC-D']],
  });
}

describe('multi-area OSPF', () => {
  it('learns other areas as O IA through the ABRs and keeps intra-area routes as O', () => {
    const net = areas();
    const r1 = routingTable(net, 'R1');
    const find = (dst: string) => r1.find((e) => e.destination === dst);
    expect(find('10.0.23.0')).toMatchObject({ source: 'ospf-ia', nextHop: '10.0.12.2', metric: 2 });
    expect(find('2.2.2.2')).toMatchObject({ source: 'ospf-ia', metric: 2 });
    expect(find('10.0.34.0')).toMatchObject({ source: 'ospf-ia', metric: 3 });
    expect(find('192.168.4.0')).toMatchObject({ source: 'ospf-ia', nextHop: '10.0.12.2', metric: 4 });
    const show = executeOn(net, 'R1', 'show ip route').output;
    expect(show.some((l) => l.startsWith('O IA  192.168.4.0/24 [110/4] via 10.0.12.2'))).toBe(true);
    // R2 sees area 1 and area 0 directly (O), area 2 via R3 (O IA).
    const r2 = routingTable(net, 'R2');
    expect(r2.find((e) => e.destination === '192.168.1.0')).toMatchObject({ source: 'ospf', metric: 2 });
    expect(r2.find((e) => e.destination === '10.0.34.0')).toMatchObject({ source: 'ospf-ia', metric: 2 });
    expect(r2.find((e) => e.destination === '192.168.4.0')).toMatchObject({ source: 'ospf-ia', metric: 3 });
    expect(ping(net, 'PC-A', '192.168.4.10').success).toBe(true);
    expect(executeOn(net, 'R1', 'show ip route ospf').output.filter((l) => l.startsWith('O IA'))).toHaveLength(4);
  });

  it('isolates an area that is not attached to the backbone', () => {
    // R3 puts its link to R4 in area 2 but R4 uses area 3: no adjacency at all.
    const mismatch = areas({ r4Area: 3 });
    expect(ospfNeighbors(mismatch, 'R4')).toHaveLength(0);
    // Both sides agree on area 2, but R3's other interface is in area 1 instead of 0: R3 is not a valid ABR.
    const r1 = createRouter({
      hostname: 'R1',
      interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.12.1', subnetMask: '255.255.255.252', shutdown: false } },
      ospf: { routerId: '1.1.1.1', networks: [['192.168.1.0', '0.0.0.255', 0], ['10.0.12.0', '0.0.0.3', 0]] },
    });
    const r2 = createRouter({
      hostname: 'R2',
      interfaces: { 'g0/0': { ipAddress: '10.0.12.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '10.0.23.1', subnetMask: '255.255.255.252', shutdown: false } },
      ospf: { routerId: '2.2.2.2', networks: [['10.0.12.0', '0.0.0.3', 0], ['10.0.23.0', '0.0.0.3', 1]] },
    });
    const r3 = createRouter({
      hostname: 'R3',
      interfaces: { 'g0/0': { ipAddress: '10.0.23.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '192.168.3.1', subnetMask: '255.255.255.0', shutdown: false } },
      ospf: { routerId: '3.3.3.3', networks: [['10.0.23.0', '0.0.0.3', 1], ['192.168.3.0', '0.0.0.255', 2]] },
    });
    const net = buildNetwork({ primary: 'R1', devices: [r1, r2, r3], hosts: [{ id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }, { id: 'PC-C', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' }], links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/0'], ['R2:g0/1', 'R3:g0/0'], ['R3:g0/1', 'PC-C']] });
    const r1Routes = routingTable(net, 'R1');
    expect(r1Routes.find((e) => e.destination === '10.0.23.0')).toMatchObject({ source: 'ospf-ia' });
    // Area 2 hangs off area 1 (not the backbone): R1 never learns 192.168.3.0.
    expect(r1Routes.find((e) => e.destination === '192.168.3.0')).toBeUndefined();
    // R2 is inside area 1 with R3 and does see 192.168.3.0? No: R3 is not backbone-attached, so it is not an ABR.
    expect(routingTable(net, 'R2').find((e) => e.destination === '192.168.3.0')).toBeUndefined();
    // Fixing R3 so area 1 becomes the backbone side is wrong; moving R2's link to area 0 fixes it properly.
    const fixed = run(net, 'R2: en', 'R2: conf t', 'R2: router ospf 1', 'R2: no network 10.0.23.0 0.0.0.3 area 1', 'R2: network 10.0.23.0 0.0.0.3 area 0', 'R2: end', 'R3: en', 'R3: conf t', 'R3: router ospf 1', 'R3: no network 10.0.23.0 0.0.0.3 area 1', 'R3: network 10.0.23.0 0.0.0.3 area 0', 'R3: end');
    expect(routingTable(fixed, 'R1').find((e) => e.destination === '192.168.3.0')).toMatchObject({ source: 'ospf-ia', metric: 3 });
    expect(routingTable(fixed, 'R3').find((e) => e.destination === '192.168.1.0')).toMatchObject({ source: 'ospf', metric: 3 });
  });

  it('prefers an intra-area route over an inter-area route to the same prefix', () => {
    // Square: R1-R2 (area 0), R2-R3 (area 0), R1-R4 (area 1), R4-R3 (area 1). R3 LAN in area 0.
    const mk = (hostname: string, rid: string, ifs: Record<string, [string, number]>, extra: Array<[string, string, number]> = []) =>
      createRouter({
        hostname,
        ports: 3,
        interfaces: Object.fromEntries(Object.entries(ifs).map(([k, [ip]]) => [k, { ipAddress: ip, subnetMask: ip.startsWith('192') ? '255.255.255.0' : '255.255.255.252', shutdown: false }])),
        ospf: { routerId: rid, networks: [...Object.values(ifs).map(([ip, area]): [string, string, number] => [ip.startsWith('192') ? ip.replace(/\.\d+$/, '.0') : ip.replace(/\.(\d+)$/, (_, d) => `.${Math.floor(Number(d) / 4) * 4}`), ip.startsWith('192') ? '0.0.0.255' : '0.0.0.3', area]), ...extra] },
      });
    const r1 = mk('R1', '1.1.1.1', { 'g0/0': ['10.0.12.1', 0], 'g0/1': ['10.0.14.1', 1] });
    const r2 = mk('R2', '2.2.2.2', { 'g0/0': ['10.0.12.2', 0], 'g0/1': ['10.0.23.1', 0] });
    const r3 = mk('R3', '3.3.3.3', { 'g0/0': ['10.0.23.2', 0], 'g0/1': ['10.0.34.2', 1], 'g0/2': ['192.168.3.1', 0] });
    const r4 = mk('R4', '4.4.4.4', { 'g0/0': ['10.0.14.2', 1], 'g0/1': ['10.0.34.1', 1] });
    const net = buildNetwork({ primary: 'R1', devices: [r1, r2, r3, r4], hosts: [{ id: 'PC-C', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' }], links: [['R1:g0/0', 'R2:g0/0'], ['R2:g0/1', 'R3:g0/0'], ['R1:g0/1', 'R4:g0/0'], ['R4:g0/1', 'R3:g0/1'], ['R3:g0/2', 'PC-C']] });
    const route = routingTable(net, 'R1').find((e) => e.destination === '192.168.3.0');
    // Both paths cost 3; the backbone (intra-area) path via R2 wins.
    expect(route).toMatchObject({ source: 'ospf', nextHop: '10.0.12.2', metric: 3 });
    // 10.0.34.0/30 is in area 1: R1 reaches it intra-area through R4 at cost 2 rather than O IA via R3.
    expect(routingTable(net, 'R1').find((e) => e.destination === '10.0.34.0')).toMatchObject({ source: 'ospf', nextHop: '10.0.14.2', metric: 2 });
  });
});
