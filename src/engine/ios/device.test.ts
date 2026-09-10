import { describe, expect, it } from 'vitest';
import { createSwitch, execute, prompt, tabComplete } from './device';
import type { DeviceState } from '../types';

function session(initial: DeviceState) {
  let state = initial;
  const outputs: string[][] = [];
  const run = (...lines: string[]) => {
    for (const line of lines) {
      const r = execute(state, line);
      state = r.state;
      outputs.push(r.output);
    }
    return outputs[outputs.length - 1];
  };
  return { run, get state() { return state; }, outputs };
}

function office() {
  return createSwitch({
    hostname: 'Switch',
    ports: 4,
    neighbors: [
      { port: 'g0/1', name: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0' },
      { port: 'g0/2', name: 'PC-B', ip: '192.168.1.20', mask: '255.255.255.0' },
    ],
    interfaces: { 'g0/4': { shutdown: true } },
  });
}

describe('mode navigation', () => {
  it('walks through the mode hierarchy and back', () => {
    const s = session(office());
    expect(prompt(s.state)).toBe('Switch>');
    s.run('en');
    expect(prompt(s.state)).toBe('Switch#');
    s.run('conf t');
    expect(prompt(s.state)).toBe('Switch(config)#');
    s.run('int g0/1');
    expect(prompt(s.state)).toBe('Switch(config-if)#');
    s.run('exit');
    expect(prompt(s.state)).toBe('Switch(config)#');
    s.run('vlan 10');
    expect(prompt(s.state)).toBe('Switch(config-vlan)#');
    s.run('end');
    expect(prompt(s.state)).toBe('Switch#');
    s.run('disable');
    expect(prompt(s.state)).toBe('Switch>');
    expect(s.state.modesVisited).toEqual(['user', 'privileged', 'config', 'interface', 'vlan']);
  });

  it('does not mutate the previous state', () => {
    const before = office();
    execute(before, 'enable');
    expect(before.mode).toBe('user');
    expect(before.commandHistory).toEqual([]);
  });

  it('records expanded canonical commands', () => {
    const s = session(office());
    s.run('en', 'conf t', 'int g0/1', 'do sh run');
    expect(s.state.canonicalHistory).toEqual(['enable', 'configure terminal', 'interface g0/1', 'do show running-config']);
  });
});

describe('error messages', () => {
  it('reports unknown commands in exec mode the IOS way', () => {
    const s = session(office());
    const out = s.run('shwo version');
    expect(out[1]).toBe('% Unknown command or computer name, or unable to find computer address');
    expect(s.state.errorsSeen).toEqual(['invalid']);
  });

  it('places the caret under the offending word', () => {
    const s = session(office());
    s.run('en');
    const out = s.run('show runn-config');
    // "Switch#show runn-config" -> caret under "runn-config" (col 7 + 5)
    expect(out[0]).toBe(' '.repeat('Switch#show '.length) + '^');
    expect(out[1]).toBe("% Invalid input detected at '^' marker.");
  });

  it('reports incomplete and ambiguous commands', () => {
    const s = session(office());
    s.run('en');
    expect(s.run('sh st')[0]).toBe('% Ambiguous command:  "sh st"');
    s.run('conf t');
    expect(s.run('hostname')[0]).toBe('% Incomplete command.');
    expect(s.state.errorsSeen).toEqual(['ambiguous', 'incomplete']);
  });

  it('refuses privileged show commands in user mode', () => {
    const s = session(office());
    const out = s.run('show running-config');
    expect(out[1]).toBe("% Invalid input detected at '^' marker.");
  });
});

describe('configuration', () => {
  it('sets hostname, banner, secret and saves', () => {
    const s = session(office());
    s.run('enable', 'configure terminal', 'hostname Remote-SW1', 'banner motd # Authorized access only #', 'enable secret R3mote!', 'end');
    expect(s.state.hostname).toBe('Remote-SW1');
    expect(prompt(s.state)).toBe('Remote-SW1#');
    expect(s.state.bannerMotd).toBe('Authorized access only');
    expect(s.state.enableSecret).toBe('R3mote!');
    expect(s.run('show startup-config')[0]).toBe('startup-config is not present');
    expect(s.run('wr')).toEqual(['Building configuration...', '[OK]', '']);
    expect(s.state.startupConfig).toContain('hostname Remote-SW1');
    const run = s.run('show running-config');
    expect(run).toContain('hostname Remote-SW1');
    expect(run.some((l) => l.startsWith('enable secret 5 $1$'))).toBe(true);
    expect(run).toContain('banner motd ^CAuthorized access only^C');
  });

  it('asks for the enable password once one is set', () => {
    const s = session(office());
    s.run('en', 'conf t', 'enable secret cisco', 'end', 'disable');
    s.run('enable');
    expect(prompt(s.state)).toBe('Password: ');
    s.run('wrong');
    expect(prompt(s.state)).toBe('Password: ');
    s.run('cisco');
    expect(prompt(s.state)).toBe('Switch#');
  });

  it('creates and names VLANs, assigns access ports, deletes VLANs', () => {
    const s = session(office());
    s.run('en', 'conf t', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'int g0/2', 'sw mo acc', 'sw acc vl 20', 'end');
    expect(s.state.vlans[10]).toEqual({ id: 10, name: 'SALES' });
    expect(s.state.interfaces['GigabitEthernet0/1']).toMatchObject({ mode: 'access', accessVlan: 10 });
    expect(s.state.interfaces['GigabitEthernet0/2']).toMatchObject({ mode: 'access', accessVlan: 20 });
    const brief = s.run('show vlan brief');
    expect(brief.find((l) => l.startsWith('10 '))).toMatch(/SALES\s+active\s+Gi0\/1/);
    expect(brief.find((l) => l.startsWith('20 '))).toMatch(/HR\s+active\s+Gi0\/2/);
    expect(brief.find((l) => l.startsWith('1 '))).toMatch(/default\s+active\s+Gi0\/3, Gi0\/4/);
    s.run('conf t', 'no vlan 10', 'end');
    expect(s.state.vlans[10]).toBeUndefined();
    // IOS accepts global commands from inside a submode, including deleting the VLAN you are editing.
    s.run('conf t', 'vlan 40', 'no vlan 40');
    expect(s.state.vlans[40]).toBeUndefined();
    expect(prompt(s.state)).toBe('Switch(config)#');
    s.run('end');
    expect(s.run('conf t', 'no vlan 1')[0]).toBe('% Default VLAN 1 may not be deleted.');
  });

  it('creates a VLAN on the fly when an access port references it', () => {
    const s = session(office());
    const out = s.run('en', 'conf t', 'int g0/3', 'switchport access vlan 30');
    expect(out[0]).toBe('% Access VLAN does not exist. Creating vlan 30');
    expect(s.state.vlans[30]).toBeDefined();
  });

  it('configures trunks and renders show interfaces trunk', () => {
    const s = session(office());
    s.run('en', 'conf t', 'vlan 10', 'vlan 20', 'vlan 99', 'int g0/3', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'switchport trunk native vlan 99', 'end');
    const i = s.state.interfaces['GigabitEthernet0/3'];
    expect(i).toMatchObject({ mode: 'trunk', trunkAllowed: [10, 20], nativeVlan: 99 });
    const trunk = s.run('show interfaces trunk');
    expect(trunk[1]).toMatch(/^Gi0\/3\s+on\s+802\.1q\s+trunking\s+99$/);
    expect(trunk).toContain('Gi0/3       10,20');
    s.run('conf t', 'int g0/3', 'switchport trunk allowed vlan add 30-32', 'end');
    expect(s.state.interfaces['GigabitEthernet0/3'].trunkAllowed).toEqual([10, 20, 30, 31, 32]);
    s.run('conf t', 'int g0/3', 'switchport trunk allowed vlan remove 31', 'end');
    expect(s.state.interfaces['GigabitEthernet0/3'].trunkAllowed).toEqual([10, 20, 30, 32]);
  });

  it('shuts ports down and brings them up with syslog output', () => {
    const s = session(office());
    const down = s.run('en', 'conf t', 'int g0/1', 'shutdown');
    expect(down[0]).toContain('%LINK-5-CHANGED: Interface GigabitEthernet0/1, changed state to administratively down');
    expect(s.state.interfaces['GigabitEthernet0/1'].shutdown).toBe(true);
    const up = s.run('no shut');
    expect(up[0]).toContain('changed state to up');
    const status = s.run('do show interfaces status');
    expect(status.find((l) => l.startsWith('Gi0/1'))).toMatch(/connected\s+1\s+a-full/);
    expect(status.find((l) => l.startsWith('Gi0/3'))).toMatch(/notconnect/);
    expect(status.find((l) => l.startsWith('Gi0/4'))).toMatch(/disabled/);
  });

  it('secures lines and local users', () => {
    const s = session(office());
    s.run('en', 'conf t', 'line con 0', 'password conpass', 'login', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'username admin privilege 15 secret Adm1n', 'end');
    expect(s.state.lines.con).toEqual({ login: true, password: 'conpass' });
    expect(s.state.lines.vty).toMatchObject({ login: 'local', transportInput: 'ssh' });
    expect(s.state.users[0]).toEqual({ username: 'admin', password: 'Adm1n', secret: true, privilege: 15 });
    const run = s.run('show run');
    expect(run).toContain(' login local');
    expect(run).toContain(' transport input ssh');
    expect(run.some((l) => l.startsWith('username admin privilege 15 secret 5 '))).toBe(true);
  });

  it('refuses login without a password', () => {
    const s = session(office());
    const out = s.run('en', 'conf t', 'line con 0', 'login');
    expect(out[0]).toContain('Login disabled on line');
    expect(s.state.lines.con.login).toBe(false);
  });

  it('addresses the SVI and pings a host in the same VLAN', () => {
    const s = session(office());
    s.run('en', 'conf t', 'int vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'no shut', 'exit', 'ip default-gateway 192.168.1.1', 'end');
    expect(s.state.interfaces['Vlan1']).toMatchObject({ ipAddress: '192.168.1.2', subnetMask: '255.255.255.0', shutdown: false });
    expect(s.run('ping 192.168.1.10')[2]).toBe('!!!!!');
    expect(s.run('ping 192.168.1.99')[2]).toBe('.....');
    expect(s.state.pings).toEqual([
      { target: '192.168.1.10', success: true },
      { target: '192.168.1.99', success: false },
    ]);
    const brief = s.run('show ip interface brief');
    expect(brief.find((l) => l.startsWith('Vlan1'))).toMatch(/192\.168\.1\.2\s+YES manual up\s+up/);
  });

  it('rejects IP addresses on L2 ports', () => {
    const s = session(office());
    expect(s.run('en', 'conf t', 'int g0/1', 'ip address 10.0.0.1 255.255.255.0')[0]).toBe('% IP addresses may not be configured on L2 links.');
  });

  it('generates SSH keys only after a domain name exists', () => {
    const s = session(office());
    expect(s.run('en', 'conf t', 'crypto key generate rsa')[0]).toBe('% Please define a domain-name first.');
    s.run('ip domain-name lab.local');
    expect(s.run('crypto key generate rsa modulus 2048')[0]).toBe('The name for the keys will be: Switch.lab.local');
    expect(s.state.rsaKeyBits).toBe(2048);
  });
});

describe('help and completion', () => {
  it('lists privileged commands for "?"', () => {
    const s = session(office());
    s.run('en');
    const out = s.run('?');
    expect(out.some((l) => l.trim().startsWith('configure'))).toBe(true);
    expect(out.some((l) => l.trim().startsWith('show'))).toBe(true);
    expect(s.state.canonicalHistory).toEqual(['enable', '?']);
  });

  it('lists partial matches for "sh?"', () => {
    const s = session(office());
    s.run('en');
    const out = s.run('sh?');
    expect(out.map((l) => l.trim().split(/\s+/)[0])).toEqual(['show']);
  });

  it('tab-completes unique prefixes', () => {
    const s = session(office());
    s.run('en');
    expect(tabComplete(s.state, 'conf')).toBe('configure ');
    expect(tabComplete(s.state, 'show ru')).toBe('show running-config ');
    expect(tabComplete(s.state, 'sh st')).toBeNull();
    s.run('conf t');
    // Like IOS, Tab completes only the word being typed; earlier abbreviations stay as typed.
    expect(tabComplete(s.state, 'do sh ru')).toBe('do sh running-config ');
  });
});
