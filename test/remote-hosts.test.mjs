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

test('panel renders without any login password field, never fetches while rendering and shows the B3 notice in both languages', { skip }, async () => {
  const render = await renderer();
  const de = render('RemoteHostsPanel', { de: true, request: noFetch });
  const en = render('RemoteHostsPanel', { de: false, request: noFetch });
  assert.doesNotMatch(de, /type="password"/);
  assert.doesNotMatch(de, /name="password"/i);
  assert.doesNotMatch(de, /RCON und B3 sind für Remote-Server noch nicht verfügbar/);
  assert.match(de, /B3 startet CONTROL für Remote-Server nicht/);
  assert.match(en, /CONTROL does not start B3 for remote servers/);
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
  assert.doesNotMatch(odd, /<script/i);
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

test('Block 18b: a running remote server gets the console and the player list over its remote routes; a stopped one does not', { skip }, async () => {
  const render = await renderer();
  const entry = status => ({ instance: { id: 'srv-1', name: 'Srv', hostId: 'lab-1', port: 28961 }, runtime: status === 'RUNNING' ? { status, pid: 42, runId: 'r1' } : { status } });
  const running = render('RemoteInstanceTools', { de: true, entry: entry('RUNNING'), request: noFetch });
  assert.match(running, /Server-Konsole · RCON/);
  assert.match(running, /RCON über SSH auf dem Server, dort an 127\.0\.0\.1:28961/);
  assert.match(running, /Online-Spieler|Spieler/);
  const container = render('RemoteInstanceTools', { de: true, entry: { instance: { id: 'srv-1', name: 'Srv', hostId: 'lab-1', port: 28961, deployment: 'docker' }, runtime: { status: 'RUNNING', containerId: 'abcdef012345', runId: 'r1' } }, request: noFetch });
  assert.match(container, /Server-Konsole · RCON/, 'Block 19: a running container has no pid and still gets the console');
  const stopped = render('RemoteInstanceTools', { de: false, entry: entry('STOPPED'), request: noFetch });
  assert.doesNotMatch(stopped, /Server console/);
  assert.match(stopped, /Start the server to use RCON/);
  // credentials and B3 through its database do not need a running server
  for (const html of [running, stopped]) {
    assert.match(html, /B3 (Datenbank|database)/);
    assert.match(html, /B3 (A|a)dministration/);
    assert.doesNotMatch(html, /Master-Token|Master token|Join/);
    assert.ok(!/type="password"[^>]*name="password"/.test(html));
  }
  assert.match(stopped, /RCON password goes to the server as a private file/);
});

// ---- Block 19: Docker ------------------------------------------------------------------------------------------
test('Block 19: a docker-group host shows the root warning and the confirm button stays disabled until the word is typed', { skip }, async () => {
  const render = await renderer();
  const props = { busy: false, host: { id: 'lab-1', docker: null }, onConfirm() {}, onBuild() {} };
  const rootful = { mode: 'ROOTFUL', version: '29.1.0', confirmed: false, image: 'MISSING', note: 'ROOTFUL_ROOT_EQUIVALENT' };
  const en = render('DockerHostLine', { ...props, de: false, status: rootful });
  assert.match(en, /role="alert"/);
  assert.match(en, /equivalent to root on this host/);
  assert.match(en, /DOCKER_ROOT_EQUIVALENT/);
  assert.match(en, /29\.1\.0/);
  assert.match(en, /<button[^>]*disabled=""[^>]*>Confirm Docker for this host/);
  assert.match(en, /<button[^>]*disabled=""[^>]*>Build image/, 'no build before the confirmation');
  const de = render('DockerHostLine', { ...props, de: true, status: rootful });
  assert.match(de, /root-gleich/);
  assert.doesNotMatch(de, /type="password"/);
});

test('Block 19: a rootless host gets the note about player addresses, a confirmed host the build button, no Docker no controls', { skip }, async () => {
  const render = await renderer();
  const props = { de: false, busy: false, host: { id: 'lab-1', docker: null }, onConfirm() {}, onBuild() {} };
  const rootless = render('DockerHostLine', { ...props, status: { mode: 'ROOTLESS', version: '29.1.0', confirmed: false, image: 'MISSING', note: 'ROOTLESS_SOURCE_ADDRESS' } });
  assert.match(rootless, /source address of players/);
  assert.doesNotMatch(rootless, /role="alert"/);
  assert.doesNotMatch(rootless, /<button[^>]*disabled=""[^>]*>Confirm Docker for this host/, 'rootless needs no word');
  const confirmed = render('DockerHostLine', { ...props, status: { mode: 'ROOTFUL', version: '29.1.0', confirmed: true, image: 'OUTDATED', note: 'ROOTFUL_ROOT_EQUIVALENT' } });
  assert.match(confirmed, /Image outdated/);
  assert.doesNotMatch(confirmed, /<button[^>]*disabled=""[^>]*>Build image/);
  assert.doesNotMatch(confirmed, />Confirm Docker for this host</);
  assert.match(confirmed, />Withdraw confirmation</);
  assert.doesNotMatch(rootless, />Withdraw confirmation</, 'nothing to withdraw before a confirmation');
  const present = render('DockerHostLine', { ...props, status: { mode: 'ROOTLESS', version: '29.1.0', confirmed: true, image: 'PRESENT', note: 'ROOTLESS_SOURCE_ADDRESS' } });
  assert.match(present, /Image ready/);
  const none = render('DockerHostLine', { ...props, status: { mode: 'NO_DOCKER', version: null, confirmed: false, image: null, note: null } });
  assert.match(none, /Docker is not available/);
  assert.doesNotMatch(none, /<button/);
});

test('Block 19: the instance row names the deployment, shows the short container ID and offers the switch only while stopped', { skip }, async () => {
  const render = await renderer();
  const row = (instance, runtime, de = false) => render('RemoteInstanceRow', { de, busy: false, entry: { instance: { id: 'srv-1', name: 'Srv', hostId: 'lab-1', port: 28960, ...instance }, runtime }, onAction() {} });
  const running = row({ deployment: 'docker' }, { status: 'RUNNING', containerId: 'abcdef012345' });
  assert.match(running, /Docker/);
  assert.match(running, /Container abcdef012345/);
  assert.doesNotMatch(running, /PID/);
  assert.match(running, /<button[^>]*disabled=""[^>]*>Switch to native/);
  assert.match(running, /ufw/, 'published ports bypass ufw: said where the instance is a container');
  const stopped = row({ deployment: 'docker' }, { status: 'STOPPED' });
  assert.doesNotMatch(stopped, /<button[^>]*disabled=""[^>]*>Switch to native/);
  const native = row({ deployment: 'native' }, { status: 'STOPPED' }, true);
  assert.match(native, />Auf Docker umstellen</);
  assert.doesNotMatch(native, /ufw/);
  const old = row({}, { status: 'RUNNING', pid: 42 });
  assert.match(old, /PID 42/);
  assert.match(old, /Switch to Docker/, 'an instance saved before Block 19 is native');
});

test('Block 19: the install form offers the deployment and the panel still has no login password field', { skip }, async () => {
  const render = await renderer();
  const html = render('RemoteHostsPanel', { de: false, request: noFetch });
  assert.match(html, /<select[^>]*>.*<option value="native"[^>]*>.*<option value="docker"/s);
  assert.match(html, /Docker needs a host where Docker was confirmed and the image was built/);
  assert.match(html, /Core file name or path inside the import folder/);
  assert.match(html, /is read from the import folder of CONTROL only/);
  assert.doesNotMatch(html, /type="password"/);
});
