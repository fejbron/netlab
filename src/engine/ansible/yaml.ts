/**
 * A YAML subset large enough for playbooks, inventories, variable files and
 * requirements files: block mappings and sequences, flow collections, the quoting and
 * block scalar styles, comments, and the YAML 1.1 booleans Ansible still uses (yes/no).
 *
 * Anchors, aliases and tags are not supported, and say so rather than being quietly
 * ignored. Every mapping and sequence remembers the line it started on, so an error can
 * point at the offending line the way Ansible does.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

/** Where a mapping or sequence started, for error messages. */
export const LINE_OF = new WeakMap<object, number>();

export function lineOf(v: unknown): number | undefined {
  return typeof v === 'object' && v !== null ? LINE_OF.get(v) : undefined;
}

export class YamlError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
    public text: string,
  ) {
    super(message);
  }
}

interface Line {
  raw: string;
  /** Content with any trailing comment removed, right-trimmed. */
  text: string;
  indent: number;
  n: number;
}

function stripComment(raw: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"') {
        out += raw[++i] ?? '';
        continue;
      }
      if (c === quote) {
        if (quote === "'" && raw[i + 1] === "'") {
          out += raw[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}

function scan(src: string): Line[] {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((raw, i) => {
      const text = stripComment(raw);
      return { raw, text, indent: /^[ ]*/.exec(text)![0].length, n: i + 1 };
    });
}

const BOOL_TRUE = new Set(['true', 'yes', 'on', 'y']);
const BOOL_FALSE = new Set(['false', 'no', 'off', 'n']);

/** A plain (unquoted) scalar, resolved to the type YAML would give it. */
export function plainScalar(text: string): YamlValue {
  const s = text.trim();
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null;
  const lower = s.toLowerCase();
  if (BOOL_TRUE.has(lower)) return true;
  if (BOOL_FALSE.has(lower)) return false;
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  return s;
}

class Parser {
  i = 0;

  constructor(private lines: Line[]) {}

  fail(message: string, line: Line, column = line.indent + 1): never {
    throw new YamlError(message, line.n, column, line.raw);
  }

  /** The next line that carries content. */
  peek(): Line | null {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const t = l.text.trim();
      if (t === '' || t === '---' || t === '...') {
        this.i++;
        continue;
      }
      return l;
    }
    return null;
  }

  parseDocument(): YamlValue {
    const first = this.peek();
    if (!first) return null;
    const value = this.parseBlock(first.indent);
    const rest = this.peek();
    if (rest) this.fail('did not find expected key', rest);
    return value;
  }

  parseBlock(indent: number): YamlValue {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (/^-(\s|$)/.test(line.text.slice(line.indent))) return this.parseSequence(line.indent);
    return this.parseMapping(line.indent);
  }

  parseSequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    LINE_OF.set(out, this.peek()!.n);
    while (true) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      const body = line.text.slice(line.indent);
      if (!/^-(\s|$)/.test(body)) break;
      if (line.indent > indent) this.fail('found a line indented too far', line);
      const rest = body.slice(1).replace(/^\s/, '');
      const at = line.indent + body.length - rest.length;
      this.i++;
      out.push(this.parseValueAfterMarker(rest, line, at, indent));
    }
    return out;
  }

  /** The value of "- x" or "key: x", which may continue on the following lines. */
  parseValueAfterMarker(rest: string, line: Line, column: number, indent: number): YamlValue {
    if (rest === '') {
      const next = this.peek();
      if (next && next.indent > indent) return this.parseBlock(next.indent);
      return null;
    }
    if (rest.startsWith('|') || rest.startsWith('>')) return this.parseBlockScalar(rest, indent);
    // "- key: value" starts a mapping whose first key sits at this column.
    if (this.looksLikeKey(rest)) {
      const inline = this.lines[this.i - 1];
      const virtual: Line = { raw: inline.raw, text: ' '.repeat(column) + rest, indent: column, n: inline.n };
      this.lines.splice(this.i, 0, virtual);
      return this.parseMapping(column);
    }
    return this.scalarFrom(rest, line, indent);
  }

  looksLikeKey(text: string): boolean {
    if (text.startsWith('{') || text.startsWith('[')) return false;
    return splitKey(text) !== null;
  }

  parseMapping(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    LINE_OF.set(out, this.peek()!.n);
    while (true) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      const body = line.text.slice(line.indent);
      if (/^-(\s|$)/.test(body)) break;
      if (line.indent > indent) this.fail('mapping values are not allowed in this context', line, line.indent + 1);
      const split = splitKey(body);
      if (!split) this.fail("could not find expected ':'", line, line.indent + body.length);
      const { key, rest } = split;
      if (key in out) this.fail(`found duplicate key "${key}"`, line);
      this.i++;
      out[key] = this.parseValueAfterMarker(rest, line, line.indent + (body.length - rest.length), indent);
    }
    return out;
  }

  parseBlockScalar(header: string, indent: number): string {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body: string[] = [];
    let blockIndent = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const isBlank = l.raw.trim() === '';
      const lineIndent = /^[ ]*/.exec(l.raw)![0].length;
      if (!isBlank && lineIndent <= indent) break;
      if (blockIndent === -1 && !isBlank) blockIndent = lineIndent;
      body.push(isBlank ? '' : l.raw.slice(blockIndent === -1 ? lineIndent : blockIndent));
      this.i++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    let text: string;
    if (style === '|') text = body.join('\n');
    else {
      // Folded: a blank line becomes a newline, any other break becomes a space.
      text = body.reduce((acc, l, idx) => (idx === 0 ? l : l === '' ? acc + '\n' : acc.endsWith('\n') ? acc + l : acc + ' ' + l), '');
    }
    return chomp === 'strip' ? text : text + '\n';
  }

  /** A scalar that may fold over the following, more-indented lines. */
  scalarFrom(first: string, line: Line, indent: number): YamlValue {
    if (first.startsWith('"') || first.startsWith("'")) {
      const r = readQuoted(first, 0);
      if (r === null) this.fail('found unexpected end of stream', line);
      if (first.slice(r.end).trim() !== '') this.fail('found unexpected end of stream', line, r.end + 1);
      return r.value;
    }
    if (first.startsWith('[') || first.startsWith('{')) {
      let text = first;
      // A flow collection may span lines; keep taking lines until it balances.
      while (!balanced(text)) {
        const next = this.lines[this.i];
        if (!next) this.fail('found unexpected end of stream', line);
        text += ' ' + next.text.trim();
        this.i++;
      }
      const r = readFlow(text, 0);
      if (r === null || text.slice(r.end).trim() !== '') this.fail('found unexpected end of stream', line);
      return r.value;
    }
    let text = first;
    while (true) {
      const next = this.peek();
      if (!next || next.indent <= indent) break;
      const body = next.text.slice(next.indent);
      if (/^-(\s|$)/.test(body) || splitKey(body)) break;
      text += ' ' + body.trim();
      this.i++;
    }
    return plainScalar(text);
  }
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth === 0;
}

/** "key: rest" split, respecting quotes and flow collections; null when there is no key. */
function splitKey(body: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) {
        if (quote === "'" && body[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i + 1 === body.length || /\s/.test(body[i + 1]))) {
      const rawKey = body.slice(0, i).trim();
      if (rawKey === '') return null;
      const quoted = rawKey.startsWith('"') || rawKey.startsWith("'") ? readQuoted(rawKey, 0) : null;
      const key = quoted && quoted.end === rawKey.length ? String(quoted.value) : rawKey;
      return { key, rest: body.slice(i + 1).replace(/^\s+/, '') };
    }
  }
  return null;
}

function readQuoted(text: string, at: number): { value: string; end: number } | null {
  const q = text[at];
  let out = '';
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (q === '"' && c === '\\') {
      const n = text[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      out += map[n] ?? n;
      continue;
    }
    if (c === q) {
      if (q === "'" && text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    out += c;
  }
  return null;
}

function readFlow(text: string, at: number): { value: YamlValue; end: number } | null {
  const open = text[at];
  if (open !== '[' && open !== '{') {
    // A plain scalar inside a flow collection ends at a comma or a closing bracket.
    let i = at;
    while (i < text.length && !',]}'.includes(text[i])) i++;
    return { value: plainScalar(text.slice(at, i)), end: i };
  }
  const close = open === '[' ? ']' : '}';
  const items: YamlValue[] = [];
  const map: { [key: string]: YamlValue } = {};
  let i = at + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === close) return { value: open === '[' ? items : map, end: i + 1 };
    if (open === '{') {
      const keyStart = i;
      let key: string;
      if (text[i] === '"' || text[i] === "'") {
        const q = readQuoted(text, i);
        if (!q) return null;
        key = q.value;
        i = q.end;
      } else {
        while (i < text.length && text[i] !== ':') i++;
        key = text.slice(keyStart, i).trim();
      }
      while (i < text.length && /[\s:]/.test(text[i])) i++;
      const v = text[i] === '"' || text[i] === "'" ? readQuoted(text, i) : readFlow(text, i);
      if (!v) return null;
      map[key] = v.value as YamlValue;
      i = v.end;
    } else {
      const v = text[i] === '"' || text[i] === "'" ? readQuoted(text, i) : readFlow(text, i);
      if (!v) return null;
      items.push(v.value as YamlValue);
      i = v.end;
    }
  }
  return null;
}

/** Parse one YAML document. Throws YamlError with the line it failed on. */
export function parseYaml(src: string): YamlValue {
  const anchor = src.split('\n').findIndex((l) => /^\s*\w[\w.-]*:\s*[*&]\w/.test(l) || /^\s*-\s*[*&]\w/.test(l));
  if (anchor >= 0) throw new YamlError('anchors and aliases are not simulated by NetLab', anchor + 1, 1, src.split('\n')[anchor]);
  return new Parser(scan(src)).parseDocument();
}

/** Ansible's syntax error report, with the offending line and a caret. */
export function renderYamlError(e: YamlError, path: string, headline = 'Syntax Error while loading YAML.'): string[] {
  return [
    `ERROR! ${headline}`,
    `  ${e.message}`,
    '',
    `The error appears to be in '${path}': line ${e.line}, column ${e.column}, but may`,
    'be elsewhere in the file depending on the exact syntax problem.',
    '',
    'The offending line appears to be:',
    '',
    e.text,
    `${' '.repeat(Math.max(0, e.column - 1))}^ here`,
    '',
  ];
}

/** Dump a value as YAML, for ansible-inventory and vault round-trips. */
export function toYaml(v: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^[\w./@+-]+$/.test(v) && !/^(true|false|yes|no|null|on|off|\d+(\.\d+)?)$/i.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((item) => `\n${pad}- ${toYaml(item, indent + 2).replace(/^\n\s*/, '')}`).join('');
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return keys.map((k) => `\n${pad}${k}: ${toYaml(v[k], indent + 2)}`).join('');
}
