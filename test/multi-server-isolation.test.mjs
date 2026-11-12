import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceB3DatabaseService } from '../lib/instance-b3-database-service.mjs';

// Block 17 (4.18.22): cross-contamination between instances.
const SETTINGS = { host: '127.0.0.1', port: 3306, database: 'b3', username: 'b3' };

async function databaseFixture(t, ids = ['server-a', 'server-b']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-multi-db-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instances = new Map(ids.map(id => [id, { id, homePath: path.join(root, id) }]));
  for (const { homePath } of instances.values()) await fs.mkdir(homePath, { recursive: true });
  const store = {
    get: id => { if (!instances.has(id)) throw Object.assign(new Error('INSTANCE_NOT_FOUND'), { code: 'INSTANCE_NOT_FOUND' }); return instances.get(id); },
    list: () => [...instances.values()],
  };
  const service = new InstanceB3DatabaseService({ store, credentials: { instanceStatus: async () => ({ b3db: { configured: true } }) }, environment: {}, b3IsRunning: async () => false });
  const file = id => path.join(instances.get(id).homePath, 'b3', 'database.json');
  const enable = async id => { const document = JSON.parse(await fs.readFile(file(id), 'utf8')); document.mysqlEnabled = true; await fs.writeFile(file(id), JSON.stringify(document)); };
  return { service, file, enable };
}

test('B3 database: a second instance cannot save the same MySQL target (named code, other instance only)', async t => {
  const { service } = await databaseFixture(t);
  await service.save('server-a', SETTINGS);
  await assert.rejects(service.save('server-b', SETTINGS), error => error.code === 'B3_DATABASE_TARGET_SHARED' && error.otherInstanceId === 'server-a' && !/username|host|password/i.test(JSON.stringify(error)));
  await assert.rejects(service.save('server-b', { ...SETTINGS, host: 'localhost', username: 'someone_else' }), { code: 'B3_DATABASE_TARGET_SHARED' });
  assert.equal((await service.read('server-b')).settings, null, 'nothing was stored for the rejected instance');
});

test('B3 database: another database name, port or host is accepted; re-saving the own target is fine', async t => {
  const { service } = await databaseFixture(t);
  await service.save('server-a', SETTINGS);
  await service.save('server-b', { ...SETTINGS, database: 'b3_two' });
  await service.save('server-a', SETTINGS);
  await service.save('server-a', { ...SETTINGS, port: 3307 });
  await service.save('server-b', { ...SETTINGS, host: '10.0.0.5' });
});

test('B3 database: a saved target belongs to its instance; sharedTarget reports it to the other once that one runs on MySQL', async t => {
  const { service, file, enable } = await databaseFixture(t);
  await service.save('server-a', SETTINGS);
  await service.save('server-b', { ...SETTINGS, database: 'b3_two' });
  assert.equal(await service.sharedTarget('server-a'), null);
  // server-b is changed on disk to the target of server-a (e.g. an install from before this check).
  const document = JSON.parse(await fs.readFile(file('server-b'), 'utf8'));
  document.settings.database = 'b3';
  await fs.writeFile(file('server-b'), JSON.stringify(document));
  assert.equal(await service.sharedTarget('server-a'), null, 'server-a does not use MySQL yet');
  await enable('server-a');
  assert.equal(await service.sharedTarget('server-a'), 'server-b', 'server-b only saved the target, which is enough');
  assert.equal(await service.sharedTarget('server-b'), null, 'server-b does not use MySQL yet');
  await enable('server-b');
  assert.equal(await service.sharedTarget('server-b'), 'server-a');
});

test('B3 database: saving the unchanged own target is allowed even where it is already shared; a change to another taken target is not', async t => {
  const { service, file } = await databaseFixture(t);
  await service.save('server-a', SETTINGS);
  await service.save('server-b', { ...SETTINGS, database: 'b3_two' });
  const document = JSON.parse(await fs.readFile(file('server-b'), 'utf8'));
  document.settings.database = 'b3';
  await fs.writeFile(file('server-b'), JSON.stringify(document));
  await service.save('server-b', SETTINGS);
  await service.save('server-b', { ...SETTINGS, username: 'rebound' });
  await service.save('server-b', { ...SETTINGS, database: 'b3_two' });
  await assert.rejects(service.save('server-b', SETTINGS), { code: 'B3_DATABASE_TARGET_SHARED' }, 'moving back onto the taken target is refused');
});

test('B3 database: two saves of the same target at the same moment let exactly one through', async t => {
  const { service } = await databaseFixture(t);
  const outcomes = await Promise.allSettled([service.save('server-a', SETTINGS), service.save('server-b', SETTINGS)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'B3_DATABASE_TARGET_SHARED');
});

test('B3 database: a sibling whose b3 directory is a symlink is not followed; its target is unknown, so saving fails closed', async t => {
  const { service, file } = await databaseFixture(t);
  const outside = path.join(path.dirname(path.dirname(file('server-a'))), 'outside-b3');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'database.json'), JSON.stringify({ version: 1, settings: { ...SETTINGS, database: 'elsewhere' }, mysqlEnabled: true }));
  await fs.symlink(outside, path.dirname(file('server-a')), 'dir');
  await assert.rejects(service.save('server-b', SETTINGS), error => error.code === 'B3_DATABASE_SIBLING_UNREADABLE' && error.otherInstanceId === 'server-a');
  assert.equal((await service.read('server-b')).settings, null, 'nothing was stored');
});

test('B3 database: a corrupt database.json of a sibling fails closed (issue #30), for save and for the B3 start check', async t => {
  const { service, file, enable } = await databaseFixture(t);
  await service.save('server-a', SETTINGS);
  await service.save('server-b', { ...SETTINGS, database: 'b3_two' });
  await enable('server-b');
  await fs.writeFile(file('server-a'), '{ not json');
  await assert.rejects(service.save('server-b', { ...SETTINGS, database: 'b3_three' }), error => error.code === 'B3_DATABASE_SIBLING_UNREADABLE' && error.otherInstanceId === 'server-a' && !/host|password|username/i.test(JSON.stringify(error)));
  await assert.rejects(service.sharedTarget('server-b'), { code: 'B3_DATABASE_SIBLING_UNREADABLE' });
  // Invalid settings inside valid JSON are unknown as well.
  await fs.writeFile(file('server-a'), JSON.stringify({ version: 1, settings: { host: 'bad host!', port: 3306, database: 'b3', username: 'b3' } }));
  await assert.rejects(service.sharedTarget('server-b'), { code: 'B3_DATABASE_SIBLING_UNREADABLE' });
  // Removing the broken settings gives the target back.
  await fs.rm(file('server-a'));
  assert.equal(await service.sharedTarget('server-b'), null);
});

test('B3 database: a sibling without b3 directory or database.json claims nothing', async t => {
  const { service } = await databaseFixture(t, ['server-a', 'server-b', 'server-c']);
  await service.save('server-b', SETTINGS);
  assert.equal((await service.read('server-b')).settings.database, 'b3');
});

test('B3 database: a known match wins over an unreadable sibling', async t => {
  const { service, file } = await databaseFixture(t, ['server-a', 'server-b', 'server-c']);
  await service.save('server-c', SETTINGS);
  await service.save('server-a', { ...SETTINGS, database: 'b3_a' });
  await fs.writeFile(file('server-a'), '{ not json');
  await assert.rejects(service.save('server-b', SETTINGS), error => error.code === 'B3_DATABASE_TARGET_SHARED' && error.otherInstanceId === 'server-c');
});

test('B3 database: the target cannot change while B3 runs on MySQL (issue #29); unchanged re-save and SQLite stay allowed', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-multi-db-run-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instance = { id: 'server-a', homePath: path.join(root, 'server-a') };
  await fs.mkdir(instance.homePath, { recursive: true });
  let running = false;
  const service = new InstanceB3DatabaseService({ store: { get: () => instance, list: () => [instance] }, credentials: { instanceStatus: async () => ({}) }, environment: {}, b3IsRunning: async () => running });
  const file = path.join(instance.homePath, 'b3', 'database.json');
  running = true;
  await service.save('server-a', SETTINGS); // first settings while B3 runs on SQLite: allowed
  await service.save('server-a', { ...SETTINGS, database: 'b3_other' }); // not on MySQL yet: allowed
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...document, mysqlEnabled: true }));
  await assert.rejects(service.save('server-a', SETTINGS), { code: 'B3_RUNNING' });
  assert.equal((await service.read('server-a')).settings.database, 'b3_other', 'the running target stays saved');
  await service.save('server-a', { ...SETTINGS, database: 'b3_other', username: 'rebound' }); // same target (user only): allowed
  running = false;
  await service.save('server-a', SETTINGS);
});

test('B3 start: blocked while another instance runs B3 on the same MySQL database, nothing written', async t => {
  const { createB3InstanceFixture } = await import('./support/b3-instance-fixture.mjs');
  const { b3Service, create, store } = await createB3InstanceFixture();
  t.after(async () => { try { await b3Service.stop('b3-one'); } catch { /* best effort */ } });
  await create('b3-one');
  const config = path.join(store.get('b3-one').homePath, 'b3', 'b3.xml');
  let shared = null;
  const database = { read: async () => ({ ready: true, mysqlEnabled: true }), isBusy: () => false, sharedTarget: async () => shared, connectionFor: async () => null };
  b3Service.database = database;
  shared = 'b3-two';
  await assert.rejects(b3Service.start('b3-one'), error => error.code === 'B3_DATABASE_TARGET_SHARED');
  await assert.rejects(fs.access(config), { code: 'ENOENT' });
  // Plain SQLite instances never ask: the check only applies to MySQL.
  b3Service.database = { ...database, read: async () => ({ ready: false, mysqlEnabled: false }), sharedTarget: async () => { throw new Error('must not be asked'); } };
  await b3Service.start('b3-one');
});

// ---- Block 17: shared master token / RCON password is a warning, never a block ----
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';

const passphrase = 'Disposable multi-server passphrase!';
async function vaultFixture(t, ids = ['server-a', 'server-b', 'server-c']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-multi-vault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const births = new Map(ids.map((id, index) => [id, `2026-10-04T10:00:0${index}.000Z`]));
  const resolveInstance = id => {
    if (!births.has(id)) throw Object.assign(new Error('Missing test instance'), { code: 'INSTANCE_NOT_FOUND' });
    return { id, homePath: path.join(root, 'servers', id), createdAt: births.get(id) };
  };
  const service = new InstanceCredentialService({ dataRoot: root, resolveInstance });
  await service.initialize(passphrase); await service.unlock(passphrase);
  const set = async (id, kind, value) => service.set(id, kind, { value, expectedSha256: (await service.status()).sha256 });
  return { service, set, births, resolveInstance, root };
}
const MASTER = 'A'.repeat(32);

test('credentials: a master token shared with another instance saves with a warning naming only that instance', async t => {
  const { service, set } = await vaultFixture(t);
  const first = await set('server-a', 'master', MASTER);
  assert.equal(first.warnings, undefined, 'a unique value carries no warning');
  const second = await set('server-b', 'master', MASTER);
  assert.deepEqual(second.warnings, [{ code: 'MASTER_TOKEN_SHARED', instances: ['server-a'] }]);
  assert.ok(!JSON.stringify(second).includes(MASTER));
  assert.equal((await service.instanceStatus('server-b')).master.configured, true, 'the value was stored');
  const third = await set('server-c', 'master', MASTER);
  assert.deepEqual(third.warnings, [{ code: 'MASTER_TOKEN_SHARED', instances: ['server-a', 'server-b'] }]);
});

test('credentials: a shared RCON password warns, a different value or a different kind does not', async t => {
  const { set } = await vaultFixture(t);
  await set('server-a', 'rcon', 'Shared-Rcon-123!');
  assert.deepEqual((await set('server-b', 'rcon', 'Shared-Rcon-123!')).warnings, [{ code: 'RCON_PASSWORD_SHARED', instances: ['server-a'] }]);
  assert.equal((await set('server-c', 'rcon', 'Another-Rcon-123!')).warnings, undefined);
  // The same text as a join password is not a shared RCON password.
  assert.equal((await set('server-c', 'join', 'Shared-Rcon-123!')).warnings, undefined);
});

test('credentials: instanceStatus lists sharedWith (ids only), [] when unique, null while locked', async t => {
  const { service, set } = await vaultFixture(t);
  await set('server-a', 'master', MASTER); await set('server-b', 'master', MASTER); await set('server-c', 'rcon', 'Only-Mine-Rcon-1!');
  const a = await service.instanceStatus('server-a');
  assert.deepEqual([a.master.sharedWith, a.rcon.sharedWith], [['server-b'], []]);
  assert.deepEqual((await service.instanceStatus('server-c')).rcon.sharedWith, []);
  assert.ok(!JSON.stringify(a).includes(MASTER));
  service.lock();
  const locked = await service.instanceStatus('server-a');
  assert.deepEqual([locked.master.sharedWith, locked.rcon.sharedWith], [null, null]);
});

test('credentials: removing the other instance token clears the warning; a recreated or removed instance record is ignored', async t => {
  const { service, set, births } = await vaultFixture(t);
  await set('server-a', 'master', MASTER); await set('server-b', 'master', MASTER);
  await service.remove('server-b', 'master', { expectedSha256: (await service.status()).sha256 });
  assert.deepEqual((await service.instanceStatus('server-a')).master.sharedWith, []);
  await set('server-b', 'master', MASTER);
  // server-b is archived and a new instance reuses the ID: its old record is stale.
  births.set('server-b', '2026-10-05T10:00:00.000Z');
  assert.deepEqual((await service.instanceStatus('server-a')).master.sharedWith, []);
  assert.equal((await set('server-c', 'master', MASTER)).warnings.length, 1, 'only server-a is still a live holder');
  assert.deepEqual((await service.instanceStatus('server-c')).master.sharedWith, ['server-a']);
});

test('credential warning text: German and English, names the other instances, empty when unique or unknown', async () => {
  const { sharedCredentialWarning } = await import('../lib/credential-warnings.mjs');
  assert.equal(sharedCredentialWarning('master', [], true), '');
  assert.equal(sharedCredentialWarning('master', null, true), '');
  assert.equal(sharedCredentialWarning('join', ['server-b'], true), '', 'only master and RCON are compared');
  assert.match(sharedCredentialWarning('master', ['server-b', 'server-c'], true), /Master-Token.*server-b, server-c/s);
  assert.match(sharedCredentialWarning('master', ['server-b'], false), /master token.*server-b/is);
  assert.match(sharedCredentialWarning('rcon', ['server-b'], true), /RCON-Passwort.*server-b/s);
  assert.match(sharedCredentialWarning('rcon', ['server-b'], false), /RCON password.*server-b/s);
});

// ---- Block 17: a hand-edited server.cfg cannot point the game log outside the instance ----
test('managed config: g_log and logfile follow the same rules as the config engine', async () => {
  const { validateManagedConfigText, GAME_LOG_PATH } = await import('../lib/instance-config-validator.mjs');
  const instance = { port: 28960, network: { scope: 'LOOPBACK' } };
  const code = text => { try { validateManagedConfigText(text, instance); return null; } catch (error) { return error.code; } };
  for (const ok of ['set g_log "games_mp.log"', 'set g_log "logs/games_mp.log"', 'set logfile "2"', 'seta logfile 0']) assert.equal(code(ok), null, ok);
  for (const bad of ['set g_log "../../other/main/games_mp.log"', 'set g_log "/etc/x.log"', 'set g_log "C:\\\\x.log"', 'set g_log "logs/../x.log"', 'set g_log "x.txt"', 'set g_log ""', 'set logfile "7"', 'set logfile "two"', 'set logfile "-1"']) {
    assert.equal(code(bad), 'INSTANCE_CONFIG_INVALID', bad);
  }
  // One rule for both modules: the engine imports the validator's pattern.
  assert.ok(GAME_LOG_PATH.test('logs/games_mp.log') && !GAME_LOG_PATH.test('../a.log'));
  const engine = await fs.readFile(new URL('../lib/config-engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /GAME_LOG_PATH/);
  assert.ok(!engine.includes('[a-zA-Z0-9_-]+\\.log$/'), 'config-engine no longer carries its own copy of the pattern');
});

// ---- Block 17: three parallel instances, real vault / RCON service / UDP doubles ----
import { createRconFixture } from './support/rcon-instance-fixture.mjs';
import { createB3InstanceFixture } from './support/b3-instance-fixture.mjs';
import { RconClient } from '../lib/rcon-client.mjs';

const IDS = ['multi-1', 'multi-2', 'multi-3'];
const RCON = Object.fromEntries(IDS.map((id, index) => [id, `Rcon-Pass-${index + 1}-Unique`]));
const TOKEN = Object.fromEntries(IDS.map((id, index) => [id, String(index + 1).repeat(32)]));
const argAfter = (args, name) => { const index = args.findIndex((value, i) => value === '+set' && args[i + 1] === name); return index < 0 ? null : args[index + 2]; };

async function threeInstances(t) {
  const fixture = await createRconFixture();
  t.after(fixture.cleanup);
  for (const id of IDS) { await fixture.create(id); await fixture.setRcon(id, RCON[id]); await fixture.setMaster(id, TOKEN[id]); }
  const states = await Promise.all(IDS.map(id => fixture.manager.launch(id)));
  return { ...fixture, states: Object.fromEntries(IDS.map((id, index) => [id, states[index]])) };
}

test('three parallel instances: own port, home, RCON, master token and answers; no secret reaches a sibling', async t => {
  const { manager, children, store, states } = await threeInstances(t);
  const processes = IDS.map(id => children.get(states[id].pid));
  assert.equal(new Set(IDS.map(id => states[id].status)).size, 1);
  assert.equal(states['multi-1'].status, 'RUNNING');
  assert.equal(new Set(IDS.map(id => store.get(id).port)).size, 3);
  for (const id of IDS) {
    const instance = store.get(id), child = children.get(states[id].pid), others = IDS.filter(other => other !== id);
    assert.equal(argAfter(child.args, 'net_port'), String(instance.port));
    assert.equal(argAfter(child.args, 'fs_homepath'), instance.homePath);
    // Security audit 4.18.26 (A2-1): both secrets arrive through the private +exec file.
    assert.equal(argAfter(child.args, 'rcon_password'), null);
    assert.equal(child.execedSettings.rcon_password, RCON[id]);
    assert.equal(child.execedSettings.sv_authtoken, TOKEN[id]);
    const commandLine = child.args.join(' ');
    for (const other of others) {
      assert.ok(!commandLine.includes(RCON[other]) && !commandLine.includes(TOKEN[other]) && !commandLine.includes(store.get(other).homePath), `${id} must not see ${other}`);
    }
    // The server on this port is this instance: its own hostname, only its own password works.
    const client = new RconClient({ port: instance.port, timeoutMs: 400 });
    const own = await client.execute(Buffer.from(RCON[id]), 'serverinfo');
    assert.match(JSON.stringify(own), new RegExp(`RCON ${id}`));
    for (const other of others) {
      assert.ok(!JSON.stringify(own).includes(`RCON ${other}`));
      await assert.rejects(new RconClient({ port: instance.port, timeoutMs: 400 }).execute(Buffer.from(RCON[other]), 'serverinfo'), error => /RCON/.test(error.code || ''), `${other} password on ${id}`);
    }
  }
  assert.equal(new Set(processes.map(child => child.pid)).size, 3);
  // Runtime state files live in each own home.
  for (const id of IDS) {
    const state = JSON.parse(await fs.readFile(path.join(store.get(id).homePath, 'logs', 'runtime-state.json'), 'utf8'));
    assert.equal(state.instanceId, id);
    assert.ok(!JSON.stringify(state).includes(RCON[id]) && !JSON.stringify(state).includes(TOKEN[id]));
  }
  // Stopping one leaves the other two serving.
  await manager.stop('multi-2');
  assert.equal((await manager.status('multi-2')).runtime.status, 'STOPPED');
  for (const id of ['multi-1', 'multi-3']) {
    assert.equal((await manager.status(id)).runtime.status, 'RUNNING');
    assert.match(JSON.stringify(await new RconClient({ port: store.get(id).port, timeoutMs: 400 }).execute(Buffer.from(RCON[id]), 'serverinfo')), new RegExp(`RCON ${id}`));
  }
});

test('RCON commands for one instance reach only that instance (wrong-RCON error case)', async t => {
  const { rconService, children, states, store } = await threeInstances(t);
  await rconService.connect('multi-1', 'tester');
  await rconService.execute('multi-1', 'serverinfo', 'tester');
  const seen = id => children.get(states[id].pid).server.state.commands;
  assert.ok(seen('multi-1').includes('serverinfo'));
  assert.deepEqual(seen('multi-2'), []);
  assert.deepEqual(seen('multi-3'), []);
  assert.equal(store.get('multi-1').port !== store.get('multi-2').port, true);
});

test('roadmap error cases: taken port, taken ID, foreign homepath and a config with a sibling port', async t => {
  const fixture = await createRconFixture();
  t.after(fixture.cleanup);
  const { manager, store, children } = fixture;
  const one = await fixture.create('multi-1');
  const two = await fixture.create('multi-2');
  const base = { name: 'X', platform: 'windows', serverCore: store.get('multi-1').serverCore, basePath: store.get('multi-1').basePath };
  await assert.rejects(manager.create({ ...base, id: 'multi-3', port: one.port }), { code: 'INSTANCE_PORT_CONFLICT' });
  await assert.rejects(manager.create({ ...base, id: 'multi-1', port: two.port + 1 }), { code: 'INSTANCE_ID_CONFLICT' });
  await assert.rejects(manager.create({ ...base, id: 'multi-3', port: two.port + 2, homePath: store.get('multi-1').homePath }), { code: 'INSTANCE_HOME_INVALID' });
  // server.cfg of multi-1 carries the port of multi-2: the launch is blocked before any process exists.
  await fs.writeFile(store.get('multi-1').configPath, `set sv_hostname "x"\nset net_port "${two.port}"\n`);
  await assert.rejects(manager.launch('multi-1'), { code: 'INSTANCE_CONFIG_INVALID' });
  assert.equal(children.size, 0);
  // ... and a hand-edited g_log pointing into the sibling is blocked the same way.
  await fs.writeFile(store.get('multi-1').configPath, 'set sv_hostname "x"\nset g_log "../../multi-2/main/games_mp.log"\n');
  await assert.rejects(manager.launch('multi-1'), { code: 'INSTANCE_CONFIG_INVALID' });
  assert.equal(children.size, 0);
});

test('B3 assignment: each instance gets its own b3.xml (own port, home, database file, game log)', async t => {
  const fixture = await createB3InstanceFixture();
  t.after(fixture.cleanup);
  const { b3Service, create, store } = fixture;
  await create('multi-1'); await create('multi-2');
  await b3Service.start('multi-1');
  const xml = id => path.join(store.get(id).homePath, 'b3', 'b3.xml');
  await assert.rejects(fs.access(xml('multi-2')), { code: 'ENOENT' }, 'starting B3 for multi-1 writes nothing for multi-2');
  await b3Service.start('multi-2');
  for (const [id, other] of [['multi-1', 'multi-2'], ['multi-2', 'multi-1']]) {
    const text = await fs.readFile(xml(id), 'utf8');
    assert.ok(text.includes(`<set name="port">${store.get(id).port}</set>`));
    assert.ok(text.includes(store.get(id).homePath.replace(/\\/g, '/')) || text.includes(store.get(id).homePath));
    assert.ok(!text.includes(String(store.get(other).port)) && !text.includes(store.get(other).homePath), `${id} b3.xml must not mention ${other}`);
  }
  // Stopping one B3 leaves the other running.
  await b3Service.stop('multi-1');
  assert.equal(await b3Service.isRunning('multi-1'), false);
  assert.equal(await b3Service.isRunning('multi-2'), true);
});

// ---- Block 17 review: runtime credential scopes take turns inside the vault ----
async function scopeFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-multi-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resolveInstance = id => ({ id, homePath: path.join(root, 'servers', id), createdAt: '2026-10-04T10:00:00.000Z' });
  const service = new InstanceCredentialService({ dataRoot: root, resolveInstance, ...options });
  await service.initialize(passphrase); await service.unlock(passphrase);
  for (const id of ['server-a', 'server-b', 'server-c']) await service.set(id, 'rcon', { value: `Rcon-${id}-Value1!`, expectedSha256: (await service.status()).sha256 });
  return service;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('vault scopes: parallel callers take turns instead of failing with VAULT_OPERATION_BUSY', async t => {
  const service = await scopeFixture(t);
  const log = [];
  const scope = (id, ms) => service.withRuntimeCredentials(id, async credentials => {
    log.push(`start ${id}`); const seen = credentials.rcon.toString(); await pause(ms); log.push(`end ${id}`); return seen;
  });
  const results = await Promise.all([scope('server-a', 40), scope('server-b', 5), scope('server-c', 5)]);
  assert.deepEqual(results, ['Rcon-server-a-Value1!', 'Rcon-server-b-Value1!', 'Rcon-server-c-Value1!']);
  assert.deepEqual(log, ['start server-a', 'end server-a', 'start server-b', 'end server-b', 'start server-c', 'end server-c'], 'scopes never overlap');
});

test('vault scopes: a scope opened inside a scope still fails at once (no deadlock) and mutations stay refused', async t => {
  const service = await scopeFixture(t);
  await service.withRuntimeCredentials('server-a', async () => {
    await assert.rejects(Promise.race([service.withRuntimeCredentials('server-b', async () => 'nested'), pause(2000).then(() => 'HUNG')]), { code: 'VAULT_OPERATION_BUSY' });
    await assert.rejects(service.remove('server-b', 'rcon', { expectedSha256: (await service.status()).sha256 }), { code: 'VAULT_OPERATION_BUSY' });
  });
});

test('vault scopes: a waiter gives up with VAULT_OPERATION_BUSY after the wait limit and later callers still run', async t => {
  const service = await scopeFixture(t, { scopeWaitMs: 60 });
  let release;
  const holder = service.withRuntimeCredentials('server-a', () => new Promise(resolve => { release = resolve; }));
  await pause(10);
  await assert.rejects(service.withRuntimeCredentials('server-b', async () => 'never'), { code: 'VAULT_OPERATION_BUSY' });
  release('done'); await holder;
  assert.equal(await service.withRuntimeCredentials('server-c', async () => 'after'), 'after');
});

test('vault scopes: a vault locked while a caller waits fails that caller with VAULT_LOCKED', async t => {
  const service = await scopeFixture(t);
  let release;
  const holder = service.withRuntimeCredentials('server-a', () => new Promise(resolve => { release = resolve; })).catch(error => error.code);
  await pause(10);
  const waiter = service.withRuntimeCredentials('server-b', async () => assert.fail('must not run on a locked vault')).catch(error => error.code);
  await pause(10);
  service.lock(); release('late');
  assert.equal(await waiter, 'VAULT_LOCKED');
  assert.equal(await holder, 'VAULT_LOCKED');
});
