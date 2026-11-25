// Runs Python (Pyodide = CPython compiled to WebAssembly) off the extension host.
// Classic worker: the web extension host wraps nested workers as classic blob workers.
const ROOT = 'http://127.0.0.1:18791';
const dec = new TextDecoder(), decErr = new TextDecoder();
const post = m => self.postMessage(m);
let pyodide = null, sid = '0', microReady = false, restored = false;

// Offline reuse: wheels/packages already downloaded are served from Cache Storage (network first for indexes).
const CACHEABLE = /^https:\/\/(cdn\.jsdelivr\.net|pypi\.org|files\.pythonhosted\.org)\//;
const realFetch = self.fetch ? self.fetch.bind(self) : null;
if (realFetch) self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!self.caches || !CACHEABLE.test(url) || (init && init.method && init.method !== 'GET')) return realFetch(input, init);
  const cache = await caches.open('merlin-pkgs');
  if (/\.(whl|zip|tar\.gz|wasm|so)(\?|$)/.test(url)) { const hit = await cache.match(url); if (hit) return hit; }
  try { const r = await realFetch(input, init); if (r.ok) cache.put(url, r.clone()).catch(() => {}); return r; }
  catch (e) { const hit = await cache.match(url); if (hit) return hit; throw e; }
};
// Installed requirement list (what the user ran "pip install" for), kept across restarts.
const META = 'https://merlin.invalid/pip-installed';
async function metaGet() {
  if (self.__merlinMeta) return self.__merlinMeta.slice();
  if (!self.caches) return [];
  try { const r = await (await caches.open('merlin-meta')).match(META); return r ? await r.json() : []; } catch (e) { return []; }
}
async function metaSet(list) {
  if (self.__merlinMeta) { self.__merlinMeta = list.slice(); return; }
  if (!self.caches) return;
  try { await (await caches.open('merlin-meta')).put(META, new Response(JSON.stringify(list))); } catch (e) { }
}

const WRAPPER = `
import runpy, sys, traceback, os
def _merlin_run(path, argv):
    sys.argv = list(argv)
    sys.path.insert(0, os.path.dirname(path))
    try:
        runpy.run_path(path, run_name='__main__')
        return 0
    except SystemExit as e:
        c = e.code
        if c is None: return 0
        if isinstance(c, int): return c
        print(c, file=sys.stderr)
        return 1
    except BaseException:
        et, ev, tb = sys.exc_info()
        while tb is not None and ('runpy' in tb.tb_frame.f_code.co_filename or tb.tb_frame.f_code.co_filename == '<exec>'):
            tb = tb.tb_next
        traceback.print_exception(et, ev, tb)
        return 1

async def _merlin_pip(op, specs):
    import micropip, json
    snap = lambda: {m.name: m.version for m in micropip.list().values()}
    before = snap()
    if op == 'install':
        await micropip.install(list(specs))
        import re
        have = {re.sub(r'[-_.]+', '-', k).lower() for k in snap()}
        for sp in specs:
            nm = re.sub(r'[-_.]+', '-', re.split(r'[<>=!~;\[ ]', sp)[0]).lower()
            if nm not in have:
                raise RuntimeError("could not download '" + sp + "' - check your internet connection")
    elif op == 'uninstall':
        micropip.uninstall(list(specs))
    after = snap()
    added = [[k, v] for k, v in after.items() if before.get(k) != v]
    removed = [k for k in before if k not in after]
    return json.dumps({'added': added, 'removed': removed, 'all': sorted(after.items())})
`;

// stdin: block (sync XHR) until the terminal sends a line; the server answers with the line text.
function readLine() {
  const x = new XMLHttpRequest();
  x.open('GET', ROOT + '/api/term/' + sid + '/pystdin', false);
  x.send();
  if (x.status !== 200 || x.responseText === '\u0000') return undefined; // EOF
  return x.responseText + '\n';
}

const loadPy = self.__merlinLoad || (async () => {
  const { loadPyodide } = await import(ROOT + '/s/pyodide/pyodide.mjs');
  return loadPyodide({ indexURL: ROOT + '/s/pyodide/', packageBaseUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/' });
});

const ready = (async () => {
  pyodide = await loadPy();
  pyodide.setStdout({ write: b => { post({ t: 'o', d: dec.decode(b, { stream: true }) }); return b.length; } });
  pyodide.setStderr({ write: b => { post({ t: 'o', d: '\x1b[31m' + decErr.decode(b, { stream: true }) + '\x1b[0m' }); return b.length; } });
  pyodide.setStdin({ stdin: () => readLine() });
  pyodide.runPython(WRAPPER);
  post({ t: 'ready' });
})().catch(e => post({ t: 'fatal', d: String((e && e.message) || e) }));

const norm = n => String(n).toLowerCase().replace(/[-_.]+/g, '-');
const specName = sp => norm(String(sp).split(/[<>=!~;\[ ]/)[0]);
const out = (d, color) => post({ t: 'o', d: color ? '\x1b[' + color + 'm' + d + '\x1b[0m' : d });
async function ensureMicropip() {
  if (microReady) return;
  await pyodide.loadPackage(['packaging', 'micropip'], { messageCallback: () => {}, errorCallback: m => out(m + '\n', '31') });
  pyodide.runPython('import micropip');
  microReady = true;
}
async function pipCall(op, specs) {
  await ensureMicropip();
  const r = await pyodide.globals.get('_merlin_pip')(op, pyodide.toPy(specs));
  return JSON.parse(r);
}
async function restore() {
  if (restored) return; restored = true;
  const list = await metaGet();
  if (!list.length) return;
  out('(restoring ' + list.length + ' installed package' + (list.length > 1 ? 's' : '') + '...)\n', '90');
  try { await pipCall('install', list); } catch (e) { out('could not restore packages: ' + lastLine(e) + '\n', '31'); }
}
const lastLine = e => String((e && e.message) || e).trim().split('\n').pop();

async function pip(m) {
  await ready;
  if (!pyodide) return post({ t: 'done', code: 1, changed: [], deleted: [] });
  sid = m.sid;
  const a = m.args.filter(x => x), op = (a[0] || '').toLowerCase(), rest = a.slice(1).filter(x => !x.startsWith('-'));
  let code = 0;
  try {
    if (op === 'install' && rest.length) {
      await restore();
      out('Installing ' + rest.join(' ') + ' ...\n', '90');
      const r = await pipCall('install', rest);
      out(r.added.length ? 'Successfully installed ' + r.added.map(x => x[0] + '-' + x[1]).join(' ') + '\n' : 'Requirement already satisfied\n');
      const saved = await metaGet(), names = new Set(rest.map(specName));
      await metaSet(saved.filter(x => !names.has(specName(x))).concat(rest));
    } else if (op === 'uninstall' && rest.length) {
      await restore();
      const r = await pipCall('uninstall', rest);
      out(r.removed.length ? 'Successfully uninstalled ' + r.removed.join(' ') + '\n' : 'Nothing to uninstall\n');
      const names = new Set(rest.map(specName));
      await metaSet((await metaGet()).filter(x => !names.has(specName(x))));
    } else if (op === 'list') {
      await restore();
      const r = await pipCall('list', []);
      out('Package'.padEnd(28) + 'Version\n' + '-'.repeat(40) + '\n' + r.all.map(x => x[0].padEnd(28) + x[1]).join('\n') + '\n');
    } else {
      out('Merlin pip: pip install <pkg> | pip uninstall <pkg> | pip list\n(pure-Python packages and the Pyodide set, e.g. numpy, pandas)\n');
    }
  } catch (e) {
    code = 1;
    const msg = lastLine(e);
    out('ERROR: ' + msg + '\n', '31');
    if (/pure Python|wheel/i.test(msg)) out('This package needs native code and is not available for Merlin\'s Python.\n', '33');
  }
  post({ t: 'done', code, changed: [], deleted: [] });
}

function rmrf(FS, p) {
  let st; try { st = FS.stat(p); } catch (e) { return; }
  if (FS.isDir(st.mode)) { for (const n of FS.readdir(p)) if (n !== '.' && n !== '..') rmrf(FS, p + '/' + n); FS.rmdir(p); } else FS.unlink(p);
}
function same(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

async function run(m) {
  try { await run1(m); }
  catch (e) { post({ t: 'o', d: '\x1b[31mMerlin Python error: ' + ((e && (e.message || e.name)) || e) + ' ' + ((e && e.errno) || '') + '\x1b[0m\n' }); post({ t: 'done', code: 1, changed: [], deleted: [] }); }
}
async function run1(m) {
  await ready;
  if (!pyodide) return post({ t: 'done', code: 1, changed: [], deleted: [] });
  sid = m.sid;
  await restore();
  // Packages shipped with Pyodide (numpy, pandas, ...) are loaded automatically when the script imports them.
  let n = 0;
  for (const f of m.files) {
    if (!f.path.endsWith('.py') || n++ >= 40) continue;
    try { await pyodide.loadPackagesFromImports(dec.decode(f.data), { messageCallback: x => out(x + '\n', '90'), errorCallback: x => out(x + '\n', '31') }); } catch (e) { }
  }
  const FS = pyodide.FS, snap = new Map();
  try { FS.chdir('/'); } catch (e) { }
  rmrf(FS, '/work'); FS.mkdirTree('/work');
  for (const f of m.files) {
    const p = '/work' + f.path;
    FS.mkdirTree(p.slice(0, p.lastIndexOf('/')) || '/');
    FS.writeFile(p, f.data); snap.set(p, f.data);
  }
  FS.chdir('/work' + m.cwd);
  let code = 1;
  try { code = pyodide.globals.get('_merlin_run')('/work' + m.script, [m.script.split('/').pop()].concat(m.args || [])); }
  catch (e) { post({ t: 'o', d: '\x1b[31m' + String((e && e.message) || e) + '\x1b[0m\n' }); }
  const now = new Map();
  (function walk(d) {
    for (const n of FS.readdir(d)) {
      if (n === '.' || n === '..' || n === '__pycache__') continue;
      const p = d + '/' + n;
      if (FS.isDir(FS.stat(p).mode)) walk(p); else now.set(p, FS.readFile(p));
    }
  })('/work');
  const changed = [], deleted = [];
  for (const [p, d] of now) { const o = snap.get(p); if (!o || !same(o, d)) changed.push({ path: p.slice(5), data: d }); }
  for (const p of snap.keys()) if (!now.has(p)) deleted.push(p.slice(5));
  post({ t: 'done', code, changed, deleted });
}

self.onmessage = e => {
  const d = e.data;
  if (d && d.t === 'run') run(d); else if (d && d.t === 'pip') pip(d).catch(x => { out('pip error: ' + lastLine(x) + '\n', '31'); post({ t: 'done', code: 1, changed: [], deleted: [] }); });
};
