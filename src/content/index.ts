import { fromSwitch, isNetworkState, type NetworkState } from '../engine';
import type { Lab, Module } from './types';
import { meetTheCliLabs } from './labs/meet-the-cli';
import { learnSwitchingLabs } from './labs/learn-switching';
import { learnEtherchannelLabs } from './labs/learn-etherchannel';
import { learnStpLabs } from './labs/learn-stp';
import { secureTheSwitchLabs } from './labs/secure-the-switch';
import { learnRoutingLabs } from './labs/learn-routing';
import { learnOspfLabs } from './labs/learn-ospf';
import { multiAreaOspfLabs } from './labs/learn-ospf-multiarea';
import { learnAclLabs } from './labs/learn-acls';
import { learnDhcpLabs } from './labs/learn-dhcp';
import { learnNatLabs } from './labs/learn-nat';
import { learnIpv6Labs } from './labs/learn-ipv6';
import { learnSecurityLabs } from './labs/learn-security';
import { learnAutomationLabs } from './labs/learn-automation';
import { ccnaExamLabs } from './labs/ccna-exams';
import { linuxShellLabs } from './labs/linux-shell';
import { linuxAdminLabs } from './labs/linux-admin';
import { linuxScriptingLabs } from './labs/linux-scripting';
import { linuxPythonLabs } from './labs/linux-python';
import { linuxWebLabs } from './labs/linux-web';
import { linuxApacheLabs } from './labs/linux-apache';
import { sqlQueryLabs } from './labs/sql-query';
import { sqlCombineLabs } from './labs/sql-combine';
import { sqlChangeLabs } from './labs/sql-change';
import { sqlDesignLabs } from './labs/sql-design';
import { sqlPerformLabs } from './labs/sql-perform';
import { sqlExamLabs } from './labs/sql-exams';
import { tfBasicsLabs } from './labs/tf-basics';
import { tfProvidersLabs } from './labs/tf-providers';
import { tfConfigLabs } from './labs/tf-config';
import { tfModulesLabs } from './labs/tf-modules';
import { tfStateLabs } from './labs/tf-state';
import { tfHcpLabs } from './labs/tf-hcp';
import { tfExamLabs } from './labs/tf-exams';
import { anBasicsLabs } from './labs/an-basics';
import { anPlaybookLabs } from './labs/an-playbooks';
import { anFilesLabs } from './labs/an-files';
import { anSystemLabs } from './labs/an-system';
import { anRolesLabs } from './labs/an-roles';
import { anNetworkLabs } from './labs/an-network';
import { anExamLabs } from './labs/an-exams';
import { gitBasicsLabs } from './labs/git-basics';
import { gitBranchingLabs } from './labs/git-branching';
import { gitHistoryLabs } from './labs/git-history';
import { gitRemotesLabs } from './labs/git-remotes';
import { gitRewriteLabs } from './labs/git-rewrite';
import { gitWorkflowLabs } from './labs/git-workflow';
import { gitExamLabs } from './labs/git-exams';
import { paths } from './paths';

export type { Lab, Module, Difficulty } from './types';
export { BLUEPRINT, EXAM_DOMAINS, EXAM_TOPICS, PATH_OVERVIEW, domainCoverage, topicDomain, byTopicCode } from './blueprint';
export type { ExamDomain, DomainCoverage } from './blueprint';
export { paths, getPath, pathUrl, ccnaPath, linuxPath, sqlPath, terraformPath, ansiblePath, gitPath, LFCS_DOMAINS, LFCS_TOPICS, SQL_DOMAINS, SQL_TOPICS, TF_DOMAINS, TF_TOPICS, AN_DOMAINS, AN_TOPICS, GIT_DOMAINS, GIT_TOPICS } from './paths';
export type { LearningPath, PathBlueprint } from './paths';

export const modules: Module[] = [
  // --- CCNA
  { id: 'meet-the-cli', pathId: 'ccna', order: 1, title: 'Meet the CLI', description: 'Move through device prompts, read command output, and save your work.', examTopics: ['1.1', '4.8', '5.3'] },
  { id: 'learn-switching', pathId: 'ccna', order: 2, title: 'Learn Switching', description: 'Build VLANs, access ports and trunks, then troubleshoot them.', examTopics: ['1.13', '2.1', '2.2'] },
  { id: 'learn-etherchannel', pathId: 'ccna', order: 3, title: 'Learn EtherChannel', description: 'Bundle parallel links into one Port-channel with LACP and PAgP.', examTopics: ['2.4'] },
  { id: 'learn-stp', pathId: 'ccna', order: 4, title: 'Learn Spanning Tree', description: 'Read the tree, place the root bridge, protect edge ports, and recover a BPDU-guarded uplink.', examTopics: ['2.5'] },
  { id: 'secure-the-switch', pathId: 'ccna', order: 5, title: 'Secure the Switch', description: 'Encrypt passwords, enable SSH, lock down unused ports, and secure user ports.', examTopics: ['4.8', '5.3', '5.7'] },
  { id: 'learn-routing', pathId: 'ccna', order: 6, title: 'Learn Routing', description: 'Address router interfaces, build routing tables with static routes, and connect networks.', examTopics: ['1.6', '1.10', '3.1', '3.2', '3.3'] },
  { id: 'learn-ospf', pathId: 'ccna', order: 7, title: 'Learn OSPF', description: 'Let routers discover each other and exchange routes with single-area and multi-area OSPF.', examTopics: ['3.1', '3.4'] },
  { id: 'learn-acls', pathId: 'ccna', order: 8, title: 'Learn ACLs', description: 'Filter traffic with standard and extended access lists and protect management access.', examTopics: ['5.6'] },
  { id: 'learn-dhcp', pathId: 'ccna', order: 9, title: 'Learn DHCP', description: 'Hand out addresses from a router, relay across the network, and troubleshoot leases.', examTopics: ['1.10', '4.3', '4.6'] },
  { id: 'learn-nat', pathId: 'ccna', order: 10, title: 'Learn NAT', description: 'Publish a server with static NAT and share one public address with PAT.', examTopics: ['4.1'] },
  { id: 'learn-ipv6', pathId: 'ccna', order: 11, title: 'Learn IPv6', description: 'Address interfaces with global and link-local IPv6, then route between IPv6 networks.', examTopics: ['1.8', '1.9', '3.3'] },
  {
    id: 'learn-security',
    pathId: 'ccna',
    order: 12,
    title: 'Learn Network Security',
    description: 'Enforce password policy and AAA, protect the management plane, and defend the access layer with DHCP snooping and dynamic ARP inspection.',
    examTopics: ['5.3', '5.4', '5.7', '5.8'],
  },
  {
    id: 'learn-automation',
    pathId: 'ccna',
    order: 13,
    title: 'Learn Automation & AI Network Operations',
    description: 'Enable RESTCONF and NETCONF, read and change a router as JSON, feed telemetry to an AI operations platform, and verify an AI-proposed change before trusting it.',
    examTopics: ['4.2', '4.4', '4.5', '6.4', '6.5', '6.7'],
  },
  {
    id: 'ccna-exams',
    pathId: 'ccna',
    order: 14,
    title: 'CCNA Exams',
    description: 'Multi-device capstone exams that combine switching, routing, OSPF, ACLs, DHCP, NAT, IPv6, troubleshooting and hardening.',
    examTopics: ['2.1', '2.2', '3.3', '3.4', '4.6', '4.8', '5.3', '5.6'],
  },
  // --- Linux
  { id: 'linux-shell', pathId: 'linux', order: 1, title: 'Meet the Shell', description: 'Find your way around a Linux server: files, directories, permissions, links, and the tools that read and search text.', examTopics: ['EC.1', 'EC.2', 'EC.3', 'EC.4', 'EC.5', 'EC.6', 'EC.7'] },
  { id: 'linux-admin', pathId: 'linux', order: 2, title: 'Administer the Server', description: 'Become root safely, manage users and groups, install and run services, read processes and logs, and check the network from the host.', examTopics: ['UG.1', 'UG.2', 'OD.1', 'OD.2', 'OD.3', 'NW.1', 'NW.2', 'NW.3', 'NW.4'] },
  { id: 'linux-scripting', pathId: 'linux', order: 3, title: 'Shell Scripting', description: 'Automate with Bash: variables, scripts, conditions, loops, functions, exit codes and text-processing pipelines.', examTopics: ['OD.4', 'EC.5', 'EC.6', 'EC.7'] },
  { id: 'linux-web', pathId: 'linux', order: 4, title: 'Web Servers, TLS and Load Balancing', description: 'Configure nginx: virtual hosts, self-signed TLS with HTTP-to-HTTPS redirects, a reverse proxy, and an upstream that balances two application servers and survives a backend failure.', examTopics: ['NW.3', 'NW.5', 'NW.6', 'NW.7', 'OD.1'] },
  {
    id: 'linux-apache',
    pathId: 'linux',
    order: 5,
    title: 'Apache HTTP Server',
    description: 'Run the other web server: the Debian apache2 layout, virtual hosts with a2ensite, modules with a2enmod, TLS, redirects, reverse proxying, mod_proxy_balancer, and the port conflict when two servers want 80.',
    examTopics: ['NW.3', 'NW.5', 'NW.6', 'NW.7', 'NW.8', 'OD.1', 'OD.2'],
  },
  { id: 'linux-python', pathId: 'linux', order: 6, title: 'Python on Linux', description: 'Run real Python in your browser: read files and JSON, generate device configuration, and audit the system.', examTopics: ['OD.5', 'NW.4'] },
  // --- SQL
  { id: 'sql-query', pathId: 'sql', order: 1, title: 'Query the Database', description: 'Read a database at the psql prompt: pick columns, filter rows, sort them, handle the values that are missing, compute new columns, and find your way around a schema you did not write.', examTopics: ['QL.1', 'QL.2', 'QL.3', 'QL.4', 'QL.5', 'QL.6'] },
  { id: 'sql-combine', pathId: 'sql', order: 2, title: 'Combine and Summarise', description: 'Join tables on their keys, keep the rows an inner join drops, summarise with GROUP BY, ask a question inside a question, walk a many-to-many, and stack results with UNION.', examTopics: ['JA.1', 'JA.2', 'JA.3', 'JA.4', 'JA.5', 'QL.6'] },
  { id: 'sql-change', pathId: 'sql', order: 3, title: 'Change the Data', description: 'Add, change and remove rows, meet the foreign key that refuses to orphan data, undo a bad update with a transaction, archive rows before deleting them, and drive an update from a query.', examTopics: ['DM.1', 'DM.2', 'DM.3'] },
  { id: 'sql-design', pathId: 'sql', order: 4, title: 'Design the Schema', description: 'Build tables from scratch: choose types, identify rows with a primary key, refuse bad data with constraints, link tables with foreign keys, alter a table already in use, clean up duplicates, and model a many-to-many.', examTopics: ['SD.1', 'SD.2', 'SD.3', 'SD.4', 'SD.5'] },
  { id: 'sql-perform', pathId: 'sql', order: 5, title: 'Make It Fast and Safe', description: 'Read a query plan, add an index that changes it, learn which queries a multi-column index helps, use a unique one as a constraint, and save a query as a view.', examTopics: ['PS.1', 'PS.2', 'PS.3'] },
  { id: 'sql-exams', pathId: 'sql', order: 6, title: 'SQL Exams', description: 'Three capstones: answer a trading report with joins, aggregates and subqueries; design, constrain, fill and query a schema of your own; and clean up a table nobody ever constrained.', examTopics: ['QL.2', 'JA.1', 'JA.3', 'JA.4', 'JA.5', 'SD.1', 'SD.3', 'SD.4'] },
  // --- Terraform
  { id: 'tf-basics', pathId: 'terraform', order: 1, title: 'Meet Terraform', description: 'Infrastructure as code and the core workflow: init, plan, apply and destroy, validate and fmt, and reading a plan before you trust it.', examTopics: ['1.a', '1.b', '3.a', '3.b', '3.c', '3.d', '3.e', '3.f', '3.g'] },
  { id: 'tf-providers', pathId: 'terraform', order: 2, title: 'Providers and State', description: 'Pin providers and read the lock file, write resources that refer to each other, combine providers and provider aliases across regions, and see what state is for by losing it.', examTopics: ['1.c', '2.a', '2.b', '2.c', '2.d', '4.b', '6.a', '7.b'] },
  { id: 'tf-config', pathId: 'terraform', order: 3, title: 'Variables, Expressions and Dependencies', description: 'Inputs and outputs, data sources, count and for_each, complex types, functions and dynamic blocks, then lifecycle rules, custom conditions, and secrets that never reach state.', examTopics: ['4.a', '4.b', '4.c', '4.d', '4.e', '4.f', '4.g', '4.h'] },
  { id: 'tf-modules', pathId: 'terraform', order: 4, title: 'Modules', description: 'Write a local module with inputs and outputs, respect its scope, consume and upgrade a versioned registry module, and refactor running resources into a module with moved blocks.', examTopics: ['5.a', '5.b', '5.c', '5.d'] },
  { id: 'tf-state', pathId: 'terraform', order: 5, title: 'Manage State and Troubleshoot', description: 'Inspect and rename state, resolve drift, import hand-built infrastructure, move state to a remote backend, break a stale lock, run environments as workspaces, and debug with verbose logging.', examTopics: ['6.a', '6.b', '6.c', '6.d', '7.a', '7.b', '7.c'] },
  { id: 'tf-hcp', pathId: 'terraform', order: 6, title: 'HCP Terraform', description: 'Log in and run plans and applies remotely, organise workspaces by project and tag, and meet the policy checks that govern what a run may build.', examTopics: ['8.a', '8.b', '8.c', '8.d'] },
  { id: 'tf-exams', pathId: 'terraform', order: 7, title: 'Terraform Exams', description: 'Two capstones: build a production network from a written specification, and take over an inherited estate with a leaked secret, drift, hand-built resources and local state.', examTopics: ['2.a', '3.e', '3.g', '4.c', '4.f', '4.h', '6.c', '6.d', '7.a'] },

  // --- Ansible
  { id: 'an-basics', pathId: 'ansible', order: 1, title: 'Meet Ansible', description: 'Build a control node, distribute SSH keys, write an inventory with groups and variables, and do real work with ad hoc commands.', examTopics: ['1.a', '1.b', '1.g', '1.i', '3.a', '3.b', '3.c', '3.d', '4.a', '4.b', '4.d'] },
  { id: 'an-playbooks', pathId: 'ansible', order: 2, title: 'Playbooks, Variables and Facts', description: 'Write plays that are safe to run twice: variables and their precedence, facts, loops and conditions, registered results, handlers and error handling.', examTopics: ['1.c', '1.d', '1.e', '1.f', '6.a', '6.b', '6.c', '6.d', '6.e', '7.a', '7.b'] },
  { id: 'an-files', pathId: 'ansible', order: 3, title: 'Files, Templates and Vault', description: 'Deploy files and directories, edit a line of someone else’s configuration, render Jinja2 templates per host, and keep secrets out of Git with Ansible Vault.', examTopics: ['4.c', '7.f', '8.a', '8.b'] },
  { id: 'an-system', pathId: 'ansible', order: 4, title: 'System Administration', description: 'The everyday work: packages and services, accounts and keys, scheduled tasks, firewall rules through a collection, and shell scripts that call ad hoc commands.', examTopics: ['5.a', '5.b', '7.a', '7.b', '7.c', '7.h', '7.i', '7.j'] },
  { id: 'an-roles', pathId: 'ansible', order: 5, title: 'Roles and Collections', description: 'Refactor a playbook into a role with defaults, templates and handlers, reuse it with different values, and install roles and collections from Galaxy with a requirements file.', examTopics: ['1.h', '2.a', '2.b', '2.c', '2.d'] },
  { id: 'an-network', pathId: 'ansible', order: 6, title: 'Network Devices', description: 'Beyond RHCE: reach Cisco IOS devices with network_cli and the cisco.ios collection, configure them idempotently, and drive them all from one template.', examTopics: ['1.a', '1.b', '2.c', '8.a'] },
  { id: 'an-exams', pathId: 'ansible', order: 7, title: 'Ansible Exams', description: 'Two capstones: automate a three-server environment from a written specification, and take over a playbook that works once and make it something you would schedule.', examTopics: ['1.a', '1.h', '2.a', '6.e', '7.a', '7.b', '7.h', '7.j', '8.a', '8.b'] },

  // --- Git
  { id: 'git-basics', pathId: 'git', order: 1, title: 'Commits and the Object Store', description: 'Make a repository, move changes through the staging area deliberately, read the history, keep junk out of it, and open .git to see what a commit really is.', examTopics: ['RC.1', 'RC.2', 'RC.3', 'RC.4', 'RC.5', 'RC.6'] },
  { id: 'git-branching', pathId: 'git', order: 2, title: 'Branching and Merging', description: 'Branch for every piece of work, merge it back both ways, resolve a conflict by hand, and keep the branch list and the tags tidy.', examTopics: ['BM.1', 'BM.2', 'BM.3', 'BM.4', 'BM.5'] },
  { id: 'git-history', pathId: 'git', order: 3, title: 'Undo and Recover', description: 'The three resets and what each keeps, revert for history other people have, the reflog that finds lost commits, and the stash for work you are not ready to commit.', examTopics: ['HR.1', 'HR.2', 'HR.3', 'HR.4', 'HR.5'] },
  { id: 'git-remotes', pathId: 'git', order: 4, title: 'Working With Other People', description: 'Publish to a server, clone it elsewhere, read remote-tracking branches, recover from a rejected push, and resolve a conflict that arrives through a pull.', examTopics: ['CR.1', 'CR.2', 'CR.3', 'CR.4', 'CR.5'] },
  { id: 'git-rewrite', pathId: 'git', order: 5, title: 'Rewriting History', description: 'Rebase a branch onto a moved main, amend and squash your own commits, cherry-pick one commit from an unfinished branch, and watch what rewriting published work costs.', examTopics: ['RW.1', 'RW.2', 'RW.3', 'RW.4'] },
  { id: 'git-workflow', pathId: 'git', order: 6, title: 'Workflow and Review', description: 'Shape a messy branch into a history somebody can review, then run one change through the whole feature-branch loop on a shared repository.', examTopics: ['WF.1', 'WF.2'] },
  { id: 'git-exams', pathId: 'git', order: 7, title: 'Git Exams', description: 'Two capstones: ship a feature onto a repository a colleague is also pushing to, and rescue a repository with a leaked secret, a deleted branch and a bad public commit.', examTopics: ['RC.4', 'BM.2', 'HR.2', 'HR.3', 'HR.4', 'CR.1', 'CR.3', 'RW.1', 'WF.2'] },
];

const pathOrder = (pathId: string) => paths.findIndex((p) => p.id === pathId);

export const labs: Lab[] = [
  ...meetTheCliLabs,
  ...learnSwitchingLabs,
  ...learnEtherchannelLabs,
  ...learnStpLabs,
  ...secureTheSwitchLabs,
  ...learnRoutingLabs,
  ...learnOspfLabs,
  ...multiAreaOspfLabs,
  ...learnAclLabs,
  ...learnDhcpLabs,
  ...learnNatLabs,
  ...learnIpv6Labs,
  ...learnSecurityLabs,
  ...learnAutomationLabs,
  ...ccnaExamLabs,
  ...linuxShellLabs,
  ...linuxAdminLabs,
  ...linuxScriptingLabs,
  ...linuxWebLabs,
  ...linuxApacheLabs,
  ...linuxPythonLabs,
  ...sqlQueryLabs,
  ...sqlCombineLabs,
  ...sqlChangeLabs,
  ...sqlDesignLabs,
  ...sqlPerformLabs,
  ...sqlExamLabs,
  ...tfBasicsLabs,
  ...tfProvidersLabs,
  ...tfConfigLabs,
  ...tfModulesLabs,
  ...tfStateLabs,
  ...tfHcpLabs,
  ...tfExamLabs,
  ...anBasicsLabs,
  ...anPlaybookLabs,
  ...anFilesLabs,
  ...anSystemLabs,
  ...anRolesLabs,
  ...anNetworkLabs,
  ...anExamLabs,
  ...gitBasicsLabs,
  ...gitBranchingLabs,
  ...gitHistoryLabs,
  ...gitRemotesLabs,
  ...gitRewriteLabs,
  ...gitWorkflowLabs,
  ...gitExamLabs,
].sort((a, b) => {
  const ma = modules.find((m) => m.id === a.moduleId);
  const mb = modules.find((m) => m.id === b.moduleId);
  return pathOrder(ma?.pathId ?? '') - pathOrder(mb?.pathId ?? '') || (ma?.order ?? 0) - (mb?.order ?? 0) || a.order - b.order;
});

export function getModule(id: string): Module | undefined {
  return modules.find((m) => m.id === id);
}

export function modulesForPath(pathId: string): Module[] {
  return modules.filter((m) => m.pathId === pathId);
}

export function labsForModule(moduleId: string): Lab[] {
  return labs.filter((l) => l.moduleId === moduleId);
}

export function labsForPath(pathId: string): Lab[] {
  const ids = new Set(modulesForPath(pathId).map((m) => m.id));
  return labs.filter((l) => ids.has(l.moduleId));
}

export function pathIdOfLab(lab: Lab): string {
  return getModule(lab.moduleId)?.pathId ?? paths[0].id;
}

export function getLab(id: string): Lab | undefined {
  return labs.find((l) => l.id === id);
}

/** The next lab in the same learning path, if any. */
export function nextLab(id: string): Lab | undefined {
  const lab = getLab(id);
  if (!lab) return undefined;
  const list = labsForPath(pathIdOfLab(lab));
  const idx = list.findIndex((l) => l.id === id);
  return idx === -1 ? undefined : list[idx + 1];
}

/** The previous lab in the same learning path, if any. */
export function previousLab(id: string): Lab | undefined {
  const lab = getLab(id);
  if (!lab) return undefined;
  const list = labsForPath(pathIdOfLab(lab));
  const idx = list.findIndex((l) => l.id === id);
  return idx <= 0 ? undefined : list[idx - 1];
}

/**
 * Labs unlock in order within their path: a lab is available once the lab before it
 * has been passed. The first lab of every path is always open, and passing the last
 * lab of a module opens the next module.
 */
export function isLabUnlocked(id: string, completed: Record<string, unknown>): boolean {
  const prev = previousLab(id);
  return prev === undefined || Boolean(completed[prev.id]);
}

/** Total estimated time for every lab, in minutes. */
export function totalMinutes(items: Lab[] = labs): number {
  return items.reduce((n, l) => n + l.estimatedMinutes, 0);
}

/** Fresh starting network for a lab. */
export function labNetwork(lab: Lab): NetworkState {
  const s = lab.createState();
  return isNetworkState(s) ? s : fromSwitch(s);
}
