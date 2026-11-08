import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteRconClient, createRemoteRconClientFactory } from '../lib/remote-rcon-client.mjs';
import { RconClient } from '../lib/rcon-client.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';
import { startFakeCod4xServer } from './support/fake-cod4x-udp.mjs';

const skip = (await loopbackAvailable()) ? false : 'needs Linux and a non-root user';
const PASSWORD = 'Sup3rSecretPw';

// A pool whose session runs the remote command on this machine (loopback) and records what was sent.
async function setup(t, fakeOptions = {}) {
  const loopback = await createLoopbackServer();
  const fake = await startFakeCod4xServer({ password: PASSWORD, ...fakeOptions });
  t.after(async () => { fake.close(); await loopback.cleanup(); });
  const stdins = [];
  const session = Object.create(loopback.session);
  session.exec = (command, options = {}) => { stdins.push(options.stdin); return loopback.session.exec(command, options); };
  const pool = { uses: [], async use(hostId, action) { this.uses.push(hostId); return action({ session, uid: 1000, gid: 1000 }); } };
  return { loopback, fake, pool, stdins, client: new RemoteRconClient({ pool, hostId: 'lab-1', port: fake.port }) };
}

test('execute returns the same text as the UDP client', { skip }, async t => {
  const { fake, client, pool } = await setup(t, { hostname: 'Same Text' });
  const remote = await client.execute(Buffer.from(PASSWORD), 'serverinfo');
  const local = await new RconClient({ port: fake.port }).execute(Buffer.from(PASSWORD), 'serverinfo');
  assert.equal(remote.text, local.text);
  assert.equal(remote.packets, local.packets);
  assert.ok(Number.isFinite(remote.latencyMs));
  assert.deepEqual(pool.uses, ['lab-1']);
});

test('a status reply split over several datagrams is joined', { skip }, async t => {
  const { client, fake } = await setup(t);
  const result = await client.execute(Buffer.from(PASSWORD), 'status');
  assert.ok(result.packets >= 2, `packets ${result.packets}`);
  assert.match(result.text, /Bot0[\s\S]*Bot23/);
  assert.deepEqual(fake.state.commands, ['status']);
});

test('a wrong password is RCON_AUTH_FAILED', { skip }, async t => {
  const { client } = await setup(t);
  await assert.rejects(client.execute(Buffer.from('WrongPassword1'), 'status'), { code: 'RCON_AUTH_FAILED' });
});

test('the packet buffer is wiped after the exchange and the password never reaches the command line', { skip }, async t => {
  const { client, stdins, loopback } = await setup(t);
  await client.execute(Buffer.from(PASSWORD), 'serverinfo');
  assert.equal(stdins.length, 1);
  assert.ok(stdins[0].every(byte => byte === 0), 'stdin packet zeroed');
  assert.ok(loopback.session.calls.every(command => !command.includes(PASSWORD)));
});

test('probe, queryStatus, say and kick work through the same exchange', { skip }, async t => {
  const { client } = await setup(t, { hostname: 'Probe Me', statusPlayers: [{ score: 1, ping: 20, name: 'Ann' }] });
  const probe = await client.probe();
  assert.equal(probe.reachable, true); assert.equal(probe.hostname, 'Probe Me');
  const status = await client.queryStatus();
  assert.equal(status.reachable, true); assert.equal(status.players.length, 1);
  await client.say(Buffer.from(PASSWORD), 'hello all');
  const kicked = await client.kick(Buffer.from(PASSWORD), 3, 'afk');
  assert.equal(typeof kicked.text, 'string');
});

test('exit codes map to fixed errors: 3 tool missing, 4 timeout, others socket failure', async () => {
  for (const [code, expected] of [[3, 'REMOTE_RCON_TOOL_MISSING'], [4, 'RCON_TIMEOUT'], [5, 'RCON_SOCKET_FAILED'], [-1, 'RCON_SOCKET_FAILED']]) {
    const pool = { async use(hostId, action) { return action({ session: { exec: async () => ({ code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) } }); } };
    await assert.rejects(new RemoteRconClient({ pool, hostId: 'lab-1', port: 28960 }).execute(Buffer.from(PASSWORD), 'status'), { code: expected });
  }
});

test('transport errors from the pool pass through unchanged', async () => {
  const pool = { async use() { throw Object.assign(new Error('x'), { code: 'VAULT_LOCKED' }); } };
  await assert.rejects(new RemoteRconClient({ pool, hostId: 'lab-1', port: 28960 }).execute(Buffer.from(PASSWORD), 'status'), { code: 'VAULT_LOCKED' });
});

test('a bad port or host id is refused like a bad UDP target', () => {
  const pool = { use() {} };
  for (const options of [{ hostId: 'lab-1', port: 80 }, { hostId: 'lab-1', port: '28960' }, { hostId: 'Bad Host', port: 28960 }]) {
    assert.throws(() => new RemoteRconClient({ pool, ...options }), { code: 'RCON_TARGET_INVALID' });
  }
});

test('the factory builds a client for the instance id and refuses a port that is not the instance port', () => {
  const instances = { get: id => { if (id !== 'srv-1') throw Object.assign(new Error('x'), { code: 'REMOTE_INSTANCE_NOT_FOUND' }); return { id, hostId: 'lab-2', port: 28961 }; } };
  const factory = createRemoteRconClientFactory({ pool: { use() {} }, instances });
  const client = factory({ instanceId: 'srv-1', host: '127.0.0.1', port: 28961, timeoutMs: 800 });
  assert.deepEqual(client.target, { hostId: 'lab-2', port: 28961 });
  assert.throws(() => factory({ instanceId: 'srv-1', port: 28960 }), { code: 'RCON_TARGET_INVALID' });
  assert.throws(() => factory({ instanceId: 'nope', port: 28961 }), { code: 'REMOTE_INSTANCE_NOT_FOUND' });
  assert.throws(() => factory({ port: 28961 }), { code: 'RCON_TARGET_INVALID' });
});
