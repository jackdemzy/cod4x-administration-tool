import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { evaluateB3Dependencies } from '../lib/b3-dependencies.mjs';

// Audit 4.18.31, debug pass: faults found while playing the app through (B1-B10, see the PR of the
// audit). Components are rendered to static markup where that is cheap; the rest is pinned in source.
const root = fileURLToPath(new URL('../', import.meta.url));
const escapeRegExp = value => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const skip = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url)) ? false : 'native esbuild missing';

async function load(file) {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; export * from './${file}'; export const render = element => renderToStaticMarkup(element); export {React};`, resolveDir: root, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}

test('B6: remote host and instance errors name what to check instead of a bare code', { skip }, async () => {
  const { RemoteError, render, React } = await load('lib/remote-hosts.jsx');
  for (const [code, english] of [['REMOTE_HOST_INVALID', /port 1–65535 and a user other than root/], ['REMOTE_INSTANCE_INVALID', /absolute path without/], ['REMOTE_CREDENTIAL_MISSING', /No SSH key is stored/]]) {
    const html = render(React.createElement(RemoteError, { de: false, code }));
    assert.match(html, english, code);
    assert.doesNotMatch(html, /Operation failed\./, code);
    assert.match(render(React.createElement(RemoteError, { de: true, code })), /<code>/, `${code} keeps the code for support`);
  }
});

test('B6: B3 dependency errors and the MySQL rows are explained, not shown as codes', { skip }, async () => {
  const { B3DependencyTable, b3DependencyMessage, render, React } = await load('lib/b3-dependency-panel.jsx');
  assert.match(b3DependencyMessage('B3_PYTHON_PATH_INVALID', false), /absolute path to python/);
  assert.match(b3DependencyMessage('B3_PYTHON_PATH_INVALID', true), /absoluter Pfad/);
  assert.equal(b3DependencyMessage('SOMETHING_NEW', false), 'SOMETHING_NEW', 'an unknown code is shown as it is');
  const dependencies = evaluateB3Dependencies({});
  assert.ok(dependencies.results.every(item => !String(item.detail || '').startsWith('PLANNED_')), 'no developer wording such as PLANNED_BLOCK_14');
  const html = render(React.createElement(B3DependencyTable, { dependencies, de: false }));
  assert.match(html, /checked per server under “B3 database”/);
  // Codex review: GSCLIB is checked nowhere, so it must not claim a per-server check.
  assert.equal(dependencies.results.find(item => item.id === 'gsclib').detail, 'OPERATOR_DECISION');
  assert.equal(dependencies.results.find(item => item.id === 'mysql-server').detail, 'CHECKED_PER_INSTANCE');
  assert.equal(dependencies.results.find(item => item.id === 'rcon').detail, 'SET_UP_AT_B3_START');
  assert.doesNotMatch(html, /later block|PLANNED_/);
  assert.match(read('lib/b3-dependency-panel.jsx'), /<p role="alert">\{b3DependencyMessage\(error, de\)\}<\/p>/);
});

test('B6: restore points and the RCON console explain refused operations', { skip }, async () => {
  assert.match(read('lib/restore-points-panel.jsx'), /B3_PYTHON_NOT_CONFIGURED: \['Für einen Punkt mit B3-Datenbank/);
  const { rconHistoryNote } = await load('lib/instance-rcon-console.jsx');
  assert.equal(rconHistoryNote('RCON_COMMAND_BLOCKED', 'en'), 'blocked: this command is not allowed here (RCON_COMMAND_BLOCKED)');
  assert.match(rconHistoryNote('RCON_COMMAND_BLOCKED', 'de'), /^gesperrt/);
  assert.equal(rconHistoryNote('RCON_SOMETHING', 'en'), 'RCON_SOMETHING');
  // B10: a server that is not running is not "transfer unknown (backend restarted?)".
  assert.match(read('lib/instance-rcon-console.jsx'), /\{running \? PROVISIONING\[lang\]\[rcon\?\.provisioning \|\| 'UNKNOWN'\] : STATUS_LABELS\[lang\]\.OFFLINE\}/);
});

test('B5: the German login shows German errors; English stays as sent', { skip }, async () => {
  const { loginErrorText } = await load('cod4x-control-improved.jsx');
  assert.equal(loginErrorText({ error: 'Invalid username or password.' }, 401, true), 'Benutzername oder Passwort falsch.');
  assert.equal(loginErrorText({ error: 'Invalid username or password.' }, 401, false), 'Invalid username or password.');
  assert.equal(loginErrorText({ code: 'LOGIN_LOCKED', retryAfterMs: 14 * 60000 + 1, error: 'Too many failed attempts. Try again in 15 min.' }, 429, true), 'Zu viele Fehlversuche. Erneut versuchen in 15 min.');
  assert.equal(loginErrorText({ error: 'Password: at least 12 characters required.' }, 400, true), 'Passwort: mindestens 12 Zeichen.');
  assert.equal(loginErrorText({}, 502, true), 'HTTP 502');
});

test('B5: hard-coded English in the German UI is translated', () => {
  const ui = read('cod4x-control-improved.jsx');
  for (const english of ['"Load FPSChallenge download catalog"', '"Use existing server mod"', '"FIRST-RUN ADMIN INITIALIZATION"', '"RCON is sent server-side; the password is never written to the application log."']) {
    assert.match(ui, new RegExp(`de\\?"[^"]+":${escapeRegExp(english)}`), english);
  }
  assert.doesNotMatch(ui.slice(ui.indexOf('  de: {'), ui.indexOf('  en: {')), /server\.cfg Preview/);
  assert.match(read('lib/instance-master-status.jsx'), /de \? 'Zuletzt gesehen' : 'Last seen'/);
  assert.match(read('lib/instance-b3-plugins.jsx'), /shipped: de \? 'mitgeliefert' : 'shipped'/);
});

test('B7: B3 requirements that were not checked show "–", not a tick', { skip }, async () => {
  const { B3IntegrationPanel, render, React } = await load('lib/instance-b3-integration.jsx');
  const data = { settings: { hideCommands: false, prefix: '!', hideLevel: 20 }, plan: { blockers: [], warnings: [] }, vault: { initialized: true, locked: false }, b3hide: null, authLevels: [], restart: {} };
  const off = render(React.createElement(B3IntegrationPanel, { data, canManage: true, de: false, busy: false, onSave() {}, onSetPassword() {} }));
  assert.match(off, /<li>– B3 auth plugin present \(checked when switched on\)<\/li>/);
  assert.doesNotMatch(off, /✔ B3 auth plugin present/);
  const on = render(React.createElement(B3IntegrationPanel, { data: { ...data, settings: { ...data.settings, hideCommands: true }, plan: { blockers: [{ code: 'B3_AUTH_PLUGIN_MISSING' }], warnings: [] } }, canManage: true, de: false, busy: false, onSave() {}, onSetPassword() {} }));
  assert.match(on, /<li>✖ B3 auth plugin present<\/li>/);
  // Codex review: with the auth plugin missing the prefix was never read, so no tick for it.
  assert.match(on, /<li>– B3 command prefix is &quot;!&quot; \(plugin_admin\.ini\) \(not checked\)<\/li>/);
  const read2 = render(React.createElement(B3IntegrationPanel, { data: { ...data, prefixChecked: true, settings: { ...data.settings, hideCommands: true } }, canManage: true, de: false, busy: false, onSave() {}, onSetPassword() {} }));
  assert.match(read2, /<li>✔ B3 command prefix is &quot;!&quot; \(plugin_admin\.ini\)<\/li>/);
});

test('B1/B4: an unlock does not fall into the save branch; a wrong passphrase keeps the status', () => {
  const editor = read('lib/instance-credential-editor.jsx');
  assert.match(editor, /else if \(kind !== 'unlock'\) \{/);
  assert.match(editor, /\['VAULT_PASSPHRASE_MISMATCH', 'VAULT_UNLOCK_FAILED', 'VAULT_PASSPHRASE_INVALID'\]\.includes\(code\)/);
  assert.match(editor, /Wrong unlock passphrase\. The vault stays locked\./);
});

test('B8/B9: audit panels only for roles that may read them; the first preflight uses the stored runtime', () => {
  const ui = read('cod4x-control-improved.jsx');
  assert.match(ui, /const seed=async generation=>\{const sr=await apiFetch\(apiUrl\("\/api\/runtime\/status"\)\)/);
  assert.match(ui, /if\(!seeded\.current&&!\(await seed\(generation\)\)\)return;/);
  assert.ok(/audit\.read|\["admin","auditor","viewer"\]/.test(ui), 'audit panels are gated by role');
});

test('B3: diagnostics and the security check judge the dedicated server core, not the client iw3mp.exe', { timeout: 60000 }, async t => {
  const { backend, password } = await import('./support/security-backend.mjs');
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const diagnostics = await call('/api/diagnostics?platform=linux', { token: admin });
  assert.equal(diagnostics.status, 200);
  const core = diagnostics.json.checks.find(check => check.id === 'verified-core');
  assert.ok(core, 'a verified-core check exists');
  assert.match(core.detail, /cod4x18_dedrun/);
  assert.doesNotMatch(JSON.stringify(diagnostics.json.checks), /iw3mp\.exe/);
  const security = await call('/api/security/status?platform=linux', { token: admin });
  assert.equal(security.status, 200);
});

test('B3 (Codex review): the stored runtime core only answers for its own installation and version', () => {
  const server = read('installer-server.mjs');
  assert.match(server, /if \(state\.executablePath && sameTarget && \(!state\.cod4x \|\| String\(state\.cod4x\) === String\(cod4x\)\)\) \{/);
  assert.match(server, /return \{ \.\.\.await verifiedCoreStatus\(target, cod4x, platform\), platform, checked: "target" \};/);
});
