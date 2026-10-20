import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InstanceB3DatabaseService, verifyBackup } from '../lib/instance-b3-database-service.mjs';
import { parseSchemaFile, EBC_CONFIRMATION } from '../lib/b3-database.mjs';

const PASSWORD = 'Db-Secret-Pass!9';
const SETTINGS = { host: '127.0.0.1', port: 3306, database: 'b3', username: 'b3' };
const fixtures = new URL('./fixtures/', import.meta.url);
const CORE = parseSchemaFile(await fs.readFile(new URL('b3-mysql-b3.sql', fixtures), 'latin1')).tables;
const complete = () => Object.fromEntries(Object.entries(CORE).map(([name, columns]) => [name, [...columns]]));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function backupText(tables) {
  return ['-- COD4X CONTROL B3 backup v1', 'SET NAMES utf8;', ...Object.entries(tables).flatMap(([name, rows]) => [`-- TABLE ${name} ROWS ${rows}`, `DROP TABLE IF EXISTS \`${name}\`;`])].join('\n') + '\n';
}

// Scripted helper: each op pops the next response for that op.
function scriptedHelper(script) {
  const calls = [];
  const helper = async request => {
    calls.push({ op: request.op, statements: request.statements, target: request.target, password: request.password.toString() });
    const next = script[request.op]?.shift();
    if (!next) throw new Error(`unexpected ${request.op}`);
    if (next.error) throw Object.assign(new Error(next.error), { code: next.error, mysqlCode: next.mysqlCode ?? null });
    if (request.op === 'backup') {
      const text = next.text ?? backupText(next.tables);
      await fs.writeFile(request.target, text, { mode: 0o600 });
      return { path: request.target, sha256: next.sha256 ?? sha(Buffer.from(text)), tables: next.tables };
    }
    return next;
  };
  return { helper, calls };
}

async function fixture(script, action, { running = false, locked = false, password = PASSWORD } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-database-')));
  const b3Path = path.join(root, 'ebc-b3');
  await fs.mkdir(path.join(b3Path, 'b3', 'sql', 'mysql'), { recursive: true });
  await fs.copyFile(new URL('b3-mysql-b3.sql', fixtures), path.join(b3Path, 'b3', 'sql', 'mysql', 'b3.sql'));
  await fs.copyFile(new URL('b3-mysql-b3-update-ebc.sql', fixtures), path.join(b3Path, 'b3', 'sql', 'mysql', 'b3-update-ebc.sql'));
  const instance = { id: 'server-a', homePath: path.join(root, 'home') };
  await fs.mkdir(instance.homePath);
  const events = [];
  const { helper, calls } = scriptedHelper(script);
  const credentials = {
    async withRuntimeCredentials(id, fn) {
      if (locked) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
      const b3db = password ? Buffer.from(password) : null;
      try { return await fn(Object.freeze({ rcon: null, master: null, join: null, b3db }), new AbortController().signal); } finally { b3db?.fill(0); }
    },
    async instanceStatus() { return { locked, b3db: { configured: locked ? null : Boolean(password) } }; },
  };
  const service = new InstanceB3DatabaseService({
    store: { get: id => { assert.equal(id, 'server-a'); return instance; } },
    credentials, environment: { read: async () => ({ pythonPath: '/usr/bin/python2.7', b3Path }) },
    b3IsRunning: async () => running, onEvent: event => events.push(event), helper, now: () => new Date('2026-10-20T10:15:00.000Z'),
  });
  try { await action({ service, calls, events, instance, root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const file = instance => path.join(instance.homePath, 'b3', 'database.json');
const noSecret = (...values) => { for (const value of values) assert.ok(!JSON.stringify(value ?? null).includes(PASSWORD), 'password leaked'); };

test('test reports each connection failure and persists it without values', async () => {
  for (const code of ['DB_UNREACHABLE', 'DB_AUTH_FAILED', 'DB_NOT_FOUND', 'DB_DRIVER_MISSING']) {
    await fixture({ probe: [{ error: code }] }, async ({ service, events, instance }) => {
      await service.save('server-a', SETTINGS);
      const result = await service.test('server-a');
      assert.deepEqual([result.connection, result.schema, result.ready], [code, null, false]);
      const stored = JSON.parse(await fs.readFile(file(instance), 'utf8'));
      assert.equal(stored.lastCheck.connection, code);
      assert.equal(events.at(-1).event, 'b3.database.tested');
      noSecret(result, stored, events);
    });
  }
});

test('test reports SCHEMA_PARTIAL with missing tables and SCHEMA_OUTDATED with missing columns', async () => {
  const { penalties, ...partial } = complete();
  const outdated = { ...complete(), clients: CORE.clients.filter(column => column !== 'login') };
  await fixture({ probe: [{ version: '10.11', tables: partial }, { version: '10.11', tables: outdated }, { version: '10.11', tables: complete() }] }, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    const first = await service.test('server-a');
    assert.deepEqual([first.connection, first.code, first.schema.state, first.schema.missingTables, first.ready], ['OK', 'SCHEMA_PARTIAL', 'PARTIAL', ['penalties'], false]);
    const second = await service.test('server-a');
    assert.deepEqual([second.code, second.schema.missingColumns], ['SCHEMA_OUTDATED', { clients: ['login'] }]);
    const third = await service.test('server-a');
    assert.deepEqual([third.code, third.ready], [null, true]);
    assert.equal((await service.read('server-a')).ready, true);
  });
});

test('migrate on EMPTY runs the core schema without backup and ends ready', async () => {
  await fixture({ probe: [{ tables: {} }, { tables: complete() }], apply: [{ statements: 14 }] }, async ({ service, calls, events }) => {
    await service.save('server-a', SETTINGS);
    const result = await service.migrate('server-a');
    assert.deepEqual([result.backup, result.files, result.schema.state, result.ready], [null, ['b3/sql/mysql/b3.sql'], 'COMPLETE', true]);
    const apply = calls.find(call => call.op === 'apply');
    assert.equal(apply.statements.filter(sql => /^CREATE TABLE/i.test(sql)).length, 6);
    assert.ok(!calls.some(call => call.op === 'backup'));
    assert.equal(events.at(-1).event, 'b3.database.migrated');
    noSecret(result, events);
  });
});

test('migrate on PARTIAL backs up first, verifies it and only creates the missing tables', async () => {
  const { penalties, data, ...partial } = complete();
  await fixture({ probe: [{ tables: partial }, { tables: complete() }], backup: [{ tables: { aliases: 0, ipaliases: 0, clients: 3, groups: 8 } }], apply: [{ statements: 2 }] }, async ({ service, calls, events }) => {
    await service.save('server-a', SETTINGS);
    const result = await service.migrate('server-a');
    assert.equal(calls.map(call => call.op).join(','), 'probe,backup,apply,probe');
    assert.match(result.backup.path, /[\\/]b3[\\/]backups[\\/]b3-20261020T101500Z\.sql$/);
    assert.match(result.backup.sha256, /^[a-f0-9]{64}$/);
    const statements = calls.find(call => call.op === 'apply').statements;
    assert.deepEqual(statements.map(sql => /`(\w+)`/.exec(sql)[1]), ['penalties', 'data']);
    assert.ok(events.some(event => event.event === 'b3.database.backup_created' && event.backupSha256 === result.backup.sha256));
  });
});

test('aborts on unverifiable backup before any SQL runs', async () => {
  const { penalties, ...partial } = complete();
  for (const broken of [{ tables: { clients: 3 }, text: backupText({ clients: 2 }) }, { tables: { clients: 3 }, sha256: 'f'.repeat(64) }, { tables: { clients: 3 }, text: 'garbage\n' }]) {
    await fixture({ probe: [{ tables: partial }], backup: [broken] }, async ({ service, calls, events }) => {
      await service.save('server-a', SETTINGS);
      await assert.rejects(service.migrate('server-a'), { code: 'BACKUP_FAILED' });
      assert.ok(!calls.some(call => call.op === 'apply'));
      assert.equal(events.at(-1).event, 'b3.database.migration_failed');
    });
  }
});

test('ebc opt-in needs the exact phrase and runs the eBc schema after a backup', async () => {
  const withEbc = { ...complete(), player_core: ['id'], prestige_log: ['id'] };
  await fixture({ probe: [{ tables: complete() }, { tables: complete() }, { tables: withEbc }], backup: [{ tables: { clients: 1 } }], apply: [{ statements: 20 }] }, async ({ service, calls }) => {
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.migrate('server-a', { ebcOptIn: true, confirmation: 'yes' }), { code: 'EBC_CONFIRMATION_REQUIRED' });
    const result = await service.migrate('server-a', { ebcOptIn: true, confirmation: EBC_CONFIRMATION });
    assert.deepEqual(result.files, ['b3/sql/mysql/b3-update-ebc.sql']);
    assert.ok(calls.find(call => call.op === 'apply').statements.some(sql => /^DROP TABLE IF EXISTS `player_core`/.test(sql)));
    assert.equal(calls.filter(call => call.op === 'backup').length, 1);
  });
});

test('post-migration probe not COMPLETE or failing apply -> MIGRATION_FAILED with backup path', async () => {
  const { penalties, ...partial } = complete();
  await fixture({ probe: [{ tables: partial }, { tables: partial }, { tables: partial }], backup: [{ tables: { clients: 1 } }, { tables: { clients: 1 } }], apply: [{ statements: 1 }, { error: 'DB_ERROR', mysqlCode: 1062 }] }, async ({ service, events, instance }) => {
    await service.save('server-a', SETTINGS);
    const error = await service.migrate('server-a').catch(e => e);
    assert.equal(error.code, 'MIGRATION_FAILED');
    assert.match(error.backup.path, /b3-20261020T101500Z\.sql$/);
    const second = await service.migrate('server-a').catch(e => e);
    assert.equal(second.code, 'MIGRATION_FAILED');
    assert.equal(events.at(-1).cause, 'DB_ERROR');
    const stored = JSON.parse(await fs.readFile(file(instance), 'utf8'));
    assert.deepEqual([stored.lastCheck.code, stored.lastCheck.ready], ['MIGRATION_FAILED', false]);
  });
});

test('refuses migration while B3 runs and outdated schemas', async () => {
  await fixture({}, async ({ service, calls }) => {
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.migrate('server-a'), { code: 'B3_RUNNING' });
    assert.equal(calls.length, 0);
  }, { running: true });
  const outdated = { ...complete(), clients: ['id'] };
  await fixture({ probe: [{ tables: outdated }] }, async ({ service, calls }) => {
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.migrate('server-a'), { code: 'SCHEMA_OUTDATED' });
    assert.ok(!calls.some(call => call.op === 'backup' || call.op === 'apply'));
  });
});

test('concurrent operations on one instance -> B3_DATABASE_BUSY', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await fixture({}, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    service.helper = async () => { await gate; return { tables: complete() }; };
    const first = service.test('server-a');
    await assert.rejects(service.test('server-a'), { code: 'B3_DATABASE_BUSY' });
    await assert.rejects(service.save('server-a', SETTINGS), { code: 'B3_DATABASE_BUSY' });
    release();
    assert.equal((await first).ready, true);
  });
});

test('settings change and invalidate clear readiness', async () => {
  await fixture({ probe: [{ tables: complete() }, { tables: complete() }] }, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    await service.test('server-a');
    assert.equal((await service.read('server-a')).ready, true);
    await service.save('server-a', { ...SETTINGS, port: 3307 });
    assert.deepEqual([(await service.read('server-a')).ready, (await service.read('server-a')).lastCheck], [false, null]);
    await service.test('server-a');
    await service.invalidate('server-a');
    assert.equal((await service.read('server-a')).ready, false);
  });
});

test('vault locked or password missing -> no partial writes', async () => {
  await fixture({}, async ({ service, instance, calls }) => {
    await service.save('server-a', SETTINGS);
    const before = await fs.readFile(file(instance), 'utf8');
    await assert.rejects(service.test('server-a'), { code: 'VAULT_LOCKED' });
    await assert.rejects(service.migrate('server-a'), { code: 'VAULT_LOCKED' });
    assert.equal(await fs.readFile(file(instance), 'utf8'), before);
    assert.equal(calls.length, 0);
    assert.equal((await service.read('server-a')).passwordConfigured, null);
  }, { locked: true });
  await fixture({}, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.test('server-a'), { code: 'B3_DATABASE_PASSWORD_MISSING' });
  }, { password: null });
  await fixture({}, async ({ service }) => {
    await assert.rejects(service.test('server-a'), { code: 'B3_DATABASE_NOT_CONFIGURED' });
    await assert.rejects(service.save('server-a', { ...SETTINGS, host: 'a/b' }), { code: 'B3_DATABASE_SETTINGS_INVALID' });
  });
});

test('database.json holds no password, is 0600 on POSIX, and connectionFor needs readiness', async () => {
  await fixture({ probe: [{ tables: complete() }] }, async ({ service, instance }) => {
    await service.save('server-a', SETTINGS);
    assert.equal(await service.connectionFor('server-a', Buffer.from(PASSWORD)), null);
    await service.test('server-a');
    const stored = await fs.readFile(file(instance), 'utf8');
    assert.ok(!stored.includes(PASSWORD));
    if (process.platform !== 'win32') assert.equal((await fs.stat(file(instance))).mode & 0o777, 0o600);
    const { dsn } = await service.connectionFor('server-a', Buffer.from(PASSWORD));
    assert.equal(dsn, `mysql://b3:${PASSWORD}@127.0.0.1:3306/b3`);
    noSecret(await service.read('server-a'));
  });
});

test('verifyBackup checks hash, header and every table marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-backup-verify-'));
  try {
    const target = path.join(dir, 'b.sql');
    const text = backupText({ clients: 2, data: 0 });
    await fs.writeFile(target, text);
    const sha256 = sha(Buffer.from(text));
    await verifyBackup(target, { sha256, tables: { clients: 2, data: 0 } });
    await assert.rejects(verifyBackup(target, { sha256, tables: { clients: 3, data: 0 } }), { code: 'BACKUP_FAILED' });
    await assert.rejects(verifyBackup(target, { sha256, tables: { clients: 2 } }), { code: 'BACKUP_FAILED' });
    await assert.rejects(verifyBackup(target, { sha256: 'a'.repeat(64), tables: { clients: 2, data: 0 } }), { code: 'BACKUP_FAILED' });
    await assert.rejects(verifyBackup(path.join(dir, 'missing.sql'), { sha256, tables: {} }), { code: 'BACKUP_FAILED' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
