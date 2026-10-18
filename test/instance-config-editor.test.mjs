import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as editor from './lib/instance-config-editor.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(editor[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('config editor renders a readable diff, delegated sections and activation state', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const diff = render('ConfigDiffTable', { de: true, diff: [{ name: 'sv_hostname', change: 'modified', before: 'Old', after: 'New' }, { name: 'logfile', change: 'added', before: null, after: '' }] });
  assert.match(diff, /<table>/);
  assert.match(diff, /<td>sv_hostname<\/td><td>modified<\/td><td>Old<\/td><td>New<\/td>/);
  assert.match(diff, /<td>logfile<\/td><td>added<\/td><td>—<\/td><td>&quot;&quot;<\/td>/);
  assert.ok(!diff.includes('"name"'), 'Diff must not be raw JSON');
  assert.match(render('ConfigDiffTable', { de: false, diff: [] }), /No changes/);
  const overview = render('ConfigSectionOverview', { de: true, sections: [{ id: 'identity', label: 'Server Identity', managedBy: 'schema', roadmapBlock: 6 }, { id: 'rcon', label: 'RCON', managedBy: 'credential-vault', roadmapBlock: 7 }, { id: 'plugins', label: 'Plugins', managedBy: 'planned', roadmapBlock: 10 }] });
  assert.match(overview, /RCON \(Credential Vault, Block 7\)/);
  assert.match(overview, /Plugins \(noch nicht verwaltet, Block 10\)/);
  assert.ok(!overview.includes('Server Identity'));
  assert.match(render('ConfigActivationStatus', { de: true, activation: { state: 'RESTART_REQUIRED' } }), /role="alert".*Neustart erforderlich/);
  assert.match(render('ConfigActivationStatus', { de: false, activation: { state: 'STOPPED', changedSinceLastStart: true } }), /Changed since last start/);
  // The full editor starts unloaded and must not fetch during render.
  const editor = render('InstanceConfigEditor', { de: true, instance: { id: 'test', runtime: { status: 'STOPPED' } }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(editor, /Datei laden/);
});
