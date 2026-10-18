import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('authenticated runtime/instance APIs persist isolated definitions across backend restart and block unverified starts', { skip: !['win32', 'linux'].includes(process.platform), timeout: 30000 }, async () => {
  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-runtime-http-'));
  let child;
  let closed;
  try {
    const baseGame = path.join(root, 'game');
    const core = path.join(root, 'core', platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun');
    const home = path.join(root, 'server-home');
    await fs.mkdir(path.join(baseGame, 'main'), { recursive: true });
    await fs.mkdir(path.join(baseGame, 'zone'), { recursive: true });
    await fs.mkdir(path.dirname(core));
    await fs.writeFile(path.join(baseGame, 'main', 'pak0.iwd'), 'structural test fixture');
    await fs.writeFile(path.join(baseGame, 'zone', 'localized.ff'), 'structural test fixture');
    // Never executable or adopted: this test must exercise the verified-core denial.
    await fs.writeFile(core, 'NOT AN EXECUTABLE');
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
    Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root });
    const url = `http://127.0.0.1:${port}`;
    async function startBackend() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
    closed = new Promise(resolve => child.once('close', resolve));
    child.once('error', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      try { const response = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, `Isolated backend did not become ready: ${diagnostics}`);
    }
    await startBackend();
    const password = `${crypto.randomBytes(20).toString('hex')}Aa9!`;
    const initialized = await fetch(`${url}/api/auth/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'runtimeAuditAdmin', password }), signal: AbortSignal.timeout(5000) });
    assert.equal(initialized.status, 201);
    let { token } = await initialized.json();
    assert.equal(typeof token, 'string');
    const request = async (route, body, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
      return { status: response.status, json: await response.json() };
    };
    const configuration = { path: home, executablePath: core, baseGamePath: baseGame, cod4x: '21.5', platform };
    const saved = await request('/api/runtime/config', configuration);
    assert.equal(saved.status, 200, saved.json.error);
    assert.equal(saved.json.runtime.baseGamePath, baseGame);
    const selected212 = await request('/api/runtime/config', { ...configuration, cod4x: '21.2' });
    assert.equal(selected212.status, 200, selected212.json.error);
    assert.equal(selected212.json.runtime.cod4x, '21.2');
    const unverified212 = await request('/api/runtime/start', { ...configuration, cod4x: '21.2' });
    assert.equal(unverified212.status, 400);
    assert.match(unverified212.json.error, /Verified-Core gate/);
    // An explicit older selection is retained, never silently migrated to 21.2.
    assert.equal((await request('/api/runtime/config', configuration)).json.runtime.cod4x, '21.5');
    const denied = await request('/api/runtime/config', { ...configuration, baseGamePath: path.join(root, 'missing') });
    assert.equal(denied.status, 400);
    const status = await request('/api/runtime/status');
    assert.equal(status.json.runtime.baseGamePath, baseGame);
    const preflight = await request('/api/runtime/preflight');
    assert.equal(preflight.status, 200, preflight.json.error);
    assert.equal(preflight.json.baseGame.valid, true);
    assert.equal(preflight.json.core.verified, false);
    assert.equal(preflight.json.ok, false);
    const started = await request('/api/runtime/start', configuration);
    assert.equal(started.status, 400);
    assert.match(started.json.error, /Verified-Core gate/);
    assert.equal(started.json.runtime.pid, null);
    await assert.rejects(fs.stat(home), { code: 'ENOENT' });
    const stored = JSON.parse(await fs.readFile(path.join(root, 'data', 'config', 'runtime-state.json'), 'utf8'));
    assert.equal(stored.baseGamePath, baseGame);

    // Block atomic replacement with a real directory at the state-file target.
    const stateFile = path.join(root, 'data', 'config', 'runtime-state.json');
    const backup = `${stateFile}.test-backup`;
    await fs.rename(stateFile, backup);
    await fs.mkdir(stateFile);
    try {
      const failedSave = await request('/api/runtime/config', configuration);
      assert.equal(failedSave.status, 400, 'write failure must not return HTTP success');
      assert.equal(failedSave.json.ok, false);
      assert.match(failedSave.json.error, /could not be saved/);
      assert.equal((await request('/api/runtime/status')).json.runtime.persistenceError.code, 'RUNTIME_PERSISTENCE_FAILED');
      assert.equal(await fs.readFile(backup, 'utf8'), JSON.stringify(stored, null, 2));
      // Separate, non-executable fixture: adoption is exercised, never launched.
      const adoptionCore = path.join(root, 'adoption-fixture', platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun');
      await fs.mkdir(path.dirname(adoptionCore));
      await fs.writeFile(adoptionCore, 'NON EXECUTABLE ADOPTION TEST');
      const failedAdoption = await request('/api/runtime/adopt', { ...configuration, executablePath: adoptionCore });
      assert.equal(failedAdoption.status, 400);
      assert.equal(failedAdoption.json.ok, false);
      assert.match(failedAdoption.json.error, /could not be saved/);
      assert.equal(await fs.readFile(backup, 'utf8'), JSON.stringify(stored, null, 2));
      // Manifest adoption precedes state persistence; a failed API is not rollback.
      const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(adoptionCore), 'cod4x-control-manifest.json'), 'utf8'));
      assert.equal(manifest.verification, 'operator-adopted');
      assert.equal((await request('/api/runtime/status')).json.runtime.pid, null);
    } finally {
      await fs.rmdir(stateFile);
      await fs.rename(backup, stateFile);
    }
    assert.equal((await request('/api/runtime/config', configuration)).status, 200);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).persistenceError, null);

    assert.equal((await fetch(`${url}/api/instances`)).status, 401);
    assert.equal((await request('/api/instances')).json.hostPlatform, platform);
    async function freeUdpPort() {
      const socket = dgram.createSocket('udp4');
      await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
      const value = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      return value;
    }
    const firstPort = await freeUdpPort();
    let secondPort = await freeUdpPort();
    while (secondPort === firstPort) secondPort = await freeUdpPort();
    const definition = { id: 'public-01', name: 'Public 01', platform, serverCore: { executablePath: core, version: '21.2' }, basePath: baseGame, port: firstPort };
    const created = await request('/api/instances', definition);
    assert.equal(created.status, 201, created.json.error);
    const duplicate = await request('/api/instances', { ...definition, id: 'duplicate-port' });
    assert.equal(duplicate.json.code, 'INSTANCE_PORT_CONFLICT');
    const cloned = await request('/api/instances/public-01/clone', { id: 'public-02', name: 'Public 02', port: secondPort });
    assert.equal(cloned.status, 201, cloned.json.error);
    assert.notEqual(created.json.instance.homePath, cloned.json.instance.homePath);
    assert.equal((await fetch(`${url}/api/credentials/vault`)).status, 401);
    const unauthorizedUnlock = await fetch(`${url}/api/credentials/vault/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'Disposable unauthorized passphrase!' }) });
    assert.equal(unauthorizedUnlock.status, 401);
    assert.equal(unauthorizedUnlock.headers.get('cache-control'), 'no-store');
    const malformedUnlock = await fetch(`${url}/api/credentials/vault/unlock`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"passphrase":"private-malformed-secret' });
    assert.equal(malformedUnlock.status, 400);
    assert.ok(!(await malformedUnlock.text()).includes('private-malformed-secret'));
    const vaultPassphrase = 'Disposable HTTP vault passphrase!';
    const rconSecret = 'Disposable-HTTP-Rcon-123!';
    const masterSecret = 'A'.repeat(32);
    assert.equal((await request('/api/credentials/vault')).json.vault.initialized, false);
    const vaultInitialized = await request('/api/credentials/vault/initialize', { passphrase: vaultPassphrase });
    assert.equal(vaultInitialized.status, 201, vaultInitialized.json.error);
    assert.equal(vaultInitialized.json.vault.locked, true);
    const unlocked = await request('/api/credentials/vault/unlock', { passphrase: vaultPassphrase });
    assert.equal(unlocked.status, 200, unlocked.json.error);
    assert.equal(unlocked.json.vault.locked, false);
    const credentialSet = await request('/api/instances/public-01/credentials/rcon', { value: rconSecret, expectedSha256: unlocked.json.vault.sha256 });
    assert.equal(credentialSet.status, 200, credentialSet.json.error);
    assert.equal(credentialSet.json.credential.verified, true);
    assert.ok(!JSON.stringify(credentialSet.json).includes(rconSecret));
    const credentialMetadata = await request('/api/instances/public-01/credentials');
    assert.equal(credentialMetadata.json.credentials.rcon.configured, true);
    assert.ok(!JSON.stringify(credentialMetadata.json).includes(rconSecret));
    assert.equal((await request('/api/instances/public-02/credentials')).json.credentials.rcon.configured, false);
    const masterSet = await request('/api/instances/public-02/credentials/master', { value: masterSecret, expectedSha256: credentialSet.json.credential.sha256 });
    assert.equal(masterSet.status, 200, masterSet.json.error);
    assert.equal((await request('/api/instances/public-01/credentials')).json.credentials.master.configured, false);
    const masterStopped = await request('/api/instances/public-02/master');
    assert.equal(masterStopped.status, 200, masterStopped.json.error);
    assert.deepEqual([masterStopped.json.master.state, masterStopped.json.master.reason], ['TOKEN_CONFIGURED', 'SERVER_STOPPED']);
    assert.equal((await request('/api/instances/public-01/master')).json.master.state, 'NOT_CONFIGURED');
    assert.ok(!JSON.stringify(masterStopped.json).includes(masterSecret));
    // Public exposure: loopback default, confirmation required, persisted, audited.
    assert.equal((await request('/api/instances/public-02')).json.instance.network.scope, 'LOOPBACK');
    const unconfirmed = await request('/api/instances/public-02/network', { scope: 'PUBLIC' });
    assert.equal(unconfirmed.status, 428);
    assert.equal(unconfirmed.json.code, 'INSTANCE_NETWORK_CONFIRMATION_REQUIRED');
    const exposed = await request('/api/instances/public-02/network', { scope: 'PUBLIC', publicAddress: '203.0.113.7', confirm: 'PUBLIC_EXPOSURE' });
    assert.equal(exposed.status, 200, exposed.json.error);
    assert.deepEqual(exposed.json.network, { scope: 'PUBLIC', publicAddress: '203.0.113.7' });
    assert.equal((await request('/api/instances/public-02/network', { scope: 'LOOPBACK' })).json.network.scope, 'LOOPBACK');
    // B3 dependency layer: matrix is public diagnostics, settings are validated, nothing starts B3.
    const b3Matrix = await request('/api/b3/dependencies/matrix');
    assert.equal(b3Matrix.status, 200, b3Matrix.json.error);
    assert.ok(b3Matrix.json.matrix.some(entry => entry.id === 'python' && entry.requirement === '>= 2.7, < 3'));
    const b3Invalid = await request('/api/b3/environment', { pythonPath: 'python' });
    assert.deepEqual([b3Invalid.status, b3Invalid.json.code], [400, 'B3_PYTHON_PATH_INVALID']);
    const b3Check = await request('/api/b3/dependencies/check', {});
    assert.equal(b3Check.status, 200, b3Check.json.error);
    assert.equal(b3Check.json.dependencies.overall, 'BLOCKED', 'unconfigured B3 environment is blocked, never assumed ready');
    // B3 runtime: separate process per instance; unconfigured dependencies never start it.
    const b3Status = await request('/api/instances/public-02/b3');
    assert.equal(b3Status.status, 200, b3Status.json.error);
    assert.deepEqual([b3Status.json.b3.runtime.status, b3Status.json.b3.health.status], ['STOPPED', 'DOWN']);
    const b3Board = await request('/api/instances/public-02/b3/dashboard');
    assert.equal(b3Board.status, 200, b3Board.json.error);
    assert.deepEqual(b3Board.json.b3.diagnosis.slice(0, 2), ['PYTHON_MISSING', 'B3_MISSING'], 'unconfigured environment is diagnosed, not assumed');
    assert.equal((await request('/api/instances/public-02/b3/config')).json.config.exists, false);
    const b3Start = await request('/api/instances/public-02/b3/start', {});
    assert.deepEqual([b3Start.status, b3Start.json.code], [400, 'B3_DEPENDENCIES_BLOCKED']);
    assert.equal((await request('/api/instances/public-02')).json.instance.runtime.status, 'STOPPED', 'a blocked B3 start never touches the server');
    // Plugin manager: discovery is empty, malformed requests use fixed codes.
    const pluginList = await request('/api/instances/public-02/plugins');
    assert.equal(pluginList.status, 200, pluginList.json.error);
    assert.deepEqual(pluginList.json.plugins.plugins, []);
    const badInstall = await request('/api/instances/public-02/plugins/install', { sourcePath: 'relative.dll' });
    assert.deepEqual([badInstall.status, badInstall.json.code], [400, 'PLUGIN_SOURCE_INVALID']);
    assert.equal((await request('/api/instances/public-02/plugins/b3hide/enable', {})).json.code, 'PLUGIN_NOT_APPROVED');
    // Verify on a stopped server never contacts the master list.
    const stoppedVerify = await request('/api/instances/public-02/master/verify', {});
    assert.equal(stoppedVerify.status, 200, stoppedVerify.json.error);
    assert.equal(stoppedVerify.json.master.list, null);
    const invalidSecret = 'private-secret;quit';
    const invalidCredential = await request('/api/instances/public-01/credentials/rcon', { value: invalidSecret, expectedSha256: masterSet.json.credential.sha256 });
    assert.equal(invalidCredential.status, 400);
    assert.ok(!JSON.stringify(invalidCredential.json).includes(invalidSecret));
    const ciphertext = await fs.readFile(path.join(root, 'data', 'credential-vault', 'vault.json'), 'utf8');
    for (const secret of [rconSecret, masterSecret, vaultPassphrase]) assert.ok(!ciphertext.includes(secret));
    const configBefore = await request('/api/instances/public-01/config');
    assert.equal(configBefore.status, 200, configBefore.json.error);
    // Electron file:// renders use Origin: null; browsers preflight JSON PUT.
    const configPreflight = await fetch(`${url}/api/instances/public-01/config`, {
      method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(configPreflight.status, 204);
    assert.ok(configPreflight.headers.get('access-control-allow-methods').split(',').map(value => value.trim()).includes('PUT'), 'Config editor PUT must pass browser preflight');
    for (const route of ['/api/credentials/vault', '/api/instances/public-01/start', '/api/instances/public-01/config/preview']) {
      const unrelated = await fetch(`${url}${route}`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT' } });
      assert.ok(!unrelated.headers.get('access-control-allow-methods').split(',').map(value => value.trim()).includes('PUT'), 'Do not broaden PUT to unrelated endpoints');
    }
    const edited = configBefore.json.configuration.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Edited through schema' } : entry);
    const anonymousConfigWrite = await fetch(`${url}/api/instances/public-01/config`, { method: 'PUT', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedSha256: configBefore.json.configuration.sha256, entries: edited }) });
    assert.equal(anonymousConfigWrite.status, 401);
    assert.equal((await request('/api/instances/public-01/config')).json.configuration.sha256, configBefore.json.configuration.sha256);
    const configPreview = await request('/api/instances/public-01/config/preview', { expectedSha256: configBefore.json.configuration.sha256, entries: edited });
    assert.equal(configPreview.status, 200, configPreview.json.error);
    assert.equal(configPreview.json.configuration.valid, true);
    assert.equal(configPreview.json.configuration.diff[0].name, 'sv_hostname');
    assert.equal((await request('/api/instances/public-01/config')).json.configuration.sha256, configBefore.json.configuration.sha256);
    const configApplied = await request('/api/instances/public-01/config', { expectedSha256: configBefore.json.configuration.sha256, entries: edited }, 'PUT');
    assert.equal(configApplied.status, 200, configApplied.json.error);
    assert.equal(configApplied.json.configuration.verified, true);
    assert.equal(configApplied.json.configuration.restartRequired, true);
    const listedBackups = await request('/api/instances/public-01/config/backups');
    assert.equal(listedBackups.status, 200, listedBackups.json.error);
    assert.equal(listedBackups.json.backups[0].id, configApplied.json.configuration.backupId);
    assert.equal(listedBackups.json.backups[0].valid, true);
    assert.equal(Object.hasOwn(listedBackups.json.backups[0], 'text'), false);
    assert.equal((await request('/api/instances/public-02/config')).json.configuration.entries.find(entry => entry.name === 'sv_hostname').value, 'Public 02');
    const conflict = await request('/api/instances/public-01/config', { expectedSha256: configBefore.json.configuration.sha256, entries: edited }, 'PUT');
    assert.equal(conflict.status, 409);
    const restoredConfig = await request('/api/instances/public-01/config/restore', { expectedSha256: configApplied.json.configuration.sha256, backupId: configApplied.json.configuration.backupId });
    assert.equal(restoredConfig.status, 200, restoredConfig.json.error);
    assert.equal(restoredConfig.json.configuration.sha256, configBefore.json.configuration.sha256);
    await fs.writeFile(created.json.instance.configPath, 'set sv_hostname "damaged');
    const recoverable = await request('/api/instances/public-01/config');
    assert.equal(recoverable.status, 200, recoverable.json.error);
    assert.equal(recoverable.json.configuration.valid, false);
    assert.equal(Object.hasOwn(recoverable.json.configuration, 'text'), false);
    assert.equal((await request('/api/instances/public-01/config/backups')).status, 200);
    const repaired = await request('/api/instances/public-01/config/restore', { expectedSha256: recoverable.json.configuration.sha256, backupId: configApplied.json.configuration.backupId });
    assert.equal(repaired.status, 200, repaired.json.error);
    assert.equal(repaired.json.configuration.sha256, configBefore.json.configuration.sha256);
    assert.equal((await fetch(`${url}/api/instances/public-01/config`)).status, 401);
    const rejectedStart = await request('/api/instances/public-01/start', {}, 'POST');
    assert.equal(rejectedStart.status, 400);
    assert.equal(rejectedStart.json.code, 'VERIFIED_CORE_BLOCKED');
    assert.equal((await request('/api/instances/public-02')).json.instance.runtime.status, 'STOPPED');
    const auditEntries = (await request('/api/audit?limit=100')).json.events;
    const createAudit = auditEntries.find(entry => entry.details?.correlationId === created.json.correlationId);
    assert.equal(createAudit.details.route, '/api/instances');
    assert.equal(createAudit.details.instanceId, 'public-01');
    assert.equal(createAudit.details.actor, 'runtimeAuditAdmin');
    const startAudit = auditEntries.find(entry => entry.details?.correlationId === rejectedStart.json.correlationId);
    assert.equal(startAudit.details.route, '/api/instances/:id/start');
    assert.equal(startAudit.details.method, 'POST');
    assert.equal(startAudit.details.code, 'VERIFIED_CORE_BLOCKED');
    assert.ok(auditEntries.some(entry => entry.event === 'master.token.configured' && entry.details?.instanceId === 'public-02'));
    assert.equal(auditEntries.filter(entry => entry.event === 'network.exposure.changed' && entry.details?.instanceId === 'public-02').length, 2);
    const appliedAudit = auditEntries.find(entry => entry.event === 'config.change.applied' && entry.details?.backupId === configApplied.json.configuration.backupId);
    assert.deepEqual(appliedAudit.details.settings, ['modified:sv_hostname']);
    assert.equal(appliedAudit.details.previousSha256, configBefore.json.configuration.sha256);
    assert.equal(appliedAudit.details.sha256, configApplied.json.configuration.sha256);
    assert.ok(auditEntries.some(entry => entry.event === 'config.change.restored' && entry.details?.instanceId === 'public-01'));
    assert.ok(!JSON.stringify(auditEntries.filter(entry => entry.event?.startsWith('config.change.'))).includes('Edited through schema'), 'Config audit must not carry values');

    // Restart only our isolated backend: registry and legacy state must survive.
    child.kill(); await closed; await startBackend();
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'runtimeAuditAdmin', password }), signal: AbortSignal.timeout(5000) });
    assert.equal(login.status, 200);
    ({ token } = await login.json());
    assert.equal((await request('/api/credentials/vault')).json.vault.locked, true);
    assert.equal((await request('/api/instances/public-01/credentials')).json.credentials.rcon.configured, null);
    const lockedWrite = await request('/api/instances/public-01/credentials/rcon', { value: 'Disposable-New-123!', expectedSha256: masterSet.json.credential.sha256 });
    assert.equal(lockedWrite.status, 423);
    assert.equal((await request('/api/credentials/vault/unlock', { passphrase: vaultPassphrase })).status, 200);
    assert.equal((await request('/api/instances/public-01/credentials')).json.credentials.rcon.referenceId, credentialMetadata.json.credentials.rcon.referenceId);
    const privateAudit = JSON.stringify((await request('/api/audit')).json);
    for (const secret of [rconSecret, masterSecret, vaultPassphrase, invalidSecret]) assert.ok(!privateAudit.includes(secret));
    const privatePersistentAudit = JSON.stringify((await request('/api/audit/persistent')).json);
    for (const secret of [rconSecret, masterSecret, vaultPassphrase, invalidSecret]) assert.ok(!privatePersistentAudit.includes(secret));
    const viewerCreated = await request('/api/users', { username: 'credentialViewer', password: 'Disposable-Viewer-Password-123!', role: 'viewer' });
    assert.equal(viewerCreated.status, 201, viewerCreated.json.error);
    const viewerLogin = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'credentialViewer', password: 'Disposable-Viewer-Password-123!' }) });
    const viewerToken = (await viewerLogin.json()).token;
    const viewerDenied = await fetch(`${url}/api/credentials/vault`, { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert.equal(viewerDenied.status, 403);
    const viewerConfigBefore = await request('/api/instances/public-01/config');
    const viewerConfigDenied = await fetch(`${url}/api/instances/public-01/config`, { method: 'PUT', headers: { Origin: 'null', Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedSha256: viewerConfigBefore.json.configuration.sha256, entries: edited }) });
    assert.equal(viewerConfigDenied.status, 403);
    assert.equal((await request('/api/instances/public-01/config')).json.configuration.sha256, viewerConfigBefore.json.configuration.sha256);
    assert.equal((await request('/api/instances')).json.instances.length, 2);
    assert.equal((await request('/api/runtime/status')).json.runtime.baseGamePath, baseGame);
    assert.equal((await request('/api/runtime/status')).json.runtime.cod4x, '21.5');
    assert.equal((await request('/api/instances/public-02')).json.instance.serverCore.version, '21.2');
    const archived = await request('/api/instances/public-01', undefined, 'DELETE');
    assert.equal(archived.status, 200, archived.json.error);
    assert.equal(archived.json.archive.recoverable, true);
    assert.ok((await fs.stat(archived.json.archive.archivedHomePath)).isDirectory());
    assert.equal((await request('/api/instances')).json.instances.length, 1);
    assert.ok((await fs.stat(cloned.json.instance.homePath)).isDirectory());
    assert.ok((await fs.stat(baseGame)).isDirectory());
    const policy = (await request('/api/policy')).json.policy;
    assert.ok(policy.security.allowedCod4xVersions.includes('21.2'));
    const restricted = structuredClone(policy);
    restricted.security.allowedCod4xVersions = ['21.5'];
    // Emulate a pre-existing explicit operator restriction, not a new default.
    child.kill(); await closed;
    await fs.writeFile(path.join(root, 'data', 'config', 'policy.json'), JSON.stringify(restricted));
    await startBackend();
    const restrictedLogin = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'runtimeAuditAdmin', password }), signal: AbortSignal.timeout(5000) });
    assert.equal(restrictedLogin.status, 200);
    ({ token } = await restrictedLogin.json());
    assert.deepEqual((await request('/api/policy')).json.policy.security.allowedCod4xVersions, ['21.5']);
    const restrictedSelection = await request('/api/runtime/config', { ...configuration, cod4x: '21.2' });
    assert.equal(restrictedSelection.status, 400);
    assert.match(restrictedSelection.json.error, /Unsupported CoD4x version/);
    assert.equal((await request('/api/runtime/status')).json.runtime.cod4x, '21.5');
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (closed) await Promise.race([closed, delay(5000).then(() => { throw new Error('Isolated backend did not stop; fixtures retained'); })]);
    // Only the exact directory returned by mkdtemp is removed, after its child has stopped.
    assert.ok(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('cod4x-runtime-http-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
