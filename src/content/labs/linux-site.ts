import { buildNetwork, createRouter, createSwitch, type LinuxSpec, type NetworkState } from '../../engine';

export const AUTH_LOG = [
  'Sep 11 08:40:11 web1 sshd[790]: Accepted publickey for student from 192.168.1.10 port 51234 ssh2',
  'Sep 11 08:41:02 web1 sshd[801]: Failed password for invalid user admin from 203.0.113.45 port 40122 ssh2',
  'Sep 11 08:41:05 web1 sshd[801]: Failed password for invalid user admin from 203.0.113.45 port 40122 ssh2',
  'Sep 11 08:41:09 web1 sshd[801]: Failed password for root from 203.0.113.45 port 40130 ssh2',
  'Sep 11 08:42:00 web1 sudo:  student : TTY=pts/0 ; PWD=/home/student ; USER=root ; COMMAND=/usr/bin/apt update',
  'Sep 11 08:45:17 web1 sshd[830]: Failed password for root from 198.51.100.7 port 33002 ssh2',
  'Sep 11 08:50:00 web1 sshd[844]: Accepted password for student from 192.168.1.10 port 51300 ssh2',
].join('\n') + '\n';

export const APP_LOG = ['2026-09-11 08:55:01 INFO  app started on port 8080', '2026-09-11 08:55:09 INFO  connected to database', '2026-09-11 08:57:44 ERROR disk full while writing /var/lib/app/cache', '2026-09-11 08:58:03 WARN  retrying write (attempt 2)', '2026-09-11 08:58:10 ERROR timeout talking to 192.168.2.50:5432', '2026-09-11 08:59:30 INFO  request /health 200'].join('\n') + '\n';

export const INTENT_JSON = JSON.stringify(
  {
    device: { hostname: 'Site2-R2', location: 'Branch 2 comms room' },
    interfaces: [
      { name: 'GigabitEthernet0/0', description: 'Site 2 LAN', enabled: true, ipv4: { ip: '192.168.2.1', netmask: '255.255.255.0' } },
      { name: 'GigabitEthernet0/1', description: 'Link to R1', enabled: true, ipv4: { ip: '10.0.0.2', netmask: '255.255.255.252' } },
    ],
    'static-routes': [{ prefix: '192.168.1.0', netmask: '255.255.255.0', 'next-hop': '10.0.0.1' }],
    ntp: { servers: ['192.168.1.50'] },
  },
  null,
  2,
) + '\n';

/**
 * web1 (Linux, 192.168.1.50) and PC-A (192.168.1.10) on R1 g0/0 192.168.1.1; R1 g0/1 10.0.0.1 --- R2 10.0.0.2 with SRV2 192.168.2.50 behind it.
 * R1 has RESTCONF enabled for the API labs.
 */
export function linuxSite(linux: LinuxSpec = {}, opts: { primary?: string } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'Site 1 LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
    overrides: { httpSecureServer: true, httpAuthLocal: true, restconf: true, users: [{ username: 'netops', password: 'Aut0mate!', secret: true, privilege: 15 }] },
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { description: 'Site 2 LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }],
  });
  const spec: LinuxSpec = {
    hostname: 'web1',
    ...linux,
    files: { '/var/log/auth.log': AUTH_LOG, '/var/log/app.log': APP_LOG, ...(linux.files ?? {}) },
  };
  const sw = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'web1' }, 'g0/2': { description: 'PC-A' }, 'g0/8': { description: 'Uplink to R1' } } });
  return buildNetwork({
    primary: opts.primary ?? 'web1',
    devices: [r1, r2, sw],
    hosts: [
      { id: 'web1', ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1', linux: spec },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'SRV2', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', kind: 'server' },
    ],
    links: [['web1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'SRV2']],
  });
}
