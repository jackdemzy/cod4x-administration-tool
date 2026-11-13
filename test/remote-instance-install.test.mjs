import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteHostStore } from '../lib/remote-host-store.mjs';
import { RemoteInstanceStore } from '../lib/remote-instance-store.mjs';
import { RemoteInstanceManager } from '../lib/remote-instance-manager.mjs';
import { RestorePointStore } from '../lib/restore-points.mjs';
import { validateManagedConfigText } from '../lib/instance-config-validator.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CORE_BYTES = crypto.randomBytes(40_000);
const NEW_CORE_BYTES = crypto.randomBytes(41_000);

async function fixture(t, { state = null, backups = false } = {}) {
  const loopback = await createLoopbackServer();
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-install-local-'));
  t.after(async () => { await loopback.cleanup(); await fs.rm(local, { recursive: true, force: true }); });
  // the remote server: a base game and an (empty) place for instances
  await fs.mkdir(loopback.path('game', 'main'), { recursive: true }); await fs.mkdir(loopback.path('game', 'zone'), { recursive: true });
  await fs.writeFile(loopback.path('game', 'main', 'pak0.iwd'), 'iwd'); await fs.writeFile(loopback.path('game', 'zone', 'common.ff'), 'ff');
  await fs.mkdir(loopback.path('servers'));
  // the control PC: the core to upload
  await fs.mkdir(path.join(local, 'core')); const corePath = path.join(local, 'core', 'cod4x18_dedrun');
  await fs.writeFile(corePath, CORE_BYTES);

  const hostStore = new RemoteHostStore({ file: path.join(local, 'hosts.json'), inUse: id => instances.hasInstancesFor(id) });
  await hostStore.load();
  for (const id of ['lab-1', 'lab-2']) await hostStore.create({ id, label: id, host: `${id}.example.org`, port: 22, username: 'cod4x' });
  const instances = new RemoteInstanceStore({ file: path.join(local, 'instances.json'), hosts: hostStore });
  await instances.load();

  const connects = [], closes = [], audits = [];
  const control = { error: null, gate: null, session: loopback.session };
  const hosts = {
    store: hostStore,
    async connect(hostId) {
      connects.push(hostId);
      if (control.gate) await control.gate;
      if (control.error) throw Object.assign(new Error(control.error), { code: control.error });
      const session = Object.create(control.session);
      session.close = () => { closes.push(hostId); };
      return { session, uid: process.getuid(), gid: process.getgid() };
    },
  };
  const restorePoints = backups ? new RestorePointStore({ root: path.join(local, 'points') }) : null;
  const manager = new RemoteInstanceManager({ instances, hosts, state, coreImportRoot: local, uploadChunkBytes: 4096, audit: (level, event, details) => audits.push({ level, event, ...details }),
    ...(backups ? { backupRoot: path.join(local, 'backups'), restorePoints } : {}) });
  const request = overrides => ({
    id: 'public-01', name: 'Public 01', hostId: 'lab-1', port: 28960, remoteRoot: loopback.path('servers'), basePath: loopback.path('game'),
    corePath, coreVersion: '21.5', expectedCoreSha256: sha(CORE_BYTES), ...overrides,
  });
  return { loopback, local, corePath, instances, hosts, manager, request, connects, closes, audits, control, restorePoints };
}

const mode = async file => (await fs.stat(file)).mode & 0o777;

test('install creates the private layout, the core with mode 0755 and a valid server.cfg, and stores the instance', { skip }, async t => {
  const { manager, request, loopback, instances, audits, closes } = await fixture(t);
  const instance = await manager.install(request());
  const home = loopback.path('servers', 'public-01');
  assert.equal(instance.home, home);
  for (const name of ['', 'main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs', 'core']) {
    assert.equal(await mode(`${home}/${name}`), 0o700, name || 'home');
  }
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), CORE_BYTES);
  assert.equal(await mode(`${home}/core/cod4x18_dedrun`), 0o755);
  assert.deepEqual((await fs.readdir(`${home}/core`)), ['cod4x18_dedrun'], 'no temporary upload file is left');
  const config = await fs.readFile(`${home}/main/server.cfg`, 'utf8');
  assert.equal(config, '// Generated initial configuration; no credentials.\nset sv_hostname "Public 01"\nset net_port "28960"\nset g_log "logs/games_mp.log"\n');
  assert.equal(validateManagedConfigText(config, { port: 28960, network: { scope: 'LOOPBACK', publicAddress: null } }).assignments, 3);
  assert.equal(await mode(`${home}/main/server.cfg`), 0o600);
  assert.deepEqual(instances.get('public-01').core, { path: `${home}/core/cod4x18_dedrun`, version: '21.5', sha256: sha(CORE_BYTES) });
  assert.deepEqual(audits.filter(entry => entry.event === 'remote.instance.installed').map(entry => [entry.instanceId, entry.hostId]), [['public-01', 'lab-1']]);
  assert.deepEqual(closes, ['lab-1'], 'the connection is closed');
});

test('a core with the wrong file name, no file, a symlink or a wrong hash is refused before any connection', { skip }, async t => {
  const { manager, request, local, corePath, connects, loopback } = await fixture(t);
  const renamed = path.join(local, 'core', 'cod4x18_dedrun.exe'); await fs.copyFile(corePath, renamed);
  const link = path.join(local, 'core', 'link', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(link)); await fs.symlink(corePath, link);
  const empty = path.join(local, 'core', 'e', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(empty)); await fs.writeFile(empty, '');
  for (const overrides of [{ corePath: renamed }, { corePath: path.join(local, 'nope', 'cod4x18_dedrun') }, { corePath: link }, { corePath: empty }, { corePath: path.join(local, 'core') },
    { corePath: 'relative/cod4x18_dedrun' }, { expectedCoreSha256: sha('other') }]) {
    await rejects(manager.install(request(overrides)), 'REMOTE_CORE_INVALID');
  }
  // a malformed version or hash is an input error, found by the instance definition
  for (const overrides of [{ coreVersion: '20.1' }, { expectedCoreSha256: 'ABC' }, { expectedCoreSha256: undefined }]) await rejects(manager.install(request(overrides)), 'REMOTE_INSTANCE_INVALID');
  assert.deepEqual(connects, [], 'nothing reached the network');
  await assert.rejects(fs.stat(loopback.path('servers', 'public-01')), { code: 'ENOENT' });
});

test('input that the store refuses stops before any connection: bad id, taken port, path overlap, unknown host', { skip }, async t => {
  const { manager, request, connects } = await fixture(t);
  await rejects(manager.install(request({ id: 'Bad Id' })), 'REMOTE_INSTANCE_INVALID');
  await rejects(manager.install(request({ hostId: 'missing' })), 'REMOTE_HOST_NOT_FOUND');
  await rejects(manager.install(request({ basePath: request().remoteRoot })), 'REMOTE_PATH_OVERLAP');
  await manager.install(request());
  const before = connects.length;
  await rejects(manager.install(request({ id: 'public-02' })), 'REMOTE_PORT_CONFLICT');
  await rejects(manager.install(request()), 'REMOTE_INSTANCE_EXISTS');
  assert.equal(connects.length, before, 'no connection for the refused installs');
});

test('a base game without main or without zone files is refused with its reasons, and nothing is created', { skip }, async t => {
  const { manager, request, loopback } = await fixture(t);
  await fs.rm(loopback.path('game', 'main'), { recursive: true });
  await assert.rejects(manager.install(request()), error => error.code === 'REMOTE_BASEGAME_INVALID' && error.reasons.map(reason => reason.code).join() === 'REMOTE_BASEGAME_MAIN_MISSING');
  await fs.mkdir(loopback.path('game', 'main')); await fs.writeFile(loopback.path('game', 'main', 'pak0.iwd'), 'x');
  await fs.rm(loopback.path('game', 'zone', 'common.ff'));
  await assert.rejects(manager.install(request()), error => error.reasons.map(reason => reason.code).join() === 'REMOTE_BASEGAME_ZONE_ASSETS_MISSING');
  await assert.rejects(fs.stat(loopback.path('servers', 'public-01')), { code: 'ENOENT' });
});

test('an existing home is never adopted or overwritten', { skip }, async t => {
  const { manager, request, loopback, instances } = await fixture(t);
  await fs.mkdir(loopback.path('servers', 'public-01')); await fs.writeFile(loopback.path('servers', 'public-01', 'keep.txt'), 'mine');
  await rejects(manager.install(request()), 'REMOTE_HOME_EXISTS');
  assert.equal(await fs.readFile(loopback.path('servers', 'public-01', 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual(await fs.readdir(loopback.path('servers', 'public-01')), ['keep.txt']);
  assert.equal(instances.list().length, 0);
});

test('a missing or wrong instance root, and a root that is not writable, are refused', { skip }, async t => {
  const { manager, request, loopback } = await fixture(t);
  await rejects(manager.install(request({ remoteRoot: loopback.path('nope') })), 'REMOTE_ROOT_INVALID');
  await fs.writeFile(loopback.path('afile'), 'x');
  await rejects(manager.install(request({ remoteRoot: loopback.path('afile') })), 'REMOTE_ROOT_INVALID');
  await fs.symlink(loopback.path('servers'), loopback.path('linked-root'));
  await rejects(manager.install(request({ remoteRoot: loopback.path('linked-root') })), 'REMOTE_ROOT_INVALID');
  await fs.chmod(loopback.path('servers'), 0o555);
  await rejects(manager.install(request()), 'REMOTE_ROOT_INVALID');
  await fs.chmod(loopback.path('servers'), 0o755);
});

test('not enough free space is refused before anything is created', { skip }, async t => {
  const { manager, request, loopback, control } = await fixture(t);
  const real = control.session;
  control.session = Object.create(real);
  control.session.exec = (command, options) => (command.startsWith('df ') ? Promise.resolve({ code: 0, stdout: Buffer.from('/dev/x 100 99 1 99% /srv\n'), stderr: Buffer.alloc(0), truncated: false }) : real.exec(command, options));
  await rejects(manager.install(request()), 'REMOTE_DISK_FULL');
  await assert.rejects(fs.stat(loopback.path('servers', 'public-01')), { code: 'ENOENT' });
});

test('a truncated upload leaves no partial core and no record; the half-built home is moved to .recovery', { skip }, async t => {
  const { manager, request, loopback, instances, audits } = await fixture(t);
  const sftp = await loopback.session.sftp();
  const write = sftp.write.bind(sftp);
  let sent = 0;
  sftp.write = (handle, buffer, offset, length, position, cb) => {
    sent += length;
    return sent > 10_000 ? cb(Object.assign(new Error('Failure'), { code: 4 })) : write(handle, buffer, offset, length, position, cb);
  };
  await rejects(manager.install(request()), 'REMOTE_UPLOAD_FAILED');
  assert.equal(instances.list().length, 0);
  await assert.rejects(fs.stat(loopback.path('servers', 'public-01')), { code: 'ENOENT' }, 'the home is gone from its place');
  const moved = await fs.readdir(loopback.path('servers', '.recovery'));
  assert.equal(moved.length, 1);
  assert.match(moved[0], /^public-01-[a-z0-9-]{8,}$/);
  assert.deepEqual(await fs.readdir(loopback.path('servers', '.recovery', moved[0], 'core')), [], 'no partial core was left');
  assert.ok(audits.some(entry => entry.event === 'remote.instance.install_failed' && entry.code === 'REMOTE_UPLOAD_FAILED'));
  // the same install works afterwards
  sftp.write = write;
  assert.equal((await manager.install(request())).id, 'public-01');
});

test('a core that arrives changed fails the hash check and is not installed', { skip }, async t => {
  const { manager, request, loopback, instances } = await fixture(t);
  const sftp = await loopback.session.sftp();
  const write = sftp.write.bind(sftp);
  sftp.write = (handle, buffer, offset, length, position, cb) => {
    if (position === 0) buffer[0] ^= 0xff; // a bit flips in transit
    return write(handle, buffer, offset, length, position, cb);
  };
  await rejects(manager.install(request()), 'REMOTE_UPLOAD_FAILED');
  assert.equal(instances.list().length, 0);
  await assert.rejects(fs.stat(loopback.path('servers', 'public-01')), { code: 'ENOENT' });
});

test('a platform other than Linux x86_64, a root login and a changed host key stop the install and create nothing', { skip }, async t => {
  const { manager, request, loopback, control, instances } = await fixture(t);
  for (const code of ['REMOTE_PLATFORM_UNSUPPORTED', 'REMOTE_ROOT_BLOCKED', 'REMOTE_HOST_KEY_CHANGED', 'VAULT_LOCKED']) {
    control.error = code;
    await rejects(manager.install(request()), code);
  }
  assert.equal(instances.list().length, 0);
  assert.deepEqual(await fs.readdir(loopback.path('servers')), []);
});

test('two installs of the same instance at the same moment: one runs, the other is busy', { skip }, async t => {
  const { manager, request, control, instances } = await fixture(t);
  let release;
  control.gate = new Promise(resolve => { release = resolve; });
  const first = manager.install(request());
  await new Promise(resolve => setTimeout(resolve, 20));
  await rejects(manager.install(request()), 'REMOTE_OPERATION_BUSY');
  release();
  await first;
  assert.equal(instances.list().length, 1);
  control.gate = null;
});

test('updateCore replaces the core, keeps the old one as .previous and records the new hash', { skip }, async t => {
  const { manager, request, loopback, instances, local } = await fixture(t, { state: { read: async () => null } });
  await manager.install(request());
  const next = path.join(local, 'new', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(next)); await fs.writeFile(next, NEW_CORE_BYTES);
  const updated = await manager.updateCore('public-01', { corePath: next, coreVersion: '21.4', expectedCoreSha256: sha(NEW_CORE_BYTES) });
  const core = `${updated.home}/core/cod4x18_dedrun`;
  assert.deepEqual(await fs.readFile(core), NEW_CORE_BYTES);
  assert.equal(await mode(core), 0o755);
  assert.deepEqual(await fs.readFile(`${core}.previous`), CORE_BYTES);
  assert.deepEqual((await fs.readdir(`${updated.home}/core`)).sort(), ['cod4x18_dedrun', 'cod4x18_dedrun.previous']);
  assert.deepEqual([instances.get('public-01').core.version, instances.get('public-01').core.sha256], ['21.4', sha(NEW_CORE_BYTES)]);
  // a second update replaces the older .previous
  const third = path.join(local, 'third', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(third)); await fs.writeFile(third, 'third core');
  await manager.updateCore('public-01', { corePath: third, coreVersion: '21.5', expectedCoreSha256: sha('third core') });
  assert.deepEqual(await fs.readFile(`${core}.previous`), NEW_CORE_BYTES);
});

test('updateCore needs a state source and refuses while the instance may be running', { skip }, async t => {
  const alive = { status: 'RUNNING', pid: process.pid, createdAt: 'x' };
  const running = await fixture(t, { state: { read: async () => alive } });
  await running.manager.install(running.request());
  const spec = { corePath: running.corePath, coreVersion: '21.5', expectedCoreSha256: sha(CORE_BYTES) };
  // process.pid is a live process, so the instance is treated as running (unknown identity fails closed)
  await rejects(running.manager.updateCore('public-01', spec), 'REMOTE_INSTANCE_RUNNING');
  assert.deepEqual(await fs.readFile(running.instances.get('public-01').core.path), CORE_BYTES);
  const blocked = await fixture(t, { state: { read: async () => ({ status: 'STARTING', pid: null, recoveryBlocked: true }) } });
  await blocked.manager.install(blocked.request());
  await rejects(blocked.manager.updateCore('public-01', { ...spec, corePath: blocked.corePath }), 'REMOTE_INSTANCE_RUNNING');
  const none = await fixture(t);
  await none.manager.install(none.request());
  await rejects(none.manager.updateCore('public-01', { ...spec, corePath: none.corePath }), 'REMOTE_STATE_UNAVAILABLE');
  await rejects(none.manager.updateCore('missing', spec), 'REMOTE_INSTANCE_NOT_FOUND');
});

test('updateCore with a bad local hash or a core changed in transit leaves the old core and no temporary file', { skip }, async t => {
  const { manager, request, loopback, instances, local } = await fixture(t, { state: { read: async () => null } });
  await manager.install(request());
  const home = instances.get('public-01').home;
  const next = path.join(local, 'new', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(next)); await fs.writeFile(next, NEW_CORE_BYTES);
  await rejects(manager.updateCore('public-01', { corePath: next, coreVersion: '21.5', expectedCoreSha256: sha('wrong') }), 'REMOTE_CORE_INVALID');
  const sftp = await loopback.session.sftp();
  const write = sftp.write.bind(sftp);
  sftp.write = (handle, buffer, offset, length, position, cb) => { if (position === 0) buffer[0] ^= 0xff; return write(handle, buffer, offset, length, position, cb); };
  await rejects(manager.updateCore('public-01', { corePath: next, coreVersion: '21.5', expectedCoreSha256: sha(NEW_CORE_BYTES) }), 'REMOTE_UPLOAD_FAILED');
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), CORE_BYTES);
  assert.deepEqual(await fs.readdir(`${home}/core`), ['cod4x18_dedrun']);
  assert.equal(instances.get('public-01').core.sha256, sha(CORE_BYTES));
});

test('updateCore restores the previous core when the swap fails half way', { skip }, async t => {
  const { manager, request, loopback, instances, local } = await fixture(t, { state: { read: async () => null } });
  await manager.install(request());
  const home = instances.get('public-01').home;
  const next = path.join(local, 'new', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(next)); await fs.writeFile(next, NEW_CORE_BYTES);
  const sftp = await loopback.session.sftp();
  const rename = sftp.rename.bind(sftp);
  let renames = 0;
  sftp.rename = (from, to, cb) => (++renames === 2 ? cb(Object.assign(new Error('Failure'), { code: 4 })) : rename(from, to, cb));
  await rejects(manager.updateCore('public-01', { corePath: next, coreVersion: '21.5', expectedCoreSha256: sha(NEW_CORE_BYTES) }), 'REMOTE_UPDATE_FAILED');
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), CORE_BYTES, 'the old core is back in place');
  assert.equal(instances.get('public-01').core.sha256, sha(CORE_BYTES), 'the record is unchanged');
  assert.deepEqual(await fs.readdir(`${home}/core`), ['cod4x18_dedrun'], 'neither the temporary upload nor a stray .previous is left');
});

// ---- 4.18.25: the core is read from the import directory of CONTROL only ------------------------------------
test('a core outside the import directory is refused before any connection: other folder, sibling prefix, "..", a linked folder', { skip }, async t => {
  const { manager, request, local, corePath, connects } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-install-outside-'));
  const sibling = `${local}-2`;
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); await fs.rm(sibling, { recursive: true, force: true }); });
  const elsewhere = path.join(outside, 'cod4x18_dedrun'); await fs.copyFile(corePath, elsewhere);
  await fs.mkdir(sibling); await fs.copyFile(corePath, path.join(sibling, 'cod4x18_dedrun'));
  await fs.symlink(outside, path.join(local, 'linked')); // a folder inside the import directory that leads out of it
  for (const file of [elsewhere, path.join(sibling, 'cod4x18_dedrun'), path.join(local, 'core', '..', '..', path.basename(outside), 'cod4x18_dedrun'), path.join(local, 'linked', 'cod4x18_dedrun')]) {
    await rejects(manager.install(request({ corePath: file })), 'REMOTE_CORE_OUTSIDE_IMPORT');
  }
  // a path that is written with ".." but stays inside is the same file
  assert.equal((await manager.install(request({ corePath: path.join(local, 'core', 'x', '..', 'cod4x18_dedrun') }))).id, 'public-01');
  assert.deepEqual(connects, ['lab-1']);
  // a folder whose name merely begins with two dots is inside
  await fs.mkdir(path.join(local, '..21.5')); await fs.copyFile(corePath, path.join(local, '..21.5', 'cod4x18_dedrun'));
  assert.equal((await manager.install(request({ id: 'public-02', port: 28999, corePath: path.join(local, '..21.5', 'cod4x18_dedrun') }))).id, 'public-02');
  await rejects(manager.updateCore('public-01', { corePath: elsewhere, coreVersion: '21.5', expectedCoreSha256: sha(CORE_BYTES) }), 'REMOTE_CORE_OUTSIDE_IMPORT');
});

test('without an import directory no core file is read at all', { skip }, async t => {
  const { instances, hosts, request, connects } = await fixture(t);
  const manager = new RemoteInstanceManager({ instances, hosts });
  await rejects(manager.install(request()), 'REMOTE_CORE_OUTSIDE_IMPORT');
  assert.deepEqual(connects, []);
  assert.equal(manager.coreImportRoot, null);
});

// ---- Block 21: core rollback and recovery -------------------------------------------------------------------
async function updated(t) {
  const context = await fixture(t, { state: { read: async () => null }, backups: true });
  await context.manager.install(context.request());
  const next = path.join(context.local, 'new', 'cod4x18_dedrun'); await fs.mkdir(path.dirname(next)); await fs.writeFile(next, NEW_CORE_BYTES);
  return { ...context, next, home: context.instances.get('public-01').home };
}

test('rollbackCore restores the previous core and version', { skip }, async t => {
  const { manager, instances, next, home } = await updated(t);
  const result = await manager.updateCore('public-01', { corePath: next, coreVersion: '21.4', expectedCoreSha256: sha(NEW_CORE_BYTES) });
  assert.match(result.restorePointId, /Z-[0-9a-f]{8}$/);
  assert.equal((await manager.listBackups('public-01'))[0].action, 'core.update');
  const rolled = await manager.rollbackCore('public-01');
  assert.deepEqual([rolled.core.version, rolled.core.sha256], ['21.5', sha(CORE_BYTES)]);
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), CORE_BYTES);
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun.previous`), NEW_CORE_BYTES);
  assert.equal(instances.get('public-01').core.sha256, sha(CORE_BYTES));
  assert.deepEqual((await fs.readdir(`${home}/core`)).sort(), ['cod4x18_dedrun', 'cod4x18_dedrun.previous']);
});

test('rollbackCore refuses a .previous whose hash differs, and a missing .previous', { skip }, async t => {
  const { manager, instances, next, home } = await updated(t);
  await rejects(manager.rollbackCore('public-01'), 'REMOTE_BACKUP_INVALID');
  await manager.updateCore('public-01', { corePath: next, coreVersion: '21.4', expectedCoreSha256: sha(NEW_CORE_BYTES) });
  await fs.writeFile(`${home}/core/cod4x18_dedrun.previous`, 'tampered core');
  await rejects(manager.rollbackCore('public-01'), 'REMOTE_BACKUP_INVALID');
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), NEW_CORE_BYTES);
  assert.equal(instances.get('public-01').core.version, '21.4');
});

test('failed in-place rollback marks RECOVERY_REQUIRED, start is refused, rollbackCore recovers', { skip }, async t => {
  const { manager, instances, next, home, loopback, restorePoints } = await updated(t);
  const sftp = await loopback.session.sftp();
  const rename = sftp.rename.bind(sftp);
  let renames = 0;
  sftp.rename = (from, to, cb) => (++renames >= 2 && renames <= 3 ? cb(Object.assign(new Error('Failure'), { code: 4 })) : rename(from, to, cb));
  const error = await manager.updateCore('public-01', { corePath: next, coreVersion: '21.4', expectedCoreSha256: sha(NEW_CORE_BYTES) }).catch(caught => caught);
  assert.equal(error.code, 'REMOTE_UPDATE_FAILED');
  assert.equal(error.recoveryRequired, true);
  sftp.rename = rename;
  assert.ok(await restorePoints.recovery('remote:public-01'));
  await rejects(manager.start('public-01'), 'RECOVERY_REQUIRED');
  await rejects(manager.restart('public-01'), 'RECOVERY_REQUIRED');
  await assert.rejects(fs.access(`${home}/core/cod4x18_dedrun`));
  const rolled = await manager.rollbackCore('public-01');
  assert.equal(rolled.core.sha256, sha(CORE_BYTES));
  assert.deepEqual(await fs.readFile(`${home}/core/cod4x18_dedrun`), CORE_BYTES);
  assert.equal(await restorePoints.recovery('remote:public-01'), null);
  assert.equal(instances.get('public-01').core.version, '21.5');
});

test('old backup manifests without action still list and restore', { skip }, async t => {
  const { manager, local } = await updated(t);
  const { backupId } = await manager.createBackup('public-01');
  const file = path.join(local, 'backups', 'public-01', backupId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  delete manifest.action; delete manifest.core.previousSha256;
  await fs.writeFile(file, JSON.stringify(manifest));
  const [entry] = await manager.listBackups('public-01');
  assert.deepEqual([entry.backupId, entry.invalid, entry.action], [backupId, false, null]);
  const restored = await manager.restoreBackup('public-01', backupId);
  assert.equal(restored.backupId, backupId);
  manifest.action = 'evil';
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal((await manager.listBackups('public-01')).find(item => item.backupId === backupId).invalid, true);
});

// Security audit 4.18.26 (A4-4): the instance root belongs to the SSH user and nobody else may
// write in it (a sticky, world-writable folder such as /tmp is accepted).
test('an instance root that others may write in is refused; a sticky one is accepted', { skip }, async t => {
  const { manager, request, loopback } = await fixture(t);
  await fs.chmod(loopback.path('servers'), 0o775);
  await rejects(manager.install(request()), 'REMOTE_ROOT_UNSAFE');
  await fs.chmod(loopback.path('servers'), 0o757);
  await rejects(manager.install(request()), 'REMOTE_ROOT_UNSAFE');
  await fs.chmod(loopback.path('servers'), 0o1777);
  const installed = await manager.install(request());
  assert.ok(installed);
  await fs.chmod(loopback.path('servers'), 0o755);
});
