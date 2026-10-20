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
  const helper = async (request, options = {}) => {
    if (scriptedHelper.inScope && !scriptedHelper.inScope()) throw new Error('helper called outside a vault scope');
    options.onRequestWritten?.();
    if (script.hold) await script.hold;
    calls.push({ op: request.op, statements: request.statements, target: request.target, password: request.password.toString() });
    const next = script[request.op]?.shift();
    if (!next) throw new Error(`unexpected ${request.op}`);
    if (next.after) next.after();
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
  const vault = { scopes: 0, open: 0, lease: null, lockNow() { locked = true; if (vault.lease) { vault.lease.b3db?.fill(0); vault.lease.controller.abort(); } } };
  scriptedHelper.inScope = () => vault.open > 0;
  const credentials = {
    async withRuntimeCredentials(id, fn) {
      if (locked) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
      if (vault.busyAt === vault.scopes + 1) { vault.scopes++; throw Object.assign(new Error('VAULT_OPERATION_BUSY'), { code: 'VAULT_OPERATION_BUSY' }); }
      const b3db = password ? Buffer.from(password) : null;
      const controller = new AbortController();
      vault.lease = { b3db, controller }; vault.scopes++; vault.open++;
      try {
        const result = await fn(Object.freeze({ rcon: null, master: null, join: null, b3db }), controller.signal);
        if (controller.signal.aborted || locked) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
        return result;
      } finally { b3db?.fill(0); vault.lease = null; vault.open--; }
    },
    async instanceStatus() { return { locked, b3db: { configured: locked ? null : Boolean(password) } }; },
  };
  const service = new InstanceB3DatabaseService({
    store: { get: id => { assert.equal(id, 'server-a'); return instance; } },
    credentials, environment: { read: async () => ({ pythonPath: '/usr/bin/python2.7', b3Path }) },
    b3IsRunning: async () => running, onEvent: event => events.push(event), helper, now: () => new Date('2026-10-20T10:15:00.000Z'),
  });
  const rawSave = service.save.bind(service);
  service.save = async (id, input) => { const result = await rawSave(id, input); await service.invalidate(id); return result; };
  try { await action({ service, calls, events, instance, root, vault, rawSave }); }
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

test('each helper call runs in its own short vault scope', async () => {
  const { penalties, ...partial } = complete();
  await fixture({ probe: [{ tables: partial }, { tables: complete() }], backup: [{ tables: { clients: 1 } }], apply: [{ statements: 1 }] }, async ({ service, calls, vault }) => {
    await service.save('server-a', SETTINGS);
    await service.migrate('server-a');
    assert.equal(calls.length, 4);
    assert.equal(vault.scopes, 4, 'one vault scope per helper call, none spanning the migration');
  });
});

test('vault lock between backup and apply: nothing applied, VAULT_LOCKED, state unchanged', async () => {
  const { penalties, ...partial } = complete();
  let vault;
  await fixture({ probe: [{ tables: partial }], backup: [{ tables: { clients: 1 }, after: () => vault.lockNow() }], apply: [{ statements: 1 }] }, async context => {
    vault = context.vault;
    const { service, calls, instance } = context;
    await service.save('server-a', SETTINGS);
    const before = await fs.readFile(file(instance), 'utf8');
    await assert.rejects(service.migrate('server-a'), { code: 'VAULT_LOCKED' });
    assert.ok(!calls.some(call => call.op === 'apply'));
    assert.equal(await fs.readFile(file(instance), 'utf8'), before);
  });
});

test('vault lock while SQL runs: VAULT_LOCKED recorded, not ready, no misleading MIGRATION_FAILED', async () => {
  const { penalties, ...partial } = complete();
  let vault;
  await fixture({ probe: [{ tables: partial }, { tables: complete() }], backup: [{ tables: { clients: 1 } }], apply: [{ statements: 1, after: () => vault.lockNow() }] }, async context => {
    vault = context.vault;
    const { service, events, instance } = context;
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.migrate('server-a'), { code: 'VAULT_LOCKED' });
    const stored = JSON.parse(await fs.readFile(file(instance), 'utf8'));
    assert.deepEqual([stored.lastCheck.code, stored.lastCheck.ready], ['VAULT_LOCKED', false]);
    assert.match(stored.lastCheck.backup.path, /b3-20261020T101500Z\.sql$/);
    assert.ok(!events.some(event => event.cause === 'DB_AUTH_FAILED'));
  });
});

test('once ready, MySQL stays enabled until the settings are removed; isBusy reports running operations', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await fixture({ probe: [{ tables: complete() }] }, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    assert.equal((await service.read('server-a')).mysqlEnabled, false);
    await service.test('server-a');
    assert.deepEqual([(await service.read('server-a')).ready, (await service.read('server-a')).mysqlEnabled], [true, true]);
    await service.save('server-a', { ...SETTINGS, port: 3307 });
    assert.deepEqual([(await service.read('server-a')).ready, (await service.read('server-a')).mysqlEnabled], [false, true]);
    await service.invalidate('server-a');
    assert.equal((await service.read('server-a')).mysqlEnabled, true);
    service.helper = async () => { await gate; return { tables: complete() }; };
    const running = service.test('server-a');
    assert.equal(service.isBusy('server-a'), true);
    release(); await running;
    assert.equal(service.isBusy('server-a'), false);
    const removed = await service.remove('server-a');
    assert.deepEqual([removed.settings, removed.ready, removed.mysqlEnabled], [null, false, false]);
  });
});

test('vault scope ends as soon as the request is written, not when the helper finishes', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await fixture({ hold, probe: [{ tables: complete() }] }, async ({ service, vault }) => {
    await service.save('server-a', SETTINGS);
    const running = service.test('server-a');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(vault.open, 0, 'no vault scope is held while the helper runs');
    release();
    assert.equal((await running).ready, true);
  });
});

test('a busy vault aborts a migration step without recording a failed migration', async () => {
  const { penalties, ...partial } = complete();
  await fixture({ probe: [{ tables: partial }], backup: [{ tables: { clients: 1 } }], apply: [{ statements: 1 }] }, async ({ service, calls, events, vault, instance }) => {
    await service.save('server-a', SETTINGS);
    const before = await fs.readFile(file(instance), 'utf8');
    vault.busyAt = vault.scopes + 3; // probe, backup, then the apply scope is busy
    await assert.rejects(service.migrate('server-a'), { code: 'VAULT_OPERATION_BUSY' });
    assert.ok(!calls.some(call => call.op === 'apply'));
    assert.ok(!events.some(event => event.event === 'b3.database.migration_failed'));
    assert.equal(await fs.readFile(file(instance), 'utf8'), before);
  });
});

test('changing host, port or user requires re-entering the password before it is sent anywhere', async () => {
  await fixture({ probe: [{ tables: complete() }, { tables: complete() }] }, async ({ service, calls, rawSave }) => {
    await service.save('server-a', SETTINGS);
    assert.equal((await service.test('server-a')).ready, true);
    for (const changed of [{ host: 'evil.example' }, { port: 3307 }, { username: 'other' }]) {
      await rawSave('server-a', { ...SETTINGS, ...changed });
      await assert.rejects(service.test('server-a'), { code: 'B3_DATABASE_PASSWORD_REENTRY_REQUIRED' });
      assert.equal(await service.connectionFor('server-a', Buffer.from(PASSWORD)), null);
      assert.equal((await service.read('server-a')).passwordBound, false);
    }
    assert.equal(calls.length, 1, 'the password never reached the changed target');
    await rawSave('server-a', { ...SETTINGS, database: 'b3_other' });
    await rawSave('server-a', SETTINGS);
    await service.invalidate('server-a'); // password entered again
    assert.equal((await service.read('server-a')).passwordBound, true);
    assert.equal((await service.test('server-a')).ready, true);
  });
});

test('a password stored before the settings must be entered again', async () => {
  await fixture({}, async ({ service, calls, rawSave }) => {
    await rawSave('server-a', SETTINGS);
    await assert.rejects(service.test('server-a'), { code: 'B3_DATABASE_PASSWORD_REENTRY_REQUIRED' });
    await assert.rejects(service.migrate('server-a'), { code: 'B3_DATABASE_PASSWORD_REENTRY_REQUIRED' });
    assert.equal(calls.length, 0);
  });
});

// --- Second review suggestions -------------------------------------------------
test('S1: B3 start and migration exclude each other through the start guard', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await fixture({ probe: [{ tables: complete() }] }, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    const starting = service.withStartGuard('server-a', async () => { await gate; return 'started'; });
    await assert.rejects(service.migrate('server-a'), { code: 'B3_DATABASE_BUSY' });
    release();
    assert.equal(await starting, 'started');
    const migrating = service.test('server-a');
    await assert.rejects(service.withStartGuard('server-a', async () => 'started'), { code: 'B3_DATABASE_BUSY' });
    await migrating;
  });
});

test('S2: an in-progress marker is stored before the first SQL runs', async () => {
  const { penalties, ...partial } = complete();
  let seen;
  await fixture({ probe: [{ tables: partial }, { tables: complete() }], backup: [{ tables: { clients: 1 } }], apply: [{ statements: 1 }] }, async ({ service, instance }) => {
    await service.save('server-a', SETTINGS);
    service.helper = (inner => async (request, options) => {
      if (request.op === 'apply') seen = JSON.parse(await fs.readFile(file(instance), 'utf8')).lastCheck;
      return inner(request, options);
    })(service.helper);
    await service.migrate('server-a');
    assert.deepEqual([seen.code, seen.ready], ['MIGRATION_IN_PROGRESS', false]);
    assert.match(seen.backup.path, /b3-20261020T101500Z\.sql$/);
    assert.equal((await service.read('server-a')).ready, true);
  });
});

test('S3: removing the settings is refused while B3 runs', async () => {
  await fixture({}, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    await assert.rejects(service.remove('server-a'), { code: 'B3_RUNNING' });
    assert.ok((await service.read('server-a')).settings);
  }, { running: true });
});

test('S4: a vault lock right after a successful backup still reports the verified backup', async () => {
  const { penalties, ...partial } = complete();
  let vault;
  await fixture({ probe: [{ tables: partial }], backup: [{ tables: { clients: 1 }, after: () => vault.lockNow() }] }, async context => {
    vault = context.vault;
    const { service, events } = context;
    await service.save('server-a', SETTINGS);
    const error = await service.migrate('server-a').catch(e => e);
    assert.equal(error.code, 'VAULT_LOCKED');
    assert.match(error.backup?.path || '', /b3-20261020T101500Z\.sql$/);
    assert.ok(events.some(event => event.event === 'b3.database.backup_created' && event.backupSha256 === error.backup.sha256));
  });
});

// --- Codex review on PR #7 -----------------------------------------------------
test('C2: a password change during a running test is never overwritten with ready', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await fixture({ hold, probe: [{ tables: complete() }] }, async ({ service, instance }) => {
    await service.save('server-a', SETTINGS);
    const running = service.test('server-a');
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.invalidate('server-a'); // b3db changed while the probe runs
    release();
    await running;
    const stored = JSON.parse(await fs.readFile(file(instance), 'utf8'));
    assert.equal(stored.lastCheck?.ready ?? false, false, 'stale test result must not restore readiness');
    assert.equal((await service.read('server-a')).ready, false);
  });
});

test('C5: missing columns of an OUTDATED schema are persisted', async () => {
  const outdated = { ...complete(), clients: CORE.clients.filter(column => column !== 'login') };
  await fixture({ probe: [{ tables: outdated }] }, async ({ service }) => {
    await service.save('server-a', SETTINGS);
    await service.test('server-a');
    assert.deepEqual((await service.read('server-a')).lastCheck.missingColumns, { clients: ['login'] });
  });
});
