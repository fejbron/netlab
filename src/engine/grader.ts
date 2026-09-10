import { normalizeInterfaceName } from './interfaces';
import { renderConfigBody } from './ios/show';
import type { NetworkState } from './network';
import type { CliErrorKind, DeviceState, LineState, Mode, PortMode } from './types';

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
      }
    | { type: 'enable-secret'; equals?: string }
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
    | { type: 'ping'; target: string; success?: boolean }
    | { type: 'route'; destination: string; mask: string; via?: string }
    | { type: 'route-absent'; destination: string; mask: string }
  );

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
  }
}

function sameList(a: 'all' | number[], b: 'all' | number[]): boolean {
  if (a === 'all' || b === 'all') return a === b;
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function deviceFor(check: Check, net: NetworkState): DeviceState | undefined {
  return net.devices[check.device ?? net.primary];
}

export function evaluateCheck(check: Check, net: NetworkState): boolean {
  if (check.type === 'ping') {
    const id = check.device ?? net.primary;
    const pings = net.devices[id]?.pings ?? net.hosts[id]?.pings ?? [];
    return pings.some((p) => p.target === check.target && (check.success === undefined || p.success === check.success));
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
      if (check.description !== undefined && (i.description ?? '').toLowerCase() !== check.description.toLowerCase()) return false;
      if (check.trunkAllowed !== undefined && !sameList(i.trunkAllowed, check.trunkAllowed)) return false;
      if (check.nativeVlan !== undefined && i.nativeVlan !== check.nativeVlan) return false;
      if (check.ipAddress !== undefined && i.ipAddress !== check.ipAddress) return false;
      if (check.subnetMask !== undefined && i.subnetMask !== check.subnetMask) return false;
      if (check.encapsulation !== undefined && i.encapsulation?.vlan !== check.encapsulation) return false;
      return true;
    }
    case 'enable-secret':
      return state.enableSecret !== undefined && (check.equals === undefined || state.enableSecret === check.equals);
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
  }
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
