/**
 * Git's object model: blobs, trees, commits and annotated tags, addressed by the
 * SHA-1 of their contents.
 *
 * Objects are stored in the working host's filesystem under .git/objects, two hex
 * digits of the id as a directory and the rest as the file name, so a learner can
 * find one with `find .git/objects -type f` and read it with `git cat-file -p`.
 * Two honest departures from the real thing, both so the files stay readable in a
 * simulator with no zlib and no binary filesystem: the object files are not
 * compressed, and a tree lists its entries in the text form `git cat-file -p`
 * prints rather than packing each id into twenty raw bytes. Ids are therefore
 * stable and content-addressed, but they are not the same ids real git computes
 * for the same file.
 */

export type Oid = string;

export type GitObject =
  | { type: 'blob'; content: string }
  | { type: 'tree'; entries: TreeEntry[] }
  | { type: 'commit'; commit: Commit }
  | { type: 'tag'; tag: AnnotatedTag };

export interface TreeEntry {
  /** '100644' for a file, '100755' for an executable, '040000' for a directory, '120000' for a symlink. */
  mode: string;
  name: string;
  oid: Oid;
}

export interface Person {
  name: string;
  email: string;
  /** Seconds, from the lab clock rather than the wall clock, so ids are reproducible. */
  when: number;
  /** Fixed offset text, e.g. '+0000'. */
  tz: string;
}

export interface Commit {
  tree: Oid;
  parents: Oid[];
  author: Person;
  committer: Person;
  message: string;
}

export interface AnnotatedTag {
  object: Oid;
  type: 'commit' | 'tree' | 'blob' | 'tag';
  tag: string;
  tagger: Person;
  message: string;
}

// ---------------------------------------------------------------------------
// SHA-1

/** SHA-1 of a string, as 40 hex characters. Pure, so object ids are reproducible. */
export function sha1(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  // Pad to a multiple of 64 bytes: a 0x80 byte, zeroes, then the length as 64 bits.
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  for (let i = 7; i >= 0; i--) padded.push(Math.floor(bitLength / 2 ** (8 * i)) & 0xff);

  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array<number>(80);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((padded[chunk + i * 4] << 24) | (padded[chunk + i * 4 + 1] << 16) | (padded[chunk + i * 4 + 2] << 8) | padded[chunk + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function rotl(n: number, by: number): number {
  return ((n << by) | (n >>> (32 - by))) >>> 0;
}

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

/** Byte length, which is what the object header records. */
export function byteLength(text: string): number {
  return utf8Bytes(text).length;
}

// ---------------------------------------------------------------------------
// encoding

export function personText(p: Person): string {
  return `${p.name} <${p.email}> ${p.when} ${p.tz}`;
}

export function parsePerson(text: string): Person {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (!m) return { name: text.trim(), email: '', when: 0, tz: '+0000' };
  return { name: m[1], email: m[2], when: Number(m[3]), tz: m[4] };
}

/** The body of an object, as stored (and as `git cat-file -p` prints it). */
export function objectBody(o: GitObject): string {
  switch (o.type) {
    case 'blob':
      return o.content;
    case 'tree':
      return o.entries.map((e) => `${e.mode} ${entryType(e.mode)} ${e.oid}\t${e.name}`).join('\n') + (o.entries.length ? '\n' : '');
    case 'commit': {
      const c = o.commit;
      const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${personText(c.author)}`, `committer ${personText(c.committer)}`, '', c.message];
      return lines.join('\n');
    }
    case 'tag': {
      const t = o.tag;
      return [`object ${t.object}`, `type ${t.type}`, `tag ${t.tag}`, `tagger ${personText(t.tagger)}`, '', t.message].join('\n');
    }
  }
}

/** The full stored form: "<type> <size>\0<body>", which is what the id hashes. */
export function encodeObject(o: GitObject): string {
  const body = objectBody(o);
  return `${o.type} ${byteLength(body)}\0${body}`;
}

export function objectId(o: GitObject): Oid {
  return sha1(encodeObject(o));
}

export function decodeObject(stored: string): GitObject | null {
  const nul = stored.indexOf('\0');
  if (nul < 0) return null;
  const header = stored.slice(0, nul);
  const body = stored.slice(nul + 1);
  const type = header.split(' ')[0];
  switch (type) {
    case 'blob':
      return { type: 'blob', content: body };
    case 'tree': {
      const entries: TreeEntry[] = [];
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.*)$/.exec(line);
        if (!m) return null;
        entries.push({ mode: m[1], oid: m[3], name: m[4] });
      }
      return { type: 'tree', entries };
    }
    case 'commit': {
      const blank = body.indexOf('\n\n');
      const head = blank < 0 ? body : body.slice(0, blank);
      const message = blank < 0 ? '' : body.slice(blank + 2);
      const commit: Commit = { tree: '', parents: [], author: parsePerson(''), committer: parsePerson(''), message };
      for (const line of head.split('\n')) {
        const at = line.indexOf(' ');
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        if (key === 'tree') commit.tree = value;
        else if (key === 'parent') commit.parents.push(value);
        else if (key === 'author') commit.author = parsePerson(value);
        else if (key === 'committer') commit.committer = parsePerson(value);
      }
      return { type: 'commit', commit };
    }
    case 'tag': {
      const blank = body.indexOf('\n\n');
      const head = blank < 0 ? body : body.slice(0, blank);
      const message = blank < 0 ? '' : body.slice(blank + 2);
      const tag: AnnotatedTag = { object: '', type: 'commit', tag: '', tagger: parsePerson(''), message };
      for (const line of head.split('\n')) {
        const at = line.indexOf(' ');
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        if (key === 'object') tag.object = value;
        else if (key === 'type') tag.type = value as AnnotatedTag['type'];
        else if (key === 'tag') tag.tag = value;
        else if (key === 'tagger') tag.tagger = parsePerson(value);
      }
      return { type: 'tag', tag };
    }
    default:
      return null;
  }
}

/** What a tree entry with this mode points at. */
export function entryType(mode: string): 'tree' | 'blob' | 'commit' {
  return mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
}

/** Trees list their entries in name order, with directories sorted as if they ended in "/". */
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry) => (e.mode === '040000' ? e.name + '/' : e.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
