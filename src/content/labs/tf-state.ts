import type { NetworkState } from '../../engine';
import type { CloudSpec } from '../../engine/terraform/cloud';
import type { Lab } from '../types';
import { IMAGE_2404, tfSite, TF, versions } from './tf-site';

const MODULE = 'tf-state';

const STATE_URL = 'https://state.netlab.cloud/teams/network/infra.tfstate';

const BADLY_NAMED = `resource "netcloud_network" "main" {
  name       = "docs"
  cidr_block = "10.12.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.12.1.0/24"
}

resource "netcloud_instance" "instance1" {
  name      = "docs-web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}

resource "netcloud_bucket" "bucket" {
  name       = "netlab-docs-assets-7c1f"
  versioning = true
}
`;

const DRIFT_MAIN = `resource "netcloud_network" "main" {
  name       = "search"
  cidr_block = "10.14.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.14.1.0/24"
}

resource "netcloud_instance" "web" {
  name      = "search-web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id

  tags = {
    owner = "search-team"
  }
}
`;

const IMPORT_MAIN = `# The legacy web server and its asset bucket were built by hand in the console.
# Bring them under Terraform without rebuilding them.
`;

const LEGACY: CloudSpec = {
  objects: [
    { kind: 'network' as const, id: 'net-1a2b3c4d', attrs: { name: 'legacy', cidr_block: '172.16.0.0/16', tags: {} } },
    { kind: 'subnet' as const, id: 'subnet-5e6f7a8b', attrs: { network_id: 'net-1a2b3c4d', cidr_block: '172.16.1.0/24', zone: 'eu-west-a', public: false, name: null, tags: {} } },
    { kind: 'instance' as const, id: 'i-9c0d1e2f', attrs: { name: 'legacy-web', size: 'medium', image: 'img-ubuntu-2204-20260815', subnet_id: 'subnet-5e6f7a8b', firewall_ids: [], user_data: null, tags: { owner: 'web-team' }, private_ip: '172.16.1.10', public_ip: null, status: 'running' } },
    { kind: 'bucket' as const, id: 'netlab-legacy-assets', attrs: { name: 'netlab-legacy-assets', versioning: true, force_destroy: false, objects: 1240, url: 'https://netlab-legacy-assets.storage.netlab.cloud', tags: { owner: 'web-team' } } },
  ],
};

const REMOTE_MAIN = `resource "netcloud_network" "main" {
  name       = "core"
  cidr_block = "10.16.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.16.1.0/24"
}
`;

const BACKEND = `terraform {
  backend "http" {
    address        = "${STATE_URL}"
    lock_address   = "${STATE_URL}/lock"
    unlock_address = "${STATE_URL}/lock"
  }
}
`;

const LOCKED_MAIN_AFTER = REMOTE_MAIN.replace('  cidr_block = "10.16.1.0/24"\n}', '  cidr_block = "10.16.1.0/24"\n  name       = "core-app"\n}');

const WORKSPACE_MAIN = `locals {
  env       = terraform.workspace
  web_count = terraform.workspace == "prod" ? 2 : 1
}

resource "netcloud_network" "main" {
  name       = "\${local.env}-net"
  cidr_block = "10.18.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.18.1.0/24"
}

resource "netcloud_instance" "web" {
  count     = local.web_count
  name      = "\${local.env}-web-\${count.index}"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const QUOTA_MAIN = `resource "netcloud_network" "main" {
  name       = "video"
  cidr_block = "10.22.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.22.1.0/24"
}

resource "netcloud_instance" "transcoder" {
  count     = 3
  name      = "transcoder-\${count.index}"
  size      = "large"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const HACKATHON: CloudSpec = {
  instanceQuota: 4,
  objects: [
    { kind: 'network' as const, id: 'net-0badf00d', attrs: { name: 'hackathon', cidr_block: '10.99.0.0/16', tags: {} } },
    { kind: 'subnet' as const, id: 'subnet-0badf00d', attrs: { network_id: 'net-0badf00d', cidr_block: '10.99.1.0/24', zone: 'eu-west-a', public: false, name: null, tags: {} } },
    { kind: 'instance' as const, id: 'i-0hack001', attrs: { name: 'hackathon-demo-1', size: 'xlarge', image: 'img-debian-12-20260820', subnet_id: 'subnet-0badf00d', firewall_ids: [], user_data: null, tags: { event: 'hackathon-2026-03', owner: 'nobody' }, private_ip: '10.99.1.10', public_ip: null, status: 'running' } },
    { kind: 'instance' as const, id: 'i-0hack002', attrs: { name: 'hackathon-demo-2', size: 'xlarge', image: 'img-debian-12-20260820', subnet_id: 'subnet-0badf00d', firewall_ids: [], user_data: null, tags: { event: 'hackathon-2026-03', owner: 'nobody' }, private_ip: '10.99.1.11', public_ip: null, status: 'running' } },
  ],
};

function instanceId(net: NetworkState, name: string): string {
  return Object.values(net.hosts[TF].linux!.cloud!.objects).find((o) => o.kind === 'instance' && o.attrs.name === name)!.id;
}

export const tfStateLabs: Lab[] = [
  {
    id: 'tf-21-inspect-and-rename',
    moduleId: MODULE,
    order: 1,
    title: 'Inspect and Rename in State',
    difficulty: 'Intermediate',
    estimatedMinutes: 13,
    description: 'Read state from the command line, then rename resources two ways, with terraform state mv and with a moved block, without touching the real objects.',
    scenario:
      'The docs site is managed from ~/infra, but whoever wrote it named things instance1 and bucket. The names only exist in Terraform, so fixing them should not rebuild anything. Renaming the block alone would, because Terraform would see one address disappear and another appear.\n\nStart by reading state with the CLI rather than the JSON file: terraform state list prints every address, and terraform state show netcloud_instance.instance1 prints one object with all its attributes.\n\nRename the instance to web in both places: change the block label in main.tf, then move its state entry with terraform state mv netcloud_instance.instance1 netcloud_instance.web. That edits state immediately and quietly, which is fine for you but invisible to anyone else\'s copy.\n\nRename the bucket to assets the reviewable way: change the label and add a moved block from netcloud_bucket.bucket to netcloud_bucket.assets. The rename then happens during the next plan and apply, where it shows up for review. Plan (nothing to add, change or destroy), and apply.',
    concepts: ['terraform state list and state show', 'terraform state mv', 'moved blocks', 'Renaming without replacing'],
    hints: ['terraform state list; terraform state show netcloud_instance.instance1', "sed -i 's/\"instance1\"/\"web\"/' main.tf; terraform state mv netcloud_instance.instance1 netcloud_instance.web", "sed -i 's/\"netcloud_bucket\" \"bucket\"/\"netcloud_bucket\" \"assets\"/' main.tf", "moved {\n  from = netcloud_bucket.bucket\n  to   = netcloud_bucket.assets\n}\nthen terraform plan and terraform apply -auto-approve"],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': BADLY_NAMED }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'inspect', label: 'Inspect state from the CLI', checks: [{ type: 'tf-ran', device: TF, command: 'state list' }, { type: 'tf-ran', device: TF, command: 'state show' }] },
      { id: 'mv', label: 'Rename the instance with state mv', checks: [{ type: 'tf-ran', device: TF, command: 'state mv', code: 0 }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.web' }, { type: 'tf-config', device: TF, pattern: '"instance1"', absent: true, label: 'The configuration calls it web' }] },
      { id: 'moved', label: 'Rename the bucket with a moved block', checks: [{ type: 'tf-config', device: TF, pattern: 'to\\s*=\\s*netcloud_bucket\\.assets', label: 'A moved block to netcloud_bucket.assets' }, { type: 'tf-resource', device: TF, address: 'netcloud_bucket.assets' }] },
      { id: 'same', label: 'Nothing was rebuilt', checks: [{ type: 'cloud-object', device: TF, kind: 'instance', count: 1 }, { type: 'cloud-object', device: TF, kind: 'bucket', name: 'netlab-docs-assets-7c1f' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-22-drift',
    moduleId: MODULE,
    order: 2,
    title: 'Drift',
    difficulty: 'Intermediate',
    estimatedMinutes: 13,
    description: 'Find changes made outside Terraform with a refresh-only plan, accept the ones another system owns with ignore_changes, and undo the rest.',
    scenario:
      'The search web server is managed by Terraform, and somebody has been in the console. Before you apply anything, find out what changed.\n\nterraform plan -refresh-only compares state with the real infrastructure and reports the differences as "Objects have changed outside of Terraform", without proposing to undo anything. netcloud activity shows who made each change. There are two. The backup service tags the servers it protects, which is its job: that tag will keep coming back, so Terraform should stop fighting it. A colleague also resized the server to large to test something and never put it back, which is nobody\'s job.\n\nAdd a lifecycle block to the instance with ignore_changes = [tags], so Terraform no longer manages the tags after creation. Then run terraform plan: the tag is no longer mentioned, and the size is set back to small. Apply.',
    concepts: ['Drift', 'terraform plan -refresh-only', 'lifecycle ignore_changes', 'Deciding which source of truth wins'],
    hints: ['terraform plan -refresh-only', 'netcloud activity', 'lifecycle {\n  ignore_changes = [tags]\n}', 'terraform plan shows only size "large" -> "small"; then terraform apply -auto-approve'],
    createState: () =>
      tfSite({
        files: { 'versions.tf': versions(), 'main.tf': DRIFT_MAIN },
        prepare: ['terraform init', 'terraform apply -auto-approve'],
        after: (net) => {
          const acct = net.hosts[TF].linux!.cloud!;
          const id = instanceId(net, 'search-web');
          const o = acct.objects[id];
          o.attrs.tags = { ...(o.attrs.tags as Record<string, string>), backup: 'daily' };
          acct.activity.push({ who: 'backup-service (API)', action: 'update instance', id });
          o.attrs.size = 'large';
          acct.activity.push({ who: 'jordan@console', action: 'update instance', id });
        },
      }),
    objectives: [
      { id: 'detect', label: 'Detect the drift', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, argsPattern: '-refresh-only', label: 'Ran terraform plan -refresh-only' }] },
      { id: 'ignore', label: 'Stop managing what another system owns', checks: [{ type: 'tf-config', device: TF, pattern: 'ignore_changes\\s*=\\s*\\[\\s*tags\\s*\\]', label: 'The instance ignores changes to tags' }] },
      { id: 'revert', label: 'Undo the unapproved resize', checks: [{ type: 'cloud-object', device: TF, kind: 'instance', name: 'search-web', attrs: { size: 'small' } }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-23-import',
    moduleId: MODULE,
    order: 3,
    title: 'Import Existing Infrastructure',
    difficulty: 'Advanced',
    estimatedMinutes: 18,
    description: 'Bring hand-built infrastructure under Terraform: generate configuration from an import block, and import a bucket from the command line.',
    scenario:
      'The legacy web server and its asset bucket were built by hand years ago, and nobody wants to rebuild them. Import records existing objects in state against a resource block, so that from then on Terraform manages them.\n\nFind them first: netcloud instances list and netcloud buckets list.\n\nFor the server, use an import block, the modern way: it is configuration, so it goes through plan and review like any other change. Write import { to = netcloud_instance.legacy, id = "i-9c0d1e2f" } in imports.tf. You have no resource block to go with it, so let Terraform write one: terraform plan -generate-config-out=generated.tf. Read generated.tf, then apply; the summary says 1 imported.\n\nFor the bucket, use the older CLI command, which changes state directly and needs the resource block to exist first. Write resource "netcloud_bucket" "assets" with the name, versioning, force_destroy and tags that netcloud buckets show reports, then run terraform import netcloud_bucket.assets netlab-legacy-assets.\n\nFinish with a plan that shows no changes. If it wants to change something, your configuration does not match reality yet: fix the configuration, not the bucket.',
    concepts: ['import blocks', 'plan -generate-config-out', 'terraform import', 'Matching configuration to what exists'],
    hints: ['netcloud instances list; netcloud buckets show netlab-legacy-assets', "cat > imports.tf << 'EOF'\nimport {\n  to = netcloud_instance.legacy\n  id = \"i-9c0d1e2f\"\n}\nEOF", 'terraform init; terraform plan -generate-config-out=generated.tf; cat generated.tf; terraform apply -auto-approve', 'resource "netcloud_bucket" "assets" {\n  name          = "netlab-legacy-assets"\n  versioning    = true\n  force_destroy = false\n  tags          = { owner = "web-team" }\n}\nthen terraform import netcloud_bucket.assets netlab-legacy-assets'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': IMPORT_MAIN }, cloud: LEGACY }),
    objectives: [
      { id: 'find', label: 'Find what exists', checks: [{ type: 'command', device: TF, pattern: '^netcloud (instances|buckets) (list|show)', label: 'Looked the objects up with netcloud' }] },
      { id: 'generate', label: 'Generate configuration from an import block', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, argsPattern: 'generate-config-out', label: 'Ran terraform plan -generate-config-out=…' }, { type: 'tf-config', device: TF, pattern: 'resource\\s+"netcloud_instance"\\s+"legacy"', label: 'Configuration for netcloud_instance.legacy exists' }] },
      { id: 'block', label: 'Import the server with the block', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, imported: 1, label: 'Applied an import' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.legacy', attrs: { id: 'i-9c0d1e2f' } }] },
      { id: 'cli', label: 'Import the bucket from the command line', checks: [{ type: 'tf-ran', device: TF, command: 'import', code: 0 }, { type: 'tf-resource', device: TF, address: 'netcloud_bucket.assets', attrs: { id: 'netlab-legacy-assets' } }] },
      { id: 'match', label: 'Configuration matches reality', checks: [{ type: 'tf-converged', device: TF }, { type: 'cloud-object', device: TF, kind: 'instance', count: 1 }] },
    ],
  },
  {
    id: 'tf-24-remote-state',
    moduleId: MODULE,
    order: 4,
    title: 'Move State to a Remote Backend',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Move local state to a shared http backend with locking, so a team works from one copy, and retire the local file.',
    scenario:
      'The core network has so far been managed from this laptop, with state in terraform.tfstate. A second engineer is joining, and a state file on one machine does not work for two: each would build from a different copy, and nothing would stop two applies running at once.\n\nThe team runs a state service that speaks Terraform\'s http backend protocol, with locking. A backend is configured in a terraform block: add backend.tf with backend "http" whose address is ' + STATE_URL + ', and whose lock_address and unlock_address are the same URL with /lock on the end.\n\nAny command now tells you that the backend needs initialising. Run terraform init: it finds the existing local state and asks whether to copy it to the new backend. Answer yes. Plan to check that Terraform still knows every object (no changes), and then remove the local terraform.tfstate and terraform.tfstate.backup, so nobody mistakes them for the real state.',
    concepts: ['Local versus remote backends', 'The backend block', 'State migration during init', 'Locking in a remote backend'],
    hints: ["cat > backend.tf << 'EOF'\nterraform {\n  backend \"http\" {\n    address        = \"" + STATE_URL + '"\n    lock_address   = "' + STATE_URL + '/lock"\n    unlock_address = "' + STATE_URL + "/lock\"\n  }\n}\nEOF", 'terraform init asks: Do you want to copy existing state to the new backend? Type yes.', 'terraform plan should report no changes.', 'rm terraform.tfstate terraform.tfstate.backup'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': REMOTE_MAIN }, cloud: { stateService: { [STATE_URL]: {} } }, prepare: ['terraform init', 'terraform apply -auto-approve', 'terraform taint netcloud_subnet.app', 'terraform untaint netcloud_subnet.app'] }),
    objectives: [
      { id: 'configure', label: 'Configure the backend', checks: [{ type: 'tf-config', device: TF, pattern: 'backend\\s+"http"', label: 'A backend "http" block' }, { type: 'tf-config', device: TF, pattern: 'lock_address', label: 'The backend has a lock_address' }] },
      { id: 'migrate', label: 'Migrate the state', checks: [{ type: 'tf-backend', device: TF, backend: 'http' }, { type: 'tf-resource', device: TF, address: 'netcloud_subnet.app' }] },
      { id: 'retire', label: 'Retire the local copy', checks: [{ type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate', exists: false }, { type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate.backup', exists: false }] },
      { id: 'work', label: 'Keep working', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0 }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-25-stale-lock',
    moduleId: MODULE,
    order: 5,
    title: 'Break a Stale Lock',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Read a state lock error, decide whether the holder is really gone, release the lock with force-unlock, and carry on.',
    scenario:
      'The core network\'s state lives in the team\'s http backend, which locks state while any plan or apply runs, so two people cannot write it at once. You have a small change to apply (the subnet gets a name), and terraform plan refuses to run.\n\nRead the error. Lock Info says who holds the lock, from which machine, for what operation and since when. It was taken by the CI runner build-07 during an apply early this morning. The platform channel says build-07 was killed at 07:42 when its host was recycled, so that apply will never finish or release the lock.\n\nThat is the one situation force-unlock is for: a lock whose holder is definitely gone. Never use it to push past a colleague who is still running. Copy the lock ID from the error and run terraform force-unlock with it; Terraform asks you to confirm. Then plan and apply your change.',
    concepts: ['State locking', 'Lock Info: ID, Who, Operation, Created', 'terraform force-unlock', 'When not to force-unlock'],
    hints: ['terraform plan, and read Lock Info.', 'The ID is 6f3c2a1e-8b4d-4c5e-9a7b-2d1e0f3a4b5c.', 'terraform force-unlock 6f3c2a1e-8b4d-4c5e-9a7b-2d1e0f3a4b5c, then type yes.', 'terraform apply -auto-approve'],
    createState: () =>
      tfSite({
        files: { 'versions.tf': versions(), 'main.tf': REMOTE_MAIN, 'backend.tf': BACKEND },
        cloud: { stateService: { [STATE_URL]: {} } },
        prepare: ['terraform init', 'terraform apply -auto-approve'],
        edits: { 'main.tf': LOCKED_MAIN_AFTER },
        after: (net) => {
          net.hosts[TF].linux!.cloud!.stateService[STATE_URL].lock = { ID: '6f3c2a1e-8b4d-4c5e-9a7b-2d1e0f3a4b5c', Operation: 'OperationTypeApply', Info: '', Who: 'ci@build-07', Version: '1.12.2', Created: '2026-09-14 07:31:18.204417 +0000 UTC', Path: '' };
        },
      }),
    objectives: [
      { id: 'locked', label: 'Hit the lock', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 1 }] },
      { id: 'unlock', label: 'Release the stale lock', checks: [{ type: 'tf-ran', device: TF, command: 'force-unlock', code: 0 }, { type: 'tf-remote-lock', device: TF, address: STATE_URL, locked: false }] },
      { id: 'apply', label: 'Apply your change', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, change: 1 }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-26-workspaces',
    moduleId: MODULE,
    order: 6,
    title: 'Workspaces',
    difficulty: 'Intermediate',
    estimatedMinutes: 13,
    description: 'Run one configuration as separate dev and prod environments with CLI workspaces, each with its own state.',
    scenario:
      'main.tf builds a network and web servers, and it reads terraform.workspace: names start with the workspace, and prod gets two web servers where anything else gets one. With the local backend, every workspace keeps its own state under terraform.tfstate.d, while the configuration stays the same.\n\nYou are in the default workspace, which should stay empty. Create dev with terraform workspace new dev (it switches to it), and apply. Create prod the same way and apply again: the plan starts from nothing, because prod\'s state is separate, even though dev\'s objects exist.\n\nList the workspaces with terraform workspace list, where the current one is starred, and switch back to dev with terraform workspace select dev. CLI workspaces suit near-identical copies like these; environments that differ in access, backends or providers are usually separate configurations.',
    concepts: ['terraform workspace new, list, select, show', 'terraform.workspace', 'Per-workspace state', 'When workspaces fit'],
    hints: ['terraform init; terraform workspace new dev; terraform apply -auto-approve', 'terraform workspace new prod; terraform apply -auto-approve', 'terraform workspace list', 'terraform workspace select dev'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': WORKSPACE_MAIN } }),
    objectives: [
      { id: 'dev', label: 'A dev environment', checks: [{ type: 'tf-workspace', device: TF, name: 'dev' }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'dev-web-0' }, { type: 'tf-state-count', device: TF, workspace: 'dev', count: 3 }] },
      { id: 'prod', label: 'A prod environment from the same code', checks: [{ type: 'tf-workspace', device: TF, name: 'prod' }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'prod-web-1' }, { type: 'tf-state-count', device: TF, workspace: 'prod', count: 4 }] },
      { id: 'default', label: 'Default stays empty', checks: [{ type: 'tf-state-count', device: TF, workspace: 'default', count: 0 }] },
      { id: 'switch', label: 'List and switch', checks: [{ type: 'tf-ran', device: TF, command: 'workspace list' }, { type: 'tf-workspace', device: TF, name: 'dev', current: true }] },
    ],
  },
  {
    id: 'tf-27-verbose-logging',
    moduleId: MODULE,
    order: 7,
    title: 'Debug With Verbose Logging',
    difficulty: 'Intermediate',
    estimatedMinutes: 13,
    description: 'Turn an unhelpful 403 into the real cause with TF_LOG and TF_LOG_PATH, fix it, and finish the apply.',
    scenario:
      'The video team\'s apply stops halfway through with "creating instance: 403 Forbidden", and that is all the provider says. The configuration is fine and the token works (two of the servers were created), so the answer is in the conversation between the provider and the API.\n\nTerraform writes detailed logs when TF_LOG is set to a level: TRACE, DEBUG, INFO, WARN or ERROR. On its own the log goes to the terminal, mixed with everything else, so also set TF_LOG_PATH to write it to a file. Both can be set for one command: TF_LOG=DEBUG TF_LOG_PATH=terraform.log terraform apply -auto-approve.\n\nSearch the log for the failing response: grep -i 403 terraform.log. The body names the real problem. List the instances in the account with netcloud instances list to see what is using it up, and delete what nobody owns with netcloud instances delete. Then apply again. Logs can contain sensitive values; do not paste them into public tickets.',
    concepts: ['TF_LOG levels', 'TF_LOG_PATH', 'Reading provider HTTP logs', 'When to reach for verbose logging'],
    hints: ['terraform apply -auto-approve fails partway with 403 Forbidden.', 'TF_LOG=DEBUG TF_LOG_PATH=terraform.log terraform apply -auto-approve; then grep -i 403 terraform.log', 'The account allows 4 instances in eu-west. netcloud instances list shows two left over from a hackathon, owned by nobody.', 'netcloud instances delete i-0hack001; netcloud instances delete i-0hack002; terraform apply -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': QUOTA_MAIN }, cloud: HACKATHON, prepare: ['terraform init'] }),
    objectives: [
      { id: 'fail', label: 'See the unhelpful error', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 1 }] },
      { id: 'log', label: 'Capture a debug log to a file', checks: [{ type: 'file', device: TF, path: '/home/student/infra/terraform.log', contains: 'InstanceLimitExceeded' }, { type: 'command', device: TF, pattern: '^grep\\b.*terraform\\.log', label: 'Searched the log with grep' }] },
      { id: 'cleanup', label: 'Remove the leftovers', checks: [{ type: 'cloud-object', device: TF, kind: 'instance', name: 'hackathon-demo-1', exists: false }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'hackathon-demo-2', exists: false }] },
      { id: 'finish', label: 'Finish the apply', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0 }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'transcoder-2' }, { type: 'tf-converged', device: TF }] },
    ],
  },
];
