import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { openSession, probeHostKey } from '../lib/ssh-transport.mjs';

const { Server, utils } = ssh2;
const sha256Hex = blob => crypto.createHash('sha256').update(blob).digest('hex');
const generate = () => utils.generateKeyPairSync('ed25519');

// In-process SSH server: counts authentication attempts, accepts one client key,
// and offers a handful of fixed "commands" over exec.
async function startServer(t, { clientPublic, hostKey = generate(), sftp = false } = {}) {
  const allowed = utils.parseKey(clientPublic);
  let attempts = 0;
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => {
      attempts++;
      if (context.method !== 'publickey') return context.reject(['publickey']);
      const sameKey = context.key.algo === allowed.type && Buffer.compare(context.key.data, allowed.getPublicSSH()) === 0;
      if (!sameKey || (context.signature && allowed.verify(context.blob, context.signature, context.hashAlgo) !== true)) return context.reject(['publickey']);
      context.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', (acceptSftp, rejectSftp) => (sftp ? acceptSftp() : rejectSftp()));
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        switch (info.command) {
          case 'echo hi': stream.write('hi\n'); stream.exit(0); stream.end(); break;
          case 'fail': stream.stderr.write('bad\n'); stream.exit(3); stream.end(); break;
          case 'big': stream.write(Buffer.alloc(1024 * 1024, 0x61)); stream.exit(0); stream.end(); break;
          case 'hang': break; // never finishes
          default: stream.stderr.write(`unknown command: ${info.command}\n`); stream.exit(127); stream.end();
        }
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // close open connections first, otherwise server.close() waits for them forever
  t.after(() => new Promise(resolve => { for (const client of clients) client.end(); server.close(resolve); }));
  return { port: server.address().port, attempts: () => attempts, hostSha256: sha256Hex(utils.parseKey(hostKey.public).getPublicSSH()) };
}

const hostFor = (server, hostKeySha256 = null) => ({ id: 'lab-1', label: 'Lab', host: '127.0.0.1', port: server.port, username: 'cod4x', hostKeySha256, createdAt: 'x' });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

test('an unpinned host is refused before authentication and reports the presented fingerprint', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  await assert.rejects(openSession({ host: hostFor(server), privateKey: Buffer.from(client.private) }), error => {
    assert.equal(error.code, 'REMOTE_HOST_KEY_UNVERIFIED');
    assert.equal(error.presentedSha256, server.hostSha256);
    return true;
  });
  assert.equal(server.attempts(), 0, 'no authentication attempt reached the server');
});

test('a pinned host with the matching key connects and runs a command', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  const session = await openSession({ host: hostFor(server, server.hostSha256), privateKey: Buffer.from(client.private) });
  t.after(() => session.close());
  assert.equal(session.hostKeySha256, server.hostSha256);
  const result = await session.exec('echo hi');
  assert.deepEqual([result.code, result.stdout.toString(), result.truncated], [0, 'hi\n', false]);
  const failed = await session.exec('fail');
  assert.deepEqual([failed.code, failed.stderr.toString()], [3, 'bad\n']);
  assert.equal(server.attempts() > 0, true);
});

test('a changed host key is a hard stop with zero authentication attempts', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  const pinned = 'c'.repeat(64);
  await assert.rejects(openSession({ host: hostFor(server, pinned), privateKey: Buffer.from(client.private) }), error => {
    assert.equal(error.code, 'REMOTE_HOST_KEY_CHANGED');
    assert.equal(error.presentedSha256, server.hostSha256);
    assert.equal(error.pinnedSha256, pinned);
    return true;
  });
  assert.equal(server.attempts(), 0);
});

test('a client key the server does not know fails with REMOTE_AUTH_FAILED', async t => {
  const known = generate(), other = generate();
  const server = await startServer(t, { clientPublic: known.public });
  await rejects(openSession({ host: hostFor(server, server.hostSha256), privateKey: Buffer.from(other.private) }), 'REMOTE_AUTH_FAILED');
});

test('an unreachable host fails with REMOTE_CONNECT_FAILED', async () => {
  const client = generate();
  const host = { id: 'lab-1', label: 'Lab', host: '127.0.0.1', port: 1, username: 'cod4x', hostKeySha256: 'a'.repeat(64), createdAt: 'x' };
  await rejects(openSession({ host, privateKey: Buffer.from(client.private), readyTimeoutMs: 2000 }), 'REMOTE_CONNECT_FAILED');
});

test('probeHostKey returns the pinned-form hash in both notations and makes no authentication attempt', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  const probe = await probeHostKey(hostFor(server));
  assert.equal(probe.sha256Hex, server.hostSha256);
  assert.equal(probe.sha256Base64, Buffer.from(server.hostSha256, 'hex').toString('base64').replace(/=+$/, ''));
  assert.equal(server.attempts(), 0);
  // the same probe on a host that already has a pinned key still only reports and never authenticates
  assert.equal((await probeHostKey(hostFor(server, 'd'.repeat(64)))).sha256Hex, server.hostSha256);
  assert.equal(server.attempts(), 0);
});

test('exec output is bounded and flagged truncated', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  const session = await openSession({ host: hostFor(server, server.hostSha256), privateKey: Buffer.from(client.private) });
  t.after(() => session.close());
  const result = await session.exec('big', { maxBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length + result.stderr.length <= 1000, `kept ${result.stdout.length + result.stderr.length} bytes`);
  // the session is still usable afterwards
  assert.equal((await session.exec('echo hi')).stdout.toString(), 'hi\n');
});

test('an exec that never finishes is cut off with REMOTE_TIMEOUT', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public });
  const session = await openSession({ host: hostFor(server, server.hostSha256), privateKey: Buffer.from(client.private) });
  t.after(() => session.close());
  await rejects(session.exec('hang', { timeoutMs: 200 }), 'REMOTE_TIMEOUT');
});

test('a server without an sftp subsystem gives REMOTE_SFTP_UNAVAILABLE', async t => {
  const client = generate();
  const server = await startServer(t, { clientPublic: client.public, sftp: false });
  const session = await openSession({ host: hostFor(server, server.hostSha256), privateKey: Buffer.from(client.private) });
  t.after(() => session.close());
  await rejects(session.sftp(), 'REMOTE_SFTP_UNAVAILABLE');
});

test('the module offers no password, agent or keyboard-interactive path', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/ssh-transport.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['password:', 'agent:', 'tryKeyboard', 'agentForward']) assert.ok(!source.includes(forbidden), forbidden);
});
