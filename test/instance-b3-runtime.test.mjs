import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-b3-runtime.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('B3 runtime view shows crash, health and RCON reachability without fetching', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const crashed = render('B3RuntimeView', { de: true, b3: { runtime: { status: 'CRASHED', pid: null, exitCode: null, signal: 'SIGKILL', running: false }, health: { status: 'DOWN', uptimeSec: null }, output: '' } });
  assert.match(crashed, /role="alert">B3: <strong>CRASHED<\/strong> – abgestürzt – Server unberührt/);
  assert.match(crashed, /\(SIGKILL\)/);
  const running = render('B3RuntimeView', { de: false, b3: { runtime: { status: 'RUNNING', pid: 4711, exitCode: null, running: true }, health: { status: 'HEALTHY', uptimeSec: 12, rcon: 'UNREACHABLE' }, output: 'B3 v1.10.10' } });
  assert.match(running, /PID: 4711/);
  assert.match(running, /server unreachable \(B3 keeps running\)/);
  const ok = value => ({ ok: value, state: value ? 'OK' : 'X' });
  const dashboard = render('B3Dashboard', { de: true, dashboard: { status: 'RUNNING', health: 'HEALTHY', version: { label: 'eBc/B3', b3: '1.10.10', commit: '9096624' }, parser: 'Cod4XParser v0.4', database: 'sqlite:CONNECTED', rcon: 'OFFLINE',
    checks: { python: ok(true), b3: ok(true), mysql: { ok: null, state: 'SQLITE (MySQL: Block 14)' }, parser: ok(true), rcon: ok(false), cod4x: ok(false) }, diagnosis: ['COD4X_OFFLINE', 'RCON_OFFLINE'], primary: 'COD4X_OFFLINE', rconCause: 'COD4X_OFFLINE', publist: 'SUPPRESSED' } });
  assert.match(dashboard, /keine Meldung an bigbrotherbot\.net/);
  for (const label of ['Status', 'Version', 'Parser', 'Database', 'RCON']) assert.match(dashboard, new RegExp(`<th>${label}</th>`));
  assert.match(dashboard, /eBc\/B3 1\.10\.10 @ 9096624/);
  for (const [label, sign] of [['Python', '✓'], ['MySQL', '–'], ['RCON', '✗'], ['CoD4X', '✗']]) assert.match(dashboard, new RegExp(`<td>${label}</td><td>${sign}</td>`));
  assert.match(dashboard, /COD4X_OFFLINE<\/strong> \(Hauptursache\)/);
  assert.match(dashboard, /Folge von CoD4X offline/);
  // PR #23 review: the runtime integration state is shown, not only the prerequisites.
  const lost = render('B3IntegrationStatus', { de: false, integration: { status: 'NOT_CONNECTED', code: 'B3HIDE_NOT_LOADED' } });
  assert.match(lost, /role="alert"/);
  assert.match(lost, /not connected – B3 commands are NOT hidden – The server is running but the core did not load b3hide\./);
  assert.match(lost, /do not type !auth passwords in chat/);
  assert.match(render('B3IntegrationStatus', { de: true, integration: { status: 'OK', code: null } }), /role="status".*verbunden – B3-Befehle werden ausgeblendet/);
  assert.equal(render('B3IntegrationStatus', { de: true, integration: null }), '');
  assert.match(render('B3IntegrationStatus', { de: false, integration: { status: 'OK', code: null, authExposed: true } }), /role="alert">Since the last B3 start, an auth command was typed publicly/);
  assert.doesNotMatch(render('B3IntegrationStatus', { de: false, integration: { status: 'OK', code: null } }), /typed publicly/);
  assert.match(render('B3Dashboard', { de: true, dashboard: { status: 'RUNNING', health: 'HEALTHY', version: { label: 'eBc/B3' }, checks: {}, diagnosis: [], publist: 'SUPPRESSED', integration: { status: 'BLOCKED', code: 'B3_COMMAND_PREFIX_MISMATCH' } } }), /b3hide\/auth:<\/strong> blockiert – B3 nutzt einen anderen Befehls-Prefix/);
  const panel = render('InstanceB3Runtime', { de: true, instance: { id: 'x' }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(panel, /unabhängig vom CoD4x-Server/);
  for (const button of ['Start', 'Stop', 'Restart', 'Logs', 'Config']) assert.match(panel, new RegExp(`>${button}</button>`));
});
