import { fromSwitch, isNetworkState, type NetworkState } from '../engine';
import type { Lab, Module } from './types';
import { meetTheCliLabs } from './labs/meet-the-cli';
import { learnSwitchingLabs } from './labs/learn-switching';
import { secureTheSwitchLabs } from './labs/secure-the-switch';
import { learnRoutingLabs } from './labs/learn-routing';
import { learnOspfLabs } from './labs/learn-ospf';
import { ccnaExamLabs } from './labs/ccna-exams';

export type { Lab, Module, Difficulty } from './types';

export const modules: Module[] = [
  { id: 'meet-the-cli', order: 1, title: 'Meet the CLI', description: 'Move through device prompts, read command output, and save your work.' },
  { id: 'learn-switching', order: 2, title: 'Learn Switching', description: 'Build VLANs, access ports and trunks, then troubleshoot them.' },
  { id: 'secure-the-switch', order: 3, title: 'Secure the Switch', description: 'Encrypt passwords, enable SSH, and lock down unused ports.' },
  { id: 'learn-routing', order: 4, title: 'Learn Routing', description: 'Address router interfaces, build routing tables with static routes, and connect networks.' },
  { id: 'learn-ospf', order: 5, title: 'Learn OSPF', description: 'Let routers discover each other and exchange routes with single-area OSPF.' },
  { id: 'ccna-exams', order: 6, title: 'CCNA Exams', description: 'Multi-device capstone exams that combine switching, routing, OSPF, troubleshooting and hardening.' },
];

export const labs: Lab[] = [...meetTheCliLabs, ...learnSwitchingLabs, ...secureTheSwitchLabs, ...learnRoutingLabs, ...learnOspfLabs, ...ccnaExamLabs].sort((a, b) => {
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

/** Fresh starting network for a lab. */
export function labNetwork(lab: Lab): NetworkState {
  const s = lab.createState();
  return isNetworkState(s) ? s : fromSwitch(s);
}
