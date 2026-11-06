// Builds index.html for the static VS Code Web output. Usage: node make-index.mjs <vscode-dir> <vscode-web-dir>
import fs from 'node:fs'; import path from 'node:path';
const [vs, web] = process.argv.slice(2);
let html = fs.readFileSync(path.join(vs, 'src/vs/code/browser/workbench/workbench.html'), 'utf8');
const cfg = {
  callbackRoute: '/s/out/vs/code/browser/workbench/callback.html',
  enableWorkspaceTrust: false,
  productConfiguration: { embedderIdentifier: 'merlin-android' },
  configurationDefaults: {
    'workbench.colorTheme': 'Default Dark Modern',
    'telemetry.telemetryLevel': 'off',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
  },
};
const attr = JSON.stringify(cfg).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const hasNls = fs.existsSync(path.join(web, 'out/nls.messages.js'));
html = html
  .replace(/<script type="module" src="\{\{WORKBENCH_NLS_URL\}\}"><\/script>\n?/, '')
  .replace(/<script type="module" src="\{\{WORKBENCH_NLS_FALLBACK_URL\}\}"><\/script>\n?/, hasNls ? '<script type="module" src="/s/out/nls.messages.js"></script>\n' : '')
  .replaceAll('{{WORKBENCH_WEB_CONFIGURATION}}', attr)
  .replaceAll('{{WORKBENCH_WEB_BASE_URL}}', '/s')
  .replaceAll('{{WORKBENCH_AUTH_SESSION}}', '')
  .replaceAll('{{WORKBENCH_SCRIPT_NONCE}}', '');
fs.writeFileSync(path.join(web, 'index.html'), html);
console.log('index.html written (nls fallback:', hasNls, ')');
