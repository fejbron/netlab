import { buildNetwork, createRouter, createSwitch, type NetworkState, type RouterOptions } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-acls';

/**
 * PC-A (Sales, VLAN 10) and PC-B (HR, VLAN 20) - SW1 - R1 g0/0 (router on a stick)
 * R1 g0/1 (10.10.10.1) - SRV1 (10.10.10.10). Everything works; R1 is the learner's device.
 */
export function aclCampus(opts: { acls?: RouterOptions['acls']; interfaces?: Record<string, { aclIn?: string; aclOut?: string }> } = {}): NetworkState {
  const sw = createSwitch({
    hostname: 'SW1',
    ports: 8,
    vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
    interfaces: { 'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales PC' }, 'g0/2': { mode: 'access', accessVlan: 20, description: 'HR PC' }, 'g0/8': { mode: 'trunk', description: 'Trunk to R1' } },
  });
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { description: 'Trunk to SW1', shutdown: false },
      'g0/0.10': { encapsulation: { vlan: 10, native: false }, ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', description: 'Sales VLAN', ...(opts.interfaces?.['g0/0.10'] ?? {}) },
      'g0/0.20': { encapsulation: { vlan: 20, native: false }, ipAddress: '192.168.20.1', subnetMask: '255.255.255.0', description: 'HR VLAN', ...(opts.interfaces?.['g0/0.20'] ?? {}) },
      'g0/1': { description: 'Server LAN', ipAddress: '10.10.10.1', subnetMask: '255.255.255.0', shutdown: false, ...(opts.interfaces?.['g0/1'] ?? {}) },
    },
    acls: opts.acls,
    overrides: { users: [{ username: 'admin', password: 'Adm1n-Lab', secret: true, privilege: 15 }], lines: { con: { login: false }, vty: { login: 'local', transportInput: 'ssh' } }, ipDomainName: 'lab.local', rsaKeyBits: 2048, sshVersion: 2 },
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

export const learnAclLabs: Lab[] = [
  {
    id: 'acl-01-first-standard-acl',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Standard ACL',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Keep HR away from the server with a numbered standard access list placed close to the destination.',
    scenario:
      'The finance server SRV1 (10.10.10.10) sits behind R1 g0/1. Sales (192.168.10.0/24) needs it; HR (192.168.20.0/24) must not reach it at all.\n\nA standard ACL only looks at the source address, so the rule of thumb is to place it as close to the destination as possible. Create access-list 10 that denies the HR network and permits everything else, apply it outbound on g0/1, then prove it: PC-B is refused, PC-A still gets through. Check the hit counters afterwards.',
    concepts: ['Standard ACL', 'Wildcard masks', 'Implicit deny', 'ip access-group out', 'show access-lists'],
    hints: [
      'access-list 10 deny 192.168.20.0 0.0.0.255, then access-list 10 permit any. Without the permit, the implicit deny would block Sales too.',
      'interface g0/1, ip access-group 10 out.',
      'From PC-B, ping 10.10.10.10 now answers Destination net unreachable from 192.168.20.1. From PC-A it still works.',
      'show access-lists shows how many packets each line matched.',
    ],
    createState: () => aclCampus(),
    objectives: [
      { id: 'deny', label: 'Deny the HR network first', checks: [{ type: 'acl-entry', name: '10', action: 'deny', src: '192.168.20.0 0.0.0.255', position: 1, label: 'access-list 10 deny 192.168.20.0 0.0.0.255 is the first entry' }] },
      { id: 'permit', label: 'Permit everyone else', checks: [{ type: 'acl-entry', name: '10', action: 'permit', src: 'any', label: 'access-list 10 permit any' }] },
      { id: 'apply', label: 'Apply it outbound on g0/1', checks: [{ type: 'acl-applied', interface: 'g0/1', direction: 'out', name: '10' }] },
      { id: 'prove', label: 'Prove the policy', checks: [{ type: 'ping', device: 'PC-B', target: '10.10.10.10', success: false, denied: true, label: 'PC-B is refused (Destination net unreachable)' }, { type: 'ping', device: 'PC-A', target: '10.10.10.10', success: true, label: 'PC-A still reaches SRV1' }] },
      { id: 'counters', label: 'Read the hit counters', checks: [{ type: 'command', pattern: '^(do )?show (ip )?access-lists' }] },
    ],
  },
  {
    id: 'acl-02-extended-named-acl',
    moduleId: MODULE,
    order: 2,
    title: 'Extended ACL: Surgical Control',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Block only ping from Sales to the server, and nothing else, with a named extended list close to the source.',
    scenario:
      'The server team is tired of Sales staff pinging SRV1 to "check if it is up". They want ICMP echo requests from Sales to the server blocked, but every other kind of traffic, including Sales talking to HR, must keep working.\n\nExtended ACLs match protocol, source and destination, so they go close to the source. Create a named extended list NO-PING-SRV that denies ICMP echo from 192.168.10.0/24 to host 10.10.10.10 and permits all other IP traffic, and apply it inbound on g0/0.10.',
    concepts: ['Extended ACL', 'Named ACLs', 'ICMP echo vs echo-reply', 'ip access-group in', 'Placement near the source'],
    hints: [
      'ip access-list extended NO-PING-SRV opens (config-ext-nacl)# mode.',
      'deny icmp 192.168.10.0 0.0.0.255 host 10.10.10.10 echo, then permit ip any any.',
      'interface g0/0.10, ip access-group NO-PING-SRV in.',
      'PC-A pinging SRV1 is refused; PC-A pinging PC-B and PC-B pinging SRV1 still work.',
    ],
    createState: () => aclCampus(),
    objectives: [
      { id: 'list', label: 'Create the named extended list', checks: [{ type: 'acl-exists', name: 'NO-PING-SRV', kind: 'extended' }] },
      { id: 'deny', label: 'Deny only Sales echo requests to SRV1', checks: [{ type: 'acl-entry', name: 'NO-PING-SRV', action: 'deny', protocol: 'icmp', src: '192.168.10.0 0.0.0.255', dst: 'host 10.10.10.10', icmpType: 'echo', position: 1, label: 'deny icmp 192.168.10.0 0.0.0.255 host 10.10.10.10 echo comes first' }] },
      { id: 'permit', label: 'Permit everything else', checks: [{ type: 'acl-entry', name: 'NO-PING-SRV', action: 'permit', protocol: 'ip', src: 'any', dst: 'any', label: 'permit ip any any' }] },
      { id: 'apply', label: 'Apply it inbound on g0/0.10', checks: [{ type: 'acl-applied', interface: 'g0/0.10', direction: 'in', name: 'NO-PING-SRV' }] },
      { id: 'prove', label: 'Prove the policy', checks: [{ type: 'ping', device: 'PC-A', target: '10.10.10.10', success: false, denied: true, label: 'PC-A cannot ping SRV1' }, { type: 'ping', device: 'PC-A', target: '192.168.20.10', success: true, label: 'PC-A still reaches PC-B' }, { type: 'ping', device: 'PC-B', target: '10.10.10.10', success: true, label: 'PC-B still reaches SRV1' }] },
    ],
  },
  {
    id: 'acl-03-implicit-deny',
    moduleId: MODULE,
    order: 3,
    title: 'Troubleshoot: Everyone Is Blocked',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'An ACL meant to block one thing blocked everything. Find the missing line.',
    scenario:
      'Last night someone added the access list SERVER-POLICY to R1 to stop HR from pinging SRV1. This morning HR cannot reach anything at all, not even Sales, and the helpdesk queue is on fire.\n\nInspect the list and how it is applied. Every access list ends with an invisible deny, so a list that only says what to block blocks everything else too. Fix it without weakening the intended rule.',
    concepts: ['Implicit deny', 'Reading show access-lists', 'Ordering', 'Minimal change'],
    hints: [
      'show access-lists: SERVER-POLICY has a single deny line. show ip interface g0/0.20 shows it applied inbound.',
      'Anything not matched by the deny hits the implicit deny at the end. HR traffic to Sales has nowhere to go.',
      'ip access-list extended SERVER-POLICY, then permit ip any any. The new line lands after the deny, which is exactly where it belongs.',
    ],
    createState: () => aclCampus({ acls: { 'SERVER-POLICY': { kind: 'extended', rules: ['deny icmp 192.168.20.0 0.0.0.255 host 10.10.10.10'] } }, interfaces: { 'g0/0.20': { aclIn: 'SERVER-POLICY' } } }),
    objectives: [
      { id: 'inspect', label: 'Inspect the access list', checks: [{ type: 'command', pattern: '^(do )?show (ip )?access-lists' }] },
      { id: 'fix', label: 'Add the missing permit', checks: [{ type: 'acl-entry', name: 'SERVER-POLICY', action: 'permit', protocol: 'ip', src: 'any', dst: 'any', position: 2, label: 'permit ip any any is the second entry' }] },
      { id: 'keep', label: 'Keep the intended rule', checks: [{ type: 'acl-entry', name: 'SERVER-POLICY', action: 'deny', protocol: 'icmp', src: '192.168.20.0 0.0.0.255', dst: 'host 10.10.10.10', position: 1, label: 'The deny for HR pings is still first' }, { type: 'acl-applied', interface: 'g0/0.20', direction: 'in', name: 'SERVER-POLICY' }] },
      { id: 'prove', label: 'Prove the fix', checks: [{ type: 'ping', device: 'PC-B', target: '192.168.10.10', success: true, label: 'PC-B reaches PC-A again' }, { type: 'ping', device: 'PC-B', target: '10.10.10.10', success: false, denied: true, label: 'PC-B still cannot ping SRV1' }] },
    ],
  },
  {
    id: 'acl-04-protect-vty',
    moduleId: MODULE,
    order: 4,
    title: 'Protect the VTY Lines',
    difficulty: 'Intermediate',
    estimatedMinutes: 6,
    description: 'Allow SSH to the router only from the admin PC with a standard ACL and access-class.',
    scenario:
      'R1 already accepts SSH with local logins. Security wants management access restricted so that only the admin workstation PC-A (192.168.10.10) can even open a session.\n\nCreate standard access-list 5 with a remark, permit only the admin PC, and apply it to the VTY lines with access-class. Confirm it in the running configuration.',
    concepts: ['access-class', 'host keyword', 'Remarks', 'Management plane protection'],
    hints: [
      'access-list 5 remark Admin PC only, then access-list 5 permit host 192.168.10.10.',
      'line vty 0 4, then access-class 5 in. Everyone else is caught by the implicit deny.',
      'show running-config shows access-class 5 in under the VTY lines.',
    ],
    createState: () => aclCampus(),
    objectives: [
      { id: 'list', label: 'Build access-list 5', checks: [{ type: 'acl-entry', name: '5', action: 'permit', src: 'host 192.168.10.10', label: 'access-list 5 permit host 192.168.10.10' }] },
      { id: 'apply', label: 'Apply it to the VTY lines', checks: [{ type: 'access-class', name: '5' }] },
      { id: 'verify', label: 'Verify in the running configuration', checks: [{ type: 'command', pattern: '^(do )?show running-config' }] },
    ],
  },
  {
    id: 'acl-05-exam-access-policy',
    moduleId: MODULE,
    order: 5,
    title: 'Exam: Access Policy',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    isExam: true,
    description: 'Implement a three-part security policy with standard and extended lists without breaking normal traffic.',
    scenario:
      'Implement the access policy for R1:\n\n1. HR (192.168.20.0/24) must not reach SRV1 (10.10.10.10) with any protocol. Everything else from HR stays allowed. Use a named extended list HR-POLICY applied inbound on g0/0.20.\n2. Sales (192.168.10.0/24) may reach SRV1 only for web (TCP port 80) and ping (ICMP); all other Sales traffic to SRV1 is denied, and all Sales traffic elsewhere is allowed. Use a named extended list SALES-POLICY applied inbound on g0/0.10.\n3. Only PC-A (192.168.10.10) may open management sessions: standard access-list 5 applied with access-class on the VTY lines.\n\nSave the configuration. Prove it: PC-B cannot ping SRV1 but can ping PC-A; PC-A can ping SRV1 and PC-B. No hints are available.',
    concepts: ['Synthesis', 'Standard and extended ACLs', 'Placement', 'Implicit deny'],
    hints: [],
    createState: () => aclCampus(),
    objectives: [
      { id: 'hr', label: 'HR policy', checks: [{ type: 'acl-entry', name: 'HR-POLICY', action: 'deny', protocol: 'ip', src: '192.168.20.0 0.0.0.255', dst: 'host 10.10.10.10', label: 'HR-POLICY denies ip 192.168.20.0/24 to host 10.10.10.10' }, { type: 'acl-entry', name: 'HR-POLICY', action: 'permit', protocol: 'ip', src: 'any', dst: 'any', label: 'HR-POLICY permits ip any any' }, { type: 'acl-applied', interface: 'g0/0.20', direction: 'in', name: 'HR-POLICY' }] },
      { id: 'sales', label: 'Sales policy', checks: [{ type: 'acl-entry', name: 'SALES-POLICY', action: 'permit', protocol: 'tcp', src: '192.168.10.0 0.0.0.255', dst: 'host 10.10.10.10', dstPort: 80, label: 'SALES-POLICY permits tcp to SRV1 eq 80' }, { type: 'acl-entry', name: 'SALES-POLICY', action: 'permit', protocol: 'icmp', src: '192.168.10.0 0.0.0.255', dst: 'host 10.10.10.10', label: 'SALES-POLICY permits icmp to SRV1' }, { type: 'acl-entry', name: 'SALES-POLICY', action: 'deny', protocol: 'ip', src: '192.168.10.0 0.0.0.255', dst: 'host 10.10.10.10', label: 'SALES-POLICY denies other ip to SRV1' }, { type: 'acl-entry', name: 'SALES-POLICY', action: 'permit', protocol: 'ip', src: 'any', dst: 'any', label: 'SALES-POLICY permits ip any any' }, { type: 'acl-applied', interface: 'g0/0.10', direction: 'in', name: 'SALES-POLICY' }] },
      { id: 'vty', label: 'Management access', checks: [{ type: 'acl-entry', name: '5', action: 'permit', src: 'host 192.168.10.10', label: 'access-list 5 permit host 192.168.10.10' }, { type: 'access-class', name: '5' }] },
      { id: 'prove', label: 'Prove the policy', checks: [{ type: 'ping', device: 'PC-B', target: '10.10.10.10', success: false, denied: true, label: 'PC-B cannot ping SRV1' }, { type: 'ping', device: 'PC-B', target: '192.168.10.10', success: true, label: 'PC-B can ping PC-A' }, { type: 'ping', device: 'PC-A', target: '10.10.10.10', success: true, label: 'PC-A can ping SRV1' }, { type: 'ping', device: 'PC-A', target: '192.168.20.10', success: true, label: 'PC-A can ping PC-B' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
];
