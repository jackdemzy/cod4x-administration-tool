import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceRconService } from '../lib/instance-rcon-service.mjs';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';
import { createRemoteRconClientFactory } from '../lib/remote-rcon-client.mjs';
import { createShadowStore, remoteSubjectResolver, prefixedCredentials } from '../lib/remote-subjects.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';
import { startFakeCod4xServer } from './support/fake-cod4x-udp.mjs';

const skip = (await loopbackAvailable()) ? false : 'needs Linux and a non-root user';
const PASSWORD = 'Remote-Service-Pw1';

// The production pieces wired as installer-server.mjs wires them, with the SSH session replaced by the loopback.
async function setup(t, { runtime = { status: 'RUNNING', pid: 4242, runId: 'run-1' } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-rcon-service-'));
  const loopback = await createLoopbackServer();
  const fake = await startFakeCod4xServer({ password: PASSWORD, hostname: 'Remote Service' });
  t.after(async () => { fake.close(); await loopback.cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  const records = new Map([['srv-1', { id: 'srv-1', hostId: 'lab-1', port: fake.port, createdAt: '2026-11-08T10:00:00.000Z' }]]);
  const instances = { get: id => { const value = records.get(id); if (!value) throw Object.assign(new Error('x'), { code: 'REMOTE_INSTANCE_NOT_FOUND' }); return { ...value }; }, list: () => [...records.values()] };
  const shadow = createShadowStore({ instances, dataRoot: root });
  const vault = new InstanceCredentialService({ dataRoot: root, resolveInstance: remoteSubjectResolver(shadow) });
  await vault.initialize('Disposable remote service passphrase!'); await vault.unlock('Disposable remote service passphrase!');
  const credentials = prefixedCredentials(vault);
  await credentials.set('srv-1', 'rcon', { value: PASSWORD, expectedSha256: (await vault.status()).sha256 });
  const pool = { async use(hostId, action) { return action({ session: loopback.session, uid: 1000, gid: 1000 }); } };
  const audits = [];
  const service = new InstanceRconService({
    resolveInstance: id => shadow.get(id),
    runtimeFor: () => ({ state: runtime, async reconcileRuntimeState() {} }),
    credentialService: credentials,
    clientFactory: createRemoteRconClientFactory({ pool, instances }),
    audit: (level, event, details) => audits.push({ level, event, ...details }),
  });
  service.recordProvisioning('srv-1', runtime.runId, 'PROVISIONED');
  return { service, audits, loopback, fake, runtime };
}

test('connect and execute run through ssh with the password from the rmt_ vault entry', { skip }, async t => {
  const { service, fake, loopback } = await setup(t);
  assert.equal((await service.connect('srv-1', 'ops')).status, 'CONNECTED');
  const result = await service.execute('srv-1', 'serverinfo', 'ops');
  assert.match(JSON.stringify(result), /Remote Service/);
  assert.deepEqual(fake.state.commands.slice(-1), ['serverinfo']);
  assert.ok(loopback.session.calls.every(command => !command.includes(PASSWORD)), 'no password in any remote command');
});

test('a blocked command never reaches the server', { skip }, async t => {
  const { service, fake } = await setup(t);
  await assert.rejects(service.execute('srv-1', 'quit', 'ops'), { code: 'RCON_COMMAND_BLOCKED' });
  assert.ok(!fake.state.commands.includes('quit'));
});

test('online players come from status over ssh; the audit holds no password', { skip }, async t => {
  const { service, audits } = await setup(t);
  const online = await service.online('srv-1', { full: true });
  assert.ok(online.players.length >= 20);
  await service.execute('srv-1', 'status', 'ops');
  assert.ok(audits.length > 0);
  assert.ok(!JSON.stringify(audits).includes(PASSWORD));
});

test('a stopped remote server answers RCON_SERVER_NOT_RUNNING without any ssh command', { skip }, async t => {
  const { service, loopback } = await setup(t, { runtime: { status: 'STOPPED', pid: null, runId: 'run-1' } });
  await assert.rejects(service.execute('srv-1', 'status', 'ops'), { code: 'RCON_SERVER_NOT_RUNNING' });
  assert.equal(loopback.session.calls.length, 0);
});
