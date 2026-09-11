/**
 * Linux utilities available to the simulated shell. Each command is a pure function
 * over the host state and returns stdout, stderr and an exit code.
 */
import { curl } from '../curl';
import { ping as netPing, type HostState, type NetworkState } from '../network';
import { prefixLength } from '../ios/net';
import {
  KNOWN_PACKAGES,
  KNOWN_SERVICES,
  baseName,
  canExec,
  canRead,
  canWrite,
  copyNode,
  currentUser,
  daemonCommand,
  findUser,
  getNode,
  groupName,
  homeOf,
  isRoot,
  listDir,
  makeDir,
  modeString,
  moveNode,
  normalizePath,
  octal,
  parentPath,
  readFile,
  removeNode,
  resolveLink,
  userGroups,
  writeFile,
  type FsNode,
  type LinuxState,
} from './fs';
import { fail, ok, type CmdCtx, type CmdResult, type Command } from './shell';
import { loadNginx, makeCertificate, makePrivateKey, nginxPorts, opensslDate, parseCertificate, testNginx } from './web';
import { installAppFiles, installNginxFiles } from './fs';

// ---------------------------------------------------------------------------
// helpers

interface Parsed {
  flags: Set<string>;
  /** Option values for options that take an argument (e.g. -n 5). */
  values: Record<string, string>;
  operands: string[];
}

/** Parse "-abc", "-n 5", "--long" style arguments. `withValue` lists short options that take a value. */
function parseArgs(args: string[], withValue: string[] = [], longWithValue: string[] = []): Parsed {
  const p: Parsed = { flags: new Set(), values: {}, operands: [] };
  let onlyOperands = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (onlyOperands || a === '-' || !a.startsWith('-')) {
      p.operands.push(a);
      continue;
    }
    if (a === '--') {
      onlyOperands = true;
      continue;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (longWithValue.includes(k)) p.values[k] = v ?? args[++i] ?? '';
      else p.flags.add(k);
      continue;
    }
    const letters = a.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const ch = letters[j];
      if (withValue.includes(ch)) {
        const rest = letters.slice(j + 1);
        p.values[ch] = rest !== '' ? rest : (args[++i] ?? '');
        break;
      }
      if (/^\d$/.test(ch) && j === 0 && (withValue.includes('n') || withValue.includes('c'))) {
        // head -5 / tail -20
        p.values.n = letters;
        break;
      }
      p.flags.add(ch);
    }
  }
  return p;
}

function lines(text: string): string[] {
  if (text === '') return [];
  const arr = text.split('\n');
  if (arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/** Read every operand file (or stdin when none) and return the joined text, reporting missing files. */
function readInputs(ctx: CmdCtx, operands: string[], who: string): { text: string; errors: string[]; perFile: Array<{ name: string; text: string }> } {
  const errors: string[] = [];
  const perFile: Array<{ name: string; text: string }> = [];
  if (operands.length === 0 || (operands.length === 1 && operands[0] === '-')) return { text: ctx.stdin, errors, perFile: [{ name: '-', text: ctx.stdin }] };
  for (const op of operands) {
    if (op === '-') {
      perFile.push({ name: '-', text: ctx.stdin });
      continue;
    }
    const r = readFile(ctx.state, ctx.sh.path(op), who, op);
    if ('error' in r) errors.push(r.error);
    else perFile.push({ name: op, text: r.content });
  }
  return { text: perFile.map((f) => f.text).join(''), errors, perFile };
}

function requireRoot(ctx: CmdCtx, msg: string): CmdResult | null {
  return isRoot(ctx.state) ? null : fail([msg]);
}

function fmtSize(n: number, human: boolean): string {
  if (!human) return String(n);
  if (n < 1024) return String(n);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fakeDate(state: LinuxState, offsetSeconds = 0): Date {
  return new Date(Date.UTC(2026, 8, 11, 9, 0, 0) + (state.clock + offsetSeconds) * 1000);
}

function mtimeText(_state: LinuxState, node: FsNode): string {
  const d = new Date(Date.UTC(2026, 8, 11, 8, 30, 0) + node.mtime * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function sizeOf(state: LinuxState, path: string, node: FsNode): number {
  if (node.type === 'dir') return 4096;
  if (node.type === 'link') return (node.target ?? '').length;
  const r = readFile(state, path, 'ls');
  return 'error' in r ? node.content.length : r.content.length;
}

function longLine(state: LinuxState, path: string, name: string, node: FsNode, human: boolean): string {
  const links = node.type === 'dir' ? 2 : 1;
  const target = node.type === 'link' ? ` -> ${node.target}` : '';
  return `${modeString(node)} ${links} ${node.owner.padEnd(8)} ${node.group.padEnd(8)} ${fmtSize(sizeOf(state, path, node), human).padStart(human ? 5 : 6)} ${mtimeText(state, node)} ${name}${target}`;
}

function hostOf(ctx: CmdCtx): HostState {
  return ctx.network.hosts[ctx.hostId];
}

function isSudoer(state: LinuxState, user: string): boolean {
  const u = findUser(state, user);
  return state.sudoers.includes(user) || Boolean(u?.groups.includes('sudo'));
}

// ---------------------------------------------------------------------------
// commands

export const COMMANDS: Record<string, Command> = {
  pwd: { help: 'print name of current/working directory', run: (ctx) => ok([ctx.state.cwd]) },

  ls: {
    help: 'list directory contents',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const st = ctx.state;
      const all = p.flags.has('a') || p.flags.has('A');
      const long = p.flags.has('l');
      const human = p.flags.has('h');
      const dirOnly = p.flags.has('d');
      const targets = p.operands.length ? p.operands : ['.'];
      const out: string[] = [];
      const err: string[] = [];
      const many = targets.length > 1;
      targets.forEach((t, idx) => {
        const path = ctx.sh.path(t);
        const node = getNode(st, path);
        if (!node) {
          err.push(`ls: cannot access '${t}': No such file or directory`);
          return;
        }
        if (node.type !== 'dir' || dirOnly) {
          out.push(long ? longLine(st, path, t, getNode(st, path, false)!, human) : t);
          return;
        }
        if (!canRead(st, node)) {
          err.push(`ls: cannot open directory '${t}': Permission denied`);
          return;
        }
        if (many) out.push(`${idx ? '' : ''}${t}:`);
        let names = listDir(st, path);
        if (!all) names = names.filter((n) => !n.startsWith('.'));
        if (long) {
          out.push(`total ${names.length * 4}`);
          if (p.flags.has('a')) {
            out.push(longLine(st, path, '.', node, human));
            out.push(longLine(st, parentPath(path), '..', getNode(st, parentPath(path)) ?? node, human));
          }
          for (const n of names) out.push(longLine(st, normalizePath(path, n), n, st.fs[normalizePath(path, n)], human));
        } else if (names.length) {
          const decorated = p.flags.has('F') ? names.map((n) => (st.fs[normalizePath(path, n)]?.type === 'dir' ? n + '/' : n)) : names;
          out.push(decorated.join('  '));
        }
        if (many && idx < targets.length - 1) out.push('');
      });
      return { out, err, code: err.length ? 2 : 0 };
    },
  },

  cat: {
    help: 'concatenate files and print on the standard output',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const { text, errors } = readInputs(ctx, p.operands, 'cat');
      let out = lines(text);
      if (p.flags.has('n')) out = out.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`);
      return { out, err: errors, code: errors.length ? 1 : 0 };
    },
  },
  less: { help: 'view file contents', run: (ctx) => COMMANDS.cat.run(ctx) },
  more: { help: 'view file contents', run: (ctx) => COMMANDS.cat.run(ctx) },

  echo: {
    help: 'display a line of text',
    run: (ctx) => {
      let args = ctx.args;
      let newline = true;
      let escapes = false;
      while (args[0] && /^-[neE]+$/.test(args[0])) {
        if (args[0].includes('n')) newline = false;
        if (args[0].includes('e')) escapes = true;
        args = args.slice(1);
      }
      let text = args.join(' ');
      if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      void newline;
      return ok(text === '' ? [''] : text.split('\n'));
    },
  },

  printf: {
    help: 'format and print data',
    run: (ctx) => {
      const [fmt, ...rest] = ctx.args;
      if (fmt === undefined) return fail(['printf: usage: printf [-v var] format [arguments]'], 2);
      let i = 0;
      const format = fmt.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      const once = () =>
        format.replace(/%(-?)(\d*)(?:\.(\d+))?([sdif%])/g, (_m, minus, width, prec, kind) => {
          if (kind === '%') return '%';
          let v: string = rest[i++] ?? '';
          if (kind === 'd' || kind === 'i') v = String(Math.trunc(Number(v) || 0));
          if (kind === 'f') v = (Number(v) || 0).toFixed(prec ? Number(prec) : 6);
          if (kind === 's' && prec) v = v.slice(0, Number(prec));
          const w = Number(width) || 0;
          return minus ? v.padEnd(w) : v.padStart(w);
        });
      let text = once();
      while (i < rest.length && /%[-\d.]*[sdif]/.test(format)) text += once();
      return ok(text.replace(/\n$/, '').split('\n'));
    },
  },

  mkdir: {
    help: 'make directories',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      if (!p.operands.length) return fail(['mkdir: missing operand'], 1);
      const err: string[] = [];
      for (const op of p.operands) {
        const e = makeDir(ctx.state, ctx.sh.path(op), p.flags.has('p'));
        if (e) err.push(e.error);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  rmdir: {
    help: 'remove empty directories',
    run: (ctx) => {
      const err: string[] = [];
      for (const op of ctx.args) {
        const path = ctx.sh.path(op);
        const node = getNode(ctx.state, path);
        if (!node) err.push(`rmdir: failed to remove '${op}': No such file or directory`);
        else if (node.type !== 'dir') err.push(`rmdir: failed to remove '${op}': Not a directory`);
        else if (listDir(ctx.state, path).length) err.push(`rmdir: failed to remove '${op}': Directory not empty`);
        else {
          const e = removeNode(ctx.state, path, true, 'rmdir');
          if (e) err.push(e.error);
        }
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  touch: {
    help: 'change file timestamps, creating empty files',
    run: (ctx) => {
      const err: string[] = [];
      for (const op of parseArgs(ctx.args).operands) {
        const path = ctx.sh.path(op);
        const node = getNode(ctx.state, path);
        if (node) {
          ctx.state.clock += 7;
          node.mtime = ctx.state.clock;
          continue;
        }
        const e = writeFile(ctx.state, path, '', false, 'touch');
        if (e) err.push(e.error.replace(/^touch: (.*): (.*)$/, "touch: cannot touch '$1': $2"));
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  cp: {
    help: 'copy files and directories',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      if (p.operands.length < 2) return fail([p.operands.length ? `cp: missing destination file operand after '${p.operands[0]}'` : 'cp: missing file operand'], 1);
      const dest = ctx.sh.path(p.operands[p.operands.length - 1]);
      const err: string[] = [];
      for (const src of p.operands.slice(0, -1)) {
        const e = copyNode(ctx.state, ctx.sh.path(src), dest, p.flags.has('r') || p.flags.has('R') || p.flags.has('a'));
        if (e) err.push(e.error);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  mv: {
    help: 'move (rename) files',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      if (p.operands.length < 2) return fail([p.operands.length ? `mv: missing destination file operand after '${p.operands[0]}'` : 'mv: missing file operand'], 1);
      const dest = ctx.sh.path(p.operands[p.operands.length - 1]);
      const err: string[] = [];
      for (const src of p.operands.slice(0, -1)) {
        const e = moveNode(ctx.state, ctx.sh.path(src), dest);
        if (e) err.push(e.error);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  rm: {
    help: 'remove files or directories',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      if (!p.operands.length) return fail(['rm: missing operand'], 1);
      const err: string[] = [];
      for (const op of p.operands) {
        const path = ctx.sh.path(op);
        if (path === '/' ) {
          err.push("rm: it is dangerous to operate recursively on '/'", 'rm: use --no-preserve-root to override this failsafe');
          continue;
        }
        const e = removeNode(ctx.state, path, p.flags.has('r') || p.flags.has('R'));
        if (e && !(p.flags.has('f') && /No such file/.test(e.error))) err.push(e.error);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  ln: {
    help: 'make links between files',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      if (p.operands.length < 2) return fail(['ln: missing file operand'], 1);
      const [target, linkName] = p.operands;
      const st = ctx.state;
      let path = ctx.sh.path(linkName);
      if (getNode(st, path)?.type === 'dir') path = normalizePath(path, baseName(target));
      if (st.fs[path]) return fail([`ln: failed to create symbolic link '${linkName}': File exists`]);
      const parent = getNode(st, parentPath(path));
      if (!parent || !canWrite(st, parent)) return fail([`ln: failed to create symbolic link '${linkName}': Permission denied`]);
      if (p.flags.has('s')) st.fs[path] = { type: 'link', content: '', target, owner: st.user, group: groupName(st, currentUser(st).gid), mode: 0o777, mtime: ++st.clock };
      else {
        const src = st.fs[ctx.sh.path(target)];
        if (!src) return fail([`ln: failed to access '${target}': No such file or directory`]);
        st.fs[path] = { ...src, mtime: ++st.clock };
      }
      return ok();
    },
  },

  readlink: {
    help: 'print resolved symbolic links',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const path = ctx.sh.path(p.operands[0] ?? '');
      const node = getNode(ctx.state, path, false);
      if (p.flags.has('f')) return ok([resolveLink(ctx.state, path)]);
      return node?.type === 'link' ? ok([node.target ?? '']) : ok([], 1);
    },
  },

  chmod: {
    help: 'change file mode bits',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const [mode, ...files] = p.operands;
      if (!mode || !files.length) return fail(['chmod: missing operand'], 1);
      const err: string[] = [];
      const apply = (path: string, node: FsNode) => {
        if (!isRoot(ctx.state) && node.owner !== ctx.state.user) {
          err.push(`chmod: changing permissions of '${path}': Operation not permitted`);
          return;
        }
        if (/^[0-7]{3,4}$/.test(mode)) {
          node.mode = parseInt(mode.slice(-3), 8);
          return;
        }
        const m = mode.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
        if (!m) {
          err.push(`chmod: invalid mode: ‘${mode}’`);
          return;
        }
        const who = m[1] || 'a';
        let bits = 0;
        if (m[3].includes('r')) bits |= 4;
        if (m[3].includes('w')) bits |= 2;
        if (m[3].includes('x') || (m[3].includes('X') && node.type === 'dir')) bits |= 1;
        let mask = 0;
        if (who.includes('u') || who.includes('a')) mask |= bits << 6;
        if (who.includes('g') || who.includes('a')) mask |= bits << 3;
        if (who.includes('o') || who.includes('a')) mask |= bits;
        let clear = 0;
        if (who.includes('u') || who.includes('a')) clear |= 0o700;
        if (who.includes('g') || who.includes('a')) clear |= 0o070;
        if (who.includes('o') || who.includes('a')) clear |= 0o007;
        if (m[2] === '+') node.mode |= mask;
        else if (m[2] === '-') node.mode &= ~mask;
        else node.mode = (node.mode & ~clear) | mask;
      };
      for (const f of files) {
        const path = ctx.sh.path(f);
        const node = getNode(ctx.state, path);
        if (!node) {
          err.push(`chmod: cannot access '${f}': No such file or directory`);
          continue;
        }
        apply(f, node);
        if (p.flags.has('R') && node.type === 'dir') for (const key of Object.keys(ctx.state.fs)) if (key.startsWith(path + '/')) apply(key, ctx.state.fs[key]);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  chown: {
    help: 'change file owner and group',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const [spec, ...files] = p.operands;
      if (!spec || !files.length) return fail(['chown: missing operand'], 1);
      const denied = requireRoot(ctx, `chown: changing ownership of '${files[0]}': Operation not permitted`);
      if (denied) return denied;
      const [owner, group] = spec.split(':');
      if (owner && !findUser(ctx.state, owner)) return fail([`chown: invalid user: ‘${spec}’`]);
      if (group && !ctx.state.groups.some((g) => g.name === group)) return fail([`chown: invalid group: ‘${spec}’`]);
      const err: string[] = [];
      for (const f of files) {
        const path = ctx.sh.path(f);
        const node = getNode(ctx.state, path);
        if (!node) {
          err.push(`chown: cannot access '${f}': No such file or directory`);
          continue;
        }
        const apply = (n: FsNode) => {
          if (owner) n.owner = owner;
          if (group) n.group = group;
          else if (owner && spec.endsWith(':')) n.group = groupName(ctx.state, findUser(ctx.state, owner)!.gid);
        };
        apply(node);
        if (p.flags.has('R') && node.type === 'dir') for (const key of Object.keys(ctx.state.fs)) if (key.startsWith(path + '/')) apply(ctx.state.fs[key]);
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },

  chgrp: {
    help: 'change group ownership',
    run: (ctx) => {
      const [group, ...files] = parseArgs(ctx.args).operands;
      if (!group || !files.length) return fail(['chgrp: missing operand'], 1);
      return COMMANDS.chown.run({ ...ctx, args: [`:${group}`, ...files] });
    },
  },

  stat: {
    help: 'display file status',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['c'], ['format']);
      const out: string[] = [];
      const err: string[] = [];
      for (const f of p.operands) {
        const path = ctx.sh.path(f);
        const node = getNode(ctx.state, path, false);
        if (!node) {
          err.push(`stat: cannot statx '${f}': No such file or directory`);
          continue;
        }
        const fmt = p.values.c ?? p.values.format;
        if (fmt) {
          out.push(fmt.replace(/%([aAUGnsF])/g, (_m, k) => ({ a: octal(node.mode), A: modeString(node), U: node.owner, G: node.group, n: f, s: String(sizeOf(ctx.state, path, node)), F: node.type === 'dir' ? 'directory' : node.type === 'link' ? 'symbolic link' : 'regular file' })[k as string] ?? ''));
          continue;
        }
        out.push(`  File: ${f}${node.type === 'link' ? ` -> ${node.target}` : ''}`, `  Size: ${String(sizeOf(ctx.state, path, node)).padEnd(10)}\tBlocks: 8          IO Block: 4096   ${node.type === 'dir' ? 'directory' : node.type === 'link' ? 'symbolic link' : 'regular file'}`, `Access: (${octal(node.mode)}/${modeString(node)})  Uid: (${String(findUser(ctx.state, node.owner)?.uid ?? 0).padStart(5)}/${node.owner.padEnd(8)})   Gid: (${String(ctx.state.groups.find((g) => g.name === node.group)?.gid ?? 0).padStart(5)}/${node.group.padEnd(8)})`, `Modify: 2026-09-11 ${mtimeText(ctx.state, node).slice(7)}:00.000000000 +0000`);
      }
      return { out, err, code: err.length ? 1 : 0 };
    },
  },

  head: {
    help: 'output the first part of files',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['n', 'c']);
      const n = p.values.n !== undefined ? Number(p.values.n) : 10;
      const { perFile, errors } = readInputs(ctx, p.operands, 'head');
      const out: string[] = [];
      perFile.forEach((f, i) => {
        if (perFile.length > 1) out.push(`${i ? '\n' : ''}==> ${f.name} <==`);
        out.push(...lines(f.text).slice(0, n));
      });
      return { out, err: errors, code: errors.length ? 1 : 0 };
    },
  },

  tail: {
    help: 'output the last part of files',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['n', 'c']);
      const n = p.values.n !== undefined ? Number(String(p.values.n).replace(/^\+/, '')) : 10;
      const { perFile, errors } = readInputs(ctx, p.operands, 'tail');
      const out: string[] = [];
      perFile.forEach((f, i) => {
        if (perFile.length > 1) out.push(`${i ? '\n' : ''}==> ${f.name} <==`);
        out.push(...lines(f.text).slice(-n));
      });
      if (p.flags.has('f')) out.push('(tail -f would keep following the file; this simulator returns to the prompt)');
      return { out, err: errors, code: errors.length ? 1 : 0 };
    },
  },

  wc: {
    help: 'print newline, word, and byte counts for each file',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const { perFile, errors } = readInputs(ctx, p.operands, 'wc');
      const only = p.flags.has('l') ? 'l' : p.flags.has('w') ? 'w' : p.flags.has('c') || p.flags.has('m') ? 'c' : null;
      const out: string[] = [];
      let tl = 0,
        tw = 0,
        tc = 0;
      for (const f of perFile) {
        const l = (f.text.match(/\n/g) ?? []).length;
        const w = f.text.split(/\s+/).filter(Boolean).length;
        const c = f.text.length;
        tl += l;
        tw += w;
        tc += c;
        const name = f.name === '-' && perFile.length === 1 && !p.operands.length ? '' : ` ${f.name}`;
        out.push(only ? `${{ l, w, c }[only]}${name}` : `${String(l).padStart(7)}${String(w).padStart(8)}${String(c).padStart(8)}${name}`);
      }
      if (perFile.length > 1) out.push(only ? `${{ l: tl, w: tw, c: tc }[only]} total` : `${String(tl).padStart(7)}${String(tw).padStart(8)}${String(tc).padStart(8)} total`);
      return { out, err: errors, code: errors.length ? 1 : 0 };
    },
  },

  grep: {
    help: 'print lines that match patterns',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['e', 'm', 'A', 'B', 'C']);
      const pattern = p.values.e ?? p.operands.shift();
      if (pattern === undefined) return fail(['Usage: grep [OPTION]... PATTERNS [FILE]...', "Try 'grep --help' for more information."], 2);
      let re: RegExp;
      try {
        const src = p.flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p.flags.has('E') || p.flags.has('P') ? pattern : pattern.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+').replace(/\\\?/g, '?').replace(/\\\{/g, '{').replace(/\\\}/g, '}');
        re = new RegExp(p.flags.has('w') ? `\\b(?:${src})\\b` : src, p.flags.has('i') ? 'i' : '');
      } catch {
        return fail([`grep: Invalid regular expression`], 2);
      }
      let operands = p.operands;
      if (p.flags.has('r') || p.flags.has('R')) {
        const roots = operands.length ? operands : ['.'];
        operands = [];
        for (const r of roots) {
          const base = ctx.sh.path(r);
          const node = getNode(ctx.state, base);
          if (node?.type === 'dir') for (const key of Object.keys(ctx.state.fs).sort()) if (key.startsWith(base + '/') && ctx.state.fs[key].type === 'file') operands.push(r === '.' ? key.slice(base.length + 1) : r.replace(/\/$/, '') + key.slice(base.length));
          else operands.push(r);
        }
      }
      const { perFile, errors } = readInputs(ctx, operands, 'grep');
      const out: string[] = [];
      let any = false;
      const showName = perFile.length > 1 || p.flags.has('H');
      for (const f of perFile) {
        const all = lines(f.text);
        const hits = all.map((l, i) => ({ l, i })).filter(({ l }) => re.test(l) !== p.flags.has('v'));
        if (hits.length) any = true;
        if (p.flags.has('c')) {
          out.push(showName ? `${f.name}:${hits.length}` : String(hits.length));
          continue;
        }
        if (p.flags.has('l')) {
          if (hits.length) out.push(f.name);
          continue;
        }
        if (p.flags.has('L')) {
          if (!hits.length) out.push(f.name);
          continue;
        }
        for (const h of hits) {
          const prefix = `${showName ? f.name + ':' : ''}${p.flags.has('n') ? h.i + 1 + ':' : ''}`;
          out.push(prefix + (p.flags.has('o') ? (h.l.match(re)?.[0] ?? '') : h.l));
        }
      }
      return { out, err: p.flags.has('s') ? [] : errors, code: errors.length && !any ? 2 : any ? 0 : 1 };
    },
  },
  egrep: { help: 'grep -E', run: (ctx) => COMMANDS.grep.run({ ...ctx, args: ['-E', ...ctx.args] }) },
  fgrep: { help: 'grep -F', run: (ctx) => COMMANDS.grep.run({ ...ctx, args: ['-F', ...ctx.args] }) },

  sed: {
    help: 'stream editor for filtering and transforming text',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['e']);
      const script = p.values.e ?? p.operands.shift();
      if (script === undefined) return fail(['Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...'], 1);
      const { perFile, errors } = readInputs(ctx, p.operands, 'sed');
      const quiet = p.flags.has('n');
      const ops = splitSedScript(script);
      const transform = (input: string[]): string[] | string => {
        let out: string[] = [];
        const printed: string[] = [];
        let work = [...input];
        for (const op of ops) {
          const sub = op.match(/^(?:(\d+|\$|\/[^/]*\/))?s(.)(.*?)\2(.*?)\2([gIi]*)$/);
          if (sub) {
            const [, addr, , pat, rep, flags] = sub;
            let re: RegExp;
            try {
              re = new RegExp(pat.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+'), (flags.includes('g') ? 'g' : '') + (/[Ii]/.test(flags) ? 'i' : ''));
            } catch {
              return `sed: -e expression #1, char ${op.length}: Invalid regular expression`;
            }
            const replacement = rep.replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&');
            work = work.map((l, i) => (addrMatches(addr, i, work.length, l) ? l.replace(re, replacement) : l));
            continue;
          }
          const del = op.match(/^(\d+|\$|\/[^/]*\/|\d+,\d+)d$/);
          if (del) {
            work = work.filter((l, i) => !addrMatches(del[1], i, work.length, l));
            continue;
          }
          const pr = op.match(/^(\d+|\$|\/[^/]*\/|\d+,\d+)p$/);
          if (pr) {
            work.forEach((l, i) => {
              if (addrMatches(pr[1], i, work.length, l)) printed.push(l);
            });
            continue;
          }
          const ins = op.match(/^(\d+|\$)?([ia])\\?(.*)$/);
          if (ins && !/^s/.test(op)) {
            const [, addr, kind, text] = ins;
            const next: string[] = [];
            work.forEach((l, i) => {
              const hit = addr ? addrMatches(addr, i, work.length, l) : true;
              if (hit && kind === 'i') next.push(text);
              next.push(l);
              if (hit && kind === 'a') next.push(text);
            });
            work = next;
            continue;
          }
          return `sed: -e expression #1, char ${op.length}: unknown command: \`${op[0]}'`;
        }
        out = quiet ? printed : [...work, ...printed];
        return out;
      };
      const out: string[] = [];
      for (const f of perFile) {
        const r = transform(lines(f.text));
        if (typeof r === 'string') return fail([r]);
        if (p.flags.has('i') && f.name !== '-') {
          const e = writeFile(ctx.state, ctx.sh.path(f.name), r.length ? r.join('\n') + '\n' : '', false, 'sed');
          if (e) errors.push(e.error);
        } else out.push(...r);
      }
      return { out, err: errors, code: errors.length ? 2 : 0 };
    },
  },

  awk: {
    help: 'pattern scanning and processing language (subset)',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['F', 'v']);
      const program = p.operands.shift();
      if (program === undefined) return fail(['usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]'], 2);
      const fs = p.values.F ?? null;
      const vars: Record<string, string | number> = {};
      if (p.values.v) {
        const [k, v] = p.values.v.split('=');
        vars[k] = v;
      }
      const { text, errors } = readInputs(ctx, p.operands, 'awk');
      // split program into rules: [pattern] { action }, BEGIN { }, END { }
      const rules: Array<{ pattern: string | null; action: string }> = [];
      const ruleRe = /(BEGIN|END|\/(?:[^/\\]|\\.)*\/|[^{}]+?)?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(program)) !== null) rules.push({ pattern: m[1]?.trim() || null, action: m[2].trim() });
      if (!rules.length) rules.push({ pattern: program.trim(), action: 'print' });
      const out: string[] = [];
      const evalExpr = (expr: string, fields: string[], nr: number): string | number => {
        const e = expr.trim();
        if (e === '') return '';
        const str = e.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (str) return str[1].replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\"/g, '"');
        if (/^\$\d+$/.test(e)) {
          const n = Number(e.slice(1));
          return n === 0 ? fields.join(' ') : (fields[n - 1] ?? '');
        }
        const fieldExpr = e.match(/^\$\((.+)\)$/) ?? e.match(/^\$(NF(?:\s*-\s*\d+)?)$/);
        if (fieldExpr) {
          const n = Number(evalExpr(fieldExpr[1], fields, nr));
          return n === 0 ? fields.join(' ') : (fields[n - 1] ?? '');
        }
        if (e === 'NR') return nr;
        if (e === 'NF') return fields.length;
        if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
        if (/^[A-Za-z_]\w*$/.test(e)) return vars[e] ?? '';
        const bin = e.match(/^(.+?)\s*([+\-*/%])\s*(.+)$/);
        if (bin && !/^"/.test(e)) {
          const a = Number(evalExpr(bin[1], fields, nr)) || 0;
          const b = Number(evalExpr(bin[3], fields, nr)) || 0;
          return { '+': a + b, '-': a - b, '*': a * b, '/': b ? a / b : 0, '%': b ? a % b : 0 }[bin[2]]!;
        }
        return e;
      };
      const matches = (pattern: string | null, fields: string[], line: string, nr: number): boolean => {
        if (pattern === null) return true;
        const re = pattern.match(/^\/(.*)\/$/);
        if (re) return new RegExp(re[1]).test(line);
        const cmp = pattern.match(/^(.+?)\s*(==|!=|>=|<=|>|<|~|!~)\s*(.+)$/);
        if (cmp) {
          const a = evalExpr(cmp[1], fields, nr);
          const b = evalExpr(cmp[3], fields, nr);
          if (cmp[2] === '~' || cmp[2] === '!~') {
            const hit = new RegExp(String(b).replace(/^\/|\/$/g, '')).test(String(a));
            return cmp[2] === '~' ? hit : !hit;
          }
          const na = Number(a),
            nb = Number(b);
          const numeric = !Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '';
          const [x, y] = numeric ? [na, nb] : [String(a), String(b)];
          return { '==': x === y, '!=': x !== y, '>=': x >= y, '<=': x <= y, '>': x > y, '<': x < y }[cmp[2]]!;
        }
        return Boolean(evalExpr(pattern, fields, nr));
      };
      const run = (action: string, fields: string[], nr: number) => {
        for (const stmt of action.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean)) {
          const pr = stmt.match(/^print(?:f)?\s*(.*)$/);
          if (pr) {
            if (pr[1].trim() === '') {
              out.push(fields.join(' '));
              continue;
            }
            const args = pr[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => evalExpr(a, fields, nr));
            out.push(args.map((a) => (typeof a === 'number' && !Number.isInteger(a) ? a.toFixed(2).replace(/\.?0+$/, '') : String(a))).join(vars.OFS !== undefined ? String(vars.OFS) : ' '));
            continue;
          }
          const inc = stmt.match(/^([A-Za-z_]\w*)\s*(\+=|-=|=|\+\+)\s*(.*)$/);
          if (inc) {
            const cur = Number(vars[inc[1]] ?? 0);
            if (inc[2] === '++') vars[inc[1]] = cur + 1;
            else if (inc[2] === '+=') vars[inc[1]] = cur + Number(evalExpr(inc[3], fields, nr));
            else if (inc[2] === '-=') vars[inc[1]] = cur - Number(evalExpr(inc[3], fields, nr));
            else vars[inc[1]] = evalExpr(inc[3], fields, nr);
            continue;
          }
          const pp = stmt.match(/^([A-Za-z_]\w*)\+\+$/);
          if (pp) vars[pp[1]] = Number(vars[pp[1]] ?? 0) + 1;
        }
      };
      for (const r of rules.filter((x) => x.pattern === 'BEGIN')) run(r.action, [], 0);
      const body = rules.filter((x) => x.pattern !== 'BEGIN' && x.pattern !== 'END');
      lines(text).forEach((line, i) => {
        const fields = fs === null ? line.trim().split(/\s+/).filter((f, _idx, arr) => !(f === '' && arr.length === 1)) : line.split(fs.length === 1 ? fs : new RegExp(fs));
        for (const r of body) if (matches(r.pattern, fields, line, i + 1)) run(r.action, fields, i + 1);
      });
      const total = lines(text).length;
      for (const r of rules.filter((x) => x.pattern === 'END')) run(r.action, [], total);
      return { out, err: errors, code: errors.length ? 2 : 0 };
    },
  },

  cut: {
    help: 'remove sections from each line of files',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['d', 'f', 'c']);
      const { text, errors } = readInputs(ctx, p.operands, 'cut');
      const ranges = (spec: string, max: number) => {
        const set = new Set<number>();
        for (const part of spec.split(',')) {
          const [a, b] = part.split('-');
          const start = a === '' ? 1 : Number(a);
          const end = b === undefined ? start : b === '' ? max : Number(b);
          for (let i = start; i <= end; i++) set.add(i);
        }
        return set;
      };
      const out = lines(text).map((l) => {
        if (p.values.c) {
          const idx = ranges(p.values.c, l.length);
          return [...l].filter((_c, i) => idx.has(i + 1)).join('');
        }
        const d = p.values.d ?? '\t';
        if (!l.includes(d)) return p.flags.has('s') ? null : l;
        const fields = l.split(d);
        const idx = ranges(p.values.f ?? '1', fields.length);
        return fields.filter((_f, i) => idx.has(i + 1)).join(d);
      });
      return { out: out.filter((x): x is string => x !== null), err: errors, code: errors.length ? 1 : 0 };
    },
  },

  sort: {
    help: 'sort lines of text files',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['k', 't']);
      const { text, errors } = readInputs(ctx, p.operands, 'sort');
      let arr = lines(text);
      const key = p.values.k ? Number(p.values.k.split(',')[0]) : null;
      const sep = p.values.t;
      const field = (l: string) => (key ? (sep ? l.split(sep) : l.trim().split(/\s+/))[key - 1] ?? '' : l);
      arr.sort((a, b) => {
        const x = field(a),
          y = field(b);
        if (p.flags.has('n') || p.flags.has('h')) return (parseFloat(x) || 0) - (parseFloat(y) || 0) || x.localeCompare(y);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      if (p.flags.has('r')) arr.reverse();
      if (p.flags.has('u')) arr = arr.filter((l, i) => i === 0 || l !== arr[i - 1]);
      return { out: arr, err: errors, code: errors.length ? 2 : 0 };
    },
  },

  uniq: {
    help: 'report or omit repeated lines',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const { text, errors } = readInputs(ctx, p.operands, 'uniq');
      const groups: Array<{ line: string; count: number }> = [];
      for (const l of lines(text)) {
        const last = groups[groups.length - 1];
        if (last && last.line === l) last.count++;
        else groups.push({ line: l, count: 1 });
      }
      let g = groups;
      if (p.flags.has('d')) g = g.filter((x) => x.count > 1);
      if (p.flags.has('u')) g = g.filter((x) => x.count === 1);
      return { out: g.map((x) => (p.flags.has('c') ? `${String(x.count).padStart(7)} ${x.line}` : x.line)), err: errors, code: errors.length ? 1 : 0 };
    },
  },

  tr: {
    help: 'translate or delete characters',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const expand = (s: string) => {
        const classes: Record<string, string> = { '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[:lower:]': 'abcdefghijklmnopqrstuvwxyz', '[:digit:]': '0123456789', '[:space:]': ' \t\n', '[:punct:]': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', '[:alpha:]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' };
        let out = s;
        for (const [k, v] of Object.entries(classes)) out = out.split(k).join(v);
        out = out.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return out.replace(/(.)-(.)/g, (_m, a, b) => {
          let r = '';
          for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c);
          return r;
        });
      };
      const [set1, set2] = p.operands.map(expand);
      if (set1 === undefined) return fail(['tr: missing operand'], 1);
      let text = ctx.stdin;
      if (p.flags.has('d')) text = [...text].filter((c) => !set1.includes(c)).join('');
      else if (p.flags.has('s')) text = text.replace(new RegExp(`([${set1.replace(/[\]\\^-]/g, '\\$&')}])\\1+`, 'g'), '$1');
      else if (set2 !== undefined) text = [...text].map((c) => (set1.includes(c) ? set2[Math.min(set1.indexOf(c), set2.length - 1)] : c)).join('');
      return ok(lines(text));
    },
  },

  tee: {
    help: 'read from standard input and write to standard output and files',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const err: string[] = [];
      for (const f of p.operands) {
        const e = writeFile(ctx.state, ctx.sh.path(f), ctx.stdin, p.flags.has('a'), 'tee');
        if (e) err.push(e.error);
      }
      return { out: lines(ctx.stdin), err, code: err.length ? 1 : 0 };
    },
  },

  xargs: {
    help: 'build and execute command lines from standard input',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['I', 'n']);
      const items = ctx.stdin.split(/\s+/).filter(Boolean);
      const cmd = p.operands.length ? p.operands : ['echo'];
      if (p.values.I) {
        const results = lines(ctx.stdin).map((line) => ctx.sh.runSource(cmd.map((c) => c.split(p.values.I).join(line)).map(quoteArg).join(' '), []));
        return { out: results.flatMap((r) => r.out), err: results.flatMap((r) => r.err), code: results.some((r) => r.code) ? 123 : 0 };
      }
      return ctx.sh.runSource([...cmd, ...items].map(quoteArg).join(' '), []);
    },
  },

  find: {
    help: 'search for files in a directory hierarchy',
    run: (ctx) => {
      const args = [...ctx.args];
      const roots: string[] = [];
      while (args.length && !args[0].startsWith('-')) roots.push(args.shift()!);
      if (!roots.length) roots.push('.');
      let name: RegExp | null = null;
      let type: string | null = null;
      let user: string | null = null;
      let perm: string | null = null;
      let empty = false;
      let del = false;
      let maxDepth = Infinity;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-name' || a === '-iname') name = new RegExp('^' + args[++i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', a === '-iname' ? 'i' : '');
        else if (a === '-type') type = args[++i];
        else if (a === '-user') user = args[++i];
        else if (a === '-perm') perm = args[++i];
        else if (a === '-empty') empty = true;
        else if (a === '-delete') del = true;
        else if (a === '-maxdepth') maxDepth = Number(args[++i]);
        else if (a === '-mindepth' || a === '-newer' || a === '-mtime' || a === '-size') i++;
        else if (a === '-print' || a === '-ls') continue;
        else return fail([`find: unknown predicate \`${a}'`], 1);
      }
      const out: string[] = [];
      const err: string[] = [];
      for (const root of roots) {
        const base = ctx.sh.path(root);
        const rootNode = getNode(ctx.state, base);
        if (!rootNode) {
          err.push(`find: ‘${root}’: No such file or directory`);
          continue;
        }
        const keys = Object.keys(ctx.state.fs)
          .filter((k) => k === base || k.startsWith(base === '/' ? '/' : base + '/'))
          .sort();
        for (const key of keys) {
          const node = ctx.state.fs[key];
          const rel = key === base ? root : base === '/' ? key : (root === '.' ? '.' : root.replace(/\/$/, '')) + key.slice(base.length);
          const depth = key === base ? 0 : key.slice(base.length).split('/').length - 1;
          if (depth > maxDepth) continue;
          if (name && !name.test(baseName(key))) continue;
          if (type && !((type === 'f' && node.type === 'file') || (type === 'd' && node.type === 'dir') || (type === 'l' && node.type === 'link'))) continue;
          if (user && node.owner !== user) continue;
          if (perm && !(perm.startsWith('-') ? (node.mode & parseInt(perm.slice(1), 8)) === parseInt(perm.slice(1), 8) : perm.startsWith('/') ? (node.mode & parseInt(perm.slice(1), 8)) !== 0 : (node.mode & 0o777) === parseInt(perm, 8))) continue;
          if (empty && !(node.type === 'file' ? node.content === '' : listDir(ctx.state, key).length === 0)) continue;
          if (del) {
            removeNode(ctx.state, key, true, 'find');
            continue;
          }
          out.push(rel);
        }
      }
      return { out, err, code: err.length ? 1 : 0 };
    },
  },

  which: {
    help: 'locate a command',
    run: (ctx) => {
      const out: string[] = [];
      let missing = 0;
      for (const a of ctx.args) {
        if (COMMANDS[a] || ['bash', 'sh', 'sudo'].includes(a)) out.push(`/usr/bin/${a}`);
        else missing++;
      }
      return ok(out, missing ? 1 : 0);
    },
  },

  whoami: { help: 'print effective user name', run: (ctx) => ok([ctx.state.user]) },
  id: {
    help: 'print real and effective user and group IDs',
    run: (ctx) => {
      const name = ctx.args.find((a) => !a.startsWith('-')) ?? ctx.state.user;
      const u = findUser(ctx.state, name);
      if (!u) return fail([`id: ‘${name}’: no such user`]);
      const groups = userGroups(ctx.state, u);
      const gid = (g: string) => ctx.state.groups.find((x) => x.name === g)?.gid ?? 0;
      if (ctx.args.includes('-u')) return ok([String(u.uid)]);
      if (ctx.args.includes('-un')) return ok([u.name]);
      if (ctx.args.includes('-Gn') || ctx.args.includes('-nG')) return ok([groups.join(' ')]);
      return ok([`uid=${u.uid}(${u.name}) gid=${u.gid}(${groupName(ctx.state, u.gid)}) groups=${groups.map((g) => `${gid(g)}(${g})`).join(',')}`]);
    },
  },
  groups: {
    help: 'print the groups a user is in',
    run: (ctx) => {
      const name = ctx.args[0] ?? ctx.state.user;
      const u = findUser(ctx.state, name);
      if (!u) return fail([`groups: ‘${name}’: no such user`]);
      return ok([`${ctx.args[0] ? name + ' : ' : ''}${userGroups(ctx.state, u).join(' ')}`]);
    },
  },
  hostname: {
    help: 'show or set the system host name',
    run: (ctx) => {
      if (ctx.args[0] && !ctx.args[0].startsWith('-')) {
        const d = requireRoot(ctx, 'hostname: you must be root to change the host name');
        if (d) return d;
        ctx.state.hostname = ctx.args[0];
        ctx.state.env.HOSTNAME = ctx.args[0];
        return ok();
      }
      if (ctx.args.includes('-I') || ctx.args.includes('-i')) return ok([hostOf(ctx).ip ?? '']);
      return ok([ctx.state.hostname]);
    },
  },
  hostnamectl: {
    help: 'control the system hostname',
    run: (ctx) => {
      const [verb, value] = ctx.args;
      if (verb === 'set-hostname' || verb === 'hostname') {
        if (!value) return fail(['hostnamectl: missing hostname'], 1);
        const d = requireRoot(ctx, 'Could not set pretty hostname: Access denied');
        if (d) return d;
        ctx.state.hostname = value;
        ctx.state.env.HOSTNAME = value;
        return ok();
      }
      const h = hostOf(ctx);
      void h;
      return ok([` Static hostname: ${ctx.state.hostname}`, '       Icon name: computer-vm', '         Chassis: vm', '      Machine ID: 4c1d4b9e5a4f4d3c9f1a2b3c4d5e6f70', '         Boot ID: 8f1a2b3c4d5e6f708f1a2b3c4d5e6f70', '  Virtualization: kvm', 'Operating System: Ubuntu 24.04.1 LTS', '          Kernel: Linux 6.8.0-45-generic', '    Architecture: x86-64']);
    },
  },
  uname: {
    help: 'print system information',
    run: (ctx) => {
      const a = ctx.args[0] ?? '-s';
      if (a === '-a') return ok([`Linux ${ctx.state.hostname} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux`]);
      if (a === '-r') return ok(['6.8.0-45-generic']);
      if (a === '-n') return ok([ctx.state.hostname]);
      if (a === '-m') return ok(['x86_64']);
      return ok(['Linux']);
    },
  },
  date: {
    help: 'print the system date and time',
    run: (ctx) => {
      const d = fakeDate(ctx.state);
      const fmt = ctx.args.find((a) => a.startsWith('+'));
      const pad = (n: number) => String(n).padStart(2, '0');
      const pieces: Record<string, string> = { Y: String(d.getUTCFullYear()), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()), F: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, T: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`, s: String(Math.floor(d.getTime() / 1000)), a: 'Thu', b: MONTHS[d.getUTCMonth()], Z: 'UTC', j: '254', u: '4' };
      if (fmt) return ok([fmt.slice(1).replace(/%([YmdHMSFTsabZju%])/g, (_m, k) => (k === '%' ? '%' : pieces[k]))]);
      return ok([`Thu ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pieces.T} UTC ${pieces.Y}`]);
    },
  },
  uptime: { help: 'tell how long the system has been running', run: (ctx) => ok([` ${fakeDate(ctx.state).toISOString().slice(11, 19)} up 2 days,  3:14,  1 user,  load average: 0.08, 0.03, 0.01`]) },
  env: { help: 'print the environment', run: (ctx) => ok(Object.entries({ ...ctx.state.env, HOME: homeOf(ctx.state), USER: ctx.state.user, PWD: ctx.state.cwd }).map(([k, v]) => `${k}=${v}`)) },
  printenv: {
    help: 'print all or part of environment',
    run: (ctx) => {
      if (!ctx.args.length) return COMMANDS.env.run(ctx);
      const all: Record<string, string | undefined> = { ...ctx.state.env, HOME: homeOf(ctx.state), USER: ctx.state.user, PWD: ctx.state.cwd };
      const missing = ctx.args.some((a) => all[a] === undefined);
      return ok(ctx.args.map((a) => all[a]).filter((v): v is string => v !== undefined), missing ? 1 : 0);
    },
  },
  seq: {
    help: 'print a sequence of numbers',
    run: (ctx) => {
      const nums = ctx.args.map(Number);
      if (!nums.length || nums.some(Number.isNaN)) return fail(['seq: missing operand'], 1);
      const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
      const out: string[] = [];
      for (let n = first; step > 0 ? n <= last : n >= last; n += step) {
        out.push(String(n));
        if (out.length > 10000) break;
      }
      return ok(out);
    },
  },
  basename: { help: 'strip directory and suffix from filenames', run: (ctx) => ok([ctx.args[0] ? baseName(ctx.args[0].replace(/\/+$/, '')).replace(ctx.args[1] ? new RegExp(ctx.args[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') : /$^/, '') : '']) },
  dirname: { help: 'strip last component from file name', run: (ctx) => ok([ctx.args[0] ? (ctx.args[0].includes('/') ? parentPath(ctx.args[0].replace(/\/+$/, '')) || '/' : '.') : '']) },
  realpath: { help: 'print the resolved path', run: (ctx) => ok(ctx.args.map((a) => resolveLink(ctx.state, ctx.sh.path(a)))) },
  sleep: { help: 'delay for a specified amount of time', run: () => ok() },
  clear: { help: 'clear the terminal screen', run: () => ok() },
  true: { help: 'do nothing, successfully', run: () => ok() },
  false: { help: 'do nothing, unsuccessfully', run: () => ok([], 1) },
  yes: { help: 'output a string repeatedly', run: (ctx) => ok(Array(5).fill(ctx.args.join(' ') || 'y')) },
  file: {
    help: 'determine file type',
    run: (ctx) => {
      const out: string[] = [];
      for (const a of ctx.args) {
        const node = getNode(ctx.state, ctx.sh.path(a), false);
        if (!node) out.push(`${a}: cannot open \`${a}' (No such file or directory)`);
        else if (node.type === 'dir') out.push(`${a}: directory`);
        else if (node.type === 'link') out.push(`${a}: symbolic link to ${node.target}`);
        else if (node.content === '') out.push(`${a}: empty`);
        else if (node.content.startsWith('#!')) out.push(`${a}: ${/python/.test(node.content.split('\n')[0]) ? 'Python' : 'Bourne-Again shell'} script, ASCII text executable`);
        else if (/^\s*[[{]/.test(node.content)) out.push(`${a}: JSON text data`);
        else out.push(`${a}: ASCII text`);
      }
      return ok(out);
    },
  },
  du: {
    help: 'estimate file space usage',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const targets = p.operands.length ? p.operands : ['.'];
      const out: string[] = [];
      for (const t of targets) {
        const base = ctx.sh.path(t);
        let total = 0;
        for (const [k, n] of Object.entries(ctx.state.fs)) if (k === base || k.startsWith(base + '/')) total += n.type === 'file' ? Math.max(4096, n.content.length) : 4096;
        out.push(`${p.flags.has('h') ? fmtSize(total, true) : Math.ceil(total / 1024)}\t${t}`);
      }
      return ok(out);
    },
  },
  df: { help: 'report file system space usage', run: (ctx) => ok(ctx.args.includes('-h') ? ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/vda1        40G  8.2G   30G  22% /', 'tmpfs           2.0G     0  2.0G   0% /dev/shm', '/dev/vda15      105M  6.1M   99M   6% /boot/efi'] : ['Filesystem     1K-blocks    Used Available Use% Mounted on', '/dev/vda1       41152736 8598528  30786504  22% /', 'tmpfs            2016000       0   2016000   0% /dev/shm', '/dev/vda15        106858    6182    100677   6% /boot/efi']) },
  free: { help: 'display amount of free and used memory', run: (ctx) => ok(ctx.args.includes('-h') ? ['               total        used        free      shared  buff/cache   available', 'Mem:           3.8Gi       612Mi       2.6Gi       1.0Mi       676Mi       3.0Gi', 'Swap:             0B          0B          0B'] : ['               total        used        free      shared  buff/cache   available', 'Mem:         4025936      626688     2705408        1024      693840     3155968', 'Swap:              0           0           0']) },
  lscpu: { help: 'display information about the CPU architecture', run: () => ok(['Architecture:            x86_64', '  CPU op-mode(s):        32-bit, 64-bit', 'CPU(s):                  2', 'Model name:              Simulated CPU @ 2.40GHz']) },

  ps: {
    help: 'report a snapshot of the current processes',
    run: (ctx) => {
      const all = ctx.args.some((a) => /aux|-e|-A|ax/.test(a));
      const procs = all ? ctx.state.processes : ctx.state.processes.filter((p) => p.user === ctx.state.user);
      if (ctx.args.some((a) => a.includes('-o'))) return ok(['  PID CMD', ...procs.map((p) => `${String(p.pid).padStart(5)} ${p.cmd}`)]);
      if (ctx.args.some((a) => a.startsWith('-e'))) return ok(['UID          PID    PPID  C STIME TTY          TIME CMD', ...procs.map((p) => `${p.user.padEnd(10)}${String(p.pid).padStart(7)}${String(p.pid === 1 ? 0 : 1).padStart(8)}  0 08:55 ?        00:00:00 ${p.cmd}`)]);
      if (all) return ok(['USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND', ...procs.map((p) => `${p.user.padEnd(10)}${String(p.pid).padStart(6)}  0.0  0.${String(p.pid % 9)}  ${String(21000 + p.pid * 3).padStart(5)} ${String(2000 + p.pid).padStart(5)} ?        Ss   08:55   0:00 ${p.cmd}`)]);
      return ok(['    PID TTY          TIME CMD', ...procs.map((p) => `${String(p.pid).padStart(7)} pts/0    00:00:00 ${baseName(p.cmd.split(' ')[0])}`), `${String(ctx.state.nextPid).padStart(7)} pts/0    00:00:00 ps`]);
    },
  },
  pgrep: { help: 'look up processes based on name', run: (ctx) => { const pat = ctx.args.filter((a) => !a.startsWith('-')).pop() ?? ''; const hits = ctx.state.processes.filter((p) => p.cmd.includes(pat)); return ok(hits.map((p) => (ctx.args.includes('-l') || ctx.args.includes('-a') ? `${p.pid} ${p.cmd}` : String(p.pid))), hits.length ? 0 : 1); } },
  kill: {
    help: 'send a signal to a process',
    run: (ctx) => {
      const pids = ctx.args.filter((a) => /^\d+$/.test(a)).map(Number);
      if (!pids.length) return fail(['kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]'], 2);
      const err: string[] = [];
      for (const pid of pids) {
        const proc = ctx.state.processes.find((p) => p.pid === pid);
        if (!proc) err.push(`bash: kill: (${pid}) - No such process`);
        else if (!isRoot(ctx.state) && proc.user !== ctx.state.user) err.push(`bash: kill: (${pid}) - Operation not permitted`);
        else if (pid === 1) err.push(`bash: kill: (1) - Operation not permitted`);
        else {
          ctx.state.processes = ctx.state.processes.filter((p) => p.pid !== pid);
          for (const s of Object.values(ctx.state.services)) if (s.active && daemonCommand(s.name) === proc.cmd) s.active = false;
        }
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    },
  },
  pkill: {
    help: 'signal processes based on name',
    run: (ctx) => {
      const pat = ctx.args.filter((a) => !a.startsWith('-')).pop() ?? '';
      const hits = ctx.state.processes.filter((p) => p.cmd.includes(pat) && p.pid !== 1 && (isRoot(ctx.state) || p.user === ctx.state.user));
      if (!hits.length) return ok([], 1);
      return COMMANDS.kill.run({ ...ctx, args: hits.map((p) => String(p.pid)) });
    },
  },
  top: { help: 'display Linux processes', run: (ctx) => ok([`top - ${fakeDate(ctx.state).toISOString().slice(11, 19)} up 2 days,  3:14,  1 user,  load average: 0.08, 0.03, 0.01`, `Tasks: ${ctx.state.processes.length} total,   1 running, ${ctx.state.processes.length - 1} sleeping,   0 stopped,   0 zombie`, '%Cpu(s):  0.3 us,  0.2 sy,  0.0 ni, 99.5 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st', 'MiB Mem :   3931.6 total,   2642.0 free,    612.0 used,    677.6 buff/cache', '', '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND', ...ctx.state.processes.slice(0, 8).map((p) => `${String(p.pid).padStart(7)} ${p.user.padEnd(9)} 20   0 ${String(21000 + p.pid * 3).padStart(7)} ${String(2000 + p.pid).padStart(6)} ${String(1500 + (p.pid % 100)).padStart(6)} S   0.0   0.1   0:00.${String(p.pid % 100).padStart(2, '0')} ${baseName(p.cmd.split(' ')[0])}`), '(top is interactive on a real system; this is a single snapshot)']) },
  htop: { help: 'interactive process viewer', run: (ctx) => (ctx.state.packages.includes('htop') ? COMMANDS.top.run(ctx) : fail(['Command \'htop\' not found, but can be installed with:', 'sudo apt install htop'], 127)) },

  systemctl: {
    help: 'control the systemd system and service manager',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const [verb, ...units] = p.operands;
      const st = ctx.state;
      const unitName = (u: string) => u.replace(/\.service$/, '');
      if (!verb || verb === 'list-units') {
        const rows = Object.values(st.services).map((s) => `  ${(s.name + '.service').padEnd(24)} loaded ${s.active ? 'active   running' : 'inactive dead   '} ${s.description}`);
        return ok(['  UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION', ...rows, '', 'LOAD   = Reflects whether the unit definition was properly loaded.', 'ACTIVE = The high-level unit activation state, i.e. generalization of SUB.', 'SUB    = The low-level unit activation state, values depend on unit type.']);
      }
      if (verb === 'daemon-reload') return isRoot(st) ? ok() : fail(['Failed to reload daemon: Interactive authentication required.']);
      if (!units.length) return fail([`Too few arguments.`], 1);
      const out: string[] = [];
      const err: string[] = [];
      for (const u of units) {
        const name = unitName(u);
        const svc = st.services[name];
        if (!svc) {
          if (verb === 'status') {
            err.push(`Unit ${name}.service could not be found.`);
            continue;
          }
          const known = KNOWN_SERVICES[name];
          err.push(`Failed to ${verb} ${name}.service: Unit ${name}.service not found.${known?.package && !st.packages.includes(known.package) ? ` (Install it first: sudo apt install ${known.package})` : ''}`);
          continue;
        }
        switch (verb) {
          case 'status': {
            const since = svc.active ? 'Thu 2026-09-11 08:55:12 UTC; 2h ago' : 'n/a';
            const proc = st.processes.find((x) => x.cmd === daemonCommand(name));
            out.push(`${svc.active ? '●' : '○'} ${name}.service - ${svc.description}`, `     Loaded: loaded (/usr/lib/systemd/system/${name}.service; ${svc.enabled ? 'enabled' : 'disabled'}; preset: enabled)`, `     Active: ${svc.active ? 'active (running)' : 'inactive (dead)'}${svc.active ? ` since ${since}` : ''}`);
            if (svc.active && proc) out.push(`   Main PID: ${proc.pid} (${baseName(proc.cmd.split(' ')[0]).replace(/:$/, '')})`, '      Tasks: 2 (limit: 4556)', '     Memory: 3.1M (peak: 4.0M)', '        CPU: 42ms', `     CGroup: /system.slice/${name}.service`, `             └─${proc.pid} ${proc.cmd}`);
            if (svc.active) out.push('', `Sep 11 08:55:12 ${st.hostname} systemd[1]: Started ${svc.description}.`);
            else if (name === 'nginx' && st.web.lastError) out.push('', `Sep 11 09:10:02 ${st.hostname} nginx[${st.nextPid}]: ${st.web.lastError}`, `Sep 11 09:10:02 ${st.hostname} nginx[${st.nextPid}]: nginx: configuration file /etc/nginx/nginx.conf test failed`, `Sep 11 09:10:02 ${st.hostname} systemd[1]: nginx.service: Control process exited, code=exited, status=1/FAILURE`, `Sep 11 09:10:02 ${st.hostname} systemd[1]: Failed to start ${svc.description}.`);
            else out.push('', `Sep 11 08:55:12 ${st.hostname} systemd[1]: Stopped ${svc.description}.`);
            if (units.length > 1) out.push('');
            break;
          }
          case 'is-active':
            out.push(svc.active ? 'active' : 'inactive');
            if (!svc.active) return { out, err, code: 3 };
            break;
          case 'is-enabled':
            out.push(svc.enabled ? 'enabled' : 'disabled');
            if (!svc.enabled) return { out, err, code: 1 };
            break;
          case 'start':
          case 'stop':
          case 'restart':
          case 'reload':
          case 'enable':
          case 'disable': {
            if (!isRoot(st)) {
              err.push(`Failed to ${verb} ${name}.service: Interactive authentication required.`, 'See system logs and \'systemctl status ' + name + '.service\' for details.');
              break;
            }
            if (verb === 'start' || verb === 'restart' || verb === 'reload') {
              if (name === 'nginx') {
                const r = loadNginx(st);
                if (!r.ok) {
                  err.push(`Job for nginx.service failed because the control process exited with error code.`, `See "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.`);
                  if (verb !== 'reload') {
                    svc.active = false;
                    st.processes = st.processes.filter((x) => x.cmd !== daemonCommand(name));
                  }
                  break;
                }
              }
              if (!svc.active) {
                svc.active = true;
                st.processes.push({ pid: st.nextPid++, user: name === 'nginx' || name === 'apache2' ? 'www-data' : 'root', cmd: daemonCommand(name) });
              }
            }
            if (verb === 'stop') {
              svc.active = false;
              st.processes = st.processes.filter((x) => x.cmd !== daemonCommand(name));
            }
            if (verb === 'enable') {
              svc.enabled = true;
              out.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → /usr/lib/systemd/system/${name}.service.`);
              if (p.flags.has('now') && !svc.active) {
                if (name === 'nginx' && !loadNginx(st).ok) {
                  err.push(`Job for nginx.service failed because the control process exited with error code.`, `See "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.`);
                  break;
                }
                svc.active = true;
                st.processes.push({ pid: st.nextPid++, user: name === 'nginx' || name === 'apache2' ? 'www-data' : 'root', cmd: daemonCommand(name) });
              }
            }
            if (verb === 'disable') {
              svc.enabled = false;
              out.push(`Removed "/etc/systemd/system/multi-user.target.wants/${name}.service".`);
              if (p.flags.has('now')) {
                svc.active = false;
                st.processes = st.processes.filter((x) => x.cmd !== daemonCommand(name));
              }
            }
            break;
          }
          default:
            err.push(`Unknown command verb ${verb}.`);
        }
      }
      return { out, err, code: err.length ? (err[0].includes('could not be found') ? 4 : 1) : 0 };
    },
  },
  service: { help: 'run a System V init script', run: (ctx) => (ctx.args.length >= 2 ? COMMANDS.systemctl.run({ ...ctx, args: [ctx.args[1], ctx.args[0]] }) : fail(['Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]'])) },
  journalctl: {
    help: 'query the systemd journal',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['u', 'n']);
      const unit = p.values.u;
      const h = ctx.state.hostname;
      if (unit) {
        const s = ctx.state.services[unit.replace(/\.service$/, '')];
        if (!s) return ok(['-- No entries --']);
        return ok([`Sep 11 08:55:10 ${h} systemd[1]: Starting ${s.description}...`, `Sep 11 08:55:12 ${h} systemd[1]: Started ${s.description}.`, ...(s.active ? [] : [`Sep 11 09:10:02 ${h} systemd[1]: Stopping ${s.description}...`, `Sep 11 09:10:02 ${h} systemd[1]: ${unit}.service: Deactivated successfully.`, `Sep 11 09:10:02 ${h} systemd[1]: Stopped ${s.description}.`])]);
      }
      const syslog = ctx.state.fs['/var/log/syslog']?.content ?? '';
      const arr = lines(syslog);
      return ok(p.values.n ? arr.slice(-Number(p.values.n)) : arr);
    },
  },

  useradd: {
    help: 'create a new user',
    run: (ctx) => {
      const d = requireRoot(ctx, 'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.');
      if (d) return { ...d, err: d.err[0].split('\n') };
      const p = parseArgs(ctx.args, ['s', 'G', 'g', 'd', 'c', 'u']);
      const name = p.operands[0];
      if (!name) return fail(['Usage: useradd [options] LOGIN', '       useradd -D', '       useradd -D [options]'], 2);
      if (!/^[a-z_][a-z0-9_-]*$/.test(name)) return fail([`useradd: invalid user name '${name}': use --badname to ignore`], 3);
      const st = ctx.state;
      if (findUser(st, name)) return fail([`useradd: user '${name}' already exists`], 9);
      const uid = Math.max(999, ...st.users.map((u) => u.uid).filter((u) => u < 60000)) + 1;
      const supp = p.values.G ? p.values.G.split(',').filter(Boolean) : [];
      for (const g of supp) if (!st.groups.some((x) => x.name === g)) return fail([`useradd: group '${g}' does not exist`], 6);
      let gid = uid;
      if (p.values.g) {
        const g = st.groups.find((x) => x.name === p.values.g);
        if (!g) return fail([`useradd: group '${p.values.g}' does not exist`], 6);
        gid = g.gid;
      } else st.groups.push({ name, gid });
      const home = p.values.d ?? `/home/${name}`;
      st.users.push({ name, uid, gid, home, shell: p.values.s ?? '/bin/sh', groups: supp });
      if (p.flags.has('m') || p.flags.has('create-home')) {
        st.fs[home] = { type: 'dir', content: '', owner: name, group: groupName(st, gid), mode: 0o750, mtime: ++st.clock };
        st.fs[`${home}/.bashrc`] = { type: 'file', content: '# ~/.bashrc\n', owner: name, group: groupName(st, gid), mode: 0o644, mtime: st.clock };
      }
      return ok();
    },
  },
  adduser: {
    help: 'add a user to the system (interactive on a real system)',
    run: (ctx) => {
      const name = ctx.args.filter((a) => !a.startsWith('-')).pop();
      if (ctx.args.length === 2 && !ctx.args[0].startsWith('-') && ctx.state.groups.some((g) => g.name === ctx.args[1])) return COMMANDS.usermod.run({ ...ctx, args: ['-aG', ctx.args[1], ctx.args[0]] });
      if (!name) return fail(['adduser: Only one or two names allowed.'], 1);
      const r = COMMANDS.useradd.run({ ...ctx, args: ['-m', '-s', '/bin/bash', name] });
      if (r.code) return r;
      return ok([`info: Adding user \`${name}' ...`, `info: Selecting UID/GID from range 1000 to 59999 ...`, `info: Adding new group \`${name}' ...`, `info: Adding new user \`${name}' with group \`${name}' ...`, `info: Creating home directory \`/home/${name}' ...`, `info: Copying files from \`/etc/skel' ...`, '(Set the password with: passwd ' + name + ')']);
    },
  },
  usermod: {
    help: 'modify a user account',
    run: (ctx) => {
      const d = requireRoot(ctx, 'usermod: Permission denied.');
      if (d) return d;
      const p = parseArgs(ctx.args, ['G', 's', 'd', 'l', 'g', 'c']);
      const name = p.operands[0];
      const u = name ? findUser(ctx.state, name) : undefined;
      if (!u) return fail([`usermod: user '${name ?? ''}' does not exist`], 6);
      if (p.values.G !== undefined) {
        const groups = p.values.G.split(',').filter(Boolean);
        for (const g of groups) if (!ctx.state.groups.some((x) => x.name === g)) return fail([`usermod: group '${g}' does not exist`], 6);
        u.groups = p.flags.has('a') ? [...new Set([...u.groups, ...groups])] : groups;
      }
      if (p.values.s) u.shell = p.values.s;
      if (p.values.d) u.home = p.values.d;
      if (p.values.g) {
        const g = ctx.state.groups.find((x) => x.name === p.values.g);
        if (!g) return fail([`usermod: group '${p.values.g}' does not exist`], 6);
        u.gid = g.gid;
      }
      if (p.flags.has('L')) u.locked = true;
      if (p.flags.has('U')) u.locked = false;
      if (p.values.l) u.name = p.values.l;
      return ok();
    },
  },
  userdel: {
    help: 'delete a user account',
    run: (ctx) => {
      const d = requireRoot(ctx, 'userdel: Permission denied.');
      if (d) return d;
      const p = parseArgs(ctx.args);
      const name = p.operands[0];
      const u = name ? findUser(ctx.state, name) : undefined;
      if (!u) return fail([`userdel: user '${name ?? ''}' does not exist`], 6);
      if (u.name === ctx.state.user || ctx.state.userStack.includes(u.name)) return fail([`userdel: user ${u.name} is currently used by process 1201`], 8);
      ctx.state.users = ctx.state.users.filter((x) => x !== u);
      ctx.state.groups = ctx.state.groups.filter((g) => !(g.name === u.name && g.gid === u.gid));
      if (p.flags.has('r')) for (const key of Object.keys(ctx.state.fs)) if (key === u.home || key.startsWith(u.home + '/')) delete ctx.state.fs[key];
      return ok();
    },
  },
  groupadd: {
    help: 'create a new group',
    run: (ctx) => {
      const d = requireRoot(ctx, 'groupadd: Permission denied.');
      if (d) return d;
      const name = parseArgs(ctx.args, ['g']).operands[0];
      if (!name) return fail(['Usage: groupadd [options] GROUP'], 2);
      if (ctx.state.groups.some((g) => g.name === name)) return fail([`groupadd: group '${name}' already exists`], 9);
      ctx.state.groups.push({ name, gid: Math.max(999, ...ctx.state.groups.map((g) => g.gid).filter((g) => g < 60000)) + 1 });
      return ok();
    },
  },
  groupdel: {
    help: 'delete a group',
    run: (ctx) => {
      const d = requireRoot(ctx, 'groupdel: Permission denied.');
      if (d) return d;
      const name = ctx.args[0];
      const g = ctx.state.groups.find((x) => x.name === name);
      if (!g) return fail([`groupdel: group '${name}' does not exist`], 6);
      if (ctx.state.users.some((u) => u.gid === g.gid)) return fail([`groupdel: cannot remove the primary group of user '${ctx.state.users.find((u) => u.gid === g.gid)!.name}'`], 8);
      ctx.state.groups = ctx.state.groups.filter((x) => x !== g);
      for (const u of ctx.state.users) u.groups = u.groups.filter((x) => x !== name);
      return ok();
    },
  },
  gpasswd: {
    help: 'administer /etc/group',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['a', 'd']);
      const group = p.operands[0];
      if (p.values.a) {
        const r = COMMANDS.usermod.run({ ...ctx, args: ['-aG', group, p.values.a] });
        return r.code ? r : ok([`Adding user ${p.values.a} to group ${group}`]);
      }
      if (p.values.d) {
        const u = findUser(ctx.state, p.values.d);
        if (u) u.groups = u.groups.filter((g) => g !== group);
        return ok([`Removing user ${p.values.d} from group ${group}`]);
      }
      return fail(['Usage: gpasswd [option] GROUP'], 2);
    },
  },
  passwd: {
    help: 'change user password',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const name = p.operands[0] ?? ctx.state.user;
      const u = findUser(ctx.state, name);
      if (!u) return fail([`passwd: user '${name}' does not exist`], 1);
      if (!isRoot(ctx.state) && name !== ctx.state.user) return fail(['passwd: You may not view or modify password information for ' + name + '.'], 1);
      if (p.flags.has('l')) {
        u.locked = true;
        return ok([`passwd: password changed.`]);
      }
      if (p.flags.has('u')) {
        u.locked = false;
        return ok([`passwd: password changed.`]);
      }
      if (p.flags.has('S')) return ok([`${u.name} ${u.locked ? 'L' : u.password ? 'P' : 'NP'} 09/11/2026 0 99999 7 -1`]);
      ctx.state.pending = { kind: 'password', user: name, stage: 'new' };
      return ok([isRoot(ctx.state) && name !== 'root' ? `Changing password for ${name}.` : `Changing password for ${name}.`]);
    },
  },
  chpasswd: {
    help: 'update passwords in batch mode',
    run: (ctx) => {
      const d = requireRoot(ctx, 'chpasswd: Permission denied.');
      if (d) return d;
      for (const l of lines(ctx.stdin)) {
        const [name, pw] = l.split(':');
        const u = findUser(ctx.state, name);
        if (!u) return fail([`chpasswd: line 1: user '${name}' does not exist`]);
        u.password = pw;
      }
      return ok();
    },
  },
  su: {
    help: 'run a shell with substitute user',
    run: (ctx) => {
      const name = ctx.args.filter((a) => !a.startsWith('-')).pop() ?? 'root';
      const u = findUser(ctx.state, name);
      if (!u) return fail([`su: user ${name} does not exist or the user entry does not contain all the required fields`], 1);
      if (!isRoot(ctx.state) && !isSudoer(ctx.state, ctx.state.user)) return fail(['Password: ', 'su: Authentication failure', '(In this simulator only root and sudoers may switch users; try sudo -i.)']);
      ctx.state.userStack.push(ctx.state.user);
      ctx.state.user = name;
      if (ctx.args.includes('-') || ctx.args.includes('-l')) ctx.state.cwd = u.home;
      return ok();
    },
  },
  visudo: { help: 'edit the sudoers file', run: () => fail(['visudo: this simulator has no interactive editor; add users to the sudo group with usermod -aG sudo <user> instead.']) },

  apt: {
    help: 'package manager',
    run: (ctx) => {
      const p = parseArgs(ctx.args);
      const [verb, ...pkgs] = p.operands;
      const st = ctx.state;
      if (verb === 'update') {
        const d = requireRoot(ctx, 'Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/');
        if (d) return { ...d, err: d.err[0].split('\n'), code: 100 };
        return ok(['Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease', 'Get:2 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]', 'Fetched 126 kB in 1s (118 kB/s)', 'Reading package lists... Done', 'Building dependency tree... Done', 'All packages are up to date.']);
      }
      if (verb === 'list') return ok(st.packages.sort().map((x) => `${x}/noble,now 1.0 amd64 [installed]`));
      if (verb === 'search') return ok(Object.entries(KNOWN_PACKAGES).filter(([k, v]) => k.includes(pkgs[0] ?? '') || v.description.includes(pkgs[0] ?? '')).map(([k, v]) => `${k}/noble 1.0 amd64\n  ${v.description}`).flatMap((s) => s.split('\n')));
      if (verb === 'install' || verb === 'remove' || verb === 'purge' || verb === 'autoremove') {
        const d = requireRoot(ctx, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
        if (d) return { ...d, err: d.err[0].split('\n'), code: 100 };
        if (verb === 'autoremove') return ok(['Reading package lists... Done', 'Building dependency tree... Done', '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.']);
        const out = ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'];
        for (const pkg of pkgs) {
          const known = KNOWN_PACKAGES[pkg];
          if (!known) return fail([...out, `E: Unable to locate package ${pkg}`], 100);
          if (verb === 'install') {
            if (st.packages.includes(pkg)) {
              out.push(`${pkg} is already the newest version (1.0).`);
              continue;
            }
            st.packages.push(pkg);
            out.push(`The following NEW packages will be installed:`, `  ${pkg}`, `0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.`, `Need to get 512 kB of archives.`, `Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${pkg} amd64 1.0 [512 kB]`, `Fetched 512 kB in 0s (2,048 kB/s)`, `Selecting previously unselected package ${pkg}.`, `Unpacking ${pkg} (1.0) ...`, `Setting up ${pkg} (1.0) ...`);
            if (known.service) {
              const ks = KNOWN_SERVICES[known.service];
              st.services[known.service] = { name: known.service, description: ks.description, active: false, enabled: false, port: ks.port };
              if (known.service === 'nginx') installNginxFiles(st);
              if (known.service === 'app') installAppFiles(st);
              if (known.service === 'apache2') {
                st.fs['/var/www/html'] ??= { type: 'dir', content: '', owner: 'root', group: 'root', mode: 0o755, mtime: ++st.clock };
                st.fs['/var/www/html/index.html'] ??= { type: 'file', content: '<!DOCTYPE html>\n<html>\n<head><title>Apache2 Ubuntu Default Page</title></head>\n<body><h1>It works!</h1></body>\n</html>\n', owner: 'root', group: 'root', mode: 0o644, mtime: st.clock };
              }
              out.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${known.service}.service → /usr/lib/systemd/system/${known.service}.service.`);
              st.services[known.service].enabled = true;
              st.services[known.service].active = true;
              st.processes.push({ pid: st.nextPid++, user: known.service === 'nginx' || known.service === 'apache2' ? 'www-data' : 'root', cmd: daemonCommand(known.service) });
            }
          } else {
            if (!st.packages.includes(pkg)) {
              out.push(`Package '${pkg}' is not installed, so not removed`);
              continue;
            }
            st.packages = st.packages.filter((x) => x !== pkg);
            out.push(`The following packages will be REMOVED:`, `  ${pkg}`, `Removing ${pkg} (1.0) ...`);
            if (known.service) {
              delete st.services[known.service];
              st.processes = st.processes.filter((x) => x.cmd !== daemonCommand(known.service!));
            }
          }
        }
        return ok(out);
      }
      return fail([`E: Invalid operation ${verb ?? ''}`], 100);
    },
  },
  'apt-get': { help: 'package manager', run: (ctx) => COMMANDS.apt.run(ctx) },
  dnf: { help: 'package manager', run: (ctx) => COMMANDS.apt.run(ctx) },
  yum: { help: 'package manager', run: (ctx) => COMMANDS.apt.run(ctx) },
  dpkg: { help: 'package manager for Debian', run: (ctx) => (ctx.args[0] === '-l' ? ok(['Desired=Unknown/Install/Remove/Purge/Hold', '||/ Name            Version      Architecture Description', '+++-===============-============-============-=================================', ...ctx.state.packages.sort().map((p) => `ii  ${p.padEnd(15)} 1.0          amd64        ${KNOWN_PACKAGES[p]?.description ?? 'installed package'}`)]) : ctx.args[0] === '-s' || ctx.args[0] === '-L' ? ok(ctx.state.packages.includes(ctx.args[1]) ? [`Package: ${ctx.args[1]}`, 'Status: install ok installed'] : [], ctx.state.packages.includes(ctx.args[1]) ? 0 : 1) : fail(['dpkg: error: need an action option'], 2)) },

  ip: {
    help: 'show / manipulate routing, network devices, interfaces',
    run: (ctx) => {
      const h = hostOf(ctx);
      const sub = ctx.args.filter((a) => !a.startsWith('-'));
      const verb = sub[0] ?? '';
      const mac = h.mac.replace(/\./g, '').match(/.{2}/g)!.join(':');
      const prefix = h.mask ? prefixLength(h.mask) : 24;
      if (/^a(ddr(ess)?)?$/.test(verb) || /^l(ink)?$/.test(verb)) {
        const brief = ctx.args.includes('-br') || ctx.args.includes('-brief');
        if (brief) return ok([`lo               UNKNOWN        127.0.0.1/8`, `eth0             UP             ${h.ip ? `${h.ip}/${prefix}` : ''}`]);
        const out = ['1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000', '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00'];
        if (!/^l/.test(verb)) out.push('    inet 127.0.0.1/8 scope host lo', '       valid_lft forever preferred_lft forever');
        out.push('2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000', `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`);
        if (!/^l/.test(verb)) {
          if (h.ip) out.push(`    inet ${h.ip}/${prefix} brd ${broadcast(h.ip, prefix)} scope global ${h.dhcp ? 'dynamic ' : ''}eth0`, '       valid_lft forever preferred_lft forever');
          if (h.ip6) out.push(`    inet6 ${h.ip6.toLowerCase()}/${h.prefix6 ?? 64} scope global`, '       valid_lft forever preferred_lft forever');
        }
        return ok(out);
      }
      if (/^r(oute)?$/.test(verb)) {
        const out: string[] = [];
        if (h.gateway) out.push(`default via ${h.gateway} dev eth0 ${h.dhcp ? 'proto dhcp ' : 'proto static '}metric 100`);
        if (h.ip && h.mask) out.push(`${networkOf(h.ip, prefix)}/${prefix} dev eth0 proto kernel scope link src ${h.ip}`);
        return ok(out);
      }
      if (/^n(eigh(bou?r)?)?$/.test(verb)) return ok(h.gateway ? [`${h.gateway} dev eth0 lladdr 00:11:22:33:44:01 REACHABLE`] : []);
      return fail(['Object "' + verb + '" is unknown, try "ip help".'], 1);
    },
  },
  ifconfig: { help: 'configure a network interface (legacy)', run: (ctx) => (ctx.state.packages.includes('net-tools') ? COMMANDS.ip.run({ ...ctx, args: ['addr'] }) : fail(["Command 'ifconfig' not found, but can be installed with:", 'sudo apt install net-tools'], 127)) },
  ping: {
    help: 'send ICMP ECHO_REQUEST to network hosts',
    run: (ctx) => {
      const p = parseArgs(ctx.args, ['c', 'W', 'i']);
      const target = p.operands[0];
      if (!target) return fail(['ping: usage error: Destination address required'], 2);
      const h = hostOf(ctx);
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(target) && !target.includes(':')) return fail([`ping: ${target}: Temporary failure in name resolution`], 2);
      const count = Math.min(Number(p.values.c ?? 4) || 4, 10);
      const r = netPing(ctx.network, ctx.hostId, target);
      h.pings.push({ target, success: r.success, ...(r.denied ? { denied: true } : {}) });
      const out = [`PING ${target} (${target}) 56(84) bytes of data.`];
      const routerHops = Math.max(0, r.hops.length - 1);
      for (let i = 1; i <= count; i++) {
        if (r.success) out.push(`64 bytes from ${target}: icmp_seq=${i} ttl=${64 - routerHops} time=0.${(3 + i * 7) % 10}${i}${i} ms`);
        else if (r.denied) out.push(`From ${r.denied.ip ?? target} icmp_seq=${i} Destination Net Unreachable`);
      }
      out.push('', `--- ${target} ping statistics ---`, `${count} packets transmitted, ${r.success ? count : 0} received, ${r.denied && !r.success ? `+${count} errors, ` : ''}${r.success ? 0 : 100}% packet loss, time ${(count - 1) * 1000 + 3}ms`);
      if (r.success) out.push('rtt min/avg/max/mdev = 0.311/0.402/0.511/0.071 ms');
      return { out, err: [], code: r.success ? 0 : 1 };
    },
  },
  traceroute: {
    help: 'print the route packets trace to network host',
    run: (ctx) => {
      const target = ctx.args.filter((a) => !a.startsWith('-'))[0];
      if (!target) return fail(['Usage: traceroute [ -46dFITnreAUDV ] host'], 2);
      const r = netPing(ctx.network, ctx.hostId, target);
      const out = [`traceroute to ${target} (${target}), 30 hops max, 60 byte packets`];
      r.hops.forEach((hop, i) => out.push(` ${i + 1}  ${hop.ip ?? hop.node} (${hop.ip ?? hop.node})  0.4${i} ms  0.3${i} ms  0.5${i} ms`));
      if (!r.success) out.push(` ${r.hops.length + 1}  * * *`);
      return ok(out);
    },
  },
  ss: {
    help: 'investigate sockets',
    run: (ctx) => {
      const listening = Object.values(ctx.state.services).filter((s) => s.active && (s.port || s.ports?.length));
      const showProc = ctx.args.some((a) => a.includes('p'));
      const out = [`Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port ${showProc ? 'Process' : ''}`.trimEnd()];
      for (const s of listening) {
        const proc = ctx.state.processes.find((x) => x.cmd === daemonCommand(s.name));
        const pname = baseName(proc?.cmd.split(' ')[0] ?? s.name).replace(/:$/, '');
        const ports = s.name === 'nginx' ? nginxPorts(ctx.state) : (s.ports ?? [s.port!]);
        for (const port of ports) out.push(`tcp   LISTEN 0      ${port === 22 ? 128 : 511}    ${`0.0.0.0:${port}`.padEnd(19)}${'0.0.0.0:*'.padEnd(18)}${showProc ? (isRoot(ctx.state) ? `users:(("${pname}",pid=${proc?.pid ?? 0},fd=6))` : '') : ''}`.trimEnd());
      }
      return ok(out);
    },
  },
  netstat: { help: 'print network connections (legacy)', run: (ctx) => (ctx.state.packages.includes('net-tools') ? COMMANDS.ss.run(ctx) : fail(["Command 'netstat' not found, but can be installed with:", 'sudo apt install net-tools'], 127)) },
  curl: {
    help: 'transfer a URL',
    run: (ctx) => {
      const r = curl(ctx.network, hostOf(ctx), ctx.args);
      return r.code === 0 ? ok(r.output) : fail(r.output, r.code);
    },
  },
  wget: {
    help: 'non-interactive network downloader',
    run: (ctx) => {
      const url = ctx.args.filter((a) => !a.startsWith('-')).pop();
      if (!url) return fail(['wget: missing URL'], 1);
      const r = curl(ctx.network, hostOf(ctx), [url]);
      if (r.code) return fail(r.output, r.code);
      const name = baseName(url.replace(/\/+$/, '')) || 'index.html';
      const e = writeFile(ctx.state, ctx.sh.path(name), r.output.join('\n') + '\n', false, 'wget');
      return e ? fail([e.error]) : ok([`--2026-09-11 09:00:00--  ${url}`, `Saving to: ‘${name}’`, '', `‘${name}’ saved [${r.output.join('\n').length + 1}]`]);
    },
  },
  dig: { help: 'DNS lookup utility', run: (ctx) => ok([`; <<>> DiG 9.18 <<>> ${ctx.args[0] ?? ''}`, ';; ->>HEADER<<- opcode: QUERY, status: SERVFAIL', '(No DNS server is reachable from this lab network.)']) },
  nslookup: { help: 'query DNS', run: () => fail([';; connection timed out; no servers could be reached'], 1) },
  ssh: { help: 'OpenSSH remote login client', run: (ctx) => fail([`ssh: connect to host ${ctx.args.filter((a) => !a.startsWith('-')).pop() ?? ''} port 22: interactive sessions are not simulated. Use the device tabs above to open another console.`], 255) },

  man: {
    help: 'an interface to the system reference manuals',
    run: (ctx) => {
      const name = ctx.args.filter((a) => !a.startsWith('-'))[0];
      if (!name) return fail(['What manual page do you want?', 'For example, try \'man man\'.'], 1);
      const c = COMMANDS[name];
      const builtin: Record<string, string> = { cd: 'change the shell working directory', export: 'set export attribute for shell variables', test: 'evaluate a conditional expression', '[': 'evaluate a conditional expression', read: 'read a line from standard input into variables', source: 'execute commands from a file in the current shell', exit: 'exit the shell', sudo: 'execute a command as another user', bash: 'GNU Bourne-Again SHell' };
      const desc = c?.help ?? builtin[name];
      if (!desc) return fail([`No manual entry for ${name}`], 16);
      return ok([`${name.toUpperCase()}(1)                        User Commands                       ${name.toUpperCase()}(1)`, '', 'NAME', `       ${name} - ${desc}`, '', 'SYNOPSIS', `       ${name} [OPTION]... [FILE]...`, '', 'DESCRIPTION', `       ${desc.charAt(0).toUpperCase() + desc.slice(1)}. This simulator supports the common options; see help for the`, '       full list of commands it knows.']);
    },
  },
  help: {
    help: 'list the commands this shell supports',
    run: () => ok(['NetLab Linux shell. Supported commands:', '', ...chunk(Object.keys(COMMANDS).sort(), 8).map((row) => '  ' + row.map((c) => c.padEnd(11)).join('')), '', 'Shell builtins: cd export unset exit return source read test [ [[ if for while until case functions sudo su', 'Redirections and pipes: > >> 2> 2>&1 < << | && || ; $(cmd) $((expr)) $VAR ${VAR:-x}', 'Editors are not simulated: create files with echo > file, printf, or cat > file << EOF ... EOF', 'Python: python3 script.py or python3 -c "code" runs real CPython (Pyodide) in your browser.']) },
  nano: { help: 'text editor (not simulated)', run: (ctx) => fail([`nano: this simulator has no interactive editor. Write ${ctx.args[0] ?? 'the file'} with a heredoc instead:`, `  cat > ${ctx.args[0] ?? 'file'} << 'EOF'`, '  ...lines...', '  EOF']) },
  vi: { help: 'text editor (not simulated)', run: (ctx) => COMMANDS.nano.run(ctx) },
  vim: { help: 'text editor (not simulated)', run: (ctx) => COMMANDS.nano.run(ctx) },
  tree: {
    help: 'list contents of directories in a tree-like format',
    run: (ctx) => {
      if (!ctx.state.packages.includes('tree')) return fail(["Command 'tree' not found, but can be installed with:", 'sudo apt install tree'], 127);
      const root = ctx.sh.path(ctx.args.filter((a) => !a.startsWith('-'))[0] ?? '.');
      const out = [ctx.args.filter((a) => !a.startsWith('-'))[0] ?? '.'];
      let dirs = 0,
        files = 0;
      const walk = (dir: string, prefix: string) => {
        const names = listDir(ctx.state, dir).filter((n) => !n.startsWith('.'));
        names.forEach((n, i) => {
          const last = i === names.length - 1;
          const path = normalizePath(dir, n);
          const node = ctx.state.fs[path];
          out.push(`${prefix}${last ? '└── ' : '├── '}${n}${node.type === 'link' ? ` -> ${node.target}` : ''}`);
          if (node.type === 'dir') {
            dirs++;
            walk(path, prefix + (last ? '    ' : '│   '));
          } else files++;
        });
      };
      walk(root, '');
      out.push('', `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
      return ok(out);
    },
  },
  jq: {
    help: 'command-line JSON processor',
    run: (ctx) => {
      if (!ctx.state.packages.includes('jq')) return fail(["Command 'jq' not found, but can be installed with:", 'sudo apt install jq'], 127);
      const p = parseArgs(ctx.args);
      const filter = p.operands.shift() ?? '.';
      const { text, errors } = readInputs(ctx, p.operands, 'jq');
      if (errors.length) return fail(errors, 2);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return fail([`jq: parse error: ${(e as Error).message}`], 2);
      }
      let cur: unknown = data;
      for (const seg of filter.split('.').filter(Boolean)) {
        const m = seg.match(/^([^[]*)(?:\[(\d*)\])?$/);
        if (!m) return fail([`jq: error: syntax error near ${seg}`], 3);
        if (m[1]) cur = typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[m[1]] : undefined;
        if (m[2] !== undefined) cur = Array.isArray(cur) ? (m[2] === '' ? cur : cur[Number(m[2])]) : undefined;
      }
      if (p.flags.has('r') && typeof cur === 'string') return ok([cur]);
      return ok(JSON.stringify(cur === undefined ? null : cur, null, 2).split('\n'));
    },
  },

  nginx: {
    help: 'HTTP and reverse proxy server (nginx -t tests the configuration, -s reload reloads it)',
    run: (ctx) => {
      if (!ctx.state.packages.includes('nginx')) return fail(["Command 'nginx' not found, but can be installed with:", 'sudo apt install nginx'], 127);
      const a = ctx.args;
      if (a[0] === '-v' || a[0] === '-V') return fail(['nginx version: nginx/1.24.0 (Ubuntu)'], 0);
      if (a[0] === '-t' || a[0] === '-T') {
        const r = testNginx(ctx.state);
        if (a[0] === '-T' && r.ok) return ok([...r.warnings, ...(ctx.state.fs['/etc/nginx/nginx.conf']?.content ?? '').split('\n')]);
        if (r.ok) return fail([...r.warnings, 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful'], 0);
        return fail([...r.warnings, ...r.errors, 'nginx: configuration file /etc/nginx/nginx.conf test failed'], 1);
      }
      if (a[0] === '-s') {
        const d = requireRoot(ctx, `nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)`);
        if (d) return fail([...d.err, 'nginx: [error] open() "/run/nginx.pid" failed (13: Permission denied)']);
        if (!ctx.state.services.nginx?.active) return fail(['nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)']);
        if (a[1] === 'reload') {
          const r = loadNginx(ctx.state);
          return r.ok ? ok() : fail(r.errors);
        }
        if (a[1] === 'stop' || a[1] === 'quit') {
          ctx.state.services.nginx.active = false;
          ctx.state.processes = ctx.state.processes.filter((x) => x.cmd !== daemonCommand('nginx'));
          return ok();
        }
        return fail([`nginx: invalid option: "-s ${a[1] ?? ''}"`]);
      }
      return fail(['nginx: this simulator runs nginx through systemd; use sudo systemctl start nginx, nginx -t or sudo nginx -s reload.']);
    },
  },
  openssl: {
    help: 'OpenSSL command line tool (req -x509 creates a self-signed certificate; x509 inspects one)',
    run: (ctx) => {
      const [sub, ...rest] = ctx.args;
      const opt = (name: string) => {
        const i = rest.indexOf(name);
        return i === -1 ? undefined : rest[i + 1];
      };
      const has = (name: string) => rest.includes(name);
      if (sub === 'version') return ok(['OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)']);
      if (sub === 'req') {
        if (!has('-x509')) return fail(['openssl req: this simulator only creates self-signed certificates; add -x509 (certificate signing requests need a CA, which the lab network does not have).']);
        const out = opt('-out');
        const keyout = opt('-keyout');
        const existingKey = opt('-key');
        const subj = opt('-subj');
        const days = Number(opt('-days') ?? 30);
        if (!out) return fail(['openssl req: -out <file> is required (this simulator does not print certificates to the terminal)']);
        if (!keyout && !existingKey) return fail(['openssl req: give -newkey rsa:2048 -keyout <file> to create a key, or -key <file> to reuse one']);
        if (!subj) return fail(['You are about to be asked to enter information that will be incorporated', 'into your certificate request.', '(This simulator cannot prompt; pass the subject on the command line, e.g. -subj "/CN=web1.lab.local")'], 1);
        if (!/\/CN=[^/]+/.test(subj)) return fail(['openssl req: the subject needs a common name, e.g. -subj "/CN=web1.lab.local"']);
        if (!has('-nodes') && !has('-noenc') && keyout) return fail(['Enter PEM pass phrase:', '(This simulator cannot prompt for a pass phrase; add -nodes to write an unencrypted key, which nginx needs anyway.)'], 1);
        const errs: string[] = [];
        if (keyout) {
          const e = writeFile(ctx.state, ctx.sh.path(keyout), makePrivateKey(subj), false, 'openssl', keyout);
          if (e) errs.push(e.error);
          else {
            const node = getNode(ctx.state, ctx.sh.path(keyout));
            if (node) node.mode = 0o600;
          }
        } else if (existingKey) {
          const k = readFile(ctx.state, ctx.sh.path(existingKey), 'openssl', existingKey);
          if ('error' in k) return fail([`Could not read private key from ${existingKey}`, k.error]);
        }
        const e2 = writeFile(ctx.state, ctx.sh.path(out), makeCertificate(subj, days), false, 'openssl', out);
        if (e2) errs.push(e2.error);
        if (errs.length) return fail(errs);
        return fail(keyout ? ['..+.+.....+......+..+.......+++++++++++++++++++++++++++++++++++++++*', '.......+..+.+..+...+.......+...+.....+.+.....+....+..+.........+*', '-----'] : ['-----'], 0);
      }
      if (sub === 'x509') {
        const file = opt('-in');
        if (!file) return fail(['openssl x509: -in <certificate> is required']);
        const r = readFile(ctx.state, ctx.sh.path(file), 'openssl', file);
        if ('error' in r) return fail([`Could not open file or uri for loading certificate from ${file}`, r.error]);
        const cert = parseCertificate(r.content);
        if (!cert) return fail(['Could not read certificate from ' + file, 'Unable to load certificate']);
        const out: string[] = [];
        if (has('-text')) out.push('Certificate:', '    Data:', '        Version: 3 (0x2)', `        Serial Number:`, `            ${cert.serial.match(/.{2}/g)!.join(':')}`, '        Signature Algorithm: sha256WithRSAEncryption', `        Issuer: ${cert.issuer.replace(/^\//, '').replace(/\//g, ', ')}`, '        Validity', `            Not Before: ${opensslDate(cert.notBefore)}`, `            Not After : ${opensslDate(cert.notAfter)}`, `        Subject: ${cert.subject.replace(/^\//, '').replace(/\//g, ', ')}`, '        Subject Public Key Info:', '            Public Key Algorithm: rsaEncryption', '                Public-Key: (2048 bit)', '        X509v3 extensions:', '            X509v3 Basic Constraints: critical', '                CA:TRUE');
        if (has('-subject')) out.push(`subject=${cert.subject.replace(/^\//, '').replace(/\//g, ', ')}`);
        if (has('-issuer')) out.push(`issuer=${cert.issuer.replace(/^\//, '').replace(/\//g, ', ')}`);
        if (has('-dates') || has('-startdate')) out.push(`notBefore=${opensslDate(cert.notBefore)}`);
        if (has('-dates') || has('-enddate')) out.push(`notAfter=${opensslDate(cert.notAfter)}`);
        if (has('-serial')) out.push(`serial=${cert.serial.toUpperCase()}`);
        if (has('-fingerprint')) out.push(`sha256 Fingerprint=${cert.serial.toUpperCase().match(/.{2}/g)!.join(':')}`);
        if (!has('-noout')) out.push(...r.content.replace(/\n$/, '').split('\n'));
        if (!out.length) out.push(...r.content.replace(/\n$/, '').split('\n'));
        return ok(out);
      }
      if (sub === 'genrsa') {
        const out = opt('-out');
        if (!out) return fail(['openssl genrsa: -out <file> is required in this simulator']);
        const e = writeFile(ctx.state, ctx.sh.path(out), makePrivateKey(out), false, 'openssl', out);
        if (e) return fail([e.error]);
        const node = getNode(ctx.state, ctx.sh.path(out));
        if (node) node.mode = 0o600;
        return ok();
      }
      if (sub === 'rsa') {
        const file = opt('-in');
        const r = file ? readFile(ctx.state, ctx.sh.path(file), 'openssl', file) : { error: 'openssl rsa: -in <key> is required' };
        if ('error' in r) return fail([r.error]);
        return r.content.includes('PRIVATE KEY') ? ok(has('-check') ? ['RSA key ok', 'writing RSA key', ...r.content.replace(/\n$/, '').split('\n')] : (has('-noout') ? [] : r.content.replace(/\n$/, '').split('\n'))) : fail(['Could not read private key from ' + file]);
      }
      if (sub === 's_client') return fail(['openssl s_client: interactive TLS sessions are not simulated; use curl -k -v https://... to test a TLS listener.']);
      return fail([`Invalid command '${sub ?? ''}'; type "help" for a list.`]);
    },
  },
  python3: {
    help: 'an interpreted, interactive, object-oriented programming language',
    run: (ctx) => {
      const st = ctx.state;
      const args = [...ctx.args];
      if (args[0] === '--version' || args[0] === '-V') return ok(['Python 3.12.1']);
      let code: string;
      let argv: string[];
      let file: string | undefined;
      if (args[0] === '-c') {
        code = args.slice(1).join(' ');
        argv = ['-c'];
      } else if (args[0] === '-m') {
        if (args[1] === 'json.tool') {
          const { text, errors } = readInputs(ctx, args.slice(2), 'python3');
          if (errors.length) return fail(errors, 1);
          try {
            return ok(JSON.stringify(JSON.parse(text), null, 4).split('\n'));
          } catch (e) {
            return fail([`Expecting value: ${(e as Error).message}`], 1);
          }
        }
        return fail([`/usr/bin/python3: No module named ${args[1]} (only json.tool is supported with -m)`], 1);
      } else if (args[0] && !args[0].startsWith('-')) {
        file = ctx.sh.path(args[0]);
        const r = readFile(st, file, 'python3');
        if ('error' in r) return fail([`python3: can't open file '${file}': [Errno 2] No such file or directory`], 2);
        code = r.content;
        argv = [args[0], ...args.slice(1)];
      } else return fail(['python3: the interactive interpreter is not simulated; run a script (python3 file.py) or use python3 -c "code".'], 1);
      // Text files the script may read or write: everything under the home directory and the cwd.
      const files: Record<string, string> = {};
      const home = homeOf(st);
      for (const [k, n] of Object.entries(st.fs)) if (n.type === 'file' && (k.startsWith(home + '/') || k.startsWith(st.cwd + '/') || k.startsWith('/tmp/') || k.startsWith('/etc/') || k.startsWith('/var/log/')) && canRead(st, n)) files[k] = n.content;
      files['/etc/passwd'] = (readFile(st, '/etc/passwd') as { content: string }).content;
      return { out: [], err: [], code: 0, pending: { kind: 'python', code, argv, cwd: st.cwd, user: st.user, files, display: ['python3', ...ctx.args].join(' ') } };
    },
  },
  python: { help: 'alias of python3', run: (ctx) => COMMANDS.python3.run(ctx) },
  pip: { help: 'Python package installer', run: (ctx) => (ctx.args[0] === 'install' ? ok([`Requirement already satisfied: ${ctx.args.slice(1).join(' ')} (the simulator ships the standard library only)`]) : ok(['pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)'])) },
  pip3: { help: 'Python package installer', run: (ctx) => COMMANDS.pip.run(ctx) },
};

/**
 * Split a sed script into commands. A ";" only separates commands outside a
 * substitution, so "s#a#b;#" stays one command.
 */
export function splitSedScript(script: string): string[] {
  const ops: string[] = [];
  let i = 0;
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
    if (i >= script.length) break;
    const start = i;
    const addr = script.slice(i).match(/^(\d+,\d+|\d+|\$|\/(?:[^/\\]|\\.)*\/)/);
    if (addr) i += addr[0].length;
    if (script[i] === 's' || script[i] === 'y') {
      const delim = script[i + 1];
      i += 2;
      let seen = 0;
      while (i < script.length && seen < 2) {
        if (script[i] === '\\') i++;
        else if (script[i] === delim) seen++;
        i++;
      }
      while (i < script.length && /[gIip0-9]/.test(script[i])) i++;
    } else while (i < script.length && script[i] !== ';') i++;
    const op = script.slice(start, i).trim();
    if (op) ops.push(op);
  }
  return ops;
}

function quoteArg(a: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function addrMatches(addr: string | undefined, index: number, total: number, line: string): boolean {
  if (!addr) return true;
  if (addr === '$') return index === total - 1;
  const range = addr.match(/^(\d+),(\d+)$/);
  if (range) return index + 1 >= Number(range[1]) && index + 1 <= Number(range[2]);
  if (/^\d+$/.test(addr)) return index + 1 === Number(addr);
  const re = addr.match(/^\/(.*)\/$/);
  if (re) return new RegExp(re[1]).test(line);
  return false;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}
function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function networkOf(ip: string, prefix: number): string {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return intToIp((ipToInt(ip) & mask) >>> 0);
}
function broadcast(ip: string, prefix: number): string {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return intToIp(((ipToInt(ip) & mask) | (~mask >>> 0)) >>> 0);
}

export const LINUX_COMMAND_NAMES = Object.keys(COMMANDS);
export type { NetworkState };
export { canExec };
