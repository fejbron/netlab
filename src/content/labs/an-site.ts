import { buildNetwork, createRouter, createSwitch, executeHost, type LinuxSpec, type NetworkState } from '../../engine';

/**
 * Every Ansible lab runs on ops1, a control node with ansible installed, and reaches
 * three managed nodes over SSH: web1, web2 and db1. R1 and SW1 are the same Cisco
 * devices the CCNA path uses, ready for SSH, for the network automation module.
 *
 * Preparation is real: when a lab starts with keys already distributed, the site runs
 * ssh-keygen and ssh-copy-id (answering the password prompt) rather than planting an
 * authorized_keys file, so what the learner inherits is what those commands produce.
 */
export const CONTROL = 'ops1';
export const HOME = '/home/student';
export const WORK = `${HOME}/ansible`;
/** The password every lab account uses, the same one the Linux path uses. */
export const PASSWORD = 'student';
/** The managed nodes, in inventory order. */
export const NODES = ['web1', 'web2', 'db1'] as const;
export const ADDRESSES: Record<string, string> = { ops1: '192.168.1.20', web1: '192.168.1.51', web2: '192.168.1.52', db1: '192.168.1.53' };

/** The inventory most labs start from: two web servers, one database server. */
export const INVENTORY = `[web]
web1
web2

[db]
db1

[production:children]
web
db
`;

export const CONFIG = `[defaults]
inventory = inventory.ini
host_key_checking = False
`;

export interface AnSiteOptions {
  /** Files by path; relative paths are under ~/ansible. */
  files?: Record<string, string>;
  /** The inventory to write as ~/ansible/inventory.ini, or false for none. */
  inventory?: string | false;
  /** The ansible.cfg to write in ~/ansible, or false for none. */
  config?: string | false;
  /** Extra specification for a managed node, merged over the default. */
  nodes?: Record<string, LinuxSpec>;
  /** Leave ansible uninstalled, for the lab that installs it. */
  noAnsible?: boolean;
  /** Leave the control node without an SSH key, for the labs that build one. */
  noKeys?: boolean;
  /** Managed nodes that should not trust the control node's key yet. */
  withoutKey?: string[];
  /** Commands run on ops1 before the lab starts (a colleague's earlier work). */
  prepare?: string[];
  /** Files written after preparation, replacing what was there. */
  edits?: Record<string, string>;
  /** Anything else that happened outside Ansible. */
  after?: (net: NetworkState) => void;
}

function managedNode(id: string, extra: LinuxSpec = {}): LinuxSpec {
  return {
    hostname: id,
    user: 'student',
    sudo: true,
    ...extra,
    services: { ssh: { active: true, enabled: true }, cron: { active: true, enabled: true }, ...(extra.services ?? {}) },
    users: extra.users ?? [],
  };
}

export function anSite(opts: AnSiteOptions = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: {
      'g0/0': { description: 'Site 1 LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false },
      'g0/1': { description: 'Link to the branch', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false },
    },
    overrides: {
      ipDomainName: 'netlab.local',
      rsaKeyBits: 2048,
      users: [{ username: 'netops', password: 'Aut0mate!', secret: true, privilege: 15 }],
      lines: { con: { login: false }, vty: { login: 'local', transportInput: 'ssh' } },
    },
  });
  const sw1 = createSwitch({
    hostname: 'SW1',
    ports: 8,
    interfaces: {
      Vlan1: { ipAddress: '192.168.1.2', subnetMask: '255.255.255.0', shutdown: false },
      'g0/1': { description: 'ops1' },
      'g0/2': { description: 'web1' },
      'g0/3': { description: 'web2' },
      'g0/4': { description: 'db1' },
      'g0/8': { description: 'Uplink to R1' },
    },
    overrides: {
      ipDomainName: 'netlab.local',
      rsaKeyBits: 2048,
      users: [{ username: 'netops', password: 'Aut0mate!', secret: true, privilege: 15 }],
      lines: { con: { login: false }, vty: { login: 'local', transportInput: 'ssh' } },
      ipDefaultGateway: '192.168.1.1',
    },
  });

  const files: Record<string, string> = {
    [`${HOME}/.bashrc`]: `# ~/.bashrc: executed by bash(1) for non-login shells.\nexport PATH="$HOME/bin:$PATH"\nalias ll='ls -alF'\n`,
  };
  if (opts.inventory !== false) files[`${WORK}/inventory.ini`] = opts.inventory ?? INVENTORY;
  if (opts.config !== false) files[`${WORK}/ansible.cfg`] = opts.config ?? CONFIG;
  for (const [p, content] of Object.entries(opts.files ?? {})) files[p.startsWith('/') ? p : `${WORK}/${p}`] = content;

  let net = buildNetwork({
    primary: CONTROL,
    devices: [r1, sw1],
    hosts: [
      {
        id: CONTROL,
        name: 'ops1',
        ip: ADDRESSES.ops1,
        mask: '255.255.255.0',
        gateway: '192.168.1.1',
        kind: 'server',
        linux: { hostname: 'ops1', user: 'student', sudo: true, packages: opts.noAnsible ? [] : ['ansible'], services: { ssh: { active: true, enabled: true } }, files },
      },
      ...NODES.map((id) => ({ id, name: id, ip: ADDRESSES[id], mask: '255.255.255.0', gateway: '192.168.1.1', kind: 'server' as const, linux: managedNode(id, opts.nodes?.[id]) })),
    ],
    links: [[CONTROL, 'SW1:g0/1'], ['web1', 'SW1:g0/2'], ['web2', 'SW1:g0/3'], ['db1', 'SW1:g0/4'], ['SW1:g0/8', 'R1:g0/0']],
  });

  const control = net.hosts[CONTROL].linux!;
  control.cwd = WORK;
  // A lab may start with no files at all in ~/ansible, but the directory is always there.
  control.fs[WORK] ??= { type: 'dir', content: '', owner: 'student', group: 'student', mode: 0o755, mtime: 0 };

  const setup: string[] = [];
  if (!opts.noKeys) {
    setup.push(`ssh-keygen -t rsa -N '' -f ${HOME}/.ssh/id_rsa -q`);
    for (const id of NODES) {
      if (opts.withoutKey?.includes(id)) continue;
      setup.push(`ssh-copy-id student@${id}`, PASSWORD);
    }
  }
  for (const cmd of [...setup, ...(opts.prepare ?? [])]) {
    const r = executeHost(net, CONTROL, cmd);
    // A lab whose preparation fails is an authoring mistake: make it loud.
    if (r.output.some((l) => /^fatal:|Permission denied|command not found/.test(l))) throw new Error(`lab preparation failed on "${cmd}":\n${r.output.join('\n')}`);
    net = r.network;
  }

  const host = net.hosts[CONTROL];
  const lx = host.linux!;
  for (const [p, content] of Object.entries(opts.edits ?? {})) {
    const path = p.startsWith('/') ? p : `${WORK}/${p}`;
    const node = lx.fs[path];
    if (node) node.content = content;
    else lx.fs[path] = { type: 'file', content, owner: 'student', group: 'student', mode: 0o644, mtime: 0 };
  }
  opts.after?.(net);
  // The learner starts with a clean history: preparation is not their work.
  host.commandHistory = [];
  host.acceptedHistory = [];
  lx.history = [];
  lx.outputs = [];
  lx.ansibleRuns = [];
  lx.pending = undefined;
  lx.cwd = WORK;
  return net;
}
