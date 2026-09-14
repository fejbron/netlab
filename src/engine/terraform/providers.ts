/**
 * Providers: what Terraform downloads at init and calls during plan and apply.
 *
 * Three real providers that need no cloud (hashicorp/random, hashicorp/local and the
 * built-in terraform_data), and netlab/netcloud, which manages the simulated NetLab
 * Cloud account. Schemas depend on the provider version, so pinning a version matters:
 * netcloud 2.0 renamed an instance argument, which is what an unpinned upgrade breaks.
 */
import { normalizePath, readFile as fsRead, writeFile as fsWrite, removeNode, getNode, parentPath, makeDir, type LinuxState } from '../linux/fs';
import { CloudError, cloudCreate, cloudDelete, cloudUpdate, findImage, objectsOf, SIZES, type CloudAccount, type CloudKind } from './cloud';
import { T, type TypeSpec, type Val, type ValObject } from './values';

export interface AttrDef {
  type: TypeSpec;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  forceNew?: boolean;
  sensitive?: boolean;
  writeOnly?: boolean;
  default?: Val;
}

export interface BlockDef {
  nesting: 'list' | 'single';
  attrs: Record<string, AttrDef>;
  min?: number;
  max?: number;
  forceNew?: boolean;
}

export interface ProviderCtx {
  lx: LinuxState;
  cloud?: CloudAccount;
  /** Evaluated provider block (plus environment fallbacks). */
  config: ValObject;
  version: string;
  /** Working directory, for local_file. */
  cwd: string;
  address: string;
  /** Seed for deterministic random values. */
  seed: string;
  log: (line: string) => void;
}

export class ProviderError extends Error {
  constructor(
    public summary: string,
    public detail = '',
  ) {
    super(summary);
  }
}

export interface ResourceDef {
  attrs: Record<string, AttrDef>;
  blocks?: Record<string, BlockDef>;
  importable?: boolean;
  /** Computed values that are known at plan time (defaults the provider fills in). */
  planKnown?: (cfg: ValObject, ctx: ProviderCtx) => ValObject;
  create: (cfg: ValObject, ctx: ProviderCtx) => ValObject;
  read: (state: ValObject, ctx: ProviderCtx) => ValObject | null;
  update?: (prior: ValObject, cfg: ValObject, ctx: ProviderCtx) => ValObject;
  delete: (state: ValObject, ctx: ProviderCtx) => void;
  import?: (id: string, ctx: ProviderCtx) => ValObject | null;
}

export interface DataDef {
  attrs: Record<string, AttrDef>;
  read: (cfg: ValObject, ctx: ProviderCtx) => ValObject;
}

export interface ProviderDef {
  /** registry.terraform.io/<namespace>/<type> */
  namespace: string;
  type: string;
  versions: string[];
  config: Record<string, AttrDef>;
  resources: (version: string) => Record<string, ResourceDef>;
  data: (version: string) => Record<string, DataDef>;
  ephemeral?: (version: string) => Record<string, DataDef>;
  /** Check the configuration (credentials, region) before any API call. */
  configure?: (ctx: ProviderCtx) => void;
  builtin?: boolean;
}

// ---------------------------------------------------------------------------
// versions

export function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('-')[0].split('.').map((x) => Number(x) || 0);
}

export function cmpVersion(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Does `version` satisfy a constraint string like "~> 3.6, != 3.6.1"? */
export function satisfies(version: string, constraint: string | undefined): boolean {
  if (!constraint || !constraint.trim()) return true;
  return constraint.split(',').every((part) => {
    const m = /^\s*(~>|>=|<=|!=|=|>|<)?\s*v?([0-9]+(?:\.[0-9]+){0,2})\s*$/.exec(part);
    if (!m) return false;
    const op = m[1] ?? '=';
    const want = m[2];
    const c = cmpVersion(version, want);
    switch (op) {
      case '=':
        return c === 0;
      case '!=':
        return c !== 0;
      case '>':
        return c > 0;
      case '>=':
        return c >= 0;
      case '<':
        return c < 0;
      case '<=':
        return c <= 0;
      case '~>': {
        const parts = want.split('.');
        if (c < 0) return false;
        const v = parseVersion(version);
        const w = parseVersion(want);
        // ~> 3.6 allows 3.x (x >= 6); ~> 3.6.1 allows 3.6.x (x >= 1).
        if (parts.length <= 1) return true;
        if (parts.length === 2) return v[0] === w[0];
        return v[0] === w[0] && v[1] === w[1];
      }
    }
    return false;
  });
}

export function validConstraint(constraint: string): boolean {
  return constraint.split(',').every((part) => /^\s*(~>|>=|<=|!=|=|>|<)?\s*v?[0-9]+(\.[0-9]+){0,2}\s*$/.test(part));
}

export function newestMatching(versions: string[], constraints: string[]): string | undefined {
  return [...versions].sort(cmpVersion).reverse().find((v) => constraints.every((c) => satisfies(v, c)));
}

// ---------------------------------------------------------------------------
// shared helpers

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function rng(seed: string) {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export function hexHash(text: string, len = 40): string {
  let out = '';
  let n = 0;
  while (out.length < len) out += hash(text + ':' + n++).toString(16).padStart(8, '0');
  return out.slice(0, len);
}

const S = (extra: Partial<AttrDef> = {}): AttrDef => ({ type: T.string, ...extra });
const N = (extra: Partial<AttrDef> = {}): AttrDef => ({ type: T.number, ...extra });
const B = (extra: Partial<AttrDef> = {}): AttrDef => ({ type: T.bool, ...extra });
const ID: AttrDef = { type: T.string, computed: true };
const KEEPERS: AttrDef = { type: T.map(T.string), optional: true, forceNew: true };

// ---------------------------------------------------------------------------
// hashicorp/random

const ADJECTIVES = ['able', 'bold', 'brave', 'calm', 'clever', 'cosmic', 'eager', 'fair', 'fancy', 'fast', 'gentle', 'golden', 'happy', 'humble', 'keen', 'lively', 'lucky', 'mellow', 'noble', 'proud', 'quick', 'quiet', 'rapid', 'sharp', 'smart', 'steady', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'wise'];
const ANIMALS = ['badger', 'beagle', 'bison', 'cobra', 'crane', 'dingo', 'eagle', 'falcon', 'ferret', 'gecko', 'heron', 'ibex', 'jaguar', 'koala', 'lemur', 'lynx', 'marten', 'moose', 'newt', 'ocelot', 'otter', 'panda', 'puffin', 'quail', 'raven', 'salmon', 'shrew', 'tapir', 'toucan', 'viper', 'walrus', 'zebra'];

function randomString(cfg: ValObject, seed: string): string {
  const r = rng(seed);
  let alphabet = '';
  if (cfg.lower !== false) alphabet += 'abcdefghijklmnopqrstuvwxyz';
  if (cfg.upper !== false) alphabet += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (cfg.numeric !== false && cfg.number !== false) alphabet += '0123456789';
  if (cfg.special !== false) alphabet += typeof cfg.override_special === 'string' ? cfg.override_special : '!#$%&*()-_=+[]{}<>:?';
  if (!alphabet) alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < Number(cfg.length); i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

const RANDOM_STRING_ATTRS: Record<string, AttrDef> = {
  length: N({ required: true, forceNew: true }),
  special: B({ optional: true, forceNew: true, default: true }),
  upper: B({ optional: true, forceNew: true, default: true }),
  lower: B({ optional: true, forceNew: true, default: true }),
  numeric: B({ optional: true, forceNew: true, default: true }),
  min_upper: N({ optional: true, forceNew: true, default: 0 }),
  min_lower: N({ optional: true, forceNew: true, default: 0 }),
  min_numeric: N({ optional: true, forceNew: true, default: 0 }),
  min_special: N({ optional: true, forceNew: true, default: 0 }),
  override_special: S({ optional: true, forceNew: true }),
  keepers: KEEPERS,
  id: ID,
};

const random: ProviderDef = {
  namespace: 'hashicorp',
  type: 'random',
  versions: ['3.5.1', '3.6.0', '3.6.3', '3.7.2'],
  config: {},
  resources: () => ({
    random_pet: {
      attrs: { length: N({ optional: true, forceNew: true, default: 2 }), prefix: S({ optional: true, forceNew: true }), separator: S({ optional: true, forceNew: true, default: '-' }), keepers: KEEPERS, id: ID },
      create: (cfg, ctx) => {
        const r = rng(ctx.seed);
        const words: string[] = [];
        const n = Number(cfg.length ?? 2);
        for (let i = 0; i < n - 1; i++) words.push(ADJECTIVES[Math.floor(r() * ADJECTIVES.length)]);
        words.push(ANIMALS[Math.floor(r() * ANIMALS.length)]);
        const sep = String(cfg.separator ?? '-');
        const id = (cfg.prefix ? `${cfg.prefix}${sep}` : '') + words.join(sep);
        return { ...cfg, id };
      },
      read: (s) => s,
      delete: () => undefined,
    },
    random_integer: {
      attrs: { min: N({ required: true, forceNew: true }), max: N({ required: true, forceNew: true }), seed: S({ optional: true, forceNew: true }), keepers: KEEPERS, result: N({ computed: true }), id: ID },
      create: (cfg, ctx) => {
        const min = Number(cfg.min);
        const max = Number(cfg.max);
        if (max < min) throw new ProviderError('Invalid attribute combination', 'min value must be less than or equal to max value');
        const result = min + Math.floor(rng(String(cfg.seed ?? ctx.seed))() * (max - min + 1));
        return { ...cfg, result, id: String(result) };
      },
      read: (s) => s,
      delete: () => undefined,
    },
    random_string: {
      attrs: { ...RANDOM_STRING_ATTRS, result: S({ computed: true }) },
      importable: true,
      create: (cfg, ctx) => {
        const result = randomString(cfg, ctx.seed);
        return { ...cfg, result, id: result };
      },
      read: (s) => s,
      delete: () => undefined,
      import: (id) => ({ length: id.length, special: true, upper: true, lower: true, numeric: true, min_upper: 0, min_lower: 0, min_numeric: 0, min_special: 0, override_special: null, keepers: null, result: id, id }),
    },
    random_password: {
      attrs: { ...RANDOM_STRING_ATTRS, result: S({ computed: true, sensitive: true }), bcrypt_hash: S({ computed: true, sensitive: true }) },
      create: (cfg, ctx) => {
        const result = randomString(cfg, ctx.seed);
        return { ...cfg, result, bcrypt_hash: '$2a$10$' + hexHash(result, 53), id: 'none' };
      },
      read: (s) => s,
      delete: () => undefined,
    },
    random_id: {
      attrs: { byte_length: N({ required: true, forceNew: true }), prefix: S({ optional: true, forceNew: true }), keepers: KEEPERS, hex: S({ computed: true }), dec: S({ computed: true }), b64_url: S({ computed: true }), b64_std: S({ computed: true }), id: ID },
      create: (cfg, ctx) => {
        const hex = hexHash(ctx.seed, Number(cfg.byte_length) * 2);
        const bytes = hex.match(/../g)!.map((b) => parseInt(b, 16));
        const b64 = btoa(String.fromCharCode(...bytes));
        const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const prefix = String(cfg.prefix ?? '');
        return { ...cfg, hex: prefix + hex, dec: prefix + BigInt('0x' + hex).toString(), b64_url: prefix + b64url, b64_std: prefix + b64, id: b64url };
      },
      read: (s) => s,
      delete: () => undefined,
    },
  }),
  data: () => ({}),
  ephemeral: (version): Record<string, DataDef> =>
    cmpVersion(version, '3.7.0') >= 0
      ? {
          random_password: {
            attrs: { ...RANDOM_STRING_ATTRS, result: S({ computed: true, sensitive: true }) },
            read: (cfg, ctx) => ({ ...cfg, result: randomString(cfg, ctx.seed + ':ephemeral') }),
          },
        }
      : {},
};

// ---------------------------------------------------------------------------
// hashicorp/local

function localPath(ctx: ProviderCtx, p: unknown): string {
  return normalizePath(ctx.cwd, String(p), `/home/${ctx.lx.user}`);
}

function writeLocal(ctx: ProviderCtx, cfg: ValObject, sensitive: boolean): ValObject {
  const path = localPath(ctx, cfg.filename);
  const content = String(cfg.content ?? '');
  // Parent directories are created, as the provider does.
  const parent = parentPath(path);
  if (!getNode(ctx.lx, parent)) {
    const e = makeDir(ctx.lx, parent, true);
    if (e) throw new ProviderError('Create local file error', `An unexpected error occurred while writing the file\n\nOriginal Error: ${e.error}`);
  }
  const e = fsWrite(ctx.lx, path, content, false, 'terraform');
  if (e) throw new ProviderError('Create local file error', `An unexpected error occurred while writing the file\n\nOriginal Error: open ${cfg.filename}: permission denied`);
  const node = getNode(ctx.lx, path);
  const perm = String(cfg.file_permission ?? (sensitive ? '0700' : '0777'));
  if (node) node.mode = parseInt(perm, 8) & 0o777 & ~0o022;
  return { ...cfg, file_permission: perm, directory_permission: String(cfg.directory_permission ?? '0777'), id: hexHash(content), content_md5: hexHash('md5' + content, 32), content_sha256: hexHash('sha256' + content, 64) };
}

const LOCAL_FILE_ATTRS = (sensitive: boolean): Record<string, AttrDef> => ({
  filename: S({ required: true, forceNew: true }),
  content: S({ optional: true, forceNew: true, sensitive }),
  file_permission: S({ optional: true, computed: true, forceNew: true }),
  directory_permission: S({ optional: true, computed: true, forceNew: true }),
  id: ID,
  content_md5: S({ computed: true }),
  content_sha256: S({ computed: true }),
});

const localResource = (sensitive: boolean): ResourceDef => ({
  attrs: LOCAL_FILE_ATTRS(sensitive),
  planKnown: (cfg) => ({ file_permission: cfg.file_permission ?? (sensitive ? '0700' : '0777'), directory_permission: cfg.directory_permission ?? '0777' }),
  create: (cfg, ctx) => writeLocal(ctx, cfg, sensitive),
  // local_file notices a file that was deleted or edited, and plans to write it again.
  read: (state, ctx) => {
    const r = fsRead({ ...ctx.lx, user: 'root' }, localPath(ctx, state.filename));
    if ('error' in r) return null;
    if (hexHash(r.content) !== state.id) return null;
    return state;
  },
  delete: (state, ctx) => {
    const path = localPath(ctx, state.filename);
    if (getNode(ctx.lx, path)) removeNode(ctx.lx, path, false, 'terraform');
  },
});

const local: ProviderDef = {
  namespace: 'hashicorp',
  type: 'local',
  versions: ['2.4.1', '2.5.1', '2.5.3'],
  config: {},
  resources: () => ({ local_file: localResource(false), local_sensitive_file: localResource(true) }),
  data: () => ({
    local_file: {
      attrs: { filename: S({ required: true }), content: S({ computed: true }), content_base64: S({ computed: true }), id: ID },
      read: (cfg, ctx) => {
        const r = fsRead(ctx.lx, localPath(ctx, cfg.filename));
        if ('error' in r) throw new ProviderError('Read local file data source error', `The file at given path cannot be read.\n\n+Original Error: open ${cfg.filename}: no such file or directory`);
        return { ...cfg, content: r.content, content_base64: btoa(unescape(encodeURIComponent(r.content))), id: hexHash(r.content) };
      },
    },
  }),
};

// ---------------------------------------------------------------------------
// terraform.io/builtin/terraform

const builtin: ProviderDef = {
  namespace: 'builtin',
  type: 'terraform',
  versions: ['1.12.2'],
  builtin: true,
  config: {},
  resources: () => ({
    terraform_data: {
      attrs: { input: { type: T.any, optional: true }, triggers_replace: { type: T.any, optional: true, forceNew: true }, output: { type: T.any, computed: true }, id: ID },
      create: (cfg, ctx) => ({ ...cfg, output: cfg.input ?? null, id: `${hexHash(ctx.seed, 8)}-${hexHash(ctx.seed + 'a', 4)}-${hexHash(ctx.seed + 'b', 4)}-${hexHash(ctx.seed + 'c', 4)}-${hexHash(ctx.seed + 'd', 12)}` }),
      read: (s) => s,
      update: (prior, cfg) => ({ ...prior, ...cfg, output: cfg.input ?? null }),
      delete: () => undefined,
    },
  }),
  data: () => ({
    terraform_remote_state: {
      attrs: { backend: S({ required: true }), config: { type: T.any, optional: true }, outputs: { type: T.any, computed: true } },
      read: (cfg) => ({ ...cfg, outputs: {} }),
    },
  }),
};

// ---------------------------------------------------------------------------
// netlab/netcloud

function cloudOf(ctx: ProviderCtx): CloudAccount {
  if (!ctx.cloud) throw new ProviderError('NetLab Cloud is unreachable', 'This host has no route to api.netlab.cloud.');
  return ctx.cloud;
}

function api(ctx: ProviderCtx, method: string, path: string) {
  ctx.log(`[DEBUG] provider.terraform-provider-netcloud_v${ctx.version}_x5: HTTP Request: ${method} https://api.${ctx.config.region}.netlab.cloud/v1${path}: @module=netcloud tf_resource_type=${ctx.address.split('.').slice(-2, -1)[0] ?? ''}`);
}

function apiResult(ctx: ProviderCtx, status: number, body: string) {
  ctx.log(`[DEBUG] provider.terraform-provider-netcloud_v${ctx.version}_x5: HTTP Response: status=${status} body=${body}: @module=netcloud`);
}

/** Run a cloud call, logging it, and turn API errors into what the provider reports. */
function call<T>(ctx: ProviderCtx, method: string, path: string, verb: string, fn: () => T): T {
  api(ctx, method, path);
  try {
    const r = fn();
    apiResult(ctx, method === 'POST' ? 201 : 200, '{...}');
    return r;
  } catch (e) {
    if (e instanceof CloudError) {
      apiResult(ctx, e.status, JSON.stringify({ error: e.code, detail: e.message }));
      // A 403 is reported the way many real providers report it: without the body.
      if (e.status === 403) throw new ProviderError(`${verb}: 403 Forbidden`, 'The NetLab Cloud API refused the request. Enable debug logging (TF_LOG=DEBUG) to see the response body.');
      throw new ProviderError(`${verb}: ${e.code}: ${e.message}`);
    }
    throw e;
  }
}

function cloudResource(kind: CloudKind, attrs: Record<string, AttrDef>, blocks: Record<string, BlockDef> = {}, map: { toCloud?: (cfg: ValObject) => Record<string, Val>; fromCloud?: (a: Record<string, Val>) => ValObject } = {}): ResourceDef {
  const path = `/${kind}s`;
  const toCloud = map.toCloud ?? ((cfg: ValObject) => ({ ...cfg }));
  const fromCloud = map.fromCloud ?? ((a: Record<string, Val>) => ({ ...a }));
  /**
   * The object Terraform stores. Secrets come from what Terraform sent (the API never
   * returns them), write-only arguments are never stored, and arguments the API does not
   * keep (a write-only version number) come from configuration.
   */
  const shape = (id: string, region: string, a: Record<string, Val>, known: ValObject, secrets: boolean): ValObject => {
    const out: ValObject = { id, region };
    const mapped = fromCloud(a);
    for (const k of Object.keys(blocks)) out[k] = mapped[k] ?? [];
    for (const [k, d] of Object.entries(attrs)) {
      if (k === 'id' || k === 'region') continue;
      if (d.writeOnly) out[k] = null;
      else if (d.sensitive) out[k] = secrets ? known[k] ?? null : null;
      else out[k] = mapped[k] !== undefined ? mapped[k] : known[k] ?? null;
    }
    return out;
  };
  return {
    attrs: { ...attrs, id: ID, region: S({ optional: true, computed: true, forceNew: true }) },
    blocks,
    importable: true,
    planKnown: (_cfg, ctx) => ({ region: _cfg.region ?? ctx.config.region }),
    create: (cfg, ctx) => {
      const acct = cloudOf(ctx);
      const region = String(cfg.region ?? ctx.config.region);
      const o = call(ctx, 'POST', path, `creating ${kind}`, () => cloudCreate(acct, kind, region, toCloud(cfg), 'terraform'));
      return shape(o.id, o.region, o.attrs, cfg, true);
    },
    read: (state, ctx) => {
      const acct = cloudOf(ctx);
      api(ctx, 'GET', `${path}/${state.id}`);
      const o = acct.objects[String(state.id)];
      if (!o || o.kind !== kind) {
        apiResult(ctx, 404, '{"error":"NotFound"}');
        return null;
      }
      apiResult(ctx, 200, '{...}');
      return shape(o.id, o.region, o.attrs, state, true);
    },
    update: (prior, cfg, ctx) => {
      const acct = cloudOf(ctx);
      const changes = toCloud(cfg);
      const o = call(ctx, 'PATCH', `${path}/${prior.id}`, `updating ${kind}`, () => cloudUpdate(acct, String(prior.id), changes, 'terraform'));
      return shape(o.id, o.region, o.attrs, { ...prior, ...cfg }, true);
    },
    delete: (state, ctx) => {
      const acct = cloudOf(ctx);
      call(ctx, 'DELETE', `${path}/${state.id}`, `deleting ${kind}`, () => cloudDelete(acct, String(state.id), 'terraform'));
    },
    import: (id, ctx) => {
      const acct = cloudOf(ctx);
      const o = acct.objects[id];
      if (!o || o.kind !== kind) return null;
      return shape(o.id, o.region, o.attrs, {}, false);
    },
  };
}

const TAGS: AttrDef = { type: T.map(T.string), optional: true };

const netcloud: ProviderDef = {
  namespace: 'netlab',
  type: 'netcloud',
  versions: ['1.0.0', '1.2.0', '1.4.1', '2.0.0'],
  config: { region: S({ optional: true }), token: S({ optional: true, sensitive: true }) },
  configure: (ctx) => {
    const acct = ctx.cloud;
    if (!ctx.config.region) throw new ProviderError('Missing region', 'The netcloud provider needs a region: set region in the provider block or the NETCLOUD_REGION environment variable.');
    if (!ctx.config.token) throw new ProviderError('No credentials for NetLab Cloud', 'Set the NETCLOUD_TOKEN environment variable, or token in the provider block. Prefer the environment variable: a token written into a .tf file ends up in version control.');
    ctx.log(`[DEBUG] provider.terraform-provider-netcloud_v${ctx.version}_x5: configuring client: region=${ctx.config.region} endpoint=https://api.${ctx.config.region}.netlab.cloud`);
    if (!acct) throw new ProviderError('NetLab Cloud is unreachable', 'This host has no route to api.netlab.cloud.');
    if (!acct.regions.includes(String(ctx.config.region))) {
      ctx.log(`[ERROR] provider.terraform-provider-netcloud_v${ctx.version}_x5: dial tcp: lookup api.${ctx.config.region}.netlab.cloud: no such host`);
      throw new ProviderError('Failed to configure the netcloud provider', `Get "https://api.${ctx.config.region}.netlab.cloud/v1/account": dial tcp: lookup api.${ctx.config.region}.netlab.cloud: no such host`);
    }
    if (ctx.config.token !== acct.token) {
      ctx.log(`[DEBUG] provider.terraform-provider-netcloud_v${ctx.version}_x5: HTTP Response: status=401 body={"error":"invalid_token"}`);
      throw new ProviderError('Failed to configure the netcloud provider', 'authenticating with NetLab Cloud: 401 Unauthorized: the API token was rejected');
    }
  },
  resources: (version) => {
    const v2 = cmpVersion(version, '2.0.0') >= 0;
    const withWo = cmpVersion(version, '1.4.0') >= 0;
    const sizeAttr = v2 ? 'machine_type' : 'size';
    return {
      netcloud_network: cloudResource('network', { name: S({ required: true }), cidr_block: S({ required: true, forceNew: true }), tags: TAGS }),
      netcloud_subnet: cloudResource('subnet', {
        network_id: S({ required: true, forceNew: true }),
        cidr_block: S({ required: true, forceNew: true }),
        zone: S({ optional: true, computed: true, forceNew: true }),
        public: B({ optional: true, default: false }),
        name: S({ optional: true }),
        tags: TAGS,
      }),
      netcloud_firewall: cloudResource(
        'firewall',
        { name: S({ required: true }), network_id: S({ required: true, forceNew: true }), description: S({ optional: true }) },
        { ingress: { nesting: 'list', attrs: { port: N({ required: true }), protocol: S({ optional: true, default: 'tcp' }), cidr_blocks: { type: T.list(T.string), required: true }, description: S({ optional: true }) } } },
      ),
      netcloud_instance: cloudResource(
        'instance',
        {
          name: S({ required: true }),
          [sizeAttr]: S({ required: true }),
          image: S({ required: true, forceNew: true }),
          subnet_id: S({ required: true, forceNew: true }),
          firewall_ids: { type: T.list(T.string), optional: true },
          user_data: S({ optional: true, forceNew: true }),
          tags: TAGS,
          private_ip: S({ computed: true }),
          public_ip: S({ computed: true }),
          status: S({ computed: true }),
        },
        {},
        v2
          ? {
              toCloud: (cfg) => {
                const { machine_type, ...rest } = cfg;
                return { ...rest, size: machine_type };
              },
              fromCloud: (a) => ({ ...a, machine_type: a.size }),
            }
          : {},
      ),
      netcloud_bucket: cloudResource('bucket', { name: S({ required: true, forceNew: true }), versioning: B({ optional: true, default: false }), force_destroy: B({ optional: true, default: false }), tags: TAGS, url: S({ computed: true }) }),
      netcloud_database: cloudResource(
        'database',
        {
          name: S({ required: true, forceNew: true }),
          engine: S({ required: true, forceNew: true }),
          engine_version: S({ required: true }),
          size: S({ required: true }),
          password: S({ optional: true, sensitive: true }),
          ...(withWo ? { password_wo: S({ optional: true, sensitive: true, writeOnly: true }), password_wo_version: N({ optional: true }) } : {}),
          endpoint: S({ computed: true }),
        },
        {},
        {
          toCloud: (cfg) => {
            const { password_wo, password_wo_version, ...rest } = cfg;
            void password_wo_version;
            return password_wo !== undefined && password_wo !== null ? { ...rest, password: password_wo } : rest;
          },
        },
      ),
    };
  },
  data: () => ({
    netcloud_image: {
      attrs: { family: S({ required: true }), id: ID, name: S({ computed: true }), created: S({ computed: true }) },
      read: (cfg, ctx) => {
        const acct = cloudOf(ctx);
        api(ctx, 'GET', `/images?family=${cfg.family}`);
        const img = findImage(acct, String(cfg.family));
        if (!img) {
          apiResult(ctx, 200, '{"images":[]}');
          throw new ProviderError('No image found', `no image in family "${cfg.family}"; families available: ${[...new Set(acct.images.map((i) => i.family))].join(', ')}`);
        }
        apiResult(ctx, 200, '{...}');
        return { family: cfg.family, id: img.id, name: img.name, created: img.created };
      },
    },
    netcloud_zones: {
      attrs: { names: { type: T.list(T.string), computed: true }, id: ID },
      read: (_cfg, ctx) => ({ names: ['a', 'b', 'c'].map((z) => `${ctx.config.region}-${z}`), id: String(ctx.config.region) }),
    },
    netcloud_network: {
      attrs: { name: S({ required: true }), id: ID, cidr_block: S({ computed: true }) },
      read: (cfg, ctx) => {
        const acct = cloudOf(ctx);
        api(ctx, 'GET', `/networks?name=${cfg.name}`);
        const net = objectsOf(acct, 'network', String(ctx.config.region)).find((n) => n.attrs.name === cfg.name);
        if (!net) throw new ProviderError('No network found', `no network named "${cfg.name}" in ${ctx.config.region}`);
        return { name: cfg.name, id: net.id, cidr_block: net.attrs.cidr_block };
      },
    },
  }),
};

export { SIZES };

export const PROVIDERS: Record<string, ProviderDef> = {
  'hashicorp/random': random,
  'hashicorp/local': local,
  'netlab/netcloud': netcloud,
  'terraform.io/builtin/terraform': builtin,
};

/** "hashicorp/random" from a source string, applying the default registry and namespace. */
export function normalizeSource(source: string): string {
  const parts = source.toLowerCase().replace(/^registry\.terraform\.io\//, '').split('/');
  if (parts.length === 1) return `hashicorp/${parts[0]}`;
  return parts.join('/');
}

export function providerFor(source: string): ProviderDef | undefined {
  return PROVIDERS[normalizeSource(source)];
}
