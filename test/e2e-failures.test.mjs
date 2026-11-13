import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import dgram from 'node:dgram';
import path from 'node:path';
import { buildE2eCore, e2eCoreAvailable } from './support/e2e-core.mjs';
import { e2eBackend, baseGameFixture, consecutiveUdpPorts, createInstance, adoptCore, answers, silent, until, ok } from './support/e2e-backend.mjs';
import { RconClient } from '../lib/rcon-client.mjs';

// Block 22 (E2E): the ten intentional failures of the roadmap. Each one must be refused or
// reported with a named code (never HTTP 5xx), CONTROL must keep answering, and a reference
// instance running next to them must stay untouched.
const skip = await e2eCoreAvailable();

test('E2E failures: ten intentional faults, CONTROL and the reference server keep running', { skip: skip || false, timeout: 180000 }, async t => {
  const backend = await e2eBackend(t, { prefix: 'cod4x-e2e-fail-' });
  const { request, assertAlive, root } = backend;
  const core = await buildE2eCore(path.join(root, 'cores', 'e2e'));
  const baseGame = await baseGameFixture(root);
  await adoptCore(backend, { core, baseGame });
  const ports = await consecutiveUdpPorts(7);
  const reference = { id: 'reference', port: ports[0], hostname: 'E2E Reference', rcon: 'E2eReferenceRcon1' };
  await createInstance(backend, { ...reference, core, baseGame });
  ok(await request(`/api/instances/${reference.id}/start`, {}), 'start reference');
  assert.ok(await answers(reference.port));
  const spare = { id: 'spare', port: ports[1], hostname: 'E2E Spare' };
  await createInstance(backend, { ...spare, core, baseGame });

  const refused = (response, code, status) => {
    assert.equal(response.json?.code, code, `expected ${code}, got HTTP ${response.status} ${JSON.stringify(response.json)}`);
    if (status) assert.equal(response.status, status);
    assert.ok(response.status >= 400 && response.status < 500, `HTTP ${response.status}`);
  };
  const definition = (id, port, overrides = {}) => ({ id, name: id, platform: 'linux', serverCore: { executablePath: core, version: '21.2' }, basePath: baseGame, port, ...overrides });
  const copyBaseGame = async name => { const copy = path.join(root, name); await fs.cp(baseGame, copy, { recursive: true }); return copy; };
  let failed = null;
  const fault = async (name, action) => {
    await t.test(name, { skip: failed ? `after failed case "${failed}"` : false }, async () => {
      try { await action(); } catch (error) { failed = name; throw error; }
      await assertAlive(name);
      assert.match(JSON.stringify(await new RconClient({ port: reference.port, timeoutMs: 1500 }).execute(Buffer.from(reference.rcon), 'serverinfo')), /E2E Reference/, `reference server disturbed by "${name}"`);
    });
  };

  await fault('falscher Core: nicht übernommener und kaputter Core werden nicht gestartet', async () => {
    const other = await buildE2eCore(path.join(root, 'cores', 'unadopted'));
    await createInstance(backend, { id: 'wrong-core', port: ports[2], hostname: 'Wrong Core', core: other, baseGame });
    refused(await request('/api/instances/wrong-core/start', {}), 'VERIFIED_CORE_BLOCKED', 400);
    assert.ok(await silent(ports[2], 1000));
    const text = path.join(root, 'cores', 'text', 'cod4x18_dedrun');
    await fs.mkdir(path.dirname(text), { recursive: true });
    await fs.writeFile(text, 'NOT AN EXECUTABLE');
    ok(await request('/api/instances/wrong-core', undefined, 'DELETE'), 'delete wrong-core');
    assert.equal((await request('/api/instances', definition('text-core', ports[2], { serverCore: { executablePath: text, version: '21.2' } }))).status, 201);
    refused(await request('/api/instances/text-core/start', {}), 'VERIFIED_CORE_BLOCKED', 400);
  });
  await fault('fehlende main-Datei: beim Anlegen und nachträglich gelöscht', async () => {
    const missing = await copyBaseGame('game-no-main');
    await fs.rm(path.join(missing, 'main', 'iw_00.iwd'));
    refused(await request('/api/instances', definition('no-main', ports[3], { basePath: missing })), 'BASEGAME_INVALID', 400);
    const later = await copyBaseGame('game-later-main');
    await createInstance(backend, { id: 'later-main', port: ports[3], hostname: 'Later Main', core, baseGame: later });
    await fs.rm(path.join(later, 'main', 'iw_00.iwd'));
    refused(await request('/api/instances/later-main/start', {}), 'BASEGAME_INVALID', 400);
    assert.ok(await silent(ports[3], 1000));
  });
  await fault('fehlende zone-Datei: beim Anlegen und nachträglich gelöscht', async () => {
    const missing = await copyBaseGame('game-no-zone');
    await fs.rm(path.join(missing, 'zone'), { recursive: true });
    refused(await request('/api/instances', definition('no-zone', ports[4], { basePath: missing })), 'BASEGAME_INVALID', 400);
    const later = await copyBaseGame('game-later-zone');
    await createInstance(backend, { id: 'later-zone', port: ports[4], hostname: 'Later Zone', core, baseGame: later });
    await fs.rm(path.join(later, 'zone'), { recursive: true });
    refused(await request('/api/instances/later-zone/start', {}), 'BASEGAME_INVALID', 400);
  });
  await fault('falscher Port: außerhalb, doppelt, belegt beim Anlegen und beim Start', async () => {
    refused(await request('/api/instances', definition('port-range', 70000)), 'INSTANCE_PORT_INVALID', 400);
    refused(await request('/api/instances', definition('port-dup', reference.port)), 'INSTANCE_PORT_CONFLICT', 400);
    const squatter = dgram.createSocket('udp4');
    await new Promise(resolve => squatter.bind(ports[5], '0.0.0.0', resolve));
    try { refused(await request('/api/instances', definition('port-busy', ports[5])), 'INSTANCE_PORT_UNAVAILABLE', 400); }
    finally { await new Promise(resolve => squatter.close(resolve)); }
    const blocker = dgram.createSocket('udp4');
    await new Promise(resolve => blocker.bind(spare.port, '127.0.0.1', resolve));
    try { refused(await request(`/api/instances/${spare.id}/start`, {}), 'INSTANCE_PORT_UNAVAILABLE', 400); }
    finally { await new Promise(resolve => blocker.close(resolve)); }
  });
  await fault('falscher RCON: ungültige Werte, veralteter Stand, Befehl an gestoppten Server', async () => {
    const { sha256 } = (await request(`/api/instances/${spare.id}/credentials`)).json.credentials;
    refused(await request(`/api/instances/${spare.id}/credentials/rcon`, { expectedSha256: sha256, value: 'short' }), 'CREDENTIAL_INVALID', 400);
    refused(await request(`/api/instances/${spare.id}/credentials/rcon`, { expectedSha256: sha256, value: 'With+PlusSign12' }), 'CREDENTIAL_INVALID', 400);
    refused(await request(`/api/instances/${spare.id}/credentials/rcon`, { expectedSha256: '0'.repeat(64), value: 'GoodEnough12345' }), 'VAULT_CONFLICT', 409);
    refused(await request(`/api/instances/${spare.id}/rcon/command`, { command: 'status' }), 'RCON_SERVER_NOT_RUNNING', 409);
    await assert.rejects(new RconClient({ port: reference.port, timeoutMs: 1500 }).execute(Buffer.from('WrongReference1'), 'serverinfo'), { code: 'RCON_AUTH_FAILED' });
  });
  await fault('fehlender Master Token: Prüfung meldet NOT_CONFIGURED, Server läuft', async () => {
    const verified = await request(`/api/instances/${reference.id}/master/verify`, {}, 'POST', { timeoutMs: 30000 });
    ok(verified, 'master verify');
    assert.equal(verified.json.master.state, 'NOT_CONFIGURED');
    assert.equal(verified.json.master.reason, 'MASTER_TOKEN_NOT_CONFIGURED');
    assert.equal(verified.json.master.verified, false);
  });
  await fault('falsche DB: unerreichbares Ziel wird gespeichert, der Test meldet einen B3-Code', async () => {
    const saved = await request(`/api/instances/${reference.id}/b3/database`, { host: '127.0.0.1', port: 1, database: 'b3', username: 'b3' });
    ok(saved, 'save database');
    assert.equal(saved.json.database.ready, false);
    const probe = await request(`/api/instances/${reference.id}/b3/database/test`, {}, 'POST', { timeoutMs: 30000 });
    // Without Python (CI): B3_PYTHON_NOT_CONFIGURED; with Python the connection error code.
    assert.ok(probe.status >= 400 && probe.status < 500 && /^B3_[A-Z_]+$/.test(probe.json?.code || ''), `HTTP ${probe.status} ${JSON.stringify(probe.json)}`);
  });
  await fault('B3 down: Status DOWN, Stop ohne laufendes B3 ist harmlos', async () => {
    const status = await request(`/api/instances/${reference.id}/b3`);
    ok(status, 'b3 status');
    assert.equal(status.json.b3.health.status, 'DOWN');
    assert.equal(status.json.b3.runtime.running, false);
    ok(await request(`/api/instances/${reference.id}/b3/stop`, {}), 'b3 stop');
  });
  await fault('Server crash: SIGKILL wird erkannt, Neustart klappt', async () => {
    const crash = { id: 'crash', port: ports[6], hostname: 'E2E Crash', rcon: 'E2eCrashRcon1234' };
    await createInstance(backend, { ...crash, core, baseGame });
    const started = await request(`/api/instances/${crash.id}/start`, {});
    ok(started, 'start crash');
    assert.ok(await answers(crash.port));
    process.kill(started.json.runtime.pid, 'SIGKILL');
    assert.ok(await silent(crash.port), 'crashed core still answers');
    assert.ok(await until(async () => (await request(`/api/instances/${crash.id}`)).json.instance.runtime?.status === 'FAILED'), 'crash not detected as FAILED');
    const again = await request(`/api/instances/${crash.id}/start`, {});
    ok(again, 'start after crash');
    assert.equal(again.json.runtime.status, 'RUNNING');
    assert.notEqual(again.json.runtime.pid, started.json.runtime.pid);
    assert.ok(await answers(crash.port));
    ok(await request(`/api/instances/${crash.id}/stop`, {}), 'stop crash');
  });
  await fault('Plugin fehlt: nicht freigegeben, Datei nachträglich gelöscht', async () => {
    refused(await request(`/api/instances/${spare.id}/plugins/missing/enable`, {}), 'PLUGIN_NOT_APPROVED', 400);
    const source = path.join(root, 'plugin-src', 'e2eplugin.so');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(508)]));
    ok(await request(`/api/instances/${spare.id}/plugins/install`, { sourcePath: source }), 'install plugin');
    ok(await request(`/api/instances/${spare.id}/plugins/e2eplugin/enable`, {}), 'enable plugin');
    const instance = (await request(`/api/instances/${spare.id}`)).json.instance;
    await fs.rm(path.join(instance.homePath, 'plugins', 'e2eplugin.so'));
    const listed = await request(`/api/instances/${spare.id}/plugins`);
    assert.equal(listed.json.plugins.plugins.find(plugin => plugin.name === 'e2eplugin')?.state, 'MISSING');
    refused(await request(`/api/instances/${spare.id}/start`, {}), 'PLUGIN_MISSING', 400);
    assert.ok(await silent(spare.port, 1000));
  });
});
