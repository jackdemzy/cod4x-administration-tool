import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-b3-database.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const noFetch = () => { throw new Error('SSR must not fetch'); };
const settings = { host: '127.0.0.1', port: 3306, database: 'b3', username: 'b3' };
const state = (lastCheck, extra = {}) => ({ database: { settings, passwordConfigured: true, lastCheck, ready: lastCheck?.ready === true }, b3Running: false, ...extra });
// [match, 'disabled' | undefined]
const migrateButton = html => { const match = /<button([^>]*)>Migration starten<\/button>/.exec(html); return [match[0], /disabled/.test(match[1]) ? 'disabled' : undefined]; };

test('shows ready state with backup hash', { skip }, async () => {
  const render = await renderer();
  const html = render('InstanceB3Database', { de: true, instance: { id: 'x' }, request: noFetch, initial: state({ connection: 'OK', schema: 'COMPLETE', code: null, ready: true, backup: { path: '/srv/x/b3/backups/b3-20261020T101500Z.sql', sha256: 'ab'.repeat(32) } }) });
  assert.match(html, /B3 Ready/);
  assert.match(html, /b3-20261020T101500Z\.sql/);
  assert.match(html, new RegExp('ab'.repeat(32)));
  assert.match(html, /Passwort: im Tresor hinterlegt/);
});

test('migrate disabled for COMPLETE and OUTDATED and while B3 runs', { skip }, async () => {
  const render = await renderer();
  const html = (lastCheck, extra) => render('InstanceB3Database', { de: true, instance: { id: 'x' }, request: noFetch, initial: state(lastCheck, extra) });
  assert.ok(migrateButton(html({ connection: 'OK', schema: 'COMPLETE', code: null, ready: true }))[1]);
  const outdated = html({ connection: 'OK', schema: 'OUTDATED', code: 'SCHEMA_OUTDATED', ready: false });
  assert.ok(migrateButton(outdated)[1]);
  assert.match(outdated, /veraltet/);
  assert.ok(migrateButton(html({ connection: 'OK', schema: 'PARTIAL', code: 'SCHEMA_PARTIAL', missingTables: ['penalties'], ready: false }, { b3Running: true }))[1]);
  const partial = html({ connection: 'OK', schema: 'PARTIAL', code: 'SCHEMA_PARTIAL', missingTables: ['penalties'], ready: false });
  assert.equal(migrateButton(partial)[1], undefined);
  assert.match(partial, /penalties/);
  assert.match(html({ connection: 'DB_AUTH_FAILED', schema: null, code: 'DB_AUTH_FAILED', ready: false }), /Anmeldung abgelehnt/);
});

test('ebc opt-in shows warning and requires phrase', { skip }, async () => {
  const render = await renderer();
  const html = render('InstanceB3Database', { de: false, instance: { id: 'x' }, request: noFetch, initial: state({ connection: 'OK', schema: 'COMPLETE', code: null, ready: true }) });
  assert.match(html, /type="checkbox"/);
  assert.match(html, /drops player_core and prestige_log/);
  assert.match(html, /DROP player_core AND prestige_log/);
});

test('renders no password input or value', { skip }, async () => {
  const render = await renderer();
  const html = render('InstanceB3Database', { de: true, instance: { id: 'x' }, request: noFetch, initial: state(null) });
  assert.ok(!html.includes('type="password"'));
  assert.match(html, /value="127\.0\.0\.1"/);
  assert.match(html, /Noch nicht getestet/);
});

test('S5: every code of the database flow has a German and an English message', { skip }, async () => {
  const { B3_DATABASE_MESSAGES } = await import('../lib/b3-database-messages.mjs');
  for (const code of ['DB_UNREACHABLE', 'DB_AUTH_FAILED', 'DB_ACCESS_DENIED', 'DB_NOT_FOUND', 'DB_DRIVER_MISSING', 'DB_ERROR', 'DB_HELPER_FAILED', 'DB_HELPER_TIMEOUT',
    'SCHEMA_PARTIAL', 'SCHEMA_OUTDATED', 'MIGRATION_FAILED', 'MIGRATION_IN_PROGRESS', 'BACKUP_FAILED', 'VAULT_LOCKED', 'VAULT_OPERATION_BUSY', 'B3_DATABASE_BUSY',
    'B3_DATABASE_PASSWORD_MISSING', 'B3_DATABASE_PASSWORD_REENTRY_REQUIRED', 'B3_DATABASE_SETTINGS_INVALID', 'B3_DATABASE_NOT_CONFIGURED', 'B3_DATABASE_NOT_READY',
    'B3_SQL_HASH_MISMATCH', 'B3_SQL_UNSAFE', 'EBC_CONFIRMATION_REQUIRED', 'B3_RUNNING', 'B3_PYTHON_NOT_CONFIGURED', 'B3_SOURCE_NOT_CONFIGURED']) {
    const message = B3_DATABASE_MESSAGES[code];
    assert.ok(Array.isArray(message) && message.length === 2 && message.every(text => typeof text === 'string' && text.length > 5), code);
  }
  const render = await renderer();
  const html = render('InstanceB3Database', { de: true, instance: { id: 'x' }, request: noFetch, initial: state({ connection: 'OK', schema: 'PARTIAL', code: 'MIGRATION_IN_PROGRESS', ready: false }) });
  assert.match(html, /Migration lief/);
});
