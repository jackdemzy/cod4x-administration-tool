import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
const HEX = 'ab'.repeat(32);
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as M from './lib/remote-hosts.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(M[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  const compiled = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  return (name, props) => { try { return compiled.render(name, props); } catch (error) { throw new Error('Render failed: ' + error.name + ': ' + String(error.message).slice(0, 160)); } };
}
const skip = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url)) ? false : 'native esbuild missing';
const noFetch = () => { throw new Error('SSR must not fetch'); };

test('panel renders without any login password field, never fetches while rendering and shows the notice in both languages', { skip }, async () => {
  const render = await renderer();
  const de = render('RemoteHostsPanel', { de: true, request: noFetch });
  const en = render('RemoteHostsPanel', { de: false, request: noFetch });
  assert.doesNotMatch(de, /type="password"/);
  assert.doesNotMatch(de, /name="password"/i);
  assert.match(de, /RCON und B3 sind für Remote-Server noch nicht verfügbar/);
  assert.match(en, /RCON and B3 are not available for remote servers yet/);
  assert.match(de, /SSH-Schlüssel/);
});

test('host-key dialog shows hex and OpenSSH form and the trust button stays disabled until the exact value is confirmed', { skip }, async () => {
  const render = await renderer();
  const html = render('HostKeyDialog', { de: false, host: { id: 'lab-1', host: 'lab-1.example.org' }, fingerprint: { sha256Hex: HEX, sha256Base64: 'q83vq83vq83vq83vq83vq83vq83vq83vq83vq83vq80=' }, confirmed: false, onConfirm() {}, onTrust() {}, onCancel() {} });
  assert.ok(html.includes(HEX));
  assert.match(html, /SHA256:q83vq83vq83vq83vq83vq83vq83vq83vq83vq83vq80/);
  assert.ok(!html.includes('q80='), 'padding is dropped like ssh-keygen prints it');
  assert.match(html, /type="checkbox"/);
  assert.match(html, /I compared this fingerprint with the server/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Trust this key/);
  const confirmed = render('HostKeyDialog', { de: false, host: { id: 'lab-1', host: 'x' }, fingerprint: { sha256Hex: HEX, sha256Base64: 'AA==' }, confirmed: true, onConfirm() {}, onTrust() {}, onCancel() {} });
  assert.doesNotMatch(confirmed, /<button[^>]*disabled=""[^>]*>Trust this key/);
});

test('a changed host key renders a stop message and offers no trust button', { skip }, async () => {
  const render = await renderer();
  for (const de of [true, false]) {
    const html = render('RemoteError', { de, code: 'REMOTE_HOST_KEY_CHANGED', presentedSha256: HEX, pinnedSha256: 'cd'.repeat(32) });
    assert.match(html, /role="alert"/);
    assert.match(html, de ? /Verbindung gestoppt/ : /Connection stopped/);
    assert.ok(html.includes(HEX) && html.includes('cd'.repeat(32)));
    assert.doesNotMatch(html, /<button/);
  }
});

test('unknown error codes never show server text, only a fixed message plus the code', { skip }, async () => {
  const render = await renderer();
  const html = render('RemoteError', { de: false, code: 'REMOTE_AUTH_FAILED' });
  assert.match(html, /REMOTE_AUTH_FAILED/);
  const odd = render('RemoteError', { de: false, code: '<script>alert(1)</script>' });
  assert.doesNotMatch(odd, /<script>/);
  assert.match(odd, /REMOTE_OPERATION_FAILED/);
});

test('key form: multi-line key field, one clearly labelled passphrase field, no value rendered, disabled while busy', { skip }, async () => {
  const render = await renderer();
  const html = render('HostCredentialForm', { de: false, host: { id: 'lab-1' }, status: { ssh: { configured: true, value: 'PRIVATE-KEY-MATERIAL' }, sha256: HEX }, busy: false, onSave() {}, onRemove() {} });
  assert.match(html, /<textarea/);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.match(html, /Key passphrase \(only if the key is encrypted\)/);
  assert.match(html, /autoComplete="off"|autocomplete="off"/i);
  assert.ok(!html.includes('PRIVATE-KEY-MATERIAL'));
  assert.match(html, /Stored/);
  const busy = render('HostCredentialForm', { de: true, host: { id: 'lab-1' }, status: null, busy: true, onSave() {}, onRemove() {} });
  assert.match(busy, /Status unbekannt/);
  assert.ok((busy.match(/disabled=""/g) || []).length >= 3);
});

test('instance row offers all operations and disables them while busy', { skip }, async () => {
  const render = await renderer();
  const html = render('RemoteInstanceRow', { de: false, busy: false, entry: { instance: { id: 'srv-1', name: 'Srv', hostId: 'lab-1', port: 28960 }, runtime: { status: 'STOPPED' } }, onAction() {} });
  for (const label of ['Start', 'Stop', 'Restart', 'Logs', 'Health', 'Config', 'Backup', 'Restore list']) assert.match(html, new RegExp('>' + label + '<'), label);
  const running = render('RemoteInstanceRow', { de: true, busy: true, entry: { instance: { id: 'srv-1', name: 'Srv', hostId: 'lab-1', port: 28960 }, runtime: { status: 'RUNNING', pid: 42 } }, onAction() {} });
  assert.match(running, /RUNNING/);
  assert.ok((running.match(/disabled=""/g) || []).length >= 8);
});
