import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from '../lib/remote-linux-routes.mjs';

// The remote routes on a real express app. Roles: viewer (diagnostics.read), operator (+ server.manage),
// admin (+ config.manage). The services are recorders; the RCON service behaviour is tested elsewhere.
const ROLES = { viewer: ['diagnostics.read'], operator: ['diagnostics.read', 'server.manage'], admin: ['diagnostics.read', 'server.manage', 'config.manage', 'install.execute', 'update.execute'] };
const fail = code => { throw Object.assign(new Error(code), { code, rcon: { status: 'ERROR' } }); };

async function start(t, { rcon } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { username: `user-${req.get('x-role')}`, role: req.get('x-role') }; next(); });
  const requirePermission = permission => (req, res, next) => (ROLES[req.auth.role]?.includes(permission) ? next() : res.status(403).json({ ok: false, code: 'FORBIDDEN' }));
  const audits = [];
  const instances = { get: id => (id === 'srv-1' ? { id, hostId: 'lab-1', port: 28960 } : fail('REMOTE_INSTANCE_NOT_FOUND')) };
  registerRemoteLinuxRoutes({
    app, requirePermission, audit: (level, event, details) => audits.push({ level, event, ...details }),
    hostService: {}, hostStore: {}, manager: { instances }, credentials: {},
    rcon, hasPermission: (role, permission) => ROLES[role]?.includes(permission) === true,
  });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (role, route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'x-role': role, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  return { call, audits };
}

function recorder() {
  const calls = [];
  return {
    calls,
    status: id => { calls.push(['status', id]); return { status: 'CONNECTED', provisioning: 'PROVISIONED' }; },
    connect: async (id, actor) => { calls.push(['connect', id, actor]); return { status: 'CONNECTED' }; },
    execute: async (id, command, actor) => { calls.push(['execute', id, command, actor]); if (command === 'quit') fail('RCON_COMMAND_BLOCKED'); return { rcon: { status: 'CONNECTED' }, text: 'ok' }; },
    online: async (id, { full }) => { calls.push(['online', id, full]); return { map: 'mp_crash', players: [] }; },
    kick: async (id, target, actor) => { calls.push(['kick', id, target, actor]); return { kicked: true }; },
  };
}

test('remote rcon routes mirror the local ones: permissions, shapes and the instance check', async t => {
  const rcon = recorder();
  const { call } = await start(t, { rcon });
  assert.equal((await call('viewer', '/api/remote-instances/srv-1/rcon')).status, 403, 'status needs server.manage, as locally');
  assert.deepEqual((await call('operator', '/api/remote-instances/srv-1/rcon')).json.rcon, { status: 'CONNECTED', provisioning: 'PROVISIONED' });
  assert.equal((await call('viewer', '/api/remote-instances/srv-1/rcon/online')).json.online.map, 'mp_crash');
  await call('admin', '/api/remote-instances/srv-1/rcon/online');
  assert.deepEqual(rcon.calls.filter(entry => entry[0] === 'online').map(entry => entry[2]), [false, true], 'addresses unmasked only with config.manage');
  for (const route of ['connect', 'command', 'kick']) assert.equal((await call('viewer', `/api/remote-instances/srv-1/rcon/${route}`, {})).status, 403, route);
  assert.equal((await call('operator', '/api/remote-instances/srv-1/rcon/connect', {})).json.rcon.status, 'CONNECTED');
  assert.equal((await call('operator', '/api/remote-instances/srv-1/rcon/command', { command: 'status' })).json.result.text, 'ok');
  assert.equal((await call('operator', '/api/remote-instances/srv-1/rcon/kick', { slot: 3, name: 'Ann', reason: 'afk', extra: 1 })).json.kick.kicked, true);
  assert.deepEqual(rcon.calls.find(entry => entry[0] === 'kick'), ['kick', 'srv-1', { slot: 3, playerid: undefined, name: 'Ann', reason: 'afk' }, 'user-operator']);
  assert.deepEqual([(await call('operator', '/api/remote-instances/nope/rcon')).status, (await call('operator', '/api/remote-instances/nope/rcon/command', { command: 'status' })).json.code], [404, 'REMOTE_INSTANCE_NOT_FOUND']);
  assert.ok(!rcon.calls.some(entry => entry[1] === 'nope'), 'an unknown remote id never reaches the rcon service');
});

test('a command body other than exactly { command } is blocked; rcon codes keep their status', async t => {
  const { call } = await start(t, { rcon: recorder() });
  for (const body of [{}, { command: 'status', more: 1 }, []]) assert.deepEqual([(await call('operator', '/api/remote-instances/srv-1/rcon/command', body)).json.code], ['RCON_COMMAND_BLOCKED']);
  const blocked = await call('operator', '/api/remote-instances/srv-1/rcon/command', { command: 'quit' });
  assert.deepEqual([blocked.status, blocked.json.code, blocked.json.rcon], [403, 'RCON_COMMAND_BLOCKED', { status: 'ERROR' }]);
});

test('rcon error codes are mapped to fixed statuses and unknown errors to a fixed code', async t => {
  const cases = [['RCON_TIMEOUT', 504], ['RCON_SERVER_NOT_RUNNING', 409], ['VAULT_LOCKED', 423], ['RCON_AUTH_FAILED', 400], ['REMOTE_RCON_TOOL_MISSING', 400], ['EPIPE', 400]];
  for (const [code, status] of cases) {
    const rcon = { ...recorder(), connect: async () => fail(code) };
    const { call } = await start(t, { rcon });
    const result = await call('operator', '/api/remote-instances/srv-1/rcon/connect', {});
    assert.deepEqual([result.status, result.json.code], [status, code === 'EPIPE' ? 'REMOTE_OPERATION_FAILED' : code], code);
  }
});

test('B3 runtime paths stay unsupported for remote servers, the permission map lists the rcon routes', async t => {
  const { call } = await start(t, { rcon: recorder() });
  assert.equal((await call('operator', '/api/remote-instances/srv-1/b3/start', {})).json.code, 'REMOTE_B3_UNSUPPORTED');
  const listed = REMOTE_LINUX_BINDINGS.flatMap(binding => binding.routes.map(route => `${binding.permission} ${route}`));
  for (const entry of ['server.manage GET /api/remote-instances/:id/rcon', 'diagnostics.read GET /api/remote-instances/:id/rcon/online', 'server.manage POST /api/remote-instances/:id/rcon/connect',
    'server.manage POST /api/remote-instances/:id/rcon/command', 'server.manage POST /api/remote-instances/:id/rcon/kick']) assert.ok(listed.includes(entry), entry);
});
