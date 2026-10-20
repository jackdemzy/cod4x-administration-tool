import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceB3AdminService } from '../lib/instance-b3-admin-service.mjs';

const NOW = 1_800_000_000;
const IP = '203.0.113.77', GUID = 'ABCDEF0123456789FACE', OLD_IP = '198.51.100.23';
const GROUPS = [[0, 'Guest', 'guest', 0], [1, 'User', 'user', 1], [8, 'Moderator', 'mod', 20], [16, 'Admin', 'admin', 40], [128, 'Super Admin', 'superadmin', 100]];
const CLIENT = [7, 'Tester', GUID, IP, 16, 12, NOW - 5000, NOW - 60];

async function fixture(action, { ready = true, running = false, responses = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-admin-'));
  const b3Path = path.join(root, 'ebc-b3');
  await fs.mkdir(path.join(b3Path, 'b3', 'conf'), { recursive: true });
  await fs.copyFile(new URL('./fixtures/b3-plugin_admin.ini', import.meta.url), path.join(b3Path, 'b3', 'conf', 'plugin_admin.ini'));
  const calls = [], events = [], guarded = [];
  const answers = {
    groups: { rows: GROUPS },
    players: { total: 1, rows: [CLIENT] },
    admins: { rows: [CLIENT] },
    player: { client: CLIENT, aliases: [['OldName', 3, NOW - 9000, NOW - 8000]], ips: [[OLD_IP, 2, NOW - 9000, NOW - 8000]] },
    penalties: { total: 2, rows: [[1, 'TempBan', 7, 'Tester', GUID, 0, 10, 0, 'Wallhack', NOW - 100, NOW + 500], [2, 'Warning', 7, 'Tester', GUID, 3, 0, 0, 'Spam', NOW - 50, NOW]] },
    unban: { affected: 2 }, addBan: { id: 99 }, setGroup: { affected: 1 }, liftWarning: { affected: 1 },
    ...responses,
  };
  const database = {
    read: async () => ({ ready }),
    async query(id, name, params, options = {}) {
      calls.push({ name, params, write: options.write === true });
      if (!ready) throw Object.assign(new Error('B3_DATABASE_NOT_READY'), { code: 'B3_DATABASE_NOT_READY' });
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
    async withStartGuard(id, fn) { guarded.push(id); return fn(); },
  };
  const service = new InstanceB3AdminService({ store: { get: () => ({ id: 'server-a' }) }, database, environment: { read: async () => ({ pythonPath: '/usr/bin/python2.7', b3Path }) },
    b3IsRunning: async () => running, onEvent: event => events.push(event), now: () => NOW * 1000 });
  try { await action({ service, calls, events, guarded, b3Path }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('reads are masked without config.manage: no full IP or GUID anywhere', async () => {
  await fixture(async ({ service }) => {
    const masked = [await service.players('server-a', {}), await service.admins('server-a'), await service.player('server-a', 7), await service.penalties('server-a', {})];
    for (const value of masked) for (const secret of [IP, GUID, OLD_IP]) assert.ok(!JSON.stringify(value).includes(secret), `${secret} leaked`);
    const [players, , detail, penalties] = masked;
    assert.deepEqual(players.rows[0], { id: 7, name: 'Tester', guid: '…FACE', ip: '203.0.113.x', group: 'Admin', level: 40, connections: 12, firstSeen: NOW - 5000, lastSeen: NOW - 60 });
    assert.deepEqual(detail.ips[0], { ip: '198.51.100.x', used: 2, firstSeen: NOW - 9000, lastSeen: NOW - 8000 });
    assert.deepEqual(detail.aliases[0], { alias: 'OldName', used: 3, firstSeen: NOW - 9000, lastSeen: NOW - 8000 });
    assert.deepEqual(penalties.rows.map(row => [row.type, row.status, row.permanent]), [['TempBan', 'active', false], ['Warning', 'expired', false]]);
    const full = await service.players('server-a', {}, { full: true });
    assert.deepEqual([full.rows[0].ip, full.rows[0].guid], [IP, GUID]);
  });
});

test('reads validate their parameters and require a ready database', async () => {
  await fixture(async ({ service, calls }) => {
    await assert.rejects(service.players('server-a', { limit: 500 }), { code: 'B3_ADMIN_INPUT_INVALID' });
    await assert.rejects(service.penalties('server-a', { type: 'Mute' }), { code: 'B3_ADMIN_INPUT_INVALID' });
    assert.equal(calls.filter(call => call.name !== 'groups').length, 0);
  });
  await fixture(async ({ service }) => {
    await assert.rejects(service.players('server-a', {}), { code: 'B3_DATABASE_NOT_READY' });
    await assert.rejects(service.commands('server-a'), { code: 'B3_DATABASE_NOT_READY' });
  }, { ready: false });
});

test('actions are writes with value-free audit events', async () => {
  await fixture(async ({ service, calls, events }) => {
    assert.deepEqual(await service.addBan('server-a', 7, { kind: 'TempBan', durationMinutes: 60, reason: 'Wallhack by Tester' }, 'admin1'), { id: 99 });
    assert.deepEqual(await service.unban('server-a', 7, 'admin1'), { affected: 2 });
    assert.deepEqual(await service.liftWarning('server-a', 2, 'admin1'), { affected: 1 });
    assert.deepEqual(calls.filter(call => call.write).map(call => [call.name, call.params]), [
      ['addBan', { clientId: 7, kind: 'TempBan', durationMinutes: 60, reason: 'Wallhack by Tester' }], ['unban', { clientId: 7 }], ['liftWarning', { penaltyId: 2 }]]);
    assert.deepEqual(events.map(event => event.event), ['b3.admin.ban_added', 'b3.admin.unbanned', 'b3.admin.warning_lifted']);
    assert.deepEqual(events[0], { event: 'b3.admin.ban_added', instanceId: 'server-a', actor: 'admin1', clientId: 7, kind: 'TempBan', durationMinutes: 60 });
    assert.equal(events[1].count, 2);
    for (const secret of ['Wallhack', 'Tester', IP, GUID]) assert.ok(!JSON.stringify(events).includes(secret));
    await assert.rejects(service.addBan('server-a', 7, { kind: 'TempBan', durationMinutes: 0, reason: 'x' }, 'admin1'), { code: 'B3_ADMIN_INPUT_INVALID' });
  });
});

test('set group runs inside the start guard and refuses while B3 runs', async () => {
  await fixture(async ({ service, calls, events, guarded }) => {
    assert.deepEqual(await service.setGroup('server-a', 7, 16, 'admin1'), { affected: 1 });
    assert.deepEqual(guarded, ['server-a']);
    assert.deepEqual(events.at(-1), { event: 'b3.admin.group_changed', instanceId: 'server-a', actor: 'admin1', clientId: 7, groupKeyword: 'admin' });
    assert.ok(calls.some(call => call.name === 'setGroup'));
  });
  await fixture(async ({ service, calls }) => {
    await assert.rejects(service.setGroup('server-a', 7, 16, 'admin1'), { code: 'B3_RUNNING' });
    assert.ok(!calls.some(call => call.name === 'setGroup'));
  }, { running: true });
});

test('commands come from plugin_admin.ini with group names; a missing file is reported', async () => {
  await fixture(async ({ service, b3Path }) => {
    const commands = await service.commands('server-a');
    assert.deepEqual(commands.find(entry => entry.command === 'ban'), { command: 'ban', alias: 'b', level: 40, group: 'Admin' });
    await fs.rm(path.join(b3Path, 'b3', 'conf', 'plugin_admin.ini'));
    await assert.rejects(service.commands('server-a'), { code: 'B3_ADMIN_COMMANDS_UNAVAILABLE' });
    await fs.writeFile(path.join(b3Path, 'b3', 'conf', 'plugin_admin.ini'), Buffer.alloc(65 * 1024, 0x61));
    await assert.rejects(service.commands('server-a'), { code: 'B3_ADMIN_COMMANDS_UNAVAILABLE' });
  });
});
