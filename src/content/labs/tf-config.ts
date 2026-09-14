import type { Lab } from '../types';
import { IMAGE_2204, IMAGE_2404, RANDOM_PROVIDER, tfSite, TF, versions } from './tf-site';

const MODULE = 'tf-config';

const HARDCODED = `resource "netcloud_network" "main" {
  name       = "shop-dev"
  cidr_block = "10.20.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.20.1.0/24"
}
`;

const OLD_IMAGE = `resource "netcloud_network" "main" {
  name       = "catalog"
  cidr_block = "10.5.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.5.1.0/24"
}

resource "netcloud_instance" "web" {
  name      = "catalog-web"
  size      = "small"
  image     = "${IMAGE_2204}"
  subnet_id = netcloud_subnet.app.id
}
`;

const LOOP_VARS = `variable "subnets" {
  description = "Subnets to create, by name."
  type        = map(string)
  default = {
    app = "10.30.1.0/24"
    db  = "10.30.2.0/24"
  }
}

variable "web_count" {
  description = "How many web servers to run."
  type        = number
  default     = 2
}
`;

const LOOP_NETWORK = `resource "netcloud_network" "main" {
  name       = "fleet"
  cidr_block = "10.30.0.0/16"
}
`;

const COMPLEX_VARS = `variable "network" {
  description = "The network and the subnets to carve out of it, in order."
  type = object({
    name = string
    cidr = string
    subnets = list(object({
      name   = string
      public = optional(bool, false)
    }))
  })
}

variable "common_tags" {
  type = map(string)
  default = {
    managed_by = "terraform"
    team       = "network"
  }
}
`;

const COMPLEX_TFVARS = `network = {
  name = "analytics"
  cidr = "10.40.0.0/16"
  subnets = [
    { name = "public", public = true },
    { name = "private" },
  ]
}
`;

const STATIC_FIREWALL = `resource "netcloud_network" "main" {
  name       = "edge"
  cidr_block = "10.60.0.0/16"
}

resource "netcloud_firewall" "edge" {
  name       = "edge"
  network_id = netcloud_network.main.id

  ingress {
    port        = 22
    cidr_blocks = ["10.0.0.0/8"]
  }

  ingress {
    port        = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    port        = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

const LIFECYCLE_BEFORE = `resource "netcloud_network" "main" {
  name       = "orders"
  cidr_block = "10.70.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.70.1.0/24"
}

resource "random_id" "logs" {
  byte_length = 3
}

resource "netcloud_bucket" "logs" {
  name = "orders-logs-\${random_id.logs.hex}"
}

resource "netcloud_instance" "web" {
  name      = "orders-web"
  size      = "small"
  image     = "${IMAGE_2204}"
  subnet_id = netcloud_subnet.app.id

  # The application writes its logs to the bucket, but only finds it by listing
  # buckets at boot, so nothing here refers to it.
  user_data = "LOG_BUCKET_PREFIX=orders-logs-"
}

resource "netcloud_database" "orders" {
  name           = "orders"
  engine         = "postgres"
  engine_version = "16"
  size           = "small"
  password       = "orders-db-password-2026"
}
`;

const CONDITIONS_MAIN = `resource "netcloud_network" "main" {
  name       = "payments"
  cidr_block = "10.80.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.80.1.0/24"
}

data "netcloud_image" "base" {
  family = var.image_family
}

resource "netcloud_instance" "api" {
  name      = "payments-api"
  size      = var.instance_size
  image     = data.netcloud_image.base.id
  subnet_id = netcloud_subnet.app.id
}
`;

const CONDITIONS_VARS = `variable "instance_size" {
  type    = string
  default = "small"
}

variable "image_family" {
  type    = string
  default = "ubuntu-2404"
}
`;

const SECRETS_VERSIONS = `terraform {
  required_version = ">= 1.11"

  required_providers {
    netcloud = {
      source  = "netlab/netcloud"
      version = "~> 1.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "netcloud" {
  region = "eu-west"
  token  = "nlc_7f3a9e2b41c8d05e"
}
`;

const SECRETS_MAIN = `resource "netcloud_database" "orders" {
  name           = "orders"
  engine         = "postgres"
  engine_version = "16"
  size           = "small"
  password       = "Sup3rSecret-2026"
}

output "db_endpoint" {
  value = netcloud_database.orders.endpoint
}
`;

export const tfConfigLabs: Lab[] = [
  {
    id: 'tf-09-variables-and-outputs',
    moduleId: MODULE,
    order: 1,
    title: 'Inputs and Outputs',
    difficulty: 'Beginner',
    estimatedMinutes: 12,
    description: 'Turn hard-coded values into typed input variables, set them from a tfvars file and the command line, and publish results as outputs.',
    scenario:
      'main.tf builds the shop\'s development network, and every value in it is typed in. To build staging from the same code, the values that differ have to become inputs.\n\nCreate variables.tf with two variables: env, a string defaulting to "dev", and cidr_block, a string with no default. Set cidr_block = "10.20.0.0/16" in terraform.tfvars, which Terraform loads automatically. In main.tf, name the network "shop-${var.env}", use var.cidr_block for its range, and derive the subnet\'s range with cidrsubnet(var.cidr_block, 8, 1) instead of typing it.\n\nCreate outputs.tf with network_id (the network\'s id) and subnet_cidr (the subnet\'s cidr_block). Outputs are what a configuration gives back: printed after apply, read with terraform output, and consumed by other configurations.\n\nThis directory is for staging, so run terraform init and apply with -var="env=staging". A -var on the command line wins over terraform.tfvars, which wins over a default. Read the outputs with terraform output.',
    concepts: ['variable blocks with type, default and description', 'terraform.tfvars and variable precedence', '-var', 'output blocks', 'cidrsubnet()'],
    hints: ['variable "cidr_block" {\n  type = string\n}', "echo 'cidr_block = \"10.20.0.0/16\"' > terraform.tfvars", 'name = "shop-${var.env}", cidr_block = var.cidr_block, and in the subnet cidr_block = cidrsubnet(var.cidr_block, 8, 1)', 'output "subnet_cidr" {\n  value = netcloud_subnet.app.cidr_block\n}\nthen terraform init and terraform apply -var="env=staging"'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': HARDCODED } }),
    objectives: [
      { id: 'declare', label: 'Declare the inputs', checks: [{ type: 'tf-config', device: TF, pattern: 'variable\\s+"env"', label: 'A variable named env' }, { type: 'tf-config', device: TF, pattern: 'variable\\s+"cidr_block"', label: 'A variable named cidr_block' }] },
      { id: 'tfvars', label: 'Set a value in terraform.tfvars', checks: [{ type: 'file', device: TF, path: '/home/student/infra/terraform.tfvars', contains: 'cidr_block\\s*=\\s*"10\\.20\\.0\\.0/16"' }] },
      { id: 'use', label: 'Use them instead of literals', checks: [{ type: 'tf-config', device: TF, pattern: '"shop-dev"|"10\\.20\\.1\\.0/24"', absent: true, label: 'No hard-coded name or subnet range is left' }, { type: 'tf-config', device: TF, pattern: 'cidrsubnet\\(', label: 'The subnet range comes from cidrsubnet()' }] },
      { id: 'override', label: 'Apply for staging from the command line', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, argsPattern: 'env=staging', label: 'Applied with -var="env=staging"' }, { type: 'cloud-object', device: TF, kind: 'network', name: 'shop-staging' }] },
      { id: 'outputs', label: 'Publish outputs', checks: [{ type: 'tf-output', device: TF, name: 'subnet_cidr', value: '10.20.1.0/24' }, { type: 'tf-output', device: TF, name: 'network_id' }] },
    ],
  },
  {
    id: 'tf-10-data-sources',
    moduleId: MODULE,
    order: 2,
    title: 'Look Things Up With Data Sources',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Replace a hard-coded image ID with a data source that finds the newest image, and see the difference between reading and managing.',
    scenario:
      'The catalogue web server was built from an image ID someone copied out of the console two years ago. Images are published and retired by the cloud, not by you, so the ID should be looked up each time rather than typed in.\n\nA resource block tells Terraform to create and own an object. A data block only reads one that exists already, and Terraform never changes or destroys it. Add data "netcloud_image" "ubuntu" with family = "ubuntu-2404"; it returns the newest image in that family.\n\nPoint the instance\'s image at data.netcloud_image.ubuntu.id. Plan and read it: the data source is read first, and the instance must be replaced, because an instance cannot change its image in place. Apply, then look at what the data source returned with terraform state show data.netcloud_image.ubuntu.',
    concepts: ['data blocks', 'resource versus data', 'Referring to data source attributes', 'Replacement caused by a new value'],
    hints: ['data "netcloud_image" "ubuntu" {\n  family = "ubuntu-2404"\n}', "sed -i 's/\"img-ubuntu-2204-20260815\"/data.netcloud_image.ubuntu.id/' main.tf", 'terraform plan shows data.netcloud_image.ubuntu: Reading... before the plan.', 'terraform apply -auto-approve, then terraform state show data.netcloud_image.ubuntu'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': OLD_IMAGE }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'data', label: 'Look the image up', checks: [{ type: 'tf-config', device: TF, pattern: 'data\\s+"netcloud_image"\\s+"ubuntu"', label: 'A netcloud_image data source named ubuntu' }, { type: 'tf-resource', device: TF, address: 'data.netcloud_image.ubuntu' }] },
      { id: 'use', label: 'Use it instead of the literal', checks: [{ type: 'tf-config', device: TF, pattern: 'img-ubuntu-2204', absent: true, label: 'The old image ID is gone from the configuration' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.web', attrs: { image: IMAGE_2404 } }] },
      { id: 'read', label: 'Read what the data source returned', checks: [{ type: 'tf-ran', device: TF, command: 'state show', argsPattern: 'data\\.netcloud_image', label: 'Ran terraform state show data.netcloud_image.ubuntu' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-11-count-and-for-each',
    moduleId: MODULE,
    order: 3,
    title: 'Many From One: count and for_each',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    description: 'Create one subnet per map entry with for_each and several identical servers with count, then scale down and watch which instance goes.',
    scenario:
      'variables.tf describes a small fleet: a map of subnets by name, and how many web servers to run. main.tf has only the network. Copying a resource block per subnet would work until the map changes, so let Terraform repeat the blocks.\n\nAdd netcloud_subnet.this with for_each = var.subnets. Inside the block, each.key is the subnet\'s name and each.value its range; name the subnet each.key. Instances are addressed by key, as netcloud_subnet.this["app"], so removing one entry later removes exactly that subnet and nothing else.\n\nAdd netcloud_instance.web with count = var.web_count, named "web-${count.index}", size small, image ' + IMAGE_2404 + ', in netcloud_subnet.this["app"]. count instances are addressed by position: netcloud_instance.web[0], [1].\n\nInitialise and apply. Then scale down with terraform apply -var="web_count=1" and read the plan: only index 1 is destroyed. count suits identical copies; for_each suits things that each have a name.',
    concepts: ['for_each over a map', 'each.key and each.value', 'count and count.index', 'Instance addresses: [0] and ["app"]'],
    hints: ['resource "netcloud_subnet" "this" {\n  for_each   = var.subnets\n  network_id = netcloud_network.main.id\n  name       = each.key\n  cidr_block = each.value\n}', 'resource "netcloud_instance" "web" {\n  count     = var.web_count\n  name      = "web-${count.index}"\n  …\n  subnet_id = netcloud_subnet.this["app"].id\n}', "Append with cat >> main.tf << 'EOF', then terraform init and terraform apply -auto-approve.", 'terraform apply -var="web_count=1" -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'variables.tf': LOOP_VARS, 'main.tf': LOOP_NETWORK } }),
    objectives: [
      { id: 'foreach', label: 'One subnet per map entry', checks: [{ type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["app"]', attrs: { cidr_block: '10.30.1.0/24' } }, { type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["db"]', attrs: { cidr_block: '10.30.2.0/24' } }] },
      { id: 'count', label: 'Identical servers with count', checks: [{ type: 'tf-config', device: TF, pattern: 'count\\s*=\\s*var\\.web_count', label: 'The instance block uses count = var.web_count' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.web[0]', attrs: { name: 'web-0' } }] },
      { id: 'scale', label: 'Scale down and lose only the last one', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, argsPattern: 'web_count=1', destroy: 1, label: 'Applied web_count=1 and destroyed exactly one instance' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.web[1]', exists: false }, { type: 'cloud-object', device: TF, kind: 'instance', count: 1 }] },
    ],
  },
  {
    id: 'tf-12-expressions-and-functions',
    moduleId: MODULE,
    order: 4,
    title: 'Complex Types and Functions',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Work with an object variable, try expressions in terraform console, and compute subnets and tags with for expressions, cidrsubnet and merge.',
    scenario:
      'The analytics team describes its network as one structured value: variables.tf declares network as an object with a name, a range, and a list of subnets, each with an optional public flag that defaults to false. terraform.tfvars fills it in. main.tf is empty.\n\nExperiment before you write. terraform console evaluates expressions against this configuration: try var.network.subnets, cidrsubnet(var.network.cidr, 8, 0), [for s in var.network.subnets : s.name], and { for i, s in var.network.subnets : s.name => cidrsubnet(var.network.cidr, 8, i) }. Type exit to leave.\n\nNow write main.tf. A locals block names computed values: set subnets to a map from each subnet\'s name to an object holding its cidr (the i-th /24 of the network) and its public flag, and tags to merge(var.common_tags, { network = var.network.name }). Create the network with the name, range and local.tags, then netcloud_subnet.this with for_each = local.subnets.\n\nFinish with an output subnet_cidrs built with a for expression over netcloud_subnet.this, mapping each key to its cidr_block, and apply.',
    concepts: ['object, list, map and optional() types', 'terraform console', 'for expressions', 'locals', 'cidrsubnet() and merge()'],
    hints: [
      'terraform console, then cidrsubnet(var.network.cidr, 8, 0) prints "10.40.0.0/24".',
      'locals {\n  subnets = { for i, s in var.network.subnets : s.name => { cidr = cidrsubnet(var.network.cidr, 8, i), public = s.public } }\n  tags    = merge(var.common_tags, { network = var.network.name })\n}',
      'resource "netcloud_subnet" "this" {\n  for_each   = local.subnets\n  network_id = netcloud_network.main.id\n  name       = each.key\n  cidr_block = each.value.cidr\n  public     = each.value.public\n}',
      'output "subnet_cidrs" {\n  value = { for k, s in netcloud_subnet.this : k => s.cidr_block }\n}',
    ],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'variables.tf': COMPLEX_VARS, 'terraform.tfvars': COMPLEX_TFVARS, 'main.tf': '' }, prepare: ['terraform init'] }),
    objectives: [
      { id: 'console', label: 'Try expressions in the console', checks: [{ type: 'tf-ran', device: TF, command: 'console', label: 'Ran terraform console' }, { type: 'shell-output', device: TF, pattern: '10\\.40\\.0\\.0/24', label: 'Evaluated a cidrsubnet() that printed 10.40.0.0/24' }] },
      { id: 'locals', label: 'Compute values with locals', checks: [{ type: 'tf-config', device: TF, pattern: 'locals\\s*\\{', label: 'A locals block' }, { type: 'tf-config', device: TF, pattern: 'merge\\(', label: 'Tags built with merge()' }, { type: 'tf-config', device: TF, pattern: '\\bfor\\s+\\w+\\s*,?\\s*\\w*\\s+in\\b', label: 'A for expression' }] },
      {
        id: 'subnets',
        label: 'Subnets carved out of the object',
        checks: [
          { type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["public"]', attrs: { cidr_block: '10.40.0.0/24', public: true } },
          { type: 'tf-resource', device: TF, address: 'netcloud_subnet.this["private"]', attrs: { cidr_block: '10.40.1.0/24', public: false } },
        ],
      },
      { id: 'output', label: 'Output a map', checks: [{ type: 'tf-output', device: TF, name: 'subnet_cidrs' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-13-dynamic-blocks',
    moduleId: MODULE,
    order: 5,
    title: 'Dynamic Blocks',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Replace repeated nested blocks with a dynamic block driven by a variable, then add a rule by changing data rather than code.',
    scenario:
      'The edge firewall is running, and its three ingress rules are written out as three nested blocks. Every new rule means copying a block and hoping nobody gets the indentation wrong. Nested blocks cannot use count or for_each, but a dynamic block can generate them.\n\nCreate variables.tf with a variable ingress_rules: a list of objects, each with a port (number) and cidr_blocks (list of strings). Give it a default holding the three existing rules, and a fourth that opens 8443 to 0.0.0.0/0 for the new admin console.\n\nReplace the three ingress blocks with one dynamic "ingress" block whose for_each is var.ingress_rules. In its content block, ingress.value is the current rule: port = ingress.value.port and cidr_blocks = ingress.value.cidr_blocks.\n\nPlan: the firewall is updated in place with one new rule, because the other three come out exactly as before. Apply.',
    concepts: ['dynamic blocks', 'for_each and content', 'The iterator (ingress.value)', 'Configuration driven by data'],
    hints: ['variable "ingress_rules" {\n  type = list(object({\n    port        = number\n    cidr_blocks = list(string)\n  }))\n  default = [ … ]\n}', 'dynamic "ingress" {\n  for_each = var.ingress_rules\n  content {\n    port        = ingress.value.port\n    cidr_blocks = ingress.value.cidr_blocks\n  }\n}', 'Rewrite main.tf with cat > main.tf << \'EOF\'.', 'terraform plan shows 1 to change; then terraform apply -auto-approve'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': STATIC_FIREWALL }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'var', label: 'Describe the rules as data', checks: [{ type: 'tf-config', device: TF, pattern: 'variable\\s+"ingress_rules"', label: 'A variable named ingress_rules' }] },
      { id: 'dynamic', label: 'Generate the blocks', checks: [{ type: 'tf-config', device: TF, pattern: 'dynamic\\s+"ingress"', label: 'A dynamic "ingress" block' }, { type: 'tf-config', device: TF, pattern: '^\\s*ingress\\s*\\{', absent: true, label: 'No hand-written ingress blocks remain' }] },
      { id: 'rule', label: 'Add a rule by changing data', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, change: 1, add: 0, destroy: 0, label: 'Applied an in-place update to the firewall' }, { type: 'cloud-object', device: TF, kind: 'firewall', name: 'edge', ingressRules: 4 }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-14-dependencies-and-lifecycle',
    moduleId: MODULE,
    order: 6,
    title: 'Dependencies and Lifecycle',
    difficulty: 'Advanced',
    estimatedMinutes: 16,
    description: 'Declare a dependency Terraform cannot see, replace a server without a gap, and protect a database from being destroyed.',
    scenario:
      'The orders service is running. Three things about it are not written down anywhere Terraform can read.\n\nFirst, the web server finds its log bucket by listing buckets when it boots, so nothing in its configuration refers to netcloud_bucket.logs. Terraform only orders what it can see, so on a fresh build the server could start before the bucket exists. Add depends_on = [netcloud_bucket.logs] to the instance.\n\nSecond, the server needs the newer image, ' + IMAGE_2404 + ', and changing the image replaces it. By default Terraform destroys the old server and then creates the new one, which is an outage. Add a lifecycle block with create_before_destroy = true, change the image, and apply: the plan symbol becomes +/-, the new server is created first, and the old one is destroyed as a deposed object at the end.\n\nThird, the orders database must never be destroyed by accident. Add lifecycle { prevent_destroy = true } to it, then run terraform destroy and read the error. Nothing is removed.',
    concepts: ['Implicit and explicit dependencies', 'depends_on', 'create_before_destroy', 'prevent_destroy'],
    hints: ['Inside netcloud_instance.web: depends_on = [netcloud_bucket.logs]', 'lifecycle {\n  create_before_destroy = true\n}', "sed -i 's/img-ubuntu-2204-20260815/img-ubuntu-2404-20260901/' main.tf, then terraform apply -auto-approve", 'lifecycle { prevent_destroy = true } in the database, then terraform destroy'],
    createState: () => tfSite({ files: { 'versions.tf': versions(RANDOM_PROVIDER), 'main.tf': LIFECYCLE_BEFORE }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'depends', label: 'Declare the hidden dependency', checks: [{ type: 'tf-config', device: TF, pattern: 'depends_on\\s*=\\s*\\[\\s*netcloud_bucket\\.logs\\s*\\]', label: 'The instance has depends_on = [netcloud_bucket.logs]' }] },
      { id: 'cbd', label: 'Replace the server without a gap', checks: [{ type: 'tf-config', device: TF, pattern: 'create_before_destroy\\s*=\\s*true', label: 'The instance has create_before_destroy = true' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.web', attrs: { image: IMAGE_2404 } }, { type: 'cloud-object', device: TF, kind: 'instance', count: 1 }] },
      { id: 'protect', label: 'Protect the database', checks: [{ type: 'tf-config', device: TF, pattern: 'prevent_destroy\\s*=\\s*true', label: 'The database has prevent_destroy = true' }, { type: 'tf-ran', device: TF, command: 'destroy', code: 1, label: 'Tried terraform destroy and it refused' }, { type: 'cloud-object', device: TF, kind: 'database', name: 'orders' }] },
    ],
  },
  {
    id: 'tf-15-custom-conditions',
    moduleId: MODULE,
    order: 7,
    title: 'Custom Conditions',
    difficulty: 'Advanced',
    estimatedMinutes: 15,
    description: 'Reject bad input with variable validation, check assumptions with preconditions and postconditions, and watch a continuous check block.',
    scenario:
      'The payments API is about to be built from this configuration, and the platform team has rules: instances are small or medium, they run an LTS image, and they are never given a public address. Rules that live only in a wiki get broken, so write them into the configuration, where Terraform checks them on every plan.\n\nIn variables.tf, add a validation block to instance_size: the condition contains(["small", "medium"], var.instance_size), and an error message saying so. Try it with terraform plan -var="instance_size=xlarge" and read the error.\n\nIn main.tf, add a lifecycle block to the instance with a precondition that the image\'s name contains "LTS" (strcontains(data.netcloud_image.base.name, "LTS")), and a postcondition that self.public_ip == null. A precondition is checked before Terraform acts; a postcondition checks the result, using self.\n\nFinally, add a check block named api_running with an assert that netcloud_instance.api.status == "running". Unlike the others, a failing check block only warns, and it is evaluated on every plan and apply. Initialise and apply.',
    concepts: ['variable validation', 'precondition and postcondition', 'self', 'check blocks'],
    hints: ['validation {\n  condition     = contains(["small", "medium"], var.instance_size)\n  error_message = "instance_size must be small or medium."\n}', 'terraform plan -var="instance_size=xlarge"', 'lifecycle {\n  precondition {\n    condition     = strcontains(data.netcloud_image.base.name, "LTS")\n    error_message = "Use an LTS image."\n  }\n  postcondition {\n    condition     = self.public_ip == null\n    error_message = "The API must not have a public address."\n  }\n}', 'check "api_running" {\n  assert {\n    condition     = netcloud_instance.api.status == "running"\n    error_message = "The API is not running."\n  }\n}'],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'variables.tf': CONDITIONS_VARS, 'main.tf': CONDITIONS_MAIN }, prepare: ['terraform init'] }),
    objectives: [
      { id: 'validation', label: 'Validate the input', checks: [{ type: 'tf-config', device: TF, pattern: 'validation\\s*\\{', label: 'instance_size has a validation block' }, { type: 'tf-ran', device: TF, command: 'plan', code: 1, argsPattern: 'xlarge', label: 'A plan with instance_size=xlarge was rejected' }] },
      { id: 'pre', label: 'Check assumptions before acting', checks: [{ type: 'tf-config', device: TF, pattern: 'precondition\\s*\\{', label: 'The instance has a precondition' }] },
      { id: 'post', label: 'Check the result after acting', checks: [{ type: 'tf-config', device: TF, pattern: 'postcondition\\s*\\{', label: 'The instance has a postcondition' }, { type: 'tf-config', device: TF, pattern: 'self\\.public_ip', label: 'The postcondition checks self.public_ip' }] },
      { id: 'check', label: 'Keep checking with a check block', checks: [{ type: 'tf-config', device: TF, pattern: 'check\\s+"api_running"', label: 'A check block named api_running' }, { type: 'tf-resource', device: TF, address: 'netcloud_instance.api' }, { type: 'tf-converged', device: TF }] },
    ],
  },
  {
    id: 'tf-16-secrets',
    moduleId: MODULE,
    order: 8,
    title: 'Keep Secrets Out of Code and State',
    difficulty: 'Advanced',
    estimatedMinutes: 16,
    description: 'Find the credentials a configuration leaks, move the API token to the environment, and give a database a password that never reaches state.',
    scenario:
      'The orders database works, and it leaks secrets in three places. Find them before you fix them: cat versions.tf, cat main.tf, and grep Sup3rSecret terraform.tfstate.\n\nThe API token is written into the provider block, so it is in version control for anyone with the repository. The provider also reads NETCLOUD_TOKEN from the environment, which is already set on this workstation; remove the token line.\n\nThe database password is in main.tf, and Terraform stores every argument in state in plain text, marked sensitive or not. Anyone who can read state can read the password. Terraform 1.11 added a better way: an ephemeral resource produces a value that is never written to a plan or state, and a write-only argument accepts such a value without storing it. Add ephemeral "random_password" "db" with length = 24, remove password, and set password_wo = ephemeral.random_password.db.result with password_wo_version = 1. Bump the version number whenever you want the password rotated.\n\nApply, confirm that state no longer contains the old password, and delete terraform.tfstate.backup, which still does. In production the password would come from a secrets manager such as HashiCorp Vault, read the same way through an ephemeral resource.',
    concepts: ['Provider credentials from the environment', 'Secrets in state', 'ephemeral resources', 'Write-only arguments and their version', 'Vault'],
    hints: ["sed -i '/token  =/d' versions.tf removes the token line.", 'ephemeral "random_password" "db" {\n  length = 24\n}', 'In the database: delete the password line, and add\n  password_wo         = ephemeral.random_password.db.result\n  password_wo_version = 1', 'terraform apply -auto-approve, grep -c Sup3rSecret terraform.tfstate, then rm terraform.tfstate.backup'],
    createState: () => tfSite({ files: { 'versions.tf': SECRETS_VERSIONS, 'main.tf': SECRETS_MAIN }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'find', label: 'Find the secrets', checks: [{ type: 'command', device: TF, pattern: '^(grep|cat|less)\\b.*terraform\\.tfstate', label: 'Looked inside terraform.tfstate' }] },
      { id: 'token', label: 'Take the token out of the code', checks: [{ type: 'tf-config', device: TF, pattern: 'nlc_', absent: true, label: 'No API token in any .tf file' }] },
      {
        id: 'wo',
        label: 'A password that never reaches state',
        checks: [
          { type: 'tf-config', device: TF, pattern: 'ephemeral\\s+"random_password"', label: 'An ephemeral random_password' },
          { type: 'tf-config', device: TF, pattern: 'Sup3rSecret', absent: true, label: 'No password in the configuration' },
          { type: 'tf-resource', device: TF, address: 'netcloud_database.orders', attrs: { password: null, password_wo_version: 1 } },
        ],
      },
      { id: 'clean', label: 'Leave nothing behind', checks: [{ type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate', notContains: 'Sup3rSecret' }, { type: 'file', device: TF, path: '/home/student/infra/terraform.tfstate.backup', exists: false }, { type: 'tf-converged', device: TF }] },
    ],
  },
];
