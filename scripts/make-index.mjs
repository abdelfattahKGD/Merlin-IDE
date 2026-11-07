// Builds index.html for the static VS Code Web output (target "web": only the workbench, no browser shell).
// Usage: node make-index.mjs <vscode-dir (unused)> <vscode-web-dir>
import fs from 'node:fs'; import path from 'node:path';
const web = process.argv[3];
const wb = path.join(web, 'out/vs/workbench');
const list = fs.existsSync(wb) ? fs.readdirSync(wb) : [];
const find = re => list.find(f => re.test(f));
const js = find(/^workbench\.web\.main\.internal\.js$/) || find(/^workbench\.web\.main.*\.js$/);
const css = find(/^workbench\.web\.main\.internal\.css$/) || find(/^workbench\.web\.main.*\.css$/);
if (!js) throw new Error('workbench js not found in out/vs/workbench. Files: ' + list.filter(f => /web|main/.test(f)).join(', '));
const nls = fs.existsSync(path.join(web, 'out/nls.messages.js'));
const cfg = {
  callbackRoute: '/callback',
  enableWorkspaceTrust: false,
  productConfiguration: { embedderIdentifier: 'merlin-android' },
  configurationDefaults: {
    'workbench.colorTheme': 'Default Dark Modern',
    'telemetry.telemetryLevel': 'off',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
  },
};
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
<link rel="icon" href="/s/favicon.ico" type="image/x-icon" />
<link rel="apple-touch-icon" href="/s/code-192.png" />
<link rel="manifest" href="/s/manifest.json" />
${css ? `<link rel="stylesheet" href="/s/out/vs/workbench/${css}">` : '<!-- no workbench css found -->'}
<style>
html, body { height: 100%; margin: 0; background: #1f1f1f; }
#vscode-startup-fallback { visibility: hidden; animation: reveal 0s linear 10s forwards; position: fixed; inset: 0; z-index: 99999;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 24px;
  font-family: system-ui, sans-serif; color: #ccc; background: #1f1f1f; }
@keyframes reveal { to { visibility: visible; } }
#vscode-startup-fallback h1 { font-size: 16px; margin: 0 0 8px; }
#vscode-startup-fallback p { margin: 0; font-size: 13px; max-width: 52ch; }
</style>
</head>
<body aria-label="">
<div id="vscode-startup-fallback"><h1>The editor failed to load</h1><p>Merlin could not start the workbench.</p></div>
<script>globalThis._VSCODE_FILE_ROOT = location.origin + '/s/out/';</script>
${nls ? '<script type="module" src="/s/out/nls.messages.js"></script>' : ''}
<script type="module">
import { create } from '/s/out/vs/workbench/${js}';
const config = ${JSON.stringify(cfg)};
create(document.body, {
  ...config,
  windowIndicator: { label: '$(remote)', tooltip: 'Merlin' },
  workspaceProvider: { workspace: undefined, trusted: true, payload: Object.create(null), open: async () => false },
});
const t = setInterval(() => {
  if (document.querySelector('.monaco-workbench')) { document.getElementById('vscode-startup-fallback')?.remove(); clearInterval(t); }
}, 250);
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(web, 'index.html'), html);
console.log('index.html written. js:', js, 'css:', css, 'nls:', nls);
