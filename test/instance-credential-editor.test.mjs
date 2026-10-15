import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {InstanceCredentialEditor} from './lib/instance-credential-editor.jsx'; export const render = props => renderToStaticMarkup(React.createElement(InstanceCredentialEditor, props));`, resolveDir: source, loader: 'jsx' },
  bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
});
const compiled = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
return function render(props) {
  try { return compiled.render(props); }
  catch (error) { throw new Error('Credential render failed: ' + error.name + ': ' + String(error.message).slice(0, 160)); }
};
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('credential editor renders only password inputs, never renders supplied credential values and starts fail-closed', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const html = render({ instance: { id: 'test', rcon: { value: 'private-test-secret' }, master: { value: 'private-master-secret' }, runtime: { status: 'STOPPED' } }, de: true, request: () => { throw new Error('SSR must not fetch'); } });
  assert.equal((html.match(/type="password"/g) || []).length, 4);
  assert.ok(!html.includes('private-test-secret')); assert.ok(!html.includes('private-master-secret'));
  assert.match(html, /noch nicht an die Runtime angebunden/);
  assert.match(html, /autocomplete="new-password"/i);
  assert.ok(!html.includes('type="text"'));
  assert.match(html, /Status laden/);
  assert.ok((html.match(/disabled=""/g) || []).length >= 8);
});
