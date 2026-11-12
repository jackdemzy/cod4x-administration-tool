import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Security audit 4.18.26: a real backend on a free port with an isolated data folder.
export const DESKTOP_TOKEN = crypto.randomBytes(32).toString('hex');
export const EVIL = 'https://evil.example';

const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};

export async function backend(t, extraEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-security-api-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off', COD4X_DESKTOP_CLIENT_TOKEN: DESKTOP_TOKEN, ...extraEnv });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/installer/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `backend did not become ready: ${diagnostics}`);
  const call = async (route, { body, method = body ? 'POST' : 'GET', token, headers = {} } = {}) => {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
  };
  return { url, port, call, root };
}

export const password = () => `${crypto.randomBytes(12).toString('hex')}Aa9!`;
