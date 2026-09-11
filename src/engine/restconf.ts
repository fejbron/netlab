/**
 * A small RESTCONF server for the simulated devices: enough of the ietf-interfaces
 * and Cisco-IOS-XE-native models for learners to read a device as JSON and push a
 * change through the API from the PC terminal (curl).
 */
import { normalizeInterfaceName } from './interfaces';
import { isValidIp, isValidMask } from './ios/net';
import type { NetworkState } from './network';
import { ifaceUp, isLoopback, isSubinterface } from './network';
import type { ApiRequest, DeviceState, InterfaceState } from './types';

export type ApiMethod = ApiRequest['method'];

export interface ApiCall {
  method: ApiMethod;
  /** Path after the host, e.g. "/restconf/data/ietf-interfaces:interfaces". */
  path: string;
  body?: string;
  user?: string;
  password?: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed' };

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Unknown';
}

function error(status: number, tag: string, message: string, type = 'application'): ApiResponse {
  return { status, body: { errors: { error: [{ 'error-message': message, 'error-tag': tag, 'error-type': type }] } } };
}

/** JSON view of one interface in the ietf-interfaces model. */
export function interfaceJson(net: NetworkState, dev: DeviceState, i: InterfaceState): Record<string, unknown> {
  const type = isLoopback(i.name) ? 'iana-if-type:softwareLoopback' : isSubinterface(i.name) ? 'iana-if-type:l2vlan' : 'iana-if-type:ethernetCsmacd';
  const out: Record<string, unknown> = { name: i.name };
  if (i.description) out.description = i.description;
  out.type = type;
  out.enabled = !i.shutdown;
  out['ietf-ip:ipv4'] = i.ipAddress && i.subnetMask ? { address: [{ ip: i.ipAddress, netmask: i.subnetMask }] } : {};
  out['ietf-ip:ipv6'] = {};
  void net;
  void dev;
  return out;
}

function interfaceStateJson(net: NetworkState, dev: DeviceState, i: InterfaceState): Record<string, unknown> {
  const up = ifaceUp(net, dev.id, i.name);
  return { name: i.name, 'admin-status': i.shutdown ? 'down' : 'up', 'oper-status': up ? 'up' : 'down', 'if-index': Object.keys(dev.interfaces).indexOf(i.name) + 1 };
}

function sortedInterfaces(dev: DeviceState): InterfaceState[] {
  return Object.values(dev.interfaces).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function parseBody(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined || text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Accept "ietf-interfaces:interface" or the unprefixed "interface" wrapper, with or without a list. */
function unwrap(body: unknown, ...keys: string[]): Record<string, unknown> | null {
  const obj = asObject(body);
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    const inner = Array.isArray(v) ? v[0] : v;
    const o = asObject(inner);
    if (o) return o;
  }
  return null;
}

function applyInterface(i: InterfaceState, patch: Record<string, unknown>, replace: boolean): ApiResponse | null {
  if (patch.name !== undefined && normalizeInterfaceName(String(patch.name)) !== i.name) return error(400, 'invalid-value', 'name in payload does not match the URI');
  if (patch.description !== undefined && typeof patch.description !== 'string') return error(400, 'invalid-value', 'description must be a string');
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return error(400, 'invalid-value', 'enabled must be true or false');
  const v4 = asObject(patch['ietf-ip:ipv4'] ?? patch.ipv4);
  let addr: { ip: string; netmask: string } | null | undefined;
  if (v4) {
    const list = Array.isArray(v4.address) ? v4.address : [];
    const first = asObject(list[0]);
    if (first) {
      const ip = String(first.ip ?? '');
      const netmask = String(first.netmask ?? '');
      if (!isValidIp(ip) || !isValidMask(netmask)) return error(400, 'invalid-value', 'ipv4 address needs a valid ip and netmask');
      addr = { ip, netmask };
    } else if (replace) addr = null;
  }
  if (typeof patch.description === 'string') i.description = patch.description || undefined;
  else if (replace) i.description = undefined;
  if (typeof patch.enabled === 'boolean') i.shutdown = !patch.enabled;
  if (addr) {
    i.ipAddress = addr.ip;
    i.subnetMask = addr.netmask;
  } else if (addr === null) {
    i.ipAddress = undefined;
    i.subnetMask = undefined;
  }
  return null;
}

/**
 * Answer one RESTCONF request on a device. The caller has already checked that the
 * request reached the device and that the HTTP server is listening.
 */
export function restconfRequest(net: NetworkState, deviceId: string, call: ApiCall): ApiResponse {
  const dev = net.devices[deviceId];
  const log = (status: number) => {
    dev.apiRequests.push({ method: call.method, path: call.path, status, user: call.user });
    return status;
  };
  const done = (r: ApiResponse): ApiResponse => {
    log(r.status);
    return r;
  };
  if (!dev.restconf) return done({ status: 404, body: '404 Not Found' });
  const user = dev.users.find((u) => u.username === call.user && u.password === call.password && u.privilege >= 15);
  if (!dev.httpAuthLocal || !user) return done(error(401, 'access-denied', 'Access denied', 'protocol'));

  const raw = call.path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw.startsWith('restconf/data/')) return done(error(404, 'invalid-value', 'uri keypath not found'));
  const rest = decodeURIComponent(raw.slice('restconf/data/'.length));
  const [head, ...tail] = rest.split('/');
  const m = call.method;

  // ietf-interfaces:interfaces[/interface=<name>]
  if (head === 'ietf-interfaces:interfaces') {
    if (tail.length === 0) {
      if (m !== 'GET') return done(error(405, 'operation-not-supported', 'method not allowed on the whole list', 'protocol'));
      return done({ status: 200, body: { 'ietf-interfaces:interfaces': { interface: sortedInterfaces(dev).map((i) => interfaceJson(net, dev, i)) } } });
    }
    const key = tail.join('/');
    const name = key.startsWith('interface=') ? normalizeInterfaceName(key.slice('interface='.length)) : null;
    const i = name ? dev.interfaces[name] : undefined;
    if (!i) return done(error(404, 'invalid-value', 'uri keypath not found'));
    if (m === 'GET') return done({ status: 200, body: { 'ietf-interfaces:interface': interfaceJson(net, dev, i) } });
    if (m === 'PATCH' || m === 'PUT') {
      const parsed = parseBody(call.body);
      if (!parsed.ok) return done(error(400, 'malformed-message', 'malformed json', 'protocol'));
      const patch = unwrap(parsed.value, 'ietf-interfaces:interface', 'interface');
      if (!patch) return done(error(400, 'malformed-message', 'expected an ietf-interfaces:interface object', 'protocol'));
      const problem = applyInterface(i, patch, m === 'PUT');
      return done(problem ?? { status: 204 });
    }
    return done(error(405, 'operation-not-supported', 'method not allowed', 'protocol'));
  }

  if (head === 'ietf-interfaces:interfaces-state') {
    if (m !== 'GET') return done(error(405, 'operation-not-supported', 'operational data is read-only', 'protocol'));
    if (tail.length === 0) return done({ status: 200, body: { 'ietf-interfaces:interfaces-state': { interface: sortedInterfaces(dev).map((i) => interfaceStateJson(net, dev, i)) } } });
    const key = tail.join('/');
    const name = key.startsWith('interface=') ? normalizeInterfaceName(key.slice('interface='.length)) : null;
    const i = name ? dev.interfaces[name] : undefined;
    if (!i) return done(error(404, 'invalid-value', 'uri keypath not found'));
    return done({ status: 200, body: { 'ietf-interfaces:interface': interfaceStateJson(net, dev, i) } });
  }

  // Cisco-IOS-XE-native:native[/hostname]
  if (head === 'Cisco-IOS-XE-native:native') {
    if (tail.length === 0) {
      if (m !== 'GET') return done(error(405, 'operation-not-supported', 'method not allowed on the native tree', 'protocol'));
      return done({ status: 200, body: { 'Cisco-IOS-XE-native:native': { version: '17.9', hostname: dev.hostname, username: dev.users.map((u) => ({ name: u.username, privilege: u.privilege })) } } });
    }
    if (tail.join('/') === 'hostname') {
      if (m === 'GET') return done({ status: 200, body: { 'Cisco-IOS-XE-native:hostname': dev.hostname } });
      if (m === 'PATCH' || m === 'PUT') {
        const parsed = parseBody(call.body);
        if (!parsed.ok) return done(error(400, 'malformed-message', 'malformed json', 'protocol'));
        const obj = asObject(parsed.value);
        const value = obj?.['Cisco-IOS-XE-native:hostname'] ?? obj?.hostname;
        if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) return done(error(400, 'invalid-value', 'hostname must be a valid device name'));
        dev.hostname = value;
        return done({ status: 204 });
      }
      return done(error(405, 'operation-not-supported', 'method not allowed', 'protocol'));
    }
    return done(error(404, 'invalid-value', 'uri keypath not found'));
  }

  return done(error(404, 'invalid-value', 'uri keypath not found'));
}
