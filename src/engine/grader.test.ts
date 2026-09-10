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
    'cli-09-exam-first-switch': ['en', 'conf t', 'hostname Remote-SW1', 'banner motd #Authorized personnel only#', 'enable secret R3mote!', 'line con 0', 'password c0nsole', 'login', 'exit', 'username netadmin privilege 15 secret N3t-adm1n', 'line vty 0 4', 'login local', 'end', 'copy running-config startup-config'],
    'sw-01-create-vlans': ['en', 'conf t', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'end', 'show vlan brief'],
    'sw-02-assign-access-ports': ['en', 'conf t', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'int g0/2', 'switchport mode access', 'switchport access vlan 20', 'do show vlan brief'],
    'sw-03-make-and-undo': ['en', 'conf t', 'vlan 30', 'vlan 40', 'do show vlan brief', 'no vlan 30', 'no vlan 40', 'do show vlan brief'],
    'sw-04-build-a-trunk': ['en', 'conf t', 'vlan 99', 'name NATIVE', 'int g0/6', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'switchport trunk native vlan 99', 'end', 'show interfaces trunk'],
    'sw-05-fix-the-trunk': ['en', 'show vlan brief', 'show interfaces trunk', 'conf t', 'int g0/1', 'switchport access vlan 10', 'int g0/6', 'switchport trunk allowed vlan add 10', 'end'],
    'sw-06-management-ip': ['en', 'conf t', 'int vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 192.168.1.1', 'end', 'ping 192.168.1.10'],
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
