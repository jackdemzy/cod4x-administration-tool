import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import path from 'node:path';
import { buildE2eCore, e2eCoreAvailable } from './support/e2e-core.mjs';
import { e2eBackend, baseGameFixture, consecutiveUdpPorts } from './support/e2e-backend.mjs';

// Block 22 (E2E): the roadmap flow against the real backend over HTTP:
// Install -> Detect Core -> BaseGame -> Create Server -> Config -> Start -> Map -> RCON ->
// Master List -> B3 -> Client Join -> Stop -> Restart, then a backend restart. After every step
// CONTROL itself must still answer. The core is the native E2E test core (not cod4x18_dedrun);
// the run with the real core is scripts/verify-4.18.28-e2e-native.mjs.
const skip = await e2eCoreAvailable();
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const RCON_PASSWORD = 'E2eFlowRcon2026';

export async function udpAsk(port, text, timeoutMs = 1000) {
  const socket = dgram.createSocket('udp4');
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs);
      socket.once('message', message => { clearTimeout(timer); resolve(message.subarray(4).toString('latin1')); });
      socket.send(Buffer.concat([OOB, Buffer.from(text, 'latin1')]), port, '127.0.0.1');
    });
  } finally { socket.close(); }
}
export const until = async (predicate, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (await predicate().catch(() => false)) return true; return false; };
const ok = (response, what) => assert.ok(response.status >= 200 && response.status < 300, `${what}: HTTP ${response.status} ${JSON.stringify(response.json)}`);

test('E2E flow: install to restart through the real backend, CONTROL answers after every step', { skip: skip || false, timeout: 120000 }, async t => {
  const backend = await e2eBackend(t, { prefix: 'cod4x-e2e-flow-' });
  const { request, assertAlive, root } = backend;
  // Later steps build on earlier ones: after the first failure the rest is skipped, not piled up.
  let failed = null;
  const step = async (name, action) => {
    await t.test(name, { skip: failed ? `after failed step "${failed}"` : false }, async () => {
      try { await action(); } catch (error) { failed = name; throw error; }
      await assertAlive(name);
    });
  };
  const core = await buildE2eCore(path.join(root, 'cores', 'e2e'));
  const baseGame = await baseGameFixture(root);
  const [port] = await consecutiveUdpPorts(1);
  const id = 'e2e-01';
  let firstPid;

  await step('Install: adopt the core', async () => {
    ok(await request('/api/runtime/adopt', { path: path.join(root, 'legacy-home'), executablePath: core, baseGamePath: baseGame, cod4x: '21.2', platform: 'linux' }), 'adopt');
  });
  await step('Detect Core: preflight reports a verified core and a valid base game', async () => {
    const query = new URLSearchParams({ path: path.join(root, 'legacy-home'), executablePath: core, baseGamePath: baseGame, cod4x: '21.2', platform: 'linux' });
    const preflight = await request(`/api/runtime/preflight?${query}`);
    ok(preflight, 'preflight');
    assert.equal(preflight.json.core.verified, true, JSON.stringify(preflight.json.core));
    assert.equal(preflight.json.baseGame.valid, true, JSON.stringify(preflight.json.baseGame));
  });
  await step('Create Server', async () => {
    const created = await request('/api/instances', { id, name: 'E2E 01', platform: 'linux', serverCore: { executablePath: core, version: '21.2' }, basePath: baseGame, port });
    assert.equal(created.status, 201, JSON.stringify(created.json));
  });
  await step('Config: server.cfg and RCON password', async () => {
    const current = await request(`/api/instances/${id}/config`);
    ok(current, 'read config');
    const entries = current.json.configuration.entries.filter(entry => entry.name !== 'sv_hostname').concat([{ command: 'set', name: 'sv_hostname', value: 'E2E Flow' }]);
    ok(await request(`/api/instances/${id}/config`, { entries, expectedSha256: current.json.configuration.sha256 }, 'PUT'), 'apply config');
    const credentials = await request(`/api/instances/${id}/credentials`);
    ok(await request(`/api/instances/${id}/credentials/rcon`, { expectedSha256: credentials.json.credentials.sha256, value: RCON_PASSWORD }), 'set rcon');
  });
  await step('Start', async () => {
    const started = await request(`/api/instances/${id}/start`, {});
    ok(started, 'start');
    firstPid = started.json.runtime.pid;
    assert.ok(firstPid > 0);
    assert.ok(await until(async () => /infoResponse/.test(await udpAsk(port, 'getinfo e2e', 300))), 'core does not answer on its port');
    assert.match(await udpAsk(port, 'getinfo e2e'), /hostname\\E2E Flow/);
  });
  await step('Map: rcon map mp_crash', async () => {
    const connected = await request(`/api/instances/${id}/rcon/connect`, {});
    ok(connected, 'rcon connect');
    assert.equal(connected.json.rcon.status, 'CONNECTED');
    assert.equal(connected.json.rcon.provisioning, 'PROVISIONED');
    ok(await request(`/api/instances/${id}/rcon/command`, { command: 'map mp_crash' }), 'map');
    assert.match(await udpAsk(port, 'getinfo e2e'), /mapname\\mp_crash/);
  });
  await step('RCON: status', async () => {
    const status = await request(`/api/instances/${id}/rcon/command`, { command: 'status' });
    ok(status, 'status');
    assert.match(JSON.stringify(status.json.result), /map: mp_crash/);
  });
  await step('Master List: controlled state, no crash', async () => {
    const master = await request(`/api/instances/${id}/master`, undefined, 'GET', { timeoutMs: 30000 });
    ok(master, 'master status');
    // Without a token the instance is reported as not configured; the listing itself is only
    // checked natively (COD4X_E2E_MASTER=1 in scripts/verify-4.18.28-e2e-native.mjs).
    assert.equal(master.json.master.state, 'NOT_CONFIGURED');
    assert.equal(master.json.master.reason, 'MASTER_TOKEN_NOT_CONFIGURED');
  });
  await step('B3: controlled state without Python, game server keeps running', async () => {
    const status = await request(`/api/instances/${id}/b3`);
    ok(status, 'b3 status');
    assert.equal(status.json.b3.runtime.running, false);
    const started = await request(`/api/instances/${id}/b3/start`, {});
    assert.ok(started.status >= 400 && started.status < 500 && /^B3_[A-Z_]+$/.test(started.json?.code || ''), `b3 start without B3 must be refused with a code: HTTP ${started.status} ${JSON.stringify(started.json)}`);
    assert.match(await udpAsk(port, 'getinfo e2e'), /infoResponse/);
  });
  await step('Client Join: CONTROL sees the player', async () => {
    assert.match(await udpAsk(port, 'e2ejoin E2EPlayer'), /e2ejoinResponse/);
    const online = await request(`/api/instances/${id}/rcon/online`);
    ok(online, 'online');
    assert.deepEqual(online.json.online.players.map(player => player.name.replace(/\^\d/g, '')), ['E2EPlayer']);
  });
  await step('Stop', async () => {
    ok(await request(`/api/instances/${id}/stop`, {}), 'stop');
    assert.ok(await until(async () => { try { await udpAsk(port, 'getinfo e2e', 200); return false; } catch { return true; } }), 'port still answers after stop');
  });
  await step('Restart: same port, new process', async () => {
    ok(await request(`/api/instances/${id}/start`, {}), 'start again');
    const restarted = await request(`/api/instances/${id}/restart`, {});
    ok(restarted, 'restart');
    assert.ok(restarted.json.runtime.pid > 0 && restarted.json.runtime.pid !== firstPid);
    assert.ok(await until(async () => /infoResponse/.test(await udpAsk(port, 'getinfo e2e', 300))), 'core does not answer after restart');
  });
  await step('Backend restart: instance, config and credentials survive', async () => {
    ok(await request(`/api/instances/${id}/stop`, {}), 'stop before backend restart');
    await backend.restart();
    const instance = await request(`/api/instances/${id}`);
    ok(instance, 'instance after restart');
    const config = await request(`/api/instances/${id}/config`);
    assert.ok(config.json.configuration.entries.some(entry => entry.name === 'sv_hostname' && entry.value === 'E2E Flow'));
    const credentials = await request(`/api/instances/${id}/credentials`);
    assert.equal(credentials.json.credentials.rcon.state, 'CONFIGURED');
    ok(await request(`/api/instances/${id}/start`, {}), 'start after backend restart');
    assert.ok(await until(async () => /infoResponse/.test(await udpAsk(port, 'getinfo e2e', 300))));
    ok(await request(`/api/instances/${id}/rcon/command`, { command: 'serverinfo' }), 'rcon after backend restart');
  });
});
