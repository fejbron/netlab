/**
 * Naming and walking commits: what `main~2`, `HEAD^`, a short id or `origin/main`
 * each resolve to, which commits a branch reaches, and where two branches last
 * agreed.
 */
import { allObjects, configValue, head, readCommit, readObject, readReflog, readRef, slurp, type Repo } from './repo';
import type { Oid } from './objects';

/** A commit id from whatever the learner typed, or null when nothing matches. */
export function resolveRev(repo: Repo, text: string): Oid | null {
  let trimmed = text.trim();
  if (!trimmed) return null;
  // "@" alone is another name for HEAD.
  if (trimmed === '@') trimmed = 'HEAD';

  // <rev>:<path> names the file (or directory) at that path in that commit.
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.startsWith('refs/')) {
    const commit = resolveRev(repo, trimmed.slice(0, colon));
    const path = trimmed.slice(colon + 1).replace(/^\.?\//, '').replace(/\/$/, '');
    if (!commit) return null;
    let tree = readCommit(repo, commit)?.tree ?? commit;
    if (!path) return tree;
    for (const part of path.split('/')) {
      const o = readObject(repo, tree);
      if (o?.type !== 'tree') return null;
      const entry = o.entries.find((e) => e.name === part);
      if (!entry) return null;
      tree = entry.oid;
    }
    return tree;
  }

  // <branch>@{upstream} (or @{u}) is the remote-tracking branch it follows.
  const up = /^(.*)@\{(u|upstream|push)\}$/.exec(trimmed);
  if (up) {
    const h = head(repo);
    const branch = up[1] && up[1] !== 'HEAD' ? up[1] : h.branch?.replace('refs/heads/', '');
    if (!branch) return null;
    const remote = configValue(repo, `branch.${branch}.remote`);
    const merge = configValue(repo, `branch.${branch}.merge`);
    return remote && merge ? readRef(repo, `refs/remotes/${remote}/${merge.replace('refs/heads/', '')}`) : null;
  }

  // Suffixes are applied right to left: main~2^ is (main~2)^.
  const m = /^(.*?)(~(\d*)|\^(\d*))$/.exec(trimmed);
  if (m && m[1]) {
    const base = resolveRev(repo, m[1]);
    if (!base) return null;
    if (m[2].startsWith('~')) {
      // ~n walks n first parents.
      let oid: Oid | null = base;
      const n = m[3] ? Number(m[3]) : 1;
      for (let i = 0; i < n && oid; i++) oid = readCommit(repo, oid)?.parents[0] ?? null;
      return oid;
    }
    // ^n picks the nth parent; ^0 is the commit itself.
    const n = m[4] ? Number(m[4]) : 1;
    if (n === 0) return base;
    return readCommit(repo, base)?.parents[n - 1] ?? null;
  }

  const reflogAt = /^(.*)@\{(\d+)\}$/.exec(trimmed);
  if (reflogAt) {
    const ref = reflogAt[1] === 'HEAD' || reflogAt[1] === '' ? 'HEAD' : `refs/heads/${reflogAt[1]}`;
    const entries = readReflog(repo, ref);
    const entry = entries[entries.length - 1 - Number(reflogAt[2])];
    return entry ? entry.to : null;
  }

  if (trimmed === 'HEAD') return head(repo).oid;
  for (const special of ['ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'FETCH_HEAD']) {
    if (trimmed === special) {
      const text2 = slurp(repo.lx, `${repo.gitDir}/${special}`);
      return text2 ? (text2.trim().split(/\s+/)[0] || null) : null;
    }
  }

  for (const candidate of [trimmed, `refs/heads/${trimmed}`, `refs/tags/${trimmed}`, `refs/remotes/${trimmed}`, `refs/remotes/${trimmed}/HEAD`, `refs/${trimmed}`]) {
    const oid = readRef(repo, candidate);
    if (oid) return peel(repo, oid);
  }

  if (/^[0-9a-f]{4,40}$/.test(trimmed)) {
    const matches = allObjects(repo).filter((o) => o.startsWith(trimmed));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

/** An annotated tag names a commit; follow it down to the commit itself. */
export function peel(repo: Repo, oid: Oid): Oid {
  let current = oid;
  for (let i = 0; i < 10; i++) {
    const o = readObject(repo, current);
    if (o?.type !== 'tag') return current;
    current = o.tag.object;
  }
  return current;
}

/** Is `text` a name git would resolve? Used to tell a path from a revision. */
export function looksLikeRev(repo: Repo, text: string): boolean {
  return resolveRev(repo, text) !== null;
}

/** Commits reachable from `tips`, newest first by commit time then by insertion. */
export function walk(repo: Repo, tips: Oid[], opts: { firstParent?: boolean } = {}): Oid[] {
  // Collect everything reachable first, then order it once. Sorting the frontier on
  // every step is the same answer at many times the cost.
  const seen = new Set<Oid>();
  const stack = tips.filter(Boolean);
  const found: Oid[] = [];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const commit = readCommit(repo, oid);
    if (!commit) continue;
    seen.add(oid);
    found.push(oid);
    const parents = opts.firstParent ? commit.parents.slice(0, 1) : commit.parents;
    for (const p of parents) if (!seen.has(p)) stack.push(p);
  }
  const when = new Map(found.map((oid) => [oid, readCommit(repo, oid)?.committer.when ?? 0]));
  const order = new Map(found.map((oid, i) => [oid, i]));
  return found.sort((a, b) => when.get(b)! - when.get(a)! || order.get(a)! - order.get(b)!);
}

export function ancestors(repo: Repo, oid: Oid | null): Set<Oid> {
  return new Set(oid ? walk(repo, [oid]) : []);
}

export function isAncestor(repo: Repo, maybeAncestor: Oid, of: Oid): boolean {
  return ancestors(repo, of).has(maybeAncestor);
}

/** The best common ancestor of two commits: the one no other candidate can reach. */
export function mergeBase(repo: Repo, a: Oid, b: Oid): Oid | null {
  const fromA = ancestors(repo, a);
  // walk() returns newest first, so the first common commit is already the best
  // candidate in every history a lab can build; confirm it is not reachable from
  // another common commit before trusting it.
  const common = walk(repo, [b]).filter((oid) => fromA.has(oid));
  if (!common.length) return null;
  if (common.length === 1) return common[0];
  const reachable = new Map<Oid, Set<Oid>>();
  const from = (oid: Oid) => {
    let set = reachable.get(oid);
    if (!set) {
      set = ancestors(repo, oid);
      set.delete(oid);
      reachable.set(oid, set);
    }
    return set;
  };
  for (const candidate of common) {
    if (!common.some((other) => other !== candidate && from(other).has(candidate))) return candidate;
  }
  return common[0];
}

/** Commits in `tip` that `exclude` cannot reach, oldest first: what a rebase replays. */
export function commitsToReplay(repo: Repo, tip: Oid, exclude: Oid): Oid[] {
  const theirs = ancestors(repo, exclude);
  return walk(repo, [tip])
    .filter((oid) => !theirs.has(oid))
    .reverse();
}

/** How far apart two branches are: commits only on the left, and only on the right. */
export function aheadBehind(repo: Repo, ours: Oid | null, theirs: Oid | null): { ahead: number; behind: number } {
  if (!ours || !theirs) return { ahead: 0, behind: 0 };
  const fromOurs = ancestors(repo, ours);
  const fromTheirs = ancestors(repo, theirs);
  return {
    ahead: [...fromOurs].filter((o) => !fromTheirs.has(o)).length,
    behind: [...fromTheirs].filter((o) => !fromOurs.has(o)).length,
  };
}

/** The short id git would print: seven characters, unless that is ambiguous. */
export function shortId(repo: Repo, oid: Oid): string {
  const all = allObjects(repo);
  for (let n = 7; n < 40; n++) {
    const prefix = oid.slice(0, n);
    if (all.filter((o) => o.startsWith(prefix)).length <= 1) return prefix;
  }
  return oid;
}
