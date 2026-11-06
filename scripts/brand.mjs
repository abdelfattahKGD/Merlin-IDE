// Rebrands a Code - OSS checkout as "Merlin". Usage: node brand.mjs <vscode-dir> <branding-dir>
import fs from 'node:fs'; import path from 'node:path';
const [vs, br] = process.argv.slice(2);
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
for (const k of ['defaultChatAgent', 'trustedExtensionAuthAccess', 'voiceWsUrl', 'agentsTelemetryAppName', 'sessionsWindowAllowedExtensions']) delete p[k];
fs.writeFileSync(pj, JSON.stringify(p, null, '\t'));
const cp = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(path.join(br, a), path.join(vs, b)); };
cp('code-icon.svg', 'src/vs/workbench/browser/media/code-icon.svg');   // title bar + welcome page logo
for (const f of ['code-192.png', 'code-512.png', 'favicon.ico']) cp(f, 'resources/server/' + f);
const mf = path.join(vs, 'resources/server/manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.name = 'Merlin'; m.short_name = 'Merlin';
fs.writeFileSync(mf, JSON.stringify(m, null, '\t'));
console.log('branded as Merlin');
