/**
 * terraform fmt: canonical indentation (two spaces per nesting level), one space either
 * side of an argument's equals sign, a space after commas, trailing whitespace removed,
 * and the equals signs of consecutive arguments at the same level lined up. Heredoc
 * bodies are left exactly as written.
 */

interface Line {
  text: string;
  depth: number;
  raw: boolean;
  assign?: { key: string; value: string };
}

/** Scan one line, returning the bracket balance and where a top-level "=" sits. */
function scan(line: string): { delta: number; leadingClosers: number; eq: number; heredoc?: { marker: string; strip: boolean } } {
  let delta = 0;
  let leadingClosers = 0;
  let seenOther = false;
  let eq = -1;
  let inStr = false;
  let tplDepth = 0;
  let depthHere = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '$' && line[i + 1] === '{') {
        tplDepth++;
        i++;
        continue;
      }
      if (c === '}' && tplDepth > 0) {
        tplDepth--;
        continue;
      }
      if (c === '"' && tplDepth === 0) inStr = false;
      continue;
    }
    if (c === '#' || (c === '/' && line[i + 1] === '/')) break;
    if (c === '"') {
      inStr = true;
      seenOther = true;
      continue;
    }
    if (c === '<' && line[i + 1] === '<') {
      const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(line.slice(i));
      if (m) return { delta, leadingClosers, eq, heredoc: { marker: m[2], strip: m[1] === '-' } };
    }
    if ('{[('.includes(c)) {
      delta++;
      depthHere++;
      seenOther = true;
    } else if ('}])'.includes(c)) {
      delta--;
      depthHere--;
      if (!seenOther) leadingClosers++;
    } else if (c !== ' ' && c !== '\t') {
      if (c === '=' && eq === -1 && depthHere === 0 && !'=!<>'.includes(line[i - 1] ?? '') && line[i + 1] !== '=' && line[i + 1] !== '>') eq = i;
      seenOther = true;
    }
  }
  return { delta, leadingClosers, eq };
}

function spaceCommas(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += c;
    if (inStr) {
      if (c === '\\') {
        out += s[++i] ?? '';
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ',' && s[i + 1] !== undefined && s[i + 1] !== ' ') out += ' ';
  }
  return out;
}

export function formatHcl(src: string): string {
  const input = src.replace(/\r\n/g, '\n').split('\n');
  const lines: Line[] = [];
  let depth = 0;
  let heredoc: { marker: string } | null = null;
  for (const rawLine of input) {
    if (heredoc) {
      lines.push({ text: rawLine, depth, raw: true });
      if (rawLine.trim() === heredoc.marker) {
        lines[lines.length - 1].raw = false;
        lines[lines.length - 1].text = rawLine.trim();
        lines[lines.length - 1].depth = depth;
        heredoc = null;
      }
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      lines.push({ text: '', depth, raw: false });
      continue;
    }
    const s = scan(trimmed);
    const lineDepth = Math.max(0, depth - s.leadingClosers);
    let text = trimmed;
    let assign: Line['assign'];
    if (s.eq > 0 && /^("[^"]*"|[A-Za-z_][A-Za-z0-9_-]*)\s*$/.test(trimmed.slice(0, s.eq))) {
      const key = trimmed.slice(0, s.eq).trim();
      const value = spaceCommas(trimmed.slice(s.eq + 1).trim());
      assign = { key, value };
      text = `${key} = ${value}`;
    } else if (!trimmed.startsWith('#') && !trimmed.startsWith('//')) {
      text = spaceCommas(trimmed);
    }
    lines.push({ text, depth: lineDepth, raw: false, assign });
    depth = Math.max(0, depth + s.delta);
    if (s.heredoc) heredoc = { marker: s.heredoc.marker };
  }
  // Align "=" across chains of consecutive arguments at the same depth.
  const chains = new Map<number, number[]>();
  const close = (d: number) => {
    const chain = chains.get(d) ?? [];
    if (chain.length > 1) {
      const width = Math.max(...chain.map((i) => lines[i].assign!.key.length));
      for (const i of chain) lines[i].text = `${lines[i].assign!.key.padEnd(width)} = ${lines[i].assign!.value}`;
    }
    chains.delete(d);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.raw) continue;
    if (!l.text) {
      for (const d of [...chains.keys()]) close(d);
      continue;
    }
    // A line at this depth ends any chain nested deeper than it.
    for (const d of [...chains.keys()]) if (d > l.depth) close(d);
    if (!l.assign) {
      close(l.depth);
      continue;
    }
    chains.set(l.depth, [...(chains.get(l.depth) ?? []), i]);
  }
  for (const d of [...chains.keys()]) close(d);
  let out = lines.map((l) => (l.raw ? l.text : l.text ? '  '.repeat(l.depth) + l.text : '')).join('\n');
  out = out.replace(/\n+$/, '') + '\n';
  return out;
}

/** A unified diff of two texts, one hunk covering the changed region. */
export function unifiedDiff(name: string, a: string, b: string): string[] {
  const x = a.replace(/\n$/, '').split('\n');
  const y = b.replace(/\n$/, '').split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length - 1;
  let endY = y.length - 1;
  while (endX >= start && endY >= start && x[endX] === y[endY]) {
    endX--;
    endY--;
  }
  const ctxStart = Math.max(0, start - 3);
  const ctxEndX = Math.min(x.length - 1, endX + 3);
  const ctxEndY = Math.min(y.length - 1, endY + 3);
  const out = [`--- old/${name}`, `+++ new/${name}`, `@@ -${ctxStart + 1},${ctxEndX - ctxStart + 1} +${ctxStart + 1},${ctxEndY - ctxStart + 1} @@`];
  for (let i = ctxStart; i < start; i++) out.push(' ' + x[i]);
  for (let i = start; i <= endX; i++) out.push('-' + x[i]);
  for (let i = start; i <= endY; i++) out.push('+' + y[i]);
  for (let i = endX + 1; i <= ctxEndX; i++) out.push(' ' + x[i]);
  return out;
}
