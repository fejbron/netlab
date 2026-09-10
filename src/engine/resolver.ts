/**
 * Generic IOS-style command resolver.
 *
 * Commands are declared with a pattern such as
 *   "switchport access vlan <vlan>"      literal words + one parameter
 *   "banner motd <text...>"              a trailing "rest" parameter that swallows the line
 *
 * Learner input is matched word by word with prefix matching, exactly like IOS:
 *   - "conf t"  -> "configure terminal"
 *   - "sh st"   -> ambiguous when several "show s..." commands exist
 *   - "hostname" alone -> incomplete
 *   - "shwo run" -> invalid at word 0
 */

export interface PatternToken {
  word: string;
  param: boolean;
  rest: boolean;
}

export interface CommandDef<Ctx> {
  pattern: string;
  help: string;
  run: (ctx: Ctx, args: Record<string, string>) => string[] | void;
}

export type Resolution<Ctx> =
  | { kind: 'ok'; def: CommandDef<Ctx>; args: Record<string, string>; canonical: string }
  | { kind: 'ambiguous'; index: number; options: string[] }
  | { kind: 'invalid'; index: number }
  | { kind: 'incomplete' };

const patternCache = new Map<string, PatternToken[]>();

export function parsePattern(pattern: string): PatternToken[] {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const tokens = pattern
    .trim()
    .split(/\s+/)
    .map((word): PatternToken => {
      const m = word.match(/^<([^>]+?)(\.\.\.)?>$/);
      if (m) return { word: m[1], param: true, rest: Boolean(m[2]) };
      return { word: word.toLowerCase(), param: false, rest: false };
    });
  patternCache.set(pattern, tokens);
  return tokens;
}

interface Candidate<Ctx> {
  def: CommandDef<Ctx>;
  pat: PatternToken[];
}

function tokenAt<Ctx>(c: Candidate<Ctx>, i: number): PatternToken | undefined {
  if (i < c.pat.length) return c.pat[i];
  const last = c.pat[c.pat.length - 1];
  return last && last.rest ? last : undefined;
}

export function resolve<Ctx>(defs: CommandDef<Ctx>[], tokens: string[]): Resolution<Ctx> {
  let cands: Candidate<Ctx>[] = defs.map((def) => ({ def, pat: parsePattern(def.pattern) }));
  const canonical: string[] = [];
  const positional: Array<{ index: number; value: string }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    const active = cands.filter((c) => tokenAt(c, i) !== undefined);
    if (active.length === 0) return { kind: 'invalid', index: i };

    const literal = active.filter((c) => {
      const p = tokenAt(c, i)!;
      return !p.param && p.word.startsWith(lower);
    });

    if (literal.length > 0) {
      const exact = literal.filter((c) => tokenAt(c, i)!.word === lower);
      if (exact.length > 0) {
        cands = exact;
        canonical.push(lower);
      } else {
        const words = [...new Set(literal.map((c) => tokenAt(c, i)!.word))];
        if (words.length > 1) return { kind: 'ambiguous', index: i, options: words.sort() };
        cands = literal;
        canonical.push(words[0]);
      }
      continue;
    }

    const params = active.filter((c) => tokenAt(c, i)!.param);
    if (params.length === 0) return { kind: 'invalid', index: i };
    cands = params;

    const restCands = params.filter((c) => tokenAt(c, i)!.rest);
    if (restCands.length === params.length) {
      // Every remaining candidate swallows the rest of the line here.
      const value = tokens.slice(i).join(' ');
      positional.push({ index: i, value });
      canonical.push(value);
      break;
    }
    positional.push({ index: i, value: tok });
    canonical.push(tok);
  }

  const complete = cands.filter((c) => {
    const last = c.pat[c.pat.length - 1];
    if (last?.rest) return tokens.length >= c.pat.length;
    return c.pat.length === tokens.length;
  });
  if (complete.length === 0) return { kind: 'incomplete' };

  const chosen = complete[0];
  const args: Record<string, string> = {};
  for (const { index, value } of positional) {
    const p = tokenAt(chosen, index);
    if (p?.param) args[p.word] = value;
  }
  return { kind: 'ok', def: chosen.def, args, canonical: canonical.join(' ') };
}

export interface HelpEntry {
  word: string;
  help: string;
}

/**
 * Context-sensitive help for "?".
 * `tokens` are the words typed before the question mark. When `partial` is true the last
 * token is an unfinished word ("sh?") and we list completions for it; otherwise ("show ?")
 * we list what may follow.
 */
export function help<Ctx>(
  defs: CommandDef<Ctx>[],
  tokens: string[],
  partial: boolean,
  wordHelp: Record<string, string> = {},
): HelpEntry[] {
  const prefixTokens = partial ? tokens.slice(0, -1) : tokens;
  const partialWord = partial ? tokens[tokens.length - 1].toLowerCase() : '';

  let cands: Candidate<Ctx>[] = defs.map((def) => ({ def, pat: parsePattern(def.pattern) }));
  for (let i = 0; i < prefixTokens.length; i++) {
    const lower = prefixTokens[i].toLowerCase();
    const active = cands.filter((c) => tokenAt(c, i) !== undefined);
    const literal = active.filter((c) => {
      const p = tokenAt(c, i)!;
      return !p.param && p.word.startsWith(lower);
    });
    if (literal.length > 0) {
      const exact = literal.filter((c) => tokenAt(c, i)!.word === lower);
      cands = exact.length > 0 ? exact : literal;
    } else {
      cands = active.filter((c) => tokenAt(c, i)!.param);
    }
    if (cands.length === 0) return [];
  }

  const pos = prefixTokens.length;
  const entries = new Map<string, string>();
  for (const c of cands) {
    const p = tokenAt(c, pos);
    if (!p) {
      if (!partial) entries.set('<cr>', '');
      continue;
    }
    if (p.param) {
      if (partial) continue;
      entries.set(`<${p.word}>`, c.def.help);
      continue;
    }
    if (partial && !p.word.startsWith(partialWord)) continue;
    if (!entries.has(p.word)) entries.set(p.word, wordHelp[p.word] ?? c.def.help);
  }
  return [...entries.entries()]
    .map(([word, help]) => ({ word, help }))
    .sort((a, b) => (a.word === '<cr>' ? 1 : b.word === '<cr>' ? -1 : a.word.localeCompare(b.word)));
}

/** Tab completion: returns the full word when the last token is a unique literal prefix. */
export function complete<Ctx>(defs: CommandDef<Ctx>[], tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const entries = help(defs, tokens, true);
  const literals = entries.filter((e) => !e.word.startsWith('<'));
  return literals.length === 1 ? literals[0].word : null;
}
