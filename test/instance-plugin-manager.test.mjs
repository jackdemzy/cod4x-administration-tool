import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-plugin-manager.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('plugin manager renders states, hashes, actions, dependencies and config without fetching', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const catalog = { fullName: 'CoD4x B3 hide', dependencies: [{ kind: 'b3', required: false, note: 'B3 later' }], configSchema: { b3Hide: { type: 'integer', min: 0, max: 1, default: '1' } } };
  const plugins = [
    { name: 'b3hide', state: 'ENABLED', enabled: true, sha256: 'a'.repeat(64), pinnedSha256: 'a'.repeat(64), load: 'LOADED', version: '1.0', catalog, config: {} },
    { name: 'other', state: 'NOT_APPROVED', enabled: false, sha256: 'b'.repeat(64), pinnedSha256: null, load: null, version: null, catalog: null },
    { name: 'changed', state: 'INTEGRITY_MISMATCH', enabled: true, sha256: 'c'.repeat(64), pinnedSha256: 'd'.repeat(64), load: null, version: null, catalog: null },
  ];
  const table = render('PluginTable', { de: true, plugins, busy: false, onAction: () => {} });
  assert.match(table, /ENABLED – aktiv/);
  assert.match(table, /geladen/);
  assert.match(table, /<td>1\.0<\/td>/);
  assert.match(table, /Abhängigkeit: b3 \(optional\)/);
  assert.match(table, /Deaktivieren/);
  assert.match(table, /Hash bestätigen \+ freigeben/);
  assert.match(table, /role="alert">INTEGRITY_MISMATCH/);
  assert.match(table, new RegExp(`Freigegeben: ${'d'.repeat(64)}`));
  const config = render('PluginConfigEditor', { de: false, plugin: plugins[0], busy: false, onSave: () => {} });
  assert.match(config, /b3Hide/);
  assert.match(config, /value="1"/);
  assert.equal(render('PluginConfigEditor', { de: false, plugin: plugins[1], busy: false, onSave: () => {} }), '');
  const panel = render('InstancePluginManager', { de: true, instance: { id: 'test' }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(panel, /Plugins erkennen/);
  assert.match(panel, /blockiert den Start/);
});
