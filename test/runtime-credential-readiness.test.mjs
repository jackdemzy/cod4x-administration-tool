import assert from 'node:assert/strict';
import { test } from 'node:test';
import dgram from 'node:dgram';

const module = await import('../lib/runtime-credential-readiness.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const secret = Buffer.from('Disposable-Readiness-123!');
const packet = text => Buffer.concat([Buffer.from([255,255,255,255]), Buffer.from(text)]);
async function fixture(t, behavior = {}) {
  assert.equal(typeof module.waitForCredentialRuntime, 'function', 'Runtime credential readiness must exist');
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const received = [];
  socket.on('message', (bytes, peer) => {
    const command = bytes.subarray(4).toString(); received.push(command);
    let text;
    if (command.startsWith('getinfo ')) {
      behavior.onInfo?.();
      text = `infoResponse\n\\challenge\\${behavior.wrongChallenge ? 'wrong' : command.slice(8)}\\pswrd\\${behavior.noJoin ? '0' : '1'}\\hostname\\fixture`;
    } else text = behavior.badRcon ? 'print\nBad rconpassword.\n' : 'print\nmap     : mp_backlot\nnum score ping guid name\n';
    if (!behavior.silent) socket.send(packet(text), peer.port, peer.address);
  });
  return { port: socket.address().port, received };
}
const options = port => ({ port, rcon: secret, joinRequired: true, signal: new AbortController().signal, timeoutMs: 500, attemptTimeoutMs: 100 });

test('readiness requires a fresh challenge, password flag and authenticated status, returning metadata only', async t => {
  const { port, received } = await fixture(t);
  const result = await module.waitForCredentialRuntime(options(port));
  assert.deepEqual(result, { rconAuthenticated: true, joinPasswordFlag: true, map: 'mp_backlot' });
  assert.equal(received.length, 2);
  assert.match(received[0], /^getinfo [a-f0-9]{24}$/);
  assert.equal(received[1], 'rcon Disposable-Readiness-123! status\n');
  assert.ok(!JSON.stringify(result).includes(secret.toString()));
});

test('wrong challenge, absent Join protection and bad RCON cannot report readiness', async t => {
  for (const behavior of [{ wrongChallenge: true }, { noJoin: true }, { badRcon: true }]) {
    const { port } = await fixture(t, behavior);
    await assert.rejects(module.waitForCredentialRuntime(options(port)), error => {
      assert.equal(error.code, 'CREDENTIAL_RUNTIME_READINESS_TIMEOUT');
      assert.ok(!String(error.stack).includes(secret.toString())); return true;
    });
  }
});

test('vault abort cancels an in-flight query and never sends RCON afterwards', async t => {
  const controller = new AbortController();
  const { port, received } = await fixture(t, { silent: true, onInfo: () => controller.abort() });
  await assert.rejects(module.waitForCredentialRuntime({ ...options(port), signal: controller.signal }), { code: 'CREDENTIAL_RUNTIME_ABORTED' });
  assert.equal(received.length, 1);
  assert.match(received[0], /^getinfo /);
});

test('invalid readiness inputs fail without opening a query', async t => {
  const { port, received } = await fixture(t);
  for (const change of [{ port: 80 }, { rcon: Buffer.from('bad";quit') }, { timeoutMs: 0 }, { joinRequired: 'yes' }]) {
    await assert.rejects(module.waitForCredentialRuntime({ ...options(port), ...change }), { code: 'CREDENTIAL_RUNTIME_READINESS_INVALID' });
  }
  assert.deepEqual(received, []);
});
