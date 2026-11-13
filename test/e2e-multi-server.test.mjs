import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildE2eCore, e2eCoreAvailable } from './support/e2e-core.mjs';
import { e2eBackend, baseGameFixture, consecutiveUdpPorts, createInstance, adoptCore, udpAsk, answers, silent, ok } from './support/e2e-backend.mjs';
import { RconClient } from '../lib/rcon-client.mjs';

// Block 22 (E2E): three servers through the real backend on three consecutive ports
// (roadmap: 28960/28961/28962), each with its own hostname and RCON password.
const skip = await e2eCoreAvailable();

test('E2E multi-server: three instances on consecutive ports stay isolated', { skip: skip || false, timeout: 120000 }, async t => {
  const backend = await e2eBackend(t, { prefix: 'cod4x-e2e-multi-' });
  const { request, assertAlive, root } = backend;
  const core = await buildE2eCore(path.join(root, 'cores', 'e2e'));
  const baseGame = await baseGameFixture(root);
  await adoptCore(backend, { core, baseGame });
  const ports = await consecutiveUdpPorts(3);
  const servers = ports.map((port, index) => ({ id: `multi-${index + 1}`, port, hostname: `E2E Multi ${index + 1}`, rcon: `E2eMultiRcon${index + 1}x${port}` }));
  const rcon = (server, password = server.rcon) => new RconClient({ port: server.port, timeoutMs: 1500 }).execute(Buffer.from(password), 'serverinfo');

  for (const server of servers) await createInstance(backend, { ...server, core, baseGame });
  await assertAlive('create three instances');
  for (const server of servers) ok(await request(`/api/instances/${server.id}/start`, {}), `start ${server.id}`);
  await assertAlive('start three instances');

  const pids = new Set();
  for (const server of servers) {
    assert.ok(await answers(server.port), `${server.id} does not answer on ${server.port}`);
    assert.match(await udpAsk(server.port, 'getinfo e2e'), new RegExp(`hostname\\\\${server.hostname}\\\\`), `${server.id} answers with another server's identity`);
    assert.match(JSON.stringify(await rcon(server)), new RegExp(server.hostname));
    for (const other of servers.filter(value => value !== server)) await assert.rejects(rcon(server, other.rcon), { code: 'RCON_AUTH_FAILED' }, `${server.id} accepted the password of ${other.id}`);
    const status = await request(`/api/instances/${server.id}`);
    ok(status, `status ${server.id}`);
    assert.equal(status.json.instance.port, server.port);
    pids.add(status.json.instance.runtime?.pid ?? status.json.instance.pid);
  }
  assert.equal(pids.size, 3, 'three different processes');

  const [first, second, third] = servers;
  ok(await request(`/api/instances/${second.id}/stop`, {}), 'stop multi-2');
  assert.ok(await silent(second.port), 'multi-2 still answers after its stop');
  assert.ok(await answers(first.port, 1000) && await answers(third.port, 1000), 'stopping multi-2 took a sibling down');
  await assertAlive('stop multi-2');

  ok(await request(`/api/instances/${second.id}/start`, {}), 'start multi-2 again');
  assert.ok(await answers(second.port), 'multi-2 does not come back on its own port');
  assert.match(JSON.stringify(await rcon(second)), /E2E Multi 2/);
  assert.ok(await answers(first.port, 1000) && await answers(third.port, 1000));
  await assertAlive('restart multi-2');
});
