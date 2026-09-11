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
import { paths } from './paths';

export type { Lab, Module, Difficulty } from './types';
export { BLUEPRINT, EXAM_DOMAINS, EXAM_TOPICS, PATH_OVERVIEW, domainCoverage, topicDomain, byTopicCode } from './blueprint';
export type { ExamDomain, DomainCoverage } from './blueprint';
export { paths, getPath, pathUrl, ccnaPath, linuxPath, LFCS_DOMAINS, LFCS_TOPICS } from './paths';
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
  { id: 'linux-python', pathId: 'linux', order: 4, title: 'Python on Linux', description: 'Run real Python in your browser: read files and JSON, generate device configuration, and audit the system.', examTopics: ['OD.5', 'NW.4'] },
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
  ...linuxPythonLabs,
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
