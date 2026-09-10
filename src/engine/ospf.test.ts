import { describe, expect, it } from 'vitest';
import { buildNetwork, createRouter, executeHost, executeOn, ospfNeighbors, ping, prompt, routingTable, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

/** R1 (192.168.1.0/24, PC-A) --10.0.12.0/30-- R2 (192.168.2.0/24, PC-B) --10.0.23.0/30-- R3 (192.168.3.0/24, PC-C) */
function chain(ospf: { R1?: boolean; R2?: boolean; R3?: boolean } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.12.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: ospf.R1 ? { routerId: '1.1.1.1', networks: [['192.168.1.0', '0.0.0.255', 0], ['10.0.12.0', '0.0.0.3', 0]] } : undefined,
  });
  const r2 = createRouter({
    hostname: 'R2',
    ports: 3,
    interfaces: { 'g0/0': { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.12.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/2': { ipAddress: '10.0.23.1', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: ospf.R2 ? { routerId: '2.2.2.2', networks: [['192.168.2.0', '0.0.0.255', 0], ['10.0.12.0', '0.0.0.3', 0], ['10.0.23.0', '0.0.0.3', 0]] } : undefined,
  });
  const r3 = createRouter({
    hostname: 'R3',
    interfaces: { 'g0/0': { ipAddress: '192.168.3.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.23.2', subnetMask: '255.255.255.252', shutdown: false } },
    ospf: ospf.R3 ? { routerId: '3.3.3.3', networks: [['192.168.3.0', '0.0.0.255', 0], ['10.0.23.0', '0.0.0.3', 0]] } : undefined,
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2, r3],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' },
      { id: 'PC-C', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B'], ['R2:g0/2', 'R3:g0/1'], ['R3:g0/0', 'PC-C']],
  });
}

describe('OSPF neighbours', () => {
  it('forms adjacencies on shared subnets in the same area and elects DR/BDR by router-id', () => {
    const net = chain({ R1: true, R2: true, R3: true });
    const r1 = ospfNeighbors(net, 'R1');
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ routerId: '2.2.2.2', ip: '10.0.12.2', localIface: 'GigabitEthernet0/1', state: 'FULL/DR' });
    const r2 = ospfNeighbors(net, 'R2');
    expect(r2.map((n) => `${n.routerId} ${n.state}`)).toEqual(['1.1.1.1 FULL/BDR', '3.3.3.3 FULL/DR']);
  });

  it('does not form when areas differ or a side is passive', () => {
    const base = chain({ R1: true, R2: true });
    const mismatch = run(base, 'en', 'conf t', 'router ospf 1', 'no network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.12.0 0.0.0.3 area 1');
    expect(ospfNeighbors(mismatch, 'R1')).toHaveLength(0);
    const passive = run(base, 'en', 'conf t', 'router ospf 1', 'passive-interface g0/1');
    expect(ospfNeighbors(passive, 'R1')).toHaveLength(0);
    expect(ospfNeighbors(passive, 'R2')).toHaveLength(0);
  });

  it('honours a configured router-id over interface addresses', () => {
    const net = run(chain({ R2: true }), 'en', 'conf t', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'end');
    // No router-id configured on R1: highest active interface address.
    expect(ospfNeighbors(net, 'R2').map((n) => n.routerId)).toEqual(['192.168.1.1']);
    const withId = run(net, 'conf t', 'router ospf 1', 'router-id 1.1.1.1');
    expect(ospfNeighbors(withId, 'R2').map((n) => n.routerId)).toEqual(['1.1.1.1']);
  });
});

describe('OSPF routes', () => {
  it('learns every OSPF network with hop-by-hop metrics and reaches end to end', () => {
    const net = chain({ R1: true, R2: true, R3: true });
    const table = routingTable(net, 'R1');
    const o = table.filter((e) => e.source === 'ospf').map((e) => `${e.destination}/${e.prefix} [${e.adminDistance}/${e.metric}] via ${e.nextHop}`);
    expect(o).toEqual(['10.0.23.0/30 [110/2] via 10.0.12.2', '192.168.2.0/24 [110/2] via 10.0.12.2', '192.168.3.0/24 [110/3] via 10.0.12.2']);
    expect(ping(net, 'PC-A', '192.168.3.10').success).toBe(true);
    expect(ping(net, 'PC-C', '192.168.1.10').hops.map((h) => h.ip)).toEqual(['192.168.3.1', '10.0.23.1', '10.0.12.1', '192.168.1.10']);
  });

  it('is only partial until every router runs OSPF', () => {
    const net = chain({ R1: true, R3: true });
    expect(routingTable(net, 'R1').some((e) => e.source === 'ospf')).toBe(false);
    const fixed = run(net, 'R2: en', 'R2: conf t', 'R2: router ospf 1', 'R2: router-id 2.2.2.2', 'R2: network 192.168.2.0 0.0.0.255 area 0', 'R2: network 10.0.12.0 0.0.0.3 area 0', 'R2: network 10.0.23.0 0.0.0.3 area 0');
    expect(routingTable(fixed, 'R1').some((e) => e.destination === '192.168.3.0' && e.source === 'ospf')).toBe(true);
    expect(ping(fixed, 'PC-A', '192.168.3.10').success).toBe(true);
  });

  it('uses interface cost and prefers static routes by administrative distance', () => {
    const net = run(chain({ R1: true, R2: true, R3: true }), 'en', 'conf t', 'int g0/1', 'ip ospf cost 10', 'end');
    expect(routingTable(net, 'R1').find((e) => e.destination === '192.168.2.0')).toMatchObject({ source: 'ospf', metric: 11 });
    const withStatic = run(net, 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.12.2');
    expect(routingTable(withStatic, 'R1').find((e) => e.destination === '192.168.2.0')).toMatchObject({ source: 'static', adminDistance: 1 });
  });

  it('propagates a default route with default-information originate', () => {
    const isp = createRouter({ hostname: 'ISP', interfaces: { 'g0/0': { ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false }, lo0: { ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' } }, staticRoutes: [{ destination: '192.168.0.0', mask: '255.255.0.0', nextHop: '203.0.113.2' }, { destination: '10.0.0.0', mask: '255.0.0.0', nextHop: '203.0.113.2' }] });
    const base = chain({ R1: true, R2: true, R3: true });
    const r1 = { ...base.devices['R1'], interfaces: { ...base.devices['R1'].interfaces, 'GigabitEthernet0/2': { name: 'GigabitEthernet0/2', shutdown: false, connected: false, mode: 'access' as const, accessVlan: 1, trunkAllowed: 'all' as const, nativeVlan: 1, ipAddress: '203.0.113.2', subnetMask: '255.255.255.252' } } };
    const net = buildNetwork({ primary: 'R1', devices: [r1, base.devices['R2'], base.devices['R3'], isp], hosts: Object.values(base.hosts).map((h) => ({ id: h.id, ip: h.ip, mask: h.mask, gateway: h.gateway })), links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B'], ['R2:g0/2', 'R3:g0/1'], ['R3:g0/0', 'PC-C'], ['R1:g0/2', 'ISP:g0/0']] });
    expect(ping(net, 'PC-C', '8.8.8.8').success).toBe(false);
    const withDefault = run(net, 'en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'router ospf 1', 'default-information originate', 'end');
    const r3 = routingTable(withDefault, 'R3').find((e) => e.candidateDefault);
    expect(r3).toMatchObject({ source: 'ospf-external', nextHop: '10.0.23.1', adminDistance: 110, metric: 1 });
    expect(executeOn(withDefault, 'R3', 'show ip route').output).toContain('O*E2  0.0.0.0/0 [110/1] via 10.0.23.1, 00:02:14, GigabitEthernet0/1');
    expect(ping(withDefault, 'PC-C', '8.8.8.8').success).toBe(true);
    expect(executeHost(withDefault, 'PC-C', 'ping 8.8.8.8').output[1]).toBe('Reply from 8.8.8.8: bytes=32 time<1ms TTL=125');
  });
});

describe('OSPF commands and output', () => {
  it('uses the router config prompt and renders show commands', () => {
    const cfg = run(chain({ R2: true }), 'en', 'conf t', 'router ospf 1');
    expect(prompt(cfg.devices['R1'])).toBe('R1(config-router)#');
    const net = run(cfg, 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'passive-interface g0/0', 'end');
    const nbr = executeOn(net, 'R1', 'show ip ospf neighbor').output;
    expect(nbr[2]).toMatch(/^2\.2\.2\.2\s+1\s+FULL\/DR\s+00:00:3\d\s+10\.0\.12\.2\s+GigabitEthernet0\/1$/);
    const brief = executeOn(net, 'R1', 'show ip ospf interface brief').output;
    expect(brief.find((l) => l.startsWith('Gi0/1'))).toMatch(/^Gi0\/1\s+1\s+0\s+10\.0\.12\.1\/30\s+1\s+BDR\s+1\/1$/);
    expect(brief.find((l) => l.startsWith('Gi0/0'))).toMatch(/DR\s+0\/0$/);
    const proto = executeOn(net, 'R1', 'show ip protocols').output;
    expect(proto).toContain('Routing Protocol is "ospf 1"');
    expect(proto).toContain('  Router ID 1.1.1.1');
    expect(proto).toContain('    192.168.1.0 0.0.0.255 area 0');
    expect(proto).toContain('    GigabitEthernet0/0');
    const route = executeOn(net, 'R1', 'show ip route').output;
    expect(route).toContain('O     192.168.2.0/24 [110/2] via 10.0.12.2, 00:02:14, GigabitEthernet0/1');
    const runCfg = executeOn(net, 'R1', 'show running-config').output;
    expect(runCfg).toContain('router ospf 1');
    expect(runCfg).toContain(' router-id 1.1.1.1');
    expect(runCfg).toContain(' passive-interface GigabitEthernet0/0');
    expect(runCfg).toContain(' network 10.0.12.0 0.0.0.3 area 0');
  });

  it('validates arguments and reports missing processes', () => {
    const net = run(chain(), 'en');
    expect(executeOn(net, 'R1', 'show ip ospf neighbor').output[0]).toBe('%OSPF: No router process configured');
    const cfg = run(net, 'conf t', 'router ospf 1');
    expect(executeOn(cfg, 'R1', 'network 192.168.1.0 0.0.0.255 area x').output[0]).toBe("% Invalid input detected at '^' marker.");
    expect(executeOn(cfg, 'R1', 'no network 192.168.9.0 0.0.0.255 area 0').output[0]).toBe('%OSPF: No such network statement');
    expect(executeOn(cfg, 'R1', 'passive-interface g0/9').output[0]).toBe("% Invalid input detected at '^' marker.");
    expect(executeOn(cfg, 'R1', 'router ospf 2').output[0]).toMatch(/already exists/);
  });

  it('enables OSPF per interface with ip ospf area', () => {
    const net = run(chain({ R2: true }), 'en', 'conf t', 'int g0/1', 'ip ospf 1 area 0', 'int g0/0', 'ip ospf 1 area 0', 'end');
    expect(ospfNeighbors(net, 'R1')).toHaveLength(1);
    expect(routingTable(net, 'R2').some((e) => e.destination === '192.168.1.0' && e.source === 'ospf')).toBe(true);
    expect(executeOn(net, 'R1', 'show running-config').output).toContain(' ip ospf 1 area 0');
  });
});
