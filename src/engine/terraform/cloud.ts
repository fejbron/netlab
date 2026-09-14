/**
 * NetLab Cloud: a small, vendor-neutral cloud account for Terraform to manage.
 *
 * It holds networks, subnets, firewalls, instances, storage buckets and databases, and it
 * enforces the rules that make infrastructure mistakes visible: a subnet has to sit
 * inside its network and must not overlap a sibling, a network with subnets cannot be
 * deleted, bucket names are global, a region has an instance quota. Terraform reaches it
 * through the netcloud provider; people reach it through the `netcloud` CLI, which is
 * how changes happen "outside Terraform" in the drift and import labs.
 */
import type { Val } from './values';
import { cidrText, parseCidr } from './eval';

export type CloudKind = 'network' | 'subnet' | 'firewall' | 'instance' | 'bucket' | 'database';

export interface CloudObject {
  id: string;
  kind: CloudKind;
  region: string;
  attrs: Record<string, Val>;
}

export interface CloudImage {
  id: string;
  family: string;
  name: string;
  created: string;
}

export interface LockInfo {
  ID: string;
  Operation: string;
  Info: string;
  Who: string;
  Version: string;
  Created: string;
  Path: string;
}

export interface HcpVariable {
  value: string;
  category: 'terraform' | 'env';
  hcl?: boolean;
  sensitive?: boolean;
}

export interface HcpWorkspace {
  name: string;
  project: string;
  tags: string[];
  /** Terraform state JSON, when the workspace has any. */
  state?: string;
  vars: Record<string, HcpVariable>;
  runs: number;
  locked?: boolean;
}

export interface HcpPolicy {
  name: string;
  enforcement: 'advisory' | 'soft-mandatory' | 'hard-mandatory';
  /** What the policy checks. The rules themselves are implemented in hcp.ts. */
  rule: 'allowed-instance-sizes' | 'required-tags';
  sizes?: string[];
  tags?: string[];
}

export interface HcpOrg {
  hostname: string;
  organization: string;
  token: string;
  projects: string[];
  workspaces: Record<string, HcpWorkspace>;
  /** Policy sets, applied to every workspace in these projects (or everywhere). */
  policySets: Array<{ name: string; projects?: string[]; policies: HcpPolicy[] }>;
}

export interface CloudAccount {
  account: string;
  /** The API token that authenticates. */
  token: string;
  regions: string[];
  seq: number;
  objects: Record<string, CloudObject>;
  /** Bucket names already owned by somebody else. */
  takenBuckets: string[];
  images: CloudImage[];
  /** Instances allowed per region. */
  instanceQuota: number;
  activity: Array<{ who: string; action: string; id: string }>;
  /** A generic HTTP state service (Terraform's http backend), by address. */
  stateService: Record<string, { state?: string; lock?: LockInfo }>;
  hcp?: HcpOrg;
}

export interface CloudObjectSpec {
  kind: CloudKind;
  id?: string;
  region?: string;
  attrs: Record<string, Val>;
}

export interface CloudSpec {
  account?: string;
  token?: string;
  objects?: CloudObjectSpec[];
  takenBuckets?: string[];
  instanceQuota?: number;
  stateService?: Record<string, { state?: string; lock?: LockInfo }>;
  hcp?: Partial<HcpOrg> & { organization: string; token: string };
}

export const SIZES = ['small', 'medium', 'large', 'xlarge'];
export const ZONES = ['a', 'b', 'c'];

export class CloudError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const PREFIX: Record<CloudKind, string> = { network: 'net', subnet: 'subnet', firewall: 'fw', instance: 'i', bucket: 'bkt', database: 'db' };

export function createCloud(spec: CloudSpec = {}): CloudAccount {
  const acct: CloudAccount = {
    account: spec.account ?? 'netlab-training',
    token: spec.token ?? 'nlc_7f3a9e2b41c8d05e',
    regions: ['eu-west', 'us-east', 'ap-south'],
    seq: 0,
    objects: {},
    takenBuckets: spec.takenBuckets ?? ['backups', 'logs', 'assets', 'terraform-state'],
    images: [
      { id: 'img-ubuntu-2404-20260901', family: 'ubuntu-2404', name: 'Ubuntu 24.04 LTS (2026-09-01)', created: '2026-09-01' },
      { id: 'img-ubuntu-2404-20260715', family: 'ubuntu-2404', name: 'Ubuntu 24.04 LTS (2026-07-15)', created: '2026-07-15' },
      { id: 'img-ubuntu-2204-20260815', family: 'ubuntu-2204', name: 'Ubuntu 22.04 LTS (2026-08-15)', created: '2026-08-15' },
      { id: 'img-debian-12-20260820', family: 'debian-12', name: 'Debian 12 (2026-08-20)', created: '2026-08-20' },
    ],
    instanceQuota: spec.instanceQuota ?? 10,
    activity: [],
    stateService: spec.stateService ?? {},
  };
  if (spec.hcp) {
    acct.hcp = {
      hostname: 'app.terraform.io',
      projects: ['Default Project'],
      workspaces: {},
      policySets: [],
      ...spec.hcp,
    };
  }
  for (const o of spec.objects ?? []) {
    const id = o.id ?? nextId(acct, o.kind);
    acct.objects[id] = { id, kind: o.kind, region: o.region ?? 'eu-west', attrs: { ...o.attrs } };
    if (o.kind === 'bucket') acct.objects[id].attrs.name ??= id;
  }
  return acct;
}

/** Deterministic, realistic-looking identifiers: net-4f2a9c1e. */
export function nextId(acct: CloudAccount, kind: CloudKind): string {
  acct.seq += 1;
  let h = 0x811c9dc5 ^ acct.seq;
  for (const c of kind + acct.account) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  h = Math.imul(h ^ (acct.seq * 2654435761), 0x01000193) >>> 0;
  return `${PREFIX[kind]}-${h.toString(16).padStart(8, '0')}`;
}

export function objectsOf(acct: CloudAccount, kind: CloudKind, region?: string): CloudObject[] {
  return Object.values(acct.objects).filter((o) => o.kind === kind && (region === undefined || o.region === region));
}

function need(acct: CloudAccount, id: unknown, kind: CloudKind, region: string): CloudObject {
  const o = typeof id === 'string' ? acct.objects[id] : undefined;
  const label = kind === 'network' ? 'Network' : kind === 'subnet' ? 'Subnet' : kind === 'firewall' ? 'Firewall' : 'Object';
  if (!o || o.kind !== kind) throw new CloudError(404, `Invalid${label}.NotFound`, `The ${kind} ID '${String(id)}' does not exist`);
  if (o.region !== region) throw new CloudError(400, `Invalid${label}.Region`, `The ${kind} '${String(id)}' is in ${o.region}, not ${region}`);
  return o;
}

function overlaps(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  const bits = Math.min(x.bits, y.bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((x.base & mask) >>> 0) === ((y.base & mask) >>> 0);
}

function contains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (i.bits < o.bits) return false;
  const mask = o.bits === 0 ? 0 : (0xffffffff << (32 - o.bits)) >>> 0;
  return ((i.base & mask) >>> 0) === o.base;
}

function validCidr(cidr: unknown, min: number, max: number, what: string): string {
  if (typeof cidr !== 'string') throw new CloudError(400, 'InvalidParameterValue', `${what} is required`);
  let p: { base: number; bits: number };
  try {
    p = parseCidr(cidr);
  } catch {
    throw new CloudError(400, 'InvalidParameterValue', `Value (${cidr}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
  }
  if (cidrText(p.base, p.bits) !== cidr) throw new CloudError(400, 'InvalidParameterValue', `Value (${cidr}) for parameter cidrBlock is invalid. The address has host bits set; did you mean ${cidrText(p.base, p.bits)}?`);
  if (p.bits < min || p.bits > max) throw new CloudError(400, 'InvalidParameterValue', `The CIDR '${cidr}' is invalid: ${what} must be between /${min} and /${max}.`);
  return cidr;
}

function intIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function log(acct: CloudAccount, who: string, action: string, id: string) {
  acct.activity.push({ who, action, id });
  if (acct.activity.length > 200) acct.activity.shift();
}

/** Create an object after checking it the way the API would. Returns the stored object. */
export function cloudCreate(acct: CloudAccount, kind: CloudKind, region: string, input: Record<string, Val>, who: string): CloudObject {
  if (!acct.regions.includes(region)) throw new CloudError(400, 'InvalidRegion', `unknown region "${region}"; valid regions are ${acct.regions.join(', ')}`);
  const attrs: Record<string, Val> = { ...input };
  switch (kind) {
    case 'network':
      validCidr(attrs.cidr_block, 16, 28, 'a network');
      if (!attrs.name) throw new CloudError(400, 'MissingParameter', 'name is required');
      break;
    case 'subnet': {
      const net = need(acct, attrs.network_id, 'network', region);
      validCidr(attrs.cidr_block, 16, 28, 'a subnet');
      if (!contains(String(net.attrs.cidr_block), String(attrs.cidr_block))) {
        throw new CloudError(400, 'InvalidSubnet.Range', `The CIDR '${attrs.cidr_block}' is not within network ${net.id} (${net.attrs.cidr_block})`);
      }
      const clash = objectsOf(acct, 'subnet').find((s) => s.attrs.network_id === net.id && overlaps(String(s.attrs.cidr_block), String(attrs.cidr_block)));
      if (clash) throw new CloudError(400, 'InvalidSubnet.Conflict', `The CIDR '${attrs.cidr_block}' conflicts with subnet ${clash.id} (${clash.attrs.cidr_block})`);
      attrs.zone = attrs.zone ?? `${region}-a`;
      if (!ZONES.map((z) => `${region}-${z}`).includes(String(attrs.zone))) throw new CloudError(400, 'InvalidZone', `zone "${attrs.zone}" is not in region ${region}`);
      attrs.public = attrs.public ?? false;
      break;
    }
    case 'firewall': {
      need(acct, attrs.network_id, 'network', region);
      checkRules(attrs.ingress);
      break;
    }
    case 'instance': {
      const subnet = need(acct, attrs.subnet_id, 'subnet', region);
      const size = attrs.size;
      if (typeof size !== 'string' || !SIZES.includes(size)) throw new CloudError(400, 'InvalidParameterValue', `invalid instance size "${String(size)}"; valid sizes are ${SIZES.join(', ')}`);
      if (!acct.images.some((i) => i.id === attrs.image)) throw new CloudError(400, 'InvalidImage.NotFound', `The image id '${String(attrs.image)}' does not exist`);
      for (const fw of (attrs.firewall_ids as string[] | null) ?? []) need(acct, fw, 'firewall', region);
      const used = objectsOf(acct, 'instance', region).length;
      if (used >= acct.instanceQuota) {
        throw new CloudError(403, 'InstanceLimitExceeded', `account ${acct.account} allows ${acct.instanceQuota} instances in ${region}; ${used} in use`);
      }
      attrs.private_ip = allocateIp(acct, subnet);
      attrs.public_ip = subnet.attrs.public ? `203.0.113.${10 + (acct.seq % 200)}` : null;
      attrs.status = 'running';
      break;
    }
    case 'bucket': {
      const name = String(attrs.name ?? '');
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new CloudError(400, 'InvalidBucketName', `The bucket name "${name}" is not valid: use 3 to 63 lowercase letters, digits and hyphens`);
      if (acct.takenBuckets.includes(name)) throw new CloudError(409, 'BucketAlreadyExists', `The bucket name "${name}" is already taken by another account. Bucket names are global across NetLab Cloud.`);
      if (objectsOf(acct, 'bucket').some((b) => b.attrs.name === name)) throw new CloudError(409, 'BucketAlreadyOwnedByYou', `You already own a bucket named "${name}"`);
      attrs.versioning = attrs.versioning ?? false;
      attrs.objects = attrs.objects ?? 0;
      attrs.url = `https://${name}.storage.netlab.cloud`;
      break;
    }
    case 'database': {
      if (!['postgres', 'mysql'].includes(String(attrs.engine))) throw new CloudError(400, 'InvalidParameterValue', `engine must be postgres or mysql, got "${String(attrs.engine)}"`);
      const pw = attrs.password;
      if (typeof pw !== 'string' || pw.length < 12) throw new CloudError(400, 'InvalidParameterValue', 'the master password must be at least 12 characters');
      attrs.endpoint = `${attrs.name}.db.${region}.netlab.cloud:${attrs.engine === 'mysql' ? 3306 : 5432}`;
      break;
    }
  }
  const id = kind === 'bucket' ? String(attrs.name) : nextId(acct, kind);
  const obj: CloudObject = { id, kind, region, attrs };
  acct.objects[id] = obj;
  log(acct, who, `create ${kind}`, id);
  return obj;
}

function checkRules(rules: Val) {
  for (const r of (rules as Array<Record<string, Val>> | null) ?? []) {
    const port = Number(r.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CloudError(400, 'InvalidPermission', `port ${String(r.port)} is out of range 0-65535`);
    if (!['tcp', 'udp', 'icmp'].includes(String(r.protocol ?? 'tcp'))) throw new CloudError(400, 'InvalidPermission', `protocol must be tcp, udp or icmp`);
    for (const c of (r.cidr_blocks as string[] | null) ?? []) validCidr(c, 0, 32, 'a rule source');
  }
}

function allocateIp(acct: CloudAccount, subnet: CloudObject): string {
  const { base, bits } = parseCidr(String(subnet.attrs.cidr_block));
  const taken = new Set(objectsOf(acct, 'instance').filter((i) => i.attrs.subnet_id === subnet.id).map((i) => i.attrs.private_ip));
  const size = Math.pow(2, 32 - bits);
  for (let n = 10; n < size - 1; n++) {
    const ip = intIp(base + n);
    if (!taken.has(ip)) return ip;
  }
  throw new CloudError(400, 'InsufficientFreeAddressesInSubnet', `subnet ${subnet.id} has no free addresses`);
}

/** Change updatable attributes in place. */
export function cloudUpdate(acct: CloudAccount, id: string, changes: Record<string, Val>, who: string): CloudObject {
  const o = acct.objects[id];
  if (!o) throw new CloudError(404, 'NotFound', `The object '${id}' does not exist`);
  if (o.kind === 'instance' && 'size' in changes && !SIZES.includes(String(changes.size))) throw new CloudError(400, 'InvalidParameterValue', `invalid instance size "${String(changes.size)}"; valid sizes are ${SIZES.join(', ')}`);
  if (o.kind === 'instance' && changes.firewall_ids) for (const fw of changes.firewall_ids as string[]) need(acct, fw, 'firewall', o.region);
  if (o.kind === 'firewall' && 'ingress' in changes) checkRules(changes.ingress);
  if (o.kind === 'database' && 'password' in changes && (typeof changes.password !== 'string' || changes.password.length < 12)) throw new CloudError(400, 'InvalidParameterValue', 'the master password must be at least 12 characters');
  Object.assign(o.attrs, changes);
  log(acct, who, `update ${o.kind}`, id);
  return o;
}

export function cloudDelete(acct: CloudAccount, id: string, who: string): void {
  const o = acct.objects[id];
  if (!o) return;
  if (o.kind === 'network') {
    const deps = Object.values(acct.objects).filter((x) => (x.kind === 'subnet' || x.kind === 'firewall') && x.attrs.network_id === id);
    if (deps.length) throw new CloudError(409, 'DependencyViolation', `The network '${id}' has dependencies and cannot be deleted: ${deps.map((d) => d.id).join(', ')}`);
  }
  if (o.kind === 'subnet') {
    const deps = objectsOf(acct, 'instance').filter((x) => x.attrs.subnet_id === id);
    if (deps.length) throw new CloudError(409, 'DependencyViolation', `The subnet '${id}' has dependencies and cannot be deleted: ${deps.map((d) => d.id).join(', ')}`);
  }
  if (o.kind === 'firewall') {
    const deps = objectsOf(acct, 'instance').filter((x) => ((x.attrs.firewall_ids as string[] | null) ?? []).includes(id));
    if (deps.length) throw new CloudError(409, 'DependencyViolation', `The firewall '${id}' is attached to ${deps.map((d) => d.id).join(', ')}`);
  }
  if (o.kind === 'bucket' && Number(o.attrs.objects ?? 0) > 0 && !o.attrs.force_destroy) {
    throw new CloudError(409, 'BucketNotEmpty', `The bucket '${id}' is not empty (${o.attrs.objects} objects). Empty it first, or set force_destroy = true.`);
  }
  delete acct.objects[id];
  log(acct, who, `delete ${o.kind}`, id);
}

export function findImage(acct: CloudAccount, family: string): CloudImage | undefined {
  return acct.images.filter((i) => i.family === family).sort((a, b) => b.created.localeCompare(a.created))[0];
}

// ---------------------------------------------------------------------------
// the netcloud CLI

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').replace(/\s+$/, '');
  return [line(headers), ...rows.map(line)];
}

const show = (v: Val): string => (v === null || v === undefined ? '-' : Array.isArray(v) ? (v.length ? v.join(',') : '-') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}=${String(x)}`).join(',') || '-' : String(v));

const KIND_OF: Record<string, CloudKind> = { network: 'network', networks: 'network', subnet: 'subnet', subnets: 'subnet', firewall: 'firewall', firewalls: 'firewall', instance: 'instance', instances: 'instance', bucket: 'bucket', buckets: 'bucket', database: 'database', databases: 'database' };

const COLUMNS: Record<CloudKind, string[]> = {
  network: ['name', 'cidr_block'],
  subnet: ['network_id', 'cidr_block', 'zone', 'public'],
  firewall: ['name', 'network_id'],
  instance: ['name', 'size', 'image', 'private_ip', 'status', 'tags'],
  bucket: ['versioning', 'objects'],
  database: ['name', 'engine', 'engine_version', 'size'],
};

export const NETCLOUD_HELP = [
  'Usage: netcloud <resource> <command> [options]',
  '',
  'Resources: networks, subnets, firewalls, instances, buckets, databases, images',
  '',
  'Commands:',
  '  list [--region R]                 list objects',
  '  show ID                           print one object',
  '  instances resize ID --size SIZE   change an instance size',
  '  instances tag ID KEY=VALUE        add or change a tag',
  '  instances delete ID               delete an instance',
  '  buckets create NAME               create a bucket',
  '  activity                          who changed what, most recent last',
  '',
  'Authentication: set NETCLOUD_TOKEN. Region: --region, or NETCLOUD_REGION (default eu-west).',
];

/** Run `netcloud ...`. Returns output lines and an exit code. */
export function netcloudCli(acct: CloudAccount | undefined, args: string[], env: Record<string, string>, user: string): { out: string[]; err: string[]; code: number } {
  const err = (lines: string[], code = 1) => ({ out: [], err: lines, code });
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return { out: NETCLOUD_HELP, err: [], code: 0 };
  if (!acct) return err(['netcloud: no NetLab Cloud account is reachable from this host']);
  if (!env.NETCLOUD_TOKEN) return err(['netcloud: not authenticated: set NETCLOUD_TOKEN to your API token']);
  if (env.NETCLOUD_TOKEN !== acct.token) return err(['netcloud: 401 Unauthorized: the API token was rejected']);
  const opts: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const [k, v] = args[i].slice(2).split('=');
      opts[k] = v ?? args[++i] ?? '';
    } else pos.push(args[i]);
  }
  const region = opts.region ?? env.NETCLOUD_REGION ?? 'eu-west';
  const who = `${user} (netcloud CLI)`;
  const [res, cmd = 'list', ...rest] = pos;
  if (res === 'activity') {
    return { out: table(['WHO', 'ACTION', 'ID'], acct.activity.map((a) => [a.who, a.action, a.id])), err: [], code: 0 };
  }
  if (res === 'images') {
    return { out: table(['ID', 'FAMILY', 'NAME'], acct.images.map((i) => [i.id, i.family, i.name])), err: [], code: 0 };
  }
  const kind = KIND_OF[res];
  if (!kind) return err([`netcloud: unknown resource "${res}". Run netcloud help.`]);
  try {
    switch (cmd) {
      case 'list': {
        const rows = objectsOf(acct, kind, opts.region ? region : undefined).map((o) => [o.id, o.region, ...COLUMNS[kind].map((c) => show(o.attrs[c]))]);
        return { out: table(['ID', 'REGION', ...COLUMNS[kind].map((c) => c.toUpperCase())], rows), err: [], code: 0 };
      }
      case 'show': {
        const o = acct.objects[rest[0]];
        if (!o || o.kind !== kind) return err([`netcloud: ${kind} "${rest[0] ?? ''}" not found`]);
        const keys = Object.keys(o.attrs).filter((k) => !/password/.test(k)).sort();
        const width = Math.max(6, ...keys.map((k) => k.length));
        return { out: [`${'id'.padEnd(width)}  ${o.id}`, `${'region'.padEnd(width)}  ${o.region}`, ...keys.map((k) => `${k.padEnd(width)}  ${show(o.attrs[k])}`)], err: [], code: 0 };
      }
      case 'resize': {
        if (kind !== 'instance') break;
        const o = acct.objects[rest[0]];
        if (!o || o.kind !== 'instance') return err([`netcloud: instance "${rest[0] ?? ''}" not found`]);
        if (!opts.size) return err(['netcloud: --size is required']);
        cloudUpdate(acct, o.id, { size: opts.size }, who);
        return { out: [`Resized ${o.id} to ${opts.size}.`], err: [], code: 0 };
      }
      case 'tag': {
        if (kind !== 'instance') break;
        const o = acct.objects[rest[0]];
        if (!o || o.kind !== 'instance') return err([`netcloud: instance "${rest[0] ?? ''}" not found`]);
        const [k, v] = (rest[1] ?? '').split('=');
        if (!k || v === undefined) return err(['netcloud: expected KEY=VALUE']);
        cloudUpdate(acct, o.id, { tags: { ...((o.attrs.tags as Record<string, Val>) ?? {}), [k]: v } }, who);
        return { out: [`Tagged ${o.id} with ${k}=${v}.`], err: [], code: 0 };
      }
      case 'delete': {
        const o = acct.objects[rest[0]];
        if (!o || o.kind !== kind) return err([`netcloud: ${kind} "${rest[0] ?? ''}" not found`]);
        cloudDelete(acct, o.id, who);
        return { out: [`Deleted ${o.id}.`], err: [], code: 0 };
      }
      case 'create': {
        if (kind !== 'bucket') break;
        const o = cloudCreate(acct, 'bucket', region, { name: rest[0] ?? '', versioning: false, force_destroy: false, tags: {} }, who);
        return { out: [`Created bucket ${o.id} in ${region}.`], err: [], code: 0 };
      }
    }
  } catch (e) {
    if (e instanceof CloudError) return err([`netcloud: ${e.status} ${e.code}: ${e.message}`]);
    throw e;
  }
  return err([`netcloud: "${cmd}" is not a command for ${res}. Run netcloud help.`]);
}
