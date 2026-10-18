import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-master-status.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('master status view explains loopback, failures and never claims a verified listing', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const loopback = render('MasterStatusView', { de: true, master: { state: 'TOKEN_CONFIGURED', reason: 'LOOPBACK_BINDING', tokenConfigured: true, transfer: 'PROVISIONED', networkScope: 'LOOPBACK', verified: false } });
  assert.match(loopback, /TOKEN_CONFIGURED/);
  assert.match(loopback, /keinen Master-Heartbeat/);
  assert.match(loopback, /Listung verifiziert: nein/);
  const failed = render('MasterStatusView', { de: false, master: { state: 'REGISTRATION_FAILED', reason: 'MASTER_TOKEN_INVALID', tokenConfigured: true, transfer: 'PROVISIONED', networkScope: 'LOOPBACK', verified: false } });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /sv_authtoken is invalid/);
  const listed = render('MasterListSummary', { de: true, master: { summary: { registration: true, heartbeat: true, listed: true, lastSeenAt: '2026-10-18T10:00:00.000Z' }, list: { matchedBy: 'ADDRESS', checkedAt: '2026-10-18T10:00:00.000Z', masterTime: 'Sun Oct 18', entry: { hostname: 'Gate', addresses: [{ ip: '203.0.113.7', port: 28960, state: 'alive' }] }, listedPorts: [] } } });
  for (const label of ['Registration', 'Heartbeat', 'Listed', 'Last seen']) assert.match(listed, new RegExp(`<th>${label}</th><td>`));
  assert.match(listed, /über Adresse/);
  assert.match(listed, /203\.0\.113\.7:28960 \(alive\)/);
  const lost = render('MasterStatusView', { de: true, master: { state: 'HEARTBEAT_LOST', reason: 'MASTER_LIST_DEAD', tokenConfigured: true, networkScope: 'PUBLIC', verified: true, summary: { registration: true, heartbeat: false, listed: true, lastSeenAt: null } } });
  assert.match(lost, /Heartbeat fehlt/);
  assert.match(lost, /<th>Heartbeat<\/th><td>✗/);
  // Public exposure needs an explicit confirmation before it can be saved.
  const exposure = render('NetworkExposureEditor', { de: true, instance: { id: 'test', network: { scope: 'PUBLIC', publicAddress: null }, runtime: { status: 'STOPPED' } }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(exposure, /RCON auf demselben UDP-Port/);
  assert.match(exposure, /type="checkbox"/);
  assert.match(exposure, /<button disabled="">Bindung speichern/);
  const local = render('NetworkExposureEditor', { de: true, instance: { id: 'test', runtime: { status: 'STOPPED' } }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(local, /Netzwerkbindung<!-- -->: <!-- -->LOOPBACK|Netzwerkbindung: LOOPBACK/);
  assert.ok(!local.includes('type="checkbox"'), 'No exposure confirmation while loopback is selected');
  const panel = render('InstanceMasterStatus', { de: true, instance: { id: 'test' }, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(panel, /Master-Token ist optional/);
  assert.ok(!panel.includes('type="password"'), 'Status panel never takes the token');
});
