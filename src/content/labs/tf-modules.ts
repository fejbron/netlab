import type { Lab } from '../types';
import { IMAGE_2404, tfSite, TF, versions } from './tf-site';

const MODULE = 'tf-modules';

const ROOT_NETWORK = `resource "netcloud_network" "main" {
  name       = "intranet"
  cidr_block = "10.90.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.90.1.0/24"
}
`;

const SCOPE_MODULE_MAIN = `resource "netcloud_network" "this" {
  name       = var.name
  cidr_block = var.cidr_block
}

resource "netcloud_subnet" "this" {
  network_id = netcloud_network.this.id
  cidr_block = cidrsubnet(var.cidr_block, 8, 1)
}
`;

const SCOPE_MODULE_VARS = `variable "name" {
  type = string
}

variable "cidr_block" {
  type = string
}
`;

const SCOPE_ROOT = `module "network" {
  source     = "./modules/network"
  name       = "wiki"
  cidr_block = "10.91.0.0/16"
}

resource "netcloud_instance" "web" {
  name      = "wiki"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = module.network.netcloud_subnet.this.id
}
`;

const REGISTRY_ROOT = `module "vpc" {
  source  = "netlab/network/netcloud"
  version = "1.0.0"

  name       = "reports"
  cidr_block = "10.95.0.0/16"
  subnets = {
    app = { cidr = "10.95.1.0/24" }
  }
}

output "app_subnet_id" {
  value = module.vpc.subnet_ids["app"]
}
`;

const REFACTOR_BEFORE = `resource "netcloud_network" "main" {
  name       = "crm"
  cidr_block = "10.97.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.97.1.0/24"
}

resource "netcloud_instance" "web" {
  name      = "crm-web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

const REFACTOR_MODULE_MAIN = `resource "netcloud_network" "this" {
  name       = var.name
  cidr_block = var.cidr_block
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.this.id
  cidr_block = cidrsubnet(var.cidr_block, 8, 1)
}
`;

const REFACTOR_MODULE_VARS = SCOPE_MODULE_VARS;

const REFACTOR_MODULE_OUTPUTS = `output "subnet_id" {
  value = netcloud_subnet.app.id
}
`;

export const tfModulesLabs: Lab[] = [
  {
    id: 'tf-17-write-a-module',
    moduleId: MODULE,
    order: 1,
    title: 'Write a Module',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Package a web server as a local module with its own inputs and outputs, call it from the root, and read its result through an output.',
    scenario:
      'Several teams will need the same web server: an instance of a given size in a given subnet. Instead of copying the block into every configuration, write it once as a module, a directory of .tf files that other configurations call like a function.\n\nThe root module in ~/infra already has the intranet network and subnet. Create modules/web-tier with three files. variables.tf declares the inputs: name (string), subnet_id (string) and size (string, default "small"). main.tf creates netcloud_instance.this from those variables, with image ' + IMAGE_2404 + '. outputs.tf publishes private_ip.\n\nIn the root, call it: module "web" with source = "./modules/web-tier", name = "intranet-web" and subnet_id = netcloud_subnet.app.id. Add a root output web_ip = module.web.private_ip.\n\nA new module call has to be installed, even a local one, so run terraform init before you plan. In the plan, the instance\'s address starts with module.web.',
    concepts: ['Modules as reusable units', 'Module inputs (variables) and outputs', 'source for a local module', 'module.<name>.<output>'],
    hints: ['mkdir -p modules/web-tier', "cat > modules/web-tier/variables.tf << 'EOF'\nvariable \"name\" { type = string }\nvariable \"subnet_id\" { type = string }\nvariable \"size\" {\n  type    = string\n  default = \"small\"\n}\nEOF", 'resource "netcloud_instance" "this" {\n  name      = var.name\n  size      = var.size\n  image     = "img-ubuntu-2404-20260901"\n  subnet_id = var.subnet_id\n}\n…and output "private_ip" { value = netcloud_instance.this.private_ip }', 'module "web" {\n  source    = "./modules/web-tier"\n  name      = "intranet-web"\n  subnet_id = netcloud_subnet.app.id\n}\nthen terraform init and terraform apply'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': ROOT_NETWORK } }),
    objectives: [
      { id: 'inputs', label: 'Give the module inputs', checks: [{ type: 'file', device: TF, path: '/home/student/infra/modules/web-tier/variables.tf', contains: 'variable\\s+"subnet_id"' }] },
      { id: 'outputs', label: 'Give it an output', checks: [{ type: 'file', device: TF, path: '/home/student/infra/modules/web-tier/outputs.tf', contains: 'output\\s+"private_ip"' }] },
      { id: 'call', label: 'Call it from the root module', checks: [{ type: 'tf-config', device: TF, pattern: 'source\\s*=\\s*"\\./modules/web-tier"', label: 'module "web" uses source = "./modules/web-tier"' }, { type: 'tf-module', device: TF, key: 'web' }] },
      { id: 'apply', label: 'Apply and read the result through an output', checks: [{ type: 'tf-resource', device: TF, address: 'module.web.netcloud_instance.this', attrs: { name: 'intranet-web' } }, { type: 'tf-output', device: TF, name: 'web_ip' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-18-module-scope',
    moduleId: MODULE,
    order: 2,
    title: 'What a Module Lets You See',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Find out why the root module cannot reach into a child module\'s resources, and expose what it needs as an output instead.',
    scenario:
      'The wiki team split their network into modules/network, and now nothing validates. main.tf tries to put the wiki server in the subnet by reaching inside the module: module.network.netcloud_subnet.this.id.\n\nA module is a boundary. Its variables are its only way in, and its outputs are its only way out; the resources, locals and variables inside are private to it, the same way a function\'s local variables are private. That is what lets a module change its internals without breaking its callers.\n\nRun terraform validate and read the error. Then add modules/network/outputs.tf with an output named subnet_id whose value is netcloud_subnet.this.id, and change the instance to use module.network.subnet_id. Validate again, and apply.',
    concepts: ['Module scope', 'Outputs as a module\'s interface', 'Variables only flow in through the module block'],
    hints: ['terraform validate: "This object does not have an attribute named netcloud_subnet".', "cat > modules/network/outputs.tf << 'EOF'\noutput \"subnet_id\" {\n  value = netcloud_subnet.this.id\n}\nEOF", "sed -i 's/module.network.netcloud_subnet.this.id/module.network.subnet_id/' main.tf", 'terraform validate, then terraform apply -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': SCOPE_ROOT, 'modules/network/main.tf': SCOPE_MODULE_MAIN, 'modules/network/variables.tf': SCOPE_MODULE_VARS }, prepare: ['terraform init'] }),
    objectives: [
      { id: 'boundary', label: 'Hit the boundary', checks: [{ type: 'tf-ran', device: TF, command: 'validate', code: 1 }] },
      { id: 'expose', label: 'Expose the value as an output', checks: [{ type: 'file', device: TF, path: '/home/student/infra/modules/network/outputs.tf', contains: 'output\\s+"subnet_id"' }] },
      { id: 'use', label: 'Use the output from the root', checks: [{ type: 'tf-config', device: TF, pattern: 'module\\.network\\.subnet_id', label: 'The instance uses module.network.subnet_id' }, { type: 'tf-ran', device: TF, command: 'validate', code: 0 }] },
      { id: 'apply', label: 'Apply', checks: [{ type: 'tf-resource', device: TF, address: 'netcloud_instance.web' }, { type: 'tf-resource', device: TF, address: 'module.network.netcloud_subnet.this' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-19-registry-modules',
    moduleId: MODULE,
    order: 3,
    title: 'Use and Upgrade a Registry Module',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Install a versioned module from the registry, read its documentation, then upgrade it within a constraint to use a new input.',
    scenario:
      'The reports team uses netlab/network/netcloud, a published network module, instead of writing their own. A registry source has three parts, namespace/name/provider, and unlike a local path it has versions. main.tf pins version = "1.0.0" exactly.\n\nRun terraform init and watch it download the module into .terraform/modules/vpc. Read its README.md there: it lists the inputs the module accepts and the outputs it returns. Apply.\n\nThe team now wants every network tagged, and the tags input only arrived in 1.2.0. An exact pin never moves, so change the constraint to "~> 1.2", which accepts 1.2 and any later 1.x. Add tags = { team = "reports" } to the module block. Run terraform init to install the newer version (plan will not do it for you), then apply. The network is updated in place.',
    concepts: ['Registry module sources', 'Module version constraints', '.terraform/modules', 'Upgrading a module'],
    hints: ['terraform init, then cat .terraform/modules/vpc/README.md', 'terraform apply -auto-approve', 'Rewrite main.tf with version = "~> 1.2" and a line tags = { team = "reports" } inside the module block.', 'terraform init downloads 1.2.0; then terraform apply -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': REGISTRY_ROOT } }),
    objectives: [
      { id: 'install', label: 'Install a published module', checks: [{ type: 'tf-module', device: TF, key: 'vpc' }, { type: 'command', device: TF, pattern: '^(cat|less|more)\\s+.*README\\.md', label: 'Read the module\'s README.md' }] },
      { id: 'upgrade', label: 'Upgrade within a constraint', checks: [{ type: 'tf-config', device: TF, pattern: 'version\\s*=\\s*"~> 1\\.2"', label: 'The module version is "~> 1.2"' }, { type: 'tf-module', device: TF, key: 'vpc', version: '1.2.0' }] },
      { id: 'tags', label: 'Use the new input', checks: [{ type: 'tf-config', device: TF, pattern: 'team\\s*=\\s*"reports"', label: 'The module is given tags with team = "reports"' }, { type: 'tf-output', device: TF, name: 'app_subnet_id' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-20-refactor-into-module',
    moduleId: MODULE,
    order: 4,
    title: 'Refactor Into a Module Without Downtime',
    difficulty: 'Advanced',
    estimatedMinutes: 16,
    description: 'Move running resources into a module and use moved blocks so Terraform renames them in state instead of destroying and recreating them.',
    scenario:
      'The CRM network and subnet were written directly in the root module and are running, with a web server inside. The team has since written modules/network (it is already in the directory) and wants the CRM configuration to use it.\n\nReplace the two resource blocks in main.tf with a module "network" call (source "./modules/network", name "crm", cidr_block "10.97.0.0/16") and point the instance at module.network.subnet_id. Run terraform init, then terraform plan, and stop. The resources have new addresses, so Terraform plans to destroy the old network and subnet and create new ones, which would take the server down with them.\n\nTell Terraform what happened instead. Add two moved blocks: from netcloud_network.main to module.network.netcloud_network.this, and from netcloud_subnet.app to module.network.netcloud_subnet.app. Plan again: the resources "have moved", nothing is destroyed, and the instance is untouched. Apply. Keep moved blocks in the configuration for a while, so anyone else\'s copy of the state is moved too when they next apply.',
    concepts: ['Refactoring', 'moved blocks', 'Resource addresses inside modules', 'Why a rename is not a replacement'],
    hints: ['module "network" {\n  source     = "./modules/network"\n  name       = "crm"\n  cidr_block = "10.97.0.0/16"\n}', 'In the instance: subnet_id = module.network.subnet_id. Then terraform init and terraform plan.', 'moved {\n  from = netcloud_network.main\n  to   = module.network.netcloud_network.this\n}', 'moved {\n  from = netcloud_subnet.app\n  to   = module.network.netcloud_subnet.app\n}\nthen terraform plan (0 to destroy) and terraform apply -auto-approve'],
    createState: () =>
      tfSite({
        files: { 'versions.tf': versions(), 'main.tf': REFACTOR_BEFORE, 'modules/network/main.tf': REFACTOR_MODULE_MAIN, 'modules/network/variables.tf': REFACTOR_MODULE_VARS, 'modules/network/outputs.tf': REFACTOR_MODULE_OUTPUTS },
        prepare: ['terraform init', 'terraform apply -auto-approve'],
      }),
    objectives: [
      { id: 'call', label: 'Call the module', checks: [{ type: 'tf-config', device: TF, pattern: 'module\\s+"network"', label: 'main.tf calls module "network"' }, { type: 'tf-module', device: TF, key: 'network' }] },
      { id: 'moved', label: 'Record what moved', checks: [{ type: 'tf-config', device: TF, pattern: 'to\\s*=\\s*module\\.network\\.netcloud_network\\.this', label: 'A moved block for the network' }, { type: 'tf-config', device: TF, pattern: 'to\\s*=\\s*module\\.network\\.netcloud_subnet\\.app', label: 'A moved block for the subnet' }] },
      { id: 'apply', label: 'Apply without replacing anything', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, destroy: 0, label: 'Applied with nothing destroyed' }, { type: 'tf-resource', device: TF, address: 'module.network.netcloud_network.this' }, { type: 'cloud-object', device: TF, kind: 'network', count: 1 }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'crm-web' }, { type: 'tf-converged', device: TF }] },
    ],
  },
];
