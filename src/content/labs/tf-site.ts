import { buildNetwork, executeHost, type NetworkState } from '../../engine';
import type { CloudSpec } from '../../engine/terraform/cloud';

/**
 * Every Terraform lab runs on ops1, an operations workstation with terraform installed,
 * and a NetLab Cloud account it can reach. Configuration lives in ~/infra.
 *
 * A lab can start from a clean directory, or from infrastructure a colleague already
 * built: `prepare` runs real terraform commands before the learner arrives (so state,
 * lock files and cloud objects are all genuine), and `after` makes the changes that
 * happen behind Terraform's back, such as a resize in the console or a stale lock.
 */
export const TF = 'ops1';
export const HOME = '/home/student';
export const INFRA = `${HOME}/infra`;
export const TOKEN = 'nlc_7f3a9e2b41c8d05e';
export const HCP_TOKEN = 'hcp.nlb.7Qx2mR9vK4tW';

export interface TfSiteOptions {
  /** Files by path; relative paths are under ~/infra. */
  files?: Record<string, string>;
  cloud?: CloudSpec;
  /** Leave NETCLOUD_TOKEN unset (for the labs about credentials). */
  noToken?: boolean;
  /** terraform (or shell) commands run in ~/infra before the lab starts. */
  prepare?: string[];
  /** Files written after preparation, replacing what was there (a colleague's edits). */
  edits?: Record<string, string>;
  /** Anything else that happened outside Terraform. */
  after?: (net: NetworkState) => void;
}

export function tfSite(opts: TfSiteOptions = {}): NetworkState {
  const files: Record<string, string> = {
    [`${HOME}/.bashrc`]: `# ~/.bashrc: executed by bash(1) for non-login shells.\nexport PATH="$HOME/bin:$PATH"\nalias ll='ls -alF'\n\n# NetLab Cloud credentials and default region for terraform and netcloud\n${opts.noToken ? '' : `export NETCLOUD_TOKEN=${TOKEN}\n`}export NETCLOUD_REGION=eu-west\n`,
    [`${INFRA}/.gitignore`]: '.terraform/\n*.tfstate\n*.tfstate.*\n*.tfplan\ncrash.log\n',
  };
  for (const [p, content] of Object.entries(opts.files ?? {})) files[p.startsWith('/') ? p : `${INFRA}/${p}`] = content;
  let net = buildNetwork({
    primary: TF,
    devices: [],
    hosts: [{ id: TF, name: 'ops1', ip: '192.168.1.20', mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server', linux: { hostname: 'ops1', cloud: opts.cloud ?? {}, files } }],
    links: [],
  });
  const lx = net.hosts[TF].linux!;
  lx.cwd = INFRA;
  if (!opts.noToken) lx.env.NETCLOUD_TOKEN = TOKEN;
  lx.env.NETCLOUD_REGION = 'eu-west';
  for (const cmd of opts.prepare ?? []) {
    const r = executeHost(net, TF, cmd);
    // A lab whose preparation fails is an authoring mistake: make it loud.
    if (r.output.some((l) => l.startsWith('│ Error:'))) throw new Error(`lab preparation failed on "${cmd}":\n${r.output.join('\n')}`);
    net = r.network;
  }
  const host = net.hosts[TF];
  const prepared = host.linux!;
  for (const [p, content] of Object.entries(opts.edits ?? {})) {
    const path = p.startsWith('/') ? p : `${INFRA}/${p}`;
    const node = prepared.fs[path];
    if (node) node.content = content;
    else prepared.fs[path] = { type: 'file', content, owner: 'student', group: 'student', mode: 0o644, mtime: 0 };
  }
  opts.after?.(net);
  // The learner starts with a clean history: preparation is not their work.
  host.commandHistory = [];
  host.acceptedHistory = [];
  prepared.history = [];
  prepared.outputs = [];
  prepared.terraformRuns = [];
  prepared.pending = undefined;
  prepared.cwd = INFRA;
  return net;
}

/** The provider requirements most labs start from. */
export function versions(extra = ''): string {
  return `terraform {
  required_version = ">= 1.10"

  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }${extra}
  }
}

provider "netcloud" {
  region = "eu-west"
}
`;
}

export const RANDOM_PROVIDER = `
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }`;

export const NETWORK = `resource "netcloud_network" "main" {
  name       = "lab"
  cidr_block = "10.0.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.0.1.0/24"
}
`;

/** Pre-existing cloud objects that are nothing to do with Terraform. */
export const IMAGE_2404 = 'img-ubuntu-2404-20260901';
export const IMAGE_2204 = 'img-ubuntu-2204-20260815';
