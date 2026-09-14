import type { Lab } from '../types';
import { IMAGE_2204, IMAGE_2404, tfSite, TF, versions } from './tf-site';

const MODULE = 'tf-basics';

const HELLO = `terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

# A random, memorable name for our first server.
resource "random_pet" "server" {
  length = 2
}

# A file on this workstation that uses the name.
resource "local_file" "welcome" {
  filename = "\${path.module}/welcome.txt"
  content  = "Your first server is called \${random_pet.server.id}\\n"
}
`;

const BROKEN = `terraform {
  required_providers {
    random = {
      source = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

resource "random_pet" "server" {
  lenght = 2
  prefix = var.enviroment
}

variable "environment" {
type = string
    default = "lab"
}

output "name" {
  value=random_pet.server.id
}
`;

const REVIEW_BEFORE = `resource "netcloud_network" "main" {
  name       = "shop"
  cidr_block = "10.0.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.0.1.0/24"
}

resource "netcloud_firewall" "legacy" {
  name       = "legacy-ssh"
  network_id = netcloud_network.main.id

  ingress {
    port        = 22
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "netcloud_instance" "web" {
  name      = "web"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}

resource "netcloud_instance" "batch" {
  name      = "batch"
  size      = "small"
  image     = "${IMAGE_2204}"
  subnet_id = netcloud_subnet.app.id
}

resource "netcloud_database" "orders" {
  name           = "orders"
  engine         = "postgres"
  engine_version = "16"
  size           = "small"
  password       = var.db_password
}

variable "db_password" {
  type      = string
  sensitive = true
  default   = "correct-horse-battery"
}
`;

/** What a colleague pushed: a bigger web server, a newer image for batch, the old firewall gone, and a database engine change nobody meant to make. */
const REVIEW_AFTER = REVIEW_BEFORE.replace(`resource "netcloud_firewall" "legacy" {
  name       = "legacy-ssh"
  network_id = netcloud_network.main.id

  ingress {
    port        = 22
    cidr_blocks = ["0.0.0.0/0"]
  }
}

`, '')
  .replace('  name      = "web"\n  size      = "small"', '  name      = "web"\n  size      = "medium"')
  .replace(`  image     = "${IMAGE_2204}"`, `  image     = "${IMAGE_2404}"`)
  .replace('engine         = "postgres"', 'engine         = "mysql"');

export const tfBasicsLabs: Lab[] = [
  {
    id: 'tf-01-first-apply',
    moduleId: MODULE,
    order: 1,
    title: 'Your First Apply',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Run the core workflow for the first time: read a configuration, initialise the directory, preview the plan, and apply it.',
    scenario:
      'Infrastructure as code means describing what you want in files, and letting a tool make the real world match. The files can be reviewed, versioned and run again, which a sequence of clicks in a console never can.\n\nThe configuration in ~/infra is deliberately small. It uses two providers that need no cloud at all: random picks a memorable name, and local writes a file on this workstation. Read main.tf first and notice that nothing in it says how to create anything, only what should exist.\n\nThen run the workflow every Terraform change follows: terraform init downloads the providers the configuration names, terraform plan shows what would change without changing it, and terraform apply does the work after you type yes. Finish by reading welcome.txt, the file Terraform created.',
    concepts: ['Infrastructure as code', 'Providers', 'terraform init', 'terraform plan', 'terraform apply'],
    hints: ['cat main.tf shows the configuration.', 'terraform init reads required_providers and installs them into .terraform, then writes .terraform.lock.hcl.', 'terraform plan changes nothing. terraform apply prints the same plan and waits for you to type yes.', 'cat welcome.txt'],
    createState: () => tfSite({ files: { 'main.tf': HELLO } }),
    objectives: [
      { id: 'read', label: 'Read the configuration', checks: [{ type: 'command', device: TF, pattern: '^(cat|less|more|head) main\\.tf', label: 'Run cat main.tf' }] },
      { id: 'init', label: 'Initialise the working directory', checks: [{ type: 'tf-ran', device: TF, command: 'init', code: 0 }, { type: 'tf-lock', device: TF, provider: 'hashicorp/random' }] },
      { id: 'plan', label: 'Preview the change', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, add: 2, label: 'Ran terraform plan and saw 2 to add' }] },
      { id: 'apply', label: 'Apply it', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0 }, { type: 'tf-resource', device: TF, address: 'random_pet.server' }, { type: 'file', device: TF, path: '/home/student/infra/welcome.txt', contains: 'Your first server is called' }] },
      { id: 'look', label: 'Read what Terraform made', checks: [{ type: 'command', device: TF, pattern: '^cat (\\./)?welcome\\.txt', label: 'Run cat welcome.txt' }] },
    ],
  },
  {
    id: 'tf-02-change-and-destroy',
    moduleId: MODULE,
    order: 2,
    title: 'Change, Then Destroy',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Edit a configuration that is already applied, read why the plan replaces objects, apply the change, then destroy everything.',
    scenario:
      'The files from the last lab have been applied: random_pet.server exists and welcome.txt is on disk. Terraform remembers them in terraform.tfstate, which is how it knows that the next run is a change rather than a fresh start.\n\nMake two edits. Give the pet name three words instead of two, and change the welcome text to start with "Welcome aboard, " instead of "Your first server is called ". Neither the random_pet nor the local_file can be changed in place, so the plan will say each must be replaced, and will mark the argument that forces it.\n\nRun terraform plan and find the -/+ symbols and the "# forces replacement" notes. Apply the change. Then clean up with terraform destroy, which plans the removal of everything in state and asks you to confirm.',
    concepts: ['State', 'Update in place versus replacement', 'Plan symbols: +, ~, -/+, -', 'terraform destroy'],
    hints: ["sed -i 's/length = 2/length = 3/' main.tf", "sed -i 's/Your first server is called /Welcome aboard, /' main.tf", 'terraform plan should report 2 to add and 2 to destroy: a replacement counts as both.', 'terraform destroy asks for confirmation, like apply.'],
    createState: () => tfSite({ files: { 'main.tf': HELLO }, prepare: ['terraform init', 'terraform apply -auto-approve'] }),
    objectives: [
      { id: 'edit', label: 'Change the configuration', checks: [{ type: 'tf-config', device: TF, pattern: 'length\\s*=\\s*3', label: 'random_pet.server has length = 3' }, { type: 'tf-config', device: TF, pattern: 'Welcome aboard, ', label: 'The welcome text starts with "Welcome aboard, "' }] },
      { id: 'plan', label: 'See the replacements in a plan', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, add: 2, destroy: 2, label: 'Ran terraform plan showing 2 to add and 2 to destroy' }] },
      { id: 'apply', label: 'Apply the change', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, add: 2, destroy: 2, label: 'Applied the two replacements' }] },
      { id: 'destroy', label: 'Tear it all down', checks: [{ type: 'tf-ran', device: TF, command: 'destroy', code: 0 }, { type: 'tf-state-count', device: TF, count: 0 }, { type: 'file', device: TF, path: '/home/student/infra/welcome.txt', exists: false }] },
    ],
  },
  {
    id: 'tf-03-validate-and-format',
    moduleId: MODULE,
    order: 3,
    title: 'Validate and Format',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Let terraform validate find the mistakes in a configuration, fix them, and bring the files into the standard style with terraform fmt.',
    scenario:
      'A teammate wrote main.tf in a hurry and it does not work. Before anyone plans against real infrastructure, two commands catch most problems for free.\n\nterraform validate checks that the configuration is internally consistent: every argument exists in the provider schema, every reference points at something declared. It needs the providers installed, so run terraform init first, then validate, and read both errors. Each one names the file and line, and suggests what was meant.\n\nFix the two mistakes. Then check the style with terraform fmt -check, which exits with status 3 when files need formatting and changes nothing; terraform fmt rewrites them with consistent indentation and the equals signs lined up. Validate once more to confirm the configuration is clean.',
    concepts: ['terraform validate', 'Reading an error: file, line, summary, detail', 'terraform fmt and fmt -check', 'Canonical style'],
    hints: ['terraform init, then terraform validate.', "sed -i 's/lenght/length/' main.tf", "sed -i 's/var.enviroment/var.environment/' main.tf", 'terraform fmt -check lists the files that need formatting; terraform fmt fixes them.'],
    createState: () => tfSite({ files: { 'main.tf': BROKEN } }),
    objectives: [
      { id: 'find', label: 'Let validate find the mistakes', checks: [{ type: 'tf-ran', device: TF, command: 'validate', code: 1 }] },
      {
        id: 'fix',
        label: 'Fix them',
        checks: [
          { type: 'tf-config', device: TF, pattern: 'lenght', absent: true, label: 'The misspelled argument is fixed' },
          { type: 'tf-config', device: TF, pattern: 'enviroment', absent: true, label: 'The reference names the declared variable' },
          { type: 'tf-ran', device: TF, command: 'validate', code: 0 },
        ],
      },
      { id: 'check', label: 'Check the style without changing anything', checks: [{ type: 'tf-ran', device: TF, command: 'fmt', argsPattern: '-check', label: 'Ran terraform fmt -check' }] },
      { id: 'format', label: 'Format the files', checks: [{ type: 'tf-formatted', device: TF }] },
    ],
  },
  {
    id: 'tf-04-read-the-plan',
    moduleId: MODULE,
    order: 4,
    title: 'Read the Plan Before You Apply',
    difficulty: 'Intermediate',
    estimatedMinutes: 14,
    description: 'Review a colleague\'s change as a saved plan, catch the replacement that would lose a database, and apply exactly the plan you approved.',
    scenario:
      'The shop\'s network, two instances and an orders database are running and managed from ~/infra. A colleague has pushed an edit to main.tf and asked you to apply it. Do not trust the description; trust the plan.\n\nSave the plan to a file with terraform plan -out=change.tfplan, and read it again at leisure with terraform show change.tfplan. Go through it resource by resource: ~ is an update in place, -/+ destroys the object and creates a new one, and - destroys it. Most of the change is fine. One line is not: replacing a database means a new, empty database.\n\nPut the database engine back to postgres, save a fresh plan, check that it no longer replaces anything you care about, and apply that saved file. Applying a saved plan does not ask again, because you already reviewed it, and it refuses to run if the state changed since.',
    concepts: ['plan -out', 'terraform show on a plan file', '# forces replacement', 'Applying a saved plan'],
    hints: ['terraform plan -out=change.tfplan', 'terraform show change.tfplan', 'Look for netcloud_database.orders must be replaced, and the argument marked # forces replacement.', "sed -i 's/mysql/postgres/' main.tf, then plan -out again and terraform apply change.tfplan"],
    createState: () => tfSite({ files: { 'versions.tf': versions(), 'main.tf': REVIEW_BEFORE }, prepare: ['terraform init', 'terraform apply -auto-approve'], edits: { 'main.tf': REVIEW_AFTER } }),
    objectives: [
      { id: 'save', label: 'Save the plan for review', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, argsPattern: '-out', label: 'Ran terraform plan -out=…' }] },
      { id: 'show', label: 'Read the saved plan', checks: [{ type: 'tf-ran', device: TF, command: 'show', label: 'Ran terraform show on the plan file' }] },
      { id: 'keep', label: 'Keep the database', checks: [{ type: 'tf-config', device: TF, pattern: 'mysql', absent: true, label: 'The database engine is postgres again' }, { type: 'cloud-object', device: TF, kind: 'database', name: 'orders', attrs: { engine: 'postgres' } }] },
      {
        id: 'apply',
        label: 'Apply exactly what you reviewed',
        checks: [
          { type: 'tf-ran', device: TF, command: 'apply', code: 0, argsPattern: '\\.tfplan', label: 'Applied the saved plan file' },
          { type: 'cloud-object', device: TF, kind: 'instance', name: 'web', attrs: { size: 'medium' } },
          { type: 'cloud-object', device: TF, kind: 'firewall', name: 'legacy-ssh', exists: false },
          { type: 'tf-converged', device: TF },
        ],
      },
    ],
  },
];
