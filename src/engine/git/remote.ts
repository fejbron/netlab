/**
 * Remotes: a second repository, usually a bare one on a server, reached over SSH.
 *
 * Nothing here is faked. The remote is a real repository in another host's
 * filesystem, a transfer copies the objects the other side is missing, and a push
 * that would lose commits is rejected for the same reason git rejects it: the ref
 * it would overwrite is not an ancestor of what is being pushed.
 */
import { ping, type NetworkState } from '../network';
import { getNode, normalizePath, type LinuxState } from '../linux/fs';
import { findHost } from '../linux/hosts';
import type { Oid } from './objects';
import { allObjects, configValue, deleteRef, findRepo, readConfig, head, initRepo, listRefs, logRef, readCommit, readObject, readRef, readTree, slurp, writeObject, writeRef, type Repo } from './repo';
import { ancestors, isAncestor } from './revs';

export interface RemoteRef {
  name: string;
  oid: Oid;
}

export interface Located {
  repo: Repo;
  /** The host the repository lives on, for messages. */
  host: string;
  path: string;
}

export interface TransportError {
  error: string[];
  code: number;
}

/** A URL like `student@srv1:/srv/git/app.git`, or a plain path on this machine. */
export function parseUrl(url: string): { user?: string; host?: string; path: string } {
  const ssh = /^(?:ssh:\/\/)?(?:([^@/]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/.exec(url);
  if (ssh && !url.startsWith('/') && !url.startsWith('.')) return { user: ssh[1], host: ssh[2], path: ssh[3] };
  return { path: url };
}

export interface RemoteContext {
  lx: LinuxState;
  network: NetworkState;
  node: string;
  cwd: string;
}

/** Open the repository a URL names, on this host or across the network. */
export function openRemote(ctx: RemoteContext, url: string): Located | TransportError {
  const { user, host, path } = parseUrl(url);
  if (!host) {
    const abs = normalizePath(ctx.cwd, path, `/home/${ctx.lx.user}`);
    const repo = getNode(ctx.lx, abs) ? findRepo(ctx.lx, abs) : null;
    // findRepo walks upwards; a clone of a path that is not itself a repository must fail.
    if (!repo || (repo.bare ? repo.gitDir : repo.root) !== abs) return { error: [`fatal: repository '${url}' does not exist`], code: 128 };
    return { repo, host: ctx.lx.hostname, path: abs };
  }
  const found = findHost(ctx.network, host);
  if (!found) return { error: [`ssh: Could not resolve hostname ${host}: Name or service not known`, 'fatal: Could not read from remote repository.', '', 'Please make sure you have the correct access rights', 'and the repository exists.'], code: 128 };
  const address = Object.values(ctx.network.hosts).find((h) => h.id === found.node)?.ip;
  if (address && !ping(ctx.network, ctx.node, address).success) {
    return { error: [`ssh: connect to host ${host} port 22: No route to host`, 'fatal: Could not read from remote repository.'], code: 128 };
  }
  const remote = found.lx;
  if (!remote.services.ssh?.active) return { error: [`ssh: connect to host ${host} port 22: Connection refused`, 'fatal: Could not read from remote repository.'], code: 128 };

  const account = user ?? ctx.lx.user;
  const remoteUser = remote.users.find((u) => u.name === account);
  if (!remoteUser) return { error: [`${account}@${host}: Permission denied (publickey).`, 'fatal: Could not read from remote repository.'], code: 128 };
  // Git over SSH is not interactive, so the key has to be in place already.
  const pub = slurp(ctx.lx, `/home/${ctx.lx.user}/.ssh/id_rsa.pub`);
  const authorized = slurp({ ...remote, user: 'root' }, `${remoteUser.home}/.ssh/authorized_keys`);
  if (!pub || !authorized || !authorized.includes(pub.trim())) {
    return {
      error: [`${account}@${host}: Permission denied (publickey).`, 'fatal: Could not read from remote repository.', '', 'Please make sure you have the correct access rights', 'and the repository exists.'],
      code: 128,
    };
  }
  const abs = path.startsWith('/') ? path : `${remoteUser.home}/${path}`;
  if (!getNode(remote, abs)) return { error: [`fatal: '${abs}' does not appear to be a git repository`, 'fatal: Could not read from remote repository.'], code: 128 };
  const repo = findRepo(remote, abs);
  if (!repo || (repo.bare ? repo.gitDir : repo.root) !== abs) return { error: [`fatal: '${abs}' does not appear to be a git repository`, 'fatal: Could not read from remote repository.'], code: 128 };
  return { repo, host, path: abs };
}

export function isTransportError(x: Located | TransportError): x is TransportError {
  return 'error' in x;
}

// ---------------------------------------------------------------------------
// moving objects

/** Every object a set of commits needs: the commits, their trees and their blobs. */
export function objectsFor(repo: Repo, tips: Oid[], have: Set<Oid>): Oid[] {
  const out = new Set<Oid>();
  const addTree = (oid: Oid) => {
    if (out.has(oid) || have.has(oid)) return;
    out.add(oid);
    for (const entry of readTree(repo, oid) ?? []) {
      if (entry.mode === '040000') addTree(entry.oid);
      else if (!have.has(entry.oid)) out.add(entry.oid);
    }
  };
  for (const tip of tips) {
    for (const oid of ancestors(repo, tip)) {
      if (have.has(oid)) continue;
      out.add(oid);
      const commit = readCommit(repo, oid);
      if (commit) addTree(commit.tree);
    }
    // A tag object points at a commit but is not reachable by walking parents.
    const tagged = readObject(repo, tip);
    if (tagged?.type === 'tag' && !have.has(tip)) out.add(tip);
  }
  return [...out];
}

/** Copy objects between two repositories, skipping what the target already has. */
export function transfer(from: Repo, to: Repo, tips: Oid[]): number {
  const have = new Set(allObjects(to));
  const needed = objectsFor(from, tips, have);
  for (const oid of needed) {
    const object = readObject(from, oid);
    if (object) writeObject(to, object);
  }
  return needed.length;
}

// ---------------------------------------------------------------------------
// fetch

export interface RefUpdate {
  /** The remote-tracking ref that changed, e.g. refs/remotes/origin/main. */
  ref: string;
  /** The branch on the remote, e.g. main. */
  branch: string;
  from: Oid | null;
  to: Oid;
  kind: 'new' | 'fast-forward' | 'forced' | 'up-to-date' | 'pruned';
}

export function fetchFrom(local: Repo, remote: Repo, remoteName: string, opts: { branch?: string; tags?: boolean; prune?: boolean } = {}): { updates: RefUpdate[]; objects: number } {
  const branches = listRefs(remote, 'refs/heads').filter((r) => !opts.branch || r.name === `refs/heads/${opts.branch}`);
  const tags = opts.tags === false ? [] : listRefs(remote, 'refs/tags');
  const objects = transfer(remote, local, [...branches.map((b) => b.oid), ...tags.map((t) => t.oid)]);

  const updates: RefUpdate[] = [];
  for (const { name, oid } of branches) {
    const branch = name.slice('refs/heads/'.length);
    const trackingRef = `refs/remotes/${remoteName}/${branch}`;
    const before = readRef(local, trackingRef);
    const kind = before === null ? 'new' : before === oid ? 'up-to-date' : isAncestor(local, before, oid) ? 'fast-forward' : 'forced';
    if (kind !== 'up-to-date') {
      writeRef(local, trackingRef, oid);
      logRef(local, trackingRef, before, oid, 'git', `fetch ${remoteName}: ${kind === 'new' ? 'storing head' : kind === 'forced' ? 'forced-update' : 'fast-forward'}`, local.lx.clock);
    }
    updates.push({ ref: trackingRef, branch, from: before, to: oid, kind });
  }
  // --prune drops tracking branches whose branch is gone from the remote.
  if (opts.prune) {
    const live = new Set(listRefs(remote, 'refs/heads').map((r) => r.name.slice('refs/heads/'.length)));
    for (const { name, oid } of listRefs(local, `refs/remotes/${remoteName}`)) {
      const branch = name.slice(`refs/remotes/${remoteName}/`.length);
      if (branch === 'HEAD' || live.has(branch)) continue;
      deleteRef(local, name);
      updates.push({ ref: name, branch, from: oid, to: oid, kind: 'pruned' });
    }
  }
  for (const { name, oid } of tags) {
    const tag = name.slice('refs/tags/'.length);
    if (!readRef(local, `refs/tags/${tag}`)) writeRef(local, `refs/tags/${tag}`, oid);
  }
  return { updates, objects };
}

// ---------------------------------------------------------------------------
// push

export interface PushResult {
  /** The ref on the remote, e.g. refs/heads/main or refs/tags/v1.0. */
  ref: string;
  /** The short name, without the refs/heads/ or refs/tags/ prefix. */
  branch: string;
  tag: boolean;
  from: Oid | null;
  to: Oid;
  kind: 'new' | 'fast-forward' | 'forced' | 'up-to-date' | 'rejected';
  reason?: string;
}

export function pushTo(local: Repo, remote: Repo, remoteName: string, refs: Array<{ local: string; remote: string; force?: boolean; expect?: Oid | null }>, opts: { force?: boolean; dryRun?: boolean } = {}): { results: PushResult[]; objects: number } {
  const results: PushResult[] = [];
  const toSend: Oid[] = [];
  for (const spec of refs) {
    // The source is a ref name, or a commit id the caller already resolved.
    const oid = readRef(local, spec.local) ?? (/^[0-9a-f]{40}$/.test(spec.local) ? spec.local : null);
    const tag = spec.remote.startsWith('refs/tags/');
    const branch = spec.remote.replace(/^refs\/(heads|tags)\//, '');
    if (!oid) {
      results.push({ ref: spec.remote, branch, tag, from: null, to: '', kind: 'rejected', reason: `src refspec ${branch} does not match any` });
      continue;
    }
    const before = readRef(remote, spec.remote);
    if (before === oid) {
      results.push({ ref: spec.remote, branch, tag, from: before, to: oid, kind: 'up-to-date' });
      continue;
    }
    // A tag names one commit for good, so moving one is only ever a forced update.
    // A branch may hold commits we have never seen; refusing is what protects them.
    const fastForward = before === null || (!tag && remoteHas(remote, before) && isAncestor(local, before, oid) && localHas(local, before));
    // --force-with-lease forces only while the remote is still where we last saw it.
    if (spec.expect !== undefined && before !== spec.expect) {
      results.push({ ref: spec.remote, branch, tag, from: before, to: oid, kind: 'rejected', reason: 'stale info' });
      continue;
    }
    if (!fastForward && !opts.force && !spec.force && spec.expect === undefined) {
      results.push({ ref: spec.remote, branch, tag, from: before, to: oid, kind: 'rejected', reason: tag ? 'already exists' : 'non-fast-forward' });
      continue;
    }
    toSend.push(oid);
    results.push({ ref: spec.remote, branch, tag, from: before, to: oid, kind: before === null ? 'new' : fastForward ? 'fast-forward' : 'forced' });
  }
  if (opts.dryRun) return { results, objects: 0 };
  const objects = toSend.length ? transfer(local, remote, toSend) : 0;
  for (const result of results) {
    if (result.kind === 'rejected' || result.kind === 'up-to-date') continue;
    writeRef(remote, result.ref, result.to);
    logRef(remote, result.ref, result.from, result.to, 'git', `push`, remote.lx.clock);
    // The local side remembers where the remote now is.
    if (!result.tag) writeRef(local, `refs/remotes/${remoteName}/${result.branch}`, result.to);
  }
  return { results, objects };
}

function remoteHas(remote: Repo, oid: Oid): boolean {
  return Boolean(readCommit(remote, oid));
}

function localHas(local: Repo, oid: Oid): boolean {
  return Boolean(readCommit(local, oid));
}

// ---------------------------------------------------------------------------
// clone

export function cloneInto(
  remote: Repo,
  lx: LinuxState,
  dir: string,
  remoteName: string,
  url: string,
  opts: { branch?: string; bare?: boolean } = {},
): { repo: Repo; branch: string | null; objects: number; commits: number } {
  const remoteHead = head(remote);
  const defaultBranch = opts.branch ?? remoteHead.branch?.replace('refs/heads/', '') ?? 'main';
  const repo = initRepo(lx, dir, { branch: defaultBranch, bare: opts.bare });
  const branches = listRefs(remote, 'refs/heads');
  const tags = listRefs(remote, 'refs/tags');
  const objects = transfer(remote, repo, [...branches.map((b) => b.oid), ...tags.map((t) => t.oid)]);
  // A bare clone copies the branches as they are; a normal one tracks them.
  for (const { name, oid } of branches) writeRef(repo, opts.bare ? name : `refs/remotes/${remoteName}/${name.slice('refs/heads/'.length)}`, oid);
  for (const { name, oid } of tags) writeRef(repo, name, oid);

  const tip = branches.find((b) => b.name === `refs/heads/${defaultBranch}`)?.oid ?? null;
  if (tip && !opts.bare) {
    writeRef(repo, `refs/heads/${defaultBranch}`, tip);
    const remoteDefault = remoteHead.branch ? readRef(remote, remoteHead.branch) : null;
    if (remoteDefault) writeRef(repo, `refs/remotes/${remoteName}/HEAD`, remoteDefault);
    logRef(repo, `refs/heads/${defaultBranch}`, null, tip, 'git', `clone: from ${url}`, lx.clock);
  }
  return { repo, branch: tip ? defaultBranch : null, objects, commits: tip ? ancestors(repo, tip).size : 0 };
}

/** The remotes configured in .git/config, in name order. */
export function remotes(repo: Repo): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  for (const [key, value] of Object.entries(readConfig(repo))) {
    const m = /^remote.(.+).url$/.exec(key);
    if (m) out.push({ name: m[1], url: value });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The remote a branch follows, from branch.<name>.remote and .merge. */
export function upstreamOf(repo: Repo, branch: string): { remote: string; ref: string } | null {
  const remote = configValue(repo, `branch.${branch}.remote`);
  const merge = configValue(repo, `branch.${branch}.merge`);
  if (!remote || !merge) return null;
  return { remote, ref: merge };
}
