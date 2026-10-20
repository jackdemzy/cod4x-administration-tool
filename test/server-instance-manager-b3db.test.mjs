import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerInstanceManager } from '../lib/server-instance-manager.mjs';

function manager({ fail = false, busy = false } = {}) {
  const changed = [];
  const instance = { id: 'server-a', platform: 'linux', homePath: '/srv/a', basePath: '/srv/base', port: 28960, serverCore: { executablePath: '/srv/core', version: '21.2' } };
  const store = { get: id => { if (id !== 'server-a') throw Object.assign(new Error('missing'), { code: 'INSTANCE_NOT_FOUND' }); return instance; }, validatePaths: async () => {} };
  const runtimeFactory = () => ({ loadRuntimeState: async () => {}, reconcileRuntimeState: async () => {}, busy });
  const credentialService = {
    set: async () => { if (fail) throw Object.assign(new Error('VAULT_CONFLICT'), { code: 'VAULT_CONFLICT' }); return { verified: true }; },
    remove: async () => ({ verified: true }),
  };
  return { changed, value: new ServerInstanceManager({ store, runtimeFactory, credentialService, onCredentialChanged: (id, kind) => changed.push([id, kind]) }) };
}

test('changeCredential calls onCredentialChanged after success, not on failure', async () => {
  const ok = manager();
  await ok.value.changeCredential('server-a', 'b3db', { value: 'x', expectedSha256: 'y' });
  await ok.value.changeCredential('server-a', 'b3db', { expectedSha256: 'y' }, true);
  await ok.value.changeCredential('server-a', 'rcon', { value: 'x', expectedSha256: 'y' });
  assert.deepEqual(ok.changed, [['server-a', 'b3db'], ['server-a', 'b3db'], ['server-a', 'rcon']]);
  const failing = manager({ fail: true });
  await assert.rejects(failing.value.changeCredential('server-a', 'b3db', { value: 'x', expectedSha256: 'y' }), { code: 'VAULT_CONFLICT' });
  assert.deepEqual(failing.changed, []);
});

test('b3db can change while the game server runs; server credentials still need a stopped server', async () => {
  const running = manager({ busy: true });
  await running.value.changeCredential('server-a', 'b3db', { value: 'x', expectedSha256: 'y' });
  await assert.rejects(running.value.changeCredential('server-a', 'rcon', { value: 'x', expectedSha256: 'y' }), { code: 'INSTANCE_RUNTIME_BUSY' });
  assert.deepEqual(running.changed, [['server-a', 'b3db']]);
});
