import type { Lab } from '../types';
import { IMAGE_2404, tfSite, TF } from './tf-site';

const MODULE = 'tf-providers';

const UNPINNED = `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = ">= 1.0"
    }
  }
}

provider "netcloud" {
  region = "eu-west"
}
`;

const WEB_STACK = `resource "netcloud_network" "main" {
  name       = "web"
  cidr_block = "10.0.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.0.1.0/24"
}

resource "netcloud_instance" "web" {
  name      = "web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const PINNED = UNPINNED.replace('>= 1.0', '~> 1.4');

const EMPTY_MAIN = `# Build the network here.
`;

const BUCKET_ONE = `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }
  }
}

provider "netcloud" {
  region = "eu-west"
}

resource "netcloud_bucket" "backups" {
  name       = "backups"
  versioning = true
}
`;

const STATE_BEFORE = `terraform {
  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }
  }
}

resource "netcloud_network" "main" {
  name       = "billing"
  cidr_block = "10.8.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.8.1.0/24"
}

resource "netcloud_instance" "api" {
  name      = "billing-api"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const STATE_AFTER = STATE_BEFORE.replace('  subnet_id = netcloud_subnet.app.id\n}', '  subnet_id = netcloud_subnet.app.id\n\n  tags = {\n    team = "billing"\n  }\n}');

export const tfProvidersLabs: Lab[] = [
  {
    id: 'tf-05-pin-providers',
    moduleId: MODULE,
    order: 1,
    title: 'Pin Your Providers',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'See an unpinned provider upgrade break a working configuration, then pin the version and update the dependency lock file.',
    scenario:
      'Providers are plugins, released on their own schedule, and Terraform downloads whichever version your constraint allows. This configuration was written against netcloud 1.x, but versions.tf only says >= 1.0, and there is no lock file yet.\n\nRun terraform init and look at the version it installs, then terraform validate. netcloud 2.0.0 renamed an instance argument, so a configuration that worked last month no longer does, without anyone touching it. Read .terraform.lock.hcl too: it records the exact version and its checksums.\n\nPin the provider to the 1.4 series with version = "~> 1.4", which allows 1.4.x and later 1.x releases but never 2.0. Run terraform init again and read the error: the lock file still selects 2.0.0, and init will not silently change a locked choice. terraform init -upgrade re-selects within the new constraint. Validate, and apply.',
    concepts: ['required_providers source and version', 'Version constraints: >=, ~>', '.terraform.lock.hcl', 'terraform init -upgrade'],
    hints: ['terraform init, then terraform validate. cat .terraform.lock.hcl shows the selected version.', "sed -i 's/>= 1.0/~> 1.4/' versions.tf", 'A plain terraform init refuses because the lock file disagrees with the new constraint. terraform init -upgrade fixes the selection.', 'terraform validate, then terraform apply -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': UNPINNED, 'main.tf': WEB_STACK } }),
    objectives: [
      { id: 'break', label: 'See what an unpinned init chooses', checks: [{ type: 'tf-ran', device: TF, command: 'init', code: 0 }, { type: 'tf-ran', device: TF, command: 'validate', code: 1 }] },
      { id: 'pin', label: 'Pin the provider to the 1.4 series', checks: [{ type: 'tf-config', device: TF, pattern: 'version\\s*=\\s*"~> 1\\.4"', label: 'versions.tf constrains netcloud to "~> 1.4"' }] },
      { id: 'lock', label: 'Update the lock file', checks: [{ type: 'tf-ran', device: TF, command: 'init', code: 0, argsPattern: '-upgrade', label: 'Ran terraform init -upgrade' }, { type: 'tf-lock', device: TF, provider: 'netlab/netcloud', version: '1.4.1', constraints: '~> 1.4' }] },
      { id: 'apply', label: 'Apply', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0 }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'web' }] },
    ],
  },
  {
    id: 'tf-06-build-a-network',
    moduleId: MODULE,
    order: 2,
    title: 'Build a Network',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Write your own configuration: a network, a subnet and a firewall that refer to each other, and an instance behind them.',
    scenario:
      'Time to write configuration from scratch. versions.tf already requires the netcloud provider and sets the region; main.tf is empty. NetLab Cloud works like any other cloud: a network holds subnets, a firewall belongs to a network, and an instance sits in a subnet.\n\nCreate netcloud_network.main named web with the address range 10.10.0.0/16, and netcloud_subnet.web with 10.10.1.0/24 and public = true. The subnet needs the network\'s ID, which does not exist until the network is created, so do not type one: refer to it as netcloud_network.main.id. That reference is also how Terraform learns to create the network first.\n\nAdd netcloud_firewall.web in the same network with two ingress blocks, one for port 22 and one for port 443, each allowing 0.0.0.0/0. Finally add netcloud_instance.web, size small, image ' + IMAGE_2404 + ', in the subnet, with firewall_ids set to a list holding the firewall\'s ID.\n\nPlan to check the order and the (known after apply) values, then apply. If the cloud rejects something, the error names the rule you broke.',
    concepts: ['Resource blocks', 'Cross-resource references', 'Implicit dependencies', '(known after apply)', 'Nested blocks'],
    hints: [
      "cat > main.tf << 'EOF' … EOF writes the file. Quote the EOF so the shell leaves ${...} alone.",
      'resource "netcloud_subnet" "web" {\n  network_id = netcloud_network.main.id\n  cidr_block = "10.10.1.0/24"\n  public     = true\n}',
      'resource "netcloud_firewall" "web" {\n  name       = "web"\n  network_id = netcloud_network.main.id\n\n  ingress {\n    port        = 22\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n  ingress { … port 443 … }\n}',
      'In the instance: subnet_id = netcloud_subnet.web.id and firewall_ids = [netcloud_firewall.web.id]. Then terraform init and terraform apply.',
    ],
    createState: () => tfSite({ files: { 'versions.tf': PINNED, 'main.tf': EMPTY_MAIN } }),
    objectives: [
      {
        id: 'net',
        label: 'A network with a subnet inside it',
        checks: [
          { type: 'tf-resource', device: TF, address: 'netcloud_network.main', attrs: { cidr_block: '10.10.0.0/16' } },
          { type: 'tf-resource', device: TF, address: 'netcloud_subnet.web', attrs: { cidr_block: '10.10.1.0/24', public: true } },
        ],
      },
      { id: 'ref', label: 'Refer to IDs, never copy them', checks: [{ type: 'tf-config', device: TF, pattern: 'network_id\\s*=\\s*netcloud_network\\.main\\.id', label: 'network_id comes from netcloud_network.main.id' }, { type: 'tf-config', device: TF, pattern: '"(net|subnet|fw)-[0-9a-f]{8}"', absent: true, label: 'No resource ID is typed into the configuration' }] },
      { id: 'fw', label: 'A firewall with two rules', checks: [{ type: 'cloud-object', device: TF, kind: 'firewall', name: 'web', ingressRules: 2 }, { type: 'tf-config', device: TF, pattern: 'port\\s*=\\s*443', label: 'One rule allows port 443' }] },
      { id: 'vm', label: 'An instance behind the firewall', checks: [{ type: 'tf-resource', device: TF, address: 'netcloud_instance.web', attrs: { size: 'small' } }, { type: 'tf-config', device: TF, pattern: 'firewall_ids\\s*=\\s*\\[\\s*netcloud_firewall\\.web\\.id\\s*\\]', label: 'firewall_ids refers to netcloud_firewall.web.id' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-07-two-regions',
    moduleId: MODULE,
    order: 3,
    title: 'Two Providers, Two Regions',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Use a second provider to make a globally unique name, and a provider alias to put a bucket in another region.',
    scenario:
      'The backup team wants a storage bucket in eu-west and a copy in us-east. main.tf has a first attempt, a bucket called backups. Apply it and read the error: bucket names are global across NetLab Cloud, like domain names, and somebody else already owns that one.\n\nGenerate a suffix instead of guessing. Add the hashicorp/random provider to required_providers (version "~> 3.7") and a random_id named suffix with byte_length = 3, then name the bucket "netlab-backups-${random_id.suffix.hex}". One configuration now uses two providers from two publishers, and Terraform builds one dependency graph across both.\n\nThen the copy. A provider block configures one region, so add a second netcloud provider block with alias = "us_east" and region = "us-east", and a second bucket named "netlab-backups-dr-${random_id.suffix.hex}" with provider = netcloud.us_east. Resources without a provider argument keep using the default configuration. Because you added a provider, run terraform init before you apply.',
    concepts: ['Multiple providers', 'Provider aliases and the provider meta-argument', 'Global names', 'random_id'],
    hints: [
      'terraform apply -auto-approve first, and read the BucketAlreadyExists error.',
      'required_providers {\n  netcloud = { … }\n  random = {\n    source  = "hashicorp/random"\n    version = "~> 3.7"\n  }\n}',
      'provider "netcloud" {\n  alias  = "us_east"\n  region = "us-east"\n}',
      'resource "netcloud_bucket" "dr" {\n  provider   = netcloud.us_east\n  name       = "netlab-backups-dr-${random_id.suffix.hex}"\n  versioning = true\n}\nThen terraform init and terraform apply.',
    ],
    createState: () => tfSite({ files: { 'main.tf': BUCKET_ONE }, prepare: ['terraform init'] }),
    objectives: [
      { id: 'taken', label: 'Meet a global name', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 1, label: 'Tried to apply and saw the name was taken' }] },
      { id: 'unique', label: 'Make the name unique with a second provider', checks: [{ type: 'tf-lock', device: TF, provider: 'hashicorp/random' }, { type: 'tf-config', device: TF, pattern: 'random_id\\.suffix\\.hex', label: 'The bucket names use random_id.suffix.hex' }] },
      { id: 'alias', label: 'A second configuration for us-east', checks: [{ type: 'tf-config', device: TF, pattern: 'alias\\s*=\\s*"us_east"', label: 'A netcloud provider block has alias = "us_east"' }, { type: 'tf-config', device: TF, pattern: 'provider\\s*=\\s*netcloud\\.us_east', label: 'A bucket sets provider = netcloud.us_east' }] },
      { id: 'buckets', label: 'One bucket in each region', checks: [{ type: 'cloud-object', device: TF, kind: 'bucket', region: 'eu-west' }, { type: 'cloud-object', device: TF, kind: 'bucket', region: 'us-east' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-08-state-and-backups',
    moduleId: MODULE,
    order: 4,
    title: 'Where State Lives',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Find out what Terraform does without its state file, restore it from the backup, inspect it, and bring it up to date.',
    scenario:
      'The billing team\'s network, subnet and API server are managed from ~/infra with the local backend: state is the file terraform.tfstate, next to the configuration. Somebody tidying up the directory deleted it.\n\nRun terraform plan before you touch anything. Terraform maps configuration to real objects only through state, so without it every resource looks new, and applying would build a second copy of everything beside the first. Do not apply.\n\nThe local backend keeps the previous version of state as terraform.tfstate.backup. Read it (it is JSON, and it lists every object by address with its attributes), then copy it back into place. Inspect the result with terraform state list and terraform show.\n\nThe backup is one version behind: a tag was added in the last apply. Run terraform plan again, read what it wants to change now, and apply to bring state and infrastructure back into step.',
    concepts: ['State maps configuration to real objects', 'terraform.tfstate and terraform.tfstate.backup', 'terraform state list', 'terraform show'],
    hints: ['terraform plan wants to create 3 objects. That is the danger, not the fix.', 'cat terraform.tfstate.backup', 'cp terraform.tfstate.backup terraform.tfstate', 'terraform state list, terraform show, then terraform apply: the only change left is the team tag.'],
    createState: () =>
      tfSite({
        files: { 'main.tf': STATE_BEFORE },
        prepare: ['terraform init', 'terraform apply -auto-approve', `cat > main.tf << 'EOF'\n${STATE_AFTER}EOF`, 'terraform apply -auto-approve', 'rm terraform.tfstate'],
      }),
    objectives: [
      { id: 'blind', label: 'See what Terraform thinks without state', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, add: 3, label: 'Ran terraform plan and saw it wanted to create everything' }] },
      { id: 'restore', label: 'Restore state from the backup', checks: [{ type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate', exists: true }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.api' }] },
      { id: 'inspect', label: 'Inspect it', checks: [{ type: 'tf-ran', device: TF, command: 'state list' }, { type: 'tf-ran', device: TF, command: 'show' }] },
      { id: 'sync', label: 'Bring it up to date, without a second copy', checks: [{ type: 'tf-converged', device: TF }, { type: 'cloud-object', device: TF, kind: 'network', count: 1 }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'billing-api', attrs: {} }] },
    ],
  },
];
