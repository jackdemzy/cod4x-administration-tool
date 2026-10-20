import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-online-players.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const noFetch = () => { throw new Error('SSR must not fetch'); };
const online = { map: 'mp_crash', players: [{ slot: 3, name: 'Wolf', ping: 48, score: 12, playerid: '…7890', address: '203.0.113.x', bot: false }, { slot: 0, name: 'bot0', ping: 0, score: 0, playerid: '…', address: 'bot', bot: true }] };
const view = async initial => (await renderer())('InstanceOnlinePlayers', { de: true, instance: { id: 'x' }, request: noFetch, initial });

test('online list shows slot, name, masked id and address', { skip }, async () => {
  const html = await view({ permissions: { manage: false }, online });
  for (const text of ['Wolf', '…7890', '203.0.113.x', 'mp_crash', '<td>3</td>']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('>Kicken</button>'));
});

test('kick buttons and a bounded reason field only with server.manage', { skip }, async () => {
  const html = await view({ permissions: { manage: true }, online });
  assert.equal((html.match(/>Kicken<\/button>/g) || []).length, 2);
  assert.match(html, /maxLength="126"|maxlength="126"/i);
});
