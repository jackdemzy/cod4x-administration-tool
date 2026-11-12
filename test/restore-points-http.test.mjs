import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backend, password } from './support/security-backend.mjs';

// Block 21 (4.18.27): restore point routes on the real backend.
async function setup(t) {
  const server = await backend(t);
  const admin = (await server.call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const secret = password();
  assert.equal((await server.call('/api/users', { body: { username: 'operator1', password: secret, role: 'operator' }, token: admin })).status, 201);
  const operator = (await server.call('/api/auth/login', { body: { username: 'operator1', password: secret } })).json.token;
  const basePath = path.join(server.root, 'game'), executablePath = path.join(server.root, 'core', 'cod4x18_dedrun');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'core', { mode: 0o755 });
  const created = await server.call('/api/instances', { body: { id: 'alpha', name: 'Alpha', platform: 'linux', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 }, token: admin });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { ...server, admin, operator, executablePath };
}

test('operator without server.code gets 403 on /core and RESTORE_POINT_CODE_PERMISSION on a plugin restore', { timeout: 60000 }, async t => {
  const { call, admin, operator, executablePath } = await setup(t);
  const core = await call('/api/instances/alpha/core', { body: { executablePath, version: '21.4' }, token: operator });
  assert.deepEqual([core.status, core.json.permission], [403, 'server.code']);
  const point = await call('/api/instances/alpha/restore-points', { body: {}, token: operator });
  assert.equal(point.status, 201, JSON.stringify(point.json));
  const refused = await call(`/api/instances/alpha/restore-points/${point.json.pointId}/restore`, { body: {}, token: operator });
  assert.deepEqual([refused.status, refused.json.code], [403, 'RESTORE_POINT_CODE_PERMISSION']);
  const runtime = await call('/api/runtime/restore-points/20261112T000000Z-0000abcd/restore', { body: {}, token: operator });
  assert.deepEqual([runtime.status, runtime.json.permission], [403, 'server.code']);
  const allowed = await call(`/api/instances/alpha/restore-points/${point.json.pointId}/restore`, { body: {}, token: admin });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  const list = await call('/api/instances/alpha/restore-points', { token: operator });
  assert.deepEqual(list.json.points.map(entry => entry.action).sort(), ['manual', 'restore.safety']);
});

test('unknown body keys are refused; the B3 database needs the exact confirmation', { timeout: 60000 }, async t => {
  const { call, admin } = await setup(t);
  assert.equal((await call('/api/instances/alpha/restore-points', { body: { evil: 1 }, token: admin })).json.code, 'RESTORE_POINT_REQUEST_INVALID');
  assert.equal((await call('/api/instances/alpha/restore-points', { body: { includeB3Database: 'yes' }, token: admin })).json.code, 'RESTORE_POINT_REQUEST_INVALID');
  assert.equal((await call('/api/runtime/restore-points', { body: { parts: ['files'] }, token: admin })).json.code, 'RESTORE_POINT_REQUEST_INVALID');
  const { pointId } = (await call('/api/instances/alpha/restore-points', { body: {}, token: admin })).json;
  assert.equal((await call(`/api/instances/alpha/restore-points/${pointId}/restore`, { body: { force: true }, token: admin })).json.code, 'RESTORE_POINT_REQUEST_INVALID');
  const confirmation = await call(`/api/instances/alpha/restore-points/${pointId}/restore`, { body: { includeB3Database: true, confirmation: 'ja' }, token: admin });
  assert.deepEqual([confirmation.status, confirmation.json.code], [428, 'RESTORE_POINT_CONFIRMATION_REQUIRED']);
  assert.equal((await call('/api/instances/alpha/restore-points/20261112T000000Z-0000abcd/integrity', { token: admin })).status, 404);
  assert.equal((await call('/api/instances/alpha/restore-points/..%2F..%2Fx/integrity', { token: admin })).json.valid, false);
});

test('restore response never contains file contents; the standard server keeps points of its record', { timeout: 60000 }, async t => {
  const { call, admin } = await setup(t);
  const config = (await call('/api/instances/alpha/config', { token: admin })).json;
  const { pointId } = (await call('/api/instances/alpha/restore-points', { body: {}, token: admin })).json;
  const restored = await call(`/api/instances/alpha/restore-points/${pointId}/restore`, { body: {}, token: admin });
  assert.equal(restored.status, 200);
  const text = JSON.stringify(restored.json);
  assert.ok(!/sv_hostname|set |cod4x18_dedrun/.test(text), text);
  assert.ok(typeof config === 'object');
  const runtimePoint = await call('/api/runtime/restore-points', { body: {}, token: admin });
  assert.equal(runtimePoint.status, 201, JSON.stringify(runtimePoint.json));
  const runtimeList = await call('/api/runtime/restore-points', { token: admin });
  assert.deepEqual([runtimeList.json.points.length, runtimeList.json.recovery], [1, null]);
  const back = await call(`/api/runtime/restore-points/${runtimePoint.json.pointId}/restore`, { body: {}, token: admin });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.deepEqual(back.json.restored, ['record']);
});
