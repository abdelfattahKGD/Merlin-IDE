// C/C++ compiler (Clang 22 compiled to WebAssembly, "@live-codes/clang-wasm", MIT) in a classic worker.
// The 29 MB compiler pack is downloaded once on first use and then served from Cache Storage (works offline).
const ROOT = 'http://127.0.0.1:18791';
const BASES = self.__merlinBases || [
  'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.3.0/assets/',
  'https://unpkg.com/@live-codes/clang-wasm@0.3.0/assets/',
];
const post = m => self.postMessage(m);

// Cache downloaded assets (network first only for small files; big immutable ones are cache first).
const CACHEABLE = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|pypi\.org|files\.pythonhosted\.org)\//;
const realFetch = self.fetch ? self.fetch.bind(self) : null;
if (realFetch) self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input.url || String(input));
  if (!self.caches || !CACHEABLE.test(url) || (init && init.method && init.method !== 'GET')) return realFetch(input, init);
  const cache = await caches.open('merlin-pkgs');
  if (/\.(whl|zip|gz|wasm|so|tar)(\?|$)/.test(url)) { const hit = await cache.match(url); if (hit) return hit; }
  try { const r = await realFetch(input, init); if (r.ok) cache.put(url, r.clone()).catch(() => {}); return r; }
  catch (e) { const hit = await cache.match(url); if (hit) return hit; throw e; }
};

const compilers = {};
let loaded = false;
async function loadLib() {
  if (loaded || self.clangWasm) { loaded = true; return; }
  const src = await (await fetch(ROOT + '/s/clang/clang-wasm.global.js')).text();
  (0, eval)(src);
  if (!self.clangWasm) throw new Error('clang loader did not initialise');
  loaded = true;
}
async function getCompiler(lang) {
  await loadLib();
  if (compilers[lang]) return compilers[lang];
  let lastErr = null;
  for (const baseUrl of BASES) {
    try {
      compilers[lang] = await self.clangWasm.createCompiler(lang, {
        baseUrl, std: lang === 'c' ? 'gnu17' : 'gnu++20', onProgress: p => post({ t: 'progress', p }),
      });
      return compilers[lang];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('could not download the C/C++ pack');
}

async function run(m) {
  const c = await getCompiler(m.lang);
  const r = await c.run(m.code, m.input || '', { fileName: m.name, compileArgs: m.compileArgs || [], args: m.args || [] });
  if (r.errors && r.errors.length) post({ t: 'o', d: '\x1b[31m' + r.errors.join('\n') + '\x1b[0m\n' });
  else if (r.output) post({ t: 'o', d: r.output });
  post({ t: 'done', code: r.exitCode === null || r.exitCode === undefined ? 1 : r.exitCode });
}

self.onmessage = e => {
  const m = e.data;
  const fail = x => { post({ t: 'fatal', d: String((x && x.message) || x) }); };
  if (m && m.t === 'run') run(m).catch(fail);
  else if (m && m.t === 'install') getCompiler('c').then(() => post({ t: 'done', code: 0 })).catch(fail);
};
