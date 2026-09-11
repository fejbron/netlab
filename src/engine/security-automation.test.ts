import { describe, expect, it } from 'vitest';
import { evaluateCheck } from './grader';
import { buildNetwork, createRouter, createSwitch, executeHost, executeOn, prompt, splitArgs, type NetworkState } from './index';

function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m ? m[1] : n.primary;
    const line = m ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

function out(net: NetworkState, node: string, line: string): string[] {
  return net.hosts[node] ? executeHost(net, node, line).output : executeOn(net, node, line).output;
}

function config(net: NetworkState, node: string): string {
  return out(run(net, `${node}: enable`), node, 'show running-config').join('\n');
}

/** PC-A, PC-B (DHCP) and SRV1 (static) in VLAN 10 on SW1; SW1 g0/8 (access VLAN 10) - R1 g0/0 192.168.10.1 with pool SALES. */
function branch(): NetworkState {
  const sw = createSwitch({ hostname: 'SW1', ports: 8, vlans: [{ id: 10, name: 'SALES' }], interfaces: { 'g0/1': { mode: 'access', accessVlan: 10 }, 'g0/2': { mode: 'access', accessVlan: 10 }, 'g0/3': { mode: 'access', accessVlan: 10 }, 'g0/8': { mode: 'access', accessVlan: 10 } } });
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false } },
    dhcp: { pools: [{ name: 'SALES', network: '192.168.10.0', mask: '255.255.255.0', defaultRouter: '192.168.10.1' }], excluded: [['192.168.10.1', '192.168.10.99']] },
  });
  return buildNetwork({
    primary: 'SW1',
    devices: [sw, r1],
    hosts: [{ id: 'PC-A', dhcp: true }, { id: 'PC-B', dhcp: true }, { id: 'SRV1', ip: '192.168.10.50', mask: '255.255.255.0', gateway: '192.168.10.1', kind: 'server' }],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SRV1', 'SW1:g0/3'], ['SW1:g0/8', 'R1:g0/0']],
  });
}

/** PC-A - R1 g0/0 192.168.1.1 | R1 g0/1 10.0.0.1 --- 10.0.0.2 R2 g0/1 | R2 g0/0 192.168.2.1 - SRV1 192.168.2.50 */
function apiSite(): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false, description: 'LAN' }, 'g0/1': { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }],
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1, r2],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'SRV1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', kind: 'server' },
    ],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'SRV1']],
  });
}

describe('password policy and login hardening', () => {
  it('rejects secrets shorter than the minimum length with the IOS message', () => {
    let net = run(apiSite(), 'enable', 'conf t', 'security passwords min-length 10');
    expect(out(net, 'R1', 'enable secret cisco')).toContain('% Password too short - must be at least 10 characters. Password configuration failed');
    net = run(net, 'enable secret cisco');
    expect(net.devices.R1.enableSecret).toBeUndefined();
    expect(out(net, 'R1', 'username bob secret short')[0]).toMatch(/too short/);
    net = run(net, 'enable secret L0ngEnough!', 'username bob secret Als0LongEnough', 'line vty 0 4', 'password short');
    expect(net.devices.R1.enableSecret).toBe('L0ngEnough!');
    expect(net.devices.R1.users[0].username).toBe('bob');
    expect(net.devices.R1.lines.vty.password).toBeUndefined();
    expect(evaluateCheck({ type: 'enable-secret', minLength: 10 }, net)).toBe(true);
    expect(evaluateCheck({ type: 'password-policy', minLength: 10 }, net)).toBe(true);
    expect(evaluateCheck({ type: 'password-policy', minLength: 12 }, net)).toBe(false);
  });

  it('stores login block-for and exec-timeout, shows them, and renders them in the config', () => {
    const net = run(apiSite(), 'enable', 'conf t', 'login block-for 120 attempts 3 within 60', 'line con 0', 'exec-timeout 5 0', 'line vty 0 4', 'exec-timeout 5 30', 'end');
    expect(net.devices.R1.loginBlock).toEqual({ seconds: 120, attempts: 3, within: 60 });
    expect(net.devices.R1.lines.con.execTimeout).toEqual({ minutes: 5, seconds: 0 });
    const login = out(net, 'R1', 'show login').join('\n');
    expect(login).toContain('If more than 3 login failures occur in 60 seconds or less,');
    expect(login).toContain('logins will be disabled for 120 seconds.');
    const cfg = config(net, 'R1');
    expect(cfg).toContain('login block-for 120 attempts 3 within 60');
    expect(cfg).toContain('line con 0\n exec-timeout 5 0');
    expect(cfg).toContain(' exec-timeout 5 30');
    expect(evaluateCheck({ type: 'password-policy', loginBlock: true, maxAttempts: 3 }, net)).toBe(true);
    expect(evaluateCheck({ type: 'password-policy', loginBlock: true, maxAttempts: 2 }, net)).toBe(false);
    expect(evaluateCheck({ type: 'exec-timeout', line: 'con', maxMinutes: 5 }, net)).toBe(true);
    expect(evaluateCheck({ type: 'exec-timeout', line: 'vty', maxMinutes: 5 }, net)).toBe(false);
    expect(evaluateCheck({ type: 'exec-timeout', line: 'vty', maxMinutes: 6 }, net)).toBe(true);
  });

  it('needs aaa new-model before an authentication list and renders both', () => {
    let net = run(apiSite(), 'enable', 'conf t');
    expect(out(net, 'R1', 'aaa authentication login default local')).toContain('% AAA is not enabled. Configure aaa new-model first.');
    net = run(net, 'aaa new-model', 'aaa authentication login default local', 'line vty 0 4', 'login local', 'end');
    expect(net.devices.R1.aaaLoginDefault).toEqual(['local']);
    const cfg = config(net, 'R1');
    expect(cfg).toContain('aaa new-model\naaa authentication login default local');
    expect(cfg).not.toContain('no aaa new-model');
    expect(evaluateCheck({ type: 'aaa', newModel: true, loginLocal: true }, net)).toBe(true);
    net = run(net, 'conf t', 'no aaa new-model', 'end');
    expect(evaluateCheck({ type: 'aaa', loginLocal: true }, net)).toBe(false);
    expect(config(net, 'R1')).toContain('no aaa new-model');
  });
});

describe('DHCP snooping', () => {
  it('drops offers arriving on an untrusted port until the uplink is trusted', () => {
    let net = run(branch(), 'PC-A: ipconfig /renew');
    expect(net.hosts['PC-A'].ip).toBe('192.168.10.100');
    net = run(net, 'PC-A: ipconfig /release', 'enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'no ip dhcp snooping information option', 'end');
    expect(out(net, 'PC-A', 'ipconfig /renew').join('\n')).toContain('unable to contact your DHCP server');
    net = run(net, 'PC-A: ipconfig /renew');
    expect(net.hosts['PC-A'].ip).toBeUndefined();
    expect(evaluateCheck({ type: 'dhcp-snooping', enabled: true, vlans: [10], optionInsert: false }, net)).toBe(true);
    expect(evaluateCheck({ type: 'port-trust', interface: 'g0/8', dhcpSnooping: true }, net)).toBe(false);
    net = run(net, 'conf t', 'int g0/8', 'ip dhcp snooping trust', 'end', 'PC-A: ipconfig /renew');
    expect(net.hosts['PC-A'].ip).toBe('192.168.10.100');
    expect(evaluateCheck({ type: 'port-trust', interface: 'g0/8', dhcpSnooping: true }, net)).toBe(true);
    const snoop = out(net, 'SW1', 'show ip dhcp snooping').join('\n');
    expect(snoop).toContain('Switch DHCP snooping is enabled');
    expect(snoop).toContain('Insertion of option 82 is disabled');
    expect(snoop).toContain('GigabitEthernet0/8         yes');
    const binding = out(net, 'SW1', 'show ip dhcp snooping binding').join('\n');
    expect(binding).toContain('192.168.10.100');
    expect(binding).toContain('GigabitEthernet0/1');
    expect(binding).toContain('Total number of bindings: 1');
    const cfg = config(net, 'SW1');
    expect(cfg).toContain('ip dhcp snooping vlan 10\nno ip dhcp snooping information option\nip dhcp snooping');
    expect(cfg).toContain('interface GigabitEthernet0/8\n switchport access vlan 10\n switchport mode access\n ip dhcp snooping trust');
  });

  it('is transparent for a VLAN it does not snoop', () => {
    const net = run(branch(), 'enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 20', 'end', 'PC-A: ipconfig /renew');
    expect(net.hosts['PC-A'].ip).toBe('192.168.10.100');
  });
});

describe('dynamic ARP inspection', () => {
  it('passes DHCP clients with a binding, silences static hosts on untrusted ports, and honours trust', () => {
    let net = run(branch(), 'enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'int g0/8', 'ip dhcp snooping trust', 'ip arp inspection trust', 'end', 'PC-A: ipconfig /renew', 'PC-A: ping 192.168.10.1', 'SRV1: ping 192.168.10.1');
    expect(net.hosts['PC-A'].pings.at(-1)).toMatchObject({ success: true });
    expect(net.hosts['SRV1'].pings.at(-1)).toMatchObject({ success: true });
    net = run(net, 'conf t', 'ip arp inspection vlan 10', 'end', 'PC-A: ping 192.168.10.1', 'SRV1: ping 192.168.10.1');
    expect(net.hosts['PC-A'].pings.at(-1)).toMatchObject({ success: true });
    expect(net.hosts['SRV1'].pings.at(-1)).toMatchObject({ success: false });
    expect(out(net, 'SW1', 'show ip arp inspection vlan 10').join('\n')).toMatch(/10\s+Enabled\s+Active/);
    expect(out(net, 'SW1', 'show ip arp inspection interfaces').join('\n')).toMatch(/Gi0\/8\s+Trusted/);
    net = run(net, 'conf t', 'int g0/3', 'ip arp inspection trust', 'end', 'SRV1: ping 192.168.10.1');
    expect(net.hosts['SRV1'].pings.at(-1)).toMatchObject({ success: true });
    expect(evaluateCheck({ type: 'arp-inspection', vlans: [10] }, net)).toBe(true);
    expect(evaluateCheck({ type: 'port-trust', interface: 'g0/3', arpInspection: true }, net)).toBe(true);
    expect(config(net, 'SW1')).toContain('ip arp inspection vlan 10');
  });
});

describe('RESTCONF from the PC terminal', () => {
  const GET = 'curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces';

  it('splits quoted arguments', () => {
    expect(splitArgs(`curl -H 'Content-Type: application/yang-data+json' -d '{"a": "b c"}' "http://x"`)).toEqual(['curl', '-H', 'Content-Type: application/yang-data+json', '-d', '{"a": "b c"}', 'http://x']);
  });

  it('refuses, then warns about the certificate, then demands credentials', () => {
    let net = apiSite();
    expect(out(net, 'PC-A', GET)[0]).toMatch(/\(7\) Failed to connect to 192.168.1.1 port 443/);
    expect(out(net, 'PC-A', 'curl -k https://192.168.9.9/restconf/data/x')[0]).toMatch(/\(28\)/);
    net = run(net, 'enable', 'conf t', 'ip http secure-server', 'restconf', 'end');
    expect(out(net, 'PC-A', GET.replace('-k ', ''))[0]).toMatch(/\(60\) SSL certificate problem/);
    expect(out(net, 'PC-A', `${GET} -i`).join('\n')).toContain('HTTP/1.1 401 Unauthorized');
    net = run(net, 'conf t', 'ip http authentication local', 'username netops privilege 15 secret Aut0mate!', 'end');
    expect(out(net, 'PC-A', GET.replace('Aut0mate!', 'wrong')).join('\n')).toContain('access-denied');
    const body = out(net, 'PC-A', GET).join('\n');
    expect(body).toContain('"ietf-interfaces:interfaces"');
    expect(body).toContain('"name": "GigabitEthernet0/0"');
    expect(body).toContain('"ip": "192.168.1.1"');
    net = run(net, `PC-A: ${GET}`);
    expect(net.devices.R1.apiRequests.at(-1)).toMatchObject({ method: 'GET', status: 200, user: 'netops' });
    expect(evaluateCheck({ type: 'api-request', method: 'GET', path: 'ietf-interfaces:interfaces$', status: 200 }, net)).toBe(true);
    expect(evaluateCheck({ type: 'management-api', restconf: true, httpsServer: true, httpAuthLocal: true }, net)).toBe(true);
    expect(evaluateCheck({ type: 'management-api', netconf: true }, net)).toBe(false);
  });

  it('reads one interface, the hostname, and rejects unknown paths', () => {
    const net = run(apiSite(), 'enable', 'conf t', 'ip http secure-server', 'ip http authentication local', 'restconf', 'username netops privilege 15 secret Aut0mate!', 'end');
    const one = out(net, 'PC-A', 'curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1').join('\n');
    expect(one).toContain('"ietf-interfaces:interface"');
    expect(one).toContain('"name": "GigabitEthernet0/1"');
    expect(one).not.toContain('GigabitEthernet0/0');
    expect(out(net, 'PC-A', 'curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname').join('\n')).toContain('"Cisco-IOS-XE-native:hostname": "R1"');
    expect(out(net, 'PC-A', 'curl -k -i -u netops:Aut0mate! https://192.168.1.1/restconf/data/nonsense:thing').join('\n')).toContain('HTTP/1.1 404 Not Found');
  });

  it('applies PATCH and PUT bodies to the device and logs them', () => {
    let net = run(apiSite(), 'enable', 'conf t', 'ip http secure-server', 'ip http authentication local', 'restconf', 'username netops privilege 15 secret Aut0mate!', 'int g0/1', 'shutdown', 'end');
    const patch = `curl -k -i -u netops:Aut0mate! -X PATCH -H 'Content-Type: application/yang-data+json' -d '{"ietf-interfaces:interface": {"name": "GigabitEthernet0/1", "description": "WAN to R2", "enabled": true}}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1`;
    expect(out(net, 'PC-A', patch)[0]).toBe('HTTP/1.1 204 No Content');
    net = run(net, `PC-A: ${patch}`);
    expect(net.devices.R1.interfaces['GigabitEthernet0/1']).toMatchObject({ description: 'WAN to R2', shutdown: false });
    expect(evaluateCheck({ type: 'api-request', method: 'PATCH', path: 'interface=GigabitEthernet0(%2F|/)1', status: 204 }, net)).toBe(true);
    const bad = `curl -k -i -u netops:Aut0mate! -X PATCH -d '{not json' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1`;
    expect(out(net, 'PC-A', bad).join('\n')).toContain('HTTP/1.1 400 Bad Request');
    const host = `curl -k -u netops:Aut0mate! -X PUT -d '{"Cisco-IOS-XE-native:hostname": "Branch-R1"}' https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname`;
    net = run(net, `PC-A: ${host}`);
    expect(net.devices.R1.hostname).toBe('Branch-R1');
    expect(prompt(net.devices.R1)).toBe('Branch-R1#');
    expect(out(net, 'R1', 'show restconf requests').join('\n')).toMatch(/PUT\s+204\s+netops/);
    const cfg = config(net, 'R1');
    expect(cfg).toContain('ip http authentication local\nip http secure-server');
    expect(cfg).toContain('restconf');
  });
});

describe('telemetry: syslog, SNMP and NTP', () => {
  it('stores the collectors, renders them, and reports NTP sync only when the server is reachable', () => {
    let net = run(apiSite(), 'enable', 'conf t', 'logging host 192.168.2.50', 'logging trap informational', 'snmp-server community NetOps-RO ro', 'snmp-server location Branch 1 comms room', 'ntp server 192.168.2.50', 'end');
    const r1 = net.devices.R1;
    expect(r1.loggingHosts).toEqual(['192.168.2.50']);
    expect(r1.loggingTrap).toBe('informational');
    expect(r1.snmpCommunities).toEqual([{ name: 'NetOps-RO', mode: 'ro' }]);
    expect(evaluateCheck({ type: 'syslog', host: '192.168.2.50', trap: 'informational' }, net)).toBe(true);
    expect(evaluateCheck({ type: 'snmp-community', name: 'NetOps-RO', mode: 'ro' }, net)).toBe(true);
    expect(evaluateCheck({ type: 'snmp-community', mode: 'rw' }, net)).toBe(false);
    expect(evaluateCheck({ type: 'ntp-server', address: '192.168.2.50' }, net)).toBe(true);
    expect(out(net, 'R1', 'show logging').join('\n')).toContain('Trap logging: level informational');
    expect(out(net, 'R1', 'show ntp status')[0]).toBe('Clock is synchronized, stratum 3, reference is 192.168.2.50');
    expect(out(net, 'R1', 'show snmp community').join('\n')).toContain('Community name: NetOps-RO');
    const cfg = config(net, 'R1');
    expect(cfg).toContain('logging trap informational\nlogging host 192.168.2.50');
    expect(cfg).toContain('snmp-server community NetOps-RO RO\nsnmp-server location Branch 1 comms room');
    expect(cfg).toContain('ntp server 192.168.2.50');
    net = run(net, 'R2: enable', 'R2: conf t', 'R2: int g0/0', 'R2: shutdown');
    expect(out(net, 'R1', 'show ntp status')[0]).toMatch(/^Clock is unsynchronized/);
  });

  it('accepts numeric syslog levels and rejects unknown ones', () => {
    const net = run(apiSite(), 'enable', 'conf t');
    expect(run(net, 'logging trap 4').devices.R1.loggingTrap).toBe('warnings');
    expect(out(net, 'R1', 'logging trap loud')).toContain("% Invalid input detected at '^' marker.");
  });
});
