import type { Lab } from '../types';
import { IMAGE_2404, tfSite, TF, TOKEN } from './tf-site';

const MODULE = 'tf-exams';

const REQUIREMENTS = `# Storefront: production network

Build this in ~/infra with Terraform. Nothing exists yet.

## Providers
- netlab/netcloud, constrained to the 1.4 series ("~> 1.4"), region eu-west.
- hashicorp/random, constrained to "~> 3.7".

## Inputs
- A variable "env", a string defaulting to "prod", that only accepts "dev", "staging" or "prod".

## Network
- A network named "<env>-net" with the range 10.50.0.0/16.
- Subnets created with for_each, as netcloud_subnet.this["web"] and netcloud_subnet.this["db"]:
  - web: 10.50.1.0/24, public
  - db:  10.50.2.0/24, not public

## Web tier
- A firewall named "web" in the network allowing only port 443 from 0.0.0.0/0.
- Two instances with count, netcloud_instance.web[0] and [1], named "web-0" and "web-1",
  size medium, in the web subnet, behind the firewall.
- Their image is looked up with a netcloud_image data source for the family ubuntu-2404,
  never typed in.

## Database
- netcloud_database.orders: name "orders", postgres, engine version "16", size small.
- Its password must never be stored in state: use an ephemeral random_password
  (length 24) with password_wo, and password_wo_version = 1.
- It must be impossible to destroy by accident.

## Outputs
- web_ips: the private IPs of the web instances, as a list.
- db_endpoint: the database endpoint.

## Done means
- terraform fmt leaves every file unchanged.
- A plan shows no changes.
`;

const TAKEOVER_VERSIONS = `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }
  }
}

provider "netcloud" {
  region = "eu-west"
  token  = "${TOKEN}"
}
`;

const TAKEOVER_MAIN = `resource "netcloud_network" "main" {
  name       = "reports"
  cidr_block = "10.52.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.52.1.0/24"
}

resource "netcloud_instance" "server1" {
  name      = "reports-web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const HANDOVER = `# Reports infrastructure: handover

You now own ~/infra. The previous owner left in a hurry. Before anything else is
built, bring it up to standard:

1. The NetLab Cloud API token is written into versions.tf. Remove it; the provider
   reads NETCLOUD_TOKEN from the environment.
2. netcloud_instance.server1 should be called netcloud_instance.web. Rename it
   without replacing the server.
3. The archive bucket netlab-reports-archive was made by hand in the console. Manage
   it as netcloud_bucket.archive, with the settings it has today.
4. Someone resized the web server in the console. The configuration is right: the
   server must be small.
5. State must move to the team's http backend, with locking:
     address:        https://state.netlab.cloud/teams/reports/infra.tfstate
     lock_address:   https://state.netlab.cloud/teams/reports/infra.tfstate/lock
     unlock_address: https://state.netlab.cloud/teams/reports/infra.tfstate/lock
   Do not leave a local state file behind.
6. Finish with terraform fmt clean and a plan that shows no changes.
`;

const REPORTS_URL = 'https://state.netlab.cloud/teams/reports/infra.tfstate';

export const tfExamLabs: Lab[] = [
  {
    id: 'tf-31-exam-production-network',
    moduleId: MODULE,
    order: 1,
    title: 'Exam: Build a Production Network',
    difficulty: 'Advanced',
    estimatedMinutes: 35,
    description: 'Build a complete two-tier environment from a written specification: pinned providers, validated inputs, for_each and count, a data source, a protected database with a write-only password, and outputs.',
    scenario: 'This is an exam: there are no hints. The specification is in ~/infra/requirements.md; read it with cat and build exactly what it asks for. Write the configuration in as many files as you like, initialise, apply, and check your own work with terraform fmt and terraform plan before you submit.',
    concepts: ['Providers and versions', 'Variables with validation', 'for_each, count and data sources', 'Lifecycle and write-only secrets', 'Outputs and formatting'],
    hints: [],
    isExam: true,
    createState: () => tfSite({ files: { 'requirements.md': REQUIREMENTS } }),
    objectives: [
      { id: 'providers', label: 'Pinned providers', checks: [{ type: 'tf-lock', device: TF, provider: 'netlab/netcloud', version: '1.4.1' }, { type: 'tf-lock', device: TF, provider: 'hashicorp/random' }] },
      { id: 'input', label: 'A validated input', checks: [{ type: 'tf-config', device: TF, pattern: 'variable\\s+"env"', label: 'A variable named env' }, { type: 'tf-config', device: TF, pattern: 'validation\\s*\\{', label: 'env is validated' }] },
      {
        id: 'network',
        label: 'The network and its subnets',
        checks: [
          { type: 'cloud-object', device: TF, kind: 'network', name: 'prod-net', attrs: { cidr_block: '10.50.0.0/16' } },
          { type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["web"]', attrs: { cidr_block: '10.50.1.0/24', public: true } },
          { type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["db"]', attrs: { cidr_block: '10.50.2.0/24', public: false } },
        ],
      },
      {
        id: 'web',
        label: 'The web tier',
        checks: [
          { type: 'cloud-object', device: TF, kind: 'firewall', name: 'web', ingressRules: 1 },
          { type: 'tf-resource', device: TF, address: 'netcloud_instance.web[0]', attrs: { name: 'web-0', size: 'medium', image: IMAGE_2404 } },
          { type: 'tf-resource', device: TF, address: 'netcloud_instance.web[1]', attrs: { name: 'web-1', size: 'medium', image: IMAGE_2404 } },
          { type: 'tf-config', device: TF, pattern: 'data\\s+"netcloud_image"', label: 'The image comes from a netcloud_image data source' },
        ],
      },
      {
        id: 'db',
        label: 'A protected database whose password never reaches state',
        checks: [
          { type: 'tf-resource', device: TF, address: 'netcloud_database.orders', attrs: { engine: 'postgres', engine_version: '16', password: null, password_wo_version: 1 } },
          { type: 'tf-config', device: TF, pattern: 'ephemeral\\s+"random_password"', label: 'The password comes from an ephemeral random_password' },
          { type: 'tf-config', device: TF, pattern: 'prevent_destroy\\s*=\\s*true', label: 'The database has prevent_destroy = true' },
        ],
      },
      { id: 'outputs', label: 'Outputs', checks: [{ type: 'tf-output', device: TF, name: 'web_ips' }, { type: 'tf-output', device: TF, name: 'db_endpoint' }] },
      { id: 'done', label: 'Formatted, and nothing left to change', checks: [{ type: 'tf-formatted', device: TF }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-32-exam-take-over-an-estate',
    moduleId: MODULE,
    order: 2,
    title: 'Exam: Take Over an Estate',
    difficulty: 'Advanced',
    estimatedMinutes: 35,
    description: 'Bring an inherited configuration up to standard: remove a hard-coded secret, rename without replacing, import a hand-built bucket, correct drift, and move state to a remote backend.',
    scenario: 'This is an exam: there are no hints. You have inherited the reports team\'s infrastructure, and the previous owner\'s notes are in ~/infra/handover.md. Work through every item. The infrastructure is live, so nothing that exists today may be destroyed or rebuilt.',
    concepts: ['Secrets in configuration', 'Refactoring with moved or state mv', 'Import', 'Drift', 'Remote backends and migration'],
    hints: [],
    isExam: true,
    createState: () =>
      tfSite({
        files: { 'versions.tf': TAKEOVER_VERSIONS, 'main.tf': TAKEOVER_MAIN, 'handover.md': HANDOVER },
        cloud: { stateService: { [REPORTS_URL]: {} } },
        prepare: ['terraform init', 'terraform apply -auto-approve'],
        after: (net) => {
          const acct = net.hosts[TF].linux!.cloud!;
          const web = Object.values(acct.objects).find((o) => o.kind === 'instance')!;
          web.attrs.size = 'large';
          acct.activity.push({ who: 'sam@console', action: 'update instance', id: web.id });
          acct.objects['netlab-reports-archive'] = { id: 'netlab-reports-archive', kind: 'bucket', region: 'eu-west', attrs: { name: 'netlab-reports-archive', versioning: true, force_destroy: false, objects: 8812, url: 'https://netlab-reports-archive.storage.netlab.cloud', tags: { team: 'reports' } } };
          acct.activity.push({ who: 'sam@console', action: 'create bucket', id: 'netlab-reports-archive' });
        },
      }),
    objectives: [
      { id: 'token', label: 'No secret in the configuration', checks: [{ type: 'tf-config', device: TF, pattern: 'nlc_', absent: true, label: 'No API token in any .tf file' }] },
      { id: 'rename', label: 'Renamed, not rebuilt', checks: [{ type: 'tf-resource', device: TF, address: 'netcloud_instance.web' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.server1', exists: false }, { type: 'cloud-object', device: TF, kind: 'instance', count: 1 }] },
      { id: 'import', label: 'The archive bucket is managed', checks: [{ type: 'tf-resource', device: TF, address: 'netcloud_bucket.archive', attrs: { id: 'netlab-reports-archive' } }, { type: 'cloud-object', device: TF, kind: 'bucket', name: 'netlab-reports-archive' }] },
      { id: 'drift', label: 'The drift is corrected', checks: [{ type: 'cloud-object', device: TF, kind: 'instance', name: 'reports-web', attrs: { size: 'small' } }] },
      { id: 'backend', label: 'State lives in the remote backend', checks: [{ type: 'tf-backend', device: TF, backend: 'http' }, { type: 'tf-config', device: TF, pattern: 'lock_address', label: 'The backend locks state' }, { type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate', exists: false }] },
      { id: 'done', label: 'Formatted, and nothing left to change', checks: [{ type: 'tf-formatted', device: TF }, { type: 'tf-converged', device: TF }] },
    ],
  },
];
