import { describe, expect, it } from 'vitest';
import { isLabUnlocked, labNetwork, labs } from '../content';
import { grade } from './grader';
import { applyPythonResult, executeHost, executeOn, type NetworkState, type PendingPython, type PythonResult } from './index';

/**
 * Python runs in the browser (Pyodide), not in vitest. Reference solutions for the Python
 * labs therefore get the result a correct script would produce, keyed by lab id.
 */
type Fake = (p: PendingPython) => Partial<PythonResult>;
let pythonFake: Fake = () => ({});
const py = (partial: Partial<PythonResult>): PythonResult => ({ stdout: '', stderr: '', exitCode: 0, files: {}, ...partial });

/** Reference-solution lines. "R2: cmd" or "PC-A: cmd" targets another node; default is the primary device. */
function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m && (n.devices[m[1]] || n.hosts[m[1]]) ? m[1] : n.primary;
    const line = m && node === m[1] ? m[2] : raw;
    if (!n.hosts[node]) return executeOn(n, node, line).network;
    const r = executeHost(n, node, line);
    return r.pending ? applyPythonResult(r.network, node, r.pending, py(pythonFake(r.pending))).network : r.network;
  }, net);
}

describe('lab unlock order', () => {
  it('opens labs one at a time as the previous lab is passed', () => {
    const [first, second, third] = labs;
    expect(isLabUnlocked(first.id, {})).toBe(true);
    expect(isLabUnlocked(second.id, {})).toBe(false);
    expect(isLabUnlocked(second.id, { [first.id]: { score: 100 } })).toBe(true);
    expect(isLabUnlocked(third.id, { [first.id]: { score: 100 } })).toBe(false);
  });

  it('gates each module on the last lab of the previous one', () => {
    const firstOfSecondModule = labs.find((l) => l.moduleId !== labs[0].moduleId)!;
    const lastOfFirstModule = labs[labs.indexOf(firstOfSecondModule) - 1];
    expect(lastOfFirstModule.moduleId).toBe(labs[0].moduleId);
    const allButLast = Object.fromEntries(labs.filter((l) => l.moduleId === labs[0].moduleId && l.id !== lastOfFirstModule.id).map((l) => [l.id, {}]));
    expect(isLabUnlocked(firstOfSecondModule.id, allButLast)).toBe(false);
    expect(isLabUnlocked(firstOfSecondModule.id, { ...allButLast, [lastOfFirstModule.id]: {} })).toBe(true);
  });
});

describe('labs are well formed', () => {
  it('have unique ids and at least one objective', () => {
    const ids = new Set(labs.map((l) => l.id));
    expect(ids.size).toBe(labs.length);
    for (const lab of labs) {
      expect(lab.objectives.length, lab.id).toBeGreaterThan(0);
      expect(() => labNetwork(lab), lab.id).not.toThrow();
    }
  });

  it('start with nothing passed', () => {
    for (const lab of labs) {
      expect(grade(lab.objectives, labNetwork(lab)).passed, lab.id).toBe(false);
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
    'sec-04-lock-a-port': ['en', 'conf t', 'int g0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security maximum 1', 'switchport port-security violation shutdown', 'switchport port-security mac-address sticky', 'end', 'PC-A: ping 192.168.1.20', 'show port-security interface g0/1', 'show running-config'],
    'sec-05-err-disabled-port': ['en', 'show interfaces status', 'show port-security interface g0/1', 'conf t', 'int g0/1', 'no switchport port-security mac-address 0011.22aa.00ff', 'switchport port-security mac-address sticky', 'shutdown', 'no shutdown', 'end', 'PC-A: ping 192.168.1.20'],
    'sec-06-exam-harden-the-switch': ['en', 'conf t', 'hostname Secure-SW1', 'banner motd #Authorized access only#', 'enable secret H4rden!', 'service password-encryption', 'username admin privilege 15 secret Adm1n-Sec', 'line con 0', 'password c0nsole', 'login', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'interface range g0/1 - 2', 'switchport mode access', 'switchport port-security', 'switchport port-security mac-address sticky', 'interface range g0/3 - 7', 'shutdown', 'end', 'write memory'],
    'ec-01-lacp-bundle': ['en', 'conf t', 'interface range g0/7 - 8', 'channel-group 1 mode active', 'interface port-channel 1', 'switchport mode trunk', 'end', 'show etherchannel summary', 'PC-A: ping 192.168.10.12'],
    'ec-02-channel-never-forms': ['en', 'show etherchannel summary', 'conf t', 'interface range g0/7 - 8', 'channel-group 1 mode active', 'end', 'show etherchannel summary'],
    'ec-03-pagp-and-static': ['en', 'conf t', 'interface range g0/7 - 8', 'channel-group 1 mode desirable', 'interface port-channel 1', 'switchport mode trunk', 'end', 'show etherchannel summary', 'PC-B: ping 192.168.20.12'],
    'rt-01-meet-the-router': ['en', 'show ip interface brief', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end', 'show ip route', 'ping 192.168.1.10'],
    'rt-02-connect-two-routers': ['en', 'conf t', 'int g0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'end', 'show ip route', 'ping 10.0.0.2'],
    'rt-03-first-static-route': ['PC-A: ping 192.168.2.10', 'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end', 'show ip route', 'PC-A: ping 192.168.2.10'],
    'rt-04-missing-return-route': ['PC-A: tracert 192.168.2.10', 'en', 'show ip route', 'R2: en', 'R2: show ip route', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'PC-A: ping 192.168.2.10'],
    'rt-05-default-route': ['en', 'conf t', 'int g0/1', 'ip address 203.0.113.2 255.255.255.252', 'no shutdown', 'exit', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end', 'show ip route', 'PC-A: ping 8.8.8.8'],
    'rt-06-router-on-a-stick': ['en', 'conf t', 'int g0/0', 'no shutdown', 'int g0/0.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1q 20', 'ip address 192.168.20.1 255.255.255.0', 'end', 'PC-A: ping 192.168.20.10'],
    'rt-07-exam-branch-connectivity': ['en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'int g0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shut', 'exit', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end', 'write memory', 'R2: en', 'R2: conf t', 'R2: int g0/0', 'R2: ip address 192.168.2.1 255.255.255.0', 'R2: no shut', 'R2: int g0/1', 'R2: ip address 10.0.0.2 255.255.255.252', 'R2: no shut', 'R2: exit', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'R2: end', 'R2: write memory', 'PC-A: ping 192.168.2.10'],
    'os-01-turn-on-ospf': ['en', 'conf t', 'router ospf 1', 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.3 area 0', 'end', 'show ip ospf neighbor', 'show ip route', 'PC-A: ping 192.168.2.10'],
    'os-02-three-routers': ['en', 'conf t', 'router ospf 1', 'router-id 2.2.2.2', 'network 192.168.2.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'end', 'show ip ospf neighbor', 'PC-A: ping 192.168.3.10'],
    'os-03-passive-interfaces': ['en', 'conf t', 'router ospf 1', 'passive-interface g0/0', 'end', 'show ip protocols', 'PC-B: ping 192.168.1.10'],
    'os-04-neighbor-never-forms': ['en', 'show ip ospf neighbor', 'show ip ospf interface brief', 'conf t', 'router ospf 1', 'no network 10.0.0.0 0.0.0.3 area 1', 'network 10.0.0.0 0.0.0.3 area 0', 'end', 'PC-A: ping 192.168.2.10'],
    'os-05-default-information-originate': ['en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'router ospf 1', 'default-information originate', 'end', 'PC-B: ping 8.8.8.8'],
    'os-07-join-a-second-area': ['en', 'conf t', 'router ospf 1', 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 1', 'network 10.0.12.0 0.0.0.3 area 1', 'passive-interface g0/0', 'end', 'show ip ospf neighbor', 'show ip route', 'PC-A: ping 192.168.4.10'],
    'os-08-area-without-a-backbone': ['en', 'show ip ospf neighbor', 'show ip ospf interface brief', 'conf t', 'router ospf 1', 'no network 10.0.23.0 0.0.0.3 area 1', 'network 10.0.23.0 0.0.0.3 area 0', 'no network 2.2.2.2 0.0.0.0 area 1', 'network 2.2.2.2 0.0.0.0 area 0', 'end', 'show ip ospf neighbor', 'PC-A: ping 192.168.4.10'],
    'os-09-exam-multi-area-campus': [
      'en', 'conf t', 'router ospf 1', 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 1', 'network 10.0.12.0 0.0.0.3 area 1', 'passive-interface g0/0', 'end', 'write memory',
      'R2: en', 'R2: conf t', 'R2: router ospf 1', 'R2: router-id 2.2.2.2', 'R2: network 10.0.12.0 0.0.0.3 area 1', 'R2: network 10.0.23.0 0.0.0.3 area 0', 'R2: network 2.2.2.2 0.0.0.0 area 0', 'R2: end', 'R2: write memory',
      'R3: en', 'R3: conf t', 'R3: router ospf 1', 'R3: router-id 3.3.3.3', 'R3: network 10.0.23.0 0.0.0.3 area 0', 'R3: network 10.0.34.0 0.0.0.3 area 2', 'R3: network 3.3.3.3 0.0.0.0 area 0', 'R3: end', 'R3: write memory',
      'R4: en', 'R4: conf t', 'R4: router ospf 1', 'R4: router-id 4.4.4.4', 'R4: network 10.0.34.0 0.0.0.3 area 2', 'R4: network 192.168.4.0 0.0.0.255 area 2', 'R4: passive-interface g0/1', 'R4: end', 'R4: write memory',
      'PC-A: ping 192.168.4.10', 'PC-D: ping 192.168.1.10',
    ],
    'stp-01-find-the-root': ['en', 'show spanning-tree vlan 10', 'show spanning-tree', 'SW2: en', 'SW2: show spanning-tree vlan 10', 'SW3: en', 'SW3: show spanning-tree vlan 10'],
    'stp-02-choose-the-root': ['en', 'conf t', 'spanning-tree vlan 1,10,20 root primary', 'end', 'SW2: en', 'SW2: conf t', 'SW2: spanning-tree vlan 1,10,20 root secondary', 'SW2: end', 'show spanning-tree vlan 10', 'PC-A: ping 192.168.10.12'],
    'stp-03-portfast-bpduguard': ['en', 'conf t', 'int g0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable', 'exit', 'spanning-tree mode rapid-pvst', 'end', 'show spanning-tree vlan 10'],
    'stp-04-err-disabled-uplink': ['en', 'show interfaces status', 'show spanning-tree vlan 10', 'conf t', 'int g0/8', 'no spanning-tree bpduguard', 'shutdown', 'no shutdown', 'end', 'show spanning-tree vlan 10', 'PC-A: ping 192.168.10.12'],
    'stp-05-exam-design-the-tree': [
      'en', 'conf t', 'spanning-tree mode rapid-pvst', 'spanning-tree vlan 1,10 root primary', 'spanning-tree vlan 20 root secondary', 'int g0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable', 'end', 'write memory',
      'SW2: en', 'SW2: conf t', 'SW2: spanning-tree mode rapid-pvst', 'SW2: spanning-tree vlan 20 root primary', 'SW2: spanning-tree vlan 1,10 root secondary', 'SW2: int g0/1', 'SW2: spanning-tree portfast', 'SW2: spanning-tree bpduguard enable', 'SW2: end', 'SW2: write memory',
      'SW3: en', 'SW3: conf t', 'SW3: spanning-tree mode rapid-pvst', 'SW3: int g0/1', 'SW3: spanning-tree portfast', 'SW3: spanning-tree bpduguard enable', 'SW3: end', 'SW3: write memory',
      'PC-A: ping 192.168.10.12', 'PC-B: ping 192.168.20.1',
    ],
    'os-06-exam-ospf-campus': [
      'en', 'conf t', 'router ospf 1', 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'passive-interface g0/0', 'end', 'write memory',
      'R2: en', 'R2: conf t', 'R2: router ospf 1', 'R2: router-id 2.2.2.2', 'R2: network 192.168.2.0 0.0.0.255 area 0', 'R2: network 10.0.12.0 0.0.0.3 area 0', 'R2: network 10.0.23.0 0.0.0.3 area 0', 'R2: passive-interface g0/0', 'R2: end', 'R2: write memory',
      'R3: en', 'R3: conf t', 'R3: router ospf 1', 'R3: router-id 3.3.3.3', 'R3: network 192.168.3.0 0.0.0.255 area 0', 'R3: network 10.0.23.0 0.0.0.3 area 0', 'R3: passive-interface g0/0', 'R3: end', 'R3: write memory',
      'PC-A: ping 192.168.3.10', 'PC-B: ping 192.168.3.10',
    ],
    'ex-01-two-switch-vlan-campus': [
      ...['SW1', 'SW2'].flatMap((d, i) => [`${d}: en`, `${d}: conf t`, `${d}: vlan 10`, `${d}: name SALES`, `${d}: vlan 20`, `${d}: name HR`, `${d}: vlan 99`, `${d}: name MGMT`, `${d}: int g0/1`, `${d}: switchport mode access`, `${d}: switchport access vlan 10`, `${d}: int g0/2`, `${d}: switchport mode access`, `${d}: switchport access vlan 20`, `${d}: int g0/8`, `${d}: switchport mode trunk`, `${d}: switchport trunk allowed vlan 10,20,99`, `${d}: switchport trunk native vlan 99`, `${d}: int vlan 99`, `${d}: ip address 10.0.99.${i + 1} 255.255.255.0`, `${d}: no shutdown`, `${d}: end`, `${d}: write memory`]),
      'PC-A: ping 192.168.10.12', 'PC-B: ping 192.168.20.12', 'SW1: ping 10.0.99.2',
    ],
    'ex-02-static-routing-three-sites': [
      'en', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.12.2', 'ip route 192.168.3.0 255.255.255.0 10.0.12.2', 'end', 'write memory',
      'R2: en', 'R2: conf t', 'R2: ip route 192.168.1.0 255.255.255.0 10.0.12.1', 'R2: ip route 192.168.3.0 255.255.255.0 10.0.23.2', 'R2: end', 'R2: write memory',
      'R3: en', 'R3: conf t', 'R3: ip route 192.168.1.0 255.255.255.0 10.0.23.1', 'R3: ip route 192.168.2.0 255.255.255.0 10.0.23.1', 'R3: end', 'R3: write memory',
      'PC-A: ping 192.168.3.10', 'PC-C: ping 192.168.2.10', 'PC-B: ping 192.168.1.10',
    ],
    'ex-03-intervlan-routing-ospf': ['en', 'conf t', 'int g0/0', 'no shutdown', 'int g0/0.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1q 20', 'ip address 192.168.20.1 255.255.255.0', 'int g0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'router ospf 1', 'router-id 1.1.1.1', 'network 192.168.10.0 0.0.0.255 area 0', 'network 192.168.20.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.3 area 0', 'end', 'write memory', 'PC-A: ping 192.168.30.10', 'PC-B: ping 192.168.10.10'],
    'ex-04-troubleshooting-marathon': ['en', 'show vlan brief', 'conf t', 'int g0/1', 'switchport access vlan 10', 'int g0/8', 'switchport trunk allowed vlan 10,20', 'end', 'R1: en', 'R1: show ip interface brief', 'R1: conf t', 'R1: int g0/1', 'R1: no shutdown', 'R1: end', 'R2: en', 'R2: show ip protocols', 'R2: conf t', 'R2: router ospf 1', 'R2: network 192.168.30.0 0.0.0.255 area 0', 'R2: end', 'PC-A: ping 192.168.20.10', 'PC-A: ping 192.168.30.10', 'PC-C: ping 192.168.20.10'],
    'ex-05-secure-branch': [
      'en', 'conf t', 'enable secret Sw1tch!', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'username admin privilege 15 secret Adm1n-Sw', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'interface range g0/3 - 7', 'shutdown', 'end', 'write memory',
      'R1: en', 'R1: conf t', 'R1: enable secret R0uter!', 'R1: banner motd #Authorized access only#', 'R1: service password-encryption', 'R1: ip domain-name lab.local', 'R1: crypto key generate rsa modulus 2048', 'R1: ip ssh version 2', 'R1: username admin privilege 15 secret Adm1n-Rt', 'R1: line vty 0 4', 'R1: login local', 'R1: transport input ssh', 'R1: end', 'R1: write memory',
      'PC-A: ping 192.168.1.1',
    ],
    'ex-06-final-capstone': [
      'en', 'conf t', 'vlan 10', 'name SALES', 'vlan 20', 'name HR', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'int g0/2', 'switchport mode access', 'switchport access vlan 20', 'int g0/8', 'switchport mode trunk', 'exit', 'enable secret Capst0ne!', 'end', 'write memory',
      'R1: en', 'R1: conf t', 'R1: int g0/0', 'R1: no shutdown', 'R1: int g0/0.10', 'R1: encapsulation dot1q 10', 'R1: ip address 192.168.10.1 255.255.255.0', 'R1: int g0/0.20', 'R1: encapsulation dot1q 20', 'R1: ip address 192.168.20.1 255.255.255.0', 'R1: int g0/1', 'R1: ip address 10.0.0.1 255.255.255.252', 'R1: no shutdown', 'R1: router ospf 1', 'R1: router-id 1.1.1.1', 'R1: network 192.168.10.0 0.0.0.255 area 0', 'R1: network 192.168.20.0 0.0.0.255 area 0', 'R1: network 10.0.0.0 0.0.0.3 area 0', 'R1: exit', 'R1: enable secret Capst0ne!', 'R1: end', 'R1: write memory',
      'R2: en', 'R2: conf t', 'R2: int g0/1', 'R2: ip address 10.0.0.2 255.255.255.252', 'R2: no shutdown', 'R2: int g0/0', 'R2: ip address 203.0.113.2 255.255.255.252', 'R2: no shutdown', 'R2: exit', 'R2: ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'R2: router ospf 1', 'R2: router-id 2.2.2.2', 'R2: network 10.0.0.0 0.0.0.3 area 0', 'R2: default-information originate', 'R2: exit', 'R2: enable secret Capst0ne!', 'R2: end', 'R2: write memory',
      'PC-A: ping 192.168.20.10', 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8',
    ],
    'acl-01-first-standard-acl': ['en', 'conf t', 'access-list 10 deny 192.168.20.0 0.0.0.255', 'access-list 10 permit any', 'int g0/1', 'ip access-group 10 out', 'end', 'PC-B: ping 10.10.10.10', 'PC-A: ping 10.10.10.10', 'show access-lists'],
    'acl-02-extended-named-acl': ['en', 'conf t', 'ip access-list extended NO-PING-SRV', 'deny icmp 192.168.10.0 0.0.0.255 host 10.10.10.10 echo', 'permit ip any any', 'int g0/0.10', 'ip access-group NO-PING-SRV in', 'end', 'PC-A: ping 10.10.10.10', 'PC-A: ping 192.168.20.10', 'PC-B: ping 10.10.10.10'],
    'acl-03-implicit-deny': ['en', 'show access-lists', 'conf t', 'ip access-list extended SERVER-POLICY', 'permit ip any any', 'end', 'PC-B: ping 192.168.10.10', 'PC-B: ping 10.10.10.10'],
    'acl-04-protect-vty': ['en', 'conf t', 'access-list 5 remark Admin PC only', 'access-list 5 permit host 192.168.10.10', 'line vty 0 4', 'access-class 5 in', 'end', 'show running-config'],
    'acl-05-exam-access-policy': ['en', 'conf t', 'ip access-list extended HR-POLICY', 'deny ip 192.168.20.0 0.0.0.255 host 10.10.10.10', 'permit ip any any', 'ip access-list extended SALES-POLICY', 'permit tcp 192.168.10.0 0.0.0.255 host 10.10.10.10 eq 80', 'permit icmp 192.168.10.0 0.0.0.255 host 10.10.10.10', 'deny ip 192.168.10.0 0.0.0.255 host 10.10.10.10', 'permit ip any any', 'exit', 'access-list 5 permit host 192.168.10.10', 'int g0/0.20', 'ip access-group HR-POLICY in', 'int g0/0.10', 'ip access-group SALES-POLICY in', 'line vty 0 4', 'access-class 5 in', 'end', 'write memory', 'PC-B: ping 10.10.10.10', 'PC-B: ping 192.168.10.10', 'PC-A: ping 10.10.10.10', 'PC-A: ping 192.168.20.10'],
    'dh-01-dhcp-server': ['PC-A: ipconfig /renew', 'en', 'conf t', 'ip dhcp excluded-address 192.168.10.1 192.168.10.9', 'ip dhcp pool SALES', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'dns-server 8.8.8.8', 'end', 'PC-A: ipconfig /renew', 'PC-A: ping 192.168.10.1', 'show ip dhcp binding'],
    'dh-02-bindings-and-pool': ['PC-A: ipconfig /renew', 'PC-B: ipconfig /renew', 'en', 'show ip dhcp binding', 'show ip dhcp pool', 'PC-A: ping 192.168.10.11'],
    'dh-03-dhcp-relay': ['PC-A: ipconfig /renew', 'en', 'conf t', 'int g0/0', 'ip helper-address 10.0.0.2', 'end', 'PC-A: ipconfig /renew', 'PC-A: ping 10.0.0.2'],
    'dh-04-wrong-gateway': ['PC-A: ipconfig /all', 'en', 'conf t', 'ip dhcp pool SALES', 'default-router 192.168.10.1', 'end', 'PC-A: ipconfig /renew', 'PC-A: ping 10.0.0.2'],
    'ex-07-services-and-security': [
      'en', 'conf t', 'ip dhcp excluded-address 192.168.10.1 192.168.10.9', 'ip dhcp excluded-address 192.168.20.1 192.168.20.9', 'ip dhcp pool SALES', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'dns-server 10.10.10.10', 'ip dhcp pool HR', 'network 192.168.20.0 255.255.255.0', 'default-router 192.168.20.1', 'dns-server 10.10.10.10', 'exit',
      'ip access-list extended HR-POLICY', 'permit udp 192.168.20.0 0.0.0.255 host 10.10.10.10 eq 53', 'deny ip 192.168.20.0 0.0.0.255 host 10.10.10.10', 'permit ip any any', 'int g0/0.20', 'ip access-group HR-POLICY in', 'exit', 'access-list 5 permit host 192.168.10.10', 'line vty 0 4', 'access-class 5 in', 'end', 'write memory',
      'PC-A: ipconfig /renew', 'PC-B: ipconfig /renew', 'PC-A: ping 10.10.10.10', 'PC-A: ping 192.168.20.10', 'PC-B: ping 192.168.10.10', 'PC-B: ping 10.10.10.10',
    ],
    'nat-01-static-nat': ['NET-PC: ping 203.0.113.10', 'en', 'conf t', 'ip nat inside source static 192.168.10.20 203.0.113.10', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end', 'NET-PC: ping 203.0.113.10', 'show ip nat translations'],
    'nat-02-pat-overload': ['PC-A: ping 8.8.8.8', 'en', 'conf t', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 interface g0/1 overload', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end', 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8', 'show ip nat translations'],
    'nat-03-dynamic-pool': ['en', 'conf t', 'ip nat pool PUBLIC 203.0.113.20 203.0.113.21 netmask 255.255.255.0', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 pool PUBLIC', 'end', 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8', 'SRV1: ping 8.8.8.8', 'conf t', 'ip nat inside source list 1 pool PUBLIC overload', 'end', 'SRV1: ping 8.8.8.8'],
    'nat-04-exam-internet-edge': ['en', 'conf t', 'ip nat inside source static 192.168.10.20 203.0.113.10', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 interface g0/1 overload', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end', 'write memory', 'NET-PC: ping 203.0.113.10', 'PC-A: ping 8.8.8.8', 'PC-B: ping 8.8.8.8'],
    'v6-01-first-addresses': ['en', 'conf t', 'ipv6 unicast-routing', 'int g0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'end', 'show ipv6 interface brief', 'ping 2001:db8:1::10'],
    'v6-02-eui64-link-local': ['en', 'conf t', 'int g0/1', 'ipv6 address 2001:db8:12::/64 eui-64', 'ipv6 address fe80::1 link-local', 'no shutdown', 'end', 'show ipv6 interface brief', 'ping 2001:db8:12::2'],
    'v6-03-static-routes': ['PC-A: ping 2001:db8:2::10', 'en', 'conf t', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'end', 'show ipv6 route', 'PC-A: ping 2001:db8:2::10'],
    'v6-04-default-via-link-local': ['en', 'conf t', 'ipv6 route ::/0 fe80::2', 'ipv6 route ::/0 g0/1 fe80::2', 'end', 'show ipv6 route', 'PC-A: ping 2001:db8:ffff::1'],
    'v6-05-exam-dual-stack': [
      'en', 'conf t', 'ipv6 unicast-routing', 'int g0/0', 'ipv6 address 2001:db8:1::1/64', 'int g0/1', 'ipv6 address 2001:db8:12::1/64', 'exit', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'end', 'write memory',
      'R2: en', 'R2: conf t', 'R2: ipv6 unicast-routing', 'R2: int g0/0', 'R2: ipv6 address 2001:db8:2::1/64', 'R2: int g0/1', 'R2: ipv6 address 2001:db8:12::2/64', 'R2: exit', 'R2: ipv6 route 2001:db8:1::/64 2001:db8:12::1', 'R2: end', 'R2: write memory',
      'PC-A: ping 2001:db8:2::10', 'PC-B: ping 2001:db8:1::10', 'PC-A: ping 192.168.2.10',
    ],
  };

  const GET_IFS = 'PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces';
  const PATCH_G00 = `PC-A: curl -k -i -u netops:Aut0mate! -X PATCH -H 'Content-Type: application/yang-data+json' -d '{"ietf-interfaces:interface": {"name": "GigabitEthernet0/0", "description": "Sales LAN"}}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0`;
  Object.assign(solutions, {
    'ns-01-password-policy': ['en', 'conf t', 'security passwords min-length 10', 'enable secret cisco', 'enable secret Edge-R1-S3cret', 'login block-for 120 attempts 3 within 60', 'line con 0', 'exec-timeout 5 0', 'line vty 0 4', 'exec-timeout 5 0', 'exit', 'service password-encryption', 'end', 'show login'],
    'ns-02-aaa-local': ['enable', 'Edge-R1-S3cret', 'conf t', 'aaa new-model', 'aaa authentication login default local', 'username netops privilege 15 secret Aut0mate-Edge', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'line vty 0 4', 'transport input ssh', 'end', 'write memory'],
    'ns-03-dhcp-snooping': ['PC-A: ipconfig /renew', 'en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'no ip dhcp snooping information option', 'end', 'PC-A: ipconfig /renew', 'conf t', 'int g0/8', 'ip dhcp snooping trust', 'end', 'PC-A: ipconfig /renew', 'show ip dhcp snooping', 'show ip dhcp snooping binding'],
    'ns-04-dynamic-arp-inspection': ['en', 'conf t', 'ip arp inspection vlan 10', 'int g0/8', 'ip arp inspection trust', 'end', 'PC-A: ping 192.168.10.1', 'show ip arp inspection vlan 10', 'show ip arp inspection interfaces'],
    'ns-05-dai-static-server': ['SRV1: ping 192.168.10.1', 'en', 'show ip arp inspection interfaces', 'conf t', 'int g0/3', 'ip arp inspection trust', 'end', 'SRV1: ping 192.168.10.1', 'PC-A: ping 192.168.10.1'],
    'ns-06-exam-harden-the-branch': [
      'en', 'conf t', 'security passwords min-length 10', 'enable secret Br4nch-Secret', 'login block-for 120 attempts 3 within 60', 'aaa new-model', 'aaa authentication login default local', 'username netops privilege 15 secret Aut0mate-Edge', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'access-list 5 permit host 192.168.10.50', 'line vty 0 4', 'transport input ssh', 'access-class 5 in', 'exec-timeout 5 0', 'line con 0', 'exec-timeout 5 0', 'exit', 'service password-encryption', 'end', 'write memory',
      'SW1: en', 'SW1: conf t', 'SW1: ip dhcp snooping', 'SW1: ip dhcp snooping vlan 10', 'SW1: no ip dhcp snooping information option', 'SW1: ip arp inspection vlan 10', 'SW1: int g0/8', 'SW1: ip dhcp snooping trust', 'SW1: ip arp inspection trust', 'SW1: int g0/3', 'SW1: ip arp inspection trust', 'SW1: interface range g0/1 - 2', 'SW1: switchport port-security', 'SW1: switchport port-security maximum 1', 'SW1: switchport port-security mac-address sticky', 'SW1: end',
      'PC-A: ipconfig /renew', 'PC-A: ping 192.168.10.50', 'SRV1: ping 192.168.10.1', 'SW1: write memory',
    ],
    'au-01-enable-the-api': [GET_IFS, 'en', 'conf t', 'username netops privilege 15 secret Aut0mate!', 'ip http secure-server', 'ip http authentication local', 'restconf', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'netconf-yang', 'end', 'show platform software yang-management process', GET_IFS],
    'au-02-read-the-device-as-json': ['PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1', 'PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname', 'en', 'conf t', 'int g0/1', 'no shutdown', 'end', 'ping 10.0.0.2'],
    'au-03-configure-through-the-api': [PATCH_G00, `PC-A: curl -k -i -u netops:Aut0mate! -X PATCH -H 'Content-Type: application/yang-data+json' -d '{"Cisco-IOS-XE-native:hostname": "Branch-R1"}' https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname`, 'en', 'show running-config'],
    'au-04-deploy-from-a-json-intent': ['en', 'conf t', 'hostname Site2-R2', 'int g0/0', 'description Site 2 LAN', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'int g0/1', 'description Link to R1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'ntp server 192.168.2.50', 'end', 'SRV1: ping 192.168.1.10'],
    'au-05-telemetry-for-the-assistant': ['en', 'conf t', 'logging host 192.168.2.50', 'logging trap informational', 'snmp-server community NetOps-RO ro', 'snmp-server location Branch 1 comms room', 'snmp-server contact netops@example.com', 'ntp server 192.168.2.50', 'end', 'show logging', 'show ntp status'],
    'au-06-review-the-ai-change': ['PC-B: ping 192.168.2.50', 'PC-A: ping 192.168.2.50', 'en', 'conf t', 'ip access-list extended GUEST-POLICY', 'deny ip 192.168.3.0 0.0.0.255 host 192.168.2.50', 'permit ip any any', 'int g0/2', 'ip access-group GUEST-POLICY in', 'end', 'PC-B: ping 192.168.2.50', 'PC-A: ping 192.168.2.50', 'PC-B: ping 10.0.0.2'],
    'au-07-exam-automation-ready-branch': ['en', 'conf t', 'username netops privilege 15 secret Aut0mate!', 'ip http secure-server', 'ip http authentication local', 'restconf', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'netconf-yang', 'logging host 192.168.2.50', 'logging trap informational', 'snmp-server community NetOps-RO ro', 'ntp server 192.168.2.50', 'end', GET_IFS, PATCH_G00, 'write memory'],
  });

  const HEREDOC = (name: string, ...body: string[]) => [`cat > ${name} << 'EOF'`, ...body, 'EOF'];
  Object.assign(solutions, {
    'lx-01-find-your-way': ['pwd', 'ls -la', 'cd /var/log', 'ls', 'cat /etc/os-release', 'man ls', 'cd'],
    'lx-02-make-files-and-folders': ['mkdir -p ~/projects/netlab/docs', 'echo "NetLab project" > ~/projects/netlab/README.md', 'cp ~/projects/netlab/README.md ~/projects/netlab/docs/', 'mv ~/projects/netlab/docs/README.md ~/projects/netlab/docs/intro.md', 'rm ~/old-draft.txt'],
    'lx-03-read-and-search': ['head -3 /var/log/auth.log', 'tail -2 /var/log/auth.log', 'grep -c "Failed password" /var/log/auth.log', 'grep "Failed password" /var/log/auth.log > ~/failed.txt', 'wc -l ~/failed.txt'],
    'lx-04-permissions': ['ls -l', 'chmod 600 secret.txt', 'chmod +x deploy.sh', './deploy.sh', 'mkdir shared', 'chmod 770 shared', 'sudo chown :devops shared'],
    'lx-05-links-and-find': ['ln -s /var/log/app.log ~/app.log', 'ls -l ~/app.log', 'grep ERROR ~/app.log', 'find /var/log -name "*.log"', 'find ~ -type d'],
    'lx-06-exam-shell-essentials': ['mkdir -p ~/reports/2026', 'grep ERROR /var/log/app.log > ~/reports/2026/errors.txt', 'grep -c ERROR /var/log/app.log > ~/reports/2026/count.txt', 'chmod 640 ~/reports/2026/errors.txt', 'ln -s reports/2026/errors.txt ~/latest-errors', 'rm ~/old-draft.txt'],
    'lx-07-become-root': ['cat /etc/shadow', 'sudo -i', 'whoami', 'cat /etc/shadow', 'exit', 'sudo apt update'],
    'lx-08-users-and-groups': ['sudo groupadd devops', 'sudo useradd -m -s /bin/bash -G devops alice', 'sudo passwd alice', 'Al1ce-pass', 'Al1ce-pass', 'sudo usermod -aG devops bob', 'id alice', 'cat /etc/group'],
    'lx-09-run-a-web-server': ['systemctl status nginx', 'sudo systemctl enable --now nginx', 'ss -tlnp', 'echo "<h1>Welcome to NetLab on web1</h1>" | sudo tee /var/www/html/index.html', 'PC-A: curl http://192.168.1.50'],
    'lx-10-processes-and-logs': ['ps aux | grep runaway', 'pkill -f runaway', 'ps aux | grep runaway', 'journalctl -u ssh', 'grep -c ERROR /var/log/app.log'],
    'lx-11-network-from-the-host': ['ip addr', 'ip route', 'ping -c 3 192.168.1.1', 'ping -c 3 192.168.2.50', 'curl -s -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces'],
    'lx-12-exam-bring-up-the-server': ['sudo hostnamectl set-hostname branch-web1', 'sudo groupadd webteam', 'sudo useradd -m -s /bin/bash -G webteam carol', 'sudo passwd carol', 'C4rol-pass', 'C4rol-pass', 'sudo apt install -y nginx', 'sudo systemctl enable --now nginx', 'echo "<h1>Branch web1</h1>" | sudo tee /var/www/html/index.html', 'pkill -f runaway', 'ping -c 2 192.168.1.1', 'PC-A: curl http://192.168.1.50'],
    'lx-13-variables-and-quotes': ['site=netlab', 'echo "Site: $site"', "echo 'Literal: $site'", 'today=$(date +%F)', 'echo $today', 'export EDITOR=nano', 'env | grep EDITOR', 'echo $((7*6))'],
    'lx-14-your-first-script': [...HEREDOC('hello.sh', '#!/bin/bash', 'echo "Hello, $1!"'), 'cat hello.sh', 'chmod +x hello.sh', './hello.sh NetLab'],
    'lx-15-conditions-and-exit-codes': [...HEREDOC('check.sh', '#!/bin/bash', 'if [ -f "$1" ]; then', '  echo "$1 exists"', 'else', '  echo "$1 missing"', '  exit 1', 'fi'), 'chmod +x check.sh', './check.sh /etc/hosts', './check.sh /etc/nothing; echo $?'],
    'lx-16-loops': ['for f in /var/log/*.log; do echo "$f: $(wc -l < $f) lines"; done', 'while read t; do mkdir -p ~/teams/$t; done < teams.txt', 'ls ~/teams'],
    'lx-17-functions': [...HEREDOC('lib.sh', 'log() {', '  echo "[$(date +%T)] $*"', '}', 'check_service() {', '  systemctl is-active "$1" > /dev/null && return 0', '  return 1', '}'), 'source lib.sh', 'log hello', 'check_service ssh && echo "ssh is up"'],
    'lx-18-text-pipelines': ["grep \"Failed password\" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn > ~/attackers.txt", 'cat ~/attackers.txt', 'cut -d: -f1,7 /etc/passwd | grep bash', "sed 's/ERROR/ERR/' /var/log/app.log | head -3"],
    'lx-19-exam-backup-script': [...HEREDOC('backup.sh', '#!/bin/bash', 'if [ -z "$1" ]; then', '  echo "usage: backup.sh <dir>"', '  exit 1', 'fi', 'dest=~/backup-$(date +%F)', 'mkdir -p "$dest"', 'count=0', 'for f in "$1"/*; do', '  cp "$f" "$dest/"', '  count=$((count+1))', 'done', 'echo "Backed up $count files to $dest"'), 'chmod +x backup.sh', './backup.sh', './backup.sh ~/docs'],
    'lx-20-hello-python': ['python3 --version', "python3 -c 'print(\"Hello from Python\")'", ...HEREDOC('hello.py', 'name = "NetLab"', 'print(f"Hello, {name}!")'), 'python3 hello.py'],
    'lx-21-read-files-with-python': [...HEREDOC('errors.py', 'errors = []', 'with open("/var/log/app.log") as f:', '    for line in f:', '        if "ERROR" in line:', '            errors.append(line.rstrip())', 'print(f"{len(errors)} errors")', 'with open("summary.txt", "w") as out:', '    out.write("\\n".join(errors) + "\\n")'), 'python3 errors.py', 'cat summary.txt'],
    'lx-22-read-json-with-python': ['cat intent.json', ...HEREDOC('intent.py', 'import json', 'with open("intent.json") as f:', '    intent = json.load(f)', 'print(intent["device"]["hostname"])', 'for iface in intent["interfaces"]:', '    print(iface["name"], iface["ipv4"]["ip"])'), 'python3 intent.py'],
    'lx-23-generate-config-from-json': [...HEREDOC('render.py', 'import json', 'intent = json.load(open("intent.json"))', 'lines = [f"hostname {intent[\'device\'][\'hostname\']}"]', 'for i in intent["interfaces"]:', '    lines += [f"interface {i[\'name\']}", f" description {i[\'description\']}", f" ip address {i[\'ipv4\'][\'ip\']} {i[\'ipv4\'][\'netmask\']}", " no shutdown"]', 'for r in intent["static-routes"]:', '    lines.append(f"ip route {r[\'prefix\']} {r[\'netmask\']} {r[\'next-hop\']}")', 'for s in intent["ntp"]["servers"]:', '    lines.append(f"ntp server {s}")', 'open("r2.cfg", "w").write("\\n".join(lines) + "\\n")'), 'python3 render.py', 'cat r2.cfg'],
    'lx-24-exam-audit-the-server': [...HEREDOC('audit.py', 'import json', 'users = []', 'for line in open("/etc/passwd"):', '    name, _, uid, _, _, _, shell = line.rstrip().split(":")', '    if int(uid) >= 1000 and "nologin" not in shell:', '        users.append((name, uid, shell))', 'with open("users.csv", "w") as f:', '    for u in users:', '        f.write(",".join(u) + "\\n")', 'failed = sum(1 for l in open("/var/log/auth.log") if "Failed password" in l)', 'print(f"{failed} failed logins")', 'json.dump({"users": [u[0] for u in users], "failed_logins": failed}, open("audit.json", "w"), indent=2)'), 'python3 audit.py', 'cat users.csv'],
  });

  const TEE = (file: string, ...body: string[]) => [`sudo tee ${file} << 'EOF'`, ...body, 'EOF'];
  const NETLAB_TLS = ['server {', '    listen 80;', '    server_name netlab.lab.local;', '    return 301 https://$host$request_uri;', '}', 'server {', '    listen 443 ssl;', '    server_name netlab.lab.local;', '    ssl_certificate /etc/ssl/certs/netlab.crt;', '    ssl_certificate_key /etc/ssl/private/netlab.key;', '    add_header Strict-Transport-Security "max-age=31536000" always;', '    root /var/www/netlab;', '    index index.html;', '}'];
  Object.assign(solutions, {
    'lx-25-serve-a-site-with-nginx': ['cat /etc/nginx/nginx.conf', 'ls -l /etc/nginx/sites-enabled', 'sudo mkdir -p /var/www/netlab', 'echo "<h1>NetLab site</h1>" | sudo tee /var/www/netlab/index.html', ...TEE('/etc/nginx/sites-available/netlab.conf', 'server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    index index.html;', '}'), 'sudo ln -s /etc/nginx/sites-available/netlab.conf /etc/nginx/sites-enabled/', 'sudo nginx -t', 'sudo systemctl enable --now nginx', 'curl -H "Host: netlab.lab.local" http://192.168.1.50', 'PC-A: curl -H "Host: netlab.lab.local" http://192.168.1.50'],
    'lx-26-virtual-hosts': ['sudo mkdir -p /var/www/shop', "echo '<h1>Shop</h1>' | sudo tee /var/www/shop/index.html", ...TEE('/etc/nginx/conf.d/shop.conf', 'server {', '    listen 80;', '    server_name shop.lab.local;', '    root /var/www/shop;', '    index index.html;', '}'), 'sudo nginx -t', 'sudo systemctl reload nginx', 'echo "127.0.0.1 netlab.lab.local shop.lab.local" | sudo tee -a /etc/hosts', 'curl http://shop.lab.local', 'curl http://netlab.lab.local', 'curl -H "Host: nobody.example" http://192.168.1.50'],
    'lx-27-troubleshoot-nginx-config': ['sudo systemctl start nginx', 'sudo nginx -t', "sudo sed -i 's/servr_name/server_name/' /etc/nginx/conf.d/netlab.conf", "sudo sed -i 's#root /var/www/netlab$#root /var/www/netlab;#' /etc/nginx/conf.d/netlab.conf", 'sudo nginx -t', 'sudo systemctl start nginx', 'curl -H "Host: netlab.lab.local" http://192.168.1.50'],
    'lx-28-self-signed-tls': ['sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"', 'sudo chmod 600 /etc/ssl/private/netlab.key', 'sudo openssl x509 -in /etc/ssl/certs/netlab.crt -noout -subject -dates', ...TEE('/etc/nginx/conf.d/netlab.conf', 'server {', '    listen 80;', '    listen 443 ssl;', '    server_name netlab.lab.local;', '    ssl_certificate /etc/ssl/certs/netlab.crt;', '    ssl_certificate_key /etc/ssl/private/netlab.key;', '    root /var/www/netlab;', '    index index.html;', '}'), 'sudo nginx -t', 'sudo systemctl reload nginx', 'curl -H "Host: netlab.lab.local" https://192.168.1.50', 'curl -k -H "Host: netlab.lab.local" https://192.168.1.50'],
    'lx-29-redirect-http-to-https': [...TEE('/etc/nginx/conf.d/netlab.conf', ...NETLAB_TLS), 'sudo nginx -t', 'sudo systemctl reload nginx', 'curl -I http://netlab.lab.local', 'curl -kLi http://netlab.lab.local'],
    'lx-30-reverse-proxy': ['curl http://192.168.2.50:8080', ...TEE('/etc/nginx/conf.d/netlab.conf', 'server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    index index.html;', '    location /app/ {', '        proxy_pass http://192.168.2.50:8080/;', '        proxy_set_header Host $host;', '    }', '}'), 'sudo nginx -t', 'sudo systemctl reload nginx', 'curl http://netlab.lab.local/app/', 'PC-A: curl -H "Host: netlab.lab.local" http://192.168.1.50/app/'],
    'lx-31-load-balancing': [...TEE('/etc/nginx/conf.d/netlab.conf', 'upstream backend {', '    server 192.168.2.50:8080;', '    server 192.168.2.51:8080;', '}', 'server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    index index.html;', '    location /app/ {', '        proxy_pass http://backend/;', '        proxy_set_header Host $host;', '    }', '}'), 'sudo nginx -t', 'sudo systemctl reload nginx', 'for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done'],
    'lx-32-backend-down': ['for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done', 'curl http://192.168.2.51:8080', 'app2: systemctl status app', 'app2: sudo systemctl start app', 'for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done'],
    'lx-33-exam-web-front-end': ['sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/www.key -out /etc/ssl/certs/www.crt -subj "/CN=www.lab.local"', 'sudo mkdir -p /var/www/www', 'echo "<h1>Production site</h1>" | sudo tee /var/www/www/index.html', ...TEE('/etc/nginx/conf.d/www.conf', 'upstream backend {', '    least_conn;', '    server 192.168.2.50:8080;', '    server 192.168.2.51:8080;', '}', 'server {', '    listen 80;', '    server_name www.lab.local;', '    return 301 https://$host$request_uri;', '}', 'server {', '    listen 443 ssl;', '    server_name www.lab.local;', '    ssl_certificate /etc/ssl/certs/www.crt;', '    ssl_certificate_key /etc/ssl/private/www.key;', '    add_header Strict-Transport-Security "max-age=31536000" always;', '    root /var/www/www;', '    index index.html;', '    location /api/ {', '        proxy_pass http://backend/;', '        proxy_set_header Host $host;', '    }', '}'), 'sudo nginx -t', 'sudo systemctl enable --now nginx', 'echo "127.0.0.1 www.lab.local" | sudo tee -a /etc/hosts', 'curl -I http://www.lab.local', 'curl -kI https://www.lab.local', 'for i in 1 2 3 4; do curl -sk https://www.lab.local/api/; done'],
  });

  const A_TLS = ['<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '</VirtualHost>', '<VirtualHost *:443>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    SSLEngine on', '    SSLCertificateFile /etc/ssl/certs/netlab.crt', '    SSLCertificateKeyFile /etc/ssl/private/netlab.key', '</VirtualHost>'];
  const A_CERT = 'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"';
  Object.assign(solutions, {
    'lx-34-install-apache': ['sudo apt install -y apache2', 'ls /etc/apache2', 'ls -l /etc/apache2/sites-enabled', 'sudo apache2ctl configtest', 'sudo apache2ctl -M', 'curl http://192.168.1.50', 'PC-A: curl http://192.168.1.50'],
    'lx-35-apache-virtual-host': [...TEE('/etc/apache2/sites-available/netlab.conf', '<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '</VirtualHost>'), 'sudo a2ensite netlab', 'curl http://netlab.lab.local', 'sudo apache2ctl configtest', 'sudo systemctl reload apache2', 'curl http://netlab.lab.local', 'curl -H "Host: nobody.example" http://192.168.1.50'],
    'lx-36-troubleshoot-apache': ['sudo systemctl start apache2', 'sudo apache2ctl configtest', "sudo sed -i 's/DocumnetRoot/DocumentRoot/' /etc/apache2/sites-available/netlab.conf", "echo '</VirtualHost>' | sudo tee -a /etc/apache2/sites-available/netlab.conf", 'sudo apache2ctl configtest', 'sudo systemctl start apache2', 'curl http://netlab.lab.local'],
    'lx-37-apache-tls': [...TEE('/etc/apache2/sites-available/netlab.conf', ...A_TLS), 'sudo apache2ctl configtest', 'sudo a2enmod ssl', A_CERT, 'sudo apache2ctl configtest', 'sudo systemctl restart apache2', 'ss -tln', 'curl https://netlab.lab.local', 'curl -k https://netlab.lab.local'],
    'lx-38-apache-redirect-hsts': [
      ...TEE('/etc/apache2/sites-available/netlab.conf', '<VirtualHost *:80>', '    ServerName netlab.lab.local', '    Redirect permanent / https://netlab.lab.local/', '</VirtualHost>', '<VirtualHost *:443>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    SSLEngine on', '    SSLCertificateFile /etc/ssl/certs/netlab.crt', '    SSLCertificateKeyFile /etc/ssl/private/netlab.key', '    Header always set Strict-Transport-Security "max-age=31536000"', '</VirtualHost>'),
      'sudo a2enmod headers', 'sudo apache2ctl configtest', 'sudo systemctl restart apache2', 'curl -I http://netlab.lab.local', 'curl -kLi http://netlab.lab.local',
    ],
    'lx-39-apache-reverse-proxy': [
      'curl http://192.168.2.50:8080',
      ...TEE('/etc/apache2/sites-available/netlab.conf', '<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    ProxyPass /app/ http://192.168.2.50:8080/', '    ProxyPassReverse /app/ http://192.168.2.50:8080/', '</VirtualHost>'),
      'sudo a2enmod proxy', 'sudo apache2ctl configtest', 'sudo systemctl restart apache2', 'curl http://netlab.lab.local/app/', 'sudo a2enmod proxy_http', 'sudo systemctl restart apache2', 'curl http://netlab.lab.local/app/', 'curl http://netlab.lab.local/',
    ],
    'lx-40-apache-load-balancing': [
      'sudo a2enmod proxy_balancer lbmethod_byrequests',
      ...TEE('/etc/apache2/sites-available/netlab.conf', '<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    <Proxy balancer://cluster>', '        BalancerMember http://192.168.2.50:8080', '        BalancerMember http://192.168.2.51:8080', '    </Proxy>', '    ProxyPass /app/ balancer://cluster/', '</VirtualHost>'),
      'sudo apache2ctl configtest', 'sudo systemctl restart apache2', 'for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done',
    ],
    'lx-41-apache-port-conflict': ['sudo systemctl start apache2', 'systemctl status apache2', 'sudo ss -tlnp', 'sudo systemctl disable --now nginx', 'sudo systemctl enable --now apache2', 'curl http://192.168.1.50'],
    'lx-42-exam-apache-front-end': [
      'sudo a2enmod ssl headers proxy proxy_http proxy_balancer lbmethod_byrequests',
      'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/www.key -out /etc/ssl/certs/www.crt -subj "/CN=www.lab.local"',
      'sudo mkdir -p /var/www/www',
      'echo "<h1>Production site</h1>" | sudo tee /var/www/www/index.html',
      ...TEE(
        '/etc/apache2/sites-available/www.conf',
        '<VirtualHost *:80>',
        '    ServerName www.lab.local',
        '    Redirect permanent / https://www.lab.local/',
        '</VirtualHost>',
        '<VirtualHost *:443>',
        '    ServerName www.lab.local',
        '    DocumentRoot /var/www/www',
        '    SSLEngine on',
        '    SSLCertificateFile /etc/ssl/certs/www.crt',
        '    SSLCertificateKeyFile /etc/ssl/private/www.key',
        '    Header always set Strict-Transport-Security "max-age=31536000"',
        '    <Proxy balancer://cluster>',
        '        BalancerMember http://192.168.2.50:8080',
        '        BalancerMember http://192.168.2.51:8080',
        '    </Proxy>',
        '    ProxyPass /api/ balancer://cluster/',
        '</VirtualHost>',
      ),
      'sudo a2ensite www', 'sudo apache2ctl configtest', 'sudo systemctl restart apache2',
      'curl -I http://www.lab.local', 'curl -kI https://www.lab.local', 'for i in 1 2 3 4; do curl -sk https://www.lab.local/api/; done',
    ],
  });

  const HOME = '/home/student';
  const fakes: Record<string, Fake> = {
    'lx-20-hello-python': (p) => ({ stdout: p.argv[0] === '-c' ? 'Hello from Python\n' : 'Hello, NetLab!\n' }),
    'lx-21-read-files-with-python': () => ({ stdout: '2 errors\n', files: { [`${HOME}/summary.txt`]: '2026-09-11 08:57:44 ERROR disk full while writing /var/lib/app/cache\n2026-09-11 08:58:10 ERROR timeout talking to 192.168.2.50:5432\n' } }),
    'lx-22-read-json-with-python': () => ({ stdout: 'Site2-R2\nGigabitEthernet0/0 192.168.2.1\nGigabitEthernet0/1 10.0.0.2\n' }),
    'lx-23-generate-config-from-json': () => ({ files: { [`${HOME}/r2.cfg`]: ['hostname Site2-R2', 'interface GigabitEthernet0/0', ' description Site 2 LAN', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown', 'interface GigabitEthernet0/1', ' description Link to R1', ' ip address 10.0.0.2 255.255.255.252', ' no shutdown', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'ntp server 192.168.1.50', ''].join('\n') } }),
    'lx-24-exam-audit-the-server': () => ({ stdout: '4 failed logins\n', files: { [`${HOME}/users.csv`]: 'student,1000,/bin/bash\nbob,1001,/bin/bash\n', [`${HOME}/audit.json`]: '{\n  "users": [\n    "student",\n    "bob"\n  ],\n  "failed_logins": 4\n}' } }),
  };

  it('covers every lab', () => {
    expect(Object.keys(solutions).sort()).toEqual(labs.map((l) => l.id).sort());
  });

  for (const lab of labs) {
    it(lab.id, () => {
      pythonFake = fakes[lab.id] ?? (() => ({}));
      const net = run(labNetwork(lab), ...(solutions[lab.id] ?? []));
      const result = grade(lab.objectives, net);
      const failing = result.objectives.filter((o) => !o.passed).map((o) => `${o.label}: ${o.checks.filter((c) => !c.passed).map((c) => c.label).join(', ')}`);
      expect(failing).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
    });
  }
});
