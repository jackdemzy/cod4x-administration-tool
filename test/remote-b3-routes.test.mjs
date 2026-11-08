import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from '../lib/remote-linux-routes.mjs';

const ROLES = { viewer: ['diagnostics.read'], operator: ['diagnostics.read', 'server.manage'], admin: ['diagnostics.read', 'server.manage', 'config.manage'] };
const SECRET = 'Db-Secret-Value9';
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function start(t, { active = false } = {}) {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { name }; };
  const database = { read: record('read'), save: record('save'), remove: record('remove'), test: record('test'), invalidate: record('invalidate') };
  const admin = Object.fromEntries(['status', 'players', 'player', 'admins', 'penalties', 'groups', 'commands', 'addBan', 'kick', 'unban', 'setGroup', 'liftWarning'].map(name => [name, record(name)]));
  const remoteCredentials = {
    instanceStatus: async id => { calls.push(['instanceStatus', id]); return { locked: false, initialized: true, sha256: 'a'.repeat(64), digest: null, rcon: { configured: true }, master: { configured: false }, join: { configured: false }, b3db: { configured: false }, b3auth: { configured: false } }; },
    set: async (id, kind, input) => { calls.push(['set', id, kind, input.value === SECRET]); return { sha256: 'b'.repeat(64) }; },
    remove: async (id, kind) => { calls.push(['remove', id, kind]); return { sha256: 'c'.repeat(64) }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { username: `user-${req.get('x-role')}`, role: req.get('x-role') }; next(); });
  const requirePermission = permission => (req, res, next) => (ROLES[req.auth.role]?.includes(permission) ? next() : res.status(403).json({ ok: false, code: 'FORBIDDEN' }));
  const audits = [];
  const manager = {
    instances: { get: id => (id === 'srv-1' ? { id, hostId: 'lab-1', port: 28960 } : fail('REMOTE_INSTANCE_NOT_FOUND')) },
    savedRuntime: async () => ({ status: active ? 'RUNNING' : 'STOPPED' }),
  };
  registerRemoteLinuxRoutes({ app, requirePermission, audit: (level, event, details) => audits.push({ level, event, ...details }), hostService: {}, hostStore: {}, manager, credentials: {},
    hasPermission: (role, permission) => ROLES[role]?.includes(permission) === true, remoteCredentials, b3: { database, admin } });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (role, route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'x-role': role, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), text: '' };
  };
  return { call, calls, audits };
}

test('B3 database routes for remote servers: config.manage, same shapes, migration refused', async t => {
  const { call, calls } = await start(t);
  const base = '/api/remote-instances/srv-1/b3/database';
  assert.equal((await call('operator', base)).status, 403);
  assert.equal((await call('admin', base)).json.database.name, 'read');
  assert.equal((await call('admin', base, { host: 'db.example.org', port: 3306, database: 'b3', username: 'b3' })).json.database.name, 'save');
  assert.equal((await call('admin', `${base}/test`, {})).json.database.name, 'test');
  assert.equal((await call('admin', `${base}/remove`, {})).json.database.name, 'remove');
  assert.deepEqual(calls.find(entry => entry[0] === 'save'), ['save', 'srv-1', { host: 'db.example.org', port: 3306, database: 'b3', username: 'b3' }]);
  const migrate = await call('admin', `${base}/migrate`, {});
  assert.deepEqual([migrate.status, migrate.json.code], [400, 'REMOTE_B3_MIGRATE_UNSUPPORTED']);
  assert.equal((await call('admin', '/api/remote-instances/nope/b3/database')).status, 404);
  for (const runtime of ['start', 'stop', 'restart', 'logs', 'config', 'plugins', 'dashboard']) assert.equal((await call('admin', `/api/remote-instances/srv-1/b3/${runtime}`, {})).json.code, 'REMOTE_B3_UNSUPPORTED', runtime);
});

test('B3 admin routes for remote servers: reads with diagnostics.read, writes with server.manage, full view only with config.manage', async t => {
  const { call, calls } = await start(t);
  const base = '/api/remote-instances/srv-1/b3/admin';
  for (const read of ['status', 'players', 'players/7', 'admins', 'penalties', 'groups', 'commands']) assert.equal((await call('viewer', `${base}/${read}`)).status, 200, read);
  for (const write of ['players/7/ban', 'players/7/kick', 'players/7/unban', 'players/7/group', 'penalties/3/lift']) assert.equal((await call('viewer', `${base}/${write}`, {})).status, 403, write);
  await call('operator', `${base}/players/7/ban`, { kind: 'TempBan', durationMinutes: 60, reason: 'spam', kick: true });
  assert.deepEqual(calls.find(entry => entry[0] === 'addBan'), ['addBan', 'srv-1', 7, { kind: 'TempBan', durationMinutes: 60, reason: 'spam', kick: true }, 'user-operator']);
  await call('admin', `${base}/players?search=ann&offset=20`);
  assert.deepEqual(calls.filter(entry => entry[0] === 'players').map(entry => [entry[2], entry[3]]), [[{ search: undefined, offset: undefined }, { full: false }], [{ search: 'ann', offset: 20 }, { full: true }]]);
  await call('operator', `${base}/players/x/unban`, {});
  assert.equal(calls.find(entry => entry[0] === 'unban')[2], -1, 'a bad client id is passed as -1 and refused by the service');
});

test('remote credentials: only rcon and b3db, the value is never echoed, rcon only while stopped, b3db invalidates the database check', async t => {
  const { call, calls, audits } = await start(t);
  const base = '/api/remote-instances/srv-1/credentials';
  assert.equal((await call('operator', base)).status, 403);
  const status = (await call('admin', base)).json.credentials;
  assert.deepEqual(Object.keys(status).sort(), ['b3db', 'digest', 'initialized', 'locked', 'rcon', 'sha256']);
  for (const kind of ['master', 'join', 'b3auth', 'ssh']) assert.equal((await call('admin', `${base}/${kind}`, { value: SECRET, expectedSha256: 'a'.repeat(64) })).json.code, 'REMOTE_ARGUMENT_INVALID', kind);
  const saved = await call('admin', `${base}/b3db`, { value: SECRET, expectedSha256: 'a'.repeat(64) });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.json).includes(SECRET));
  assert.deepEqual(calls.filter(entry => ['set', 'invalidate'].includes(entry[0])).map(entry => entry.slice(0, 3)), [['set', 'srv-1', 'b3db'], ['invalidate', 'srv-1']]);
  assert.equal((await call('admin', `${base}/rcon/remove`, { expectedSha256: 'a'.repeat(64) })).status, 200);
  assert.ok(!JSON.stringify(audits).includes(SECRET));
});

test('the rcon password of a running remote server is not changed', async t => {
  const { call, calls } = await start(t, { active: true });
  const result = await call('admin', '/api/remote-instances/srv-1/credentials/rcon', { value: SECRET, expectedSha256: 'a'.repeat(64) });
  assert.deepEqual([result.status, result.json.code], [409, 'REMOTE_INSTANCE_RUNNING']);
  assert.ok(!calls.some(entry => entry[0] === 'set'));
  assert.equal((await call('admin', '/api/remote-instances/srv-1/credentials/b3db', { value: SECRET, expectedSha256: 'a'.repeat(64) })).status, 200, 'the database password is not used by the game server');
});

test('the permission map lists the remote B3 and credential routes with their permissions', () => {
  const listed = REMOTE_LINUX_BINDINGS.flatMap(binding => binding.routes.map(route => `${binding.permission} ${route}`));
  for (const entry of ['config.manage GET /api/remote-instances/:id/b3/database', 'config.manage POST /api/remote-instances/:id/b3/database/test', 'diagnostics.read GET /api/remote-instances/:id/b3/admin/penalties',
    'server.manage POST /api/remote-instances/:id/b3/admin/players/:clientId/ban', 'config.manage POST /api/remote-instances/:id/credentials/:kind', 'config.manage GET /api/remote-instances/:id/credentials']) assert.ok(listed.includes(entry), entry);
});
