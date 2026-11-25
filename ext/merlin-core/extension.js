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

class MerlinFS {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeFile = this._e.event; }
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
  const ready = new Promise(r => { resolveReady = r; });
  const post = (p, body) => fetch(BASE + p, { method: 'POST', body: body === undefined ? '' : body });
  const write = s => out.fire(String(s).replace(/\r?\n/g, '\r\n'));
  const prompt = () => out.fire('\x1b[32m' + (cwd.split('/').pop() || '/') + '\x1b[0m $ ');
  const refresh = () => vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

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
      getWorker();
      worker.postMessage({ t: 'run', sid: id, files, cwd: dir, script: ws, args });
    } catch (e) { write('\x1b[31m' + e.message + '\x1b[0m\n'); killPy(); pyDone(); }
  }

  const send = async text => {
    if (pyBusy) return post('/term/' + id + '/pyin', text);
    const pp = /^\s*(?:python3?\s+-m\s+)?pip3?(?:\s+(.*))?$/.exec(text);
    if (pp) return runPip(pp[1] || '');
    const py = /^\s*python3?(?:\s+(.*))?$/.exec(text);
    if (py) { if (!py[1]) { write('Merlin Python runs files only: python file.py\n'); return pyDone(); } return runPy(py[1]); }
    busy = true; return post('/term/' + id + '/in', text);
  };
  const pty = {
    onDidWrite: out.event, onDidClose: closed.event,
    async open() {
      out.fire('Merlin shell - lines run as commands, "python file.py" runs Python, "pip install x" adds packages, Ctrl+C stops\r\n');
      id = (await (await post('/term/start')).json()).id;
      pump(); resolveReady();
    },
    close() { if (worker) { worker.terminate(); worker = null; } if (id) post('/term/' + id + '/close'); },
    handleInput(d) {
      if (d.charCodeAt(0) === 27) return; // ignore arrows / escape sequences
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') { out.fire('\r\n'); const t = line; line = ''; send(t); }
        else if (ch === '\x7f') { if (line.length) { line = line.slice(0, -1); out.fire('\b \b'); } }
        else if (ch === '\x03') {
          out.fire('^C\r\n'); line = '';
          if (pyBusy) { killPy(); pyDone(); } else if (busy) post('/term/' + id + '/kill'); else prompt();
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
    const runners = { sh: 'sh', py: 'python' };
    if (!runners[ext]) return vscode.window.showInformationMessage('Merlin cannot run ".' + ext + '" files yet.');
    if (!current) { const t = makeTerminal(); current = { t, term: vscode.window.createTerminal({ name: 'Merlin', pty: t.pty }) }; }
    current.term.show(true);
    await current.t.ready;
    if (current.t.isBusy()) return vscode.window.showInformationMessage('A command is still running (Ctrl+C in the terminal stops it).');
    await current.t.run(runners[ext] + ' ' + sq(abs));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('merlin.stop', () => {
    if (current) current.term.sendText('\x03', false);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
