import { describe, expect, it } from 'vitest';
import { buildNetwork, executeHost, type NetworkState } from './index';
import { evaluate } from './terraform/eval';
import { formatHcl } from './terraform/fmt';
import { DiagError, parseExpression, parseHcl } from './terraform/hcl';
import { satisfies } from './terraform/providers';
import { flatten, parseState } from './terraform/state';
import type { CloudSpec } from './terraform/cloud';

const TOKEN = 'nlc_7f3a9e2b41c8d05e';

function host(files: Record<string, string>, cloud: CloudSpec = {}): NetworkState {
  const net = buildNetwork({ primary: 'ops1', devices: [], hosts: [{ id: 'ops1', linux: { hostname: 'ops1', cloud, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith('/') ? k : `/home/student/infra/${k}`, v])) } }], links: [] });
  const lx = net.hosts.ops1.linux!;
  lx.cwd = '/home/student/infra';
  lx.env.NETCLOUD_TOKEN = TOKEN;
  lx.env.NETCLOUD_REGION = 'eu-west';
  return net;
}

/** Run lines; returns the network and the output of the last line. */
function run(net: NetworkState, ...lines: string[]): { net: NetworkState; out: string } {
  let out = '';
  for (const line of lines) {
    const r = executeHost(net, 'ops1', line);
    net = r.network;
    out = r.output.join('\n');
  }
  return { net, out };
}

function file(net: NetworkState, path: string): string {
  return net.hosts.ops1.linux!.fs[`/home/student/infra/${path}`]?.content ?? '';
}

function state(net: NetworkState) {
  const s = parseState(file(net, 'terraform.tfstate'), 'terraform.tfstate');
  if ('error' in s) throw new Error(s.error);
  return flatten(s);
}

const VERSIONS = `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }
  }
}
`;

const scope = { lookup: () => null, arity: () => 1, readFile: () => undefined };

describe('HCL', () => {
  it('parses blocks, templates, heredocs and for expressions', () => {
    const body = parseHcl('locals {\n  a = [for s in ["x", "y"] : upper(s) if s != "y"]\n  b = <<-EOT\n    hello ${upper("w")}\n  EOT\n  c = true ? "t" : "f"\n}\n', 'main.tf');
    const locals = body.blocks[0].body.attrs;
    expect(evaluate(locals.a.expr, scope)).toEqual(['X']);
    expect(evaluate(locals.b.expr, scope)).toBe('hello W\n');
    expect(evaluate(locals.c.expr, scope)).toBe('t');
  });

  it('reports a missing newline after an argument with its line', () => {
    try {
      parseHcl('resource "a" "b" {\n  name = "x" extra\n}\n', 'main.tf');
      expect.unreachable();
    } catch (e) {
      expect((e as DiagError).diags[0]).toMatchObject({ summary: 'Missing newline after argument', pos: { line: 2 } });
    }
  });

  it('computes subnets like Terraform', () => {
    expect(evaluate(parseExpression('cidrsubnet("10.0.0.0/16", 8, 3)'), scope)).toBe('10.0.3.0/24');
    expect(evaluate(parseExpression('cidrhost("10.0.1.0/24", 10)'), scope)).toBe('10.0.1.10');
  });

  it('understands version constraints', () => {
    expect(satisfies('1.4.1', '~> 1.4')).toBe(true);
    expect(satisfies('2.0.0', '~> 1.4')).toBe(false);
    expect(satisfies('1.4.9', '~> 1.4.1')).toBe(true);
    expect(satisfies('1.5.0', '~> 1.4.1')).toBe(false);
    expect(satisfies('3.6.3', '>= 3.0, < 3.7')).toBe(true);
  });

  it('formats like terraform fmt, and leaves formatted files alone', () => {
    const messy = 'resource "a" "b" {\nname="x"\n    longer_name = [1,2]\n  tags = {\n  env="dev"\n  }\n}\n';
    const tidy = formatHcl(messy);
    expect(tidy).toBe('resource "a" "b" {\n  name        = "x"\n  longer_name = [1, 2]\n  tags        = {\n    env = "dev"\n  }\n}\n');
    expect(formatHcl(tidy)).toBe(tidy);
  });
});

describe('terraform workflow', () => {
  const MAIN = `resource "netcloud_network" "main" {
  name       = "lab"
  cidr_block = "10.0.0.0/16"
}
`;

  it('asks before applying, and only yes approves', () => {
    let { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN }), 'terraform init', 'terraform apply');
    expect(net.hosts.ops1.linux!.pending).toMatchObject({ kind: 'terraform', prompt: '  Enter a value: ' });
    const cancelled = run(net, 'no');
    expect(cancelled.out).toContain('Apply cancelled.');
    ({ net } = run(cancelled.net, 'terraform apply'));
    const applied = run(net, 'yes');
    expect(applied.out).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.');
    expect(Object.values(applied.net.hosts.ops1.linux!.cloud!.objects)).toHaveLength(1);
  });

  it('refuses to plan before init, naming the provider', () => {
    const { out } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN }), 'terraform plan');
    expect(out).toContain('Inconsistent dependency lock file');
    expect(out).toContain('registry.terraform.io/netlab/netcloud');
  });

  it('suggests the argument that was meant', () => {
    const { out } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN.replace('cidr_block', 'cidr_blok') }), 'terraform init', 'terraform validate');
    // The detail wraps inside the error box, so read it as one paragraph.
    expect(out.replace(/\n│ /g, ' ')).toContain('An argument named "cidr_blok" is not expected here. Did you mean "cidr_block"?');
  });

  it('keeps write-only values and the secrets they replace out of state', () => {
    const cfg = `terraform {
  required_providers {
    netcloud = { source = "netlab/netcloud", version = "~> 1.4" }
    random   = { source = "hashicorp/random", version = "~> 3.7" }
  }
}
ephemeral "random_password" "db" {
  length = 20
}
resource "netcloud_database" "db" {
  name                = "orders"
  engine              = "postgres"
  engine_version      = "16"
  size                = "small"
  password_wo         = ephemeral.random_password.db.result
  password_wo_version = 1
}
`;
    const { net } = run(host({ 'main.tf': cfg }), 'terraform init', 'terraform apply -auto-approve');
    const db = state(net).get('netcloud_database.db')!;
    expect(db.attrs.password).toBeNull();
    expect(db.attrs.password_wo).toBeNull();
    expect(db.attrs.password_wo_version).toBe(1);
    expect(run(net, 'terraform plan').out).toContain('No changes.');
  });

  it('rejects an ephemeral value in an ordinary argument', () => {
    const cfg = `terraform {
  required_providers {
    netcloud = { source = "netlab/netcloud", version = "~> 1.4" }
    random   = { source = "hashicorp/random", version = "~> 3.7" }
  }
}
ephemeral "random_password" "db" {
  length = 20
}
resource "netcloud_database" "db" {
  name           = "orders"
  engine         = "postgres"
  engine_version = "16"
  size           = "small"
  password       = ephemeral.random_password.db.result
}
`;
    expect(run(host({ 'main.tf': cfg }), 'terraform init', 'terraform plan').out).toContain('Invalid use of ephemeral value');
  });

  it('imports through an import block even when nothing else changes', () => {
    const cloud: CloudSpec = { objects: [{ kind: 'bucket', id: 'legacy-assets', attrs: { name: 'legacy-assets', versioning: true, force_destroy: false, objects: 3, url: 'https://legacy-assets.storage.netlab.cloud', tags: {} } }] };
    const cfg = `${VERSIONS}
import {
  to = netcloud_bucket.assets
  id = "legacy-assets"
}
resource "netcloud_bucket" "assets" {
  name       = "legacy-assets"
  versioning = true
  tags       = {}
}
`;
    const { net, out } = run(host({ 'main.tf': cfg }, cloud), 'terraform init', 'terraform apply -auto-approve');
    expect(out).toContain('Apply complete! Resources: 1 imported, 0 added, 0 changed, 0 destroyed.');
    expect(state(net).get('netcloud_bucket.assets')?.attrs.id).toBe('legacy-assets');
  });

  it('destroys a removed resource only after its dependents stop using it', () => {
    const before = `${VERSIONS}
resource "netcloud_network" "main" {
  name       = "lab"
  cidr_block = "10.0.0.0/16"
}
resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.0.1.0/24"
}
resource "netcloud_firewall" "old" {
  name       = "old"
  network_id = netcloud_network.main.id
}
resource "netcloud_instance" "web" {
  name         = "web"
  size         = "small"
  image        = "img-ubuntu-2404-20260901"
  subnet_id    = netcloud_subnet.app.id
  firewall_ids = [netcloud_firewall.old.id]
}
`;
    const after = before.replace('resource "netcloud_firewall" "old"', 'resource "netcloud_firewall" "new"').replace('name       = "old"', 'name       = "new"').replace('netcloud_firewall.old.id', 'netcloud_firewall.new.id');
    let { net } = run(host({ 'main.tf': before }), 'terraform init', 'terraform apply -auto-approve');
    net.hosts.ops1.linux!.fs['/home/student/infra/main.tf'].content = after;
    const r = run(net, 'terraform apply -auto-approve');
    expect(r.out).toContain('Apply complete! Resources: 1 added, 1 changed, 1 destroyed.');
    const lines = r.out.split('\n');
    expect(lines.findIndex((l) => l.startsWith('netcloud_instance.web: Modifying'))).toBeLessThan(lines.findIndex((l) => l.startsWith('netcloud_firewall.old: Destroying')));
    ({ net } = r);
    expect(run(net, 'terraform plan').out).toContain('No changes.');
  });

  it('treats a moved block as a rename, not a replacement', () => {
    let { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN }), 'terraform init', 'terraform apply -auto-approve');
    net.hosts.ops1.linux!.fs['/home/student/infra/main.tf'].content = MAIN.replace('"main"', '"core"') + '\nmoved {\n  from = netcloud_network.main\n  to   = netcloud_network.core\n}\n';
    const r = run(net, 'terraform plan');
    expect(r.out).toContain('# netcloud_network.main has moved to netcloud_network.core');
    expect(r.out).toContain('Plan: 0 to add, 0 to change, 0 to destroy.');
  });

  it('refuses a saved plan once state has moved on', () => {
    let { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN }), 'terraform init', 'terraform plan -out=first.tfplan', 'terraform apply -auto-approve');
    const r = run(net, 'terraform apply first.tfplan');
    expect(r.out).toContain('Saved plan is stale');
    ({ net } = r);
  });

  it('reports drift in a refresh-only plan', () => {
    const cfg = `${VERSIONS}
resource "netcloud_network" "main" {
  name       = "lab"
  cidr_block = "10.0.0.0/16"
}
resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.0.1.0/24"
}
resource "netcloud_instance" "web" {
  name      = "web"
  size      = "small"
  image     = "img-ubuntu-2404-20260901"
  subnet_id = netcloud_subnet.app.id
}
`;
    const { net } = run(host({ 'main.tf': cfg }), 'terraform init', 'terraform apply -auto-approve');
    const id = Object.values(net.hosts.ops1.linux!.cloud!.objects).find((o) => o.kind === 'instance')!.id;
    const r = run(net, `netcloud instances resize ${id} --size large`, 'terraform plan -refresh-only');
    expect(r.out).toContain('Note: Objects have changed outside of Terraform');
    expect(r.out).toContain('~ size = "small" -> "large"');
  });

  it('waits on a held remote lock until force-unlock releases it', () => {
    const url = 'https://state.netlab.cloud/t/infra.tfstate';
    const backend = `terraform {\n  backend "http" {\n    address      = "${url}"\n    lock_address = "${url}/lock"\n  }\n}\n`;
    let { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN, 'backend.tf': backend }, { stateService: { [url]: {} } }), 'terraform init', 'terraform apply -auto-approve');
    net.hosts.ops1.linux!.cloud!.stateService[url].lock = { ID: 'abc-123', Operation: 'OperationTypeApply', Info: '', Who: 'ci@runner', Version: '1.12.2', Created: 'earlier', Path: '' };
    expect(run(net, 'terraform plan').out).toContain('Error acquiring the state lock');
    ({ net } = run(net, 'terraform force-unlock abc-123', 'yes'));
    expect(net.hosts.ops1.linux!.cloud!.stateService[url].lock).toBeUndefined();
    expect(run(net, 'terraform plan').out).toContain('No changes.');
  });

  it('evaluates expressions at terraform console', () => {
    const { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': 'variable "cidr" {\n  default = "10.8.0.0/16"\n}\n' }), 'terraform console');
    expect(run(net, 'cidrsubnet(var.cidr, 8, 2)').out).toBe('"10.8.2.0/24"');
  });

  it('writes a debug log to TF_LOG_PATH', () => {
    const { net } = run(host({ 'versions.tf': VERSIONS, 'main.tf': MAIN }), 'terraform init', 'TF_LOG=DEBUG TF_LOG_PATH=tf.log terraform plan');
    expect(file(net, 'tf.log')).toMatch(/\[INFO\]  Terraform version: 1\.12\.2/);
  });
});
