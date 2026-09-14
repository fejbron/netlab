import { BLUEPRINT, EXAM_DOMAINS, EXAM_TOPICS, PATH_OVERVIEW, type ExamDomain } from './blueprint';

/** What a learning path maps itself against: an exam blueprint with weighted domains and topics. */
export interface PathBlueprint {
  /** Human name of the standard, e.g. "200-301 CCNA v1.1". */
  version: string;
  reviewedAt: string;
  facts: ReadonlyArray<{ label: string; value: string }>;
  sources: ReadonlyArray<{ label: string; url: string }>;
  /** How the domain bars should be read. */
  intro: string;
  weightingNote: string;
  trademarkNotice: string;
  domains: ExamDomain[];
  /** Topic code → description; codes are "<domain>.<n>". */
  topics: Record<string, string>;
}

export interface LearningPath {
  id: string;
  title: string;
  shortTitle: string;
  scopeLabel: string;
  levelLabel: string;
  eyebrow: string;
  summary: string;
  outcomes: readonly string[];
  audience: string;
  prerequisites: string;
  skillTags: readonly string[];
  blueprint: PathBlueprint;
}

export const ccnaPath: LearningPath = {
  id: 'ccna',
  title: PATH_OVERVIEW.title,
  shortTitle: 'CCNA',
  scopeLabel: PATH_OVERVIEW.scopeLabel,
  levelLabel: PATH_OVERVIEW.levelLabel,
  eyebrow: 'Cisco IOS · in your browser',
  summary: PATH_OVERVIEW.summary,
  outcomes: PATH_OVERVIEW.outcomes,
  audience: PATH_OVERVIEW.audience,
  prerequisites: PATH_OVERVIEW.prerequisites,
  skillTags: PATH_OVERVIEW.skillTags,
  blueprint: {
    version: BLUEPRINT.version,
    reviewedAt: BLUEPRINT.reviewedAt,
    facts: BLUEPRINT.facts,
    sources: BLUEPRINT.sources,
    intro: 'Cisco publishes six exam domains. Each NetLab module is tagged with the blueprint topics it practises, so the bars below show how far you are through the hands-on part of each domain.',
    weightingNote: BLUEPRINT.weightingNote,
    trademarkNotice: BLUEPRINT.trademarkNotice,
    domains: EXAM_DOMAINS,
    topics: EXAM_TOPICS,
  },
};

/**
 * Linux Foundation Certified System Administrator (LFCS). The Linux Foundation publishes
 * five weighted domains but no numbered topics, so the codes below are NetLab's own
 * grouping of the published domain contents.
 */
export const LFCS_DOMAINS: ExamDomain[] = [
  { id: 'EC', title: 'Essential Commands', weight: 20 },
  { id: 'OD', title: 'Operations Deployment', weight: 25 },
  { id: 'UG', title: 'Users and Groups', weight: 10 },
  { id: 'NW', title: 'Networking', weight: 25 },
  { id: 'ST', title: 'Storage', weight: 20 },
];

export const LFCS_TOPICS: Record<string, string> = {
  'EC.1': 'Navigate the filesystem and read documentation (pwd, ls, cd, cat, man, help)',
  'EC.2': 'Create, delete, copy and move files and directories',
  'EC.3': 'Create and manage hard and soft links',
  'EC.4': 'List, set and change standard file permissions and ownership',
  'EC.5': 'Search for files and analyse text (find, grep, regular expressions)',
  'EC.6': 'Compare and manipulate file content (head, tail, sort, uniq, cut, sed, awk)',
  'EC.7': 'Use input-output redirection and pipes',
  'OD.1': 'Manage system services and their startup (systemctl, journalctl)',
  'OD.2': 'Install, update and remove software packages',
  'OD.3': 'Diagnose and manage processes and locate system log files',
  'OD.4': 'Create, run and debug shell scripts that automate tasks',
  'OD.5': 'Automate operations with Python and structured data (JSON)',
  'UG.1': 'Create, delete and modify local user and group accounts',
  'UG.2': 'Manage privilege escalation with sudo and system-wide environment',
  'NW.1': 'Inspect network interfaces, addresses and routing on a host',
  'NW.2': 'Troubleshoot connectivity with ping, traceroute and DNS tools',
  'NW.3': 'Inspect listening services and ports (ss) and reach them over HTTP',
  'NW.4': 'Consume network device APIs from Linux (curl, RESTCONF, JSON)',
  'NW.5': 'Configure a web server: virtual hosts, static content and reverse proxying (nginx)',
  'NW.6': 'Secure a service with TLS certificates and redirect plain HTTP',
  'NW.7': 'Distribute traffic across backends with a load balancer and handle backend failures',
  'NW.8': 'Manage a modular web server: enable modules and sites, and resolve port conflicts',
};

export const linuxPath: LearningPath = {
  id: 'linux',
  title: 'Linux Server Operator',
  shortTitle: 'Linux',
  scopeLabel: 'Linux administration and scripting path',
  levelLabel: 'Foundation',
  eyebrow: 'Ubuntu shell · in your browser',
  summary: 'Learn the Linux command line as you manage files, users, services and the network on a server, then automate it with Bash and Python.',
  outcomes: [
    'Move around a Linux filesystem, create and inspect files, and read documentation without leaving the terminal.',
    'Set permissions and ownership correctly, manage users and groups, and escalate privilege with sudo only when needed.',
    'Install packages, run and enable services with systemd, and read processes and logs to diagnose a server.',
    'Inspect addressing and routing from the host, test reachability, and call a router API with curl.',
    'Configure nginx and Apache as web servers, TLS terminators, reverse proxies and load balancers, and troubleshoot them with nginx -t, apache2ctl configtest and curl.',
    'Write Bash scripts with variables, conditions, loops and functions, and build text-processing pipelines.',
    'Run real Python in the browser to read files and JSON, generate configuration, and audit a system.',
  ],
  audience: 'Network and support engineers who need to be comfortable on a Linux server, and learners preparing for LFCS-level work.',
  prerequisites: 'No Linux experience required. Basic IP-address familiarity helps for the networking module.',
  skillTags: ['Bash', 'Files and permissions', 'systemd', 'Users and sudo', 'Networking', 'nginx and TLS', 'Python'],
  blueprint: {
    version: 'LFCS (2024 domains)',
    reviewedAt: '2026-09-11',
    facts: [
      { label: 'Exam', value: 'LFCS' },
      { label: 'Format', value: 'Hands-on' },
      { label: 'Duration', value: '120 min' },
      { label: 'Domains', value: '5' },
    ],
    sources: [
      { label: 'LFCS certification page', url: 'https://training.linuxfoundation.org/certification/linux-foundation-certified-sysadmin-lfcs/' },
      { label: 'Candidate handbook', url: 'https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2' },
    ],
    intro: 'The Linux Foundation publishes five weighted domains for LFCS but no numbered topics, so the codes below are NetLab’s grouping of the published domain contents. The bars show how far you are through the hands-on part of each domain.',
    weightingNote: 'The five percentages reproduce the domain weighting published for LFCS. The Linux Foundation may revise the exam without notice.',
    trademarkNotice: 'NetLab is an independent, open-source simulator and is not affiliated with, authorized, sponsored, or endorsed by The Linux Foundation. Linux Foundation® and LFCS are trademarks of The Linux Foundation. Linux® is the registered trademark of Linus Torvalds. The labs are original and are not official training or a guarantee of exam readiness.',
    domains: LFCS_DOMAINS,
    topics: LFCS_TOPICS,
  },
};

/**
 * SQL has no single vendor exam the way CCNA and LFCS do, so these five areas are
 * NetLab's own syllabus rather than a published blueprint, and the weights say how much
 * of this path is spent on each rather than what any examiner asks. The language itself
 * is standardised (ISO/IEC 9075); the dialect the labs speak is PostgreSQL's.
 */
export const SQL_DOMAINS: ExamDomain[] = [
  { id: 'QL', title: 'Querying', weight: 30 },
  { id: 'JA', title: 'Joins and Aggregation', weight: 25 },
  { id: 'DM', title: 'Changing Data', weight: 15 },
  { id: 'SD', title: 'Schema Design', weight: 20 },
  { id: 'PS', title: 'Performance and Safety', weight: 10 },
];

export const SQL_TOPICS: Record<string, string> = {
  'QL.1': 'Connect to a database and read its tables and columns',
  'QL.2': 'Select columns and filter rows with WHERE',
  'QL.3': 'Compare with =, <, IN, BETWEEN and LIKE',
  'QL.4': 'Sort with ORDER BY, and trim with LIMIT and DISTINCT',
  'QL.5': 'Handle NULL, the value that is not a value',
  'QL.6': 'Compute expressions and name them with AS',
  'JA.1': 'Join two tables on a matching column',
  'JA.2': 'Keep unmatched rows with an outer join',
  'JA.3': 'Summarise with count, sum, avg, min and max',
  'JA.4': 'Group rows with GROUP BY and filter groups with HAVING',
  'JA.5': 'Ask a question inside a question with subqueries and EXISTS',
  'DM.1': 'Add rows with INSERT',
  'DM.2': 'Change rows with UPDATE and remove them with DELETE',
  'DM.3': 'Group changes into a transaction and undo them with ROLLBACK',
  'SD.1': 'Create tables and choose column types',
  'SD.2': 'Identify rows with a primary key',
  'SD.3': 'Constrain data with NOT NULL, UNIQUE, DEFAULT and CHECK',
  'SD.4': 'Relate tables with foreign keys and keep them consistent',
  'SD.5': 'Change an existing table with ALTER TABLE',
  'PS.1': 'Read a query plan with EXPLAIN',
  'PS.2': 'Speed up a lookup with an index, and know its cost',
  'PS.3': 'Save a query as a view',
};

export const sqlPath: LearningPath = {
  id: 'sql',
  title: 'SQL and Databases',
  shortTitle: 'SQL',
  scopeLabel: 'Relational database and SQL path',
  levelLabel: 'Foundation',
  eyebrow: 'PostgreSQL · in your browser',
  summary: 'Learn SQL at a real psql prompt: read data with queries, combine and summarise it, change it safely, design the tables behind it, and make it fast.',
  outcomes: [
    'Connect to a database, read its structure, and answer questions with SELECT, WHERE and ORDER BY.',
    'Handle NULL correctly, and know why comparing to it never matches.',
    'Combine tables with inner and outer joins, and see which rows an inner join quietly drops.',
    'Summarise data with GROUP BY and aggregate functions, and filter groups with HAVING.',
    'Add, change and remove rows, and wrap risky changes in a transaction you can roll back.',
    'Design tables with the right types, primary keys, foreign keys and constraints, so bad data is refused at the door.',
    'Read a query plan, add an index that changes it, and save a query as a view.',
  ],
  audience: 'Anyone who needs to get answers out of a database: developers, analysts, and operations engineers who have so far been handed the queries.',
  prerequisites: 'No database experience required. The labs open at a psql prompt, so no Linux knowledge is needed either.',
  skillTags: ['SELECT', 'Joins', 'Aggregation', 'Transactions', 'Schema design', 'Indexes', 'PostgreSQL'],
  blueprint: {
    version: 'NetLab SQL syllabus v1',
    reviewedAt: '2026-09-12',
    facts: [
      { label: 'Dialect', value: 'PostgreSQL' },
      { label: 'Standard', value: 'ISO/IEC 9075' },
      { label: 'Prompt', value: 'psql' },
      { label: 'Areas', value: '5' },
    ],
    sources: [
      { label: 'PostgreSQL tutorial', url: 'https://www.postgresql.org/docs/current/tutorial.html' },
      { label: 'PostgreSQL SQL reference', url: 'https://www.postgresql.org/docs/current/sql-commands.html' },
    ],
    intro: 'SQL has no single certification the way networking and Linux do, so these five areas are NetLab’s own syllabus rather than an exam blueprint. The bars show how far you are through each area.',
    weightingNote: 'The percentages say how much of this path is spent on each area. They are NetLab’s own editorial judgement and do not come from any examining body.',
    trademarkNotice: 'NetLab is an independent, open-source simulator. PostgreSQL and the PostgreSQL logo are trademarks of the PostgreSQL Community Association of Canada. The labs are original and are not official PostgreSQL training.',
    domains: SQL_DOMAINS,
    topics: SQL_TOPICS,
  },
};

/**
 * HashiCorp Certified: Terraform Associate (004). HashiCorp publishes eight objectives and
 * their sub-objectives (1a, 1b, ...) but no weighting, so the percentages below are each
 * objective's share of the published sub-objectives, rounded. Codes are written 1.a so
 * they sort and group like the other paths' blueprints.
 */
export const TF_DOMAINS: ExamDomain[] = [
  { id: '1', title: 'Infrastructure as Code (IaC) with Terraform', weight: 8 },
  { id: '2', title: 'Terraform fundamentals', weight: 11 },
  { id: '3', title: 'Core Terraform workflow', weight: 19 },
  { id: '4', title: 'Terraform configuration', weight: 21 },
  { id: '5', title: 'Terraform modules', weight: 11 },
  { id: '6', title: 'Terraform state management', weight: 11 },
  { id: '7', title: 'Maintain infrastructure with Terraform', weight: 8 },
  { id: '8', title: 'HCP Terraform', weight: 11 },
];

export const TF_TOPICS: Record<string, string> = {
  '1.a': 'Explain what IaC is',
  '1.b': 'Describe the advantages of IaC patterns',
  '1.c': 'Explain how Terraform manages multi-cloud, hybrid cloud, and service-agnostic workflows',
  '2.a': 'Install and version Terraform providers',
  '2.b': 'Describe how Terraform uses providers',
  '2.c': 'Write Terraform configuration using multiple providers',
  '2.d': 'Explain how Terraform uses and manages state',
  '3.a': 'Describe the Terraform workflow',
  '3.b': 'Initialize a Terraform working directory',
  '3.c': 'Validate a Terraform configuration',
  '3.d': 'Generate and review an execution plan for Terraform',
  '3.e': 'Apply changes to infrastructure with Terraform',
  '3.f': 'Destroy Terraform-managed infrastructure',
  '3.g': 'Apply formatting and style adjustments to a configuration',
  '4.a': 'Use and differentiate resource and data blocks',
  '4.b': 'Refer to resource attributes and create cross-resource references',
  '4.c': 'Use variables and outputs',
  '4.d': 'Understand and use complex types',
  '4.e': 'Write dynamic configuration using expressions and functions',
  '4.f': 'Define resource dependencies in configuration',
  '4.g': 'Validate configuration using custom conditions',
  '4.h': 'Understand best practices for managing sensitive data, including secrets management with Vault',
  '5.a': 'Explain how Terraform sources modules',
  '5.b': 'Describe variable scope within modules',
  '5.c': 'Use modules in configuration',
  '5.d': 'Manage module versions',
  '6.a': 'Describe the local backend',
  '6.b': 'Describe state locking',
  '6.c': 'Configure remote state using the backend block',
  '6.d': 'Manage resource drift and Terraform state',
  '7.a': 'Import existing infrastructure into your Terraform workspace',
  '7.b': 'Use the CLI to inspect state',
  '7.c': 'Describe when and how to use verbose logging',
  '8.a': 'Use HCP Terraform to create infrastructure',
  '8.b': 'Describe HCP Terraform collaboration and governance features',
  '8.c': 'Describe how to organize and use HCP Terraform workspaces and projects',
  '8.d': 'Configure and use HCP Terraform integration',
};

export const terraformPath: LearningPath = {
  id: 'terraform',
  title: 'Terraform Infrastructure as Code',
  shortTitle: 'Terraform',
  scopeLabel: 'Cloud infrastructure as code path',
  levelLabel: 'Associate',
  eyebrow: 'Terraform · in your browser',
  summary: 'Learn Terraform by building cloud infrastructure in a simulated, vendor-neutral cloud: write configuration, plan and apply it, manage state, build modules, and run it in HCP Terraform.',
  outcomes: [
    'Explain infrastructure as code, and run the init, validate, plan, apply and destroy workflow with confidence.',
    'Install and pin providers, read the dependency lock file, and use several providers and provider configurations together.',
    'Write configuration with variables, outputs, data sources, complex types, expressions, functions, for_each, count and dynamic blocks.',
    'Control dependencies and lifecycle, validate inputs with custom conditions, and keep secrets out of code and out of state.',
    'Write local modules, consume versioned registry modules, and refactor resources into modules without recreating them.',
    'Inspect and change state safely, resolve drift, import existing infrastructure, move state to a remote backend and recover from a stale lock.',
    'Debug with verbose logging, and use HCP Terraform workspaces, projects, remote runs and policy checks.',
  ],
  audience: 'Network, systems and cloud engineers who build infrastructure by hand today, and learners preparing for the HashiCorp Terraform Associate (004) exam.',
  prerequisites: 'Comfort at a Linux shell (the Linux path covers it) and basic IP addressing. No cloud account is needed: the cloud is simulated.',
  skillTags: ['HCL', 'Providers', 'Plan and apply', 'State', 'Modules', 'Import and drift', 'HCP Terraform'],
  blueprint: {
    version: 'Terraform Associate (004)',
    reviewedAt: '2026-09-14',
    facts: [
      { label: 'Exam', value: 'Associate 004' },
      { label: 'Duration', value: '1 hour' },
      { label: 'Tests', value: 'Terraform 1.12' },
      { label: 'Objectives', value: '8' },
    ],
    sources: [
      { label: 'Terraform Associate (004) exam content list', url: 'https://developer.hashicorp.com/terraform/tutorials/certification-004/associate-review-004' },
      { label: 'HashiCorp infrastructure automation certifications', url: 'https://developer.hashicorp.com/certifications/infrastructure-automation' },
    ],
    intro: 'HashiCorp publishes eight exam objectives, each with lettered sub-objectives (1a, 1b and so on, written 1.a here). Every NetLab module is tagged with the sub-objectives it practises, so the bars show how far you are through the hands-on part of each objective. The exam itself is multiple choice; the labs build the understanding it tests.',
    weightingNote: 'HashiCorp does not publish a weighting for the objectives. The percentages here are each objective’s share of the published sub-objectives, which is NetLab’s approximation rather than HashiCorp’s.',
    trademarkNotice: 'NetLab is an independent, open-source simulator and is not affiliated with, authorized, sponsored, or endorsed by HashiCorp or IBM. HashiCorp, Terraform and HCP Terraform are trademarks of HashiCorp, an IBM company. NetLab Cloud is a fictional cloud that exists only in this simulator. The labs are original and are not official training or a guarantee of exam readiness.',
    domains: TF_DOMAINS,
    topics: TF_TOPICS,
  },
};

export const paths: LearningPath[] = [ccnaPath, linuxPath, sqlPath, terraformPath];

export function getPath(id: string): LearningPath | undefined {
  return paths.find((p) => p.id === id);
}

/** Route of a path page. The site root is the home page, so every path has its own. */
export function pathUrl(id: string): string {
  return `/paths/${id}`;
}
