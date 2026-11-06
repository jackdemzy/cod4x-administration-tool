import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-b3-integration.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}
const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';

const data = (overrides = {}) => ({
  settings: { hideCommands: true, prefix: '!', hideLevel: 20 },
  plan: { enabled: true, blockers: [{ code: 'B3HIDE_NOT_APPROVED' }, { code: 'RCON_PASSWORD_MISSING' }], warnings: [] },
  b3hide: { state: 'NOT_APPROVED', sha256: 'a'.repeat(64) }, knownHash: true,
  restart: { server: 'SETTINGS_CHANGED', b3: 'CREDENTIALS_CHANGED' }, authLevels: [100], vault: { locked: false, initialized: true },
  // A leaked value in the props must still never be rendered.
  leaked: 'hunter22', ...overrides,
});
const panel = async (props) => (await renderer())('B3IntegrationPanel', { de: true, busy: false, onSave: () => {}, onSetPassword: () => {}, ...props });

test('B3 integration panel: switch, prefix, level names, password rows and no password value', { skip }, async () => {
  const html = await panel({ data: data(), canManage: true });
  assert.match(html, /B3-Befehle ausblenden/);
  assert.match(html, /maxLength="1"|maxlength="1"/i);
  assert.match(html, /20 – Moderator/);
  assert.match(html, /100 – Super admin/);
  assert.match(html, /type="password"/);
  assert.match(html, /gesetzt/);
  assert.ok(!html.includes('hunter22'));
});

test('B3 integration panel: blockers, restart hints and disabled controls without config.manage', { skip }, async () => {
  const html = await panel({ data: data(), canManage: false });
  assert.match(html, /SHA-256 ist nicht freigegeben/);
  assert.match(html, /RCON-Passwort fehlt im Tresor/);
  assert.match(html, /Server neu starten/);
  assert.match(html, /B3 neu starten/);
  assert.ok((html.match(/disabled=""/g) || []).length >= 3);
  const en = await (await renderer())('B3IntegrationPanel', { de: false, busy: false, data: data(), canManage: true, onSave: () => {}, onSetPassword: () => {} });
  assert.match(en, /Hide B3 commands/);
  assert.match(en, /its SHA-256 is not approved/);
});
