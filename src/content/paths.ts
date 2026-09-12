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

export const paths: LearningPath[] = [ccnaPath, linuxPath, sqlPath];

export function getPath(id: string): LearningPath | undefined {
  return paths.find((p) => p.id === id);
}

/** Route of a path page; the first path lives at the site root. */
export function pathUrl(id: string): string {
  return id === paths[0].id ? '/' : `/paths/${id}`;
}
