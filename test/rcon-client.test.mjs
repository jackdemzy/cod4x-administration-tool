import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { RconClient } from '../lib/rcon-client.mjs';
import { startFakeCod4xServer, freeUdpPort } from './support/fake-cod4x-udp.mjs';

// Real loopback UDP against a protocol test double, not against cod4x18_dedrun.
const password = 'Client-Rcon-123';

test('client only targets loopback ports CONTROL owns', () => {
  assert.throws(() => new RconClient({ host: '192.0.2.1', port: 28960 }), { code: 'RCON_TARGET_INVALID' });
  assert.throws(() => new RconClient({ port: 80 }), { code: 'RCON_TARGET_INVALID' });
});

test('health probe, authenticated command and multi-packet response over UDP', async t => {
  const server = await startFakeCod4xServer({ password, hostname: 'Probe Host', mapname: 'mp_crash' });
  t.after(server.close);
  const client = new RconClient({ port: server.port });
  const health = await client.probe();
  assert.deepEqual([health.reachable, health.hostname, health.mapname, health.maxClients], [true, 'Probe Host', 'mp_crash', 18]);
  const secret = Buffer.from(password);
  const status = await client.execute(secret, 'status');
  assert.ok(status.packets > 1, 'status output exceeds the 1024 byte redirect buffer');
  assert.match(status.text, /^map: mp_crash\n/);
  assert.equal((status.text.match(/Bot\d+/g) || []).length, 24, 'all chunks are reassembled in order');
  assert.equal(secret.toString(), password, 'client does not own or wipe the caller buffer');
  assert.deepEqual(server.state.commands, ['status']);
  assert.ok(server.state.rawPackets.some(packet => packet.includes(Buffer.from(`rcon ${password} status`))));
});

test('wrong password, deny rate limit and silence map to fixed codes', async t => {
  const server = await startFakeCod4xServer({ password });
  t.after(server.close);
  const client = new RconClient({ port: server.port, timeoutMs: 400, idleMs: 10 });
  await assert.rejects(client.execute(Buffer.from('Wrong-Rcon-123'), 'status'), { code: 'RCON_AUTH_FAILED' });
  // CoD4x answers only one deny per 100 ms; the second attempt sees silence.
  await assert.rejects(client.execute(Buffer.from('Wrong-Rcon-123'), 'status'), { code: 'RCON_TIMEOUT' });
  const closed = await freeUdpPort();
  await assert.rejects(new RconClient({ port: closed, timeoutMs: 300 }).probe(), error => ['RCON_TIMEOUT', 'RCON_SOCKET_FAILED'].includes(error.code));
});

test('a core started without rcon_password denies every request', async t => {
  // strcmp happens before the 8 character gate, so an unprovisioned core says "Bad rcon".
  const server = await startFakeCod4xServer({ password: '' });
  t.after(server.close);
  await assert.rejects(new RconClient({ port: server.port }).execute(Buffer.from(password), 'status'), { code: 'RCON_AUTH_FAILED' });
  assert.deepEqual(server.state.commands, []);
});

test('responses from a foreign source port are ignored', async t => {
  const server = await startFakeCod4xServer({ password, silent: true });
  const spoofer = dgram.createSocket('udp4');
  await new Promise(resolve => spoofer.bind(0, '127.0.0.1', resolve));
  t.after(async () => { await server.close(); await new Promise(resolve => spoofer.close(resolve)); });
  let clientSocket;
  const client = new RconClient({ port: server.port, timeoutMs: 400, createSocket: () => (clientSocket = dgram.createSocket('udp4')) });
  const pending = client.execute(Buffer.from(password), 'status');
  await new Promise(resolve => { const wait = () => { try { clientSocket.address(); resolve(); } catch { setTimeout(wait, 5); } }; wait(); });
  spoofer.send(Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from('print\nspoofed')]), clientSocket.address().port, '127.0.0.1');
  await assert.rejects(pending, { code: 'RCON_TIMEOUT' });
});
