import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-b3-plugins.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}
const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';

const HASH = 'b'.repeat(64);
const row = (overrides = {}) => ({ name: 'welcome', source: 'shipped', enabled: false, sha256: null, expectedSha256: null, configType: 'ini', requires: [], reason: null, state: 'DISABLED', ...overrides });
const data = (overrides = {}) => ({
  plugins: [
    row({ name: 'welcome', enabled: true, state: 'ENABLED' }),
    row({ name: 'duel', enabled: true, state: 'NOT_APPROVED', sha256: HASH, reason: 'B3_PLUGIN_NOT_APPROVED' }),
    row({ name: 'myplug', source: 'custom', state: 'DISABLED' }),
    row({ name: 'admin', source: 'fixed', state: 'UNAVAILABLE', reason: 'B3_PLUGIN_FIXED' }),
  ],
  revision: 3, restart: null,
  // A leaked value in the props must still never be rendered.
  configText: 'token = SECRET-123', ...overrides,
});
const noop = () => {};
const panel = async (props) => (await renderer())('B3PluginsPanel', { de: true, busy: false, permissions: { manage: true, code: true }, onToggle: noop, onApprove: noop, onOpenConfig: noop, onOpenCode: noop, onSaveEditor: noop, onCloseEditor: noop, onCreate: noop, onDelete: noop, ...props });

test('B3 plugins panel: table with states, full hash for NOT_APPROVED and the fixed reason', { skip }, async () => {
  const html = await panel({ data: data() });
  for (const name of ['welcome', 'duel', 'myplug', 'admin']) assert.match(html, new RegExp(`<td>${name}</td>`));
  assert.ok(html.includes(HASH), 'full 64-character hash visible');
  assert.match(html, /Aktiv/);
  assert.match(html, /Nicht freigegeben/);
  assert.match(html, /Dieses B3-Plugin ist fest vorgegeben und nicht verwaltbar\./);
  assert.match(html, /Ich habe diese Datei geprüft und vertraue ihr/);
  const en = await panel({ data: data(), de: false });
  assert.match(en, /I checked this file and trust it/);
  assert.match(en, /This B3 plugin is fixed and cannot be managed\./);
});

test('B3 plugins panel: code area only with the code permission', { skip }, async () => {
  const without = await panel({ data: data(), permissions: { manage: true, code: false } });
  assert.doesNotMatch(without, /Neues Plugin aus Vorlage/);
  assert.doesNotMatch(without, /Dieser Code läuft mit den Rechten des B3-Prozesses\./);
  const withCode = await panel({ data: data(), permissions: { manage: true, code: true } });
  assert.match(withCode, /Neues Plugin aus Vorlage/);
  assert.match(withCode, /Dieser Code läuft mit den Rechten des B3-Prozesses\./);
  assert.match(withCode, /type="file"[^>]*accept="\.py"|accept="\.py"[^>]*type="file"/);
  const en = await panel({ data: data(), de: false });
  assert.match(en, /This code runs with the rights of the B3 process\./);
});

test('B3 plugins panel: no config or code text without the matching permission', { skip }, async () => {
  const noManage = { manage: false, code: false };
  assert.ok(!(await panel({ data: data(), permissions: noManage })).includes('SECRET-123'));
  const editor = { kind: 'config', name: 'myplug', text: 'token = SECRET-123', sha256: HASH };
  assert.ok(!(await panel({ data: data(), permissions: noManage, editor })).includes('SECRET-123'), 'config editor needs manage');
  assert.ok(!(await panel({ data: data(), permissions: { manage: true, code: false }, editor: { ...editor, kind: 'code', text: 'SECRET-CODE' } })).includes('SECRET-CODE'), 'code editor needs code');
  const shown = await panel({ data: data(), permissions: { manage: true, code: false }, editor });
  assert.ok(shown.includes('SECRET-123') && /<textarea/.test(shown) && /monospace/.test(shown));
  const code = await panel({ data: data(), editor: { ...editor, kind: 'code', text: 'SECRET-CODE' } });
  assert.ok(code.includes('SECRET-CODE'));
});

test('B3 plugins panel: restart hint', { skip }, async () => {
  assert.match(await panel({ data: data({ restart: 'PLUGINS_CHANGED' }) }), /Plugin-Änderungen wirken erst nach einem B3-Neustart\./);
  assert.doesNotMatch(await panel({ data: data() }), /Plugin-Änderungen wirken erst/);
});
