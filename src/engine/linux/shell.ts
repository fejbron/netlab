/**
 * A Bash subset for the simulated Linux hosts: quoting, variables and parameter
 * expansion, command substitution, arithmetic, pipelines, redirections and heredocs,
 * if/for/while/until/case, functions, `test`, and scripts run with bash or ./script.
 *
 * Everything is synchronous and deterministic except `python3`, which the shell hands
 * back to the UI as a pending request (see PendingPython) because the interpreter runs
 * in the browser asynchronously.
 */
import type { NetworkState } from '../network';
import { canExec, canRead, canWrite, currentUser, getNode, homeOf, isRoot, listDir, normalizePath, readFile, resolveLink, writeFile, type LinuxState } from './fs';
import { COMMANDS } from './commands';

// ---------------------------------------------------------------------------
// public types

export interface PendingPython {
  kind: 'python';
  /** Source to run. */
  code: string;
  /** sys.argv, argv[0] is the script path or "-c". */
  argv: string[];
  cwd: string;
  user: string;
  /** Text files visible to the script, by absolute path. */
  files: Record<string, string>;
  /** Where the shell wanted stdout to go. */
  redirect?: { path: string; append: boolean };
  /** The command line, for the terminal echo. */
  display: string;
}

export interface CmdResult {
  out: string[];
  err: string[];
  code: number;
  pending?: PendingPython;
}

export interface ShellApi {
  /** Run shell source with positional parameters (used by bash, source, xargs). */
  runSource(text: string, args: string[]): CmdResult;
  /** Absolute path for a name relative to the current directory. */
  path(p: string): string;
}

export interface CmdCtx {
  state: LinuxState;
  network: NetworkState;
  hostId: string;
  stdin: string;
  args: string[];
  name: string;
  sh: ShellApi;
}

export interface Command {
  help: string;
  run: (ctx: CmdCtx) => CmdResult;
}

export const ok = (out: string[] = [], code = 0): CmdResult => ({ out, err: [], code });
export const fail = (err: string[], code = 1, out: string[] = []): CmdResult => ({ out, err, code });

export class Incomplete extends Error {
  constructor(public why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------------------
// tokenizer

interface Part {
  text: string;
  quoted: boolean;
  kind: 'lit' | 'var' | 'cmd' | 'arith' | 'tilde' | 'atargs';
}

interface WordTok {
  type: 'word';
  parts: Part[];
  /** Raw source, for error messages and `case` patterns. */
  raw: string;
  pos: number;
}

interface OpTok {
  type: 'op';
  op: string;
  pos: number;
}

interface RedirTok {
  type: 'redir';
  op: string;
  pos: number;
  /** Set for heredocs once the body has been collected. */
  heredoc?: { text: string; expand: boolean };
}

type Tok = WordTok | OpTok | RedirTok | { type: 'nl'; pos: number } | { type: 'eof'; pos: number };

const OPS = ['&&', '||', ';;', '|', ';', '(', ')'];
const REDIRS = ['2>>', '2>&1', '&>>', '&>', '<<-', '<<', '2>', '>>', '>', '<'];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const pendingHeredocs: Array<{ tok: RedirTok; delim: string; expand: boolean; strip: boolean }> = [];
  const n = src.length;

  const readHeredocs = () => {
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift()!;
      const lines: string[] = [];
      let found = false;
      while (i <= n) {
        let end = src.indexOf('\n', i);
        if (end === -1) end = n;
        if (i >= n && end === n && src[i - 1] !== '\n' && i === n) {
          /* nothing left */
        }
        const line = src.slice(i, end);
        i = end + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) {
          found = true;
          break;
        }
        lines.push(h.strip ? line.replace(/^\t+/, '') : line);
        if (end === n) break;
      }
      if (!found) throw new Incomplete(`heredoc ${h.delim}`);
      h.tok.heredoc = { text: lines.length ? lines.join('\n') + '\n' : '', expand: h.expand };
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      toks.push({ type: 'nl', pos: i });
      i++;
      if (pendingHeredocs.length) readHeredocs();
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    let matched = false;
    for (const r of REDIRS) {
      if (src.startsWith(r, i)) {
        const tok: RedirTok = { type: 'redir', op: r, pos: i };
        i += r.length;
        toks.push(tok);
        if (r === '<<' || r === '<<-') {
          while (src[i] === ' ' || src[i] === '\t') i++;
          let delim = '';
          let expand = true;
          if (src[i] === "'" || src[i] === '"') {
            const q = src[i++];
            while (i < n && src[i] !== q) delim += src[i++];
            i++;
            expand = false;
          } else {
            while (i < n && !/[\s;|&<>]/.test(src[i])) {
              if (src[i] === '\\') {
                i++;
                expand = false;
              }
              delim += src[i++];
            }
          }
          if (!delim) throw new Incomplete('heredoc delimiter');
          pendingHeredocs.push({ tok, delim, expand, strip: r === '<<-' });
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        toks.push({ type: 'op', op, pos: i });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // a word
    const start = i;
    const parts: Part[] = [];
    let lit = '';
    let litQuoted = false;
    const flush = () => {
      if (lit) parts.push({ text: lit, quoted: litQuoted, kind: 'lit' });
      lit = '';
      litQuoted = false;
    };
    const readDollar = (quoted: boolean) => {
      // at src[i] === '$'
      if (src[i + 1] === '(' && src[i + 2] === '(') {
        let depth = 0;
        let j = i + 3;
        let body = '';
        for (; j < n; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') {
            if (depth === 0 && src[j + 1] === ')') break;
            depth--;
          }
          body += src[j];
        }
        if (j >= n) throw new Incomplete('arithmetic');
        flush();
        parts.push({ text: body, quoted, kind: 'arith' });
        i = j + 2;
        return;
      }
      if (src[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        let body = '';
        for (; j < n; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') {
            depth--;
            if (depth === 0) break;
          }
          if (j > i + 1) body += src[j];
        }
        if (j >= n) throw new Incomplete('command substitution');
        flush();
        parts.push({ text: body, quoted, kind: 'cmd' });
        i = j + 1;
        return;
      }
      if (src[i + 1] === '{') {
        const end = src.indexOf('}', i);
        if (end === -1) throw new Incomplete('parameter expansion');
        flush();
        parts.push({ text: src.slice(i + 2, end), quoted, kind: 'var' });
        i = end + 1;
        return;
      }
      const m = src.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/);
      if (!m) {
        lit += '$';
        i++;
        return;
      }
      flush();
      parts.push({ text: m[1], quoted, kind: m[1] === '@' ? 'atargs' : 'var' });
      i += 1 + m[1].length;
    };
    while (i < n) {
      const ch = src[i];
      if (/[\s;|&<>()]/.test(ch) || ch === '\n') {
        // ")" inside a word is fine for case patterns handled by the parser; stop here.
        break;
      }
      if (ch === "'") {
        flush();
        const end = src.indexOf("'", i + 1);
        if (end === -1) throw new Incomplete('single quote');
        parts.push({ text: src.slice(i + 1, end), quoted: true, kind: 'lit' });
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        flush();
        i++;
        let buf = '';
        let closed = false;
        while (i < n) {
          const d = src[i];
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === '\\' && i + 1 < n && '"$`\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') buf += src[i + 1];
            i += 2;
            continue;
          }
          if (d === '$') {
            if (buf) parts.push({ text: buf, quoted: true, kind: 'lit' });
            buf = '';
            readDollar(true);
            continue;
          }
          if (d === '`') {
            const end = src.indexOf('`', i + 1);
            if (end === -1) throw new Incomplete('backtick');
            if (buf) parts.push({ text: buf, quoted: true, kind: 'lit' });
            buf = '';
            parts.push({ text: src.slice(i + 1, end), quoted: true, kind: 'cmd' });
            i = end + 1;
            continue;
          }
          buf += d;
          i++;
        }
        if (!closed) throw new Incomplete('double quote');
        parts.push({ text: buf, quoted: true, kind: 'lit' });
        continue;
      }
      if (ch === '\\') {
        if (i + 1 >= n) throw new Incomplete('backslash');
        lit += src[i + 1];
        litQuoted = true;
        i += 2;
        continue;
      }
      if (ch === '$') {
        readDollar(false);
        continue;
      }
      if (ch === '`') {
        const end = src.indexOf('`', i + 1);
        if (end === -1) throw new Incomplete('backtick');
        flush();
        parts.push({ text: src.slice(i + 1, end), quoted: false, kind: 'cmd' });
        i = end + 1;
        continue;
      }
      if (ch === '~' && i === start) {
        flush();
        parts.push({ text: '~', quoted: false, kind: 'tilde' });
        i++;
        continue;
      }
      lit += ch;
      i++;
    }
    flush();
    if (i === start) {
      // stray character we do not understand (e.g. "&" alone): treat as literal word
      parts.push({ text: src[i], quoted: false, kind: 'lit' });
      i++;
    }
    toks.push({ type: 'word', parts, raw: src.slice(start, i), pos: start });
  }
  if (pendingHeredocs.length) throw new Incomplete('heredoc');
  toks.push({ type: 'eof', pos: n });
  return toks;
}

// ---------------------------------------------------------------------------
// parser

interface Redir {
  op: string;
  target?: WordTok;
  heredoc?: { text: string; expand: boolean };
}

interface Simple {
  kind: 'simple';
  assigns: Array<{ name: string; value: WordTok }>;
  words: WordTok[];
  redirs: Redir[];
  pos: number;
}
interface IfCmd {
  kind: 'if';
  clauses: Array<{ cond: List; body: List }>;
  otherwise?: List;
  redirs: Redir[];
}
interface ForCmd {
  kind: 'for';
  name: string;
  words?: WordTok[];
  body: List;
  redirs: Redir[];
}
interface WhileCmd {
  kind: 'while';
  until: boolean;
  cond: List;
  body: List;
  redirs: Redir[];
}
interface CaseCmd {
  kind: 'case';
  word: WordTok;
  items: Array<{ patterns: WordTok[]; body: List }>;
  redirs: Redir[];
}
interface FuncDef {
  kind: 'func';
  name: string;
  body: Group;
  source: string;
}
interface Group {
  kind: 'group';
  body: List;
  redirs: Redir[];
}
type Cmd = Simple | IfCmd | ForCmd | WhileCmd | CaseCmd | FuncDef | Group;

interface Pipeline {
  negate: boolean;
  cmds: Cmd[];
}

interface List {
  items: Array<{ pipe: Pipeline; op: ';' | '&&' | '||' | null }>;
}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', '{', '}', '!']);

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private src: string,
  ) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isWord(t: Tok, text?: string): t is WordTok {
    if (t.type !== 'word') return false;
    if (text === undefined) return true;
    return t.raw === text;
  }
  private isOp(t: Tok, op: string): boolean {
    return t.type === 'op' && t.op === op;
  }
  private skipNewlines() {
    while (this.peek().type === 'nl' || this.isOp(this.peek(), ';')) this.next();
  }
  private expectWord(text: string, context: string) {
    this.skipNewlines();
    const t = this.peek();
    if (t.type === 'eof') throw new Incomplete(`expected ${text}`);
    if (!this.isWord(t, text)) throw new SyntaxErr(`syntax error near unexpected token \`${describe(t)}' (expected ${text} in ${context})`);
    this.next();
  }

  parseProgram(): List {
    const list = this.parseList(new Set());
    this.skipNewlines();
    const t = this.peek();
    if (t.type !== 'eof') throw new SyntaxErr(`syntax error near unexpected token \`${describe(t)}'`);
    return list;
  }

  /** Parse a list until EOF or one of the terminator words (fi, done, ...). */
  private parseList(stop: Set<string>): List {
    const items: List['items'] = [];
    this.skipNewlines();
    while (true) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (this.isWord(t) && stop.has(t.raw)) break;
      if (this.isOp(t, ')') || this.isOp(t, ';;')) break;
      const pipe = this.parsePipeline();
      let op: ';' | '&&' | '||' | null = null;
      const s = this.peek();
      if (s.type === 'op' && (s.op === '&&' || s.op === '||')) {
        op = s.op;
        this.next();
        this.skipNewlines();
        if (this.peek().type === 'eof') throw new Incomplete(op);
      } else if (s.type === 'op' && s.op === ';') {
        op = ';';
        this.next();
      } else if (s.type === 'nl') {
        op = ';';
        this.next();
      }
      items.push({ pipe, op });
      this.skipNewlines();
      if (op === null) break;
    }
    return { items };
  }

  private parsePipeline(): Pipeline {
    let negate = false;
    if (this.isWord(this.peek(), '!')) {
      negate = true;
      this.next();
    }
    const cmds = [this.parseCommand()];
    while (this.isOp(this.peek(), '|')) {
      this.next();
      this.skipNewlines();
      if (this.peek().type === 'eof') throw new Incomplete('pipe');
      cmds.push(this.parseCommand());
    }
    return { negate, cmds };
  }

  private parseRedirs(redirs: Redir[]) {
    while (this.peek().type === 'redir') {
      const r = this.next() as RedirTok;
      if (r.op === '<<' || r.op === '<<-') {
        redirs.push({ op: '<<', heredoc: r.heredoc });
        continue;
      }
      if (r.op === '2>&1') {
        redirs.push({ op: r.op });
        continue;
      }
      const t = this.peek();
      if (!this.isWord(t)) throw t.type === 'eof' ? new Incomplete('redirect target') : new SyntaxErr(`syntax error near unexpected token \`${describe(t)}'`);
      this.next();
      redirs.push({ op: r.op, target: t });
    }
  }

  private parseCommand(): Cmd {
    const t = this.peek();
    if (this.isWord(t)) {
      switch (t.raw) {
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
        case 'until':
          return this.parseWhile();
        case 'case':
          return this.parseCase();
        case '{': {
          this.next();
          const body = this.parseList(new Set(['}']));
          this.expectWord('}', 'group');
          const g: Group = { kind: 'group', body, redirs: [] };
          this.parseRedirs(g.redirs);
          return g;
        }
        case 'function': {
          this.next();
          const name = this.peek();
          if (!this.isWord(name)) throw new SyntaxErr('syntax error: function name expected');
          this.next();
          if (this.isOp(this.peek(), '(')) {
            this.next();
            if (!this.isOp(this.peek(), ')')) throw new SyntaxErr("syntax error near unexpected token `('");
            this.next();
          }
          return this.parseFuncBody(name.raw);
        }
      }
      // name() { ... }
      const nx = this.toks[this.i + 1];
      const nx2 = this.toks[this.i + 2];
      if (nx && this.isOp(nx, '(') && nx2 && this.isOp(nx2, ')') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.raw)) {
        this.i += 3;
        return this.parseFuncBody(t.raw);
      }
    }
    return this.parseSimple();
  }

  private parseFuncBody(name: string): FuncDef {
    this.skipNewlines();
    const open = this.peek();
    if (open.type === 'eof') throw new Incomplete('function body');
    if (!this.isWord(open, '{')) throw new SyntaxErr(`syntax error near unexpected token \`${describe(open)}'`);
    const startPos = open.pos;
    this.next();
    const body = this.parseList(new Set(['}']));
    this.skipNewlines();
    const close = this.peek();
    if (close.type === 'eof') throw new Incomplete('}');
    if (!this.isWord(close, '}')) throw new SyntaxErr(`syntax error near unexpected token \`${describe(close)}'`);
    this.next();
    const source = this.src.slice(startPos, close.pos + 1);
    return { kind: 'func', name, body: { kind: 'group', body, redirs: [] }, source };
  }

  private parseIf(): IfCmd {
    this.next(); // if
    const clauses: IfCmd['clauses'] = [];
    let cond = this.parseList(new Set(['then']));
    this.expectWord('then', 'if');
    let body = this.parseList(new Set(['elif', 'else', 'fi']));
    clauses.push({ cond, body });
    let otherwise: List | undefined;
    while (true) {
      this.skipNewlines();
      const t = this.peek();
      if (t.type === 'eof') throw new Incomplete('fi');
      if (this.isWord(t, 'elif')) {
        this.next();
        cond = this.parseList(new Set(['then']));
        this.expectWord('then', 'elif');
        body = this.parseList(new Set(['elif', 'else', 'fi']));
        clauses.push({ cond, body });
        continue;
      }
      if (this.isWord(t, 'else')) {
        this.next();
        otherwise = this.parseList(new Set(['fi']));
        continue;
      }
      if (this.isWord(t, 'fi')) {
        this.next();
        break;
      }
      throw new SyntaxErr(`syntax error near unexpected token \`${describe(t)}'`);
    }
    const cmd: IfCmd = { kind: 'if', clauses, otherwise, redirs: [] };
    this.parseRedirs(cmd.redirs);
    return cmd;
  }

  private parseFor(): ForCmd {
    this.next(); // for
    const name = this.peek();
    if (!this.isWord(name)) throw name.type === 'eof' ? new Incomplete('for') : new SyntaxErr("syntax error near `for'");
    this.next();
    let words: WordTok[] | undefined;
    if (this.isWord(this.peek(), 'in')) {
      this.next();
      words = [];
      while (this.isWord(this.peek()) && !this.isWord(this.peek(), 'do')) words.push(this.next() as WordTok);
    }
    if (this.isOp(this.peek(), ';')) this.next();
    this.expectWord('do', 'for');
    const body = this.parseList(new Set(['done']));
    this.expectWord('done', 'for');
    const cmd: ForCmd = { kind: 'for', name: name.raw, words, body, redirs: [] };
    this.parseRedirs(cmd.redirs);
    return cmd;
  }

  private parseWhile(): WhileCmd {
    const kw = this.next() as WordTok;
    const cond = this.parseList(new Set(['do']));
    this.expectWord('do', kw.raw);
    const body = this.parseList(new Set(['done']));
    this.expectWord('done', kw.raw);
    const cmd: WhileCmd = { kind: 'while', until: kw.raw === 'until', cond, body, redirs: [] };
    this.parseRedirs(cmd.redirs);
    return cmd;
  }

  private parseCase(): CaseCmd {
    this.next(); // case
    const word = this.peek();
    if (!this.isWord(word)) throw word.type === 'eof' ? new Incomplete('case') : new SyntaxErr("syntax error near `case'");
    this.next();
    this.expectWord('in', 'case');
    const items: CaseCmd['items'] = [];
    while (true) {
      this.skipNewlines();
      const t = this.peek();
      if (t.type === 'eof') throw new Incomplete('esac');
      if (this.isWord(t, 'esac')) {
        this.next();
        break;
      }
      if (this.isOp(t, '(')) this.next();
      const patterns: WordTok[] = [];
      while (true) {
        const p = this.peek();
        if (!this.isWord(p)) throw p.type === 'eof' ? new Incomplete('case pattern') : new SyntaxErr(`syntax error near unexpected token \`${describe(p)}'`);
        patterns.push(this.next() as WordTok);
        if (this.isOp(this.peek(), '|')) {
          this.next();
          continue;
        }
        break;
      }
      if (!this.isOp(this.peek(), ')')) throw this.peek().type === 'eof' ? new Incomplete(')') : new SyntaxErr(`syntax error near unexpected token \`${describe(this.peek())}'`);
      this.next();
      const body = this.parseList(new Set(['esac']));
      items.push({ patterns, body });
      this.skipNewlines();
      if (this.isOp(this.peek(), ';;')) this.next();
    }
    const cmd: CaseCmd = { kind: 'case', word, items, redirs: [] };
    this.parseRedirs(cmd.redirs);
    return cmd;
  }

  private parseSimple(): Simple {
    const cmd: Simple = { kind: 'simple', assigns: [], words: [], redirs: [], pos: this.peek().pos };
    let seenWord = false;
    while (true) {
      const t = this.peek();
      if (t.type === 'redir') {
        this.parseRedirs(cmd.redirs);
        continue;
      }
      if (!this.isWord(t)) break;
      if (RESERVED.has(t.raw) && cmd.words.length === 0 && cmd.assigns.length === 0 && t.raw !== '!' && t.raw !== '{' && t.raw !== '}') {
        throw new SyntaxErr(`syntax error near unexpected token \`${t.raw}'`);
      }
      if (t.raw === '}' && cmd.words.length === 0) break;
      const m = !seenWord && t.parts[0]?.kind === 'lit' && !t.parts[0].quoted ? t.raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=/) : null;
      if (m) {
        this.next();
        cmd.assigns.push({ name: m[1], value: stripAssign(t, m[0].length) });
        continue;
      }
      seenWord = true;
      cmd.words.push(this.next() as WordTok);
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirs.length === 0) {
      const t = this.peek();
      throw t.type === 'eof' ? new Incomplete('command') : new SyntaxErr(`syntax error near unexpected token \`${describe(t)}'`);
    }
    return cmd;
  }
}

/** Turn "NAME=value" into the word for `value` (dropping the first `skip` chars of the first literal part). */
function stripAssign(t: WordTok, skip: number): WordTok {
  let parts = t.parts.map((p, idx) => (idx === 0 ? { ...p, text: p.text.slice(skip) } : p)).filter((p, idx) => !(idx === 0 && p.text === '' && p.kind === 'lit' && t.parts.length > 1));
  const first = parts[0];
  if (first && first.kind === 'lit' && !first.quoted && (first.text === '~' || first.text.startsWith('~/'))) {
    parts = [{ text: '~', quoted: false, kind: 'tilde' }, ...(first.text.length > 1 ? [{ ...first, text: first.text.slice(1) }] : []), ...parts.slice(1)];
  }
  return { ...t, parts: parts.length ? parts : [{ text: '', quoted: true, kind: 'lit' }], raw: t.raw.slice(skip) };
}

function describe(t: Tok): string {
  if (t.type === 'word') return t.raw;
  if (t.type === 'op') return t.op;
  if (t.type === 'redir') return t.op;
  return t.type === 'nl' ? 'newline' : 'end of file';
}

class SyntaxErr extends Error {}
/** Control-flow signals carry the output produced before they fired. */
class FlowSignal {
  out: string[] = [];
  err: string[] = [];
}
class BreakSignal extends FlowSignal {
  constructor(public levels: number) {
    super();
  }
}
class ContinueSignal extends FlowSignal {
  constructor(public levels: number) {
    super();
  }
}
class ReturnSignal extends FlowSignal {
  constructor(public code: number) {
    super();
  }
}
class ExitSignal extends FlowSignal {
  constructor(public code: number) {
    super();
  }
}

// ---------------------------------------------------------------------------
// executor

interface Frame {
  args: string[];
  locals: Record<string, string | undefined>;
}

export interface ExecEnv {
  state: LinuxState;
  network: NetworkState;
  hostId: string;
}

export class Shell implements ShellApi {
  private frames: Frame[] = [];
  private steps = 0;
  /** Output lines the shell has printed so far (used by python pending to keep ordering). */
  constructor(
    private env: ExecEnv,
    args: string[] = [],
  ) {
    this.frames.push({ args, locals: {} });
  }

  get state(): LinuxState {
    return this.env.state;
  }

  path(p: string): string {
    return normalizePath(this.state.cwd, p, homeOf(this.state));
  }

  /** Parse and run source text. Throws Incomplete for an unfinished command. */
  runSource(text: string, args?: string[]): CmdResult {
    const toks = tokenize(text);
    const program = new Parser(toks, text).parseProgram();
    if (args) this.frames.push({ args, locals: {} });
    try {
      return this.runList(program, '');
    } catch (e) {
      if (e instanceof ExitSignal) return { out: e.out, err: e.err, code: e.code };
      if (e instanceof ReturnSignal) return { out: e.out, err: e.err, code: e.code };
      throw e;
    } finally {
      if (args) this.frames.pop();
    }
  }

  // --- variables

  private get frame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  getVar(name: string): string | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (name in this.frames[i].locals) return this.frames[i].locals[name];
    switch (name) {
      case 'PWD':
        return this.state.cwd;
      case 'HOME':
        return homeOf(this.state);
      case 'USER':
      case 'LOGNAME':
        return this.state.user;
      case 'UID':
        return String(currentUser(this.state).uid);
      case 'HOSTNAME':
        return this.state.hostname;
      case 'RANDOM':
        this.state.clock += 1;
        return String((this.state.clock * 7919) % 32768);
      case 'LINENO':
        return '1';
    }
    return this.state.env[name];
  }

  setVar(name: string, value: string, local = false) {
    if (local) {
      this.frame.locals[name] = value;
      return;
    }
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (name in this.frames[i].locals) {
        this.frames[i].locals[name] = value;
        return;
      }
    }
    this.state.env[name] = value;
  }

  // --- expansion

  private expandParam(spec: string, quoted: boolean): string | string[] {
    const args = this.frame.args;
    const special = (name: string): string | undefined => {
      switch (name) {
        case '?':
          return String(this.state.lastExit);
        case '#':
          return String(args.length);
        case '$':
          return '1201';
        case '!':
          return '0';
        case '-':
          return 'himBH';
        case '0':
          return 'bash';
        case '*':
          return args.join(' ');
        case '@':
          return args.join(' ');
      }
      if (/^[0-9]+$/.test(name)) return args[Number(name) - 1];
      return undefined;
    };
    const lookup = (name: string) => special(name) ?? this.getVar(name);
    if (spec.startsWith('#')) {
      const v = lookup(spec.slice(1)) ?? '';
      return String(v.length);
    }
    const m = spec.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(:-|:=|:\+|:\?|##|#|%%|%|\/\/|\/|\^\^|\^|,,|,)?([\s\S]*)$/);
    if (!m) return '';
    const [, name, op, rest] = m;
    const value = lookup(name);
    if (!op) return value ?? '';
    const alt = () => this.expandWordText(rest, quoted);
    switch (op) {
      case ':-':
        return value ? value : alt();
      case ':=': {
        if (value) return value;
        const v = alt();
        this.setVar(name, v);
        return v;
      }
      case ':+':
        return value ? alt() : '';
      case ':?':
        if (value) return value;
        throw new ShellError(`bash: ${name}: ${rest || 'parameter null or not set'}`);
      case '#':
      case '##': {
        const v = value ?? '';
        const re = globToRegex(alt(), op === '##');
        const mm = v.match(new RegExp('^' + re.source));
        return mm ? v.slice(mm[0].length) : v;
      }
      case '%':
      case '%%': {
        const v = value ?? '';
        const re = globToRegex(alt(), op === '%%');
        const mm = v.match(new RegExp(re.source + '$'));
        return mm ? v.slice(0, v.length - mm[0].length) : v;
      }
      case '/':
      case '//': {
        const v = value ?? '';
        const [pat, rep = ''] = splitOnce(rest, '/');
        const re = new RegExp(globToRegex(this.expandWordText(pat, quoted), true).source, op === '//' ? 'g' : '');
        return v.replace(re, this.expandWordText(rep, quoted));
      }
      case '^^':
        return (value ?? '').toUpperCase();
      case '^':
        return (value ?? '').replace(/^./, (c) => c.toUpperCase());
      case ',,':
        return (value ?? '').toLowerCase();
      case ',':
        return (value ?? '').replace(/^./, (c) => c.toLowerCase());
    }
    return value ?? '';
  }

  /** Expand a string as if it were a double-quoted word (used for parameter defaults and heredocs). */
  expandWordText(text: string, _quoted = true): string {
    if (!text.includes('$') && !text.includes('`')) return text;
    const toks = tokenize('"' + text.replace(/"/g, '\\"') + '"');
    const w = toks[0];
    if (w.type !== 'word') return text;
    return this.expandWord(w).join(' ');
  }

  private commandSubst(body: string): string {
    if (this.frames.length > 40) throw new ShellError('bash: command substitution: recursion limit reached');
    const r = this.runSourceCapture(body);
    return r.out.join('\n').replace(/\n+$/, '');
  }

  private runSourceCapture(body: string): CmdResult {
    const toks = tokenize(body);
    const program = new Parser(toks, body).parseProgram();
    const r = this.runList(program, '');
    this.state.outputs.push(...r.err);
    return r;
  }

  arith(expr: string): number {
    const replaced = expr.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (_m, a, b) => {
      const name = a ?? b;
      const v = this.getVar(name);
      const num = v === undefined ? 0 : Number(v);
      return String(Number.isFinite(num) ? num : 0);
    });
    if (!/^[\d\s+\-*/%()<>=!&|?:~^]*$/.test(replaced) || replaced.trim() === '') return 0;
    try {
      const value = new Function(`"use strict"; return (${replaced});`)() as unknown;
      const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    } catch {
      return 0;
    }
  }

  /** Expand a word into fields. */
  expandWord(w: WordTok): string[] {
    type Chunk = { text: string; split: boolean } | { fields: string[] };
    const chunks: Chunk[] = [];
    for (const p of w.parts) {
      switch (p.kind) {
        case 'lit':
          chunks.push({ text: p.text, split: false });
          break;
        case 'tilde':
          chunks.push({ text: homeOf(this.state), split: false });
          break;
        case 'var': {
          const v = this.expandParam(p.text, p.quoted);
          chunks.push({ text: Array.isArray(v) ? v.join(' ') : v, split: !p.quoted });
          break;
        }
        case 'atargs':
          if (p.quoted) chunks.push({ fields: this.frame.args });
          else chunks.push({ text: this.frame.args.join(' '), split: true });
          break;
        case 'cmd':
          chunks.push({ text: this.commandSubst(p.text), split: !p.quoted });
          break;
        case 'arith':
          chunks.push({ text: String(this.arith(this.expandWordText(p.text))), split: false });
          break;
      }
    }
    const fields: string[] = [];
    let cur: string | null = null;
    for (const c of chunks) {
      if ('fields' in c) {
        if (c.fields.length === 0) continue;
        if (cur === null) cur = c.fields[0];
        else cur += c.fields[0];
        for (let k = 1; k < c.fields.length; k++) {
          fields.push(cur);
          cur = c.fields[k];
        }
        continue;
      }
      if (!c.split) {
        cur = (cur ?? '') + c.text;
        continue;
      }
      const pieces = c.text.split(/[ \t\n]+/);
      const leading = /^[ \t\n]/.test(c.text);
      const trailing = /[ \t\n]$/.test(c.text);
      const nonEmpty = pieces.filter((x, idx) => x !== '' || (idx > 0 && idx < pieces.length - 1));
      if (nonEmpty.length === 0) {
        if (cur !== null && c.text.length > 0) {
          fields.push(cur);
          cur = null;
        }
        continue;
      }
      nonEmpty.forEach((piece, idx) => {
        if (idx === 0 && !leading) cur = (cur ?? '') + piece;
        else {
          if (cur !== null) fields.push(cur);
          cur = piece;
        }
      });
      if (trailing) {
        fields.push(cur!);
        cur = null;
      }
    }
    if (cur !== null) fields.push(cur);
    // pathname expansion for unquoted patterns
    const hasGlob = w.parts.some((p) => p.kind === 'lit' && !p.quoted && /[*?[]/.test(p.text));
    if (hasGlob) {
      const expanded: string[] = [];
      for (const f of fields) {
        const matches = /[*?[]/.test(f) ? this.glob(f) : [];
        expanded.push(...(matches.length ? matches : [f]));
      }
      return expanded;
    }
    return fields;
  }

  glob(pattern: string): string[] {
    const abs = pattern.startsWith('/');
    const base = abs ? '/' : this.state.cwd;
    const segs = pattern.split('/').filter((s, idx) => !(idx === 0 && s === '' && abs));
    let cands = [abs ? '/' : base];
    const prefixes = [abs ? '' : ''];
    void prefixes;
    const outputs: Array<{ path: string; shown: string }> = [{ path: cands[0], shown: abs ? '' : '' }];
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const nextOut: typeof outputs = [];
      for (const o of outputs) {
        if (seg === '' || seg === '.' || seg === '..') {
          const p = normalizePath(o.path, seg || '.');
          nextOut.push({ path: p, shown: o.shown ? `${o.shown}/${seg}` : abs ? `/${seg}` : seg });
          continue;
        }
        if (!/[*?[]/.test(seg)) {
          const p = normalizePath(o.path, seg);
          if (getNode(this.state, p) || si < segs.length - 1) nextOut.push({ path: p, shown: o.shown ? `${o.shown}/${seg}` : abs ? `/${seg}` : seg });
          continue;
        }
        const re = new RegExp('^' + globToRegex(seg, true).source + '$');
        for (const name of listDir(this.state, o.path)) {
          if (name.startsWith('.') && !seg.startsWith('.')) continue;
          if (!re.test(name)) continue;
          nextOut.push({ path: normalizePath(o.path, name), shown: o.shown ? `${o.shown}/${name}` : abs ? `/${name}` : name });
        }
      }
      outputs.length = 0;
      outputs.push(...nextOut);
    }
    cands = outputs.filter((o) => getNode(this.state, o.path, false)).map((o) => o.shown);
    return cands.sort();
  }

  // --- running

  private runList(list: List, stdin: string): CmdResult {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    let pending: PendingPython | undefined;
    let skip: 'and' | 'or' | null = null;
    for (const item of list.items) {
      if (skip === 'and' && code !== 0) {
        skip = item.op === '&&' ? 'and' : item.op === '||' ? 'or' : null;
        if (item.op === '||') skip = null;
        continue;
      }
      if (skip === 'or' && code === 0) {
        skip = item.op === '||' ? 'or' : item.op === '&&' ? 'and' : null;
        if (item.op === '&&') skip = null;
        continue;
      }
      let r: CmdResult;
      try {
        r = this.runPipeline(item.pipe, stdin);
      } catch (e) {
        if (e instanceof FlowSignal) {
          e.out = [...out, ...e.out];
          e.err = [...err, ...e.err];
        }
        throw e;
      }
      out.push(...r.out);
      err.push(...r.err);
      code = r.code;
      if (r.pending) pending = r.pending;
      skip = item.op === '&&' ? 'and' : item.op === '||' ? 'or' : null;
    }
    return { out, err, code, pending };
  }

  private runPipeline(p: Pipeline, stdin: string): CmdResult {
    let input = stdin;
    let result: CmdResult = ok();
    const errs: string[] = [];
    for (let i = 0; i < p.cmds.length; i++) {
      result = this.runCommand(p.cmds[i], input, i < p.cmds.length - 1);
      errs.push(...result.err);
      input = result.out.length ? result.out.join('\n') + '\n' : '';
      if (result.pending && p.cmds.length > 1) return fail(['bash: python3 cannot be part of a pipeline in this simulator; redirect to a file instead']);
    }
    let code = result.code;
    if (p.negate) code = code === 0 ? 1 : 0;
    this.state.lastExit = code;
    return { out: result.out, err: errs, code, pending: result.pending };
  }

  private applyRedirs(cmd: Cmd, r: CmdResult, redirs: Redir[]): CmdResult {
    void cmd;
    let out = r.out;
    let err = r.err;
    for (const rd of redirs) {
      if (rd.op === '2>&1') {
        out = [...out, ...err];
        err = [];
        continue;
      }
      if (rd.op === '<' || rd.op === '<<') continue;
      const target = rd.target ? this.expandWord(rd.target).join(' ') : '';
      const path = this.path(target);
      const append = rd.op === '>>' || rd.op === '2>>' || rd.op === '&>>';
      if (rd.op === '>' || rd.op === '>>' || rd.op === '&>' || rd.op === '&>>') {
        if (r.pending) {
          r.pending.redirect = { path, append };
          continue;
        }
        const text = (rd.op.startsWith('&') ? [...out, ...err] : out).map((l) => l + '\n').join('');
        if (path === '/dev/null') {
          out = [];
          if (rd.op.startsWith('&')) err = [];
          continue;
        }
        const e = writeFile(this.state, path, text, append, 'bash', target);
        if (e) return { out: [], err: [...err, e.error], code: 1 };
        out = [];
        if (rd.op.startsWith('&')) err = [];
      } else if (rd.op === '2>' || rd.op === '2>>') {
        const text = err.map((l) => l + '\n').join('');
        if (path !== '/dev/null') {
          const e = writeFile(this.state, path, text, append, 'bash', target);
          if (e) return { out, err: [e.error], code: 1 };
        }
        err = [];
      }
    }
    return { ...r, out, err };
  }

  private inputFor(redirs: Redir[], stdin: string): { stdin: string } | { error: string } {
    let input = stdin;
    for (const rd of redirs) {
      if (rd.op === '<<' && rd.heredoc) input = rd.heredoc.expand ? this.expandHeredoc(rd.heredoc.text) : rd.heredoc.text;
      if (rd.op === '<' && rd.target) {
        const shown = this.expandWord(rd.target).join(' ');
        const r = readFile(this.state, this.path(shown), 'bash', shown);
        if ('error' in r) return { error: r.error };
        input = r.content;
      }
    }
    return { stdin: input };
  }

  private expandHeredoc(text: string): string {
    return text
      .split('\n')
      .map((line) => (line.includes('$') || line.includes('`') ? this.expandWordText(line) : line))
      .join('\n');
  }

  private runCommand(cmd: Cmd, stdin: string, inPipe: boolean): CmdResult {
    if (++this.steps > 200000) throw new ShellError('bash: script aborted: too many steps (infinite loop?)');
    switch (cmd.kind) {
      case 'simple':
        return this.runSimple(cmd, stdin, inPipe);
      case 'group': {
        const inp = this.inputFor(cmd.redirs, stdin);
        if ('error' in inp) return fail([inp.error]);
        return this.applyRedirs(cmd, this.runList(cmd.body, inp.stdin), cmd.redirs);
      }
      case 'func':
        this.state.functions[cmd.name] = cmd.source;
        return ok();
      case 'if': {
        const ifIn = this.inputFor(cmd.redirs, stdin);
        if ('error' in ifIn) return fail([ifIn.error]);
        stdin = ifIn.stdin;
        for (const c of cmd.clauses) {
          const r = this.runList(c.cond, stdin);
          if (r.code === 0) {
            const b = this.runList(c.body, stdin);
            return this.applyRedirs(cmd, { ...b, err: [...r.err, ...b.err] }, cmd.redirs);
          }
          if (r.err.length) this.state.outputs.push(...r.err);
        }
        if (cmd.otherwise) return this.applyRedirs(cmd, this.runList(cmd.otherwise, stdin), cmd.redirs);
        return ok();
      }
      case 'for': {
        const forIn = this.inputFor(cmd.redirs, stdin);
        if ('error' in forIn) return fail([forIn.error]);
        stdin = forIn.stdin;
        const words = cmd.words ? cmd.words.flatMap((w) => this.expandWord(w)) : [...this.frame.args];
        const out: string[] = [];
        const err: string[] = [];
        let code = 0;
        let iterations = 0;
        for (const w of words) {
          if (++iterations > 10000) throw new ShellError('bash: for loop aborted after 10000 iterations');
          this.setVar(cmd.name, w);
          try {
            const r = this.runList(cmd.body, stdin);
            out.push(...r.out);
            err.push(...r.err);
            code = r.code;
          } catch (e) {
            if (e instanceof FlowSignal) {
              out.push(...e.out);
              err.push(...e.err);
              e.out = [];
              e.err = [];
            }
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (e instanceof ContinueSignal) {
              if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
              continue;
            }
            throw e;
          }
        }
        return this.applyRedirs(cmd, { out, err, code }, cmd.redirs);
      }
      case 'while': {
        const out: string[] = [];
        const err: string[] = [];
        let code = 0;
        let iterations = 0;
        const whileIn = this.inputFor(cmd.redirs, stdin);
        if ('error' in whileIn) return fail([whileIn.error]);
        let input = whileIn.stdin;
        while (true) {
          if (++iterations > 10000) throw new ShellError('bash: while loop aborted after 10000 iterations');
          const c = this.runList(cmd.cond, input);
          err.push(...c.err);
          const go = cmd.until ? c.code !== 0 : c.code === 0;
          if (!go) break;
          // `while read line` consumes stdin line by line.
          if (input && cmd.cond.items.some((it) => it.pipe.cmds.some((x) => x.kind === 'simple' && x.words[0]?.raw === 'read'))) input = input.split('\n').slice(1).join('\n');
          try {
            const r = this.runList(cmd.body, input);
            out.push(...r.out);
            err.push(...r.err);
            code = r.code;
          } catch (e) {
            if (e instanceof FlowSignal) {
              out.push(...e.out);
              err.push(...e.err);
              e.out = [];
              e.err = [];
            }
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (e instanceof ContinueSignal) {
              if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
              continue;
            }
            throw e;
          }
        }
        return this.applyRedirs(cmd, { out, err, code }, cmd.redirs);
      }
      case 'case': {
        const caseIn = this.inputFor(cmd.redirs, stdin);
        if ('error' in caseIn) return fail([caseIn.error]);
        stdin = caseIn.stdin;
        const value = this.expandWord(cmd.word).join(' ');
        for (const item of cmd.items) {
          for (const p of item.patterns) {
            const pat = p.parts.every((x) => x.quoted) ? p.parts.map((x) => x.text).join('') : this.expandWord(p).join(' ');
            const re = new RegExp('^' + globToRegex(pat, true).source + '$');
            if (re.test(value)) return this.applyRedirs(cmd, this.runList(item.body, stdin), cmd.redirs);
          }
        }
        return ok();
      }
    }
  }

  private runSimple(cmd: Simple, stdin: string, inPipe: boolean): CmdResult {
    const words = cmd.words.flatMap((w) => this.expandWord(w));
    if (words.length === 0) {
      for (const a of cmd.assigns) this.setVar(a.name, this.expandWord(a.value).join(' '));
      if (cmd.redirs.length) {
        const inp = this.inputFor(cmd.redirs, stdin);
        if ('error' in inp) return fail([inp.error]);
        return this.applyRedirs(cmd, ok(), cmd.redirs);
      }
      this.state.lastExit = 0;
      return ok();
    }
    const inp = this.inputFor(cmd.redirs, stdin);
    if ('error' in inp) return fail([inp.error]);
    const [name, ...args] = words;
    // temporary assignments for the command's environment
    const saved: Record<string, string | undefined> = {};
    for (const a of cmd.assigns) {
      saved[a.name] = this.state.env[a.name];
      this.state.env[a.name] = this.expandWord(a.value).join(' ');
    }
    let r: CmdResult;
    try {
      r = this.invoke(name, args, inp.stdin, cmd, inPipe);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete this.state.env[k];
        else this.state.env[k] = v;
      }
    }
    return this.applyRedirs(cmd, r, cmd.redirs);
  }

  private invoke(name: string, args: string[], stdin: string, cmd: Simple, inPipe: boolean): CmdResult {
    const st = this.state;
    // functions first
    if (st.functions[name]) return this.callFunction(name, args, stdin);
    switch (name) {
      case 'cd':
        return this.cd(args);
      case 'export': {
        for (const a of args) {
          const [k, v] = splitOnce(a, '=');
          if (v !== undefined) this.setVar(k, v);
          else if (this.getVar(k) !== undefined) st.env[k] = this.getVar(k)!;
        }
        if (!args.length) return ok(Object.entries(st.env).sort().map(([k, v]) => `declare -x ${k}="${v}"`));
        return ok();
      }
      case 'local':
      case 'declare':
      case 'typeset': {
        const local = name === 'local' || this.frames.length > 1;
        for (const a of args.filter((x) => !x.startsWith('-'))) {
          const [k, v] = splitOnce(a, '=');
          this.setVar(k, v ?? this.getVar(k) ?? '', local);
        }
        return ok();
      }
      case 'readonly':
        for (const a of args) {
          const [k, v] = splitOnce(a, '=');
          if (v !== undefined) this.setVar(k, v);
        }
        return ok();
      case 'unset':
        for (const a of args) {
          delete st.env[a];
          for (const f of this.frames) delete f.locals[a];
          if (a in st.functions && args.includes('-f')) delete st.functions[a];
        }
        return ok();
      case 'shift': {
        const n = args[0] ? Number(args[0]) : 1;
        this.frame.args = this.frame.args.slice(n);
        return ok();
      }
      case 'set':
        if (args[0] === '--') this.frame.args = args.slice(1);
        return ok();
      case 'exit': {
        const code = args[0] !== undefined ? Number(args[0]) & 255 : st.lastExit;
        if (this.frames.length > 1) throw new ExitSignal(code);
        // top level: leave a sudo/su shell, otherwise just report
        if (st.userStack.length) {
          st.user = st.userStack.pop()!;
          st.cwd = homeOf(st);
          return ok(['logout']);
        }
        return ok(['logout', '(This is a simulated console; the session stays open.)']);
      }
      case 'logout':
        return this.invoke('exit', [], stdin, cmd, inPipe);
      case 'return':
        throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) & 255 : st.lastExit);
      case 'break':
        throw new BreakSignal(args[0] ? Number(args[0]) : 1);
      case 'continue':
        throw new ContinueSignal(args[0] ? Number(args[0]) : 1);
      case ':':
      case 'true':
        return ok();
      case 'false':
        return ok([], 1);
      case 'read':
        return this.read(args, stdin);
      case 'test':
        return ok([], this.test(args) ? 0 : 1);
      case '[':
        if (args[args.length - 1] !== ']') return fail(["bash: [: missing `]'"], 2);
        return ok([], this.test(args.slice(0, -1)) ? 0 : 1);
      case '[[':
        if (args[args.length - 1] !== ']]') return fail(["bash: [[: missing `]]'"], 2);
        return ok([], this.test(args.slice(0, -1), true) ? 0 : 1);
      case 'source':
      case '.': {
        if (!args[0]) return fail([`bash: ${name}: filename argument required`], 2);
        const r = readFile(st, this.path(args[0]), 'bash');
        if ('error' in r) return fail([r.error.replace(/^bash: /, 'bash: ')]);
        return this.runSourceInline(r.content, args.slice(1));
      }
      case 'eval':
        return this.runSourceInline(args.join(' '));
      case 'type':
      case 'command': {
        if (name === 'command' && args[0] !== '-v') return this.invoke(args[0], args.slice(1), stdin, cmd, inPipe);
        const target = name === 'command' ? args[1] : args[0];
        if (!target) return fail([], 1);
        if (st.functions[target]) return ok([name === 'type' ? `${target} is a function` : target]);
        if (BUILTINS.has(target)) return ok([name === 'type' ? `${target} is a shell builtin` : target]);
        if (COMMANDS[target]) return ok([name === 'type' ? `${target} is /usr/bin/${target}` : `/usr/bin/${target}`]);
        return fail([name === 'type' ? `bash: type: ${target}: not found` : ''].filter(Boolean), 1);
      }
      case 'alias':
      case 'unalias':
      case 'umask':
      case 'hash':
      case 'ulimit':
        return ok();
      case 'history':
        return ok(st.history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h}`));
      case 'bash':
      case 'sh': {
        if (args[0] === '-c') return this.runSourceInline(args.slice(1).join(' '), []);
        if (!args[0]) return ok();
        const r = readFile(st, this.path(args[0]), name);
        if ('error' in r) return fail([`${name}: ${args[0]}: No such file or directory`], 127);
        return this.runSourceInline(r.content, args);
      }
      case 'exec':
        return this.invoke(args[0], args.slice(1), stdin, cmd, inPipe);
      case 'sudo':
        return this.sudo(args, stdin, cmd, inPipe);
    }
    // ./script or /path/script
    if (name.includes('/')) {
      const path = this.path(name);
      const node = getNode(st, path);
      if (!node) return fail([`bash: ${name}: No such file or directory`], 127);
      if (node.type === 'dir') return fail([`bash: ${name}: Is a directory`], 126);
      if (!canExec(st, node)) return fail([`bash: ${name}: Permission denied`], 126);
      if (node.content.startsWith('#!') && /python/.test(node.content.split('\n')[0])) return this.invoke('python3', [name, ...args], stdin, cmd, inPipe);
      return this.runSourceInline(node.content, [name, ...args], true);
    }
    const c = COMMANDS[name];
    if (!c) return fail([`bash: ${name}: command not found`], 127);
    const ctx: CmdCtx = { state: st, network: this.env.network, hostId: this.env.hostId, stdin, args, name, sh: this };
    return c.run(ctx);
  }

  private runSourceInline(text: string, args: string[] = [], scriptArgs = false): CmdResult {
    const frameArgs = scriptArgs ? args.slice(1) : args.length ? args.slice(1) : this.frame.args;
    this.frames.push({ args: frameArgs, locals: {} });
    try {
      const toks = tokenize(text);
      const program = new Parser(toks, text).parseProgram();
      return this.runList(program, '');
    } catch (e) {
      if (e instanceof ExitSignal) return { out: e.out, err: e.err, code: e.code };
      if (e instanceof Incomplete) return fail([`bash: syntax error: unexpected end of file (${e.why})`], 2);
      if (e instanceof SyntaxErr) return fail([`bash: ${e.message}`], 2);
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  private callFunction(name: string, args: string[], stdin: string): CmdResult {
    if (this.frames.length > 60) return fail([`bash: ${name}: maximum function nesting level exceeded`], 1);
    const source = this.state.functions[name];
    const toks = tokenize(source);
    const body = new Parser(toks, source).parseProgram();
    this.frames.push({ args, locals: {} });
    try {
      return this.runList(body, stdin);
    } catch (e) {
      if (e instanceof ReturnSignal) return { out: e.out, err: e.err, code: e.code };
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  private cd(args: string[]): CmdResult {
    const st = this.state;
    const target = args.filter((a) => !a.startsWith('-'))[0];
    let path: string;
    if (!target) path = homeOf(st);
    else if (target === '-') path = st.env.OLDPWD ?? st.cwd;
    else path = this.path(target);
    const node = getNode(st, path);
    if (!node) return fail([`bash: cd: ${target}: No such file or directory`]);
    if (node.type !== 'dir') return fail([`bash: cd: ${target}: Not a directory`]);
    if (!isRoot(st) && !canExec(st, node) && !canRead(st, node)) return fail([`bash: cd: ${target}: Permission denied`]);
    st.env.OLDPWD = st.cwd;
    st.cwd = resolveLink(st, path);
    return ok();
  }

  private read(args: string[], stdin: string): CmdResult {
    const names = args.filter((a) => !a.startsWith('-'));
    const raw = args.includes('-r');
    void raw;
    const line = stdin.split('\n')[0] ?? '';
    if (!stdin) {
      for (const n of names) this.setVar(n, '');
      return ok([], 1);
    }
    const fields = line.trim().split(/\s+/);
    names.forEach((n, i) => this.setVar(n, i === names.length - 1 ? fields.slice(i).join(' ') : (fields[i] ?? '')));
    if (!names.length) this.setVar('REPLY', line);
    return ok();
  }

  private sudo(args: string[], stdin: string, cmd: Simple, inPipe: boolean): CmdResult {
    const st = this.state;
    if (!st.sudoers.includes(st.user)) return fail([`${st.user} is not in the sudoers file.  This incident will be reported.`]);
    let rest = args;
    let login = false;
    while (rest[0]?.startsWith('-')) {
      if (rest[0] === '-i' || rest[0] === '-s') login = true;
      if (rest[0] === '-u') rest = rest.slice(1);
      rest = rest.slice(1);
    }
    if (rest[0] === 'su' && rest.length === 1) login = true;
    if (login && rest.length <= 1) {
      st.userStack.push(st.user);
      st.user = 'root';
      st.cwd = '/root';
      return ok();
    }
    if (!rest.length) return fail(['usage: sudo -h | -K | -k | -V', 'usage: sudo -v [-ABknS] [-g group] [-h host] [-p prompt] [-u user]', 'usage: sudo [-ABbEHknPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [<command>]']);
    const prev = st.user;
    st.userStack.push(prev);
    st.user = 'root';
    try {
      const r = this.invoke(rest[0], rest.slice(1), stdin, cmd, inPipe);
      return r;
    } finally {
      // `sudo -i`-style shells push root permanently; a one-shot command returns to the caller.
      if (st.user === 'root' && st.userStack[st.userStack.length - 1] === prev) {
        st.userStack.pop();
        st.user = prev;
      }
    }
  }

  /** POSIX test / [ ] with the common bash [[ ]] additions. */
  test(args: string[], extended = false): boolean {
    const st = this.state;
    const fileNode = (p: string) => getNode(st, this.path(p));
    const num = (s: string) => {
      const n = Number(s);
      if (!/^-?\d+$/.test(s.trim())) throw new ShellError(`bash: test: ${s}: integer expression expected`);
      return n;
    };
    const evalExpr = (a: string[]): boolean => {
      if (a.length === 0) return false;
      if (a.length === 1) return a[0] !== '';
      if (a[0] === '!') return !evalExpr(a.slice(1));
      if (a.length === 2) {
        const [op, x] = a;
        const node = fileNode(x);
        switch (op) {
          case '-z':
            return x === '';
          case '-n':
            return x !== '';
          case '-e':
            return Boolean(node);
          case '-f':
            return node?.type === 'file';
          case '-d':
            return node?.type === 'dir';
          case '-L':
          case '-h':
            return getNode(st, this.path(x), false)?.type === 'link';
          case '-s':
            return Boolean(node && node.content.length > 0);
          case '-r':
            return Boolean(node && canRead(st, node));
          case '-w':
            return Boolean(node && canWrite(st, node));
          case '-x':
            return Boolean(node && canExec(st, node));
          case '-v':
            return this.getVar(x) !== undefined;
        }
        throw new ShellError(`bash: test: ${op}: unary operator expected`);
      }
      // binary with -a / -o (lowest precedence)
      const ai = a.indexOf('-a');
      const oi = a.indexOf('-o');
      if (oi > 0 && !(extended && false)) return evalExpr(a.slice(0, oi)) || evalExpr(a.slice(oi + 1));
      if (ai > 0) return evalExpr(a.slice(0, ai)) && evalExpr(a.slice(ai + 1));
      if (a.includes('&&')) {
        const idx = a.indexOf('&&');
        return evalExpr(a.slice(0, idx)) && evalExpr(a.slice(idx + 1));
      }
      if (a.includes('||')) {
        const idx = a.indexOf('||');
        return evalExpr(a.slice(0, idx)) || evalExpr(a.slice(idx + 1));
      }
      if (a.length === 3) {
        const [x, op, y] = a;
        switch (op) {
          case '=':
          case '==':
            return extended ? new RegExp('^' + globToRegex(y, true).source + '$').test(x) : x === y;
          case '!=':
            return extended ? !new RegExp('^' + globToRegex(y, true).source + '$').test(x) : x !== y;
          case '=~':
            try {
              return new RegExp(y).test(x);
            } catch {
              return false;
            }
          case '<':
            return x < y;
          case '>':
            return x > y;
          case '-eq':
            return num(x) === num(y);
          case '-ne':
            return num(x) !== num(y);
          case '-lt':
            return num(x) < num(y);
          case '-le':
            return num(x) <= num(y);
          case '-gt':
            return num(x) > num(y);
          case '-ge':
            return num(x) >= num(y);
          case '-nt': {
            const p = fileNode(x);
            const q = fileNode(y);
            return Boolean(p && (!q || p.mtime > q.mtime));
          }
          case '-ot': {
            const p = fileNode(x);
            const q = fileNode(y);
            return Boolean(q && (!p || p.mtime < q.mtime));
          }
        }
        throw new ShellError(`bash: test: ${op}: binary operator expected`);
      }
      if (a[0] === '(' && a[a.length - 1] === ')') return evalExpr(a.slice(1, -1));
      throw new ShellError('bash: test: too many arguments');
    };
    return evalExpr(args);
  }
}

class ShellError extends Error {}

const BUILTINS = new Set(['cd', 'export', 'local', 'declare', 'typeset', 'readonly', 'unset', 'shift', 'set', 'exit', 'logout', 'return', 'break', 'continue', ':', 'true', 'false', 'read', 'test', '[', '[[', 'source', '.', 'eval', 'type', 'command', 'alias', 'unalias', 'umask', 'hash', 'ulimit', 'history', 'bash', 'sh', 'exec', 'sudo']);

export function isBuiltin(name: string): boolean {
  return BUILTINS.has(name);
}

export function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** Shell glob to RegExp source (no anchors). `greedy` chooses how `*` behaves in prefix/suffix stripping. */
export function globToRegex(glob: string, greedy: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += greedy ? '.*' : '.*?';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      re += '\\' + glob[++i];
    } else re += c.replace(/[.+^${}()|\]\/]/g, '\\$&');
  }
  return new RegExp(re);
}

/**
 * Run one shell command line typed at the prompt. Returns the result, or
 * `incomplete` when more lines are needed (heredoc, unfinished loop, open quote).
 */
export function runLine(env: ExecEnv, text: string): CmdResult | { incomplete: true } {
  const shell = new Shell(env);
  try {
    return shell.runSource(text);
  } catch (e) {
    if (e instanceof Incomplete) return { incomplete: true };
    if (e instanceof SyntaxErr) return fail([`bash: ${e.message}`], 2);
    if (e instanceof ShellError) return fail([e.message], 1);
    if (e instanceof BreakSignal || e instanceof ContinueSignal) return fail(['bash: break: only meaningful in a `for\', `while\', or `until\' loop'], 0);
    throw e;
  }
}
