import { describe, expect, it } from 'vitest';
import { labs } from '../content';
import { grade } from './grader';
import { execute, type DeviceState } from './index';

function run(state: DeviceState, ...lines: string[]): DeviceState {
  return lines.reduce((s, l) => execute(s, l).state, state);
}

describe('labs are well formed', () => {
  it('have unique ids and at least one objective', () => {
    const ids = new Set(labs.map((l) => l.id));
    expect(ids.size).toBe(labs.length);
    for (const lab of labs) {
      expect(lab.objectives.length, lab.id).toBeGreaterThan(0);
      expect(() => lab.createState(), lab.id).not.toThrow();
    }
  });

  it('start with nothing passed', () => {
    for (const lab of labs) {
      expect(grade(lab.objectives, lab.createState()).passed, lab.id).toBe(false);
    }
  });
});

describe('reference solutions pass', () => {
  const solutions: Record<string, string[]> = {
    'cli-01-first-contact': ['enable', '?', 'configure terminal'],
    'cli-02-give-it-a-name': ['en', 'conf t', 'hostname Branch-SW1', 'end', 'show running-config'],
    'cli-03-learning-from-errors': ['en', 'shwo running-config', 'sh st', 'conf t', 'hostname', 'do show running-config'],
    'cli-04-find-your-way-around': ['en', 'conf t', 'int g0/1', 'exit', 'vlan 10', 'end'],
    'cli-05-read-the-switch': ['en', 'show vlan brief', 'show interfaces status', 'show running-config', 'show ip interface brief'],
    'cli-06-save-your-work': ['en', 'conf t', 'hostname Floor2-SW1', 'end', 'show startup-config', 'write memory', 'show startup-config'],
    'cli-07-lock-the-door': ['en', 'conf t', 'enable secret cisco123', 'line con 0', 'password conpass', 'login', 'line vty 0 4', 'password vtypass', 'login', 'end', 'show running-config'],
    'cli-08-who-gets-in': ['en', 'conf t', 'username admin privilege 15 secret Adm1n-Lab', 'line vty 0 4', 'login local', 'transport input ssh', 'end', 'write memory'],
    'cli-09-type-smart': ['en', 'conf t', 'int g0/1', 'do sh run', 'end', 'show running-config'],
    'cli-10-leave-a-note': ['en', 'conf t', 'banner motd # Authorized access only #', 'int g0/3', 'description Printer', 'end', 'show running-config'],
    'cli-11-test-investigate': ['en', 'show run', 'show vlan brief', 'show interfaces status', 'conf t', 'hostname Closet-SW2', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'int g0/3', 'no shutdown', 'end', 'write memory'],
    'cli-12-exam-first-switch': ['en', 'conf t', 'hostname Remote-SW1', 'banner motd #Authorized personnel only#', 'enable secret R3mote!', 'line con 0', 'password c0nsole', 'login', 'exit', 'username netadmin privilege 15 secret N3t-adm1n', 'line vty 0 4', 'login local', 'end', 'copy running-config startup-config'],
    'sw-01-create-vlans': ['en', 'conf t', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'end', 'show vlan brief'],
    'sw-02-assign-access-ports': ['en', 'conf t', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'int g0/2', 'switchport mode access', 'switchport access vlan 20', 'do show vlan brief'],
    'sw-03-make-and-undo': ['en', 'conf t', 'vlan 30', 'vlan 40', 'do show vlan brief', 'no vlan 30', 'no vlan 40', 'do show vlan brief'],
    'sw-04-build-a-trunk': ['en', 'conf t', 'vlan 99', 'name NATIVE', 'int g0/6', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'switchport trunk native vlan 99', 'end', 'show interfaces trunk'],
    'sw-05-fix-the-trunk': ['en', 'show vlan brief', 'show interfaces trunk', 'conf t', 'int g0/1', 'switchport access vlan 10', 'int g0/6', 'switchport trunk allowed vlan add 10', 'end'],
    'sw-06-management-ip': ['en', 'conf t', 'int vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 192.168.1.1', 'end', 'ping 192.168.1.10'],
    'sw-07-who-is-plugged-in': ['en', 'show mac address-table', 'show interfaces status', 'conf t', 'int g0/3', 'description Printer', 'end'],
    'sw-08-native-vlan-mismatch': ['en', 'show interfaces trunk', 'conf t', 'vlan 99', 'name NATIVE', 'int g0/6', 'switchport trunk native vlan 99', 'end', 'show interfaces trunk'],
    'sw-09-management-vlan': ['en', 'conf t', 'int vlan 99', 'ip address 10.0.99.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.0.99.1', 'end', 'ping 10.0.99.10'],
    'sw-10-trunk-cleanup': ['en', 'show interfaces trunk', 'conf t', 'int g0/6', 'switchport trunk allowed vlan remove 30,40', 'exit', 'no vlan 30', 'no vlan 40', 'end', 'show interfaces trunk'],
    'sw-11-exam-department-switch': ['en', 'conf t', 'hostname Dept-SW1', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'vlan 99', 'name MGMT', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'int g0/2', 'switchport mode access', 'switchport access vlan 20', 'int g0/8', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20,99', 'switchport trunk native vlan 99', 'int vlan 99', 'ip address 10.0.99.5 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.0.99.1', 'end', 'write memory'],
    'sec-01-encrypt-the-passwords': ['enable', 'cisco', 'conf t', 'enable secret S3cret!', 'service password-encryption', 'end', 'show running-config'],
    'sec-02-remote-access-ssh': ['en', 'conf t', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'username netadmin privilege 15 secret N3t-adm1n', 'line vty 0 4', 'login local', 'transport input ssh', 'end', 'show ip ssh'],
    'sec-03-park-unused-ports': ['en', 'conf t', 'vlan 999', 'name UNUSED', 'interface range g0/3 - 7', 'switchport mode access', 'switchport access vlan 999', 'shutdown', 'end', 'show interfaces status'],
    'sec-04-exam-harden-the-switch': ['en', 'conf t', 'hostname Secure-SW1', 'banner motd #Authorized access only#', 'enable secret H4rden!', 'service password-encryption', 'username admin privilege 15 secret Adm1n-Sec', 'line con 0', 'password c0nsole', 'login', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'interface range g0/3 - 7', 'shutdown', 'end', 'write memory'],
  };

  it('covers every lab', () => {
    expect(Object.keys(solutions).sort()).toEqual(labs.map((l) => l.id).sort());
  });

  for (const lab of labs) {
    it(lab.id, () => {
      const state = run(lab.createState(), ...(solutions[lab.id] ?? []));
      const result = grade(lab.objectives, state);
      const failing = result.objectives.filter((o) => !o.passed).map((o) => `${o.label}: ${o.checks.filter((c) => !c.passed).map((c) => c.label).join(', ')}`);
      expect(failing).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
    });
  }
});
