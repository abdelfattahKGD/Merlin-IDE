// Rebrands a Code - OSS checkout as "Merlin". Usage: node brand.mjs <vscode-dir> <branding-dir>
import fs from 'node:fs'; import path from 'node:path';
const [vs, br, variant = 'full'] = process.argv.slice(2);
const pj = path.join(vs, 'product.json');
const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
Object.assign(p, {
  nameShort: 'Merlin', nameLong: 'Merlin', applicationName: 'merlin', dataFolderName: '.merlin',
  serverApplicationName: 'merlin-server', tunnelApplicationName: 'merlin-tunnel', reportIssueUrl: '',
  // Open VSX instead of Microsoft's Marketplace (whose terms don't allow other products)
  extensionsGallery: {
    serviceUrl: 'https://open-vsx.org/vscode/gallery', itemUrl: 'https://open-vsx.org/vscode/item',
    resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}', controlUrl: '', nlsBaseUrl: '',
  },
  builtInExtensions: [], builtInExtensionsEnabledWithAutoUpdates: [],
});
for (const k of ['trustedExtensionAuthAccess', 'voiceWsUrl', 'agentsTelemetryAppName', 'sessionsWindowAllowedExtensions']) delete p[k];
fs.writeFileSync(pj, JSON.stringify(p, null, '\t'));
const cp = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(path.join(br, a), path.join(vs, b)); };
cp('code-icon.svg', 'src/vs/workbench/browser/media/code-icon.svg');   // title bar + welcome page logo
for (const f of ['code-192.png', 'code-512.png', 'favicon.ico']) cp(f, 'resources/server/' + f);
const mf = path.join(vs, 'resources/server/manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.name = 'Merlin'; m.short_name = 'Merlin';
fs.writeFileSync(mf, JSON.stringify(m, null, '\t'));
// "slim" variant: drop built-in extensions that a phone IDE does not need (smaller bundle, fewer workers, less memory).
const SLIM_REMOVE = ['copilot', 'prompt-basics', 'git', 'git-base', 'github', 'github-authentication', 'microsoft-authentication',
  'typescript-language-features', 'html-language-features', 'css-language-features', 'json-language-features', 'php-language-features',
  'markdown-language-features', 'markdown-math', 'mermaid-markdown-features', 'emmet', 'ipynb', 'notebook-renderers', 'simple-browser',
  'search-result', 'references-view', 'terminal-suggest', 'tunnel-forwarding', 'merge-conflict', 'npm', 'grunt', 'gulp', 'jake',
  'extension-editing', 'debug-auto-launch', 'debug-server-ready'];
if (variant === 'slim') {
  const removed = [];
  for (const d of SLIM_REMOVE) {
    const dir = path.join(vs, 'extensions', d);
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(d); }
  }
  console.log('slim variant: removed built-in extensions:', removed.join(', '));
}
console.log('branded as Merlin (' + variant + ')');
