import { describe, expect, it } from 'vitest';
import { evaluateAcl, parseExtendedRule, parseStandardRule, ruleText } from './acl';
import { buildNetwork, createRouter, createSwitch, executeHost, executeOn, ping, prompt, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

/** PC-A (VLAN 10), PC-B (VLAN 20) - SW1 - R1 g0/0 (ROAS) | R1 g0/1 (10.10.10.1) - SRV1 (10.10.10.10) */
function campus(): NetworkState {
  const sw = createSwitch({ hostname: 'SW1', ports: 8, vlans: [{ id: 10 }, { id: 20 }], interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 }, 'g0/2': { mode: 'access', accessVlan: 20 }, 'g0/8': { mode: 'trunk' } } });
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { shutdown: false },
      'g0/0.10': { encapsulation: { vlan: 10, native: false }, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0' },
      'g0/0.20': { encapsulation: { vlan: 20, native: false }, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0' },
      'g0/1': { ipAddress: '10.10.10.1', subnetMask: '255.255.255.0', shutdown: false },
    },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, sw],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1' },
      { id: 'PC-B', ip: '192.168.20.10', mask: '255.255.255.0', gateway: '192.168.20.1' },
      { id: 'SRV1', ip: '10.10.10.10', mask: '255.255.255.0', gateway: '10.10.10.1', kind: 'server' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'SRV1']],
  });
}

describe('ACL grammar', () => {
  it('parses standard and extended rules', () => {
    expect(parseStandardRule('permit', ['192.168.1.0', '0.0.0.255'])).toMatchObject({ src: { kind: 'wildcard', address: '192.168.1.0', wildcard: '0.0.0.255' } });
    expect(parseStandardRule('deny', ['host', '10.1.1.1'])).toMatchObject({ src: { kind: 'host', ip: '10.1.1.1' } });
    expect(parseStandardRule('permit', ['10.1.1.1'])).toMatchObject({ src: { kind: 'host', ip: '10.1.1.1' } });
    expect(parseStandardRule('permit', ['any'])).toMatchObject({ src: { kind: 'any' } });
    expect(parseStandardRule('permit', ['nonsense'])).toBeNull();
    expect(parseExtendedRule('permit', ['tcp', '192.168.1.0', '0.0.0.255', 'any', 'eq', 'www'])).toMatchObject({ protocol: 'tcp', dstPort: 80 });
    expect(parseExtendedRule('deny', ['icmp', 'any', 'host', '10.0.0.1', 'echo'])).toMatchObject({ protocol: 'icmp', icmpType: 'echo', dst: { kind: 'host', ip: '10.0.0.1' } });
    expect(parseExtendedRule('permit', ['ip', 'any', 'any'])).toMatchObject({ protocol: 'ip' });
    expect(parseExtendedRule('permit', ['ip', 'any'])).toBeNull();
    expect(parseExtendedRule('permit', ['icmp', 'any', 'any', 'eq', '80'])).toBeNull();
  });

  it('matches first entry and denies implicitly', () => {
    const acl = { name: 'T', kind: 'extended' as const, entries: [{ ...parseExtendedRule('deny', ['icmp', '192.168.20.0', '0.0.0.255', 'host', '10.10.10.10', 'echo'])!, seq: 10, matches: 0 }, { ...parseExtendedRule('permit', ['ip', 'any', 'any'])!, seq: 20, matches: 0 }] };
    expect(evaluateAcl(acl, { src: '192.168.20.5', dst: '10.10.10.10', protocol: 'icmp', icmpType: 'echo' })).toMatchObject({ permit: false, entry: { seq: 10 } });
    expect(evaluateAcl(acl, { src: '192.168.20.5', dst: '10.10.10.10', protocol: 'icmp', icmpType: 'echo-reply' })).toMatchObject({ permit: true, entry: { seq: 20 } });
    expect(evaluateAcl({ ...acl, entries: [acl.entries[0]] }, { src: '1.1.1.1', dst: '2.2.2.2', protocol: 'tcp' })).toEqual({ permit: false });
    expect(ruleText(acl.entries[0], 'extended')).toBe('deny icmp 192.168.20.0 0.0.0.255 host 10.10.10.10 echo');
  });
});

describe('ACL enforcement', () => {
  it('filters transit traffic with an outbound standard list but not router-originated pings', () => {
    const net = run(campus(), 'en', 'conf t', 'access-list 10 deny 192.168.20.0 0.0.0.255', 'access-list 10 permit any', 'int g0/1', 'ip access-group 10 out', 'end');
    expect(prompt(net.devices['R1'])).toBe('R1#');
    const hr = ping(net, 'PC-B', '10.10.10.10');
    expect(hr.success).toBe(false);
    expect(hr.denied).toMatchObject({ node: 'R1', acl: '10', ip: '192.168.20.1' });
    expect(ping(net, 'PC-A', '10.10.10.10').success).toBe(true);
    expect(ping(net, 'R1', '10.10.10.10').success).toBe(true);
    const out = executeHost(net, 'PC-B', 'ping 10.10.10.10').output;
    expect(out[1]).toBe('Reply from 192.168.20.1: Destination net unreachable.');
    const counted = run(net, 'PC-B: ping 10.10.10.10', 'PC-A: ping 10.10.10.10');
    const show = executeOn(counted, 'R1', 'show access-lists').output;
    expect(show[0]).toBe('Standard IP access list 10');
    expect(show[1]).toBe('    10 deny   192.168.20.0, wildcard bits 0.0.0.255 (1 match)');
    expect(show[2]).toBe('    20 permit any (1 match)');
    const again = run(counted, 'PC-A: ping 10.10.10.10');
    expect(executeOn(again, 'R1', 'show access-lists').output[2]).toBe('    20 permit any (2 matches)');
  });

  it('applies a named extended list inbound with ICMP type precision', () => {
    const net = run(campus(), 'en', 'conf t', 'ip access-list extended NO-PING-SRV', 'deny icmp 192.168.10.0 0.0.0.255 host 10.10.10.10 echo', 'permit ip any any', 'int g0/0.10', 'ip access-group NO-PING-SRV in', 'end');
    expect(prompt(run(campus(), 'en', 'conf t', 'ip access-list extended X').devices['R1'])).toBe('R1(config-ext-nacl)#');
    expect(ping(net, 'PC-A', '10.10.10.10').denied).toMatchObject({ acl: 'NO-PING-SRV', ip: '192.168.10.1' });
    expect(ping(net, 'PC-A', '192.168.20.10').success).toBe(true);
    expect(ping(net, 'PC-B', '10.10.10.10').success).toBe(true);
    // Replies from PC-A to SRV1 are echo-replies, which the list still permits.
    expect(ping(net, 'SRV1', '192.168.10.10').success).toBe(true);
    expect(executeOn(net, 'R1', 'show ip interface g0/0.10').output).toContain('  Inbound  access list is NO-PING-SRV');
    expect(executeOn(net, 'R1', 'show running-config').output).toContain(' 10 deny icmp 192.168.10.0 0.0.0.255 host 10.10.10.10 echo');
    expect(executeOn(net, 'R1', 'show running-config').output).toContain(' ip access-group NO-PING-SRV in');
  });

  it('honours the implicit deny and a filtered reply times out', () => {
    const blocked = run(campus(), 'en', 'conf t', 'ip access-list extended HR', 'deny icmp 192.168.20.0 0.0.0.255 host 10.10.10.10', 'int g0/0.20', 'ip access-group HR in', 'end');
    expect(ping(blocked, 'PC-B', '192.168.10.10').denied).toBeDefined();
    const fixed = run(blocked, 'conf t', 'ip access-list extended HR', 'permit ip any any', 'end');
    expect(ping(fixed, 'PC-B', '192.168.10.10').success).toBe(true);
    const replyFilter = run(campus(), 'en', 'conf t', 'ip access-list extended NOREPLY', 'deny icmp any any echo-reply', 'permit ip any any', 'int g0/0.10', 'ip access-group NOREPLY in', 'end');
    const r = ping(replyFilter, 'PC-B', '192.168.10.10');
    expect(r.success).toBe(false);
    expect(r.denied).toBeUndefined();
    expect(r.reason).toBe('reply filtered by acl');
    expect(executeHost(replyFilter, 'PC-B', 'ping 192.168.10.10').output[1]).toBe('Request timed out.');
  });

  it('supports sequence numbers, remarks, deletion and access-class', () => {
    const net = run(campus(), 'en', 'conf t', 'ip access-list standard MGMT', 'remark Admin PC only', 'permit host 192.168.10.10', '5 deny host 192.168.20.10', 'exit', 'line vty 0 4', 'access-class MGMT in', 'end');
    const acl = net.devices['R1'].acls['MGMT'];
    expect(acl.entries.map((e) => `${e.seq} ${e.action}`)).toEqual(['5 deny', '10 remark', '20 permit']);
    expect(net.devices['R1'].lines.vty.accessClass).toBe('MGMT');
    const cfg = executeOn(net, 'R1', 'show running-config').output;
    expect(cfg).toContain('ip access-list standard MGMT');
    expect(cfg).toContain(' 10 remark Admin PC only');
    expect(cfg).toContain(' access-class MGMT in');
    const removed = run(net, 'conf t', 'ip access-list standard MGMT', 'no 5');
    expect(removed.devices['R1'].acls['MGMT'].entries.map((e) => e.seq)).toEqual([10, 20]);
    expect(executeOn(removed, 'R1', 'no 99').output[0]).toBe('% Sequence number not found');
    expect(executeOn(run(campus(), 'en', 'conf t'), 'R1', 'access-list 10 permit banana').output[0]).toBe("% Invalid input detected at '^' marker.");
    expect(executeOn(run(campus(), 'en', 'conf t'), 'R1', 'access-list 10 permit tcp any any').output[0]).toBe("% Invalid input detected at '^' marker.");
    const gone = run(net, 'conf t', 'no ip access-list standard MGMT');
    expect(gone.devices['R1'].acls['MGMT']).toBeUndefined();
  });

  it('shows U.U.U on IOS when a downstream router denies the echo', () => {
    const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } }, staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }] });
    const r2 = createRouter({ hostname: 'R2', interfaces: { 'g0/0': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false }, 'g0/1': { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false } }, acls: { '100': { rules: ['deny icmp host 10.0.0.1 any', 'permit ip any any'] } } });
    let net = buildNetwork({ primary: 'R1', devices: [r1, r2], hosts: [{ id: 'PC-B', ip: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' }], links: [['R1:g0/0', 'R2:g0/0'], ['R2:g0/1', 'PC-B']] });
    net = run(net, 'R2: en', 'R2: conf t', 'R2: int g0/0', 'R2: ip access-group 100 in', 'R2: end');
    const out = executeOn(net, 'R1', 'ping 192.168.2.10').output;
    expect(out[2]).toBe('U.U.U');
    expect(run(net, 'ping 192.168.2.10').devices['R1'].pings[0]).toEqual({ target: '192.168.2.10', success: false, denied: true });
  });
});

describe('DHCP', () => {
  function lan(): NetworkState {
    const r1 = createRouter({ hostname: 'R1', interfaces: { 'g0/0': { ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } }, staticRoutes: [{ destination: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.0.2' }] });
    const r2 = createRouter({ hostname: 'R2', interfaces: { 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } }, staticRoutes: [{ destination: '192.168.10.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }] });
    const sw = createSwitch({ hostname: 'SW1', ports: 8 });
    return buildNetwork({
      primary: 'R1',
      devices: [r1, r2, sw],
      hosts: [
        { id: 'PC-A', dhcp: true },
        { id: 'PC-B', dhcp: true },
        { id: 'PC-S', ip: '192.168.10.11', mask: '255.255.255.0', gateway: '192.168.10.1' },
      ],
      links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['PC-S', 'SW1:g0/3'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1']],
    });
  }

  it('leases addresses from a local pool, skipping exclusions and addresses in use', () => {
    const noServer = executeHost(lan(), 'PC-A', 'ipconfig /renew').output;
    expect(noServer[2]).toMatch(/unable to contact your DHCP server/);
    const net = run(lan(), 'en', 'conf t', 'ip dhcp excluded-address 192.168.10.1 192.168.10.9', 'ip dhcp pool SALES', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'dns-server 8.8.8.8', 'end');
    expect(prompt(run(lan(), 'en', 'conf t', 'ip dhcp pool X').devices['R1'])).toBe('R1(dhcp-config)#');
    const leased = run(net, 'PC-A: ipconfig /renew', 'PC-B: ipconfig /renew');
    expect(leased.hosts['PC-A']).toMatchObject({ ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1', dns: '8.8.8.8', dhcpServer: '192.168.10.1' });
    // .11 is statically used by PC-S, so PC-B gets .12.
    expect(leased.hosts['PC-B'].ip).toBe('192.168.10.12');
    expect(leased.devices['R1'].dhcpBindings.map((b) => b.ip)).toEqual(['192.168.10.10', '192.168.10.12']);
    expect(ping(leased, 'PC-A', '10.0.0.2').success).toBe(true);
    const binding = executeOn(leased, 'R1', 'show ip dhcp binding').output;
    expect(binding.some((l) => l.startsWith('192.168.10.10') && l.includes('0100.1122.bb00.01'))).toBe(true);
    const poolOut = executeOn(leased, 'R1', 'show ip dhcp pool').output;
    expect(poolOut[0]).toBe('Pool SALES :');
    expect(poolOut).toContain(' Leased addresses               : 2');
    expect(poolOut).toContain(' Excluded addresses             : 9');
    const all = executeHost(leased, 'PC-A', 'ipconfig /all').output;
    expect(all).toContain('   DHCP Enabled. . . . . . . . . . . : Yes');
    expect(all).toContain('   DHCP Server . . . . . . . . . . . : 192.168.10.1');
    // Renewing keeps the same lease; releasing frees it.
    expect(run(leased, 'PC-A: ipconfig /renew').hosts['PC-A'].ip).toBe('192.168.10.10');
    const released = run(leased, 'PC-A: ipconfig /release');
    expect(released.hosts['PC-A'].ip).toBeUndefined();
    expect(released.devices['R1'].dhcpBindings).toHaveLength(1);
    const cfg = executeOn(leased, 'R1', 'show running-config').output;
    expect(cfg).toContain('ip dhcp excluded-address 192.168.10.1 192.168.10.9');
    expect(cfg).toContain('ip dhcp pool SALES');
    expect(cfg).toContain(' default-router 192.168.10.1');
  });

  it('relays to a remote server with ip helper-address', () => {
    const base = run(lan(), 'R2: en', 'R2: conf t', 'R2: ip dhcp excluded-address 192.168.10.1 192.168.10.9', 'R2: ip dhcp pool BRANCH', 'R2: network 192.168.10.0 /24', 'R2: default-router 192.168.10.1', 'R2: end');
    expect(executeHost(base, 'PC-A', 'ipconfig /renew').output[2]).toMatch(/unable to contact/);
    const relayed = run(base, 'en', 'conf t', 'int g0/0', 'ip helper-address 10.0.0.2', 'end', 'PC-A: ipconfig /renew');
    expect(relayed.hosts['PC-A']).toMatchObject({ ip: '192.168.10.10', gateway: '192.168.10.1', dhcpServer: '10.0.0.2' });
    expect(relayed.devices['R2'].dhcpBindings).toHaveLength(1);
    expect(executeOn(relayed, 'R1', 'show ip interface g0/0').output).toContain('  Helper address is 10.0.0.2');
    // The relay only works while the server is reachable.
    const cut = run(relayed, 'PC-A: ipconfig /release', 'R2: conf t', 'R2: int g0/1', 'R2: shutdown', 'R2: end');
    expect(executeHost(cut, 'PC-A', 'ipconfig /renew').output[2]).toMatch(/unable to contact/);
  });
});
