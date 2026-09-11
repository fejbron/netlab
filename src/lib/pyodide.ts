/**
 * Runs the python3 requests the simulated Linux shell hands back, using Pyodide
 * (CPython compiled to WebAssembly) loaded on demand from the jsDelivr CDN.
 * The script sees the host's text files at their real paths and any file it
 * writes under the home directory comes back into the virtual filesystem.
 */
import type { PendingPython, PythonResult } from '../engine';

const PYODIDE_VERSION = '0.26.4';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyodideFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string, opts?: { encoding: string }): void;
  readFile(path: string, opts: { encoding: string }): string;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
}

interface Pyodide {
  FS: PyodideFS;
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: { set(name: string, value: unknown): void };
}

declare global {
  interface Window {
    loadPyodide?: (options: { indexURL: string }) => Promise<Pyodide>;
  }
}

let loading: Promise<Pyodide> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

/** Load Pyodide once; later calls reuse the same interpreter. */
export function getPyodide(onStatus?: (text: string) => void): Promise<Pyodide> {
  if (!loading) {
    loading = (async () => {
      onStatus?.('Downloading Python (Pyodide, about 10 MB, first run only)…');
      if (!window.loadPyodide) await loadScript(`${INDEX_URL}pyodide.js`);
      onStatus?.('Starting the Python interpreter…');
      const py = await window.loadPyodide!({ indexURL: INDEX_URL });
      return py;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export function pythonAvailable(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function ensureDir(fs: PyodideFS, dir: string) {
  try {
    fs.mkdirTree(dir);
  } catch {
    /* exists */
  }
}

/** Every regular text file under `dir` in the Pyodide FS, by absolute path. */
function collect(fs: PyodideFS, dir: string, out: Record<string, string>, depth = 0) {
  if (depth > 6) return;
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    try {
      const st = fs.stat(path);
      if (fs.isDir(st.mode)) collect(fs, path, out, depth + 1);
      else {
        const text = fs.readFile(path, { encoding: 'utf8' });
        if (text.length <= 200_000) out[path] = text;
      }
    } catch {
      /* binary or unreadable */
    }
  }
}

function clearTree(fs: PyodideFS, dir: string) {
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    try {
      if (fs.isDir(fs.stat(path).mode)) {
        clearTree(fs, path);
        fs.rmdir(path);
      } else fs.unlink(path);
    } catch {
      /* ignore */
    }
  }
}

/** Run one pending python3 request and return what the shell needs to fold back. */
export async function runPython(pending: PendingPython, onStatus?: (text: string) => void): Promise<PythonResult> {
  const py = await getPyodide(onStatus);
  const fs = py.FS;
  const home = pending.user === 'root' ? '/root' : `/home/${pending.user}`;
  // Fresh view of the host's files.
  for (const dir of [home, '/tmp']) {
    ensureDir(fs, dir);
    clearTree(fs, dir);
  }
  ensureDir(fs, pending.cwd);
  for (const [path, content] of Object.entries(pending.files)) {
    ensureDir(fs, path.slice(0, path.lastIndexOf('/')) || '/');
    try {
      fs.writeFile(path, content, { encoding: 'utf8' });
    } catch {
      /* read-only location */
    }
  }
  let stdout = '';
  let stderr = '';
  py.setStdout({ batched: (t) => (stdout += t + '\n') });
  py.setStderr({ batched: (t) => (stderr += t + '\n') });
  py.globals.set('__netlab_code', pending.code);
  py.globals.set('__netlab_argv', pending.argv);
  py.globals.set('__netlab_cwd', pending.cwd);
  const wrapper = `
import sys, os, traceback, builtins
__netlab_exit = 0
os.chdir(__netlab_cwd)
sys.argv = list(__netlab_argv)
os.environ["HOME"] = ${JSON.stringify(home)}
os.environ["USER"] = ${JSON.stringify(pending.user)}
__g = {"__name__": "__main__", "__file__": sys.argv[0] if sys.argv and sys.argv[0] != "-c" else "<string>"}
try:
    exec(compile(__netlab_code, sys.argv[0] if sys.argv and sys.argv[0] != "-c" else "<string>", "exec"), __g)
except SystemExit as e:
    __netlab_exit = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    if isinstance(e.code, str):
        print(e.code, file=sys.stderr)
except BaseException:
    __netlab_exit = 1
    tb = traceback.format_exc().splitlines()
    # hide the wrapper frame
    tb = [l for l in tb if "<string>" not in l or "line" not in l or True]
    print("\\n".join(tb[0:1] + tb[3:]), file=sys.stderr)
__netlab_exit
`;
  let exitCode = 0;
  try {
    const r = await py.runPythonAsync(wrapper);
    exitCode = typeof r === 'number' ? r : Number(r) || 0;
  } catch (e) {
    stderr += (e instanceof Error ? e.message : String(e)) + '\n';
    exitCode = 1;
  }
  const files: Record<string, string> = {};
  collect(fs, home, files);
  collect(fs, '/tmp', files);
  if (!pending.cwd.startsWith(home) && pending.cwd !== '/tmp') collect(fs, pending.cwd, files);
  return { stdout, stderr, exitCode, files };
}
