/**
 * ssh, ssh-keygen and ssh-copy-id between the simulated Linux hosts.
 *
 * Enough of OpenSSH for the workflow that matters: generate a key pair, copy the public
 * key to a managed node (which needs the password the first time), and then log in
 * without one. Ansible's connection check asks exactly the same questions, so a host
 * that answers here is a host Ansible can reach.
 */
import { ping } from '../network';
import type { NetworkState } from '../network';
import { getNode, makeDir, readFile, writeFile, type LinuxState } from './fs';
import { runLine } from './shell';
import { findHost } from './hosts';

export interface SshPending {
  kind: 'ssh';
  argv: string[];
  command: string;
  cwd: string;
  answers: string[];
  printed: number;
  prompt: string;
  masked?: boolean;
}

export interface SshResult {
  out: string[];
  err: string[];
  code: number;
  pending?: SshPending;
}

class Ask extends Error {
  constructor(
    public prompt: string,
    public masked: boolean,
  ) {
    super('ask');
  }
}

function keyFingerprint(text: string): string {
  let h = 0x811c9dc5;
  let out = '';
  while (out.length < 43) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ out.length, 0x01000193) >>> 0;
    out += h.toString(36);
  }
  return `SHA256:${out.slice(0, 43)}`;
}

function homeOfUser(lx: LinuxState, user: string): string {
  return lx.users.find((u) => u.name === user)?.home ?? (user === 'root' ? '/root' : `/home/${user}`);
}

export { findHost } from './hosts';

export function runSshCommand(lx: LinuxState, network: NetworkState, node: string, command: string, args: string[], answers: string[]): SshResult {
  const out: string[] = [];
  const err: string[] = [];
  let askIndex = 0;
  const ask = (prompt: string, masked = true): string => {
    const i = askIndex++;
    if (i < answers.length) return answers[i];
    throw new Ask(prompt, masked);
  };
  try {
    const code = dispatch();
    return { out, err, code };
  } catch (e) {
    if (e instanceof Ask) return { out, err, code: 0, pending: { kind: 'ssh', argv: args, command, cwd: lx.cwd, answers: [...answers], printed: out.length, prompt: e.prompt, masked: e.masked } };
    throw e;
  }

  function dispatch(): number {
    if (command === 'ssh-keygen') return keygen();
    if (command === 'ssh-copy-id') return copyId();
    return ssh();
  }

  function keygen(): number {
    let type = 'rsa';
    let file = '';
    let passphrase: string | null = null;
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') type = args[++i] ?? 'rsa';
      else if (args[i] === '-f') file = args[++i] ?? '';
      else if (args[i] === '-N') passphrase = args[++i] ?? '';
      else if (args[i] === '-q') quiet = true;
      else if (args[i] === '-C') i++;
      else if (args[i] === '-b') i++;
    }
    const home = homeOfUser(lx, lx.user);
    const path = file ? (file.startsWith('/') ? file : `${lx.cwd}/${file}`.replace(/\/+/g, '/')) : `${home}/.ssh/id_${type}`;
    if (!quiet) out.push(`Generating public/private ${type} key pair.`);
    if (!file) {
      const answer = ask(`Enter file in which to save the key (${path}): `, false);
      if (answer.trim()) return keygenAt(answer.trim().startsWith('/') ? answer.trim() : `${lx.cwd}/${answer.trim()}`, type, quiet);
    }
    if (passphrase === null) {
      ask('Enter passphrase (empty for no passphrase): ');
      ask('Enter same passphrase again: ');
    }
    return keygenAt(path, type, quiet);
  }

  function keygenAt(path: string, type: string, quiet: boolean): number {
    if (getNode(lx, path)) {
      const answer = ask(`${path} already exists.\nOverwrite (y/n)? `, false);
      if (!/^y/i.test(answer)) {
        out.push('');
        return 1;
      }
    }
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!getNode(lx, dir)) {
      const e = makeDir(lx, dir, true);
      if (e) {
        err.push(`Saving key "${path}" failed: ${e.error}`);
        return 1;
      }
      const node = getNode(lx, dir)!;
      node.mode = 0o700;
    }
    const comment = `${lx.user}@${lx.hostname}`;
    const body = keyFingerprint(`${path}:${comment}`).replace('SHA256:', '');
    const priv = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const pub = `ssh-${type} AAAAB3NzaC1${body} ${comment}\n`;
    writeFile(lx, path, priv, false, 'ssh-keygen');
    getNode(lx, path)!.mode = 0o600;
    writeFile(lx, `${path}.pub`, pub, false, 'ssh-keygen');
    getNode(lx, `${path}.pub`)!.mode = 0o644;
    if (!quiet) {
      out.push(`Your identification has been saved in ${path}`, `Your public key has been saved in ${path}.pub`, 'The key fingerprint is:', `${keyFingerprint(pub)} ${comment}`, 'The key’s randomart image is:', '+---[RSA 3072]----+', '|      .oo+.      |', '|     . o+..      |', '|      o.+o       |', '+----[SHA256]-----+');
    }
    return 0;
  }

  function copyId(): number {
    let identity = '';
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-i') identity = args[++i] ?? '';
      else if (args[i] === '-f' || args[i] === '-n') continue;
      else if (!args[i].startsWith('-')) targets.push(args[i]);
    }
    const spec = targets[0];
    if (!spec) {
      err.push('usage: ssh-copy-id [-i [identity_file]] [user@]hostname');
      return 1;
    }
    const home = homeOfUser(lx, lx.user);
    const keyPath = identity ? (identity.endsWith('.pub') ? identity : `${identity}.pub`) : `${home}/.ssh/id_rsa.pub`;
    const key = readFile(lx, keyPath.startsWith('/') ? keyPath : `${lx.cwd}/${keyPath}`);
    if ('error' in key) {
      err.push(`/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${keyPath}': No such file or directory`);
      return 1;
    }
    const [userPart, hostPart] = spec.includes('@') ? spec.split('@') : [lx.user, spec];
    const found = findHost(network, hostPart);
    if (!found) {
      err.push(`ssh: Could not resolve hostname ${hostPart}: Name or service not known`);
      return 255;
    }
    const remote = found.lx;
    const account = remote.users.find((u) => u.name === userPart);
    if (!remote.services.ssh?.active) {
      err.push(`ssh: connect to host ${hostPart} port 22: Connection refused`);
      return 255;
    }
    if (!account) {
      err.push(`${userPart}@${hostPart}: Permission denied (publickey,password).`);
      return 255;
    }
    const authorizedPath = `${account.home}/.ssh/authorized_keys`;
    const already = readFile({ ...remote, user: 'root' }, authorizedPath);
    const have = !('error' in already) && already.content.includes(key.content.trim());
    out.push(`/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${keyPath}"`);
    if (have) {
      out.push('/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.', '(if you think this is a mistake, you may want to use -f option)', '');
      return 0;
    }
    out.push('/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed', '/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys');
    const password = ask(`${userPart}@${hostPart}'s password: `);
    if (account.password !== password) {
      err.push('Permission denied, please try again.');
      return 255;
    }
    const saved = remote.user;
    remote.user = userPart;
    try {
      if (!getNode(remote, `${account.home}/.ssh`)) {
        makeDir(remote, `${account.home}/.ssh`, true);
        const dir = getNode(remote, `${account.home}/.ssh`)!;
        dir.mode = 0o700;
        dir.owner = userPart;
        dir.group = userPart;
      }
      const existing = readFile(remote, authorizedPath);
      const content = ('error' in existing ? '' : existing.content) + key.content;
      writeFile(remote, authorizedPath, content, false, 'ssh-copy-id');
      const node = getNode(remote, authorizedPath)!;
      node.mode = 0o600;
      node.owner = userPart;
      node.group = userPart;
    } finally {
      remote.user = saved;
    }
    out.push('', `Number of key(s) added: 1`, '', `Now try logging into the machine, with:   "ssh '${spec}'"`, 'and check to make sure that only the key(s) you wanted were added.', '');
    return 0;
  }

  function ssh(): number {
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-o' || args[i] === '-i' || args[i] === '-l' || args[i] === '-p') i++;
      else if (!args[i].startsWith('-')) positional.push(args[i]);
    }
    const spec = positional.shift();
    if (!spec) {
      err.push('usage: ssh [-i identity_file] [-l login_name] destination [command]');
      return 255;
    }
    const [userPart, hostPart] = spec.includes('@') ? spec.split('@') : [lx.user, spec];
    const found = findHost(network, hostPart);
    if (!found) {
      err.push(`ssh: Could not resolve hostname ${hostPart}: Name or service not known`);
      return 255;
    }
    const address = Object.values(network.hosts).find((h) => h.id === found.node)?.ip;
    if (address && !ping(network, node, address).success) {
      err.push(`ssh: connect to host ${hostPart} port 22: No route to host`);
      return 255;
    }
    const remote = found.lx;
    if (!remote.services.ssh?.active) {
      err.push(`ssh: connect to host ${hostPart} port 22: Connection refused`);
      return 255;
    }
    const account = remote.users.find((u) => u.name === userPart);
    const home = homeOfUser(lx, lx.user);
    const pub = readFile(lx, `${home}/.ssh/id_rsa.pub`);
    const authorized = account ? readFile({ ...remote, user: 'root' }, `${account.home}/.ssh/authorized_keys`) : { error: 'x' };
    const keyWorks = account && !('error' in pub) && !('error' in authorized) && authorized.content.includes(pub.content.trim());
    if (!keyWorks) {
      const password = ask(`${userPart}@${hostPart}'s password: `);
      if (!account || account.password !== password) {
        err.push('Permission denied, please try again.');
        return 255;
      }
    }
    const command = positional.join(' ');
    const saved = { user: remote.user, cwd: remote.cwd };
    remote.user = userPart;
    remote.cwd = account!.home;
    try {
      if (!command) {
        out.push(`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)`, '', `[NetLab] An interactive session is not simulated; run a command, as in: ssh ${spec} 'hostname'`);
        return 0;
      }
      const r = runLine({ state: remote, network, hostId: found.node }, command);
      if ('incomplete' in r) {
        err.push('bash: syntax error: unexpected end of file');
        return 2;
      }
      out.push(...r.out);
      err.push(...r.err);
      return r.code;
    } finally {
      remote.user = saved.user;
      remote.cwd = saved.cwd;
    }
  }
}

export function resumeSsh(lx: LinuxState, network: NetworkState, node: string, pending: SshPending, answer: string): SshResult {
  const r = runSshCommand(lx, network, node, pending.command, pending.argv, [...pending.answers, answer]);
  return { ...r, out: r.out.slice(pending.printed) };
}
