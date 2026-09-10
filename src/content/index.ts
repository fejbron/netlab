import { fromSwitch, isNetworkState, type NetworkState } from '../engine';
import type { Lab, Module } from './types';
import { meetTheCliLabs } from './labs/meet-the-cli';
import { learnSwitchingLabs } from './labs/learn-switching';
import { learnEtherchannelLabs } from './labs/learn-etherchannel';
import { secureTheSwitchLabs } from './labs/secure-the-switch';
import { learnRoutingLabs } from './labs/learn-routing';
import { learnOspfLabs } from './labs/learn-ospf';
import { learnAclLabs } from './labs/learn-acls';
import { learnDhcpLabs } from './labs/learn-dhcp';
import { learnNatLabs } from './labs/learn-nat';
import { learnIpv6Labs } from './labs/learn-ipv6';
import { ccnaExamLabs } from './labs/ccna-exams';

export type { Lab, Module, Difficulty } from './types';

export const modules: Module[] = [
  { id: 'meet-the-cli', order: 1, title: 'Meet the CLI', description: 'Move through device prompts, read command output, and save your work.' },
  { id: 'learn-switching', order: 2, title: 'Learn Switching', description: 'Build VLANs, access ports and trunks, then troubleshoot them.' },
  { id: 'learn-etherchannel', order: 3, title: 'Learn EtherChannel', description: 'Bundle parallel links into one Port-channel with LACP and PAgP.' },
  { id: 'secure-the-switch', order: 4, title: 'Secure the Switch', description: 'Encrypt passwords, enable SSH, lock down unused ports, and secure user ports.' },
  { id: 'learn-routing', order: 5, title: 'Learn Routing', description: 'Address router interfaces, build routing tables with static routes, and connect networks.' },
  { id: 'learn-ospf', order: 6, title: 'Learn OSPF', description: 'Let routers discover each other and exchange routes with single-area OSPF.' },
  { id: 'learn-acls', order: 7, title: 'Learn ACLs', description: 'Filter traffic with standard and extended access lists and protect management access.' },
  { id: 'learn-dhcp', order: 8, title: 'Learn DHCP', description: 'Hand out addresses from a router, relay across the network, and troubleshoot leases.' },
  { id: 'learn-nat', order: 9, title: 'Learn NAT', description: 'Publish a server with static NAT and share one public address with PAT.' },
  { id: 'learn-ipv6', order: 10, title: 'Learn IPv6', description: 'Address interfaces with global and link-local IPv6, then route between IPv6 networks.' },
  { id: 'ccna-exams', order: 11, title: 'CCNA Exams', description: 'Multi-device capstone exams that combine switching, routing, OSPF, ACLs, DHCP, NAT, IPv6, troubleshooting and hardening.' },
];

export const labs: Lab[] = [...meetTheCliLabs, ...learnSwitchingLabs, ...learnEtherchannelLabs, ...secureTheSwitchLabs, ...learnRoutingLabs, ...learnOspfLabs, ...learnAclLabs, ...learnDhcpLabs, ...learnNatLabs, ...learnIpv6Labs, ...ccnaExamLabs].sort((a, b) => {
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
export function isLabUnlocked(id: string, completed: Record<string, unknown>, unlockAll = false): boolean {
  if (unlockAll) return true;
  const prev = previousLab(id);
  return prev === undefined || Boolean(completed[prev.id]);
}

/** Fresh starting network for a lab. */
export function labNetwork(lab: Lab): NetworkState {
  const s = lab.createState();
  return isNetworkState(s) ? s : fromSwitch(s);
}
