import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTION_MAX_PER_WINDOW, RESTART_COOLDOWN_MS, RemoteActionGuard, STEP_UP_MS } from '../lib/remote-actions.mjs';
import { buildSayPacket, validSayText } from '../lib/rcon-protocol.mjs';
import { LoginThrottle } from '../lib/login-throttle.mjs';
import { RemoteSessions } from '../lib/remote-sessions.mjs';
import { REMOTE_WRITE_ROUTES, createRemoteGateway, listenRemoteGateway } from '../lib/remote-gateway.mjs';

const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('say text: printable ASCII, 1-150 characters, no quote, semicolon, percent or slash', () => {
  assert.equal(validSayText('  Restart in 5 Minuten!  '), 'Restart in 5 Minuten!');
  assert.equal(validSayText('x'.repeat(150)).length, 150);
  for (const bad of ['', '   ', 'x'.repeat(151), 'hi"; quit', 'a;b', '100%', 'a/b', 'a\\b', 'zeile\nzwei', 'Grüße', null, 42]) throwsCode(() => validSayText(bad), 'RCON_SAY_INVALID');
  const packet = buildSayPacket(Buffer.from('secretpw'), 'Hallo alle');
  assert.deepEqual([...packet.subarray(0, 4)], [0xff, 0xff, 0xff, 0xff]);
  assert.equal(packet.subarray(4).toString('ascii'), 'rcon secretpw say Hallo alle');
  throwsCode(() => buildSayPacket(Buffer.from('secretpw'), 'quit; say x'), 'RCON_SAY_INVALID');
});

test('action guard: step-up window, restart needs its own code, limits and cooldown', () => {
  let now = 0;
  const guard = new RemoteActionGuard({ now: () => now });
  throwsCode(() => guard.check('s1', 'say', 'a'), 'REMOTE_STEP_UP_REQUIRED');
  throwsCode(() => guard.check('s1', 'rcon', 'a', { freshCode: true }), 'REMOTE_ACTION_UNKNOWN');
  guard.grant('s1');
  guard.check('s1', 'say', 'a');
  guard.check('s1', 'kick', 'a');
  throwsCode(() => guard.check('s1', 'restart', 'a'), 'REMOTE_STEP_UP_REQUIRED');
  throwsCode(() => guard.check('s2', 'say', 'a'), 'REMOTE_STEP_UP_REQUIRED');
  now = STEP_UP_MS;
  throwsCode(() => guard.check('s1', 'say', 'a'), 'REMOTE_STEP_UP_REQUIRED');
  assert.equal(guard.stepUpUntil('s1'), null);

  guard.check('s1', 'restart', 'a', { freshCode: true }); guard.record('s1', 'restart', 'a');
  throwsCode(() => guard.check('s1', 'restart', 'a', { freshCode: true }), 'REMOTE_RESTART_COOLDOWN');
  guard.check('s1', 'restart', 'b', { freshCode: true });
  guard.failed('restart', 'a');
  guard.check('s1', 'restart', 'a', { freshCode: true });
  now += RESTART_COOLDOWN_MS;

  guard.grant('s3');
  for (let i = 0; i < ACTION_MAX_PER_WINDOW; i++) { guard.check('s3', 'say', 'a'); guard.record('s3', 'say', 'a'); }
  throwsCode(() => guard.check('s3', 'say', 'a'), 'REMOTE_ACTION_LIMIT');
  guard.revoke('s3');
  throwsCode(() => guard.check('s3', 'say', 'a'), 'REMOTE_STEP_UP_REQUIRED');
});

async function gateway(t, { proxy = false, allowed = true } = {}) {
  const users = {
    op: { username: 'op', role: 'operator', remoteAccess: true, totpEnabled: true },
    view: { username: 'view', role: 'viewer', remoteAccess: true, totpEnabled: true },
  };
  // One-use TOTP codes; RECOVERY-CODE only works without totpOnly.
  const used = new Set();
  const verifySecondFactor = async (username, code, { totpOnly = false } = {}) => {
    if (code === 'RECOVERY-CODE') return totpOnly ? { ok: false } : { ok: true, method: 'recovery' };
    if (!/^\d{6}$/.test(code) || used.has(code)) return { ok: false };
    used.add(code); return { ok: true, method: 'totp' };
  };
  const calls = [], audits = [];
  const matrix = { operator: ['monitor.read', 'server.manage'], viewer: ['monitor.read'] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-actions-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policy = { proxy };
  const app = createRemoteGateway({
    login: async ({ username, password }) => password === 'correct-horse-battery' ? users[username] || null : null,
    verifySecondFactor, hasPermission: (role, permission) => (matrix[role] || []).includes(permission),
    monitor: { overview: async () => ({ instances: [] }), history: async () => ({}), events: async () => ({ events: [] }) },
    sessions: new RemoteSessions(), throttle: new LoginThrottle(), policy: () => policy, staticDir: dir,
    audit: (level, event, details) => audits.push({ level, event, ...details }),
    actions: {
      allowed: () => allowed,
      players: async id => ({ instance: { id, name: 'Gate' }, map: 'mp_crash', players: [{ slot: 3, name: 'Wolf', ping: 40, score: 7, bot: false }] }),
      say: async (id, text, actor) => { calls.push(['say', id, text, actor]); if (id === 'missing') throw Object.assign(new Error('x'), { code: 'INSTANCE_NOT_FOUND' }); return { said: true, text }; },
      kick: async (id, target, actor) => { calls.push(['kick', id, target, actor]); return { kick: { slot: target.slot } }; },
      restart: async (id, actor) => { calls.push(['restart', id, actor]); if (id === 'broken') throw Object.assign(new Error('x'), { code: 'RUNTIME_START_FAILED' }); return { restarted: true }; },
      notify: (kind, details) => { calls.push(['notify', kind, details.instanceId]); },
    },
  });
  const server = await listenRemoteGateway(app, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, cookie) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json(), retryAfter: response.headers.get('retry-after') };
  };
  let next = 100000;
  const code = () => String(next++);
  const login = async (username, second = code()) => {
    const response = await fetch(`${base}/remote/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password: 'correct-horse-battery', code: second }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { request, login, code, calls, audits, policy };
}

test('gateway actions: step-up first, TOTP only, restart with its own code, audit and notify', async t => {
  const { request, login, code, calls, audits } = await gateway(t);
  assert.ok(REMOTE_WRITE_ROUTES.includes('POST /remote/api/instances/:id/restart') && !REMOTE_WRITE_ROUTES.some(route => /rcon|config|vault|\/start|\/stop/.test(route)));
  const op = await login('op');
  assert.equal((await request('/remote/api/instances/a/say', { text: 'hi' })).status, 401, 'no session');
  assert.deepEqual((await request('/remote/api/actions', null, op)).json, { ok: true, allowed: true, stepUpUntil: null, kinds: ['say', 'kick', 'restart'] });
  assert.equal((await request('/remote/api/instances/a/say', { text: 'hi' }, op)).json.code, 'REMOTE_STEP_UP_REQUIRED');
  assert.equal((await request('/remote/api/actions/step-up', { code: 'RECOVERY-CODE' }, op)).json.code, 'REMOTE_STEP_UP_INVALID', 'a recovery code never authorises an action');
  assert.equal((await request('/remote/api/actions/step-up', { code: '100000' }, op)).status, 401, 'the login code cannot be replayed');
  const stepUp = await request('/remote/api/actions/step-up', { code: code() }, op);
  assert.equal(stepUp.status, 200);
  assert.ok(stepUp.json.stepUpUntil > Date.now());
  assert.equal(calls.length, 0, 'nothing ran before the step-up');

  const said = await request('/remote/api/instances/a/say', { text: 'Restart in 5' }, op);
  assert.equal(said.status, 200, JSON.stringify(said.json));
  assert.deepEqual(calls.at(0), ['say', 'a', 'Restart in 5', 'op']);
  assert.equal((await request('/remote/api/instances/a/kick', { slot: 3, name: 'Wolf', reason: 'afk' }, op)).status, 200);
  assert.deepEqual((await request('/remote/api/instances/a/players', null, op)).json.players, [{ slot: 3, name: 'Wolf', ping: 40, score: 7, bot: false }]);
  assert.equal((await request('/remote/api/instances/a/restart', {}, op)).json.code, 'REMOTE_STEP_UP_REQUIRED', 'restart always needs its own code');
  assert.equal((await request('/remote/api/instances/a/restart', { code: code() }, op)).status, 200);
  const cooldown = await request('/remote/api/instances/a/restart', { code: code() }, op);
  assert.equal(cooldown.status, 429); assert.equal(cooldown.json.code, 'REMOTE_RESTART_COOLDOWN'); assert.ok(Number(cooldown.retryAfter) > 0);
  const broken = await request('/remote/api/instances/broken/restart', { code: code() }, op);
  assert.deepEqual([broken.status, broken.json.code], [409, 'RUNTIME_START_FAILED']);
  assert.equal((await request('/remote/api/instances/broken/restart', { code: code() }, op)).json.code, 'RUNTIME_START_FAILED', 'a failed restart does not start the cooldown');
  assert.equal((await request('/remote/api/instances/missing/say', { text: 'x' }, op)).status, 404);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call[0] === 'notify').map(call => call[1]), ['say', 'kick', 'restart']);
  for (const name of ['remote.action.step_up', 'remote.action.step_up_failed', 'remote.action.say', 'remote.action.kick', 'remote.action.restart']) assert.ok(audits.some(entry => entry.event === name), name);
  assert.ok(audits.filter(entry => entry.event.startsWith('remote.action.') && entry.event !== 'remote.action.step_up_failed').every(entry => entry.username === 'op'));
  assert.ok(!JSON.stringify(audits).includes('correct-horse-battery'));

  // 10 actions per session in 5 minutes (8 so far, one failed restart counted too).
  let limited = null;
  for (let i = 0; i < 5 && !limited; i++) { const result = await request('/remote/api/instances/a/say', { text: `n${i}` }, op); if (result.status === 429) limited = result; }
  assert.equal(limited?.json.code, 'REMOTE_ACTION_LIMIT');
  // Logging out ends the step-up.
  await request('/remote/api/logout', {}, op);
  const again = await login('op');
  assert.equal((await request('/remote/api/actions', null, again)).json.stepUpUntil, null);
});

test('gateway actions: refused without server.manage or the switches; behind the public proxy only with step-up', async t => {
  const plain = await gateway(t);
  const viewer = await plain.login('view');
  assert.equal((await plain.request('/remote/api/actions', null, viewer)).json.allowed, false);
  assert.equal((await plain.request('/remote/api/instances/a/say', { text: 'x', code: plain.code() }, viewer)).status, 403);
  const op = await plain.login('op');
  // Behind the public proxy too (TOTP login for every role), still with step-up; the audit marks it.
  plain.policy.proxy = true;
  assert.equal((await plain.request('/remote/api/actions', null, op)).json.allowed, true);
  assert.equal((await plain.request('/remote/api/instances/a/say', { text: 'x' }, op)).json.code, 'REMOTE_STEP_UP_REQUIRED');
  assert.equal((await plain.request('/remote/api/instances/a/say', { text: 'x', code: plain.code() }, op)).status, 200);
  assert.equal(plain.audits.find(entry => entry.event === 'remote.action.say' && entry.ok).proxy, true);
  plain.calls.length = 0;
  const off = await gateway(t, { allowed: false });
  const opOff = await off.login('op');
  assert.equal((await off.request('/remote/api/instances/a/restart', { code: off.code() }, opOff)).json.code, 'REMOTE_ACTIONS_DISABLED');
  assert.equal((await off.request('/remote/api/instances/a/players', null, opOff)).status, 403);
  assert.equal(plain.calls.length + off.calls.length, 0);
});
