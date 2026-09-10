import { describe, expect, it } from 'vitest';
import { buildNetwork, createRouter, createSwitch, executeHost, executeOn, ping, prompt, routingTable, type NetworkState } from './index';

/** Run lines against a network. "R2: ip route ..." targets another node; default is the primary. */
function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

/**
 * PC-A, PC-C - SW1 - R1 g0/0 (192.168.1.1) | R1 g0/1 (10.0.0.1) --- (10.0.0.2) R2 g0/1 | R2 g0/0 (192.168.2.1) - PC-B
 * PC-C has no default gateway.
 */
function twoRouters(): NetworkState {
  const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } } });
  const r2 = createRouter({ hostname: 'R2', interfaces: { 'g0/0': { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } } });
  const sw = createSwitch({ hostname: 'SW1', ports: 8 });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2, sw],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' },
      { id: 'PC-C', ip: '192.168.1.11', mask: '255.255.255.0' },
    ],
    links: [
      ['PC-A', 'SW1:g0/1'],
      ['PC-C', 'SW1:g0/2'],
      ['SW1:g0/8', 'R1:g0/0'],
      ['R1:g0/1', 'R2:g0/1'],
      ['R2:g0/0', 'PC-B'],
    ],
  });
}

describe('routing table', () => {
  it('builds connected and local routes for up interfaces only', () => {
    const net = twoRouters();
    const table = routingTable(net, 'R1');
    expect(table.map((e) => `${e.source} ${e.destination}/${e.prefix}`)).toEqual(['connected 10.0.0.0/30', 'local 10.0.0.1/32', 'connected 192.168.1.0/24', 'local 192.168.1.1/32']);
    const down = run(net, 'en', 'conf t', 'int g0/1', 'shutdown');
    expect(routingTable(down, 'R1').some((e) => e.destination === '10.0.0.0')).toBe(false);
  });

  it('installs static routes only when the next hop is reachable', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'ip route 172.16.0.0 255.255.0.0 10.9.9.9');
    const table = routingTable(net, 'R1');
    expect(table.find((e) => e.destination === '192.168.2.0')).toMatchObject({ source: 'static', nextHop: '10.0.0.2', exitInterface: 'GigabitEthernet0/1', adminDistance: 1 });
    expect(table.some((e) => e.destination === '172.16.0.0')).toBe(false);
  });

  it('renders show ip route the IOS way', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end');
    const out = executeOn(net, 'R1', 'show ip route').output;
    expect(out).toContain('Gateway of last resort is 10.0.0.2 to network 0.0.0.0');
    expect(out).toContain('S*    0.0.0.0/0 [1/0] via 10.0.0.2');
    expect(out).toContain('      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks');
    expect(out).toContain('C        10.0.0.0/30 is directly connected, GigabitEthernet0/1');
    expect(out).toContain('L        10.0.0.1/32 is directly connected, GigabitEthernet0/1');
    expect(out).toContain('S     192.168.2.0/24 [1/0] via 10.0.0.2');
  });
});

describe('forwarding', () => {
  it('pings a directly connected host from the router', () => {
    expect(ping(twoRouters(), 'R1', '192.168.1.10').success).toBe(true);
    expect(ping(twoRouters(), 'R1', '10.0.0.2').success).toBe(true);
    expect(ping(twoRouters(), 'R1', '192.168.2.10').success).toBe(false);
  });

  it('needs routes in both directions for an end-to-end ping', () => {
    const oneWay = run(twoRouters(), 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2');
    const r = ping(oneWay, 'PC-A', '192.168.2.10');
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/no return path/);
    const bothWays = run(oneWay, 'R2: en', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1');
    const ok = ping(bothWays, 'PC-A', '192.168.2.10');
    expect(ok.success).toBe(true);
    expect(ok.hops.map((h) => h.ip)).toEqual(['192.168.1.1', '10.0.0.2', '192.168.2.10']);
  });

  it('hosts without a gateway cannot leave their subnet', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'R2: en', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1');
    expect(ping(net, 'PC-C', '192.168.1.10').success).toBe(true);
    const r = ping(net, 'PC-C', '192.168.2.10');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no gateway');
  });

  it('follows a default route and an exit-interface static route', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'R2: en', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 g0/1');
    expect(ping(net, 'PC-A', '192.168.2.10').success).toBe(true);
  });

  it('routes between VLANs with router-on-a-stick subinterfaces', () => {
    const sw = createSwitch({ hostname: 'SW1', ports: 8, vlans: [{ id: 10 }, { id: 20 }], interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 }, 'g0/2': { mode: 'access', accessVlan: 20 }, 'g0/8': { mode: 'trunk' } } });
    const r1 = createRouter({ hostname: 'R1' });
    const base = buildNetwork({
      primary: 'R1',
      devices: [r1, sw],
      hosts: [
        { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
        { id: 'PC-B', ip: '192.168.20.10', mask: '255.255.255.0', gateway: '192.168.20.1' },
      ],
      links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0']],
    });
    expect(ping(base, 'PC-A', '192.168.20.10').success).toBe(false);
    const net = run(base, 'en', 'conf t', 'int g0/0', 'no shut', 'int g0/0.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1q 20', 'ip address 192.168.20.1 255.255.255.0', 'end');
    expect(prompt(run(net, 'conf t', 'int g0/0.10').devices['R1'])).toBe('R1(config-subif)#');
    expect(ping(net, 'PC-A', '192.168.20.10').success).toBe(true);
    expect(ping(net, 'PC-A', '192.168.10.1').success).toBe(true);
    // Pruning VLAN 20 from the trunk breaks HR only.
    const pruned = run(net, 'SW1: en', 'SW1: conf t', 'SW1: int g0/8', 'SW1: switchport trunk allowed vlan 10');
    expect(ping(pruned, 'PC-A', '192.168.20.10').success).toBe(false);
    expect(ping(pruned, 'PC-A', '192.168.10.1').success).toBe(true);
  });

  it('reflects a shut peer port in link state and blocks traffic', () => {
    const net = run(twoRouters(), 'R2: en', 'R2: conf t', 'R2: int g0/1', 'R2: shutdown');
    expect(net.devices['R1'].interfaces['GigabitEthernet0/1'].connected).toBe(false);
    expect(ping(net, 'R1', '10.0.0.2').success).toBe(false);
    const brief = executeOn(net, 'R1', 'show ip interface brief').output;
    expect(brief.find((l) => l.startsWith('GigabitEthernet0/1'))).toMatch(/down\s+down$/);
  });
});

describe('host terminal', () => {
  it('prints ipconfig and Windows-style ping output', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'R2: en', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1');
    const cfg = executeHost(net, 'PC-A', 'ipconfig').output;
    expect(cfg.some((l) => l.includes('IPv4 Address') && l.endsWith('192.168.1.10'))).toBe(true);
    expect(cfg.some((l) => l.includes('Default Gateway') && l.endsWith('192.168.1.1'))).toBe(true);
    const ok = executeHost(net, 'PC-A', 'ping 192.168.2.10');
    expect(ok.output[1]).toBe('Reply from 192.168.2.10: bytes=32 time<1ms TTL=126');
    expect(ok.network.hosts['PC-A'].pings).toEqual([{ target: '192.168.2.10', success: true }]);
    const bad = executeHost(net, 'PC-A', 'ping 192.168.9.9').output;
    expect(bad[1]).toBe('Request timed out.');
    expect(executeHost(net, 'PC-C', 'ping 192.168.2.10').output[0]).toBe('PING: transmit failed. General failure.');
    const trace = executeHost(net, 'PC-A', 'tracert 192.168.2.10').output;
    expect(trace[2]).toMatch(/1\s+<1 ms\s+<1 ms\s+<1 ms\s+192\.168\.1\.1$/);
    expect(trace[4]).toMatch(/192\.168\.2\.10$/);
  });
});

describe('router commands', () => {
  it('validates static routes', () => {
    const net = twoRouters();
    expect(executeOn(net, 'R1', 'conf t').output[1]).toMatch(/Unknown command/);
    const priv = run(net, 'en', 'conf t');
    expect(executeOn(priv, 'R1', 'ip route 192.168.2.5 255.255.255.0 10.0.0.2').output[0]).toBe('%Inconsistent address and mask');
    expect(executeOn(priv, 'R1', 'ip route 192.168.2.0 255.255.255.0 g0/9').output[0]).toBe("% Invalid input detected at '^' marker.");
    const withRoute = run(priv, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2 5');
    expect(withRoute.devices['R1'].staticRoutes).toEqual([{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2', adminDistance: 5 }]);
    expect(executeOn(withRoute, 'R1', 'do show running-config').output).toContain('ip route 192.168.2.0 255.255.255.0 10.0.0.2 5');
    const removed = run(withRoute, 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2');
    expect(removed.devices['R1'].staticRoutes).toEqual([]);
    expect(executeOn(removed, 'R1', 'no ip route 192.168.2.0 255.255.255.0').output[0]).toBe('%No matching route to delete');
  });

  it('rejects switch-only commands on a router', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'int g0/0');
    expect(executeOn(net, 'R1', 'switchport mode access').output[1]).toBe("% Invalid input detected at '^' marker.");
    expect(executeOn(net, 'R1', 'vlan 10').output[1]).toBe("% Invalid input detected at '^' marker.");
  });

  it('requires encapsulation before addressing a subinterface', () => {
    const net = run(twoRouters(), 'en', 'conf t', 'int g0/0.10');
    expect(executeOn(net, 'R1', 'ip address 10.1.1.1 255.255.255.0').output[0]).toMatch(/only allowed if that/);
    expect(executeOn(run(net, 'int g0/0'), 'R1', 'encapsulation dot1q 10').output[0]).toBe('% Encapsulation is only supported on subinterfaces.');
  });
});
