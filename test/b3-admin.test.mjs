import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { validateAdminQuery, ADMIN_QUERIES, penaltyStatus, groupFor, maskIp, maskGuid, parseAdminCommands } from '../lib/b3-admin.mjs';

const code = fn => { try { fn(); } catch (error) { return error.code; } return null; };
const GROUPS = [
  { id: 0, name: 'Guest', keyword: 'guest', level: 0 }, { id: 1, name: 'User', keyword: 'user', level: 1 }, { id: 2, name: 'Regular', keyword: 'reg', level: 2 },
  { id: 8, name: 'Moderator', keyword: 'mod', level: 20 }, { id: 16, name: 'Admin', keyword: 'admin', level: 40 }, { id: 32, name: 'Full Admin', keyword: 'fulladmin', level: 60 },
  { id: 64, name: 'Senior Admin', keyword: 'senioradmin', level: 80 }, { id: 128, name: 'Super Admin', keyword: 'superadmin', level: 100 },
];

test('query catalog validates names, parameters and defaults', () => {
  assert.deepEqual([...ADMIN_QUERIES].sort(), ['addBan', 'admins', 'groups', 'liftWarning', 'penalties', 'player', 'players', 'setGroup', 'unban']);
  assert.deepEqual(validateAdminQuery('players', {}), { search: '', limit: 50, offset: 0 });
  assert.deepEqual(validateAdminQuery('players', { search: '50%_x', offset: 100 }), { search: '50%_x', limit: 50, offset: 100 });
  assert.deepEqual(validateAdminQuery('penalties', { type: 'Permanent', status: 'active' }), { type: 'Permanent', status: 'active', limit: 50, offset: 0 });
  assert.deepEqual(validateAdminQuery('addBan', { clientId: 7, kind: 'TempBan', durationMinutes: 60, reason: 'Wallhack' }), { clientId: 7, kind: 'TempBan', durationMinutes: 60, reason: 'Wallhack' });
  assert.deepEqual(validateAdminQuery('addBan', { clientId: 7, kind: 'Ban', reason: 'Cheating' }), { clientId: 7, kind: 'Ban', durationMinutes: 0, reason: 'Cheating' });
  for (const [name, params] of [
    ['drop', {}], ['players', { search: 'x'.repeat(33) }], ['players', { limit: 101 }], ['players', { limit: 0 }], ['players', { offset: -1 }], ['players', { extra: 1 }],
    ['penalties', { type: 'Mute' }], ['penalties', { status: 'old' }], ['player', { clientId: 0 }], ['player', { clientId: '7' }],
    ['addBan', { clientId: 7, kind: 'TempBan', durationMinutes: 0, reason: 'x' }], ['addBan', { clientId: 7, kind: 'TempBan', durationMinutes: 525601, reason: 'x' }],
    ['addBan', { clientId: 7, kind: 'Kick', reason: 'x' }], ['addBan', { clientId: 7, kind: 'Ban', reason: '' }], ['addBan', { clientId: 7, kind: 'Ban', reason: 'x'.repeat(256) }],
    ['addBan', { clientId: 7, kind: 'Ban', reason: 'line\nbreak' }], ['setGroup', { clientId: 7, groupId: -1 }], ['liftWarning', { penaltyId: 1.5 }],
  ]) assert.equal(code(() => validateAdminQuery(name, params)), 'B3_ADMIN_INPUT_INVALID', `${name} ${JSON.stringify(params)}`);
});

test('penalty status matches B3 (time_expire > now is active, equal is expired)', () => {
  const now = 1_800_000_000;
  assert.equal(penaltyStatus({ inactive: 0, time_expire: -1 }, now), 'active');
  assert.equal(penaltyStatus({ inactive: 0, time_expire: now + 1 }, now), 'active');
  assert.equal(penaltyStatus({ inactive: 0, time_expire: now }, now), 'expired');
  assert.equal(penaltyStatus({ inactive: 0, time_expire: now - 10 }, now), 'expired');
  assert.equal(penaltyStatus({ inactive: 1, time_expire: -1 }, now), 'lifted');
});

test('group is the highest level among the set bits; no bit is Guest', () => {
  assert.equal(groupFor(0, GROUPS).name, 'Guest');
  assert.equal(groupFor(1, GROUPS).name, 'User');
  assert.equal(groupFor(16 | 1, GROUPS).name, 'Admin');
  assert.equal(groupFor(128 | 16, GROUPS).name, 'Super Admin');
  assert.equal(groupFor(4, GROUPS), null);
});

test('masking hides the host part of IPv4 and all but four GUID characters', () => {
  assert.equal(maskIp('203.0.113.77'), '203.0.113.x');
  assert.equal(maskIp('bot'), 'x');
  assert.equal(maskIp(''), 'x');
  assert.equal(maskGuid('ABCDEF0123456789A1B2'), '…A1B2');
  assert.equal(maskGuid('A1B2'), '…');
  assert.equal(maskGuid(''), '…');
});

test('commands come from the real eBc-B3 plugin_admin.ini', async () => {
  const commands = parseAdminCommands(await fs.readFile(new URL('./fixtures/b3-plugin_admin.ini', import.meta.url), 'utf8'), GROUPS);
  const find = name => commands.find(entry => entry.command === name);
  assert.deepEqual(find('ban'), { command: 'ban', alias: 'b', level: 40, group: 'Admin' });
  assert.deepEqual(find('putgroup'), { command: 'putgroup', alias: 'pg', level: 80, group: 'Senior Admin' });
  assert.deepEqual(find('help'), { command: 'help', alias: 'h', level: 0, group: 'Guest' });
  assert.deepEqual(find('warns'), { command: 'warns', alias: null, level: 40, group: 'Admin' });
  assert.ok(commands.length >= 60);
  assert.ok(!commands.some(entry => entry.command === 'settings' || entry.command.startsWith('#')));
});
