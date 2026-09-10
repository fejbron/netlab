import { describe, expect, it } from 'vitest';
import { labNetwork, labs } from '../content';
import { grade } from './grader';
import { executeHost, executeOn, type NetworkState } from './index';

/** Reference-solution lines. "R2: cmd" or "PC-A: cmd" targets another node; default is the primary device. */
function run(net: NetworkState, ...lines: string[]): NetworkState {
  return lines.reduce((n, raw) => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m && (n.devices[m[1]] || n.hosts[m[1]]) ? m[1] : n.primary;
    const line = m && node === m[1] ? m[2] : raw;
    return n.hosts[node] ? executeHost(n, node, line).network : executeOn(n, node, line).network;
  }, net);
}

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
    'sec-04-exam-harden-the-switch': ['en', 'conf t', 'hostname Secure-SW1', 'banner motd #Authorized access only#', 'enable secret H4rden!', 'service password-encryption', 'username admin privilege 15 secret Adm1n-Sec', 'line con 0', 'password c0nsole', 'login', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'interface range g0/3 - 7', 'shutdown', 'end', 'write memory'],
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

  it('covers every lab', () => {
    expect(Object.keys(solutions).sort()).toEqual(labs.map((l) => l.id).sort());
  });

  for (const lab of labs) {
    it(lab.id, () => {
      const net = run(labNetwork(lab), ...(solutions[lab.id] ?? []));
      const result = grade(lab.objectives, net);
      const failing = result.objectives.filter((o) => !o.passed).map((o) => `${o.label}: ${o.checks.filter((c) => !c.passed).map((c) => c.label).join(', ')}`);
      expect(failing).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
    });
  }
});
