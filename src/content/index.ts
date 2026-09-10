import type { Lab, Module } from './types';
import { meetTheCliLabs } from './labs/meet-the-cli';
import { learnSwitchingLabs } from './labs/learn-switching';
import { secureTheSwitchLabs } from './labs/secure-the-switch';

export type { Lab, Module, Difficulty } from './types';

export const modules: Module[] = [
  { id: 'meet-the-cli', order: 1, title: 'Meet the CLI', description: 'Move through device prompts, read command output, and save your work.' },
  { id: 'learn-switching', order: 2, title: 'Learn Switching', description: 'Build VLANs, access ports and trunks, then troubleshoot them.' },
  { id: 'secure-the-switch', order: 3, title: 'Secure the Switch', description: 'Encrypt passwords, enable SSH, and lock down unused ports.' },
];

export const labs: Lab[] = [...meetTheCliLabs, ...learnSwitchingLabs, ...secureTheSwitchLabs].sort((a, b) => {
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
