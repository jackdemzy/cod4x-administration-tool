import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCoreLaunchArgs, coreArgumentProblem, unsafeCoreValue } from '../lib/core-launch-args.mjs';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { assertRemotePosixPath } from '../lib/remote-safety.mjs';
import { startCoreCommand } from '../lib/remote-commands.mjs';
import { runContainerCommand } from '../lib/docker-commands.mjs';
import { isCredentialPath } from '../lib/credential-request.mjs';
import { CredentialVaultStorage } from '../lib/credential-vault-storage.mjs';
import { rotateGameLogs } from '../lib/game-log-rotation.mjs';
import { removeCompiledPython } from '../lib/b3-runtime.mjs';
import { LoginThrottle } from '../lib/login-throttle.mjs';
import { RemoteSessions } from '../lib/remote-sessions.mjs';
import { createRemoteGateway, listenRemoteGateway } from '../lib/remote-gateway.mjs';
import backendReady from '../lib/backend-ready.cjs';
import { backend, password } from './support/security-backend.mjs';

// Audit 4.18.31: one regression test (or more) per fixed finding of docs/SECURITY-AUDIT-4.18.31.md.
const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const tempDir = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-audit-31-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };

test('F-1/F-2: a "+" inside a core argument is refused before any start', () => {
  const normal = ['+set', 'dedicated', '2', '+set', 'fs_basepath', '/srv/cod4', '+set', 'fs_homepath', '/srv/home/a', '+set', 'sv_hostname', 'My Server', '+exec', 'server.cfg', '+map', 'mp_backlot'];
  assert.equal(coreArgumentProblem(normal), null);
  assert.deepEqual(assertCoreLaunchArgs(normal), normal);
  for (const bad of [
    ['+set', 'fs_basepath', '/tmp/b+loadPlugin evil'],
    ['+set fs_homepath /tmp/x'],
    ['x +set fs_basepath /tmp/y'],
    ['+set', 'sv_hostname', 'a\nquit'],
    ['+set', 'sv_hostname', 'a\rb'],
    ['+', 'x'],
    ['+set', 42],
  ]) assert.throws(() => assertCoreLaunchArgs(bad), { code: 'CORE_ARGUMENT_INVALID' }, JSON.stringify(bad));
  assert.equal(unsafeCoreValue('/srv/b+x'), true);
  assert.equal(unsafeCoreValue('/srv/b x'), false);
});

test('F-1: BaseGame, remote paths and remote/Docker start commands refuse "+"', async t => {
  const root = await tempDir(t);
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  const definition = { id: 'evil', name: 'evil', platform: 'linux', port: 28961, serverCore: { executablePath: '/opt/core/cod4x18_dedrun', version: '21.5' } };
  assert.throws(() => store.model({ ...definition, basePath: '/tmp/b+loadPlugin evil' }), { code: 'INSTANCE_BASEPATH_INVALID' });
  assert.equal(store.model({ ...definition, basePath: path.resolve('/tmp/base game') }).basePath, path.resolve('/tmp/base game'));
  assert.throws(() => assertRemotePosixPath('/srv/b+loadPlugin evil'), { code: 'REMOTE_PATH_INVALID' });
  assert.equal(assertRemotePosixPath('/srv/cod4'), '/srv/cod4');
  const start = { core: '/srv/home/core/cod4x18_dedrun', cwd: '/srv/cod4', stdoutFile: '/srv/home/out.log', stderrFile: '/srv/home/err.log' };
  assert.match(startCoreCommand({ ...start, args: ['+set', 'net_port', '28960'] }), /net_port/);
  assert.throws(() => startCoreCommand({ ...start, args: ['+set', 'sv_hostname', 'a+loadPlugin x'] }), { code: 'REMOTE_ARGUMENT_INVALID' });
  const docker = { instanceId: 'alpha', runId: '00000000-0000-4000-8000-000000000000', image: `sha256:${'a'.repeat(64)}`, user: '1000:1000', basePath: '/srv/cod4', home: '/srv/home/alpha', port: 28960, publish: ['127.0.0.1'] };
  assert.throws(() => runContainerCommand({ ...docker, args: ['+set fs_homepath /x'] }), { code: 'REMOTE_ARGUMENT_INVALID' });
});

test('F-1: every local core start checks its final argument list; other paths need server.code', async () => {
  const manager = await read('lib/runtime-manager.mjs'), server = await read('installer-server.mjs');
  assert.match(manager, /const launchArgs=assertCoreLaunchArgs\(\["\+set","dedicated","2","\+set","fs_basepath",filesystemBasePath,"\+set","fs_homepath",filesystemHomePath,\.\.\.extraArgs\],"RUNTIME_ARGUMENT_INVALID"\);/);
  assert.match(server, /const cloneBringsCode = body => body\.serverCore !== undefined \|\| body\.basePath !== undefined;/);
  assert.match(server, /choosesOtherPath\(body\.path, defaultRuntime\.state\.target\) \|\| choosesOtherPath\(body\.baseGamePath, defaultRuntime\.state\.baseGamePath\)/);
  assert.match(server, /if \(\/\[\+\\r\\n\]\/\.test\(raw\)\) throw new Error\("Runtime path must not contain/);
});

test('F-3: compiled Python files are removed from the B3 tree before a start, links are not followed', async t => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'b3', 'plugins', 'xlrstats'), { recursive: true });
  await fs.writeFile(path.join(root, 'b3', 'plugins', 'xlrstats', '__init__.py'), 'x = 1\n');
  await fs.writeFile(path.join(root, 'b3', 'plugins', 'xlrstats', '__init__.pyc'), 'evil');
  await fs.writeFile(path.join(root, 'b3', 'parser.pyo'), 'evil');
  const outside = await tempDir(t);
  await fs.writeFile(path.join(outside, 'keep.pyc'), 'not ours');
  const links = process.platform !== 'win32';
  if (links) {
    await fs.symlink(outside, path.join(root, 'linked'));
    // Codex review: a bytecode link is removed itself, its target stays.
    await fs.symlink(path.join(outside, 'keep.pyc'), path.join(root, 'b3', 'forged.pyc'));
  }
  const removed = (await removeCompiledPython(root)).map(file => file.split(path.sep).join('/')).sort();
  assert.deepEqual(removed, [...(links ? ['b3/forged.pyc'] : []), 'b3/parser.pyo', 'b3/plugins/xlrstats/__init__.pyc']);
  await fs.access(path.join(root, 'b3', 'plugins', 'xlrstats', '__init__.py'));
  await fs.access(path.join(outside, 'keep.pyc'));
  assert.deepEqual(await removeCompiledPython(path.join(root, 'missing')), []);
  assert.match(await read('lib/b3-runtime.mjs'), /await removeCompiledPython\(b3Path\);\n      const argv = b3LaunchArguments/);
});

test('S-7: game logs above the limit are rotated once before a start, links are left alone', async t => {
  const main = await tempDir(t);
  await fs.mkdir(path.join(main, 'logs'));
  await fs.writeFile(path.join(main, 'qconsole.log'), 'x'.repeat(200));
  await fs.writeFile(path.join(main, 'qconsole.log.1'), 'old');
  await fs.writeFile(path.join(main, 'logs', 'games_mp.log'), 'small');
  assert.deepEqual(await rotateGameLogs(main, { limit: 100 }), ['qconsole.log']);
  assert.equal((await fs.readFile(path.join(main, 'qconsole.log.1'), 'utf8')).length, 200);
  await assert.rejects(fs.access(path.join(main, 'qconsole.log')));
  assert.equal(await fs.readFile(path.join(main, 'logs', 'games_mp.log'), 'utf8'), 'small');
  assert.match(await read('lib/server-instance-manager.mjs'), /await sweepLaunchFiles\(mainDir\);\n      await rotateGameLogs\(mainDir\);/);
});

test('S-6: a vault operation lock of a process that is gone is taken over, a live one still means busy', async t => {
  const root = await tempDir(t);
  const vault = new CredentialVaultStorage(root);
  const secret = 'Disposable storage test passphrase!';
  await vault.initialize(Buffer.from('first'), secret);
  await vault.unlock(secret);
  const lock = path.join(root, 'credential-vault', '.operation.lock');
  const gone = spawn(process.execPath, ['-e', '0']);
  const deadPid = gone.pid;
  await new Promise(resolve => gone.once('exit', resolve));
  await fs.writeFile(lock, String(deadPid), { mode: 0o600 });
  const applied = await vault.update(Buffer.from('second'), (await vault.snapshot()).sha256);
  assert.equal(applied.verified, true, 'a stale lock no longer blocks the vault');
  await assert.rejects(fs.access(lock), 'the lock is removed again');
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  t.after(() => live.kill());
  await fs.writeFile(lock, String(live.pid), { mode: 0o600 });
  await assert.rejects(vault.update(Buffer.from('third'), (await vault.snapshot()).sha256), { code: 'VAULT_OPERATION_BUSY' });
  await fs.writeFile(lock, '', { mode: 0o600 });
  await assert.rejects(vault.update(Buffer.from('third'), (await vault.snapshot()).sha256), { code: 'VAULT_OPERATION_BUSY' }, 'a lock without an owner may be one being written');
  await fs.unlink(lock);
  vault.lock();
});

test('W-2: credential routes are recognised in any letter case', () => {
  for (const route of ['/API/Credentials/vault/unlock', '/api/instances/a/CREDENTIALS/rcon', '/Api/Remote-Hosts/h/Credentials', '/api/Remote-Instances/r/credentials/', '/api/instances/a/B3/Integration/Auth-Password']) assert.equal(isCredentialPath(route), true, route);
  assert.equal(isCredentialPath('/api/instances/a/config'), false);
});

test('S-1: the ready line is recognised on whole lines only, across chunk borders', () => {
  const { BACKEND_READY_LINE, createReadyWatcher } = backendReady;
  const watch = createReadyWatcher();
  assert.equal(watch('noise\nCOD4X_CONTROL_BACK'), false);
  assert.equal(watch('END_READY_x\n'), false, 'a longer line is not the ready line');
  const next = createReadyWatcher();
  assert.equal(next(`listening\n${BACKEND_READY_LINE.slice(0, 5)}`), false);
  assert.equal(next(`${BACKEND_READY_LINE.slice(5)}\r\n`), true);
  assert.equal(next('more'), true);
});

test('S-1: the desktop app waits for the ready line of its own backend, never for an answer on the port', async () => {
  const main = await read('electron-main.cjs');
  assert.doesNotMatch(main, /api\/installer\/health/, 'an HTTP answer on the port proves nothing');
  assert.doesNotMatch(main, /require\('http'\)/);
  assert.match(main, /server\.stdout\.on\('data',chunk=>\{log\.write\(chunk\);if\(!backendListening&&readyWatcher\(chunk\)\)backendListening=true;\}\);/);
  assert.match(main, /if\(backendListening\) return resolve\(true\);/);
  // issue #67: the backend is a utility process now ('exit' carries the code only)
  assert.match(main, /server\.on\('exit',code=>\{serverExited=true;backendListening=false;log\.close\(\);\n[^\n]*\n    if\(!app\.isQuitting && backendReady\)\{[^\n]*app\.quit\(\);\}\}\);/, 'any end of the backend closes the app');
});

test('S-1: the backend prints the ready line after listening and exits when its port is taken', { timeout: 60000 }, async t => {
  const api = await backend(t);
  assert.match(api.output(), new RegExp(`^${backendReady.BACKEND_READY_LINE}$`, 'm'));
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const root = await tempDir(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(blocker.address().port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off', COD4X_REMOTE: 'off' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 1, output);
  assert.match(output, /could not listen on 127\.0\.0\.1:\d+: EADDRINUSE/);
  assert.doesNotMatch(output, new RegExp(backendReady.BACKEND_READY_LINE));
});

test('W-3/S-2: a malformed body gets a fixed JSON answer, no stack trace, and the password is not logged', { timeout: 60000 }, async t => {
  const api = await backend(t);
  const secret = 'SuperSecretPass1-never-logged';
  for (const route of ['/api/auth/login', '/api/auth/init', '/api/alerts/settings']) {
    const response = await fetch(`${api.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"username":"admin","password":"${secret}"` });
    assert.equal(response.status, 400, route);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: false, code: 'REQUEST_INVALID', error: 'Request is invalid.' }, route);
    assert.doesNotMatch(text, /at |node_modules|installer-server/);
  }
  const large = await fetch(`${api.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y'.repeat(70 * 1024) }) });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).code, 'REQUEST_TOO_LARGE');
  // a mixed-case credential path still gets the credential handling (W-2)
  const mixed = await fetch(`${api.url}/API/Credentials/vault/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"passphrase":"${secret}"` });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.headers.get('cache-control'), 'no-store');
  assert.equal((await mixed.json()).code, 'CREDENTIAL_REQUEST_INVALID');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.doesNotMatch(api.output(), new RegExp(secret), 'no body in the backend log');
});

test('W-1: reading roles check the stored runtime only; probing chosen paths needs server.code', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const viewerPassword = password();
  assert.equal((await call('/api/users', { body: { username: 'watcher', password: viewerPassword, role: 'viewer' }, token: admin })).status, 201);
  const viewer = (await call('/api/auth/login', { body: { username: 'watcher', password: viewerPassword } })).json.token;
  for (const query of ['baseGamePath=%5C%5Cattacker%5Cshare', 'path=/etc', 'executablePath=/tmp/x/cod4x18_dedrun']) {
    const refused = await call(`/api/runtime/preflight?${query}`, { token: viewer });
    assert.equal(refused.status, 403, query);
    assert.equal(refused.json.permission, 'server.code');
  }
  assert.notEqual((await call('/api/runtime/preflight', { token: viewer })).status, 403, 'the stored runtime stays readable');
  assert.notEqual((await call('/api/runtime/preflight?path=.%2Fserver&executablePath=&baseGamePath=&platform=linux', { token: viewer })).status, 403, 'the page\'s own default fields are no choice of a path');
  assert.notEqual((await call('/api/runtime/preflight?baseGamePath=/tmp', { token: admin })).status, 403, 'the admin may probe paths');
});

test('W-4: the gateway write limit counts per forwarded client; failed logins do not lock the step-up', async t => {
  const users = { op: { username: 'op', role: 'operator', remoteAccess: true, totpEnabled: true } };
  const used = new Set();
  const dir = await tempDir(t);
  const userThrottle = new LoginThrottle({ maxFailures: 3 });
  const app = createRemoteGateway({
    login: async ({ username, password: given }) => given === 'correct-horse-battery' ? users[username] || null : null,
    verifySecondFactor: async (_user, code) => (/^\d{6}$/.test(code) && !used.has(code) ? (used.add(code), { ok: true, method: 'totp' }) : { ok: false }),
    hasPermission: (role, permission) => role === 'operator' && ['monitor.read', 'server.manage'].includes(permission),
    monitor: { overview: async () => ({ instances: [] }), history: async () => ({}), events: async () => ({ events: [] }) },
    sessions: new RemoteSessions(), throttle: new LoginThrottle(), userThrottle, writeLimit: 3, policy: () => ({ proxy: false }), staticDir: dir,
    actions: { allowed: () => true, players: async () => ({ players: [] }), say: async () => ({ said: true }), kick: async () => ({}), restart: async () => ({}), notify: () => {} },
  });
  const server = await listenRemoteGateway(app, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  const stranger = { 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 3; i++) assert.equal((await post('/remote/api/login', { username: 'op', password: 'wrong-password-123' }, stranger)).status, i < 2 ? 401 : 401);
  assert.equal((await post('/remote/api/logout', {}, stranger)).status, 429, 'the stranger used up their own limit');
  const login = await post('/remote/api/login', { username: 'op', password: 'correct-horse-battery', code: '100001' }, { 'X-Forwarded-For': '198.51.100.4' });
  assert.equal(login.status, 429, 'the per-user login brake (3 failures here) still holds');
  // the user's own client is not rate-limited by the stranger, and their step-up has its own brake
  userThrottle.succeed(LoginThrottle.key('remote-user', 'op'));
  const ok = await post('/remote/api/login', { username: 'op', password: 'correct-horse-battery', code: '100002' }, { 'X-Forwarded-For': '198.51.100.4' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 3; i++) await post('/remote/api/login', { username: 'op', password: 'wrong-password-123' }, { 'X-Forwarded-For': `203.0.113.${20 + i}` });
  const stepUp = await post('/remote/api/actions/step-up', { code: '100003' }, { cookie, 'X-Forwarded-For': '198.51.100.4' });
  assert.equal(stepUp.status, 200, 'failed logins of strangers do not lock the step-up');
});

test('W-6: the FPSAC download is always an attachment and listed with its real method', async () => {
  const server = await read('installer-server.mjs');
  assert.match(server, /routes: \["GET \/api\/fpschallenge\/anticheat\/download\/:version"\]/);
  assert.match(server, /"Content-Type":"application\/octet-stream","Content-Disposition":'attachment; filename="fpsac-9\.2\.0\.zip"',"X-Content-Type-Options":"nosniff"/);
  assert.doesNotMatch(server, /Zu viele Anfragen|Einrichtung abgelaufen/, 'backend texts are English');
  assert.match(server, /await downloadTo\(allowedArtifact\(\{url\}\), file, \{ maxBytes: FPSAC_MAX_BYTES, timeoutMs: FPSAC_TIMEOUT_MS \}\);\n    await verifyArtifact\(file, \{sha256\}\);\n    res\.status\(200\)/, 'checked before anything is sent');
});

test('W-6: without FPSAC_SHA256 the FPSAC download is refused before any request goes out', { timeout: 60000 }, async t => {
  const { call } = await backend(t, { FPSAC_URL: 'https://downloads.invalid/fpsac.zip' });
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const refused = await call('/api/fpschallenge/anticheat/download/9.2.0', { token: admin });
  assert.equal(refused.status, 503);
  assert.match(refused.json.error, /FPSAC_SHA256/);
});

test('I-2: player chat is never taken as the crash reason', async () => {
  const { diagnoseConsole } = await import('../lib/monitor-diagnose.mjs');
  assert.deepEqual(diagnoseConsole('Server running\nsay: Wolf: ERROR: fatal exception lol\n12:34 say;123;3;Wolf;assert this\n'), { reason: null, clean: false });
  assert.equal(diagnoseConsole('say: Wolf: hi\nERROR: Hunk_Alloc failed\n').reason, 'ERROR: Hunk_Alloc failed');
});

test('A5-14: the legacy RCON route refuses line breaks and control bytes', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  for (const command of ['status\nquit', 'status\rquit', 'say \u0000x']) {
    const refused = await call('/api/rcon/execute', { body: { host: '127.0.0.1', port: 9, password: 'secret12', command }, token: admin });
    assert.equal(refused.status, 400, JSON.stringify(command));
    assert.match(refused.json.error, /not allowed/);
  }
});

test('S-6 (Codex review): a stale-lock takeover never removes a live replacement', async t => {
  const { takeOverStaleLock } = await import('../lib/credential-vault-storage.mjs');
  const root = await tempDir(t);
  const lock = path.join(root, '.operation.lock');
  await fs.writeFile(lock, '999999', { mode: 0o600 });
  const stale = await fs.stat(lock);
  // Another process took the stale lock over first and holds a fresh one.
  await fs.unlink(lock);
  await fs.writeFile(lock, String(process.pid), { mode: 0o600 });
  assert.equal(await takeOverStaleLock(lock, stale, 999999), false, 'the replacement is not the lock judged stale');
  assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid), 'the live lock is back in place');
  assert.deepEqual((await fs.readdir(root)).sort(), ['.operation.lock'], 'nothing is left aside');
  await fs.writeFile(lock, '999999');
  assert.equal(await takeOverStaleLock(lock, await fs.stat(lock), 999999), true, 'the lock judged stale is removed');
  assert.deepEqual(await fs.readdir(root), []);
});

test('Codex review: the stored executable is no code change; the FPSAC download is bounded and single', () => {
  const server = readFileSync(new URL('../installer-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const runtimeBringsCode = body => choosesOtherPath\(body\.executablePath, defaultRuntime\.state\.executablePath\) \|\|/);
  assert.match(server, /await downloadTo\(allowedArtifact\(\{url\}\), file, \{ maxBytes: FPSAC_MAX_BYTES, timeoutMs: FPSAC_TIMEOUT_MS \}\);/);
  assert.match(server, /if \(fpsacDownloadBusy\) return res\.status\(429\)/);
  assert.match(server, /done\(maxBytes && received > maxBytes \? new Error/);
});

test('Codex review: the standard server rotates its game logs before a start as well', () => {
  const server = readFileSync(new URL('../installer-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /runtimeDependencies\.beforeLaunch = async \(\{ filesystemHomePath \}\) => \{[\s\S]{0,700}await rotateGameLogs\(path\.join\(filesystemHomePath, "main"\)\);/);
});
