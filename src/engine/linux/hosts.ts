/**
 * Finding a host in the network by any name it answers to. Kept apart from ssh.ts
 * so that git's remote code can use it without importing the shell, which imports
 * every command, git included, and would close an import cycle.
 */
import type { NetworkState } from '../network';
import type { LinuxState } from './fs';

/** Find the host in the network that answers to this name or address. */
export function findHost(network: NetworkState, target: string): { node: string; lx: LinuxState } | null {
  for (const host of Object.values(network.hosts)) {
    if (!host.linux) continue;
    if (host.id === target || host.name === target || host.ip === target || host.linux.hostname === target) return { node: host.id, lx: host.linux };
  }
  return null;
}
