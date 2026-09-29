/**
 * tar: create, list and extract uncompressed archives. It reads what `git archive`
 * writes, and what it writes itself, in the ustar format both use.
 */
import { readTar, TarError, writeTar, type TarEntry } from '../git/tar';
import { getNode, listDir, makeDir, parentPath, readFile, writeFile, type LinuxState } from './fs';

export interface TarResult {
  out: string[];
  err: string[];
  code: number;
}

function perm(mode: number, dir: boolean): string {
  const bits = ['r', 'w', 'x'];
  let out = dir ? 'd' : '-';
  for (let shift = 6; shift >= 0; shift -= 3) for (let b = 0; b < 3; b++) out += mode & (1 << (shift + 2 - b)) ? bits[b] : '-';
  return out;
}

export function tarCommand(lx: LinuxState, args: string[], resolve: (p: string) => string): TarResult {
  const out: string[] = [];
  const err: string[] = [];
  let mode: 'c' | 'x' | 't' | null = null;
  let file: string | null = null;
  let verbose = false;
  let dir: string | null = null;
  const names: string[] = [];
  // The first argument may be old-style bundled letters with no dash: "cvf".
  const list = [...args];
  if (list[0] && !list[0].startsWith('-') && /^[cxtvfzjJC]+$/.test(list[0])) list[0] = '-' + list[0];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--list') mode = 't';
    else if (a === '--create') mode = 'c';
    else if (a === '--extract' || a === '--get') mode = 'x';
    else if (a === '--verbose') verbose = true;
    else if (a.startsWith('--file=')) file = a.slice(7);
    else if (a === '--file') file = list[++i] ?? null;
    else if (a.startsWith('--directory=')) dir = a.slice(12);
    else if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const c = letters[k];
        if (c === 'c' || c === 'x' || c === 't') mode = c;
        else if (c === 'v') verbose = true;
        else if (c === 'z' || c === 'j' || c === 'J') {
          return { out, err: ["tar: NetLab's tar does not compress; drop -" + c + ' and use a plain .tar'], code: 2 };
        } else if (c === 'f') {
          file = letters.slice(k + 1) || list[++i] || null;
          break;
        } else if (c === 'C') {
          dir = letters.slice(k + 1) || list[++i] || null;
          break;
        } else return { out, err: [`tar: invalid option -- '${c}'`, "Try 'tar --help' for more information."], code: 2 };
      }
    } else names.push(a);
  }
  if (!mode) return { out, err: ["tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options", "Try 'tar --help' for more information."], code: 2 };
  if (!file) return { out, err: [mode === 'c' ? 'tar: Refusing to write archive contents to terminal (missing -f option?)' : 'tar: Refusing to read archive contents from terminal (missing -f option?)', 'tar: Error is not recoverable: exiting now'], code: 2 };
  const archive = resolve(file);

  if (mode === 'c') {
    if (!names.length) return { out, err: ['tar: Cowardly refusing to create an empty archive', "Try 'tar --help' for more information."], code: 2 };
    const base = dir ? resolve(dir) : null;
    const entries: TarEntry[] = [];
    const add = (name: string) => {
      const abs = base ? `${base}/${name}` : resolve(name);
      const node = getNode(lx, abs);
      if (!node) {
        err.push(`tar: ${name}: Cannot stat: No such file or directory`);
        return;
      }
      if (node.type === 'dir') {
        entries.push({ name, content: '', mode: node.mode, mtime: node.mtime, type: 'dir' });
        if (verbose) out.push(`${name}/`);
        for (const child of listDir(lx, abs)) add(`${name.replace(/\/$/, '')}/${child}`);
        return;
      }
      const r = readFile(lx, abs, 'tar');
      if ('error' in r) {
        err.push(`tar: ${name}: Cannot open: Permission denied`);
        return;
      }
      entries.push({ name, content: r.content, mode: node.mode, mtime: node.mtime, type: 'file' });
      if (verbose) out.push(name);
    };
    for (const n of names) add(n.replace(/\/$/, ''));
    const e = writeFile(lx, archive, writeTar(entries), false, 'tar');
    if (e) return { out, err: [`tar: ${file}: Cannot open: ${e.error.replace(/^.*: /, '')}`], code: 2 };
    return { out, err, code: err.length ? 2 : 0 };
  }

  const r = readFile(lx, archive, 'tar');
  if ('error' in r) return { out, err: [`tar: ${file}: Cannot open: No such file or directory`, 'tar: Error is not recoverable: exiting now'], code: 2 };
  let entries: TarEntry[];
  try {
    entries = readTar(r.content);
  } catch (e) {
    if (e instanceof TarError) return { out, err: ['tar: This does not look like a tar archive', 'tar: Exiting with failure status due to previous errors'], code: 2 };
    throw e;
  }
  const wanted = (name: string) => !names.length || names.some((n) => name === n.replace(/\/$/, '') || name.startsWith(n.replace(/\/$/, '') + '/'));

  if (mode === 't') {
    for (const e of entries.filter((x) => wanted(x.name))) {
      const shown = e.type === 'dir' ? `${e.name}/` : e.name;
      out.push(verbose ? `${perm(e.mode, e.type === 'dir')} root/root ${String(e.content.length).padStart(8)} 2026-09-21 09:00 ${shown}` : shown);
    }
    return { out, err, code: 0 };
  }

  const into = dir ? resolve(dir) : resolve('.');
  if (!getNode(lx, into)) return { out, err: [`tar: ${dir}: Cannot open: No such file or directory`], code: 2 };
  for (const e of entries.filter((x) => wanted(x.name))) {
    const target = `${into}/${e.name}`;
    if (e.type === 'dir') {
      if (!getNode(lx, target)) makeDir(lx, target, true);
    } else {
      if (!getNode(lx, parentPath(target))) makeDir(lx, parentPath(target), true);
      const w = writeFile(lx, target, e.content, false, 'tar');
      if (w) {
        err.push(`tar: ${e.name}: Cannot open: ${w.error.replace(/^.*: /, '')}`);
        continue;
      }
      const node = getNode(lx, target);
      if (node) node.mode = e.mode & 0o777;
    }
    if (verbose) out.push(e.type === 'dir' ? `${e.name}/` : e.name);
  }
  return { out, err, code: err.length ? 2 : 0 };
}
