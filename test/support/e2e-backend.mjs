import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Block 22 (E2E): the real backend (installer-server.mjs) as a child process with an isolated
// data root, driven only through its public HTTP API. restart() keeps the data root, so state
// that must survive a backend restart is checked against the real persistence.
const SERVER = fileURLToPath(new URL('../../installer-server.mjs', import.meta.url));

const freeTcpPort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};

export async function e2eBackend(t, { prefix = 'cod4x-e2e-', extraEnv = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const port = await freeTcpPort();
  const url = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_DESKTOP_CLIENT_TOKEN: crypto.randomBytes(32).toString('hex'), ...extraEnv });
  const credentials = { username: 'e2eAdmin', password: `${crypto.randomBytes(16).toString('hex')}Aa9!` };
  const vaultPassphrase = `E2E vault ${crypto.randomBytes(12).toString('hex')}!`;
  const state = { child: null, closed: null, diagnostics: '', token: null };

  async function start() {
    state.diagnostics = '';
    state.child = spawn(process.execPath, [SERVER], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [state.child.stdout, state.child.stderr]) stream.on('data', chunk => { state.diagnostics = (state.diagnostics + chunk.toString()).slice(-8000); });
    state.child.once('error', () => {});
    state.closed = new Promise(resolve => state.child.once('close', resolve));
    for (let attempt = 0; attempt < 100 && state.child.exitCode === null; attempt++) {
      try { if ((await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      await delay(100);
    }
    assert.fail(`E2E backend did not become ready: ${state.diagnostics}`);
  }
  async function stop() {
    if (!state.child || state.child.exitCode !== null) return;
    state.child.kill('SIGTERM');
    const timer = setTimeout(() => state.child.kill('SIGKILL'), 5000);
    await state.closed;
    clearTimeout(timer);
  }

  async function request(route, body, method = body ? 'POST' : 'GET', { timeoutMs = 10000 } = {}) {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
  // The gate of Block 22: after every step CONTROL itself still answers.
  async function assertAlive(step) {
    assert.equal(state.child.exitCode, null, `CONTROL exited after "${step}": ${state.diagnostics}`);
    const response = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(3000) }).catch(error => ({ ok: false, status: error.message }));
    assert.ok(response.ok, `CONTROL did not answer after "${step}" (${response.status}): ${state.diagnostics}`);
  }
  async function login() {
    const response = await request('/api/auth/login', credentials);
    assert.equal(response.status, 200, `login failed: ${JSON.stringify(response.json)}`);
    state.token = response.json.token;
  }
  async function unlockVault() {
    const response = await request('/api/credentials/vault/unlock', { passphrase: vaultPassphrase });
    assert.equal(response.status, 200, `vault unlock failed: ${JSON.stringify(response.json)}`);
  }
  async function restart() {
    await stop();
    state.token = null;
    await start();
    await login();
    await unlockVault();
  }

  t.after(async () => {
    // Stop every instance through the API first, so no core outlives the test.
    if (state.child?.exitCode === null && state.token) {
      const listed = await request('/api/instances').catch(() => null);
      for (const instance of listed?.json?.instances || []) await request(`/api/instances/${encodeURIComponent(instance.id)}/stop`, {}).catch(() => {});
    }
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await start();
  const initialized = await request('/api/auth/init', credentials);
  assert.equal(initialized.status, 201, `admin init failed: ${JSON.stringify(initialized.json)}`);
  state.token = initialized.json.token;
  const vault = await request('/api/credentials/vault/initialize', { passphrase: vaultPassphrase });
  assert.equal(vault.status, 201, `vault init failed: ${JSON.stringify(vault.json)}`);
  return { root, url, request, assertAlive, restart, diagnostics: () => state.diagnostics, pid: () => state.child.pid };
}

// Structural base game fixture (main/*.iwd, zone/*.ff), like the runtime HTTP test.
export async function baseGameFixture(root) {
  const baseGame = path.join(root, 'game');
  await fs.mkdir(path.join(baseGame, 'main'), { recursive: true });
  await fs.mkdir(path.join(baseGame, 'zone', 'english'), { recursive: true });
  await fs.writeFile(path.join(baseGame, 'main', 'iw_00.iwd'), 'structural test fixture');
  await fs.writeFile(path.join(baseGame, 'zone', 'english', 'common_mp.ff'), 'structural test fixture');
  await fs.writeFile(path.join(baseGame, 'zone', 'localized.ff'), 'structural test fixture');
  return baseGame;
}

export async function consecutiveUdpPorts(count) {
  const dgram = await import('node:dgram');
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = 30000 + Math.floor(Math.random() * 20000);
    const sockets = [];
    try {
      for (let index = 0; index < count; index++) {
        const socket = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(first + index, '127.0.0.1', resolve); });
        sockets.push(socket);
      }
      return Array.from({ length: count }, (_, index) => first + index);
    } catch {} finally { for (const socket of sockets) socket.close(); }
  }
  throw new Error('no free consecutive UDP ports');
}
