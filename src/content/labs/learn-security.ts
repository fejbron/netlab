import { buildNetwork, createRouter, createSwitch, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-security';

/**
 * PC-A, PC-B (DHCP clients) and SRV1 (static 192.168.10.50) in VLAN 10 on SW1.
 * SW1 g0/8 (access VLAN 10) --- R1 g0/0 192.168.10.1, DHCP pool SALES (.100 upwards).
 */
function branch(opts: { primary?: string; snooping?: { trustUplink?: boolean }; dai?: { trustUplink?: boolean; trustServer?: boolean }; leased?: boolean; hardened?: boolean } = {}): NetworkState {
  const sw = createSwitch({
    hostname: 'SW1',
    ports: 8,
    vlans: [{ id: 10, name: 'SALES' }],
    interfaces: {
      'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales PC' },
      'g0/2': { mode: 'access', accessVlan: 10, description: 'Sales PC' },
      'g0/3': { mode: 'access', accessVlan: 10, description: 'File server SRV1' },
      'g0/8': { mode: 'access', accessVlan: 10, description: 'Uplink to R1', dhcpSnoopingTrust: opts.snooping?.trustUplink || undefined, arpInspectionTrust: opts.dai?.trustUplink || undefined },
    },
    overrides: {
      dhcpSnooping: opts.snooping ? { enabled: true, vlans: [10], optionInsert: false } : undefined,
      arpInspectionVlans: opts.dai ? [10] : [],
    },
  });
  if (opts.dai?.trustServer) sw.interfaces['GigabitEthernet0/3'].arpInspectionTrust = true;
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'Sales LAN', ipAddress: '192.168.10.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to HQ', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    dhcp: { pools: [{ name: 'SALES', network: '192.168.10.0', mask: '255.255.255.0', defaultRouter: '192.168.10.1', dnsServer: '192.168.10.50' }], excluded: [['192.168.10.1', '192.168.10.99']] },
    overrides: {
      ...(opts.leased ? { dhcpBindings: [{ ip: '192.168.10.100', mac: '0011.22bb.0001', pool: 'SALES', hostId: 'PC-A' }, { ip: '192.168.10.101', mac: '0011.22bb.0002', pool: 'SALES', hostId: 'PC-B' }] } : {}),
      ...(opts.hardened ? { minPasswordLength: 10, enableSecret: 'Edge-R1-S3cret', servicePasswordEncryption: true } : {}),
    },
  });
  const net = buildNetwork({
    primary: opts.primary ?? 'SW1',
    devices: [sw, r1],
    hosts: [
      { id: 'PC-A', dhcp: true },
      { id: 'PC-B', dhcp: true },
      { id: 'SRV1', ip: '192.168.10.50', mask: '255.255.255.0', gateway: '192.168.10.1', kind: 'server' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['SRV1', 'SW1:g0/3'], ['SW1:g0/8', 'R1:g0/0']],
  });
  if (opts.leased) {
    Object.assign(net.hosts['PC-A'], { ip: '192.168.10.100', mask: '255.255.255.0', gateway: '192.168.10.1', dns: '192.168.10.50', dhcpServer: '192.168.10.1' });
    Object.assign(net.hosts['PC-B'], { ip: '192.168.10.101', mask: '255.255.255.0', gateway: '192.168.10.1', dns: '192.168.10.50', dhcpServer: '192.168.10.1' });
  }
  return net;
}

export const learnSecurityLabs: Lab[] = [
  {
    id: 'ns-01-password-policy',
    moduleId: MODULE,
    order: 1,
    title: 'Password Policy',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Enforce a minimum password length, slow down brute-force logins, and time out idle sessions on R1.',
    scenario:
      'A security audit flagged the branch router R1: the enable secret is short, there is no protection against password guessing, and console sessions never time out.\n\nOn R1, require passwords of at least 10 characters, then try to set enable secret cisco and watch IOS reject it. Set a compliant enable secret, block logins for 120 seconds after 3 failures within 60 seconds, set a 5-minute exec-timeout on the console and the VTY lines, encrypt the plain-text passwords, and confirm the login policy with show login.',
    concepts: ['security passwords min-length', 'login block-for', 'exec-timeout', 'service password-encryption', 'show login'],
    hints: [
      'security passwords min-length 10 in global configuration. From then on, enable secret cisco is refused with "% Password too short".',
      'login block-for 120 attempts 3 within 60.',
      'line console 0 then exec-timeout 5 0; the same under line vty 0 4.',
      'service password-encryption, then show login from privileged mode.',
    ],
    createState: () => branch({ primary: 'R1' }),
    objectives: [
      { id: 'minlen', label: 'Require passwords of at least 10 characters', checks: [{ type: 'password-policy', minLength: 10 }] },
      { id: 'reject', label: 'See the policy reject a short secret', checks: [{ type: 'command', pattern: '^enable secret \\S{1,9}$', label: 'Try enable secret with fewer than 10 characters' }] },
      { id: 'secret', label: 'Set a compliant enable secret', checks: [{ type: 'enable-secret', minLength: 10, label: 'Enable secret with 10 or more characters' }] },
      { id: 'block', label: 'Block password guessing', checks: [{ type: 'password-policy', loginBlock: true, maxAttempts: 3, label: 'login block-for ... attempts 3 within ...' }] },
      { id: 'timeout', label: 'Time out idle sessions after 5 minutes', checks: [{ type: 'exec-timeout', line: 'con', maxMinutes: 5 }, { type: 'exec-timeout', line: 'vty', maxMinutes: 5 }] },
      { id: 'encrypt', label: 'Encrypt plain-text passwords', checks: [{ type: 'password-encryption' }] },
      { id: 'verify', label: 'Verify the login policy', checks: [{ type: 'command', pattern: '^(do )?show login$' }] },
    ],
  },
  {
    id: 'ns-02-aaa-local',
    moduleId: MODULE,
    order: 2,
    title: 'AAA With the Local Database',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Switch R1 to the AAA model, authenticate logins against local users, and allow SSH only.',
    scenario:
      'Head office wants every device to use AAA so that a RADIUS server can be added later. Until then, R1 must authenticate administrators against its local user database.\n\nR1 already enforces a 10-character minimum and its enable secret is Edge-R1-S3cret. Enable aaa new-model, make the default login method the local database, create the administrator netops (privilege 15) with a compliant secret, prepare SSH (domain lab.local, 2048-bit RSA keys, SSH version 2), restrict the VTY lines to SSH, and save.',
    concepts: ['aaa new-model', 'aaa authentication login default local', 'Authentication vs authorization vs accounting', 'SSH-only management'],
    hints: [
      'aaa new-model first; without it, aaa authentication is refused.',
      'aaa authentication login default local. With AAA on, login local under the lines is no longer needed.',
      'username netops privilege 15 secret <10+ characters>, then ip domain-name lab.local, crypto key generate rsa modulus 2048, ip ssh version 2.',
      'line vty 0 4, transport input ssh, end, write memory.',
    ],
    createState: () => branch({ primary: 'R1', hardened: true }),
    objectives: [
      { id: 'aaa', label: 'Enable AAA with local login authentication', checks: [{ type: 'aaa', newModel: true, loginLocal: true }] },
      { id: 'user', label: 'Create the netops administrator', checks: [{ type: 'user', username: 'netops', privilege: 15, secret: true }] },
      { id: 'ssh', label: 'Prepare SSH', checks: [{ type: 'domain-name', equals: 'lab.local' }, { type: 'ssh-ready' }] },
      { id: 'vty', label: 'Allow SSH only on the VTY lines', checks: [{ type: 'line', line: 'vty', transportInput: 'ssh' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
  {
    id: 'ns-03-dhcp-snooping',
    moduleId: MODULE,
    order: 3,
    title: 'Trust Only the Real DHCP Server',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Enable DHCP snooping on the access switch, watch it drop the real server too, then trust the uplink.',
    scenario:
      'Someone plugged a home router into the Sales VLAN last month and handed out bogus addresses for an afternoon. DHCP snooping on SW1 will stop that: server messages are only accepted on trusted ports.\n\nOn PC-A, renew the lease to see that DHCP works today. On SW1, enable DHCP snooping globally and for VLAN 10, and turn off option 82 insertion (R1 drops relayed requests that carry it). Renew PC-A again: the lease fails, because the port that faces R1 is untrusted like every other port. Trust g0/8, renew once more, then read show ip dhcp snooping and show ip dhcp snooping binding.',
    concepts: ['ip dhcp snooping', 'Trusted vs untrusted ports', 'Option 82', 'show ip dhcp snooping binding', 'Rogue DHCP servers'],
    hints: [
      'PC-A: ipconfig /renew works before you start. Then on SW1: ip dhcp snooping, ip dhcp snooping vlan 10, no ip dhcp snooping information option.',
      'Renew PC-A again: "unable to contact your DHCP server". The OFFER from R1 arrives on g0/8, which snooping treats as untrusted.',
      'interface g0/8, ip dhcp snooping trust. Then PC-A: ipconfig /renew succeeds.',
      'show ip dhcp snooping lists the trusted interface; show ip dhcp snooping binding shows the lease PC-A obtained through the switch.',
    ],
    createState: () => branch(),
    objectives: [
      { id: 'before', label: 'Confirm DHCP works before snooping', checks: [{ type: 'command', device: 'PC-A', pattern: '^ipconfig /renew$', label: 'PC-A ran ipconfig /renew' }] },
      { id: 'snoop', label: 'Enable DHCP snooping for VLAN 10 without option 82', checks: [{ type: 'dhcp-snooping', enabled: true, vlans: [10], optionInsert: false }] },
      { id: 'trust', label: 'Trust the uplink to R1', checks: [{ type: 'port-trust', interface: 'g0/8', dhcpSnooping: true }] },
      { id: 'lease', label: 'PC-A obtains a lease through the snooping switch', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, inSubnet: { network: '192.168.10.0', mask: '255.255.255.0' }, label: 'PC-A holds a DHCP address in 192.168.10.0/24' }] },
      { id: 'verify', label: 'Read the snooping state and bindings', checks: [{ type: 'command', pattern: '^(do )?show ip dhcp snooping$' }, { type: 'command', pattern: '^(do )?show ip dhcp snooping binding$' }] },
    ],
  },
  {
    id: 'ns-04-dynamic-arp-inspection',
    moduleId: MODULE,
    order: 4,
    title: 'Dynamic ARP Inspection',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Validate ARP against the snooping bindings so nobody can poison the Sales VLAN.',
    scenario:
      'DHCP snooping is in place on SW1 and both Sales PCs hold leases. The next step is dynamic ARP inspection (DAI): on untrusted ports the switch drops ARP whose sender does not match a snooping binding, which defeats ARP spoofing.\n\nEnable ARP inspection for VLAN 10, trust the uplink g0/8 (R1 never obtained its address by DHCP, so its ARP would fail validation), prove that PC-A can still reach its gateway, and read the inspection state with show ip arp inspection vlan 10 and show ip arp inspection interfaces.',
    concepts: ['ip arp inspection vlan', 'ip arp inspection trust', 'ARP spoofing', 'Snooping bindings as the source of truth'],
    hints: [
      'ip arp inspection vlan 10 in global configuration.',
      'interface g0/8, ip arp inspection trust. Uplinks and server ports with static addresses must be trusted.',
      'PC-A: ping 192.168.10.1 still works because its lease is in the snooping table.',
      'show ip arp inspection vlan 10 and show ip arp inspection interfaces.',
    ],
    createState: () => branch({ snooping: { trustUplink: true }, leased: true }),
    objectives: [
      { id: 'dai', label: 'Enable ARP inspection on VLAN 10', checks: [{ type: 'arp-inspection', vlans: [10] }] },
      { id: 'trust', label: 'Trust the uplink to R1', checks: [{ type: 'port-trust', interface: 'g0/8', arpInspection: true }] },
      { id: 'ping', label: 'PC-A still reaches its gateway', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.1', success: true }] },
      { id: 'verify', label: 'Read the inspection state', checks: [{ type: 'command', pattern: '^(do )?show ip arp inspection vlan 10$' }, { type: 'command', pattern: '^(do )?show ip arp inspection interfaces$' }] },
    ],
  },
  {
    id: 'ns-05-dai-static-server',
    moduleId: MODULE,
    order: 5,
    title: 'Troubleshoot: The Server DAI Silenced',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'After ARP inspection went live the file server vanished from the network. Find out why and fix only what is needed.',
    scenario:
      'ARP inspection was switched on for VLAN 10 last night. This morning the Sales PCs work, but nobody can reach the file server SRV1 and SRV1 cannot even ping its gateway.\n\nStart on SRV1 with a ping to 192.168.10.1 to see the failure. Think about what DAI checks on an untrusted port and where SRV1 got its address. Fix it on SW1 with the smallest possible change, keep inspection enabled, and prove that both SRV1 and PC-A reach the gateway.',
    concepts: ['Static hosts on DAI VLANs', 'ip arp inspection trust', 'ARP ACLs as the alternative', 'Smallest change that fixes the fault'],
    hints: [
      'SRV1: ping 192.168.10.1 fails; PC-A: ping 192.168.10.1 works. The difference: PC-A has a DHCP snooping binding, SRV1 has a static address.',
      'show ip arp inspection interfaces on SW1: g0/3 is untrusted, so ARP from SRV1 is compared with the binding table and dropped.',
      'interface g0/3, ip arp inspection trust. (An ARP access-list would be the stricter alternative.) Do not disable inspection.',
    ],
    createState: () => branch({ snooping: { trustUplink: true }, dai: { trustUplink: true }, leased: true }),
    objectives: [
      { id: 'fail', label: 'See the failure from SRV1', checks: [{ type: 'ping', device: 'SRV1', target: '192.168.10.1', success: false, label: 'SRV1 pinged 192.168.10.1 and it failed' }] },
      { id: 'inspect', label: 'Inspect the port trust state', checks: [{ type: 'command', pattern: '^(do )?show ip arp inspection( interfaces| vlan 10)?$', label: 'Run show ip arp inspection on SW1' }] },
      { id: 'trust', label: 'Trust the server port only', checks: [{ type: 'port-trust', interface: 'g0/3', arpInspection: true }, { type: 'port-trust', interface: 'g0/1', arpInspection: false, label: 'g0/1 stays untrusted' }, { type: 'arp-inspection', vlans: [10], label: 'ARP inspection stays enabled on VLAN 10' }] },
      { id: 'works', label: 'SRV1 and PC-A reach the gateway', checks: [{ type: 'ping', device: 'SRV1', target: '192.168.10.1', success: true }, { type: 'ping', device: 'PC-A', target: '192.168.10.1', success: true }] },
    ],
  },
  {
    id: 'ns-06-exam-harden-the-branch',
    moduleId: MODULE,
    order: 6,
    title: 'Exam: Harden the Branch',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Apply the complete security baseline to a branch router and its access switch without breaking the users.',
    scenario:
      'The branch failed its audit. Bring R1 and SW1 up to the security baseline.\n\nR1: passwords of at least 10 characters, an enable secret, login blocking (120 seconds after 3 failures within 60), AAA with the local database as the default login method, administrator netops (privilege 15), SSH version 2 with domain lab.local, VTY lines limited to SSH and to the management server 192.168.10.50 (standard ACL 5 with access-class), a 5-minute exec-timeout on console and VTY, and password encryption. Save.\n\nSW1: DHCP snooping for VLAN 10 with the uplink g0/8 trusted and option 82 off, ARP inspection for VLAN 10 with g0/8 and the server port g0/3 trusted, and port security with one sticky address on g0/1 and g0/2.\n\nProve it works: PC-A renews its lease and pings SRV1, and SRV1 pings the gateway. Save both devices last, so the sticky addresses the switch learned during the tests are in the startup configuration.',
    concepts: ['Synthesis', 'Password policy', 'AAA', 'Management-plane protection', 'DHCP snooping and DAI', 'Port security'],
    hints: [],
    isExam: true,
    createState: () => branch({ primary: 'R1' }),
    objectives: [
      { id: 'policy', label: 'R1: password policy and login blocking', checks: [{ type: 'password-policy', minLength: 10, loginBlock: true, maxAttempts: 3 }, { type: 'enable-secret', minLength: 10 }, { type: 'password-encryption' }] },
      { id: 'aaa', label: 'R1: AAA with local authentication and the netops user', checks: [{ type: 'aaa', newModel: true, loginLocal: true }, { type: 'user', username: 'netops', privilege: 15, secret: true }] },
      { id: 'ssh', label: 'R1: SSH-only management from the management server', checks: [{ type: 'domain-name', equals: 'lab.local' }, { type: 'ssh-ready' }, { type: 'line', line: 'vty', transportInput: 'ssh' }, { type: 'acl-entry', name: '5', action: 'permit', src: 'host 192.168.10.50', label: 'ACL 5 permits host 192.168.10.50' }, { type: 'access-class', name: '5' }] },
      { id: 'timeout', label: 'R1: 5-minute exec-timeout on console and VTY', checks: [{ type: 'exec-timeout', line: 'con', maxMinutes: 5 }, { type: 'exec-timeout', line: 'vty', maxMinutes: 5 }] },
      { id: 'snooping', label: 'SW1: DHCP snooping with a trusted uplink', checks: [{ type: 'dhcp-snooping', device: 'SW1', enabled: true, vlans: [10], optionInsert: false }, { type: 'port-trust', device: 'SW1', interface: 'g0/8', dhcpSnooping: true }] },
      { id: 'dai', label: 'SW1: ARP inspection with trusted uplink and server port', checks: [{ type: 'arp-inspection', device: 'SW1', vlans: [10] }, { type: 'port-trust', device: 'SW1', interface: 'g0/8', arpInspection: true }, { type: 'port-trust', device: 'SW1', interface: 'g0/3', arpInspection: true }] },
      { id: 'portsec', label: 'SW1: sticky port security on the PC ports', checks: [{ type: 'port-security', device: 'SW1', interface: 'g0/1', enabled: true, maximum: 1, sticky: true }, { type: 'port-security', device: 'SW1', interface: 'g0/2', enabled: true, maximum: 1, sticky: true }] },
      { id: 'works', label: 'The users still work', checks: [{ type: 'host-config', device: 'PC-A', viaDhcp: true, inSubnet: { network: '192.168.10.0', mask: '255.255.255.0' }, label: 'PC-A holds a DHCP lease' }, { type: 'ping', device: 'PC-A', target: '192.168.10.50', success: true }, { type: 'ping', device: 'SRV1', target: '192.168.10.1', success: true }] },
      { id: 'save', label: 'Save both devices', checks: [{ type: 'saved', label: 'R1 saved' }, { type: 'saved', device: 'SW1', label: 'SW1 saved' }] },
    ],
  },
];
