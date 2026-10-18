import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function load() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as consoleModule from './lib/instance-rcon-console.jsx'; export const render = props => renderToStaticMarkup(React.createElement(consoleModule.InstanceRconConsole, props)); export const buildConsoleExport = consoleModule.buildConsoleExport;`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';

test('console renders live output, controls and no password field', { skip }, async () => {
  const { render } = await load();
  const instance = { id: 'public-01', port: 28960, runtime: { status: 'RUNNING', pid: 10, runId: 'run', output: { stdout: 'runtime ready\nWARNING: low memory\n' } }, consoleLog: { text: 'Server: mp_backlot\nERROR: missing iwd\n' } };
  const html = render({ instance, de: true, request: () => { throw new Error('SSR must not fetch'); } });
  assert.ok(!/type="password"/.test(html));
  assert.match(html, /Server-Konsole · RCON/);
  for (const label of ['Reconnect', 'Kopieren', 'Leeren', 'Log exportieren', 'Auto-Scroll', 'Senden', 'RCON-Befehl']) assert.ok(html.includes(label), label);
  assert.match(html, /\[server\] Server: mp_backlot/);
  assert.match(html, /color:#ef4444[^>]*>\[server\] ERROR: missing iwd/);
  assert.match(html, /color:#f59e0b[^>]*>\[runtime\] WARNING: low memory/);
  assert.match(html, /127\.0\.0\.1:28960/);
  assert.match(html, /map_rotate, map &lt;mapname&gt;/);
});

test('console input is disabled while the server is not running', { skip }, async () => {
  const { render } = await load();
  const html = render({ instance: { id: 'x', port: 28961, runtime: { status: 'STOPPED' }, consoleLog: { text: '' } }, de: false, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(html, /aria-label="RCON command"[^>]*disabled=""/);
});

test('log export carries server, runtime and RCON lines with status header', { skip }, async () => {
  const { buildConsoleExport } = await load();
  const text = buildConsoleExport({ instance: { id: 'public-01', port: 28960 }, rcon: { status: 'CONNECTED', provisioning: 'PROVISIONED' },
    lines: [{ source: 'server', at: null, text: 'Server: mp_backlot' }, { source: 'rcon', at: '2026-10-18T12:00:00.000Z', text: '> status' }] });
  assert.match(text, /^# COD4X CONTROL console export\n# instance=public-01 port=28960/);
  assert.match(text, /# rcon=CONNECTED provisioning=PROVISIONED/);
  assert.match(text, /-\tserver\tServer: mp_backlot\n2026-10-18T12:00:00\.000Z\trcon\t> status\n$/);
});
