/**
 * HCL native syntax: a lexer and recursive-descent parser for the subset Terraform
 * configurations use. Bodies of attributes and labelled blocks; expressions with
 * templates and heredocs, tuples and objects, traversals, splats, function calls,
 * the usual operators, conditionals and for expressions.
 *
 * Every node remembers where it came from, so a mistake is reported the way Terraform
 * reports it: file, line, the offending source line, and a summary.
 */

export interface Pos {
  file: string;
  line: number;
  col: number;
}

export type Expr =
  | { k: 'lit'; v: null | boolean | number | string; pos: Pos }
  | { k: 'tpl'; parts: Array<string | Expr>; pos: Pos }
  | { k: 'tuple'; items: Expr[]; pos: Pos }
  | { k: 'object'; items: Array<{ key: Expr; value: Expr }>; pos: Pos }
  | { k: 'var'; name: string; pos: Pos }
  | { k: 'attr'; obj: Expr; name: string; pos: Pos }
  | { k: 'index'; obj: Expr; index: Expr; pos: Pos }
  | { k: 'splat'; obj: Expr; each: Array<{ attr: string } | { index: Expr }>; pos: Pos }
  | { k: 'call'; name: string; args: Expr[]; expand: boolean; pos: Pos }
  | { k: 'unary'; op: '!' | '-'; e: Expr; pos: Pos }
  | { k: 'binary'; op: string; l: Expr; r: Expr; pos: Pos }
  | { k: 'cond'; c: Expr; t: Expr; f: Expr; pos: Pos }
  | { k: 'for'; object: boolean; keyVar?: string; valVar: string; coll: Expr; keyExpr?: Expr; valExpr: Expr; cond?: Expr; group: boolean; pos: Pos }
  | { k: 'paren'; e: Expr; pos: Pos };

export interface Attribute {
  name: string;
  expr: Expr;
  pos: Pos;
}

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  pos: Pos;
}

export interface Body {
  attrs: Record<string, Attribute>;
  /** Attribute names in source order, for generated output and formatting. */
  order: string[];
  blocks: Block[];
  pos: Pos;
}

export interface Diag {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
  pos?: Pos;
  /** `in resource "x" "y"` and similar, printed after the line number. */
  context?: string;
  /** `with netcloud_subnet.web,` for errors that belong to a resource instance. */
  subject?: string;
}

export class DiagError extends Error {
  constructor(public diags: Diag[]) {
    super(diags.map((d) => d.summary).join('; '));
  }
}

export function diag(summary: string, detail?: string, pos?: Pos, extra: Partial<Diag> = {}): Diag {
  return { severity: 'error', summary, detail, pos, ...extra };
}

// ---------------------------------------------------------------------------
// lexer

type Tok =
  | { t: 'ident'; v: string; pos: Pos }
  | { t: 'num'; v: number; pos: Pos }
  | { t: 'str'; parts: Array<string | Expr>; pos: Pos }
  | { t: 'punct'; v: string; pos: Pos }
  | { t: 'nl'; pos: Pos }
  | { t: 'eof'; pos: Pos };

const PUNCT = ['...', '=>', '==', '!=', '<=', '>=', '&&', '||', '{', '}', '[', ']', '(', ')', '=', ',', '.', ':', '?', '!', '<', '>', '+', '-', '*', '/', '%'];

class Lexer {
  i = 0;
  line: number;
  lineStart = 0;
  toks: Tok[] = [];

  constructor(
    private src: string,
    private file: string,
    firstLine = 1,
    private colOffset = 0,
  ) {
    this.line = firstLine;
  }

  pos(at = this.i): Pos {
    return { file: this.file, line: this.line, col: at - this.lineStart + 1 + (this.line === 1 ? this.colOffset : 0) };
  }

  fail(summary: string, detail: string, pos = this.pos()): never {
    throw new DiagError([diag(summary, detail, pos)]);
  }

  run(): Tok[] {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\n') {
        this.toks.push({ t: 'nl', pos: this.pos() });
        this.i++;
        this.line++;
        this.lineStart = this.i;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '#' || (c === '/' && s[this.i + 1] === '/')) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && s[this.i + 1] === '*') {
        const start = this.pos();
        const end = s.indexOf('*/', this.i + 2);
        if (end === -1) this.fail('Unterminated comment', 'There is no closing marker for this multi-line comment.', start);
        for (let j = this.i; j < end; j++) {
          if (s[j] === '\n') {
            this.line++;
            this.lineStart = j + 1;
          }
        }
        this.i = end + 2;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(this.i))!;
        this.toks.push({ t: 'ident', v: m[0], pos: this.pos() });
        this.i += m[0].length;
        continue;
      }
      if (/[0-9]/.test(c)) {
        const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(this.i))!;
        this.toks.push({ t: 'num', v: Number(m[0]), pos: this.pos() });
        this.i += m[0].length;
        continue;
      }
      if (c === '"') {
        const pos = this.pos();
        this.i++;
        const parts = this.template('"');
        this.toks.push({ t: 'str', parts, pos });
        continue;
      }
      if (c === '<' && s[this.i + 1] === '<' && /^<<-?[A-Za-z_]/.test(s.slice(this.i, this.i + 4))) {
        this.heredoc();
        continue;
      }
      const p = PUNCT.find((x) => s.startsWith(x, this.i));
      if (p) {
        this.toks.push({ t: 'punct', v: p, pos: this.pos() });
        this.i += p.length;
        continue;
      }
      this.fail('Invalid character', `This character is not used within the language.`);
    }
    this.toks.push({ t: 'nl', pos: this.pos() });
    this.toks.push({ t: 'eof', pos: this.pos() });
    return this.toks;
  }

  /** Read a quoted template up to its closing quote (already past the opening one). */
  template(close: '"'): Array<string | Expr> {
    const s = this.src;
    const parts: Array<string | Expr> = [];
    let lit = '';
    while (true) {
      if (this.i >= s.length || s[this.i] === '\n') this.fail('Unterminated template string', 'No closing marker was found for the string.');
      const c = s[this.i];
      if (c === close) {
        this.i++;
        break;
      }
      if (c === '\\') {
        const n = s[this.i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        if (n in map) {
          lit += map[n];
          this.i += 2;
          continue;
        }
        if (n === 'u') {
          lit += String.fromCharCode(parseInt(s.slice(this.i + 2, this.i + 6), 16));
          this.i += 6;
          continue;
        }
        this.fail('Invalid escape sequence', `The symbol "${n}" is not a valid escape sequence selector.`);
      }
      if ((c === '$' || c === '%') && s[this.i + 1] === c && s[this.i + 2] === '{') {
        lit += c + '{';
        this.i += 3;
        continue;
      }
      if (c === '%' && s[this.i + 1] === '{') this.fail('Unsupported template directive', 'NetLab does not simulate %{ } template directives; build the string with a conditional or a for expression instead.');
      if (c === '$' && s[this.i + 1] === '{') {
        if (lit) parts.push(lit);
        lit = '';
        parts.push(this.interpolation());
        continue;
      }
      lit += c;
      this.i++;
    }
    if (lit || parts.length === 0) parts.push(lit);
    return parts;
  }

  /** `${ expr }`: find the matching brace, then parse what is inside as an expression. */
  interpolation(): Expr {
    const s = this.src;
    const startPos = this.pos();
    let j = this.i + 2;
    if (s[j] === '~') j++;
    const bodyStart = j;
    let depth = 0;
    let inStr = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === '\n') this.fail('Unterminated template string', 'No closing marker was found for the interpolation sequence.', startPos);
    }
    if (j >= s.length) this.fail('Unterminated template string', 'No closing marker was found for the interpolation sequence.', startPos);
    let body = s.slice(bodyStart, j);
    if (body.endsWith('~')) body = body.slice(0, -1);
    const sub = new Lexer(body, this.file, this.line, 0);
    sub.lineStart = -(bodyStart - this.lineStart);
    const toks = sub.run();
    const expr = new Parser(toks).parseWholeExpr();
    this.i = j + 1;
    return expr;
  }

  heredoc() {
    const s = this.src;
    const pos = this.pos();
    const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(s.slice(this.i));
    if (!m) this.fail('Invalid heredoc', 'A heredoc marker must be followed by a newline.');
    const strip = m[1] === '-';
    const marker = m[2];
    this.i += m[0].length;
    this.line++;
    this.lineStart = this.i;
    const lines: string[] = [];
    let closed = false;
    while (this.i < s.length) {
      let end = s.indexOf('\n', this.i);
      if (end === -1) end = s.length;
      const text = s.slice(this.i, end).replace(/\r$/, '');
      this.i = end;
      if (text.trim() === marker) {
        closed = true;
        break;
      }
      lines.push(text);
      if (this.i < s.length) {
        this.i++;
        this.line++;
        this.lineStart = this.i;
      }
    }
    if (!closed) this.fail('Unterminated template string', `No closing marker was found for the "${marker}" heredoc.`, pos);
    let body = lines;
    if (strip) {
      const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
      const cut = indents.length ? Math.min(...indents) : 0;
      body = lines.map((l) => l.slice(cut));
    }
    const text = body.length ? body.join('\n') + '\n' : '';
    // The heredoc body is a template too; re-lex it on its own with the right line numbers.
    const parts = new Lexer(text, this.file, pos.line + 1).heredocTemplate();
    this.toks.push({ t: 'str', parts, pos });
  }

  /** Template scanning for a heredoc body, where newlines and quotes are ordinary text. */
  heredocTemplate(): Array<string | Expr> {
    const s = this.src;
    const parts: Array<string | Expr> = [];
    let lit = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if ((c === '$' || c === '%') && s[this.i + 1] === c && s[this.i + 2] === '{') {
        lit += c + '{';
        this.i += 3;
        continue;
      }
      if (c === '$' && s[this.i + 1] === '{') {
        if (lit) parts.push(lit);
        lit = '';
        parts.push(this.interpolation());
        continue;
      }
      if (c === '\n') {
        this.line++;
        this.lineStart = this.i + 1;
      }
      lit += c;
      this.i++;
    }
    if (lit || parts.length === 0) parts.push(lit);
    return parts;
  }
}

// ---------------------------------------------------------------------------
// parser

class Parser {
  i = 0;
  /** true: newlines are insignificant here (inside parentheses and brackets). */
  nlStack: boolean[] = [false];

  constructor(private toks: Tok[]) {}

  private get ignoreNl(): boolean {
    return this.nlStack[this.nlStack.length - 1];
  }

  peek(): Tok {
    if (this.ignoreNl) while (this.toks[this.i].t === 'nl') this.i++;
    return this.toks[this.i];
  }

  next(): Tok {
    const t = this.peek();
    if (t.t !== 'eof') this.i++;
    return t;
  }

  isPunct(v: string): boolean {
    const t = this.peek();
    return t.t === 'punct' && t.v === v;
  }

  skipNl() {
    while (this.toks[this.i].t === 'nl') this.i++;
  }

  describe(t: Tok): string {
    if (t.t === 'nl') return 'newline';
    if (t.t === 'eof') return 'end of file';
    if (t.t === 'ident') return `"${t.v}"`;
    if (t.t === 'punct') return `"${t.v}"`;
    return 'a value';
  }

  expectPunct(v: string, summary: string, detail: string): Tok {
    const t = this.peek();
    if (t.t !== 'punct' || t.v !== v) throw new DiagError([diag(summary, detail, t.pos)]);
    return this.next();
  }

  // --- bodies

  parseFile(): Body {
    const body = this.parseBody(true, this.toks[0].pos);
    return body;
  }

  parseBody(top: boolean, pos: Pos): Body {
    const body: Body = { attrs: {}, order: [], blocks: [], pos };
    while (true) {
      this.skipNl();
      const t = this.toks[this.i];
      if (t.t === 'eof') {
        if (!top) throw new DiagError([diag('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', pos)]);
        return body;
      }
      if (t.t === 'punct' && t.v === '}') {
        if (top) throw new DiagError([diag('Argument or block definition required', 'An argument or block definition is required here.', t.pos)]);
        this.i++;
        return body;
      }
      if (t.t !== 'ident') {
        throw new DiagError([diag('Argument or block definition required', 'An argument or block definition is required here.', t.pos)]);
      }
      this.i++;
      const after = this.toks[this.i];
      if (after.t === 'punct' && after.v === '=') {
        this.i++;
        const expr = this.parseExpr();
        const end = this.toks[this.i];
        if (end.t !== 'nl' && end.t !== 'eof' && !(end.t === 'punct' && end.v === '}' && !top)) {
          throw new DiagError([diag('Missing newline after argument', 'An argument definition must end with a newline.', end.pos)]);
        }
        if (body.attrs[t.v]) {
          throw new DiagError([diag('Attribute redefined', `The argument "${t.v}" was already set at ${body.attrs[t.v].pos.file}:${body.attrs[t.v].pos.line},${body.attrs[t.v].pos.col}. Each argument may be set only once.`, t.pos)]);
        }
        body.attrs[t.v] = { name: t.v, expr, pos: t.pos };
        body.order.push(t.v);
        continue;
      }
      const labels: string[] = [];
      while (true) {
        const l = this.toks[this.i];
        if (l.t === 'str') {
          if (l.parts.some((p) => typeof p !== 'string')) throw new DiagError([diag('Invalid block label', 'Template sequences are not allowed in block labels.', l.pos)]);
          labels.push(l.parts.join(''));
          this.i++;
        } else if (l.t === 'ident') {
          labels.push(l.v);
          this.i++;
        } else break;
      }
      const open = this.toks[this.i];
      if (!(open.t === 'punct' && open.v === '{')) {
        if (labels.length === 0 && open.t === 'nl') {
          throw new DiagError([diag('Unsupported argument; did you mean to use "=" ?', `An argument named "${t.v}" must be followed by an equals sign. To define a block instead, add an opening brace.`, open.pos)]);
        }
        throw new DiagError([
          diag(
            labels.length === 0 ? 'Argument or block definition required' : 'Invalid block definition',
            labels.length === 0 ? 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.' : 'Either a quoted string block label or an opening brace ("{") is expected here.',
            open.pos,
          ),
        ]);
      }
      this.i++;
      const inner = this.parseBody(false, t.pos);
      const end = this.toks[this.i];
      if (end.t !== 'nl' && end.t !== 'eof' && !(end.t === 'punct' && end.v === '}')) {
        throw new DiagError([diag('Missing newline after block definition', 'A block definition must end with a newline.', end.pos)]);
      }
      body.blocks.push({ type: t.v, labels, body: inner, pos: t.pos });
    }
  }

  // --- expressions

  parseWholeExpr(): Expr {
    this.nlStack.push(true);
    const e = this.parseExpr();
    const t = this.peek();
    this.nlStack.pop();
    if (t.t !== 'eof' && t.t !== 'nl') throw new DiagError([diag('Extra characters after expression', 'An expression was successfully parsed, but extra characters were found after it.', t.pos)]);
    return e;
  }

  parseExpr(): Expr {
    return this.parseCond();
  }

  parseCond(): Expr {
    const c = this.parseBinary(0);
    if (this.isPunct('?')) {
      this.next();
      this.nlStack.push(true);
      const t = this.parseExpr();
      this.expectPunct(':', 'Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.');
      this.nlStack.pop();
      const f = this.parseExpr();
      return { k: 'cond', c, t, f, pos: c.pos };
    }
    return c;
  }

  static LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];

  parseBinary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let l = this.parseBinary(level + 1);
    while (true) {
      const t = this.peek();
      if (t.t === 'punct' && Parser.LEVELS[level].includes(t.v)) {
        this.next();
        const r = this.parseBinary(level + 1);
        l = { k: 'binary', op: t.v, l, r, pos: l.pos };
      } else return l;
    }
  }

  parseUnary(): Expr {
    const t = this.peek();
    if (t.t === 'punct' && (t.v === '!' || t.v === '-')) {
      this.next();
      const e = this.parseUnary();
      if (t.v === '-' && e.k === 'lit' && typeof e.v === 'number') return { k: 'lit', v: -e.v, pos: t.pos };
      return { k: 'unary', op: t.v, e, pos: t.pos };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(e: Expr): Expr {
    while (true) {
      const t = this.toks[this.i];
      if (t.t === 'punct' && t.v === '.') {
        const n = this.toks[this.i + 1];
        if (n.t === 'ident') {
          this.i += 2;
          e = { k: 'attr', obj: e, name: n.v, pos: e.pos };
        } else if (n.t === 'num') {
          this.i += 2;
          e = { k: 'index', obj: e, index: { k: 'lit', v: n.v, pos: n.pos }, pos: e.pos };
        } else if (n.t === 'punct' && n.v === '*') {
          this.i += 2;
          e = { k: 'splat', obj: e, each: this.splatRest(true), pos: e.pos };
        } else {
          throw new DiagError([diag('Invalid attribute name', 'An attribute name is required after a dot.', n.pos)]);
        }
      } else if (t.t === 'punct' && t.v === '[') {
        const n = this.toks[this.i + 1];
        const n2 = this.toks[this.i + 2];
        if (n.t === 'punct' && n.v === '*' && n2.t === 'punct' && n2.v === ']') {
          this.i += 3;
          e = { k: 'splat', obj: e, each: this.splatRest(false), pos: e.pos };
          continue;
        }
        this.i++;
        this.nlStack.push(true);
        const index = this.parseExpr();
        this.expectPunct(']', 'Missing close bracket on index', 'The index operator must end with a closing bracket ("]").');
        this.nlStack.pop();
        e = { k: 'index', obj: e, index, pos: e.pos };
      } else return e;
    }
  }

  splatRest(attrOnly: boolean): Array<{ attr: string } | { index: Expr }> {
    const each: Array<{ attr: string } | { index: Expr }> = [];
    while (true) {
      const t = this.toks[this.i];
      if (t.t === 'punct' && t.v === '.' && this.toks[this.i + 1].t === 'ident') {
        each.push({ attr: (this.toks[this.i + 1] as { v: string }).v });
        this.i += 2;
      } else if (!attrOnly && t.t === 'punct' && t.v === '[' && !(this.toks[this.i + 1].t === 'punct' && (this.toks[this.i + 1] as { v: string }).v === '*')) {
        this.i++;
        this.nlStack.push(true);
        each.push({ index: this.parseExpr() });
        this.expectPunct(']', 'Missing close bracket on index', 'The index operator must end with a closing bracket ("]").');
        this.nlStack.pop();
      } else return each;
    }
  }

  parsePrimary(): Expr {
    const t = this.peek();
    switch (t.t) {
      case 'num':
        this.next();
        return { k: 'lit', v: t.v, pos: t.pos };
      case 'str': {
        this.next();
        if (t.parts.length === 1 && typeof t.parts[0] === 'string') return { k: 'lit', v: t.parts[0], pos: t.pos };
        return { k: 'tpl', parts: t.parts, pos: t.pos };
      }
      case 'ident': {
        this.next();
        if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true', pos: t.pos };
        if (t.v === 'null') return { k: 'lit', v: null, pos: t.pos };
        const open = this.toks[this.i];
        if (open.t === 'punct' && open.v === '(') return this.parseCall(t.v, t.pos);
        if (open.t === 'punct' && open.v === ':' && this.toks[this.i + 1].t === 'punct' && (this.toks[this.i + 1] as { v: string }).v === ':') {
          throw new DiagError([diag('Unsupported function namespace', 'Provider-defined functions are not simulated in NetLab.', t.pos)]);
        }
        return { k: 'var', name: t.v, pos: t.pos };
      }
      case 'punct':
        if (t.v === '(') {
          this.next();
          this.nlStack.push(true);
          const e = this.parseExpr();
          this.expectPunct(')', 'Unbalanced parentheses', 'Expected a closing parenthesis to terminate the expression.');
          this.nlStack.pop();
          return { k: 'paren', e, pos: t.pos };
        }
        if (t.v === '[') return this.parseTuple();
        if (t.v === '{') return this.parseObject();
        break;
    }
    throw new DiagError([diag('Invalid expression', 'Expected the start of an expression, but found ' + (t.t === 'nl' ? 'the end of the line' : t.t === 'eof' ? 'the end of the file' : this.describe(t)) + '.', t.pos)]);
  }

  parseCall(name: string, pos: Pos): Expr {
    this.next();
    this.nlStack.push(true);
    const args: Expr[] = [];
    let expand = false;
    while (!this.isPunct(')')) {
      args.push(this.parseExpr());
      if (this.isPunct('...')) {
        this.next();
        expand = true;
      }
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(')')) {
        throw new DiagError([diag('Missing argument separator', 'A comma is required to separate each function argument from the next.', this.peek().pos)]);
      }
    }
    this.next();
    this.nlStack.pop();
    return { k: 'call', name, args, expand, pos };
  }

  parseTuple(): Expr {
    const open = this.next();
    this.nlStack.push(true);
    const t = this.peek();
    if (t.t === 'ident' && t.v === 'for' && this.toks[this.i + 1]?.t === 'ident') {
      const f = this.parseFor(false, open.pos);
      this.nlStack.pop();
      return f;
    }
    const items: Expr[] = [];
    while (!this.isPunct(']')) {
      items.push(this.parseExpr());
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(']')) {
        throw new DiagError([diag('Missing item separator', 'Expected a comma to mark the beginning of the next item.', this.peek().pos)]);
      }
    }
    this.next();
    this.nlStack.pop();
    return { k: 'tuple', items, pos: open.pos };
  }

  parseObject(): Expr {
    const open = this.next();
    this.nlStack.push(false);
    this.skipNl();
    const t = this.toks[this.i];
    if (t.t === 'ident' && t.v === 'for' && this.toks[this.i + 1]?.t === 'ident') {
      this.nlStack.push(true);
      const f = this.parseFor(true, open.pos);
      this.nlStack.pop();
      this.nlStack.pop();
      return f;
    }
    const items: Array<{ key: Expr; value: Expr }> = [];
    while (true) {
      this.skipNl();
      if (this.isPunct('}')) break;
      const kt = this.toks[this.i];
      let key: Expr;
      if (kt.t === 'ident' && this.toks[this.i + 1].t === 'punct' && ['=', ':'].includes((this.toks[this.i + 1] as { v: string }).v)) {
        this.i++;
        key = { k: 'lit', v: kt.v, pos: kt.pos };
      } else {
        key = this.parseBinary(0);
      }
      const eq = this.toks[this.i];
      if (!(eq.t === 'punct' && (eq.v === '=' || eq.v === ':'))) {
        throw new DiagError([diag('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.', eq.pos)]);
      }
      this.i++;
      const value = this.parseExpr();
      items.push({ key, value });
      const sep = this.toks[this.i];
      if (sep.t === 'punct' && sep.v === ',') this.i++;
      else if (sep.t === 'nl') this.skipNl();
      else if (!(sep.t === 'punct' && sep.v === '}')) {
        throw new DiagError([diag('Missing attribute separator', 'Expected a newline or comma to mark the beginning of the next attribute.', sep.pos)]);
      }
    }
    this.next();
    this.nlStack.pop();
    return { k: 'object', items, pos: open.pos };
  }

  parseFor(object: boolean, pos: Pos): Expr {
    this.next(); // for
    const first = this.next();
    if (first.t !== 'ident') throw new DiagError([diag('Invalid for expression', 'For expression requires variable name after "for".', first.pos)]);
    let keyVar: string | undefined;
    let valVar = first.v;
    if (this.isPunct(',')) {
      this.next();
      const second = this.next();
      if (second.t !== 'ident') throw new DiagError([diag('Invalid for expression', 'For expression requires value variable name after comma.', second.pos)]);
      keyVar = first.v;
      valVar = second.v;
    }
    const inTok = this.next();
    if (!(inTok.t === 'ident' && inTok.v === 'in')) throw new DiagError([diag('Invalid for expression', 'For expression requires the "in" keyword after its name declarations.', inTok.pos)]);
    const coll = this.parseExpr();
    this.expectPunct(':', 'Invalid for expression', 'For expression requires a colon after the collection expression.');
    let keyExpr: Expr | undefined;
    let valExpr = this.parseExpr();
    let group = false;
    if (object) {
      if (!this.isPunct('=>')) throw new DiagError([diag('Invalid for expression', 'Key expression is required when building an object.', this.peek().pos)]);
      this.next();
      keyExpr = valExpr;
      valExpr = this.parseExpr();
      if (this.isPunct('...')) {
        this.next();
        group = true;
      }
    }
    let cond: Expr | undefined;
    const t = this.peek();
    if (t.t === 'ident' && t.v === 'if') {
      this.next();
      cond = this.parseExpr();
    }
    this.expectPunct(object ? '}' : ']', 'Invalid for expression', `Extra characters after the end of the 'for' expression.`);
    return { k: 'for', object, keyVar, valVar, coll, keyExpr, valExpr, cond, group, pos };
  }
}

/** Parse one configuration file. Throws DiagError on a syntax error. */
export function parseHcl(src: string, file: string): Body {
  const toks = new Lexer(src, file).run();
  return new Parser(toks).parseFile();
}

/** A template file's text (templatefile), with ${ } interpolations and no quotes around it. */
export function parseTemplate(text: string, file: string): Array<string | Expr> {
  return new Lexer(text, file).heredocTemplate();
}

/** Parse a standalone expression, as typed at `terraform console` or in `-var`. */
export function parseExpression(src: string, file = '<console-input>'): Expr {
  const toks = new Lexer(src, file).run();
  return new Parser(toks).parseWholeExpr();
}

// ---------------------------------------------------------------------------
// diagnostics

function wrap(text: string, width = 76): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    // Indented lines are pre-formatted (lists, lock info); leave them alone.
    if (/^\s/.test(para)) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      if (line && (line + ' ' + word).length > width) {
        out.push(line);
        line = word;
      } else line = line ? line + ' ' + word : word;
    }
    out.push(line);
  }
  return out;
}

/** Render diagnostics in Terraform's boxed format. */
export function renderDiags(diags: Diag[], sources: Record<string, string>): string[] {
  const out: string[] = [];
  for (const d of diags) {
    out.push('╷');
    out.push(`│ ${d.severity === 'error' ? 'Error' : 'Warning'}: ${d.summary}`);
    out.push('│');
    if (d.subject) out.push(`│   with ${d.subject},`);
    if (d.subject && !d.pos) out.push("│");
    if (d.pos) {
      const src = sources[d.pos.file];
      out.push(`│   on ${d.pos.file} line ${d.pos.line}${d.context ? `, in ${d.context}` : ''}:`);
      const text = src?.split('\n')[d.pos.line - 1];
      if (text !== undefined) out.push(`│ ${String(d.pos.line).padStart(4)}: ${text.replace(/\s+$/, '')}`);
      out.push('│');
    }
    if (d.detail) for (const l of wrap(d.detail)) out.push(l ? `│ ${l}` : '│');
    if (out[out.length - 1] === '│' && !d.detail) out.pop();
    out.push('╵');
  }
  return out;
}
