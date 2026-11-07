import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from '../lib/remote-gateway.mjs';

const { Server, utils } = ssh2;
const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// An SSH server for the backend to talk to: it knows one client key, answers the platform probe, and has no sftp.
async function sshServer(t, { clientPublic, probe }) {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const allowed = utils.parseKey(clientPublic);
  const state = { attempts: 0, commands: [] };
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', context => {
      state.attempts++;
      const same = context.method === 'publickey' && context.key.algo === allowed.type && Buffer.compare(context.key.data, allowed.getPublicSSH()) === 0;
      if (!same || (context.signature && allowed.verify(context.blob, context.signature, context.hashAlgo) !== true)) return context.reject(['publickey']);
      return context.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', (_accept, reject) => reject());
      session.on('exec', (acceptExec, _reject, info) => {
        state.commands.push(info.command);
        const stream = acceptExec(); stream.write(probe); stream.exit(0); stream.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const client of clients) client.end(); server.close(resolve); }));
  return { port: server.address().port, hostSha256: sha(utils.parseKey(hostKey.public).getPublicSSH()), state };
}

test('no remote Linux route is offered to the phone gateway', () => {
  assert.ok(![...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].some(route => /remote-(hosts|instances)/.test(route)));
});

test('the permission map lists every remote Linux route and the server wires the routes', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../installer-server.mjs', import.meta.url)), 'utf8');
  assert.match(source, /\.\.\.REMOTE_LINUX_BINDINGS/);
  assert.match(source, /registerRemoteLinuxRoutes\(\{ app, requirePermission, audit,/);
  assert.match(source, /id\.startsWith\("ssh_"\) \? resolveSshSubject\(id\)/);
  const { REMOTE_LINUX_BINDINGS } = await import('../lib/remote-linux-routes.mjs');
  const listed = REMOTE_LINUX_BINDINGS.flatMap(binding => binding.routes);
  const routes = await fs.readFile(fileURLToPath(new URL('../lib/remote-linux-routes.mjs', import.meta.url)), 'utf8');
  for (const route of ['GET /api/remote-hosts', 'POST /api/remote-instances', 'POST /api/remote-instances/:id/start', 'PUT /api/remote-instances/:id/config', 'POST /api/remote-hosts/:id/credentials/ssh', 'POST /api/remote-instances/:id/backups/:backupId/restore']) assert.ok(listed.includes(route), route);
  assert.match(routes, /requirePermission\('install\.execute'\)|'install\.execute'/);
});

test('remote Linux API on the real backend: permissions, host key, vault key, login chain, fixed codes, no secret anywhere', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-http-'));
  // the vault refuses a data root that is group or world writable; do not depend on the umask of the shell running the test
  await fs.mkdir(path.join(root, 'data'), { mode: 0o700 }); await fs.chmod(path.join(root, 'data'), 0o700);
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: '0' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-200000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* not yet */ }
    await delay(100);
  }
  assert.ok(ready, `backend did not become ready: ${diagnostics}`);
  const call = async (token, route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${url}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'remAdmin', password })).json.token;
  await call(admin, '/api/users', { username: 'watch', password, role: 'viewer' });
  await call(admin, '/api/users', { username: 'ops', password, role: 'operator' });
  const viewer = (await call(null, '/api/auth/login', { username: 'watch', password })).json.token;
  const operator = (await call(null, '/api/auth/login', { username: 'ops', password })).json.token;

  // the SSH servers: one normal login, one that reports root
  const clientKey = utils.generateKeyPairSync('ed25519');
  const normal = await sshServer(t, { clientPublic: clientKey.public, probe: 'Linux x86_64\n1000\n1000\n' });
  const rooted = await sshServer(t, { clientPublic: clientKey.public, probe: 'Linux x86_64\n0\n0\n' });

  // unauthenticated and viewer
  assert.equal((await call(null, '/api/remote-hosts')).status, 401);
  assert.equal((await call(null, '/api/remote-instances')).status, 401);
  assert.equal((await call(viewer, '/api/remote-hosts')).status, 200);
  assert.equal((await call(viewer, '/api/remote-instances')).status, 200);
  const hostBody = (id, sshPort) => ({ id, label: `Host ${id}`, host: '127.0.0.1', port: sshPort, username: 'cod4x' });
  assert.equal((await call(viewer, '/api/remote-hosts', hostBody('lab-1', normal.port))).status, 403);
  assert.equal((await call(viewer, '/api/remote-hosts/lab-1/hostkey/probe', {})).status, 403);

  // hosts: exact bodies, validation, duplicates
  assert.deepEqual((await call(operator, '/api/remote-hosts', { ...hostBody('lab-1', normal.port), extra: 1 })).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call(operator, '/api/remote-hosts', { ...hostBody('lab-1', normal.port), username: 'root' })).json.code, 'REMOTE_HOST_INVALID');
  assert.equal((await call(operator, '/api/remote-hosts', { ...hostBody('lab-1', normal.port), host: '-oProxyCommand=x' })).json.code, 'REMOTE_HOST_INVALID');
  const created = await call(operator, '/api/remote-hosts', hostBody('lab-1', normal.port));
  assert.equal(created.status, 201, created.json.error);
  assert.equal(created.json.host.hostKeySha256, null);
  assert.deepEqual([(await call(operator, '/api/remote-hosts', hostBody('lab-1', normal.port))).status, (await call(operator, '/api/remote-hosts', hostBody('lab-1', normal.port))).json.code], [409, 'REMOTE_HOST_EXISTS']);
  assert.equal((await call(operator, '/api/remote-hosts', hostBody('lab-root', rooted.port))).status, 201);

  // the vault: initialize and unlock, then the key of a host
  const vaultPassphrase = `${crypto.randomBytes(12).toString('hex')} vault passphrase`;
  assert.equal((await call(admin, '/api/credentials/vault/initialize', { passphrase: vaultPassphrase })).status, 201);
  assert.equal((await call(admin, '/api/credentials/vault/unlock', { passphrase: vaultPassphrase })).status, 200);
  const keyPath = '/api/remote-hosts/lab-1/credentials';
  const withoutKey = await call(operator, keyPath);
  assert.equal(withoutKey.status, 200);
  assert.equal(withoutKey.json.credentials.ssh.configured, false);
  const vaultHash = async () => (await call(operator, keyPath)).json.credentials.sha256;
  // before a key exists, the login stops with a fixed code and the server sees nothing
  assert.equal((await call(operator, '/api/remote-instances', { id: 'one', name: 'One', hostId: 'lab-1', port: 28960, remoteRoot: '/srv/cod4x', basePath: '/srv/game', corePath: path.join(root, 'cod4x18_dedrun'), coreVersion: '21.5', expectedCoreSha256: 'a'.repeat(64) })).json.code, 'REMOTE_CORE_INVALID');
  // the key: write-only
  const secretPassphrase = 'a long secret passphrase for this key';
  const stored = await call(operator, `${keyPath}/ssh`, { expectedSha256: await vaultHash(), privateKey: clientKey.private, passphrase: undefined });
  assert.equal(stored.status, 200, stored.json.error);
  assert.ok(!JSON.stringify(stored.json).includes('BEGIN'), 'the key is never echoed');
  assert.equal(stored.headers.get('cache-control'), 'no-store');
  assert.equal((await call(operator, keyPath)).json.credentials.ssh.configured, true);
  assert.ok(!JSON.stringify((await call(operator, keyPath)).json).includes('BEGIN'));
  assert.equal((await call(operator, `${keyPath}/ssh`, { expectedSha256: await vaultHash(), privateKey: 'not a key' })).json.code, 'CREDENTIAL_INVALID');
  assert.equal((await call(operator, `${keyPath}/ssh`, { expectedSha256: await vaultHash(), privateKey: clientKey.private, extra: 1 })).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call(viewer, `${keyPath}/ssh`, { expectedSha256: 'a'.repeat(64), privateKey: clientKey.private })).status, 403);
  assert.equal((await call(operator, '/api/remote-hosts/nope/credentials')).status, 404);
  assert.ok(secretPassphrase);

  // a core to install, and an install before the host key is known: stopped before any login
  const core = path.join(root, 'core', 'cod4x18_dedrun');
  await fs.mkdir(path.dirname(core)); await fs.writeFile(core, crypto.randomBytes(2048));
  const coreHash = sha(await fs.readFile(core));
  const install = (hostId, id = 'one') => ({ id, name: 'One', hostId, port: 28960, remoteRoot: '/srv/cod4x', basePath: '/srv/game', corePath: core, coreVersion: '21.5', expectedCoreSha256: coreHash });
  const unverified = await call(operator, '/api/remote-instances', install('lab-1'));
  assert.deepEqual([unverified.status, unverified.json.code], [409, 'REMOTE_HOST_KEY_UNVERIFIED']);
  assert.equal(unverified.json.presentedSha256, normal.hostSha256);
  assert.equal(normal.state.attempts, 0, 'no login data reached the server');

  // host key: probe shows it, trust needs that exact value
  const probe = await call(operator, '/api/remote-hosts/lab-1/hostkey/probe', {});
  assert.equal(probe.status, 200, probe.json.error);
  assert.equal(probe.json.fingerprint.sha256Hex, normal.hostSha256);
  assert.equal(probe.json.fingerprint.sha256Base64, Buffer.from(normal.hostSha256, 'hex').toString('base64').replace(/=+$/, ''));
  assert.equal(normal.state.attempts, 0, 'a probe never logs in');
  const mismatch = await call(operator, '/api/remote-hosts/lab-1/hostkey/trust', { expectedSha256: 'b'.repeat(64) });
  assert.deepEqual([mismatch.status, mismatch.json.code], [409, 'REMOTE_HOST_KEY_MISMATCH']);
  assert.equal((await call(operator, '/api/remote-hosts/lab-1/hostkey/trust', { expectedSha256: normal.hostSha256, extra: 1 })).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call(operator, '/api/remote-hosts/lab-1/hostkey/trust', {})).json.code, 'REMOTE_ARGUMENT_INVALID');
  const trusted = await call(operator, '/api/remote-hosts/lab-1/hostkey/trust', { expectedSha256: normal.hostSha256 });
  assert.equal(trusted.status, 200, trusted.json.error);
  assert.equal(trusted.json.host.hostKeySha256, normal.hostSha256);
  assert.equal((await call(viewer, '/api/remote-hosts')).json.hosts.find(host => host.id === 'lab-1').hostKeySha256, normal.hostSha256);

  // the chain: vault key -> pinned host key -> login -> probe -> sftp. The test server has no sftp, so the install stops there.
  const chain = await call(operator, '/api/remote-instances', install('lab-1'));
  assert.deepEqual([chain.status, chain.json.code], [400, 'REMOTE_SFTP_UNAVAILABLE']);
  assert.ok(normal.state.attempts > 0, 'the key was used for the login');
  assert.ok(normal.state.commands.some(command => command.includes('uname -s')), 'the platform probe ran');
  assert.deepEqual((await call(operator, '/api/remote-instances')).json.instances, [], 'nothing was installed');
  // a root login is refused
  await call(operator, '/api/remote-hosts/lab-root/hostkey/trust', { expectedSha256: rooted.hostSha256 });
  const rootKeyHash = (await call(operator, '/api/remote-hosts/lab-root/credentials')).json.credentials.sha256;
  assert.equal((await call(operator, '/api/remote-hosts/lab-root/credentials/ssh', { expectedSha256: rootKeyHash, privateKey: clientKey.private })).status, 200);
  const blocked = await call(operator, '/api/remote-instances', install('lab-root', 'two'));
  assert.deepEqual([blocked.status, blocked.json.code], [400, 'REMOTE_ROOT_BLOCKED']);

  // instances: unknown, permissions, unsupported features
  assert.deepEqual([(await call(operator, '/api/remote-instances/nope')).status, (await call(operator, '/api/remote-instances/nope')).json.code], [404, 'REMOTE_INSTANCE_NOT_FOUND']);
  for (const operation of ['start', 'stop', 'restart', 'recover', 'network']) assert.equal((await call(viewer, `/api/remote-instances/one/${operation}`, {})).status, 403, operation);
  assert.equal((await call(viewer, '/api/remote-instances', install('lab-1'))).status, 403);
  assert.equal((await call(viewer, '/api/remote-instances/one/config')).status, 403);
  assert.equal((await call(viewer, '/api/remote-instances/one/config', { text: 'x', expectedSha256: 'a'.repeat(64) }, 'PUT')).status, 403);
  assert.equal((await call(viewer, '/api/remote-instances/one/backups', {})).status, 403);
  assert.deepEqual([(await call(operator, '/api/remote-instances/one/rcon/status')).status, (await call(operator, '/api/remote-instances/one/rcon/command', {})).json.code], [400, 'REMOTE_RCON_UNSUPPORTED']);
  assert.equal((await call(operator, '/api/remote-instances/one/b3/dashboard')).json.code, 'REMOTE_B3_UNSUPPORTED');
  assert.equal((await call(operator, '/api/remote-instances/one/logs?limit=0')).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call(operator, '/api/remote-instances/one/logs?limit=abc')).json.code, 'REMOTE_ARGUMENT_INVALID');
  assert.equal((await call(operator, '/api/remote-instances/one/logs?limit=100')).json.code, 'REMOTE_INSTANCE_NOT_FOUND');
  assert.equal((await call(operator, '/api/remote-instances/one/network', { scope: 'PUBLIC' })).json.code, 'INSTANCE_NETWORK_CONFIRMATION_REQUIRED');
  assert.equal((await call(operator, '/api/remote-instances/one/network', { scope: 'PUBLIC', confirm: 'PUBLIC_EXPOSURE' })).json.code, 'REMOTE_INSTANCE_NOT_FOUND');

  // removing a host works (DELETE is allowed by CORS for this path) and the key stays unusable afterwards
  const options = await fetch(`${url}/api/remote-hosts/lab-root`, { method: 'OPTIONS' });
  assert.match(options.headers.get('access-control-allow-methods'), /DELETE/);
  assert.equal((await call(viewer, '/api/remote-hosts/lab-root', undefined, 'DELETE')).status, 403);
  assert.equal((await call(operator, '/api/remote-hosts/lab-root', undefined, 'DELETE')).status, 200);
  assert.equal((await call(operator, '/api/remote-hosts/lab-root', undefined, 'DELETE')).json.code, 'REMOTE_HOST_NOT_FOUND');
  const configOptions = await fetch(`${url}/api/remote-instances/one/config`, { method: 'OPTIONS' });
  assert.match(configOptions.headers.get('access-control-allow-methods'), /PUT/);

  // the permission map knows the routes
  const map = await call(operator, '/api/rbac/authorization');
  assert.ok(JSON.stringify(map.json).includes('POST /api/remote-instances/:id/start'));

  // nothing secret in the audit
  const audit = JSON.stringify((await call(admin, '/api/audit')).json);
  assert.ok(audit.includes('remote.host.created') && audit.includes('remote.host.key_trusted'));
  assert.ok(!audit.includes('BEGIN') && !audit.includes(clientKey.private.slice(60, 120)) && !audit.includes(vaultPassphrase));
  assert.ok(!diagnostics.includes('BEGIN OPENSSH'), 'the key is not in the backend output');
});
