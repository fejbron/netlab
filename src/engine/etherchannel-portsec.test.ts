import { describe, expect, it } from 'vitest';
import { buildNetwork, channelStatus, createSwitch, executeHost, executeOn, ping, prompt, type ChannelMode, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

/** SW1 and SW2 joined on g0/7 and g0/8; PC-A (VLAN 10) on SW1, PC-C (VLAN 10) on SW2. SW2 side pre-configured. */
function pair(sw2Mode: ChannelMode, sw2Trunk = true): NetworkState {
  const sw1 = createSwitch({ hostname: 'SW1', ports: 8, vlans: [{ id: 10 }], interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 } } });
  const sw2 = createSwitch({ hostname: 'SW2', ports: 8, vlans: [{ id: 10 }], interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 }, 'g0/7': { channelGroup: { id: 1, mode: sw2Mode }, mode: sw2Trunk ? 'trunk' : 'dynamic' }, 'g0/8': { channelGroup: { id: 1, mode: sw2Mode }, mode: sw2Trunk ? 'trunk' : 'dynamic' }, po1: { mode: sw2Trunk ? 'trunk' : 'dynamic' } } });
  return buildNetwork({
    primary: 'SW1',
    devices: [sw1, sw2],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.11', mask: '255.255.255.0' },
      { id: 'PC-C', ip: '192.168.10.12', mask: '255.255.255.0' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-C', 'SW2:g0/1'], ['SW1:g0/7', 'SW2:g0/7'], ['SW1:g0/8', 'SW2:g0/8']],
  });
}

describe('EtherChannel', () => {
  it('creates the Port-channel, bundles with LACP and pushes trunk config to members', () => {
    const cfg = run(pair('active'), 'en', 'conf t', 'interface range g0/7 - 8');
    const out = executeOn(cfg, 'SW1', 'channel-group 1 mode active').output;
    expect(out[0]).toBe('Creating a port-channel interface Port-channel 1');
    const net = run(cfg, 'channel-group 1 mode active', 'interface port-channel 1', 'switchport mode trunk', 'end');
    expect(prompt(run(cfg, 'interface port-channel 1').devices['SW1'])).toBe('SW1(config-if)#');
    expect(net.devices['SW1'].interfaces['GigabitEthernet0/7']).toMatchObject({ mode: 'trunk', channelGroup: { id: 1, mode: 'active' } });
    const status = channelStatus(net, 'SW1');
    expect(status).toEqual([{ id: 1, name: 'Port-channel1', protocol: 'LACP', bundled: true, members: [{ name: 'GigabitEthernet0/7', flag: 'P' }, { name: 'GigabitEthernet0/8', flag: 'P' }] }]);
    const summary = executeOn(net, 'SW1', 'show etherchannel summary').output;
    expect(summary.filter((l) => l.trim()).pop()).toBe('1      Po1(SU)         LACP      Gi0/7(P)    Gi0/8(P)');
    expect(ping(net, 'PC-A', '192.168.10.12').success).toBe(true);
    const cfgOut = executeOn(net, 'SW1', 'show running-config').output;
    expect(cfgOut).toContain(' channel-group 1 mode active');
    expect(cfgOut).toContain('interface Port-channel1');
    const trunk = executeOn(net, 'SW1', 'show interfaces trunk').output;
    expect(trunk.some((l) => l.startsWith('Po1'))).toBe(true);
    expect(trunk.some((l) => l.startsWith('Gi0/7'))).toBe(false);
  });

  it('respects negotiation rules across LACP, PAgP and static modes', () => {
    const attempt = (sw1: ChannelMode, sw2: ChannelMode) => channelStatus(run(pair(sw2), 'en', 'conf t', 'interface range g0/7 - 8', `channel-group 1 mode ${sw1}`, 'interface port-channel 1', 'switchport mode trunk', 'end'), 'SW1')[0];
    expect(attempt('active', 'passive')).toMatchObject({ bundled: true, protocol: 'LACP' });
    expect(attempt('passive', 'passive')).toMatchObject({ bundled: false, members: [{ flag: 'I' }, { flag: 'I' }] });
    expect(attempt('desirable', 'auto')).toMatchObject({ bundled: true, protocol: 'PAgP' });
    expect(attempt('auto', 'auto')).toMatchObject({ bundled: false });
    expect(attempt('on', 'on')).toMatchObject({ bundled: true, protocol: '-' });
    expect(attempt('on', 'active')).toMatchObject({ bundled: false });
    expect(attempt('active', 'desirable')).toMatchObject({ bundled: false });
  });

  it('suspends members whose configuration differs from the Port-channel and flags down links', () => {
    const net = run(pair('active'), 'en', 'conf t', 'interface range g0/7 - 8', 'channel-group 1 mode active', 'interface port-channel 1', 'switchport mode trunk', 'int g0/8', 'switchport mode access', 'end');
    expect(channelStatus(net, 'SW1')[0].members).toEqual([{ name: 'GigabitEthernet0/7', flag: 'P' }, { name: 'GigabitEthernet0/8', flag: 's' }]);
    const down = run(net, 'conf t', 'int g0/7', 'shutdown', 'end');
    expect(channelStatus(down, 'SW1')[0].members[0].flag).toBe('D');
    const gone = run(net, 'conf t', 'interface range g0/7 - 8', 'no channel-group', 'end');
    expect(channelStatus(gone, 'SW1')).toEqual([]);
    expect(executeOn(run(pair('active'), 'en', 'conf t', 'int g0/1'), 'SW1', 'channel-group 99 mode active').output[0]).toBe("% Invalid input detected at '^' marker.");
  });
});

/** PC-A and PC-B on an access switch; PC-A's MAC is 0011.22bb.0001. */
function desk(): NetworkState {
  const sw = createSwitch({ hostname: 'SW1', ports: 4, interfaces: { 'g0/1': { mode: 'access' }, 'g0/2': { mode: 'access' } } });
  return buildNetwork({
    primary: 'SW1',
    devices: [sw],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0' },
      { id: 'PC-B', ip: '192.168.1.20', mask: '255.255.255.0' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2']],
  });
}

describe('port security', () => {
  it('needs an access port and learns sticky addresses from traffic', () => {
    const dynamic = run(desk(), 'en', 'conf t', 'int g0/3');
    expect(executeOn(dynamic, 'SW1', 'switchport port-security').output[0]).toBe('Command rejected: GigabitEthernet0/3 is a dynamic port.');
    const net = run(desk(), 'en', 'conf t', 'int g0/1', 'switchport port-security', 'switchport port-security mac-address sticky', 'end');
    expect(net.devices['SW1'].interfaces['GigabitEthernet0/1'].portSecurity).toMatchObject({ enabled: true, maximum: 1, violation: 'shutdown', sticky: true, stickyMacs: [] });
    const learned = run(net, 'PC-A: ping 192.168.1.20');
    expect(learned.hosts['PC-A'].pings[0].success).toBe(true);
    expect(learned.devices['SW1'].interfaces['GigabitEthernet0/1'].portSecurity?.stickyMacs).toEqual(['0011.22bb.0001']);
    expect(executeOn(learned, 'SW1', 'show running-config').output).toContain(' switchport port-security mac-address sticky 0011.22bb.0001');
    const iface = executeOn(learned, 'SW1', 'show port-security interface g0/1').output;
    expect(iface).toContain('Port Security              : Enabled');
    expect(iface).toContain('Port Status                : Secure-up');
    expect(iface).toContain('Sticky MAC Addresses       : 1');
    expect(executeOn(learned, 'SW1', 'show port-security address').output.some((l) => l.includes('0011.22bb.0001') && l.includes('SecureSticky'))).toBe(true);
    expect(executeOn(learned, 'SW1', 'show port-security').output[3]).toMatch(/^Gi0\/1\s+1\s+1\s+0\s+Shutdown$/);
  });

  it('err-disables the port on a violation and recovers with shutdown / no shutdown', () => {
    // g0/1 only allows a MAC that is not PC-A's.
    const net = run(desk(), 'en', 'conf t', 'int g0/1', 'switchport port-security', 'switchport port-security mac-address 0011.22bb.00ff', 'end');
    const tripped = run(net, 'PC-A: ping 192.168.1.20');
    expect(tripped.hosts['PC-A'].pings[0].success).toBe(false);
    const g1 = tripped.devices['SW1'].interfaces['GigabitEthernet0/1'];
    expect(g1.errDisabled).toBe(true);
    expect(g1.portSecurity).toMatchObject({ violations: 1, lastViolationMac: '0011.22bb.0001' });
    expect(executeOn(tripped, 'SW1', 'show interfaces status').output.find((l) => l.startsWith('Gi0/1'))).toMatch(/err-disabled/);
    expect(executeOn(tripped, 'SW1', 'show port-security interface g0/1').output).toContain('Port Status                : Secure-shutdown');
    // Even PC-B cannot reach PC-A while the port is err-disabled.
    expect(ping(tripped, 'PC-B', '192.168.1.10').success).toBe(false);
    // Fix the allowed address, then bounce the port.
    const fixed = run(tripped, 'conf t', 'int g0/1', 'no switchport port-security mac-address 0011.22bb.00ff', 'switchport port-security mac-address sticky', 'shutdown', 'no shutdown', 'end', 'PC-A: ping 192.168.1.20');
    expect(fixed.devices['SW1'].interfaces['GigabitEthernet0/1'].errDisabled).toBeUndefined();
    expect(fixed.hosts['PC-A'].pings[1].success).toBe(true);
    expect(fixed.devices['SW1'].interfaces['GigabitEthernet0/1'].portSecurity?.stickyMacs).toEqual(['0011.22bb.0001']);
  });

  it('restrict mode drops offending frames without disabling the port', () => {
    const net = run(desk(), 'en', 'conf t', 'int g0/1', 'switchport port-security', 'switchport port-security violation restrict', 'switchport port-security mac-address 0011.22bb.00ff', 'end', 'PC-A: ping 192.168.1.20');
    const g1 = net.devices['SW1'].interfaces['GigabitEthernet0/1'];
    expect(net.hosts['PC-A'].pings[0].success).toBe(false);
    expect(g1.errDisabled).toBeUndefined();
    expect(g1.portSecurity?.violations).toBe(1);
    expect(executeOn(run(desk(), 'en', 'conf t', 'int g0/1', 'switchport port-security', 'switchport port-security mac-address 0011.22bb.00ff'), 'SW1', 'switchport port-security mac-address 0011.22bb.00ee').output[0]).toMatch(/exceeds the maximum/);
  });
});
