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
import { ccnaExamLabs } from './labs/ccna-exams';

export type { Lab, Module, Difficulty } from './types';
export { BLUEPRINT, EXAM_DOMAINS, EXAM_TOPICS, PATH_OVERVIEW, domainCoverage, topicDomain, byTopicCode } from './blueprint';
export type { ExamDomain, DomainCoverage } from './blueprint';

export const modules: Module[] = [
  { id: 'meet-the-cli', order: 1, title: 'Meet the CLI', description: 'Move through device prompts, read command output, and save your work.', examTopics: ['1.1', '4.8', '5.3'] },
  { id: 'learn-switching', order: 2, title: 'Learn Switching', description: 'Build VLANs, access ports and trunks, then troubleshoot them.', examTopics: ['1.13', '2.1', '2.2'] },
  { id: 'learn-etherchannel', order: 3, title: 'Learn EtherChannel', description: 'Bundle parallel links into one Port-channel with LACP and PAgP.', examTopics: ['2.4'] },
  { id: 'learn-stp', order: 4, title: 'Learn Spanning Tree', description: 'Read the tree, place the root bridge, protect edge ports, and recover a BPDU-guarded uplink.', examTopics: ['2.5'] },
  { id: 'secure-the-switch', order: 5, title: 'Secure the Switch', description: 'Encrypt passwords, enable SSH, lock down unused ports, and secure user ports.', examTopics: ['4.8', '5.3', '5.7'] },
  { id: 'learn-routing', order: 6, title: 'Learn Routing', description: 'Address router interfaces, build routing tables with static routes, and connect networks.', examTopics: ['1.6', '1.10', '3.1', '3.2', '3.3'] },
  { id: 'learn-ospf', order: 7, title: 'Learn OSPF', description: 'Let routers discover each other and exchange routes with single-area and multi-area OSPF.', examTopics: ['3.1', '3.4'] },
  { id: 'learn-acls', order: 8, title: 'Learn ACLs', description: 'Filter traffic with standard and extended access lists and protect management access.', examTopics: ['5.6'] },
  { id: 'learn-dhcp', order: 9, title: 'Learn DHCP', description: 'Hand out addresses from a router, relay across the network, and troubleshoot leases.', examTopics: ['1.10', '4.3', '4.6'] },
  { id: 'learn-nat', order: 10, title: 'Learn NAT', description: 'Publish a server with static NAT and share one public address with PAT.', examTopics: ['4.1'] },
  { id: 'learn-ipv6', order: 11, title: 'Learn IPv6', description: 'Address interfaces with global and link-local IPv6, then route between IPv6 networks.', examTopics: ['1.8', '1.9', '3.3'] },
  {
    id: 'ccna-exams',
    order: 12,
    title: 'CCNA Exams',
    description: 'Multi-device capstone exams that combine switching, routing, OSPF, ACLs, DHCP, NAT, IPv6, troubleshooting and hardening.',
    examTopics: ['2.1', '2.2', '3.3', '3.4', '4.6', '4.8', '5.3', '5.6'],
  },
];

/** Total estimated time for every lab, in minutes. */
export function totalMinutes(items: Lab[] = labs): number {
  return items.reduce((n, l) => n + l.estimatedMinutes, 0);
}

export const labs: Lab[] = [...meetTheCliLabs, ...learnSwitchingLabs, ...learnEtherchannelLabs, ...learnStpLabs, ...secureTheSwitchLabs, ...learnRoutingLabs, ...learnOspfLabs, ...multiAreaOspfLabs, ...learnAclLabs, ...learnDhcpLabs, ...learnNatLabs, ...learnIpv6Labs, ...ccnaExamLabs].sort((a, b) => {
  const ma = modules.find((m) => m.id === a.moduleId)?.order ?? 0;
  const mb = modules.find((m) => m.id === b.moduleId)?.order ?? 0;
  return ma - mb || a.order - b.order;
});

export function labsForModule(moduleId: string): Lab[] {
  return labs.filter((l) => l.moduleId === moduleId);
}

export function getLab(id: string): Lab | undefined {
  return labs.find((l) => l.id === id);
}

export function nextLab(id: string): Lab | undefined {
  const idx = labs.findIndex((l) => l.id === id);
  return idx === -1 ? undefined : labs[idx + 1];
}

export function previousLab(id: string): Lab | undefined {
  const idx = labs.findIndex((l) => l.id === id);
  return idx <= 0 ? undefined : labs[idx - 1];
}

/**
 * Labs unlock in order: a lab is available once the lab before it has been passed.
 * The first lab is always open, and passing the last lab of a module opens the next module.
 */
export function isLabUnlocked(id: string, completed: Record<string, unknown>): boolean {
  const prev = previousLab(id);
  return prev === undefined || Boolean(completed[prev.id]);
}

/** Fresh starting network for a lab. */
export function labNetwork(lab: Lab): NetworkState {
  const s = lab.createState();
  return isNetworkState(s) ? s : fromSwitch(s);
}
