import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceB3DatabaseService } from '../lib/instance-b3-database-service.mjs';
import { InstanceB3AdminService } from '../lib/instance-b3-admin-service.mjs';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';
import { createShadowStore, remoteSubjectResolver, prefixedCredentials, isRemoteSubject } from '../lib/remote-subjects.mjs';

const PASSWORD = 'Db-Secret-Value9';
const SETTINGS = { host: 'db.example.org', port: 3307, database: 'b3', username: 'b3' };

// The remote B3 database service as installer-server.mjs builds it, next to a local one with the same id.
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-b3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = new Map([['alpha', { id: 'alpha', hostId: 'lab-1', port: 28960, createdAt: '2026-11-08T10:00:00.000Z' }]]);
  const instances = { get: id => ({ ...records.get(id) }), list: () => [...records.values()] };
  const shadow = createShadowStore({ instances, dataRoot: root });
  const local = { id: 'alpha', homePath: path.join(root, 'local-alpha'), createdAt: '2026-11-08T09:00:00.000Z' };
  await fs.mkdir(local.homePath);
  const resolveRemote = remoteSubjectResolver(shadow);
  const vault = new InstanceCredentialService({ dataRoot: root, resolveInstance: id => (isRemoteSubject(id) ? resolveRemote(id) : local) });
  await vault.initialize('Disposable remote b3 passphrase!'); await vault.unlock('Disposable remote b3 passphrase!');
  const remoteCredentials = prefixedCredentials(vault);
  const helperCalls = [];
  const helper = async request => { helperCalls.push({ op: request.op, connection: request.connection, password: request.password.toString() }); return { error: undefined, ...(request.op === 'probe' ? { version: '10.11', tables: {} } : {}) }; };
  // the connection test reads the audited eBc-B3 schema files from the local B3 source, as for a local server
  const b3Path = path.join(root, 'ebc-b3');
  await fs.mkdir(path.join(b3Path, 'b3', 'sql', 'mysql'), { recursive: true });
  const fixtures = new URL('./fixtures/', import.meta.url);
  await fs.copyFile(new URL('b3-mysql-b3.sql', fixtures), path.join(b3Path, 'b3', 'sql', 'mysql', 'b3.sql'));
  await fs.copyFile(new URL('b3-mysql-b3-update-ebc.sql', fixtures), path.join(b3Path, 'b3', 'sql', 'mysql', 'b3-update-ebc.sql'));
  const environment = { read: async () => ({ pythonPath: '/usr/bin/python2.7', b3Path }) };
  const remote = new InstanceB3DatabaseService({ store: shadow, credentials: remoteCredentials, environment, b3IsRunning: async () => false, helper });
  const localService = new InstanceB3DatabaseService({ store: { get: () => local, list: () => [local] }, credentials: vault, environment, b3IsRunning: async () => false, helper });
  // as the credential route does: the password is entered for the saved settings, then the check is reset
  const enterPassword = async () => { await remoteCredentials.set('alpha', 'b3db', { value: PASSWORD, expectedSha256: (await vault.status()).sha256 }); await remote.invalidate('alpha'); };
  return { root, shadow, remote, localService, helperCalls, local, enterPassword };
}

test('remote B3 database settings live in the shadow home and reach the helper with the remote host and the rmt_ password', async t => {
  const { root, remote, helperCalls, enterPassword } = await setup(t);
  await remote.save('alpha', SETTINGS);
  await enterPassword();
  const stored = JSON.parse(await fs.readFile(path.join(root, 'remote-data', 'alpha', 'b3', 'database.json'), 'utf8'));
  assert.deepEqual(stored.settings, SETTINGS);
  assert.ok(!JSON.stringify(stored).includes(PASSWORD));
  await remote.test('alpha');
  assert.equal(helperCalls.at(-1).connection.host, 'db.example.org');
  assert.equal(helperCalls.at(-1).connection.port, 3307);
  assert.equal(helperCalls.at(-1).password, PASSWORD);
});

test('a local and a remote server with the same id keep separate database settings', async t => {
  const { remote, localService } = await setup(t);
  await remote.save('alpha', SETTINGS);
  await localService.save('alpha', { host: '127.0.0.1', port: 3306, database: 'b3local', username: 'b3' });
  assert.equal((await remote.read('alpha')).settings.database, 'b3');
  assert.equal((await localService.read('alpha')).settings.database, 'b3local');
});

test('the remote admin service lists no B3 commands (the B3 config is on the server) and kicks through the remote RCON service', async t => {
  const { shadow, remote } = await setup(t);
  const kicks = [];
  const admin = new InstanceB3AdminService({ store: shadow, database: { read: async () => ({ ready: true }), query: async () => ({ rows: [] }) },
    environment: { read: async () => ({ pythonPath: '/usr/bin/python2.7', b3Path: null }) }, b3IsRunning: async () => false,
    rcon: { findOnline: async () => new Map([['GUID1', 4]]), kick: async (id, target, actor) => { kicks.push({ id, target, actor }); return { kicked: true }; } } });
  await assert.rejects(admin.commands('alpha'), { code: 'B3_ADMIN_COMMANDS_UNAVAILABLE' });
  assert.equal(remote instanceof InstanceB3DatabaseService, true);
});
