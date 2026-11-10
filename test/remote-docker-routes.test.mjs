import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from '../lib/remote-linux-routes.mjs';

// Block 19: the Docker routes on a real express app. The services are recorders; what they do is tested elsewhere.
const ROLES = { viewer: ['diagnostics.read'], operator: ['diagnostics.read', 'server.manage'], admin: ['diagnostics.read', 'server.manage', 'config.manage', 'install.execute', 'update.execute'] };
const fail = code => { throw Object.assign(new Error(`secret text of ${code}`), { code }); };
const ID = 'c'.repeat(64);

async function start(t) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { username: `user-${req.get('x-role')}`, role: req.get('x-role') }; next(); });
  const requirePermission = permission => (req, res, next) => (ROLES[req.auth.role]?.includes(permission) ? next() : res.status(403).json({ ok: false, code: 'FORBIDDEN' }));
  const calls = [];
  const known = id => (id === 'lab-1' ? { id } : fail('REMOTE_HOST_NOT_FOUND'));
  const hostService = {
    dockerStatus: async id => { known(id); calls.push(['dockerStatus', id]); return { mode: 'ROOTFUL', version: '29.1.0', confirmed: false, image: 'MISSING', note: 'ROOTFUL_ROOT_EQUIVALENT' }; },
    confirmDocker: async (id, input) => { known(id); calls.push(['confirmDocker', id, input]); if (input.confirm !== 'DOCKER_ROOT_EQUIVALENT') fail('REMOTE_DOCKER_CONFIRMATION_REQUIRED'); return { id, docker: { mode: 'ROOTFUL', confirmedAt: '2026-11-09T00:00:00.000Z' } }; },
    buildDockerImage: async id => { known(id); calls.push(['buildDockerImage', id]); if (calls.filter(entry => entry[0] === 'buildDockerImage').length > 1) fail('REMOTE_DOCKER_BUILD_FAILED'); return { tag: 'cod4x-control-runtime:0123456789abcdef', id: `sha256:${'a'.repeat(64)}` }; },
  };
  const runtime = { status: 'RUNNING', runId: 'r1', containerId: ID };
  const manager = {
    coreImportRoot: '/data/remote-core-import',
    instances: { get: id => (id === 'srv-1' ? { id } : fail('REMOTE_INSTANCE_NOT_FOUND')) },
    updateCore: async (id, input) => { calls.push(['updateCore', id, input.corePath]); return { id }; },
    install: async input => { calls.push(['install', input]); return { id: input.id, deployment: input.deployment ?? 'native' }; },
    setDeployment: async (id, input) => { calls.push(['setDeployment', id, input]); if (id !== 'srv-1') fail('REMOTE_INSTANCE_NOT_FOUND'); if (input.deployment === 'native') fail('REMOTE_INSTANCE_RUNNING'); return { instance: { id, deployment: input.deployment }, previous: 'native' }; },
    status: async id => ({ instance: { id, deployment: 'docker' }, runtime }),
    statusAll: async () => [{ instance: { id: 'srv-1', deployment: 'docker' }, runtime }, { instance: { id: 'srv-2', deployment: 'native' }, runtime: { status: 'RUNNING', pid: 42 } }, { instance: { id: 'srv-3' }, error: 'REMOTE_CONNECT_FAILED' }],
    start: async id => { if (id === 'srv-9') fail('REMOTE_DOCKER_IMAGE_MISSING'); if (id === 'srv-8') fail('REMOTE_DOCKER_CONTAINER_EXISTS'); if (id === 'srv-7') fail('REMOTE_DOCKER_NOT_CONFIRMED'); return { instance: { id }, runtime }; },
  };
  registerRemoteLinuxRoutes({ app, requirePermission, audit() {}, hostService, hostStore: {}, manager, credentials: {} });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (role, route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'x-role': role, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  return { call, calls };
}

test('docker host routes: status for readers, confirmation and image build for managers, exact bodies', async t => {
  const { call, calls } = await start(t);
  const status = await call('viewer', '/api/remote-hosts/lab-1/docker');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.docker, { mode: 'ROOTFUL', version: '29.1.0', confirmed: false, image: 'MISSING', note: 'ROOTFUL_ROOT_EQUIVALENT' });
  assert.equal((await call('viewer', '/api/remote-hosts/nope/docker')).status, 404);

  assert.equal((await call('viewer', '/api/remote-hosts/lab-1/docker/confirm', { confirm: 'DOCKER_ROOT_EQUIVALENT' })).status, 403);
  assert.equal((await call('viewer', '/api/remote-hosts/lab-1/docker/image', {})).status, 403);
  assert.equal((await call('operator', '/api/remote-hosts/lab-1/docker/confirm', {})).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call('operator', '/api/remote-hosts/lab-1/docker/confirm', { confirm: 'DOCKER_ROOT_EQUIVALENT', mode: 'ROOTLESS' })).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.ok(!calls.some(entry => entry[0] === 'confirmDocker'), 'a wrong body never reaches the service');
  const refused = await call('operator', '/api/remote-hosts/lab-1/docker/confirm', { confirm: 'yes' });
  assert.deepEqual([refused.status, refused.json.code], [409, 'REMOTE_DOCKER_CONFIRMATION_REQUIRED']);
  assert.ok(!JSON.stringify(refused.json).includes('secret text'), 'only the code leaves the server');
  // a rootless host needs no word: null is passed on and the service decides by what the host shows
  assert.equal((await call('operator', '/api/remote-hosts/lab-1/docker/confirm', { confirm: null })).json.code, 'REMOTE_DOCKER_CONFIRMATION_REQUIRED');
  const confirmed = await call('operator', '/api/remote-hosts/lab-1/docker/confirm', { confirm: 'DOCKER_ROOT_EQUIVALENT' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.host.docker.mode, 'ROOTFUL');

  const built = await call('operator', '/api/remote-hosts/lab-1/docker/image', {});
  assert.deepEqual([built.status, built.json.image.tag], [200, 'cod4x-control-runtime:0123456789abcdef']);
  assert.equal((await call('operator', '/api/remote-hosts/lab-1/docker/image', { tag: 'evil' })).json.code, 'REMOTE_ARGUMENT_INVALID');
  const failed = await call('operator', '/api/remote-hosts/lab-1/docker/image', {});
  assert.deepEqual([failed.status, failed.json.code], [400, 'REMOTE_DOCKER_BUILD_FAILED']);
});

test('deployment routes: the install passes an optional deployment on, the switch needs server.manage and an exact body', async t => {
  const { call, calls } = await start(t);
  const body = { id: 'srv-1', name: 'One', hostId: 'lab-1', port: 28960, remoteRoot: '/srv/cod4x', basePath: '/srv/game', corePath: '/x/cod4x18_dedrun', coreVersion: '21.5', expectedCoreSha256: 'a'.repeat(64) };
  assert.equal((await call('admin', '/api/remote-instances', body)).json.instance.deployment, 'native');
  assert.equal('deployment' in calls.at(-1)[1], false, 'nothing is invented when the caller says nothing');
  assert.equal((await call('admin', '/api/remote-instances', { ...body, deployment: 'docker' })).json.instance.deployment, 'docker');
  assert.equal(calls.at(-1)[1].deployment, 'docker');
  assert.equal((await call('admin', '/api/remote-instances', { ...body, image: 'x' })).json.code, 'REMOTE_ARGUMENT_INVALID');
  // 4.18.25: a core named relative to the import directory is completed by the server; an absolute path is passed on and checked by the manager
  assert.equal(calls.at(-1)[1].corePath, '/x/cod4x18_dedrun');
  await call('admin', '/api/remote-instances', { ...body, corePath: '21.5/cod4x18_dedrun' });
  assert.equal(calls.at(-1)[1].corePath, path.join('/data/remote-core-import', '21.5', 'cod4x18_dedrun'));
  await call('admin', '/api/remote-instances/srv-1/update', { corePath: 'cod4x18_dedrun', coreVersion: '21.5', expectedCoreSha256: 'a'.repeat(64) });
  assert.deepEqual(calls.at(-1), ['updateCore', 'srv-1', path.join('/data/remote-core-import', 'cod4x18_dedrun')]);

  assert.equal((await call('viewer', '/api/remote-instances/srv-1/deployment', { deployment: 'docker' })).status, 403);
  assert.equal((await call('operator', '/api/remote-instances/srv-1/deployment', {})).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call('operator', '/api/remote-instances/srv-1/deployment', { deployment: 'docker', force: true })).json.code, 'REMOTE_ARGUMENT_INVALID');
  const switched = await call('operator', '/api/remote-instances/srv-1/deployment', { deployment: 'docker' });
  assert.deepEqual([switched.status, switched.json.instance.deployment, switched.json.previous], [200, 'docker', 'native']);
  const running = await call('operator', '/api/remote-instances/srv-1/deployment', { deployment: 'native' });
  assert.deepEqual([running.status, running.json.code], [409, 'REMOTE_INSTANCE_RUNNING']);
  assert.equal((await call('operator', '/api/remote-instances/nope/deployment', { deployment: 'docker' })).status, 404);
});

test('answers carry the container ID shortened to 12 characters, and Docker refusals are conflicts with their code', async t => {
  const { call } = await start(t);
  const one = await call('viewer', '/api/remote-instances/srv-1');
  assert.equal(one.json.status.runtime.containerId, ID.slice(0, 12));
  const listed = await call('viewer', '/api/remote-instances');
  assert.equal(listed.json.coreImportRoot, '/data/remote-core-import', 'the panel can name the import directory');
  const all = listed.json.instances;
  assert.equal(all[0].runtime.containerId, ID.slice(0, 12));
  assert.deepEqual(all[1].runtime, { status: 'RUNNING', pid: 42 });
  assert.equal(all[2].error, 'REMOTE_CONNECT_FAILED');
  const started = await call('operator', '/api/remote-instances/srv-1/start', {});
  assert.equal(started.json.status.runtime.containerId, ID.slice(0, 12));
  assert.ok(!JSON.stringify([one.json, all, started.json]).includes(ID));
  for (const [id, code] of [['srv-9', 'REMOTE_DOCKER_IMAGE_MISSING'], ['srv-8', 'REMOTE_DOCKER_CONTAINER_EXISTS'], ['srv-7', 'REMOTE_DOCKER_NOT_CONFIRMED']]) {
    const answer = await call('operator', `/api/remote-instances/${id}/start`, {});
    assert.deepEqual([answer.status, answer.json.code], [409, code]);
  }
});

test('the permission map lists the Docker routes under the permission the route asks for', () => {
  const of = route => REMOTE_LINUX_BINDINGS.filter(binding => binding.routes.includes(route)).map(binding => binding.permission);
  assert.deepEqual(of('GET /api/remote-hosts/:id/docker'), ['diagnostics.read']);
  for (const route of ['POST /api/remote-hosts/:id/docker/confirm', 'POST /api/remote-hosts/:id/docker/image', 'POST /api/remote-instances/:id/deployment']) assert.deepEqual(of(route), ['server.manage'], route);
});

test('every Docker code the library can throw has a German and an English message in the panel', async () => {
  const lib = fileURLToPath(new URL('../lib/', import.meta.url));
  const codes = new Set();
  for (const file of (await fs.readdir(lib)).filter(name => name.endsWith('.mjs'))) {
    for (const match of (await fs.readFile(lib + file, 'utf8')).matchAll(/'(REMOTE_(?:DOCKER|DEPLOYMENT)_[A-Z_]+)'/g)) codes.add(match[1]);
  }
  assert.ok(codes.size >= 12, [...codes].join());
  const panel = await fs.readFile(lib + 'remote-hosts.jsx', 'utf8');
  for (const code of [...codes, 'REMOTE_INSTANCE_RUNNING', 'INSTANCE_PROCESS_IDENTITY_BLOCKED', 'REMOTE_RECOVERY_BLOCKED']) {
    const entry = new RegExp(`^\\s*${code}: \\['([^']{10,})', '([^']{10,})'\\],$`, 'm').exec(panel);
    assert.ok(entry, `${code} has no message`);
    assert.notEqual(entry[1], entry[2], code);
  }
});
