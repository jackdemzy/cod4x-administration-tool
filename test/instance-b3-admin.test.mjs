import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/instance-b3-admin.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const noFetch = () => { throw new Error('SSR must not fetch'); };
const groups = [{ id: 0, name: 'Guest', keyword: 'guest', level: 0 }, { id: 16, name: 'Admin', keyword: 'admin', level: 40 }];
const player = { id: 7, name: 'Tester', guid: '…FACE', ip: '203.0.113.x', group: 'Admin', level: 40, connections: 12, firstSeen: 1_800_000_000, lastSeen: 1_800_000_100 };
const base = (extra = {}) => ({ ready: true, b3Running: false, permissions: { manage: true, full: false }, groups, tab: 'players', players: { total: 1, offset: 0, limit: 50, rows: [player] }, ...extra });
const view = async (initial, de = true) => (await renderer())('InstanceB3Admin', { de, instance: { id: 'x' }, request: noFetch, initial });

test('shows the database wizard hint when B3 is not on a ready MySQL database', { skip }, async () => {
  const html = await view(base({ ready: false }));
  assert.match(html, /MySQL-Datenbank im Zustand „B3 Ready“/);
  assert.ok(!html.includes('Tester'));
});

test('renders masked values as delivered and the tabs', { skip }, async () => {
  const html = await view(base());
  for (const text of ['…FACE', '203.0.113.x', 'Players', 'Admins', 'Penalties', 'Commands']) assert.ok(html.includes(text), text);
});

test('no actions without server.manage', { skip }, async () => {
  const html = await view(base({ permissions: { manage: false, full: false } }));
  for (const label of ['Bannen', 'Gruppe setzen', 'Ban aufheben']) assert.ok(!html.includes(`>${label}</button>`), label);
  assert.match(await view(base()), />Bannen<\/button>/);
});

test('set group is disabled while B3 runs, with the reason', { skip }, async () => {
  const html = await view(base({ b3Running: true }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Gruppe setzen<\/button>/);
  assert.match(html, /nur bei gestopptem B3/);
});

test('the ban dialog says when the ban takes effect', { skip }, async () => {
  const html = await view(base({ banFor: player }));
  assert.match(html, /wirkt beim nächsten Connect/);
  assert.match(html, /ohne Kick spielt ein gerade verbundener Spieler weiter/);
});

test('player detail shows aliases and IP history', { skip }, async () => {
  const html = await view(base({ detail: { client: player, aliases: [{ alias: 'OldName', used: 3, firstSeen: 1, lastSeen: 2 }], ips: [{ ip: '198.51.100.x', used: 2, firstSeen: 1, lastSeen: 2 }] } }));
  assert.match(html, /OldName/);
  assert.match(html, /198\.51\.100\.x/);
});

test('penalties and commands tabs render status and levels', { skip }, async () => {
  const penalties = await view(base({ tab: 'penalties', penalties: { total: 1, offset: 0, limit: 50, rows: [{ id: 2, type: 'Warning', permanent: false, clientId: 7, name: 'Tester', guid: '…FACE', reason: 'Spam', since: 1, until: 2, status: 'active' }] } }));
  assert.match(penalties, /Spam/);
  assert.match(penalties, />Warnung aufheben<\/button>/);
  const commands = await view(base({ tab: 'commands', commands: [{ command: 'ban', alias: 'b', level: 40, group: 'Admin' }] }));
  assert.match(commands, /<td>!ban<\/td><td>!b<\/td><td>40<\/td><td>Admin<\/td>/);
});

test('every admin code has a German and an English message', { skip }, async () => {
  const { B3_ADMIN_MESSAGES } = await import('../lib/b3-admin-messages.mjs');
  for (const code of ['B3_DATABASE_NOT_READY', 'B3_ADMIN_INPUT_INVALID', 'B3_ADMIN_CLIENT_NOT_FOUND', 'B3_ADMIN_GROUP_NOT_FOUND', 'B3_ADMIN_PENALTY_NOT_FOUND', 'B3_ADMIN_COMMANDS_UNAVAILABLE', 'B3_RUNNING', 'B3_DATABASE_BUSY', 'VAULT_LOCKED', 'VAULT_OPERATION_BUSY', 'B3_DATABASE_PASSWORD_REENTRY_REQUIRED']) {
    assert.ok(Array.isArray(B3_ADMIN_MESSAGES[code]) && B3_ADMIN_MESSAGES[code].length === 2, code);
  }
});

// --- Review fixes ------------------------------------------------------------------
test('R1/R4: loading works for a viewer and refreshes readiness and B3 state', { skip }, async () => {
  const { loadAdminView } = await import('../lib/b3-admin-messages.mjs');
  const seen = [];
  const call = async route => {
    seen.push(route);
    if (/\/b3\/database$|\/b3$/.test(route)) throw new Error('HTTP 403');
    if (route === '/api/rbac/me') return { permissions: ['diagnostics.read'] };
    if (route.endsWith('/b3/admin/status')) return { status: { ready: true, b3Running: false } };
    if (route.endsWith('/b3/admin/groups')) return { groups: { rows: groups } };
    if (route.includes('/b3/admin/players')) return { players: { total: 1, offset: 0, limit: 50, rows: [player] } };
    throw new Error(`unexpected ${route}`);
  };
  const state = await loadAdminView(call, '/api/instances/x', { tab: 'players', search: '', filter: { type: 'any', status: 'active' }, offset: 0, withPermissions: true });
  assert.deepEqual([state.ready, state.b3Running, state.permissions], [true, false, { manage: false, full: false }]);
  assert.equal(state.players.rows[0].name, 'Tester');
  assert.ok(!seen.some(route => /\/b3\/database$/.test(route)));
});

test('R3: penalties are paged with a total', { skip }, async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, type: 'Ban', permanent: true, clientId: 7, name: `P${index}`, guid: '…FACE', reason: 'x', since: 1, until: null, status: 'active' }));
  const html = await view(base({ tab: 'penalties', penalties: { total: 120, offset: 50, limit: 50, rows } }));
  assert.match(html, /51–100 \/ 120/);
  assert.match(html, /aria-label="Vorherige Seite"/);
  assert.match(html, /aria-label="Nächste Seite"/);
});

test('R5: lifting without an active ban says so', { skip }, async () => {
  const { actionMessage } = await import('../lib/b3-admin-messages.mjs');
  assert.equal(actionMessage('unban', { affected: 0 }, true), 'Kein aktiver Ban für diesen Spieler.');
  assert.equal(actionMessage('unban', { affected: 2 }, true), '2 Ban(s) aufgehoben.');
});

test('15b: online B3 players get a kick button; the ban dialog offers kick now', { skip }, async () => {
  const online = await view(base({ players: { total: 1, offset: 0, limit: 50, rows: [{ ...player, online: { slot: 3 } }] } }));
  assert.match(online, />Kicken<\/button>/);
  const offline = await view(base({ players: { total: 1, offset: 0, limit: 50, rows: [{ ...player, online: false }] } }));
  assert.ok(!offline.includes('>Kicken</button>'));
  assert.match(await view(base({ banFor: player })), /Spieler sofort kicken/);
  const { B3_ADMIN_MESSAGES, actionMessage } = await import('../lib/b3-admin-messages.mjs');
  for (const code of ['RCON_KICK_NOT_ONLINE', 'RCON_KICK_TARGET_CHANGED', 'RCON_KICK_INVALID', 'RCON_KICK_NOT_CONFIRMED', 'RCON_UNAVAILABLE', 'RCON_SERVER_NOT_RUNNING']) assert.equal(B3_ADMIN_MESSAGES[code]?.length, 2, code);
  assert.equal(actionMessage('ban', { id: 1, kick: 'kicked' }, true), 'Ban gespeichert, Spieler gekickt.');
  assert.equal(actionMessage('ban', { id: 1, kick: 'not_online' }, true), 'Ban gespeichert; Spieler ist nicht online.');
});

test('R5: kicks from B3 rows ask first; ban-and-kick passes the ban reason when it is a valid kick reason', { skip }, async () => {
  const { kickReasonFromBan } = await import('../lib/b3-admin-messages.mjs');
  assert.equal(kickReasonFromBan('Wallhack'), 'Wallhack');
  assert.equal(kickReasonFromBan('50% aimbot; obvious'), '');
  assert.equal(kickReasonFromBan('x'.repeat(200)), '');
  const online = await view(base({ players: { total: 1, offset: 0, limit: 50, rows: [{ ...player, online: { slot: 3 } }] }, kickFor: { ...player, online: { slot: 3 } } }));
  assert.match(online, /Tester jetzt vom Server kicken\?/);
});
