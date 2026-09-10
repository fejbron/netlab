import { describe, expect, it } from 'vitest';
import { eui64Address, formatIpv6, linkLocalFromMac, normalizeIpv6, parseIpv6, parsePrefix6 } from './ipv6';
import { buildNetwork, createRouter, createSwitch, executeHost, executeOn, ping, routingTable6, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

describe('IPv6 addressing', () => {
  it('parses and formats per RFC 5952 in upper case', () => {
    expect(normalizeIpv6('2001:db8:0:0:0:0:0:1')).toBe('2001:DB8::1');
    expect(normalizeIpv6('2001:0db8:0000:0001:0000:0000:0000:0001')).toBe('2001:DB8:0:1::1');
    expect(normalizeIpv6('::')).toBe('::');
    expect(normalizeIpv6('::1')).toBe('::1');
    expect(normalizeIpv6('fe80::1')).toBe('FE80::1');
    expect(normalizeIpv6('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8');
    expect(normalizeIpv6('2001:db8::1::2')).toBeNull();
    expect(normalizeIpv6('2001:db8:1')).toBeNull();
    expect(normalizeIpv6('12345::')).toBeNull();
    expect(formatIpv6(parseIpv6('2001:db8:0:0:1:0:0:1')!)).toBe('2001:DB8::1:0:0:1');
    expect(parsePrefix6('2001:db8:1::/64')).toEqual({ address: '2001:DB8:1::', length: 64 });
    expect(parsePrefix6('2001:db8:1::/129')).toBeNull();
  });

  it('derives EUI-64 and link-local addresses from a MAC', () => {
    expect(linkLocalFromMac('0011.22cc.1a2b')).toBe('FE80::211:22FF:FECC:1A2B');
    expect(eui64Address('2001:DB8:12::', 64, '0011.22cc.1a2b')).toBe('2001:DB8:12:0:211:22FF:FECC:1A2B');
  });
});

/** PC-A (2001:DB8:1::10) - R1 g0/0 | R1 g0/1 (2001:DB8:12::1) --- (::2, FE80::2) R2 g0/1 | R2 g0/0 - PC-B (2001:DB8:2::10); R2 lo0 2001:DB8:FFFF::1 */
function v6Sites(r1Ready = true): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: r1Ready
      ? { 'g0/0': { shutdown: false, ipv6: { enabled: true, addresses: [{ address: '2001:DB8:1::1', prefix: 64 }] } }, 'g0/1': { shutdown: false, ipv6: { enabled: true, addresses: [{ address: '2001:DB8:12::1', prefix: 64 }] } } }
      : {},
    ipv6: { unicastRouting: r1Ready },
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: {
      'g0/0': { shutdown: false, ipv6: { enabled: true, addresses: [{ address: '2001:DB8:2::1', prefix: 64 }] } },
      'g0/1': { shutdown: false, ipv6: { enabled: true, addresses: [{ address: '2001:DB8:12::2', prefix: 64 }], linkLocal: 'FE80::2' } },
      lo0: { ipv6: { enabled: true, addresses: [{ address: '2001:DB8:FFFF::1', prefix: 128 }] } },
    },
    ipv6: { unicastRouting: true, routes: [['2001:DB8:1::/64', '2001:DB8:12::1']] },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2],
    hosts: [
      { id: 'PC-A', ip6: '2001:DB8:1::10/64', gateway6: '2001:DB8:1::1' },
      { id: 'PC-B', ip6: '2001:DB8:2::10/64', gateway6: '2001:DB8:2::1' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'PC-B']],
  });
}

describe('IPv6 forwarding', () => {
  it('builds connected and local routes and pings on the link', () => {
    const net = v6Sites();
    expect(routingTable6(net, 'R1').map((e) => `${e.source} ${e.prefix}/${e.length}`)).toEqual(['connected 2001:DB8:1::/64', 'local 2001:DB8:1::1/128', 'connected 2001:DB8:12::/64', 'local 2001:DB8:12::1/128']);
    expect(ping(net, 'R1', '2001:db8:1::10').success).toBe(true);
    expect(ping(net, 'PC-A', '2001:DB8:1::1').success).toBe(true);
    expect(ping(net, 'R1', '2001:DB8:12::2').success).toBe(true);
    expect(ping(net, 'R1', 'fe80::2').success).toBe(true);
    expect(ping(net, 'PC-A', '2001:DB8:2::10').success).toBe(false);
  });

  it('routes with a static route, a link-local next hop and a default', () => {
    const net = run(v6Sites(), 'en', 'conf t', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'end');
    expect(ping(net, 'PC-A', '2001:DB8:2::10').success).toBe(true);
    expect(executeHost(net, 'PC-A', 'ping 2001:db8:2::10').output[1]).toBe('Reply from 2001:DB8:2::10: time<1ms');
    expect(ping(net, 'PC-A', '2001:DB8:FFFF::1').success).toBe(false);
    expect(executeOn(run(net, 'conf t'), 'R1', 'ipv6 route ::/0 fe80::2').output[0]).toBe('% Interface has to be specified for a link-local nexthop');
    const withDefault = run(net, 'conf t', 'ipv6 route ::/0 g0/1 fe80::2', 'end');
    expect(ping(withDefault, 'PC-A', '2001:DB8:FFFF::1').success).toBe(true);
    const route = executeOn(withDefault, 'R1', 'show ipv6 route').output;
    expect(route).toContain('S   ::/0 [1/0]');
    expect(route).toContain('     via FE80::2, GigabitEthernet0/1');
    expect(route).toContain('S   2001:DB8:2::/64 [1/0]');
    expect(route).toContain('C   2001:DB8:1::/64 [0/0]');
    expect(executeOn(withDefault, 'R1', 'show running-config').output).toContain('ipv6 route ::/0 GigabitEthernet0/1 FE80::2');
  });

  it('requires ipv6 unicast-routing to forward and renders show ipv6 interface brief', () => {
    const base = run(v6Sites(false), 'en', 'conf t', 'int g0/0', 'ipv6 address 2001:db8:1::1/64', 'no shut', 'int g0/1', 'ipv6 address 2001:db8:12::/64 eui-64', 'ipv6 address 2001:db8:12::1/64', 'ipv6 address fe80::1 link-local', 'no shut', 'exit', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'end');
    const brief = executeOn(base, 'R1', 'show ipv6 interface brief').output;
    expect(brief[0]).toBe('GigabitEthernet0/0     [up/up]');
    expect(brief[2]).toBe('    2001:DB8:1::1');
    expect(brief[4]).toBe('    FE80::1');
    expect(brief[5]).toMatch(/^    2001:DB8:12:0:[0-9A-F:]+$/);
    expect(brief[6]).toBe('    2001:DB8:12::1');
    expect(base.devices['R1'].interfaces['GigabitEthernet0/1'].ipv6?.addresses[0].eui64).toBe(true);
    expect(executeOn(base, 'R1', 'show running-config').output).toContain(' ipv6 address 2001:DB8:12::/64 eui-64');
    // Without unicast routing the static route is not installed and transit fails.
    expect(ping(base, 'PC-A', '2001:DB8:2::10').success).toBe(false);
    const routing = run(base, 'conf t', 'ipv6 unicast-routing', 'end');
    expect(ping(routing, 'PC-A', '2001:DB8:2::10').success).toBe(true);
    expect(ping(routing, 'PC-B', '2001:DB8:1::10').hops.map((h) => h.ip)).toEqual(['2001:DB8:2::1', expect.stringMatching(/^2001:DB8:12:0:/), '2001:DB8:1::10']);
  });
});

/** LAN 192.168.10.0/24 (PC-A .10, PC-B .11, SRV1 .20) - SW1 - R1 g0/0 | R1 g0/1 203.0.113.2/30 --- ISP (lo0 8.8.8.8, NET-PC 198.51.100.10) */
function natEdge(): NetworkState {
  const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '203.0.113.2', subnetMask: '255.255.255.252', shutdown: false } }, staticRoutes: [{ destination: '0.0.0.0', mask: '0.0.0.0', nextHop: '203.0.113.1' }] });
  const isp = createRouter({
    hostname: 'ISP',
    interfaces: { 'g0/0': { ipAddress: '203.0.113.1', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '198.51.100.1', subnetMask: '255.255.255.0', shutdown: false }, lo0: { ipAddress: '8.8.8.8', subnetMask: '255.255.255.255' } },
    staticRoutes: [{ destination: '203.0.113.0', mask: '255.255.255.0', nextHop: '203.0.113.2' }],
  });
  const sw = createSwitch({ hostname: 'SW1', ports: 8 });
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

describe('NAT', () => {
  it('fails without NAT because the ISP cannot route private addresses back', () => {
    const r = ping(natEdge(), 'PC-A', '8.8.8.8');
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/no return path/);
  });

  it('translates with PAT on the outside interface and records translations', () => {
    const net = run(natEdge(), 'en', 'conf t', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 interface g0/1 overload', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end');
    const after = run(net, 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8');
    expect(after.hosts['PC-A'].pings[0].success).toBe(true);
    expect(after.hosts['PC-B'].pings[0].success).toBe(true);
    const t = after.devices['R1'].natTranslations;
    expect(t).toHaveLength(2);
    expect(t.map((x) => `${x.proto} ${x.insideLocal}->${x.insideGlobal}:${x.insideGlobalPort}`)).toEqual(['icmp 192.168.10.10->203.0.113.2:1024', 'icmp 192.168.10.11->203.0.113.2:1025']);
    const show = executeOn(after, 'R1', 'show ip nat translations').output;
    expect(show[0]).toBe('Pro  Inside global         Inside local          Outside local         Outside global');
    expect(show[1]).toMatch(/^icmp 203\.0\.113\.2:1024\s+192\.168\.10\.10:\d+\s+8\.8\.8\.8:\d+\s+8\.8\.8\.8:\d+$/);
    expect(executeOn(after, 'R1', 'show ip nat statistics').output[0]).toBe('Total active translations: 2 (0 static, 2 dynamic; 2 extended)');
    expect(executeOn(after, 'R1', 'show running-config').output).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    // Router-originated traffic is not translated and still works.
    expect(ping(after, 'R1', '8.8.8.8').success).toBe(true);
    expect(run(after, 'clear ip nat translation *').devices['R1'].natTranslations).toHaveLength(0);
  });

  it('exposes a server with static NAT in both directions', () => {
    const net = run(natEdge(), 'en', 'conf t', 'ip nat inside source static 192.168.10.20 203.0.113.10', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end');
    expect(ping(natEdge(), 'NET-PC', '203.0.113.10').success).toBe(false);
    const inbound = ping(net, 'NET-PC', '203.0.113.10');
    expect(inbound.success).toBe(true);
    expect(inbound.hops.map((h) => h.ip)).toEqual(['198.51.100.1', '203.0.113.2', '192.168.10.20']);
    expect(ping(net, 'SRV1', '8.8.8.8').success).toBe(true);
    // PC-A is not covered by the static entry and has no dynamic rule.
    expect(ping(net, 'PC-A', '8.8.8.8').success).toBe(false);
    const show = executeOn(net, 'R1', 'show ip nat translations').output;
    expect(show[1]).toMatch(/^---\s+203\.0\.113\.10\s+192\.168\.10\.20\s+---\s+---$/);
    expect(executeOn(run(net, 'conf t'), 'R1', 'ip nat inside source static 192.168.10.20 203.0.113.11').output[0]).toMatch(/already exists/);
  });

  it('runs out of addresses in a dynamic pool until overload is added', () => {
    const net = run(natEdge(), 'en', 'conf t', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat pool PUBLIC 203.0.113.20 203.0.113.21 netmask 255.255.255.0', 'ip nat inside source list 1 pool PUBLIC', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end');
    const used = run(net, 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8', 'SRV1: ping 8.8.8.8');
    expect(used.hosts['PC-A'].pings[0].success).toBe(true);
    expect(used.hosts['PC-B'].pings[0].success).toBe(true);
    expect(used.hosts['SRV1'].pings[0].success).toBe(false);
    expect(ping(used, 'SRV1', '8.8.8.8').reason).toBe('nat pool exhausted');
    const mappings = used.devices['R1'].natTranslations.filter((t) => t.proto === '---').map((t) => `${t.insideLocal}->${t.insideGlobal}`);
    expect(mappings).toEqual(['192.168.10.10->203.0.113.20', '192.168.10.11->203.0.113.21']);
    expect(executeOn(run(net, 'conf t'), 'R1', 'no ip nat pool PUBLIC').output[0]).toMatch(/in use/);
    const overload = run(used, 'conf t', 'ip nat inside source list 1 pool PUBLIC overload', 'end', 'SRV1: ping 8.8.8.8');
    expect(overload.hosts['SRV1'].pings[1].success).toBe(true);
    expect(executeOn(overload, 'R1', 'show running-config').output).toContain('ip nat inside source list 1 pool PUBLIC overload');
  });
});
