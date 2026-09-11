import { normalizeInterfaceName } from './interfaces';
import { isIpv6, normalizeIpv6, parsePrefix6 } from './ipv6';
import { renderConfigBody } from './ios/show';
import { channelStatus, ifaceIpv6, ospfInterfaces, ospfNeighbors, ospfRouterId, routingTable, stpRoot, stpVlan, type ChannelProtocol, type HostState, type NetworkState, type RouteEntry } from './network';
import { getNode, normalizePath, octal } from './linux/fs';
import { testNginx } from './linux/web';
import type { AclAddr, AclEntry, AclProtocol, ApiRequest, CliErrorKind, DeviceState, LineState, Mode, PortMode, SnmpMode, SyslogLevel } from './types';

interface Base {
  /** Device (or host, for ping) the check targets. Defaults to the network's primary device. */
  device?: string;
  label?: string;
}

/**
 * Declarative checks a lab author combines into objectives.
 * Every check has an optional `label` shown as a sub-objective in the UI.
 */
export type Check = Base &
  (
    | { type: 'command'; pattern: string }
    | { type: 'mode'; mode: Mode }
    | { type: 'hostname'; equals: string }
    | { type: 'vlan-exists'; id: number; name?: string }
    | { type: 'vlan-absent'; id: number }
    | {
        type: 'interface';
        name: string;
        mode?: PortMode;
        accessVlan?: number;
        shutdown?: boolean;
        description?: string;
        trunkAllowed?: 'all' | number[];
        nativeVlan?: number;
        ipAddress?: string;
        subnetMask?: string;
        encapsulation?: number;
        errDisabled?: boolean;
      }
    | { type: 'enable-secret'; equals?: string; minLength?: number }
    | { type: 'enable-password'; equals?: string }
    | { type: 'line'; line: 'con' | 'vty'; password?: string; login?: LineState['login']; transportInput?: LineState['transportInput'] }
    | { type: 'user'; username: string; privilege?: number; secret?: boolean }
    | { type: 'banner'; contains?: string }
    | { type: 'domain-name'; equals?: string }
    | { type: 'ssh-ready' }
    | { type: 'default-gateway'; equals: string }
    | { type: 'saved' }
    | { type: 'password-encryption' }
    | { type: 'error-seen'; error: CliErrorKind }
    | { type: 'ping'; target: string; success?: boolean; denied?: boolean }
    | { type: 'route'; destination: string; mask: string; via?: string }
    | { type: 'route-absent'; destination: string; mask: string }
    /** A prefix present in the live routing table, optionally from a given source. */
    | { type: 'learned-route'; destination: string; mask: string; source?: RouteEntry['source'] }
    | { type: 'ospf'; processId?: number; routerId?: string }
    | { type: 'ospf-network'; address: string; wildcard: string; area: number }
    | { type: 'ospf-network-absent'; address: string; wildcard: string; area?: number }
    | { type: 'ospf-neighbors'; min: number; routerId?: string }
    | { type: 'passive-interface'; name: string; passive?: boolean }
    | { type: 'default-information-originate' }
    /** Trunk allows at least these VLANs (explicit list or "all"). */
    | { type: 'trunk-allows'; name: string; vlans: number[] }
    | { type: 'acl-exists'; name: string; kind?: 'standard' | 'extended' }
    /**
     * An entry is present. Addresses are written as in IOS: "any", "host 10.1.1.1",
     * "192.168.1.0 0.0.0.255". `position` is the 1-based index among non-remark entries.
     */
    | { type: 'acl-entry'; name: string; action: 'permit' | 'deny'; protocol?: AclProtocol; src?: string; dst?: string; dstPort?: number; icmpType?: 'echo' | 'echo-reply'; position?: number }
    | { type: 'acl-applied'; interface: string; direction: 'in' | 'out'; name?: string }
    | { type: 'acl-not-applied'; interface: string; direction: 'in' | 'out' }
    | { type: 'access-class'; name?: string }
    | { type: 'dhcp-pool'; name: string; network?: string; mask?: string; defaultRouter?: string; dnsServer?: string }
    | { type: 'dhcp-excluded'; from: string; to?: string }
    | { type: 'dhcp-bindings'; min: number }
    | { type: 'helper-address'; interface: string; address: string }
    /** Host settings (device = host id). `viaDhcp` requires a live lease. */
    | { type: 'host-config'; ip?: string; mask?: string; gateway?: string; dns?: string; viaDhcp?: boolean; inSubnet?: { network: string; mask: string } }
    | { type: 'nat-role'; interface: string; role: 'inside' | 'outside' }
    | { type: 'nat-static'; local: string; global: string }
    | { type: 'nat-pool'; name: string; start?: string; end?: string }
    | { type: 'nat-dynamic'; acl?: string; pool?: string; interface?: string; overload?: boolean }
    | { type: 'nat-translations'; min: number }
    | { type: 'ipv6-unicast-routing' }
    /** An interface carries the given global address/prefix (any spelling), optionally by EUI-64, or the given manual link-local. */
    | { type: 'ipv6-address'; interface: string; address?: string; prefix?: number; eui64?: boolean; linkLocal?: string }
    | { type: 'route6'; prefix: string; via?: string }
    /** EtherChannel group state; `members` must all be in the group, `mode` is the Port-channel's switchport mode. */
    | { type: 'etherchannel'; group: number; bundled?: boolean; protocol?: ChannelProtocol; members?: string[]; mode?: PortMode }
    | { type: 'port-security'; interface: string; enabled?: boolean; maximum?: number; violation?: 'shutdown' | 'restrict' | 'protect'; sticky?: boolean; mac?: string; secured?: number; errDisabled?: boolean }
    /** The device (default primary) is the spanning-tree root for the VLAN. */
    | { type: 'stp-root'; vlan: number }
    | { type: 'stp-priority'; vlan: number; priority?: number; max?: number }
    | { type: 'stp-mode'; mode: 'pvst' | 'rapid-pvst' }
    | { type: 'stp-port'; interface: string; vlan?: number; role?: 'Root' | 'Desg' | 'Altn'; state?: 'FWD' | 'BLK'; portfast?: boolean; bpduGuard?: boolean }
    /** "security passwords min-length" (at least `minLength`) and "login block-for". */
    | { type: 'password-policy'; minLength?: number; loginBlock?: boolean; maxAttempts?: number }
    /** exec-timeout configured on a line and no longer than `maxMinutes`. */
    | { type: 'exec-timeout'; line: 'con' | 'vty'; maxMinutes: number }
    | { type: 'aaa'; newModel?: boolean; loginLocal?: boolean }
    | { type: 'dhcp-snooping'; enabled?: boolean; vlans?: number[]; optionInsert?: boolean }
    /** Trust state of a switch port for DHCP snooping and/or dynamic ARP inspection. */
    | { type: 'port-trust'; interface: string; dhcpSnooping?: boolean; arpInspection?: boolean }
    | { type: 'arp-inspection'; vlans: number[] }
    | { type: 'management-api'; restconf?: boolean; netconf?: boolean; httpsServer?: boolean; httpAuthLocal?: boolean }
    /** The device answered a RESTCONF request; `path` is a regex over the URI path. */
    | { type: 'api-request'; method?: ApiRequest['method']; path?: string; status?: number }
    | { type: 'syslog'; host?: string; trap?: SyslogLevel }
    | { type: 'snmp-community'; name?: string; mode?: SnmpMode }
    | { type: 'ntp-server'; address: string }
    // --- Linux hosts (device = host id)
    /** A file or directory on a Linux host. `mode` is octal text like "644"; `contains` is a regex over the content. */
    | { type: 'file'; path: string; exists?: boolean; kind?: 'file' | 'dir' | 'link'; contains?: string; notContains?: string; mode?: string; owner?: string; group?: string; target?: string; executable?: boolean }
    | { type: 'linux-user'; name: string; exists?: boolean; groups?: string[]; shell?: string; home?: string; hasPassword?: boolean; locked?: boolean }
    | { type: 'linux-group'; name: string; exists?: boolean; members?: string[] }
    | { type: 'service'; name: string; active?: boolean; enabled?: boolean; installed?: boolean }
    | { type: 'package'; name: string; installed?: boolean }
    | { type: 'linux-hostname'; equals: string }
    /** Some output the learner has seen on the host matches this regex (scripts that print). */
    | { type: 'shell-output'; pattern: string }
    /** python3 ran (a given file, or any) and exited with `exitCode` (default 0); `pattern` is a regex over its stdout. */
    | { type: 'python-run'; file?: string; exitCode?: number; pattern?: string }
    | { type: 'process'; pattern: string; running?: boolean }
    /** nginx (or the demo app) on a Linux host answered a request; host/path are regexes, backend is a host id. */
    | { type: 'web-request'; scheme?: 'http' | 'https'; host?: string; path?: string; status?: number; backend?: string; server?: string }
    /** The nginx configuration on disk passes nginx -t (or fails, with valid: false). */
    | { type: 'nginx-config'; valid: boolean }
  );

const LINUX_CHECKS = new Set(['file', 'linux-user', 'linux-group', 'service', 'package', 'linux-hostname', 'shell-output', 'python-run', 'process', 'web-request', 'nginx-config']);

export interface Objective {
  id: string;
  label: string;
  checks: Check[];
}

export interface CheckResult {
  label: string;
  passed: boolean;
}

export interface ObjectiveResult {
  id: string;
  label: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface GradeResult {
  passed: boolean;
  /** 0-100, percentage of objectives fully passed. */
  score: number;
  objectives: ObjectiveResult[];
}

function describe(check: Check): string {
  if (check.label) return check.label;
  const on = check.device ? ` on ${check.device}` : '';
  switch (check.type) {
    case 'command':
      return `Run ${check.pattern.replace(/[\^$]/g, '')}${on}`;
    case 'mode':
      return `Reach ${check.mode} mode${on}`;
    case 'hostname':
      return `Hostname is ${check.equals}`;
    case 'vlan-exists':
      return check.name ? `VLAN ${check.id} exists and is named ${check.name}` : `VLAN ${check.id} exists`;
    case 'vlan-absent':
      return `VLAN ${check.id} is removed`;
    case 'interface':
      return `${check.name}${on} is configured correctly`;
    case 'enable-secret':
      return `Enable secret is set${on}`;
    case 'enable-password':
      return `Enable password is set${on}`;
    case 'line':
      return `${check.line === 'con' ? 'Console' : 'VTY'} line is configured${on}`;
    case 'user':
      return `User ${check.username} exists${on}`;
    case 'banner':
      return `MOTD banner is set${on}`;
    case 'domain-name':
      return `Domain name is set${on}`;
    case 'ssh-ready':
      return `RSA keys are generated${on}`;
    case 'default-gateway':
      return `Default gateway is ${check.equals}`;
    case 'saved':
      return `Configuration is saved${on}`;
    case 'password-encryption':
      return `Password encryption service is on${on}`;
    case 'error-seen':
      return `Triggered a ${check.error} command error`;
    case 'ping':
      return `Ping ${check.target}${check.device ? ` from ${check.device}` : ''}`;
    case 'route':
      return `Route to ${check.destination} ${check.mask}${check.via ? ` via ${check.via}` : ''}${on}`;
    case 'route-absent':
      return `No route to ${check.destination} ${check.mask}${on}`;
    case 'learned-route':
      return `${check.destination} ${check.mask} is in the routing table${check.source ? ` via ${check.source}` : ''}${on}`;
    case 'ospf':
      return `OSPF${check.processId ? ` process ${check.processId}` : ''} is running${check.routerId ? ` with router-id ${check.routerId}` : ''}${on}`;
    case 'ospf-network':
      return `network ${check.address} ${check.wildcard} area ${check.area}${on}`;
    case 'ospf-network-absent':
      return `network ${check.address} ${check.wildcard} is removed${on}`;
    case 'ospf-neighbors':
      return check.routerId ? `OSPF neighbor ${check.routerId} is up${on}` : `At least ${check.min} OSPF neighbor${check.min === 1 ? '' : 's'}${on}`;
    case 'passive-interface':
      return `${check.name} is ${check.passive === false ? 'not ' : ''}passive${on}`;
    case 'default-information-originate':
      return `default-information originate is configured${on}`;
    case 'trunk-allows':
      return `${check.name} allows VLANs ${check.vlans.join(',')}${on}`;
    case 'acl-exists':
      return `${check.kind ? `${check.kind[0].toUpperCase()}${check.kind.slice(1)} a` : 'A'}ccess list ${check.name} exists${on}`;
    case 'acl-entry':
      return `${check.name}: ${check.action}${check.protocol ? ` ${check.protocol}` : ''}${check.src ? ` ${check.src}` : ''}${check.dst ? ` ${check.dst}` : ''}${check.dstPort ? ` eq ${check.dstPort}` : ''}${check.icmpType ? ` ${check.icmpType}` : ''}${check.position ? ` (entry ${check.position})` : ''}${on}`;
    case 'acl-applied':
      return `${check.name ?? 'An access list'} is applied ${check.direction}bound on ${check.interface}${on}`;
    case 'acl-not-applied':
      return `No ${check.direction}bound access list on ${check.interface}${on}`;
    case 'access-class':
      return `VTY lines are protected with access-class${check.name ? ` ${check.name}` : ''}${on}`;
    case 'dhcp-pool':
      return `DHCP pool ${check.name}${check.network ? ` for ${check.network}` : ''}${check.defaultRouter ? ` with default-router ${check.defaultRouter}` : ''}${on}`;
    case 'dhcp-excluded':
      return `${check.from}${check.to ? ` to ${check.to}` : ''} excluded from DHCP${on}`;
    case 'dhcp-bindings':
      return `At least ${check.min} DHCP binding${check.min === 1 ? '' : 's'}${on}`;
    case 'helper-address':
      return `${check.interface} relays DHCP to ${check.address}${on}`;
    case 'host-config':
      return `${check.device ?? 'Host'} has ${check.viaDhcp ? 'a DHCP lease' : 'the expected IP settings'}${check.ip ? ` (${check.ip})` : ''}`;
    case 'nat-role':
      return `${check.interface} is ip nat ${check.role}${on}`;
    case 'nat-static':
      return `Static NAT ${check.local} -> ${check.global}${on}`;
    case 'nat-pool':
      return `NAT pool ${check.name}${check.start ? ` ${check.start}-${check.end}` : ''}${on}`;
    case 'nat-dynamic':
      return `${check.overload ? 'PAT' : 'Dynamic NAT'}${check.acl ? ` for list ${check.acl}` : ''}${check.pool ? ` using pool ${check.pool}` : check.interface ? ` using ${check.interface}` : ''}${on}`;
    case 'nat-translations':
      return `At least ${check.min} NAT translation${check.min === 1 ? '' : 's'}${on}`;
    case 'ipv6-unicast-routing':
      return `ipv6 unicast-routing is enabled${on}`;
    case 'ipv6-address':
      return check.linkLocal ? `${check.interface} has link-local ${check.linkLocal}${on}` : `${check.interface} has ${check.address ?? 'an IPv6 address'}${check.prefix ? `/${check.prefix}` : ''}${check.eui64 ? ' (EUI-64)' : ''}${on}`;
    case 'route6':
      return `IPv6 route ${check.prefix}${check.via ? ` via ${check.via}` : ''}${on}`;
    case 'etherchannel':
      return `Port-channel ${check.group}${check.bundled === true ? ' is bundled' : check.bundled === false ? ' is not bundled' : ''}${check.protocol ? ` using ${check.protocol === '-' ? 'static mode' : check.protocol}` : ''}${check.members ? ` with ${check.members.join(', ')}` : ''}${check.mode ? ` as ${check.mode}` : ''}${on}`;
    case 'port-security':
      return `${check.interface}: port security${check.enabled === false ? ' disabled' : ''}${check.maximum ? ` maximum ${check.maximum}` : ''}${check.violation ? ` violation ${check.violation}` : ''}${check.sticky ? ' sticky' : ''}${check.mac ? ` secures ${check.mac}` : ''}${check.errDisabled === false ? ' (not err-disabled)' : check.errDisabled ? ' (err-disabled)' : ''}${on}`;
    case 'stp-root':
      return `${check.device ?? 'This switch'} is the root bridge for VLAN ${check.vlan}`;
    case 'stp-priority':
      return `VLAN ${check.vlan} priority${check.priority !== undefined ? ` is ${check.priority}` : check.max !== undefined ? ` is at most ${check.max}` : ' is set'}${on}`;
    case 'stp-mode':
      return `Spanning-tree mode is ${check.mode}${on}`;
    case 'stp-port':
      return `${check.interface}${check.role ? ` is a ${check.role} port` : ''}${check.state ? ` (${check.state})` : ''}${check.portfast ? ' with PortFast' : ''}${check.bpduGuard ? ' and BPDU guard' : ''}${check.vlan ? ` in VLAN ${check.vlan}` : ''}${on}`;
    case 'password-policy':
      return [check.minLength ? `Passwords must be at least ${check.minLength} characters` : '', check.loginBlock ? `Login attacks are blocked${check.maxAttempts ? ` after at most ${check.maxAttempts} failures` : ''}` : ''].filter(Boolean).join('; ') + on;
    case 'exec-timeout':
      return `${check.line === 'con' ? 'Console' : 'VTY'} exec-timeout is ${check.maxMinutes} minutes or less${on}`;
    case 'aaa':
      return `${check.newModel === false ? 'AAA is off' : 'aaa new-model'}${check.loginLocal ? ' with default login authentication against the local database' : ''}${on}`;
    case 'dhcp-snooping':
      return `DHCP snooping${check.enabled === false ? ' off' : ''}${check.vlans ? ` on VLAN ${check.vlans.join(', ')}` : ''}${check.optionInsert === false ? ' without option 82 insertion' : ''}${on}`;
    case 'port-trust':
      return `${check.interface} is ${check.dhcpSnooping === false || check.arpInspection === false ? 'untrusted' : 'trusted'} for ${[check.dhcpSnooping !== undefined ? 'DHCP snooping' : '', check.arpInspection !== undefined ? 'ARP inspection' : ''].filter(Boolean).join(' and ')}${on}`;
    case 'arp-inspection':
      return `Dynamic ARP inspection on VLAN ${check.vlans.join(', ')}${on}`;
    case 'management-api':
      return [check.restconf ? 'RESTCONF' : '', check.netconf ? 'NETCONF' : '', check.httpsServer ? 'HTTPS server' : '', check.httpAuthLocal ? 'local HTTP authentication' : ''].filter(Boolean).join(', ') + ` enabled${on}`;
    case 'api-request':
      return `Answered a${check.method ? ` ${check.method}` : 'n API'} request${check.path ? ` for ${readable(check.path)}` : ''}${check.status ? ` with ${check.status}` : ''}${on}`;
    case 'syslog':
      return `Syslog${check.host ? ` to ${check.host}` : ''}${check.trap ? ` at level ${check.trap}` : ''}${on}`;
    case 'snmp-community':
      return `SNMP community${check.name ? ` ${check.name}` : ''}${check.mode ? ` (${check.mode.toUpperCase()})` : ''}${on}`;
    case 'ntp-server':
      return `NTP server ${check.address}${on}`;
    case 'file': {
      if (check.exists === false) return `${check.path} does not exist${on}`;
      const what = check.kind === 'dir' ? 'Directory' : check.kind === 'link' ? 'Symlink' : 'File';
      const bits = [check.contains ? `contains ${readable(check.contains)}` : '', check.notContains ? `no longer contains ${readable(check.notContains)}` : '', check.mode ? `mode ${check.mode}` : '', check.owner ? `owned by ${check.owner}` : '', check.group ? `group ${check.group}` : '', check.target ? `pointing at ${check.target}` : '', check.executable ? 'executable' : ''].filter(Boolean);
      return `${what} ${check.path}${bits.length ? ` ${bits.join(', ')}` : ' exists'}${on}`;
    }
    case 'linux-user': {
      if (check.exists === false) return `User ${check.name} is gone${on}`;
      const bits = [check.groups ? `in group ${check.groups.join(', ')}` : '', check.shell ? `with shell ${check.shell}` : '', check.home ? `home ${check.home}` : '', check.hasPassword ? 'with a password' : '', check.locked ? 'locked' : check.locked === false ? 'unlocked' : ''].filter(Boolean);
      return `User ${check.name}${bits.length ? ` ${bits.join(', ')}` : ' exists'}${on}`;
    }
    case 'linux-group':
      return check.exists === false ? `Group ${check.name} is gone${on}` : `Group ${check.name}${check.members ? ` with ${check.members.join(', ')}` : ' exists'}${on}`;
    case 'service':
      return `Service ${check.name}${check.installed === false ? ' removed' : ''}${check.active === true ? ' running' : check.active === false ? ' stopped' : ''}${check.enabled === true ? ', enabled at boot' : check.enabled === false ? ', disabled at boot' : ''}${on}`;
    case 'package':
      return `Package ${check.name} ${check.installed === false ? 'removed' : 'installed'}${on}`;
    case 'linux-hostname':
      return `Hostname is ${check.equals}${on}`;
    case 'shell-output':
      return `Output matching ${readable(check.pattern)} appeared${on}`;
    case 'python-run':
      return `python3${check.file ? ` ${check.file}` : ''} ran${check.exitCode ? ` and exited ${check.exitCode}` : ' successfully'}${check.pattern ? ` printing ${readable(check.pattern)}` : ''}${on}`;
    case 'process':
      return `${check.running === false ? 'No process' : 'A process'} matching ${check.pattern}${on}`;
    case 'web-request':
      return `Served ${check.scheme ? check.scheme.toUpperCase() + ' ' : ''}${check.host ? 'Host ' + readable(check.host) + ' ' : ''}${check.path ? readable(check.path) + ' ' : ''}${check.status ? 'with ' + check.status + ' ' : ''}${check.backend ? 'from backend ' + check.backend : ''}`.trim() + on;
    case 'nginx-config':
      return `nginx configuration ${check.valid ? 'passes' : 'fails'} nginx -t${on}`;
  }
}

function evaluateLinuxCheck(check: Check, lx: NonNullable<HostState['linux']>, sh: { path(p: string): string }): boolean {
  switch (check.type) {
    case 'file': {
      const path = sh.path(check.path);
      const node = check.kind === 'link' ? getNode(lx, path, false) : getNode(lx, path);
      if (check.exists === false) return !node;
      if (!node) return false;
      if (check.kind && node.type !== check.kind) return false;
      if (check.contains !== undefined && !new RegExp(check.contains, 'm').test(node.content)) return false;
      if (check.notContains !== undefined && new RegExp(check.notContains, 'm').test(node.content)) return false;
      if (check.mode !== undefined && octal(node.mode) !== check.mode.padStart(3, '0').slice(-3)) return false;
      if (check.owner !== undefined && node.owner !== check.owner) return false;
      if (check.group !== undefined && node.group !== check.group) return false;
      if (check.target !== undefined && node.target !== check.target) return false;
      if (check.executable !== undefined && Boolean(node.mode & 0o111) !== check.executable) return false;
      return true;
    }
    case 'linux-user': {
      const u = lx.users.find((x) => x.name === check.name);
      if (check.exists === false) return !u;
      if (!u) return false;
      const primary = lx.groups.find((g) => g.gid === u.gid)?.name;
      if (check.groups && !check.groups.every((g) => u.groups.includes(g) || primary === g)) return false;
      if (check.shell !== undefined && u.shell !== check.shell) return false;
      if (check.home !== undefined && u.home !== check.home) return false;
      if (check.hasPassword !== undefined && Boolean(u.password) !== check.hasPassword) return false;
      if (check.locked !== undefined && Boolean(u.locked) !== check.locked) return false;
      return true;
    }
    case 'linux-group': {
      const g = lx.groups.find((x) => x.name === check.name);
      if (check.exists === false) return !g;
      if (!g) return false;
      if (check.members && !check.members.every((m) => lx.users.some((u) => u.name === m && (u.groups.includes(check.name) || u.gid === g.gid)))) return false;
      return true;
    }
    case 'service': {
      const s = lx.services[check.name];
      if (check.installed === false) return !s;
      if (!s) return false;
      if (check.active !== undefined && s.active !== check.active) return false;
      if (check.enabled !== undefined && s.enabled !== check.enabled) return false;
      return true;
    }
    case 'package':
      return lx.packages.includes(check.name) === (check.installed ?? true);
    case 'linux-hostname':
      return lx.hostname === check.equals;
    case 'shell-output': {
      const re = new RegExp(check.pattern, 'm');
      return lx.outputs.some((l) => re.test(l));
    }
    case 'python-run': {
      const re = check.pattern ? new RegExp(check.pattern, 'm') : null;
      const want = check.exitCode ?? 0;
      return lx.pythonRuns.some((r) => (check.file === undefined || (r.file !== undefined && (r.file === check.file || r.file.endsWith('/' + check.file) || sh.path(r.file) === sh.path(check.file)))) && r.exitCode === want && (re === null || re.test(r.stdout)));
    }
    case 'process': {
      const re = new RegExp(check.pattern);
      return lx.processes.some((p) => re.test(p.cmd)) === (check.running ?? true);
    }
    case 'web-request': {
      const host = check.host ? new RegExp(check.host, 'i') : null;
      const path = check.path ? new RegExp(check.path) : null;
      return lx.web.requests.some((r) => (check.scheme === undefined || r.scheme === check.scheme) && (host === null || host.test(r.host)) && (path === null || path.test(r.path)) && (check.status === undefined || r.status === check.status) && (check.backend === undefined || r.backend === check.backend) && (check.server === undefined || r.server === check.server));
    }
    case 'nginx-config':
      return testNginx({ ...lx, user: 'root' }).ok === check.valid;
  }
  return false;
}

function addrText(a: AclAddr): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return `host ${a.ip}`;
  return `${a.address} ${a.wildcard}`;
}

function normalizeAddrText(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  // Bare address means host.
  return /^\d+\.\d+\.\d+\.\d+$/.test(t) ? `host ${t}` : t;
}

function entryMatchesCheck(e: AclEntry, check: Extract<Check, { type: 'acl-entry' }>): boolean {
  if (e.action !== check.action) return false;
  if (check.protocol !== undefined && e.protocol !== check.protocol) return false;
  if (check.src !== undefined && addrText(e.src) !== normalizeAddrText(check.src)) return false;
  if (check.dst !== undefined && addrText(e.dst ?? { kind: 'any' }) !== normalizeAddrText(check.dst)) return false;
  if (check.dstPort !== undefined && e.dstPort !== check.dstPort) return false;
  if (check.icmpType !== undefined && e.icmpType !== check.icmpType) return false;
  return true;
}

function sameList(a: 'all' | number[], b: 'all' | number[]): boolean {
  if (a === 'all' || b === 'all') return a === b;
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/** Render a simple regex as the text it looks for, so objective labels read naturally. */
function readable(pattern: string): string {
  return pattern
    .replace(/\\s[+*]/g, ' ')
    .replace(/\\b/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[\^$]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function deviceFor(check: Check, net: NetworkState): DeviceState | undefined {
  return net.devices[check.device ?? net.primary];
}

export function evaluateCheck(check: Check, net: NetworkState): boolean {
  return evaluateCheckInner(check, net) ?? false;
}

function evaluateCheckInner(check: Check, net: NetworkState): boolean | undefined {
  if (check.type === 'ping') {
    const id = check.device ?? net.primary;
    const pings = net.devices[id]?.pings ?? net.hosts[id]?.pings ?? [];
    const target = isIpv6(check.target) ? normalizeIpv6(check.target) : check.target;
    return pings.some((p) => p.target === target && (check.success === undefined || p.success === check.success) && (check.denied === undefined || Boolean(p.denied) === check.denied));
  }
  if (check.type === 'command' && check.device && net.hosts[check.device]) {
    const re = new RegExp(check.pattern, 'i');
    return net.hosts[check.device].commandHistory.some((c) => re.test(c));
  }
  if (LINUX_CHECKS.has(check.type)) {
    const h = net.hosts[check.device ?? ''] ?? Object.values(net.hosts).find((x) => x.os === 'linux');
    if (!h?.linux) return false;
    const lx = h.linux;
    return evaluateLinuxCheck(check, lx, { path: (p) => normalizePath(lx.cwd, p, lx.users.find((u) => u.name === lx.user)?.home ?? '/root') });
  }
  if (check.type === 'host-config') {
    const h = net.hosts[check.device ?? ''];
    if (!h) return false;
    if (check.viaDhcp && !(h.dhcp && h.dhcpServer && h.ip)) return false;
    if (check.ip !== undefined && h.ip !== check.ip) return false;
    if (check.mask !== undefined && h.mask !== check.mask) return false;
    if (check.gateway !== undefined && h.gateway !== check.gateway) return false;
    if (check.dns !== undefined && h.dns !== check.dns) return false;
    if (check.inSubnet && !(h.ip && h.mask === check.inSubnet.mask && sameSubnetText(h.ip, check.inSubnet.network, check.inSubnet.mask))) return false;
    return true;
  }
  const state = deviceFor(check, net);
  if (!state) return false;
  switch (check.type) {
    case 'command': {
      const re = new RegExp(check.pattern, 'i');
      return state.canonicalHistory.some((c) => re.test(c)) || state.commandHistory.some((c) => re.test(c));
    }
    case 'mode':
      return state.modesVisited.includes(check.mode);
    case 'hostname':
      return state.hostname === check.equals;
    case 'vlan-exists': {
      const v = state.vlans[check.id];
      return Boolean(v) && (check.name === undefined || v.name === check.name);
    }
    case 'vlan-absent':
      return !state.vlans[check.id];
    case 'interface': {
      const name = normalizeInterfaceName(check.name);
      const i = name ? state.interfaces[name] : undefined;
      if (!i) return false;
      if (check.mode !== undefined && i.mode !== check.mode) return false;
      if (check.accessVlan !== undefined && i.accessVlan !== check.accessVlan) return false;
      if (check.shutdown !== undefined && i.shutdown !== check.shutdown) return false;
      if (check.errDisabled !== undefined && Boolean(i.errDisabled) !== check.errDisabled) return false;
      if (check.description !== undefined && (i.description ?? '').toLowerCase() !== check.description.toLowerCase()) return false;
      if (check.trunkAllowed !== undefined && !sameList(i.trunkAllowed, check.trunkAllowed)) return false;
      if (check.nativeVlan !== undefined && i.nativeVlan !== check.nativeVlan) return false;
      if (check.ipAddress !== undefined && i.ipAddress !== check.ipAddress) return false;
      if (check.subnetMask !== undefined && i.subnetMask !== check.subnetMask) return false;
      if (check.encapsulation !== undefined && i.encapsulation?.vlan !== check.encapsulation) return false;
      return true;
    }
    case 'enable-secret':
      return state.enableSecret !== undefined && (check.equals === undefined || state.enableSecret === check.equals) && (check.minLength === undefined || state.enableSecret.length >= check.minLength);
    case 'enable-password':
      return state.enablePassword !== undefined && (check.equals === undefined || state.enablePassword === check.equals);
    case 'line': {
      const l = state.lines[check.line];
      if (check.password !== undefined && l.password !== check.password) return false;
      if (check.login !== undefined && l.login !== check.login) return false;
      if (check.transportInput !== undefined && l.transportInput !== check.transportInput) return false;
      return true;
    }
    case 'user': {
      const u = state.users.find((x) => x.username === check.username);
      if (!u) return false;
      if (check.privilege !== undefined && u.privilege !== check.privilege) return false;
      if (check.secret !== undefined && u.secret !== check.secret) return false;
      return true;
    }
    case 'banner':
      return state.bannerMotd !== undefined && state.bannerMotd.length > 0 && (check.contains === undefined || state.bannerMotd.toLowerCase().includes(check.contains.toLowerCase()));
    case 'domain-name':
      return state.ipDomainName !== undefined && (check.equals === undefined || state.ipDomainName === check.equals);
    case 'ssh-ready':
      return state.rsaKeyBits !== undefined;
    case 'default-gateway':
      return state.ipDefaultGateway === check.equals;
    case 'saved':
      return state.startupConfig !== null && state.startupConfig === renderConfigBody(state).join('\n');
    case 'password-encryption':
      return state.servicePasswordEncryption;
    case 'error-seen':
      return state.errorsSeen.includes(check.error);
    case 'route': {
      const viaIface = check.via ? normalizeInterfaceName(check.via) : null;
      return state.staticRoutes.some((r) => r.destination === check.destination && r.mask === check.mask && (check.via === undefined || r.nextHop === check.via || (viaIface !== null && r.exitInterface === viaIface)));
    }
    case 'route-absent':
      return !state.staticRoutes.some((r) => r.destination === check.destination && r.mask === check.mask);
    case 'learned-route':
      return routingTable(net, state.id).some((e) => e.destination === check.destination && e.mask === check.mask && (check.source === undefined || e.source === check.source));
    case 'ospf': {
      if (!state.ospf) return false;
      if (check.processId !== undefined && state.ospf.processId !== check.processId) return false;
      if (check.routerId !== undefined && ospfRouterId(net, state.id) !== check.routerId) return false;
      return true;
    }
    case 'ospf-network':
      return Boolean(state.ospf?.networks.some((n) => n.address === check.address && n.wildcard === check.wildcard && n.area === check.area));
    case 'ospf-network-absent':
      return !state.ospf?.networks.some((n) => n.address === check.address && n.wildcard === check.wildcard && (check.area === undefined || n.area === check.area));
    case 'ospf-neighbors': {
      const nbrs = ospfNeighbors(net, state.id);
      if (check.routerId !== undefined) return nbrs.some((n) => n.routerId === check.routerId);
      return nbrs.length >= check.min;
    }
    case 'passive-interface': {
      const name = normalizeInterfaceName(check.name);
      const info = ospfInterfaces(net, state.id).find((i) => i.name === name);
      return Boolean(info) && info!.passive === (check.passive ?? true);
    }
    case 'default-information-originate':
      return Boolean(state.ospf?.defaultInformationOriginate);
    case 'trunk-allows': {
      const name = normalizeInterfaceName(check.name);
      const i = name ? state.interfaces[name] : undefined;
      if (!i || i.mode !== 'trunk') return false;
      return i.trunkAllowed === 'all' || check.vlans.every((v) => (i.trunkAllowed as number[]).includes(v));
    }
    case 'acl-exists': {
      const acl = state.acls[check.name];
      return Boolean(acl) && (check.kind === undefined || acl.kind === check.kind);
    }
    case 'acl-entry': {
      const acl = state.acls[check.name];
      if (!acl) return false;
      const rules = acl.entries.filter((e) => e.action !== 'remark');
      if (check.position !== undefined) {
        const e = rules[check.position - 1];
        return Boolean(e) && entryMatchesCheck(e, check);
      }
      return rules.some((e) => entryMatchesCheck(e, check));
    }
    case 'acl-applied': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      const applied = check.direction === 'in' ? i?.aclIn : i?.aclOut;
      return Boolean(applied) && (check.name === undefined || applied === check.name);
    }
    case 'acl-not-applied': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      return Boolean(i) && !(check.direction === 'in' ? i!.aclIn : i!.aclOut);
    }
    case 'access-class':
      return Boolean(state.lines.vty.accessClass) && (check.name === undefined || state.lines.vty.accessClass === check.name);
    case 'dhcp-pool': {
      const p = state.dhcpPools[check.name];
      if (!p) return false;
      if (check.network !== undefined && p.network !== check.network) return false;
      if (check.mask !== undefined && p.mask !== check.mask) return false;
      if (check.defaultRouter !== undefined && p.defaultRouter !== check.defaultRouter) return false;
      if (check.dnsServer !== undefined && p.dnsServer !== check.dnsServer) return false;
      return true;
    }
    case 'dhcp-excluded': {
      const to = check.to ?? check.from;
      return state.dhcpExcluded.some((r) => r.from === check.from && r.to === to);
    }
    case 'dhcp-bindings':
      return state.dhcpBindings.length >= check.min;
    case 'helper-address': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      return i?.helperAddress === check.address;
    }
    case 'nat-role': {
      const name = normalizeInterfaceName(check.interface);
      return Boolean(name) && state.interfaces[name!]?.natRole === check.role;
    }
    case 'nat-static':
      return state.natStatic.some((s) => s.insideLocal === check.local && s.insideGlobal === check.global);
    case 'nat-pool': {
      const p = state.natPools[check.name];
      return Boolean(p) && (check.start === undefined || p.start === check.start) && (check.end === undefined || p.end === check.end);
    }
    case 'nat-dynamic': {
      const d = state.natDynamic;
      if (!d) return false;
      if (check.acl !== undefined && d.acl !== check.acl) return false;
      if (check.pool !== undefined && d.pool !== check.pool) return false;
      if (check.interface !== undefined && d.interface !== normalizeInterfaceName(check.interface)) return false;
      if (check.overload !== undefined && d.overload !== check.overload) return false;
      return true;
    }
    case 'nat-translations':
      return state.natTranslations.length >= check.min;
    case 'ipv6-unicast-routing':
      return state.ipv6UnicastRouting;
    case 'ipv6-address': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      if (!i?.ipv6) return false;
      if (check.linkLocal !== undefined) return i.ipv6.linkLocal === normalizeIpv6(check.linkLocal);
      const want = check.address ? normalizeIpv6(check.address) : undefined;
      const addrs = ifaceIpv6(state, i).global;
      return addrs.some((a) => (want === undefined || a.address === want) && (check.prefix === undefined || a.prefix === check.prefix) && (check.eui64 === undefined || Boolean(i.ipv6!.addresses.find((x) => x.address === a.address)?.eui64) === check.eui64));
    }
    case 'route6': {
      const p = parsePrefix6(check.prefix);
      if (!p) return false;
      const viaAddr = check.via ? normalizeIpv6(check.via) : null;
      const viaIface = check.via && !viaAddr ? normalizeInterfaceName(check.via) : null;
      return state.staticRoutes6.some((r) => r.prefix === p.address && r.length === p.length && (check.via === undefined || (viaAddr !== null && r.nextHop === viaAddr) || (viaIface !== null && r.exitInterface === viaIface)));
    }
    case 'etherchannel': {
      const g = channelStatus(net, state.id).find((c) => c.id === check.group);
      if (!g) return false;
      if (check.bundled !== undefined && g.bundled !== check.bundled) return false;
      if (check.protocol !== undefined && g.protocol !== check.protocol) return false;
      if (check.members !== undefined) {
        const names = g.members.map((m) => m.name);
        if (!check.members.every((m) => names.includes(normalizeInterfaceName(m) ?? m))) return false;
      }
      if (check.mode !== undefined && state.interfaces[g.name]?.mode !== check.mode) return false;
      return true;
    }
    case 'port-security': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      if (!i) return false;
      const ps = i.portSecurity;
      if (check.enabled === false) return !ps?.enabled;
      if (!ps?.enabled) return false;
      if (check.maximum !== undefined && ps.maximum !== check.maximum) return false;
      if (check.violation !== undefined && ps.violation !== check.violation) return false;
      if (check.sticky !== undefined && ps.sticky !== check.sticky) return false;
      if (check.mac !== undefined && ![...ps.staticMacs, ...ps.stickyMacs].includes(check.mac.toLowerCase())) return false;
      if (check.secured !== undefined && ps.staticMacs.length + ps.stickyMacs.length + ps.learnedMacs.length < check.secured) return false;
      if (check.errDisabled !== undefined && Boolean(i.errDisabled) !== check.errDisabled) return false;
      return true;
    }
    case 'stp-root':
      return stpRoot(net, check.vlan) === state.id;
    case 'stp-priority': {
      const p = state.stpPriority[check.vlan];
      if (check.priority !== undefined) return (p ?? 32768) === check.priority;
      if (check.max !== undefined) return (p ?? 32768) <= check.max;
      return p !== undefined;
    }
    case 'stp-mode':
      return state.stpMode === check.mode;
    case 'stp-port': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      if (!i) return false;
      if (check.portfast !== undefined && Boolean(i.portfast) !== check.portfast) return false;
      if (check.bpduGuard !== undefined && Boolean(i.bpduGuard) !== check.bpduGuard) return false;
      if (check.role !== undefined || check.state !== undefined) {
        const info = stpVlan(net, state.id, check.vlan ?? 1);
        const port = info?.ports.find((p) => p.name === name);
        if (!port) return false;
        if (check.role !== undefined && port.role !== check.role) return false;
        if (check.state !== undefined && port.state !== check.state) return false;
      }
      return true;
    }
    case 'password-policy': {
      if (check.minLength !== undefined && !(state.minPasswordLength !== undefined && state.minPasswordLength >= check.minLength)) return false;
      if (check.loginBlock && !state.loginBlock) return false;
      if (check.maxAttempts !== undefined && !(state.loginBlock && state.loginBlock.attempts <= check.maxAttempts)) return false;
      return true;
    }
    case 'exec-timeout': {
      const t = state.lines[check.line].execTimeout;
      return Boolean(t) && t!.minutes * 60 + t!.seconds <= check.maxMinutes * 60 && t!.minutes * 60 + t!.seconds > 0;
    }
    case 'aaa': {
      if (check.newModel !== undefined && state.aaaNewModel !== check.newModel) return false;
      if (check.loginLocal && !(state.aaaNewModel && state.aaaLoginDefault?.some((m) => m === 'local' || m === 'local-case'))) return false;
      return true;
    }
    case 'dhcp-snooping': {
      const s = state.dhcpSnooping;
      if (check.enabled === false) return !s?.enabled;
      if (!s?.enabled) return false;
      if (check.vlans && !check.vlans.every((v) => s.vlans.includes(v))) return false;
      if (check.optionInsert !== undefined && s.optionInsert !== check.optionInsert) return false;
      return true;
    }
    case 'port-trust': {
      const name = normalizeInterfaceName(check.interface);
      const i = name ? state.interfaces[name] : undefined;
      if (!i) return false;
      if (check.dhcpSnooping !== undefined && Boolean(i.dhcpSnoopingTrust) !== check.dhcpSnooping) return false;
      if (check.arpInspection !== undefined && Boolean(i.arpInspectionTrust) !== check.arpInspection) return false;
      return true;
    }
    case 'arp-inspection':
      return check.vlans.every((v) => state.arpInspectionVlans.includes(v));
    case 'management-api': {
      if (check.restconf !== undefined && state.restconf !== check.restconf) return false;
      if (check.netconf !== undefined && state.netconfYang !== check.netconf) return false;
      if (check.httpsServer !== undefined && state.httpSecureServer !== check.httpsServer) return false;
      if (check.httpAuthLocal !== undefined && state.httpAuthLocal !== check.httpAuthLocal) return false;
      return true;
    }
    case 'api-request': {
      const re = check.path ? new RegExp(check.path, 'i') : null;
      return state.apiRequests.some((r) => (check.method === undefined || r.method === check.method) && (re === null || re.test(r.path)) && (check.status === undefined || r.status === check.status));
    }
    case 'syslog': {
      if (check.host !== undefined && !state.loggingHosts.includes(check.host)) return false;
      if (check.trap !== undefined && state.loggingTrap !== check.trap) return false;
      return check.host !== undefined || check.trap !== undefined || state.loggingHosts.length > 0;
    }
    case 'snmp-community':
      return state.snmpCommunities.some((c) => (check.name === undefined || c.name === check.name) && (check.mode === undefined || c.mode === check.mode));
    case 'ntp-server':
      return state.ntpServers.includes(check.address);
  }
}

function sameSubnetText(ip: string, network: string, mask: string): boolean {
  const toInt = (s: string) => s.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
  return ((toInt(ip) & toInt(mask)) >>> 0) === ((toInt(network) & toInt(mask)) >>> 0);
}

export function grade(objectives: Objective[], net: NetworkState): GradeResult {
  const results: ObjectiveResult[] = objectives.map((o) => {
    const checks = o.checks.map((c) => ({ label: describe(c), passed: evaluateCheck(c, net) }));
    return { id: o.id, label: o.label, passed: checks.every((c) => c.passed), checks };
  });
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passed: results.length > 0 && passedCount === results.length,
    score: results.length === 0 ? 0 : Math.round((passedCount / results.length) * 100),
    objectives: results,
  };
}
