// Merlin Core: real files (FileSystemProvider "merlin:") + shell terminal + Python (Pyodide) + Run.
const vscode = require('vscode');
const ORIGIN = 'http://127.0.0.1:18791';
const BASE = ORIGIN + '/api';
const dec = new TextDecoder();
const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

async function call(path, opts, uri) {
  const r = await fetch(BASE + path, opts || {});
  if (r.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
  if (r.status === 403) throw vscode.FileSystemError.FileExists(uri);
  if (!r.ok) throw vscode.FileSystemError.Unavailable(await r.text());
  return r;
}

let fsProvider = null;
// Tell the Explorer about changes through file events (silent). The "Refresh Explorer" command was removed on purpose:
// it also opens the sidebar, which re-opened it after every run and reset the panel size.
function emitChanges(created, changed, deleted) {
  if (!fsProvider) return;
  const U = p => vscode.Uri.from({ scheme: 'merlin', path: p });
  const ev = [];
  for (const p of created) ev.push({ type: vscode.FileChangeType.Created, uri: U(p) });
  for (const p of changed) ev.push({ type: vscode.FileChangeType.Changed, uri: U(p) });
  for (const p of deleted) ev.push({ type: vscode.FileChangeType.Deleted, uri: U(p) });
  if (ev.length) fsProvider._e.fire(ev.slice(0, 500));
}
async function snapshotTree() {
  try { return new Map(await (await fetch(BASE + '/fs/tree')).json()); } catch (e) { return null; }
}
function emitDiff(before, after) {
  const created = [], deleted = [];
  for (const [p] of after) if (!before.has(p)) created.push(p);
  for (const [p] of before) if (!after.has(p)) deleted.push(p);
  emitChanges(created, [], deleted);
}
let nativeChecked = 0, nativeInstalled = false;
async function pythonInstalled(force) {
  if (!force && Date.now() - nativeChecked < 3000) return nativeInstalled;
  try { nativeInstalled = !!(await (await fetch(BASE + '/pack/python/status')).json()).installed; } catch (e) { nativeInstalled = false; }
  nativeChecked = Date.now();
  return nativeInstalled;
}

class MerlinFS {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeFile = this._e.event; fsProvider = this; }
  watch() { return new vscode.Disposable(() => {}); }
  async stat(uri) { const j = await (await call('/fs/stat?' + qs({ p: uri.path }), {}, uri)).json(); return { type: j.type, size: j.size, mtime: j.mtime, ctime: j.ctime }; }
  async readDirectory(uri) { return (await call('/fs/list?' + qs({ p: uri.path }), {}, uri)).json(); }
  async readFile(uri) { return new Uint8Array(await (await call('/fs/read?' + qs({ p: uri.path }), {}, uri)).arrayBuffer()); }
  async writeFile(uri, content, o) {
    await call('/fs/write?' + qs({ p: uri.path, create: o.create ? 1 : 0, overwrite: o.overwrite ? 1 : 0 }),
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content }, uri);
  }
  async delete(uri) { await call('/fs/delete?' + qs({ p: uri.path }), { method: 'POST' }, uri); }
  async rename(a, b, o) { await call('/fs/rename?' + qs({ from: a.path, to: b.path, overwrite: o.overwrite ? 1 : 0 }), { method: 'POST' }, a); }
  async createDirectory(uri) { await call('/fs/mkdir?' + qs({ p: uri.path }), { method: 'POST' }, uri); }
}

// C/C++ pack helpers (the compiler itself lives in cworker.js; its 29 MB assets are cached in Cache Storage).
async function packKeys() { try { return (await (await caches.open('merlin-pkgs')).keys()).filter(r => r.url.includes('clang-wasm')); } catch (e) { return []; } }
async function packCached() { return (await packKeys()).some(r => r.url.includes('clang.wasm.gz')); }
async function installPack() {
  const w = new Worker(ORIGIN + '/s/merlin-core/cworker.js');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Merlin: C/C++ pack (about 29 MB)' }, progress => new Promise(resolve => {
    let last = 0;
    w.onmessage = ev => {
      const m = ev.data;
      if (m.t === 'progress') { progress.report({ increment: Math.max(0, m.p - last) * 100, message: Math.round(m.p * 100) + '%' }); last = m.p; }
      else if (m.t === 'done' || m.t === 'fatal') {
        w.terminate();
        if (m.t === 'fatal') vscode.window.showErrorMessage('C/C++ pack failed: ' + m.d + ' (internet is needed for the first download)');
        else vscode.window.showInformationMessage('C/C++ pack is ready and works offline from now on.');
        resolve();
      }
    };
    w.onerror = ev => { w.terminate(); vscode.window.showErrorMessage('C/C++ pack: worker error ' + (ev.message || '')); resolve(); };
    w.postMessage({ t: 'install' });
  }));
}
async function installPython() {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Merlin: native Python pack' }, async progress => {
    try {
      let st = await (await fetch(BASE + '/pack/python/status')).json();
      if (st.installed) { vscode.window.showInformationMessage('Native Python pack is already installed.'); return; }
      await fetch(BASE + '/pack/python/install', { method: 'POST' });
      let last = 0;
      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        st = await (await fetch(BASE + '/pack/python/status')).json();
        if (st.state === 'error') throw new Error(st.error || 'failed');
        progress.report({ increment: Math.max(0, st.percent - last), message: st.state + ' ' + st.percent + '%' }); last = st.percent;
        if (st.state === 'done' || st.installed) break;
      }
      await pythonInstalled(true);
      vscode.window.showInformationMessage('Native Python is ready: python file.py and pip now use it.');
    } catch (e) { vscode.window.showErrorMessage('Python pack failed: ' + e.message); }
  });
}
async function removePython() {
  try { await fetch(BASE + '/pack/python/remove', { method: 'POST' }); await pythonInstalled(true); vscode.window.showInformationMessage('Native Python pack removed (the built-in Python stays).'); }
  catch (e) { vscode.window.showErrorMessage('Could not remove the pack: ' + e.message); }
}
async function removePack() {
  try { const c = await caches.open('merlin-pkgs'); const ks = await packKeys(); for (const k of ks) await c.delete(k); vscode.window.showInformationMessage('C/C++ pack removed (' + ks.length + ' files).'); }
  catch (e) { vscode.window.showErrorMessage('Could not remove the pack: ' + e.message); }
}

let root = null;
async function getRoot() { if (!root) root = (await (await fetch(BASE + '/info')).json()).root; return root; }

function normPath(p) {
  const out = [];
  for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  return '/' + out.join('/');
}

// Copies the script's folder (text and binary) into the Python worker, and back afterwards.
async function collect(dir) {
  const files = []; let total = 0;
  async function walk(p) {
    const r = await fetch(BASE + '/fs/list?' + qs({ p }));
    if (!r.ok) return;
    for (const [name, type] of await r.json()) {
      if (SKIP.has(name)) continue;
      const child = (p === '/' ? '' : p) + '/' + name;
      if (type === 2) await walk(child);
      else if (files.length < 400) {
        const data = new Uint8Array(await (await fetch(BASE + '/fs/read?' + qs({ p: child }))).arrayBuffer());
        total += data.length; if (total > 40e6) throw new Error('folder too large for Python (40 MB max)');
        files.push({ path: child, data });
      }
    }
  }
  await walk(dir);
  return files;
}

// Terminal: each line runs as a shell command (cd handled by the server). "python file.py" runs in Pyodide.
// While something runs, typed lines go to its stdin.
function makeTerminal() {
  const out = new vscode.EventEmitter(), closed = new vscode.EventEmitter();
  let id = null, line = '', cwd = '', busy = false, pyBusy = false, worker = null, resolveReady;
  let cBusy = false, cworker = null, inputJob = null, cCached = false, lastPct = -1;
  const ready = new Promise(r => { resolveReady = r; });
  const post = (p, body) => fetch(BASE + p, { method: 'POST', body: body === undefined ? '' : body });
  const write = s => out.fire(String(s).replace(/\r?\n/g, '\r\n'));
  const prompt = () => out.fire('\x1b[32m' + (cwd.split('/').pop() || '/') + '\x1b[0m $ ');
  let treeBefore = null, pySent = new Set();
  const refresh = async () => {
    if (!treeBefore) return;
    const b = treeBefore; treeBefore = null;
    const a = await snapshotTree();
    if (a) emitDiff(b, a);
  };

  function handle(ev) {
    if (ev.t === 'o') write(ev.d);
    else if (ev.t === 'x') { cwd = ev.cwd; busy = false; prompt(); refresh(); }
  }
  async function pump() {
    const reader = (await fetch(BASE + '/term/' + id + '/out')).body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, i); buf = buf.slice(i + 1); if (s) handle(JSON.parse(s)); }
    }
  }

  // ---- Python (Pyodide in a Worker) ----
  function pyDone() { pyBusy = false; busy = false; prompt(); refresh(); }
  async function onPy(m) {
    if (m.t === 'o') write(m.d);
    else if (m.t === 'fatal') { write('\x1b[31mCould not start Python: ' + m.d + '\x1b[0m\n'); killPy(); pyDone(); }
    else if (m.t === 'done') {
      try {
        for (const f of m.changed) await fetch(BASE + '/fs/write?' + qs({ p: f.path, create: 1, overwrite: 1 }), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: f.data });
        for (const p of m.deleted) await fetch(BASE + '/fs/delete?' + qs({ p }), { method: 'POST' });
        emitChanges(m.changed.filter(f => !pySent.has(f.path)).map(f => f.path), m.changed.filter(f => pySent.has(f.path)).map(f => f.path), m.deleted);
      } catch (e) { write('\x1b[31mcould not save files: ' + e.message + '\x1b[0m\n'); }
      pyDone();
    }
  }
  function killPy() { if (worker) { worker.terminate(); worker = null; } post('/term/' + id + '/pyreset'); }
  function getWorker() {
    if (worker) return worker;
    write('\x1b[90m(starting Python...)\x1b[0m\n');
    worker = new Worker(ORIGIN + '/s/merlin-core/pyworker.js');
    worker.onmessage = ev => onPy(ev.data);
    worker.onerror = ev => { write('\x1b[31mPython worker error: ' + (ev.message || 'unknown') + '\x1b[0m\n'); killPy(); pyDone(); };
    return worker;
  }
  async function runPip(argstr) {
    pyBusy = busy = true;
    try { await post('/term/' + id + '/pyreset'); getWorker().postMessage({ t: 'pip', sid: id, args: argstr.trim().split(/\s+/) }); }
    catch (e) { write('\x1b[31m' + e.message + '\x1b[0m\n'); killPy(); pyDone(); }
  }
  async function runPy(rest) {
    const m = /^(?:'([^']*)'|"([^"]*)"|(\S+))(?:\s+(.*))?$/.exec(rest.trim());
    if (!m || (m[3] || '').startsWith('-')) { write('Merlin Python runs files only: python file.py [args]\n'); return pyDone(); }
    const tok = m[1] || m[2] || m[3], args = m[4] ? m[4].split(/\s+/) : [];
    const rt = await getRoot();
    const abs = normPath(tok.startsWith('/') ? tok : (cwd || rt) + '/' + tok);
    if (!abs.startsWith(rt + '/')) { write("python: can't open '" + tok + "' (outside the workspace)\n"); return pyDone(); }
    const ws = abs.slice(rt.length);
    if (!(await fetch(BASE + '/fs/stat?' + qs({ p: ws }))).ok) { write("python: can't open file '" + tok + "': No such file\n"); return pyDone(); }
    pyBusy = busy = true;
    try {
      await post('/term/' + id + '/pyreset');
      const dir = ws.slice(0, ws.lastIndexOf('/')) || '/';
      const files = await collect(dir);
      pySent = new Set(files.map(f => f.path));
      getWorker();
      worker.postMessage({ t: 'run', sid: id, files, cwd: dir, script: ws, args });
    } catch (e) { write('\x1b[31m' + e.message + '\x1b[0m\n'); killPy(); pyDone(); }
  }

  // ---- C / C++ (Clang compiled to WebAssembly) ----
  function cDone() { cBusy = false; busy = false; prompt(); refresh(); }
  function killC() { if (cworker) { cworker.terminate(); cworker = null; } }
  function onC(m) {
    if (m.t === 'progress') {
      const pct = Math.floor(m.p * 4) * 25;
      if (pct !== lastPct) {
        if (lastPct < 0) write(cCached ? '\x1b[90m(loading the C/C++ compiler...)\x1b[0m\n' : '\x1b[90m(downloading the C/C++ compiler pack, about 29 MB, first time only)\x1b[0m\n');
        lastPct = pct; if (!cCached) write('\x1b[90m  ' + pct + '%\x1b[0m\n');
      }
    } else if (m.t === 'o') write(m.d);
    else if (m.t === 'fatal') { write('\x1b[31mC/C++ compiler error: ' + m.d + '\x1b[0m\n\x1b[90m(the first run needs internet to download the pack)\x1b[0m\n'); killC(); cDone(); }
    else if (m.t === 'done') { if (m.code) write('\x1b[90m[exit ' + m.code + ']\x1b[0m\n'); killC(); cDone(); }
  }
  async function startC(job, input) {
    cBusy = busy = true; lastPct = -1;
    if (worker) { worker.terminate(); worker = null; }   // free the Python worker's memory while the compiler runs
    try {
      cCached = await packCached();
      if (!cworker) {
        cworker = new Worker(ORIGIN + '/s/merlin-core/cworker.js');
        cworker.onmessage = ev => onC(ev.data);
        cworker.onerror = ev => { write('\x1b[31mC worker error: ' + (ev.message || 'unknown') + '\x1b[0m\n'); killC(); cDone(); };
      }
      cworker.postMessage({ t: 'run', lang: job.lang, name: job.name, code: job.code, input, compileArgs: job.compileArgs, args: [] });
    } catch (e) { write('\x1b[31m' + e.message + '\x1b[0m\n'); killC(); cDone(); }
  }
  const NEEDS_INPUT = /\b(scanf|fscanf|gets|fgets|getchar|getc|getline|cin)\b/;
  async function runC(kind, rest) {
    const toks = (rest.match(/'[^']*'|"[^"]*"|\S+/g) || []).map(t => t.replace(/^(['"])(.*)\1$/, '$2'));
    const compileArgs = []; let src = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-o') { i++; continue; }
      if (t.startsWith('-l')) continue;            // libc and libm are built in
      if (t.startsWith('-')) { compileArgs.push(t); continue; }
      if (/\.(c|cpp|cc|cxx)$/i.test(t) && !src) src = t;
    }
    if (!src) { write('usage: gcc file.c   (g++ file.cpp for C++)\n'); return cDone(); }
    const rt = await getRoot();
    const abs = normPath(src.startsWith('/') ? src : (cwd || rt) + '/' + src);
    if (!abs.startsWith(rt + '/')) { write(kind + ": error: '" + src + "' is outside the workspace\n"); return cDone(); }
    const r = await fetch(BASE + '/fs/read?' + qs({ p: abs.slice(rt.length) }));
    if (!r.ok) { write(kind + ': error: ' + src + ': No such file\n'); return cDone(); }
    const code = await r.text();
    const lang = (/\+\+/.test(kind) || !/\.c$/.test(src)) ? 'cpp' : 'c';
    const name = abs.split('/').pop().replace(/\.[^.]*$/, '') + (lang === 'c' ? '.c' : '.cpp');
    const job = { lang, name, code, compileArgs, lines: [] };
    busy = true;
    if (NEEDS_INPUT.test(code)) { inputJob = job; write('\x1b[90m(this program reads input: type its input lines, then an empty line to run)\x1b[0m\n'); return; }
    return startC(job, '');
  }

  const send = async text => {
    if (inputJob) { if (text === '') { const j = inputJob; inputJob = null; return startC(j, j.lines.join('\n') + (j.lines.length ? '\n' : '')); } inputJob.lines.push(text); return; }
    if (cBusy) return;
    if (pyBusy) return post('/term/' + id + '/pyin', text);
    if (/^\s*(?:python3?|pip3?)(?:\s|$)/.test(text) && await pythonInstalled()) {
      if (/^\s*python3?\s*$/.test(text)) { write('python: the interactive prompt needs a real terminal here - run a file: python file.py\n'); return pyDone(); }
      treeBefore = await snapshotTree(); busy = true; return post('/term/' + id + '/in', text);   // native Python from the pack
    }
    const pp = /^\s*(?:python3?\s+-m\s+)?pip3?(?:\s+(.*))?$/.exec(text);
    if (pp) return runPip(pp[1] || '');
    const py = /^\s*python3?(?:\s+(.*))?$/.exec(text);
    if (py) { if (!py[1]) { write('Merlin Python runs files only: python file.py\n'); return pyDone(); } return runPy(py[1]); }
    const cc = /^\s*(gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:\s+(.*))?$/.exec(text);
    if (cc) { if (!cc[2]) { write('usage: ' + cc[1] + ' file.c\n'); return cDone(); } return runC(cc[1], cc[2]); }
    treeBefore = await snapshotTree(); busy = true; return post('/term/' + id + '/in', text);
  };
  const pty = {
    onDidWrite: out.event, onDidClose: closed.event,
    async open() {
      out.fire('Merlin shell - lines run as commands, "python file.py" runs Python, "pip install x" adds packages, "gcc file.c" runs C, Ctrl+C stops\r\n');
      id = (await (await post('/term/start')).json()).id;
      pump(); resolveReady();
    },
    close() { if (worker) { worker.terminate(); worker = null; } killC(); if (id) post('/term/' + id + '/close'); },
    handleInput(d) {
      if (d.charCodeAt(0) === 27) return; // ignore arrows / escape sequences
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') { out.fire('\r\n'); const t = line; line = ''; send(t); }
        else if (ch === '\x7f') { if (line.length) { line = line.slice(0, -1); out.fire('\b \b'); } }
        else if (ch === '\x03') {
          out.fire('^C\r\n'); line = '';
          if (inputJob) { inputJob = null; busy = false; prompt(); }
          else if (cBusy) { killC(); cDone(); }
          else if (pyBusy) { killPy(); pyDone(); } else if (busy) post('/term/' + id + '/kill'); else prompt();
        }
        else if (ch >= ' ') { line += ch; out.fire(ch); }
      }
    },
  };
  return { pty, ready, run: cmd => { out.fire(cmd + '\r\n'); return send(cmd); }, isBusy: () => busy };
}

let current = null;

function activate(context) {
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('merlin', new MerlinFS(), { isCaseSensitive: true }));
  context.subscriptions.push(vscode.window.registerTerminalProfileProvider('merlin.shell', {
    provideTerminalProfile() { return new vscode.TerminalProfile({ name: 'Merlin', pty: makeTerminal().pty }); },
  }));
  context.subscriptions.push(vscode.window.onDidCloseTerminal(t => { if (current && current.term === t) current = null; }));

  context.subscriptions.push(vscode.commands.registerCommand('merlin.run', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'merlin') return vscode.window.showWarningMessage('Open a file from the Merlin workspace first.');
    if (ed.document.isDirty) await ed.document.save();
    const abs = (await getRoot()) + ed.document.uri.path;
    const ext = abs.split('.').pop().toLowerCase();
    const runners = { sh: 'sh', py: 'python', c: 'gcc', cpp: 'g++', cc: 'g++', cxx: 'g++' };
    if (!runners[ext]) return vscode.window.showInformationMessage('Merlin cannot run ".' + ext + '" files yet.');
    if (!current) { const t = makeTerminal(); current = { t, term: vscode.window.createTerminal({ name: 'Merlin', pty: t.pty }) }; }
    current.term.show(true);
    await current.t.ready;
    if (current.t.isBusy()) return vscode.window.showInformationMessage('A command is still running (Ctrl+C in the terminal stops it).');
    await current.t.run(runners[ext] + ' ' + sq(abs));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.installPython', installPython));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.removePython', removePython));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.installC', installPack));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.removeC', removePack));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.stop', () => {
    if (current) current.term.sendText('\x03', false);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
