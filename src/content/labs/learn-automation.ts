import { buildNetwork, createRouter, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-automation';

const NETOPS_USER = { username: 'netops', password: 'Aut0mate!', secret: true, privilege: 15 };

/**
 * PC-A 192.168.1.10 - R1 g0/0 192.168.1.1 | R1 g0/1 10.0.0.1 --- 10.0.0.2 R2 g0/1 | R2 g0/0 192.168.2.1 - SRV1 192.168.2.50 (NetOps collector)
 * Optional guest LAN: PC-B 192.168.3.10 - R1 g0/2 192.168.3.1.
 */
function site(opts: { primary?: string; api?: boolean; wanDown?: boolean; guest?: boolean; r2Blank?: boolean } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    ports: opts.guest ? 3 : 2,
    interfaces: {
      'g0/0': { description: 'LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false },
      'g0/1': { description: 'WAN to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: Boolean(opts.wanDown) },
      ...(opts.guest ? { 'g0/2': { description: 'Guest LAN', ipAddress: '192.168.3.1', subnetMask: '255.255.255.0', shutdown: false } } : {}),
    },
    staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
    overrides: opts.api ? { httpSecureServer: true, httpAuthLocal: true, restconf: true, netconfYang: true, ipDomainName: 'lab.local', rsaKeyBits: 2048, sshVersion: 2, users: [NETOPS_USER] } : undefined,
  });
  const r2 = opts.r2Blank
    ? createRouter({ id: 'R2', hostname: 'Router' })
    : createRouter({
        hostname: 'R2',
        interfaces: { 'g0/0': { description: 'Site 2 LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
        staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }, ...(opts.guest ? [{ destination: '192.168.3.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }] : [])],
      });
  return buildNetwork({
    primary: opts.primary ?? 'R1',
    devices: [r1, r2],
    hosts: [
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      ...(opts.guest ? [{ id: 'PC-B', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' }] : []),
      { id: 'SRV1', name: 'SRV1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', kind: 'server' as const },
    ],
    links: [['PC-A', 'R1:g0/0'], ...(opts.guest ? [['PC-B', 'R1:g0/2'] as [string, string]] : []), ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'SRV1']],
  });
}

const IF_PATH = 'ietf-interfaces:interfaces/interface=GigabitEthernet0(%2F|/)';

export const learnAutomationLabs: Lab[] = [
  {
    id: 'au-01-enable-the-api',
    moduleId: MODULE,
    order: 1,
    title: 'Turn On the Programmable Interfaces',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Enable RESTCONF and NETCONF on R1 with a local API user, then read the router as JSON from a PC.',
    scenario:
      'The NetOps team is rolling out automation. Their tooling talks RESTCONF (HTTPS plus JSON) and NETCONF (over SSH), and neither is enabled on R1 yet. Try it from PC-A first:\n\ncurl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces\n\nThe connection is refused. On R1, create the user netops (privilege 15, secret Aut0mate!), enable the HTTPS server with local authentication, turn on restconf, prepare SSH (domain lab.local, 2048-bit RSA keys) and turn on netconf-yang. Check the daemons with show platform software yang-management process, then repeat the curl: R1 answers with the interface list in JSON. Notice what -k and -u do.',
    concepts: ['RESTCONF and NETCONF', 'ip http secure-server', 'ip http authentication local', 'curl -k -u', 'Model-driven programmability'],
    hints: [
      'username netops privilege 15 secret Aut0mate!, ip http secure-server, ip http authentication local, restconf.',
      'NETCONF runs over SSH: ip domain-name lab.local, crypto key generate rsa modulus 2048, then netconf-yang.',
      'show platform software yang-management process shows nginx (RESTCONF) and ncsshd (NETCONF) Running.',
      'PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces. -k accepts the self-signed certificate, -u sends the credentials.',
    ],
    createState: () => site(),
    objectives: [
      { id: 'refused', label: 'See the API refuse before it is enabled', checks: [{ type: 'command', device: 'PC-A', pattern: '^curl ', label: 'PC-A ran curl' }] },
      { id: 'user', label: 'Create the API user', checks: [{ type: 'user', username: 'netops', privilege: 15, secret: true }] },
      { id: 'restconf', label: 'Enable HTTPS with local authentication and RESTCONF', checks: [{ type: 'management-api', httpsServer: true, httpAuthLocal: true, restconf: true }] },
      { id: 'netconf', label: 'Enable NETCONF over SSH', checks: [{ type: 'ssh-ready' }, { type: 'management-api', netconf: true }] },
      { id: 'processes', label: 'Check the programmability processes', checks: [{ type: 'command', pattern: '^(do )?show platform software yang-management process$' }] },
      { id: 'get', label: 'Read the interfaces as JSON from PC-A', checks: [{ type: 'api-request', method: 'GET', path: 'ietf-interfaces:interfaces/?$', status: 200, label: 'R1 answered GET .../ietf-interfaces:interfaces with 200 OK' }] },
    ],
  },
  {
    id: 'au-02-read-the-device-as-json',
    moduleId: MODULE,
    order: 2,
    title: 'Read the Device as JSON',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Use the API to find out why the WAN is down, then fix it from the CLI.',
    scenario:
      'The monitoring dashboard says Site 2 is unreachable from R1. Instead of logging into R1, investigate through its API from PC-A.\n\nGET a single interface: append /interface=GigabitEthernet0%2F1 to the interfaces path (%2F is an escaped slash). Read the JSON: "enabled": false means the interface is administratively shut down. Also GET the hostname from Cisco-IOS-XE-native:native/hostname to see how a native model differs from the standard IETF one. Then bring the interface up on R1 and prove R1 can ping R2 at 10.0.0.2.',
    concepts: ['Reading JSON objects, keys and booleans', 'URL encoding (%2F)', 'IETF vs native YANG models', 'Operational data'],
    hints: [
      'PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1',
      'PC-A: curl -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname',
      'On R1: interface g0/1, no shutdown, then ping 10.0.0.2.',
    ],
    createState: () => site({ api: true, wanDown: true }),
    objectives: [
      { id: 'get-if', label: 'GET GigabitEthernet0/1 through the API', checks: [{ type: 'api-request', method: 'GET', path: `${IF_PATH}1`, status: 200, label: 'R1 answered GET .../interface=GigabitEthernet0%2F1 with 200 OK' }] },
      { id: 'get-host', label: 'GET the hostname from the native model', checks: [{ type: 'api-request', method: 'GET', path: 'Cisco-IOS-XE-native:native/hostname', status: 200, label: 'R1 answered GET .../Cisco-IOS-XE-native:native/hostname with 200 OK' }] },
      { id: 'fix', label: 'Bring the WAN interface up', checks: [{ type: 'interface', name: 'g0/1', shutdown: false }] },
      { id: 'ping', label: 'R1 reaches R2', checks: [{ type: 'ping', target: '10.0.0.2', success: true }] },
    ],
  },
  {
    id: 'au-03-configure-through-the-api',
    moduleId: MODULE,
    order: 3,
    title: 'Configure Through the API',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Change an interface description and the hostname with PATCH requests instead of the CLI.',
    scenario:
      'The automation pipeline will push changes as JSON. Do one by hand from PC-A so you understand what it sends.\n\nPATCH the description of GigabitEthernet0/0 to "Sales LAN" with a body of {"ietf-interfaces:interface": {"name": "GigabitEthernet0/0", "description": "Sales LAN"}} and the header Content-Type: application/yang-data+json. Use -i so you can see the 204 No Content status that a successful write returns. Then PATCH Cisco-IOS-XE-native:native/hostname with {"Cisco-IOS-XE-native:hostname": "Branch-R1"}. Finally confirm both changes on the router with show running-config.',
    concepts: ['HTTP verbs: GET, PATCH, PUT', 'Content-Type: application/yang-data+json', '204 No Content', 'CRUD through RESTCONF'],
    hints: [
      "PC-A: curl -k -i -u netops:Aut0mate! -X PATCH -H 'Content-Type: application/yang-data+json' -d '{\"ietf-interfaces:interface\": {\"name\": \"GigabitEthernet0/0\", \"description\": \"Sales LAN\"}}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0",
      "PC-A: curl -k -i -u netops:Aut0mate! -X PATCH -H 'Content-Type: application/yang-data+json' -d '{\"Cisco-IOS-XE-native:hostname\": \"Branch-R1\"}' https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname",
      'A 400 Bad Request means the JSON body is malformed; check the quotes and braces. On the router: enable, show running-config.',
    ],
    createState: () => site({ api: true }),
    objectives: [
      { id: 'patch-if', label: 'PATCH the description of GigabitEthernet0/0', checks: [{ type: 'api-request', method: 'PATCH', path: `${IF_PATH}0`, status: 204, label: 'R1 answered PATCH .../interface=GigabitEthernet0%2F0 with 204 No Content' }, { type: 'interface', name: 'g0/0', description: 'Sales LAN', label: 'g0/0 is described as Sales LAN' }] },
      { id: 'patch-host', label: 'PATCH the hostname', checks: [{ type: 'api-request', method: 'PATCH', path: 'Cisco-IOS-XE-native:native/hostname', status: 204, label: 'R1 answered PATCH .../Cisco-IOS-XE-native:native/hostname with 204 No Content' }, { type: 'hostname', equals: 'Branch-R1' }] },
      { id: 'verify', label: 'Confirm on the router', checks: [{ type: 'command', pattern: '^(do )?show running-config$' }] },
    ],
  },
  {
    id: 'au-04-deploy-from-a-json-intent',
    moduleId: MODULE,
    order: 4,
    title: 'Deploy From a JSON Intent',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Turn a JSON description of the desired state into a working router configuration.',
    scenario:
      'Site 2 has a new router that the automation pipeline cannot reach yet, so you must apply its intent file by hand. The file describes the desired state:\n\n{\n  "device": { "hostname": "Site2-R2" },\n  "interfaces": [\n    { "name": "GigabitEthernet0/0", "description": "Site 2 LAN", "enabled": true, "ipv4": { "ip": "192.168.2.1", "netmask": "255.255.255.0" } },\n    { "name": "GigabitEthernet0/1", "description": "Link to R1", "enabled": true, "ipv4": { "ip": "10.0.0.2", "netmask": "255.255.255.252" } }\n  ],\n  "static-routes": [ { "prefix": "192.168.1.0", "netmask": "255.255.255.0", "next-hop": "10.0.0.1" } ],\n  "ntp": { "servers": [ "192.168.2.50" ] }\n}\n\nConfigure the router (console: Router) to match every key, then prove SRV1 can reach PC-A at 192.168.1.10.',
    concepts: ['JSON objects, arrays and key/value pairs', 'Intent-based configuration', 'Source of truth', 'Verification after deployment'],
    hints: [
      'hostname Site2-R2. Each object in "interfaces" is one interface: description, ip address, no shutdown.',
      '"static-routes" becomes ip route 192.168.1.0 255.255.255.0 10.0.0.1; "ntp" becomes ntp server 192.168.2.50.',
      'SRV1: ping 192.168.1.10. R1 already has a route back to 192.168.2.0/24.',
    ],
    createState: () => site({ primary: 'R2', r2Blank: true }),
    objectives: [
      { id: 'hostname', label: 'Hostname from "device"', checks: [{ type: 'hostname', equals: 'Site2-R2' }] },
      { id: 'lan', label: 'GigabitEthernet0/0 from "interfaces"', checks: [{ type: 'interface', name: 'g0/0', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false, description: 'Site 2 LAN' }] },
      { id: 'wan', label: 'GigabitEthernet0/1 from "interfaces"', checks: [{ type: 'interface', name: 'g0/1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false, description: 'Link to R1' }] },
      { id: 'route', label: 'Static route from "static-routes"', checks: [{ type: 'route', destination: '192.168.1.0', mask: '255.255.255.0', via: '10.0.0.1' }] },
      { id: 'ntp', label: 'NTP server from "ntp"', checks: [{ type: 'ntp-server', address: '192.168.2.50' }] },
      { id: 'ping', label: 'SRV1 reaches PC-A', checks: [{ type: 'ping', device: 'SRV1', target: '192.168.1.10', success: true }] },
    ],
  },
  {
    id: 'au-05-telemetry-for-the-assistant',
    moduleId: MODULE,
    order: 5,
    title: 'Feed the Assistant Telemetry',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Point syslog, SNMP and NTP at the NetOps collector so AI-assisted operations have accurate, time-aligned data.',
    scenario:
      'The NetOps platform uses an AI assistant to correlate events across the network. It is only as good as the telemetry it receives, and today R1 sends nothing. Its collector is SRV1 at 192.168.2.50.\n\nOn R1: send syslog messages of level informational and above to the collector, allow read-only SNMP polling with the community NetOps-RO, describe the device with an SNMP location and contact, and synchronise the clock from the collector with NTP so that every log line carries a timestamp the assistant can align. Check the result with show logging and show ntp status.',
    concepts: ['logging host / logging trap', 'Syslog severity levels', 'snmp-server community RO', 'ntp server', 'Why telemetry needs a common clock'],
    hints: [
      'logging host 192.168.2.50 and logging trap informational (level 6).',
      'snmp-server community NetOps-RO ro, snmp-server location Branch 1 comms room, snmp-server contact netops@example.com.',
      'ntp server 192.168.2.50, then show ntp status reports the clock as synchronized once the server is reachable.',
    ],
    createState: () => site({ api: true }),
    objectives: [
      { id: 'syslog', label: 'Send informational syslog to the collector', checks: [{ type: 'syslog', host: '192.168.2.50', trap: 'informational' }] },
      { id: 'snmp', label: 'Allow read-only SNMP with NetOps-RO', checks: [{ type: 'snmp-community', name: 'NetOps-RO', mode: 'ro' }] },
      { id: 'describe', label: 'Set an SNMP location and contact', checks: [{ type: 'command', pattern: '^snmp-server location ', label: 'snmp-server location ...' }, { type: 'command', pattern: '^snmp-server contact ', label: 'snmp-server contact ...' }] },
      { id: 'ntp', label: 'Synchronise time from the collector', checks: [{ type: 'ntp-server', address: '192.168.2.50' }] },
      { id: 'verify', label: 'Verify logging and NTP', checks: [{ type: 'command', pattern: '^(do )?show logging$' }, { type: 'command', pattern: '^(do )?show ntp status$' }] },
    ],
  },
  {
    id: 'au-06-review-the-ai-change',
    moduleId: MODULE,
    order: 6,
    title: "Review the AI Assistant's Change",
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'An AI assistant proposed an access-list change. Verify it before you trust it, fix what is wrong, and prove the outcome.',
    scenario:
      'A ticket asks that the guest LAN (192.168.3.0/24, PC-B) must no longer reach the NetOps server SRV1 at 192.168.2.50, while everything else stays as it is. The NetOps AI assistant proposed this change for R1:\n\nip access-list extended GUEST-POLICY\n deny ip 192.168.3.0 0.0.0.255 host 192.168.2.50\ninterface GigabitEthernet0/1\n ip access-group GUEST-POLICY in\n\nDo not apply it as written. First record the current state: ping SRV1 from PC-B and from PC-A. Then review the proposal: what does the implicit deny at the end of the list do, and is the WAN interface the right place for a guest policy? Apply a corrected version on the guest interface, then prove that PC-B can no longer reach SRV1, that PC-A still can, and that PC-B still reaches R2 at 10.0.0.2.',
    concepts: ['AI-assisted operations need human verification', 'Implicit deny', 'ACL placement', 'Verify before and after a change'],
    hints: [
      'Before changing anything: PC-B: ping 192.168.2.50 and PC-A: ping 192.168.2.50 both succeed today.',
      'The proposal has no permit ip any any, so the implicit deny would drop all other guest traffic. Add permit ip any any after the deny.',
      'The guest LAN enters R1 on g0/2, not on the WAN g0/1. Apply the list with ip access-group GUEST-POLICY in under interface g0/2 and leave g0/1 alone.',
      'After: PC-B: ping 192.168.2.50 is unreachable, PC-A: ping 192.168.2.50 works, PC-B: ping 10.0.0.2 works.',
    ],
    createState: () => site({ api: true, guest: true }),
    objectives: [
      { id: 'before', label: 'Record the state before the change', checks: [{ type: 'ping', device: 'PC-B', target: '192.168.2.50', success: true, label: 'PC-B reached SRV1 before the change' }, { type: 'ping', device: 'PC-A', target: '192.168.2.50', success: true, label: 'PC-A reached SRV1 before the change' }] },
      { id: 'acl', label: 'Build the corrected access list', checks: [{ type: 'acl-entry', name: 'GUEST-POLICY', action: 'deny', protocol: 'ip', src: '192.168.3.0 0.0.0.255', dst: 'host 192.168.2.50', position: 1, label: 'deny ip 192.168.3.0 0.0.0.255 host 192.168.2.50 first' }, { type: 'acl-entry', name: 'GUEST-POLICY', action: 'permit', protocol: 'ip', src: 'any', dst: 'any', label: 'permit ip any any after it' }] },
      { id: 'apply', label: 'Apply it on the guest interface only', checks: [{ type: 'acl-applied', interface: 'g0/2', direction: 'in', name: 'GUEST-POLICY' }, { type: 'acl-not-applied', interface: 'g0/1', direction: 'in', label: 'Nothing applied inbound on the WAN g0/1' }] },
      { id: 'after', label: 'Prove the outcome', checks: [{ type: 'ping', device: 'PC-B', target: '192.168.2.50', denied: true, label: 'PC-B is now denied to SRV1' }, { type: 'ping', device: 'PC-A', target: '192.168.2.50', success: true, label: 'PC-A still reaches SRV1' }, { type: 'ping', device: 'PC-B', target: '10.0.0.2', success: true, label: 'PC-B still reaches R2' }] },
    ],
  },
  {
    id: 'au-07-exam-automation-ready-branch',
    moduleId: MODULE,
    order: 7,
    title: 'Exam: Automation-Ready Branch',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Make R1 manageable by the NetOps platform: APIs, telemetry, and a change pushed through RESTCONF.',
    scenario:
      'A new branch router must be onboarded to the NetOps platform before it is shipped.\n\nOn R1: create the API user netops (privilege 15, secret Aut0mate!), enable HTTPS with local authentication and RESTCONF, prepare SSH (domain lab.local, 2048-bit keys, version 2) and enable NETCONF, send informational syslog to 192.168.2.50, allow read-only SNMP with community NetOps-RO, and use 192.168.2.50 as the NTP server.\n\nFrom PC-A: read the interface list through the API, then PATCH the description of GigabitEthernet0/0 to "Sales LAN" and confirm the 204 status. Finally confirm the description on R1 and save: a change made through the API lands in the running configuration exactly like one typed at the console.',
    concepts: ['Synthesis', 'RESTCONF and NETCONF', 'Telemetry', 'API-driven change', 'Verification'],
    hints: [],
    isExam: true,
    createState: () => site(),
    objectives: [
      { id: 'user', label: 'API user netops', checks: [{ type: 'user', username: 'netops', privilege: 15, secret: true }] },
      { id: 'api', label: 'RESTCONF over HTTPS with local authentication, NETCONF over SSH', checks: [{ type: 'management-api', httpsServer: true, httpAuthLocal: true, restconf: true, netconf: true }, { type: 'ssh-ready' }] },
      { id: 'telemetry', label: 'Syslog, SNMP and NTP to the collector', checks: [{ type: 'syslog', host: '192.168.2.50', trap: 'informational' }, { type: 'snmp-community', name: 'NetOps-RO', mode: 'ro' }, { type: 'ntp-server', address: '192.168.2.50' }] },
      { id: 'get', label: 'Read the interfaces through the API', checks: [{ type: 'api-request', method: 'GET', path: 'ietf-interfaces:interfaces/?$', status: 200, label: 'R1 answered GET .../ietf-interfaces:interfaces with 200 OK' }] },
      { id: 'patch', label: 'Change the description through the API', checks: [{ type: 'api-request', method: 'PATCH', path: `${IF_PATH}0`, status: 204, label: 'R1 answered PATCH .../interface=GigabitEthernet0%2F0 with 204 No Content' }, { type: 'interface', name: 'g0/0', description: 'Sales LAN', label: 'g0/0 is described as Sales LAN' }] },
      { id: 'save', label: 'Save the configuration', checks: [{ type: 'saved' }] },
    ],
  },
];
