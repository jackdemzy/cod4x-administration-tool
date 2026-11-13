import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildE2eCore, e2eCoreAvailable } from './support/e2e-core.mjs';
import { freeUdpPort } from './support/fake-cod4x-udp.mjs';
import { RconClient } from '../lib/rcon-client.mjs';

// Block 22 (E2E): the native test core answers like a dedicated server on its own port.
const skip = await e2eCoreAvailable();
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

async function ask(port, text, timeoutMs = 1000) {
  const socket = dgram.createSocket('udp4');
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs);
      socket.once('message', message => { clearTimeout(timer); resolve(message.subarray(4).toString('latin1')); });
      socket.send(Buffer.concat([OOB, Buffer.from(text, 'latin1')]), port, '127.0.0.1');
    });
  } finally { socket.close(); }
}
const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) if (await predicate()) return true; return false; };

test('E2E core: answers getinfo, rcon and joins on net_port with the +exec password, and frees the port when stopped', { skip: skip || false, timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-e2e-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = await buildE2eCore(path.join(root, 'core'));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, 'main'), { recursive: true });
  await fs.writeFile(path.join(home, 'main', 'launch.cfg'), 'set rcon_password "E2eCorePass123"\n');
  await fs.writeFile(path.join(home, 'main', 'server.cfg'), 'set sv_hostname "E2E Unit"\n');
  const port = await freeUdpPort();
  const child = spawn(core, ['+set', 'fs_homepath', home, '+set', 'net_port', String(port), '+exec', 'launch.cfg', '+exec', 'server.cfg', '+map', 'mp_crash'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await closed; });

  assert.ok(await until(async () => { try { return /infoResponse/.test(await ask(port, 'getinfo x', 300)); } catch { return false; } }), `core did not answer: ${stdout}`);
  assert.match(stdout, /execing launch\.cfg/);
  assert.doesNotMatch(stdout, /E2eCorePass123/);
  assert.match(await ask(port, 'getinfo abc'), /\\hostname\\E2E Unit\\mapname\\mp_crash/);
  const rcon = new RconClient({ port, timeoutMs: 1500 });
  assert.match(JSON.stringify(await rcon.execute(Buffer.from('E2eCorePass123'), 'serverinfo')), /E2E Unit/);
  await assert.rejects(rcon.execute(Buffer.from('wrong-password'), 'serverinfo'), { code: 'RCON_AUTH_FAILED' });
  assert.match(await ask(port, 'e2ejoin E2EPlayer'), /e2ejoinResponse/);
  assert.match(await ask(port, 'getstatus c'), /"E2EPlayer"/);
  assert.match(JSON.stringify(await rcon.execute(Buffer.from('E2eCorePass123'), 'status')), /E2EPlayer/);

  child.kill('SIGTERM');
  await closed;
  assert.ok(await until(async () => { try { await ask(port, 'getinfo y', 200); return false; } catch { return true; } }, 2000), 'responder outlived the core');
});

test('E2E core: a SIGKILLed core does not leave its responder behind', { skip: skip || false, timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-e2e-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = await buildE2eCore(path.join(root, 'core'));
  const port = await freeUdpPort();
  const child = spawn(core, ['+set', 'fs_homepath', root, '+set', 'net_port', String(port)], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  assert.ok(await until(async () => { try { return /infoResponse/.test(await ask(port, 'getinfo x', 300)); } catch { return false; } }));
  child.kill('SIGKILL');
  await closed;
  assert.ok(await until(async () => { try { await ask(port, 'getinfo y', 200); return false; } catch { return true; } }, 3000), 'responder outlived a crashed core');
});
