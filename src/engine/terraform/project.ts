/**
 * The working directory Terraform keeps next to a configuration: the .terraform data
 * directory (installed providers and modules, the backend record, the selected
 * workspace) and the dependency lock file. All of it is real files on the host, so
 * `ls -la .terraform` and `cat .terraform.lock.hcl` show what init actually did.
 */
import { getNode, listDir, makeDir, normalizePath, readFile, writeFile, type LinuxState } from '../linux/fs';
import { DiagError, parseHcl } from './hcl';
import { hexHash } from './providers';
import { canonical, type Val } from './values';

export function dataDir(cwd: string): string {
  return `${cwd === '/' ? '' : cwd}/.terraform`;
}

function ensureDir(lx: LinuxState, dir: string) {
  if (!getNode(lx, dir)) makeDir(lx, dir, true);
}

function write(lx: LinuxState, path: string, content: string) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  ensureDir(lx, dir);
  writeFile(lx, path, content, false, 'terraform');
}

// ---------------------------------------------------------------------------
// dependency lock file

export interface LockEntry {
  source: string;
  version: string;
  constraints?: string;
  hashes: string[];
}

export const LOCK_FILE = '.terraform.lock.hcl';

export function providerHashes(source: string, version: string): string[] {
  const h1 = btoa(hexHash(`${source}@${version}`, 32)).slice(0, 43) + '=';
  return [`h1:${h1}`, `zh:${hexHash('zh' + source + version, 64)}`, `zh:${hexHash('zh2' + source + version, 64)}`];
}

export function readLock(lx: LinuxState, cwd: string): Record<string, LockEntry> | { error: string } {
  const r = readFile(lx, `${cwd}/${LOCK_FILE}`);
  if ('error' in r) return {};
  try {
    const body = parseHcl(r.content, LOCK_FILE);
    const out: Record<string, LockEntry> = {};
    for (const b of body.blocks) {
      if (b.type !== 'provider' || b.labels.length !== 1) continue;
      const source = b.labels[0].replace(/^registry\.terraform\.io\//, '');
      const lit = (name: string) => {
        const e = b.body.attrs[name]?.expr;
        return e && e.k === 'lit' && typeof e.v === 'string' ? e.v : undefined;
      };
      const hashes = b.body.attrs.hashes?.expr;
      out[source] = { source, version: lit('version') ?? '', constraints: lit('constraints'), hashes: hashes && hashes.k === 'tuple' ? hashes.items.map((x) => (x.k === 'lit' ? String(x.v) : '')) : [] };
    }
    return out;
  } catch (e) {
    if (e instanceof DiagError) return { error: `Failed to read dependency lock file: ${e.diags[0].summary} in ${LOCK_FILE} on line ${e.diags[0].pos?.line}` };
    throw e;
  }
}

export function lockText(entries: Record<string, LockEntry>): string {
  const lines = ['# This file is maintained automatically by "terraform init".', '# Manual edits may be lost in future updates.', ''];
  for (const e of Object.values(entries).sort((a, b) => a.source.localeCompare(b.source))) {
    lines.push(`provider "registry.terraform.io/${e.source}" {`);
    lines.push(`  version     = "${e.version}"`);
    if (e.constraints) lines.push(`  constraints = "${e.constraints}"`);
    lines.push('  hashes = [');
    for (const h of e.hashes) lines.push(`    "${h}",`);
    lines.push('  ]', '}', '');
  }
  return lines.join('\n');
}

export function writeLock(lx: LinuxState, cwd: string, entries: Record<string, LockEntry>) {
  write(lx, `${cwd}/${LOCK_FILE}`, lockText(entries));
}

export function providerBinary(cwd: string, source: string, version: string): string {
  const type = source.split('/').pop()!;
  return `${dataDir(cwd)}/providers/registry.terraform.io/${source}/${version}/linux_amd64/terraform-provider-${type}_v${version}_x5`;
}

export function isProviderInstalled(lx: LinuxState, cwd: string, source: string, version: string): boolean {
  return Boolean(getNode(lx, providerBinary(cwd, source, version)));
}

export function installProvider(lx: LinuxState, cwd: string, source: string, version: string) {
  write(lx, providerBinary(cwd, source, version), `ELF terraform provider ${source} v${version} (simulated)\n`);
  const node = getNode(lx, providerBinary(cwd, source, version));
  if (node) node.mode = 0o755;
}

// ---------------------------------------------------------------------------
// modules

export interface ModuleRecord {
  Key: string;
  Source: string;
  Version?: string;
  Dir: string;
}

export function readModules(lx: LinuxState, cwd: string): ModuleRecord[] {
  const r = readFile(lx, `${dataDir(cwd)}/modules/modules.json`);
  if ('error' in r) return [];
  try {
    return JSON.parse(r.content).Modules ?? [];
  } catch {
    return [];
  }
}

export function writeModules(lx: LinuxState, cwd: string, records: ModuleRecord[]) {
  write(lx, `${dataDir(cwd)}/modules/modules.json`, JSON.stringify({ Modules: records }) + '\n');
}

/** Modules published in the (simulated) public registry. */
export const REGISTRY_MODULES: Record<string, Record<string, Record<string, string>>> = {
  'netlab/network/netcloud': {
    '1.0.0': networkModule(false),
    '1.1.0': networkModule(false),
    '1.2.0': networkModule(true),
  },
};

function networkModule(tags: boolean): Record<string, string> {
  return {
    'README.md': `# NetLab Cloud network module\n\nCreates a network and one subnet per entry in \`subnets\`.\n\n## Inputs\n\n- name (string, required)\n- cidr_block (string, required)\n- subnets (map of object({ cidr = string, zone = optional(string), public = optional(bool, false) }))\n${tags ? '- tags (map(string), default {})\n' : ''}\n## Outputs\n\n- network_id\n- subnet_ids (map of subnet name to id)\n`,
    'main.tf': `resource "netcloud_network" "this" {
  name       = var.name
  cidr_block = var.cidr_block${tags ? '\n  tags       = var.tags' : ''}
}

resource "netcloud_subnet" "this" {
  for_each = var.subnets

  network_id = netcloud_network.this.id
  name       = "\${var.name}-\${each.key}"
  cidr_block = each.value.cidr
  zone       = each.value.zone
  public     = each.value.public
}
`,
    'variables.tf': `variable "name" {
  type        = string
  description = "Name of the network."
}

variable "cidr_block" {
  type        = string
  description = "Address range of the network."
}

variable "subnets" {
  type = map(object({
    cidr   = string
    zone   = optional(string)
    public = optional(bool, false)
  }))
  default     = {}
  description = "Subnets to create, keyed by name."
}
${tags ? `
variable "tags" {
  type    = map(string)
  default = {}
}
` : ''}`,
    'outputs.tf': `output "network_id" {
  value = netcloud_network.this.id
}

output "subnet_ids" {
  value = { for name, s in netcloud_subnet.this : name => s.id }
}
`,
    'versions.tf': `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = ">= 1.0, < 2.0"
    }
  }
}
`,
  };
}

export function isLocalSource(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

export function installRegistryModule(lx: LinuxState, cwd: string, key: string, version: string, source: string): string {
  const dir = `${dataDir(cwd)}/modules/${key}`;
  for (const [name, content] of Object.entries(REGISTRY_MODULES[source][version])) write(lx, `${dir}/${name}`, content);
  return `.terraform/modules/${key}`;
}

export function moduleDir(_cwd: string, parentDir: string, source: string): string {
  return normalizePath(parentDir, source, '/');
}

// ---------------------------------------------------------------------------
// backend record and workspace

export interface BackendRecord {
  type: string;
  config: Record<string, Val>;
  hash: string;
}

export function backendHash(type: string, config: Record<string, Val>): string {
  return String(parseInt(hexHash(type + canonical(config), 8), 16));
}

export function readBackendRecord(lx: LinuxState, cwd: string): BackendRecord | null {
  const r = readFile(lx, `${dataDir(cwd)}/terraform.tfstate`);
  if ('error' in r) return null;
  try {
    const j = JSON.parse(r.content);
    if (!j.backend) return null;
    return { type: j.backend.type, config: j.backend.config ?? {}, hash: String(j.backend.hash) };
  } catch {
    return null;
  }
}

export function writeBackendRecord(lx: LinuxState, cwd: string, rec: BackendRecord | null) {
  const path = `${dataDir(cwd)}/terraform.tfstate`;
  if (!rec) {
    if (getNode(lx, path)) writeFile(lx, path, JSON.stringify({ version: 3, terraform_version: '1.12.2' }, null, 2) + '\n');
    return;
  }
  write(lx, path, JSON.stringify({ version: 3, terraform_version: '1.12.2', backend: { type: rec.type, config: rec.config, hash: Number(rec.hash) } }, null, 2) + '\n');
}

export function currentWorkspace(lx: LinuxState, cwd: string, env: Record<string, string>): string {
  if (env.TF_WORKSPACE) return env.TF_WORKSPACE;
  const r = readFile(lx, `${dataDir(cwd)}/environment`);
  return 'error' in r ? 'default' : r.content.trim() || 'default';
}

export function selectWorkspace(lx: LinuxState, cwd: string, name: string) {
  write(lx, `${dataDir(cwd)}/environment`, name);
}

export function hasDataDir(lx: LinuxState, cwd: string): boolean {
  return Boolean(getNode(lx, dataDir(cwd)));
}

export function listTfFiles(lx: LinuxState, dir: string): string[] {
  return listDir(lx, dir).filter((n) => n.endsWith('.tf'));
}
