import type { CloudSpec, HcpWorkspace } from '../../engine/terraform/cloud';
import type { Lab } from '../types';
import { HCP_TOKEN, HOME, IMAGE_2404, tfSite, TF, TOKEN, versions } from './tf-site';

const MODULE = 'tf-hcp';
const ORG = 'netlab-academy';

const NETWORK_VARS: HcpWorkspace['vars'] = {
  NETCLOUD_TOKEN: { value: TOKEN, category: 'env', sensitive: true },
  NETCLOUD_REGION: { value: 'eu-west', category: 'env' },
};

function workspace(name: string, project: string, tags: string[], vars: HcpWorkspace['vars'] = NETWORK_VARS): HcpWorkspace {
  return { name, project, tags, vars, runs: 0 };
}

const CREDENTIALS = JSON.stringify({ credentials: { 'app.terraform.io': { token: HCP_TOKEN } } }, null, 2) + '\n';

const DEV_MAIN = `resource "netcloud_network" "main" {
  name       = "network-dev"
  cidr_block = "10.30.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.30.1.0/24"
}

resource "netcloud_instance" "bastion" {
  name      = "bastion"
  size      = "small"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

/** Versions without a provider block: in HCP Terraform the region comes from the workspace. */
const HCP_VERSIONS = versions().replace(/\nprovider "netcloud" \{\n  region = "eu-west"\n\}\n/, '');

const CLOUD_BLOCK_NAME = `terraform {
  cloud {
    organization = "${ORG}"

    workspaces {
      name = "network-dev"
    }
  }
}
`;

const CLOUD_BLOCK_TAGS = `terraform {
  cloud {
    organization = "${ORG}"

    workspaces {
      project = "Networking"
      tags    = ["networking"]
    }
  }
}
`;

const POLICY_MAIN = `resource "netcloud_network" "main" {
  name       = "network-dev"
  cidr_block = "10.30.0.0/16"
}

resource "netcloud_subnet" "app" {
  network_id = netcloud_network.main.id
  cidr_block = "10.30.1.0/24"
}

resource "netcloud_instance" "analytics" {
  name      = "analytics"
  size      = "xlarge"
  image     = "${IMAGE_2404}"
  subnet_id = netcloud_subnet.app.id
}
`;

function hcp(extra: Partial<NonNullable<CloudSpec['hcp']>> = {}): CloudSpec {
  return {
    hcp: {
      organization: ORG,
      token: HCP_TOKEN,
      projects: ['Default Project', 'Networking', 'Apps'],
      workspaces: {
        'network-dev': workspace('network-dev', 'Networking', ['networking', 'dev']),
        'network-prod': workspace('network-prod', 'Networking', ['networking', 'prod']),
        'billing-api': workspace('billing-api', 'Apps', ['billing'], {}),
      },
      ...extra,
    },
  };
}

export const tfHcpLabs: Lab[] = [
  {
    id: 'tf-28-hcp-remote-runs',
    moduleId: MODULE,
    order: 1,
    title: 'Run in HCP Terraform',
    difficulty: 'Intermediate',
    estimatedMinutes: 16,
    description: 'Log in to HCP Terraform, connect a configuration with the cloud block, and run plan and apply remotely against a workspace.',
    scenario:
      'The networking team keeps its state and runs in HCP Terraform, in the organization ' + ORG + '. Runs there happen on HCP Terraform\'s workers rather than on your laptop: state is stored and locked for you, every run is recorded, and credentials live in the workspace instead of on everybody\'s machine.\n\nYour team lead created an API token for you and saved it in ~/hcp-token.txt. Run terraform login and follow the prompts: confirm with yes, then paste the token (cat the file first; the prompt hides what you type). Terraform stores it in ~/.terraform.d/credentials.tfrc.json. (In automation you would set TF_TOKEN_app_terraform_io instead.)\n\nConnect ~/infra to the network-dev workspace by adding cloud.tf with a terraform block containing cloud { organization = "' + ORG + '", workspaces { name = "network-dev" } }. versions.tf sets no region and this shell has no NETCLOUD_TOKEN, on purpose: the network-dev workspace holds NETCLOUD_TOKEN and NETCLOUD_REGION as environment variables, and remote runs use those.\n\nRun terraform init, then terraform plan. The output streams from the remote run, with a link to it in the HCP Terraform UI. Apply, and confirm with yes.',
    concepts: ['terraform login', 'The cloud block', 'Remote runs and remote state', 'Workspace variables'],
    hints: ['cat ~/hcp-token.txt, then terraform login: type yes, then paste the token.', "cat > cloud.tf << 'EOF'\nterraform {\n  cloud {\n    organization = \"" + ORG + "\"\n\n    workspaces {\n      name = \"network-dev\"\n    }\n  }\n}\nEOF", 'terraform init, then terraform plan: the plan runs in HCP Terraform.', 'terraform apply, and type yes.'],
    createState: () => tfSite({ files: { 'versions.tf': HCP_VERSIONS, 'main.tf': DEV_MAIN, [`${HOME}/hcp-token.txt`]: HCP_TOKEN + '\n' }, noToken: true, cloud: hcp() }),
    objectives: [
      { id: 'login', label: 'Log in', checks: [{ type: 'file', device: TF, path: `${HOME}/.terraform.d/credentials.tfrc.json`, contains: 'app\\.terraform\\.io' }] },
      { id: 'connect', label: 'Connect the configuration', checks: [{ type: 'tf-config', device: TF, pattern: 'cloud\\s*\\{', label: 'A cloud block names the organization and workspace' }, { type: 'tf-backend', device: TF, backend: 'cloud' }] },
      { id: 'plan', label: 'Plan remotely', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 0, remote: true, label: 'Ran a remote plan in HCP Terraform' }] },
      { id: 'apply', label: 'Apply remotely', checks: [{ type: 'hcp-workspace', device: TF, name: 'network-dev', resources: 3 }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'bastion' }] },
    ],
  },
  {
    id: 'tf-29-hcp-workspaces-projects',
    moduleId: MODULE,
    order: 2,
    title: 'Organize Workspaces and Projects',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Select HCP Terraform workspaces by project and tag from the CLI, switch between them, and create a new one that inherits its project.',
    scenario:
      'In HCP Terraform, a workspace holds one state, its variables, its run history and its permissions. Projects group workspaces, and teams are granted access to a project as a whole, so the networking team sees the Networking project and not the billing team\'s workspaces. Variable sets share credentials across many workspaces, and policy sets and run tasks apply checks to them.\n\nOne configuration often serves several workspaces: network-dev and network-prod here. Instead of naming a single workspace, cloud.tf selects every workspace in the Networking project tagged networking. You are already logged in.\n\nRun terraform init, then terraform workspace list: you see only the two networking workspaces, not billing-api. Select network-prod with terraform workspace select. Then create a staging workspace from the CLI with terraform workspace new network-staging; HCP Terraform creates it in the Networking project with the networking tag, because that is what the cloud block asks for. Check which one you are on with terraform workspace show.',
    concepts: ['Workspaces and projects', 'cloud block workspaces { tags, project }', 'terraform workspace in HCP Terraform', 'Teams, variable sets and policy sets'],
    hints: ['terraform init', 'terraform workspace list', 'terraform workspace select network-prod', 'terraform workspace new network-staging, then terraform workspace show'],
    createState: () => tfSite({ files: { 'versions.tf': HCP_VERSIONS, 'main.tf': DEV_MAIN.replace('"network-dev"', '"${terraform.workspace}"'), 'cloud.tf': CLOUD_BLOCK_TAGS, [`${HOME}/.terraform.d/credentials.tfrc.json`]: CREDENTIALS }, noToken: true, cloud: hcp() }),
    objectives: [
      { id: 'init', label: 'Initialise against the project', checks: [{ type: 'tf-ran', device: TF, command: 'init', code: 0 }, { type: 'tf-backend', device: TF, backend: 'cloud' }] },
      { id: 'list', label: 'See only your team\'s workspaces', checks: [{ type: 'tf-ran', device: TF, command: 'workspace list' }] },
      { id: 'select', label: 'Switch to production', checks: [{ type: 'tf-ran', device: TF, command: 'workspace select', argsPattern: 'network-prod', label: 'Selected network-prod' }] },
      { id: 'new', label: 'Create a staging workspace', checks: [{ type: 'hcp-workspace', device: TF, name: 'network-staging', project: 'Networking', tag: 'networking' }, { type: 'tf-workspace', device: TF, name: 'network-staging', current: true }] },
    ],
  },
  {
    id: 'tf-30-policy-as-code',
    moduleId: MODULE,
    order: 3,
    title: 'Policy as Code',
    difficulty: 'Advanced',
    estimatedMinutes: 14,
    description: 'Meet an organization policy check that blocks a run, read which rule failed, and change the configuration until the run is allowed.',
    scenario:
      'The analytics team wants a big server in network-dev. The configuration is already connected to that workspace and initialised, and the organization has governance in place: a policy set called netlab-guardrails runs after every plan in the Networking project, before any apply is allowed.\n\nRun terraform plan. The plan itself succeeds, then the organization policy check runs and fails hard: a hard-mandatory policy cannot be overridden by anyone, while a soft-mandatory one can be overridden by an authorised person and an advisory one only warns. Read the output: it names each policy and the resources that broke it.\n\nChange the configuration to comply. The instance becomes medium, the largest size allowed, and the network and the instance both get a tags map with owner = "analytics". Plan again to see the check pass, then apply and confirm.',
    concepts: ['Policy as code (Sentinel and OPA)', 'Enforcement levels: advisory, soft-mandatory, hard-mandatory', 'Policy checks in the run', 'Governance in HCP Terraform'],
    hints: ['terraform plan, and read the Organization policy check section.', "sed -i 's/\"xlarge\"/\"medium\"/' main.tf", 'Add tags = { owner = "analytics" } to netcloud_network.main and netcloud_instance.analytics.', 'terraform plan, then terraform apply and type yes.'],
    createState: () =>
      tfSite({
        files: { 'versions.tf': HCP_VERSIONS, 'main.tf': POLICY_MAIN, 'cloud.tf': CLOUD_BLOCK_NAME, [`${HOME}/.terraform.d/credentials.tfrc.json`]: CREDENTIALS },
        noToken: true,
        cloud: hcp({
          policySets: [
            {
              name: 'netlab-guardrails',
              projects: ['Networking'],
              policies: [
                { name: 'allowed-instance-sizes', enforcement: 'hard-mandatory', rule: 'allowed-instance-sizes', sizes: ['small', 'medium'] },
                { name: 'require-owner-tag', enforcement: 'hard-mandatory', rule: 'required-tags', tags: ['owner'] },
              ],
            },
          ],
        }),
        prepare: ['terraform init'],
      }),
    objectives: [
      { id: 'blocked', label: 'Meet the guardrail', checks: [{ type: 'tf-ran', device: TF, command: 'plan', code: 1, remote: true, label: 'A remote plan was stopped by the policy check' }] },
      { id: 'size', label: 'Use an allowed size', checks: [{ type: 'tf-config', device: TF, pattern: '"xlarge"', absent: true, label: 'No instance asks for xlarge' }] },
      { id: 'tags', label: 'Tag what you build', checks: [{ type: 'tf-config', device: TF, pattern: 'owner\\s*=\\s*"analytics"', label: 'Resources carry owner = "analytics"' }] },
      { id: 'apply', label: 'Apply once the policies pass', checks: [{ type: 'tf-ran', device: TF, command: 'apply', code: 0, remote: true }, { type: 'cloud-object', device: TF, kind: 'instance', name: 'analytics', attrs: { size: 'medium' } }, { type: 'hcp-workspace', device: TF, name: 'network-dev', resources: 3 }] },
    ],
  },
];
