import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { backend, password } from './support/security-backend.mjs';
import { dockerRefusal } from '../lib/remote-container-runtime.mjs';

// Debug phase (4.18.31): the app was started and played through (create server, start/stop, RCON, B3,
// backup/restore, backend restart, EN/DE). These tests pin the faults found there.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const ui = read('cod4x-control-improved.jsx');
const skip = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url)) ? false : 'native esbuild missing';

async function loadUi() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; export * from './cod4x-control-improved.jsx'; export const render = element => renderToStaticMarkup(element); export {React};`, resolveDir: root, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}

test('no effect returns the value of an expression: React would call it as cleanup (Tools page blanked the app)', () => {
  const files = ['cod4x-control-improved.jsx', ...readdirSync(new URL('../lib/', import.meta.url)).filter(name => name.endsWith('.jsx')).map(name => `lib/${name}`)];
  for (const file of files) {
    // useEffect(()=>call(...)) returns whatever the call returns; scrollIntoView returns a Promise in current Chromium.
    // useEffect(()=>name,[]) (returns a cleanup function by name) and useEffect(()=>()=>...) stay allowed.
    const bad = [...read(file).matchAll(/useEffect\(\s*\(\)\s*=>(?!\s*\{|\s*\(\)\s*=>|\s*[A-Za-z_$][\w$]*\s*,)[^\n]*/g)].map(match => match[0].slice(0, 90));
    assert.deepEqual(bad, [], file);
  }
  assert.match(ui, /useEffect\(\(\)=>\{bottomRef\.current\?\.scrollIntoView\(\{behavior:"smooth"\}\);\},\[messages,loading\]\)/);
});

test('an error in one page shows a message in that page instead of an empty window', { skip }, async () => {
  const { TabErrorBoundary, render, React } = await loadUi();
  assert.match(ui, /<TabErrorBoundary key=\{tab\} de=\{de\}>/, 'every page is wrapped, a new page starts clean');
  assert.deepEqual(TabErrorBoundary.getDerivedStateFromError(new Error('boom')), { error: new Error('boom') });
  const boundary = new TabErrorBoundary({ de: false, children: 'page' });
  assert.equal(boundary.render(), 'page');
  boundary.state = { error: new Error('destroy_ is not a function') };
  const html = render(boundary.render());
  assert.match(html, /This page ran into an error\./);
  assert.match(html, /destroy_ is not a function/);
  assert.match(html, /Reload page/);
  const german = new TabErrorBoundary({ de: true }); german.state = { error: new Error('x') };
  assert.match(render(german.render()), /Diese Seite ist auf einen Fehler gestoßen\./);
  assert.ok(React);
});

test('a 401 on a request with the session token ends the session and tells the login screen', { skip }, async () => {
  const { apiFetch, SESSION_EXPIRED_EVENT } = await loadUi();
  const store = new Map([['cod4x.auth.token', 'tok'], ['cod4x.auth.expiresAt', '1'], ['cod4x.auth.sessionId', 's']]);
  const events = [];
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, window: globalThis.window };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  try {
    let status = 200, body = { ok: true }, seen = null;
    globalThis.fetch = async (_input, init) => { seen = init.headers; const answer = body; return { status, ok: status < 400, clone: () => ({ json: async () => answer }) }; };
    await apiFetch('http://127.0.0.1:8787/api/instances');
    assert.equal(seen.Authorization, 'Bearer tok');
    assert.deepEqual(events, []);
    status = 401; body = { ok: false, code: 'PASSWORD_INVALID', error: 'Passwort ungültig.' };
    await apiFetch('http://127.0.0.1:8787/api/auth/totp/disable', { method: 'POST' });
    assert.deepEqual(events, [], 'a wrong password for turning off TOTP keeps the session');
    assert.equal(store.get('cod4x.auth.token'), 'tok');
    body = { ok: false, code: 'AUTH_REQUIRED', error: 'Authentication required' };
    await apiFetch('http://127.0.0.1:8787/api/auth/login', { method: 'POST' });
    assert.deepEqual(events, [], 'a failed login is no expired session');
    assert.equal(store.get('cod4x.auth.token'), 'tok');
    await apiFetch('http://127.0.0.1:8787/api/instances');
    assert.deepEqual(events, [SESSION_EXPIRED_EVENT]);
    assert.equal(store.has('cod4x.auth.token') || store.has('cod4x.auth.expiresAt') || store.has('cod4x.auth.sessionId'), false);
    await apiFetch('http://127.0.0.1:8787/api/instances');
    assert.equal(events.length, 1, 'without a token a 401 is not reported again');
  } finally { Object.assign(globalThis, saved); }
  assert.match(ui, /window\.addEventListener\(SESSION_EXPIRED_EVENT,expired\)/);
  const server = read('installer-server.mjs');
  assert.equal((server.match(/status\(401\)\.json\(\{ ok: false, code: "AUTH_REQUIRED", error: "Authentication required" \}\)/g) || []).length, 2, 'both session checks mark a missing session');
  assert.match(ui, /if\(!status\.ok\|\|typeof d\.initialized!=="boolean"\) throw/, 'a refused status answer is an error, not the setup form');
  assert.match(ui, /"Erneut versuchen":"Try again"/);
});

test('polled reads of the runtime page leave the audit log alone; changes and denials are still audited', async t => {
  const api = await backend(t);
  const user = { username: 'debugAdmin', password: password() };
  const { json } = await api.call('/api/auth/init', { body: user });
  const token = json.token;
  const before = (await api.call('/api/audit?limit=500', { token })).json.events.length;
  for (let index = 0; index < 5; index++) {
    for (const route of ['/api/instances', '/api/runtime/status', '/api/runtime/preflight']) await api.call(route, { token });
  }
  const events = (await api.call('/api/audit?limit=500', { token })).json.events;
  assert.ok(events.length >= before);
  const noise = events.filter(event => (event.event === 'rbac.permission.checked' && event.details?.permission === 'diagnostics.read') || (event.event === 'instance.operation' && event.details?.method === 'GET'));
  assert.deepEqual(noise.map(event => event.event), []);
  const created = await api.call('/api/instances', { token, body: { id: 'audit-01', name: 'x', platform: 'linux', port: 39100 } });
  const after = (await api.call('/api/audit?limit=500', { token })).json.events;
  assert.ok(after.some(event => event.event === 'rbac.permission.checked' && event.details?.permission === 'server.manage') || created.status >= 400, 'a change is still audited');
  assert.ok(after.some(event => /^instance\.operation/.test(event.event)), 'the create (or its refusal) is audited');
});

test('the vault asks for a new passphrase twice and is unlocked right after it is created', () => {
  const editor = read('lib/instance-credential-editor.jsx');
  assert.match(editor, /'VAULT_PASSPHRASE_MISMATCH'/);
  assert.match(editor, /credentials\?\.initialized === false && <label> \{de \? 'Passwort wiederholen' : 'Repeat passphrase'\}/);
  assert.match(editor, /if \(kind === 'initialize'\) await call\('\/api\/credentials\/vault\/unlock', \{ passphrase: value \}\)/);
  assert.match(editor, /onToggle=\{event => \{ if \(event\.currentTarget\.open && !credentials && !operation\.current\) void action\('load'\); \}\}/);
});

test('every permission has an English and a German description in the UI', () => {
  const ids = [...read('installer-server.mjs').match(/const RBAC_PERMISSIONS = \[([\s\S]*?)\n\];/)[1].matchAll(/id: "([a-z0-9.]+)"/g)].map(match => match[1]);
  assert.ok(ids.length >= 12);
  const table = ui.match(/export const RBAC_PERMISSION_TEXT=\{([\s\S]*?)\n\};/)[1];
  for (const id of ids) {
    const row = table.match(new RegExp(`"${id.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}":\\["([^"]+)","([^"]+)"\\]`));
    assert.ok(row, id);
    assert.notEqual(row[1], row[2], id);
    assert.doesNotMatch(row[2], /[äöüß]| und | verwalten/, `${id}: English text`);
  }
  assert.doesNotMatch(ui, /placeholder="C:\\\\Games/, 'no doubled backslash in a JSX attribute');
});

test('Electron: one instance per session, backend output in a log file, English dialogs', () => {
  const main = read('electron-main.cjs');
  // Issue #67: --cod4x-backend-only (release gate) runs no window and takes no single-instance lock.
  assert.match(main, /const SINGLE_INSTANCE=BACKEND_ONLY\|\|app\.requestSingleInstanceLock\(\);\nif\(!SINGLE_INSTANCE\) app\.quit\(\);/);
  assert.match(main, /app\.on\('second-instance'/);
  assert.match(main, /app\.whenReady\(\)\.then\(async\(\)=>\{if\(!SINGLE_INSTANCE\)return;/);
  assert.match(main, /stdio:\['ignore','pipe','pipe'\]/);
  assert.match(main, /server\.stdout\.on\('data',chunk=>\{log\.write\(chunk\);/);
  assert.match(main, /server\.stderr\.on\('data',chunk=>BACKEND_ONLY\?process\.stderr\.write\(chunk\):log\.write\(chunk\)\);/);
  assert.doesNotMatch(main, /stdio:'ignore'/);
  assert.match(main, /if\(server&&serverExited\) return resolve\(false\);/, 'never talk to a backend that is not ours');
  assert.doesNotMatch(main, /auswählen|Übernehmen|konnte nicht gestartet/);
});

test("Docker's reason for a refused container start is kept, bounded and without secrets", () => {
  const refusal = dockerRefusal({ stdout: Buffer.alloc(0), stderr: Buffer.from(`${'x'.repeat(5000)}\nset rcon_password "hunter2secret"\ndocker: Error response from daemon: Conflict. The container name "/cod4x-real-01" is already in use.\n`) });
  assert.ok(Buffer.byteLength(refusal) <= 2048);
  assert.match(refusal, /Conflict\. The container name "\/cod4x-real-01" is already in use\./);
  assert.doesNotMatch(refusal, /hunter2secret/);
  assert.equal(dockerRefusal({}), '');
  const manager = read('lib/remote-instance-manager.mjs'), routes = read('lib/remote-linux-routes.mjs');
  assert.match(manager, /await failed\('START_FAILED', typeof error\.output === 'string' \? error\.output : ''\)/);
  assert.match(routes, /code === 'REMOTE_START_FAILED' && typeof error\.output === 'string' && error\.output \? \{ output: error\.output\.slice\(0, 2048\) \}/);
  const fixture = read('test/support/docker-fixture.mjs');
  assert.match(fixture, /const unlock = real \? await lockRealDocker\(\) : null;/, 'real-Docker tests run one at a time');
});
