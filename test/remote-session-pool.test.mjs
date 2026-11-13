import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSessionPool } from '../lib/remote-session-pool.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// A fake connect that records every login and every close.
function fakeHosts() {
  const log = { connects: [], closes: [] };
  let next = 1;
  const connect = async hostId => {
    log.connects.push(hostId);
    await delay(5);
    const name = `${hostId}#${next++}`;
    return { session: { name, close: () => log.closes.push(name) }, uid: 1000, gid: 1000 };
  };
  return { log, connect };
}

test('two uses within idleMs connect once and see the same session', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 1000 });
  t.after(() => pool.closeAll());
  const first = await pool.use('lab-1', async ({ session, uid }) => { assert.equal(uid, 1000); return session.name; });
  const second = await pool.use('lab-1', async ({ session }) => session.name);
  assert.equal(first, second);
  assert.deepEqual(log.connects, ['lab-1']);
});

test('hosts get separate sessions', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 1000 });
  t.after(() => pool.closeAll());
  await pool.use('lab-1', async () => {}); await pool.use('lab-2', async () => {});
  assert.deepEqual(log.connects, ['lab-1', 'lab-2']);
});

test('an idle session is closed after idleMs and the next use connects again', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 40 });
  t.after(() => pool.closeAll());
  await pool.use('lab-1', async () => {});
  await delay(120);
  assert.deepEqual(log.closes, ['lab-1#1']);
  await pool.use('lab-1', async () => {});
  assert.deepEqual(log.connects, ['lab-1', 'lab-1']);
});

test('a session in use is not closed by the idle timer', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 30 });
  t.after(() => pool.closeAll());
  await pool.use('lab-1', async () => { await delay(100); });
  assert.deepEqual(log.closes, [], 'not closed while the action ran');
});

test('a transport error drops the session and the next use reconnects; other errors keep it', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 1000 });
  t.after(() => pool.closeAll());
  await assert.rejects(pool.use('lab-1', async () => { throw Object.assign(new Error('x'), { code: 'RCON_AUTH_FAILED' }); }), { code: 'RCON_AUTH_FAILED' });
  await pool.use('lab-1', async () => {});
  assert.deepEqual(log.connects, ['lab-1'], 'a non-transport error keeps the session');
  for (const code of ['REMOTE_CONNECT_FAILED', 'REMOTE_TIMEOUT', 'REMOTE_HOST_KEY_CHANGED', 'REMOTE_AUTH_FAILED']) {
    await assert.rejects(pool.use('lab-1', async () => { throw Object.assign(new Error('x'), { code }); }), { code });
  }
  await pool.use('lab-1', async () => {});
  assert.equal(log.connects.length, 5, 'every transport error forced a new connect');
  assert.equal(log.closes.length, 4, 'each dropped session was closed');
});

test('a failed connect is not cached', async t => {
  let calls = 0;
  const pool = new RemoteSessionPool({ connect: async () => { calls++; if (calls === 1) throw Object.assign(new Error('x'), { code: 'VAULT_LOCKED' }); return { session: { close() {} }, uid: 1, gid: 1 }; }, idleMs: 1000 });
  t.after(() => pool.closeAll());
  await assert.rejects(pool.use('lab-1', async () => {}), { code: 'VAULT_LOCKED' });
  await pool.use('lab-1', async () => {});
  assert.equal(calls, 2);
});

test('concurrent uses for one host share one connect', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 1000 });
  t.after(() => pool.closeAll());
  const names = await Promise.all([1, 2, 3].map(() => pool.use('lab-1', async ({ session }) => session.name)));
  assert.deepEqual(log.connects, ['lab-1']);
  assert.equal(new Set(names).size, 1);
});

test('closeAll closes every session and later uses connect again', async () => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 60_000 });
  await pool.use('lab-1', async () => {}); await pool.use('lab-2', async () => {});
  pool.closeAll();
  assert.deepEqual(log.closes.sort(), ['lab-1#1', 'lab-2#2']);
  await pool.use('lab-1', async () => {});
  assert.equal(log.connects.length, 3);
  pool.closeAll();
});

// Security audit 4.18.26 (A4-6): a host's session can be dropped at once (key changed or removed).
test('drop closes the pooled session of one host; the next use logs in again', async t => {
  const { log, connect } = fakeHosts();
  const pool = new RemoteSessionPool({ connect, idleMs: 60_000 });
  t.after(() => pool.closeAll());
  await pool.use('lab-1', async () => {});
  await pool.use('lab-2', async () => {});
  pool.drop('lab-1');
  assert.deepEqual(log.closes, ['lab-1#1']);
  pool.drop('unknown');
  await pool.use('lab-1', async () => {});
  assert.deepEqual(log.connects, ['lab-1', 'lab-2', 'lab-1']);
});

test('the server drops pooled SSH sessions on vault lock and on SSH key changes', async () => {
  const fs = await import('node:fs/promises');
  const server = await fs.readFile(new URL('../installer-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /onLock: \(\) => \{ try \{ remoteSessionPool\.closeAll\(\); \} catch \{\} \}/);
  assert.match(server, /registerRemoteLinuxRoutes\(\{[^)]*sessionPool: remoteSessionPool/);
  const routes = await fs.readFile(new URL('../lib/remote-linux-routes.mjs', import.meta.url), 'utf8');
  assert.equal((routes.match(/sessionPool\?\.drop\(req\.params\.id\)/g) || []).length, 2);
});
