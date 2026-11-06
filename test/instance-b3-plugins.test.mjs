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

test('B3 plugins panel: the trust tick is bound to name and hash', { skip }, async () => {
  const HASH_A = 'a'.repeat(64);
  const one = sha => ({ plugins: [row({ name: 'duel', enabled: true, state: 'NOT_APPROVED', sha256: sha, reason: 'B3_PLUGIN_NOT_APPROVED' })], revision: 1, restart: null });
  const render = await renderer();
  const props = initialTrusted => ({ de: true, busy: false, permissions: { manage: true, code: true }, onToggle: noop, onApprove: noop, onOpenConfig: noop, onOpenCode: noop, onSaveEditor: noop, onCloseEditor: noop, onCreate: noop, onDelete: noop, onReloadEditor: noop, initialTrusted });
  const ticked = { [`duel:${HASH_A}`]: true };
  const same = render('B3PluginsPanel', { ...props(ticked), data: one(HASH_A) });
  assert.match(same, /checked=""/);
  assert.doesNotMatch(same.match(/<button[^>]*>Freigeben/)[0], /disabled/);
  const changed = render('B3PluginsPanel', { ...props(ticked), data: one(HASH) });
  assert.doesNotMatch(changed, /checked=""/, 'tick for hash A does not carry over to hash B');
  assert.match(changed.match(/<button[^>]*>Freigeben/)[0], /disabled/);
});

test('B3 plugins panel: stale save shows the file-changed text and a reload button, de/en', { skip }, async () => {
  const editor = { kind: 'config', name: 'myplug', text: 'my draft', sha256: HASH, conflict: true };
  const de = await panel({ data: data(), editor });
  assert.match(de, /Datei wurde inzwischen geändert – neu laden/);
  assert.doesNotMatch(de, /bereits vergeben/);
  assert.match(de, /<button[^>]*>Neu laden/);
  const en = await panel({ data: data(), de: false, editor });
  assert.match(en, /File changed meanwhile – reload/);
  assert.match(en, /<button[^>]*>Reload/);
  assert.doesNotMatch(await panel({ data: data(), editor: { ...editor, conflict: false } }), /Neu laden/);
  const approve = await panel({ data: data(), staleList: true });
  assert.match(approve, /Datei wurde inzwischen geändert – neu laden/);
  assert.match(approve, /<button[^>]*>Neu laden/);
});

test('B3 plugins panel: requirements column, missing-plugin warning and module path', { skip }, async () => {
  const req = (plugins, pythonModules = []) => ({ plugins, pythonModules });
  const rows = [
    row({ name: 'geolocation', enabled: false, state: 'DISABLED', requires: req([], ['requests']) }),
    row({ name: 'countryfilter', requires: req(['geolocation']) }),
    row({ name: 'geowelcome', enabled: true, state: 'ENABLED', requires: req(['geolocation', 'admin']) }),
    row({ name: 'admin', source: 'fixed', state: 'UNAVAILABLE', reason: 'B3_PLUGIN_FIXED', modulePath: null }),
    row({ name: 'duel', enabled: true, state: 'NOT_APPROVED', sha256: HASH, modulePath: 'b3/plugins/duel' }),
  ];
  const html = await panel({ data: data({ plugins: rows }) });
  assert.match(html, /Voraussetzungen/);
  assert.match(html, /Python: requests – Python-Module werden beim B3-Start geprüft./);
  assert.match(html, /role="alert">Das B3-Plugin benötigt ein anderes Plugin, das nicht aktiviert ist\. \(geolocation\)/);
  assert.equal((html.match(/benötigt ein anderes Plugin/g) || []).length, 2, 'geolocation missing for both dependants; admin is fixed');
  assert.match(html, /<code>b3\/plugins\/duel<\/code>/);
  const ok = await panel({ data: data({ plugins: [row({ name: 'geolocation', enabled: true, state: 'ENABLED' }), row({ name: 'geowelcome', enabled: true, state: 'ENABLED', requires: req(['geolocation']) })] }) });
  assert.doesNotMatch(ok, /benötigt ein anderes Plugin/);
  assert.match(ok, /<button[^>]*>Deaktivieren/);
});
