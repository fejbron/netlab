/**
 * The ustar format, enough for `git archive` to write one and `tar` to read it back.
 * A tar file is a sequence of 512-byte blocks: a header per file, then the file's
 * content padded to a block, then two empty blocks to end. Everything here keeps
 * one character per byte, which is what the simulated filesystem stores.
 */

const BLOCK = 512;

export interface TarEntry {
  name: string;
  content: string;
  /** Octal permission bits, e.g. 0o644. */
  mode: number;
  mtime: number;
  type: 'file' | 'dir';
}

function field(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, '\0');
}

function octalField(n: number, width: number): string {
  // Octal digits, zero-padded, terminated with a NUL, as tar expects.
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(entry: TarEntry): string {
  const name = entry.type === 'dir' && !entry.name.endsWith('/') ? entry.name + '/' : entry.name;
  const size = entry.type === 'dir' ? 0 : byteCount(entry.content);
  let h =
    field(name, 100) +
    octalField(entry.mode & 0o7777, 8) +
    octalField(0, 8) +
    octalField(0, 8) +
    octalField(size, 12) +
    octalField(entry.mtime, 12) +
    '        ' + // checksum is computed with this field as spaces
    (entry.type === 'dir' ? '5' : '0') +
    field('', 100) +
    'ustar\0' +
    '00' +
    field('root', 32) +
    field('root', 32) +
    field('', 8) +
    field('', 8) +
    field('', 155);
  h = h.padEnd(BLOCK, '\0');
  let sum = 0;
  for (let i = 0; i < h.length; i++) sum += h.charCodeAt(i) & 0xff;
  const checksum = sum.toString(8).padStart(6, '0') + '\0 ';
  return h.slice(0, 148) + checksum + h.slice(156);
}

function byteCount(text: string): number {
  // The filesystem holds text; count characters as bytes, which is what is stored.
  return text.length;
}

export function writeTar(entries: TarEntry[]): string {
  let out = '';
  for (const entry of entries) {
    out += header(entry);
    if (entry.type === 'file') {
      out += entry.content;
      const rem = byteCount(entry.content) % BLOCK;
      if (rem) out += '\0'.repeat(BLOCK - rem);
    }
  }
  return out + '\0'.repeat(BLOCK * 2);
}

export class TarError extends Error {}

export function readTar(data: string): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  while (at + BLOCK <= data.length) {
    const h = data.slice(at, at + BLOCK);
    if (/^\0*$/.test(h)) break;
    if (h.slice(257, 262) !== 'ustar') throw new TarError('This does not look like a tar archive');
    const name = h.slice(0, 100).replace(/\0.*$/s, '');
    const mode = parseInt(h.slice(100, 108).replace(/\0.*$/s, '') || '0', 8);
    const size = parseInt(h.slice(124, 136).replace(/\0.*$/s, '') || '0', 8);
    const mtime = parseInt(h.slice(136, 148).replace(/\0.*$/s, '') || '0', 8);
    const type = h[156] === '5' ? 'dir' : 'file';
    at += BLOCK;
    const content = data.slice(at, at + size);
    at += Math.ceil(size / BLOCK) * BLOCK;
    out.push({ name: type === 'dir' ? name.replace(/\/$/, '') : name, content, mode, mtime, type });
  }
  return out;
}
