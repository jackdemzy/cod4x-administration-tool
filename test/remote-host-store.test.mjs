import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteHostStore } from '../lib/remote-host-store.mjs';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const input = overrides => ({ id: 'lab-1', label: 'Lab server', host: 'lab.example.org', port: 22, username: 'cod4x', ...overrides });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-hosts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config', 'remote-hosts.json');
  const store = new RemoteHostStore({ file, ...options });
  await store.load();
  return { store, file, reopen: async () => { const next = new RemoteHostStore({ file, ...options }); await next.load(); return next; } };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

test('creates and lists a host; the new host has no pinned key', async t => {
  const { store } = await fixture(t);
  const host = await store.create(input());
  assert.equal(host.hostKeySha256, null);
  assert.match(host.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(store.list().map(entry => entry.id), ['lab-1']);
  assert.equal(store.get('lab-1').host, 'lab.example.org');
  // results are copies
  store.list()[0].host = 'changed.example.org';
  assert.equal(store.get('lab-1').host, 'lab.example.org');
  await rejects(Promise.resolve().then(() => store.get('nope')), 'REMOTE_HOST_NOT_FOUND');
});

test('refuses root, bad port, bad host name, bad id, bad label and duplicate id', async t => {
  const { store } = await fixture(t);
  for (const bad of [{ username: 'root' }, { port: 0 }, { port: 70000 }, { port: 22.5 }, { port: '22' }, { host: '-oProxyCommand=x' }, { host: 'a b' },
    { id: 'Bad Id' }, { id: '' }, { label: '' }, { label: 'x'.repeat(81) }, { label: 'a\nb' }, { username: 'a;b' }, { extra: 'field' }]) {
    await rejects(store.create(input(bad)), 'REMOTE_HOST_INVALID');
  }
  assert.equal(store.list().length, 0);
  await store.create(input());
  await rejects(store.create(input({ host: 'other.example.org' })), 'REMOTE_HOST_EXISTS');
});

test('two creates of the same id at the same moment: exactly one wins', async t => {
  const { store } = await fixture(t);
  const outcomes = await Promise.allSettled([store.create(input()), store.create(input({ host: 'other.example.org' }))]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(store.list().length, 1);
});

test('pins a key once; the same value is accepted again, a different one is refused', async t => {
  const { store } = await fixture(t);
  await store.create(input());
  const pinned = await store.pinHostKey('lab-1', HEX_A);
  assert.equal(pinned.hostKeySha256, HEX_A);
  await store.pinHostKey('lab-1', HEX_A);
  await rejects(store.pinHostKey('lab-1', HEX_B), 'REMOTE_HOST_KEY_CHANGED');
  assert.equal(store.get('lab-1').hostKeySha256, HEX_A);
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null, 5]) {
    const { store: fresh } = await fixture(t);
    await fresh.create(input());
    await rejects(fresh.pinHostKey('lab-1', bad), 'REMOTE_HOST_INVALID');
  }
  await rejects(store.pinHostKey('missing', HEX_A), 'REMOTE_HOST_NOT_FOUND');
});

test('survives a restart and the file is private', async t => {
  const { store, file, reopen } = await fixture(t);
  await store.create(input());
  await store.pinHostKey('lab-1', HEX_A);
  const again = await reopen();
  assert.deepEqual(again.get('lab-1').hostKeySha256, HEX_A);
  if (process.platform === 'linux') assert.equal((await fs.stat(file)).mode & 0o077, 0);
  const text = await fs.readFile(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'hosts']);
  assert.ok(!(await fs.readdir(path.dirname(file))).some(name => name.includes('.tmp-')), 'no temp file left behind');
});

test('a corrupt file fails closed: load rejects, nothing is written, the file is not replaced', async t => {
  const { file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const bad of ['{ not json', JSON.stringify({ version: 2, hosts: [] }), JSON.stringify({ version: 1, hosts: 'x' }),
    JSON.stringify({ version: 1, hosts: [{ id: 'lab-1', label: 'x', host: 'a.example.org', port: 22, username: 'root', hostKeySha256: null, createdAt: 'x' }] }),
    JSON.stringify({ version: 1, hosts: [input({ hostKeySha256: null, createdAt: 'x' }), input({ hostKeySha256: null, createdAt: 'x' })] })]) {
    await fs.writeFile(file, bad);
    const broken = new RemoteHostStore({ file });
    await rejects(broken.load(), 'REMOTE_HOST_STORE_INVALID');
    await rejects(broken.create(input({ id: 'other' })), 'REMOTE_HOST_STORE_INVALID');
    assert.equal(await fs.readFile(file, 'utf8'), bad);
  }
});

test('remove is refused while the host is in use and works afterwards', async t => {
  let used = true;
  const { store } = await fixture(t, { inUse: id => used && id === 'lab-1' });
  await store.create(input());
  await rejects(store.remove('lab-1'), 'REMOTE_HOST_IN_USE');
  assert.equal(store.list().length, 1);
  used = false;
  await store.remove('lab-1');
  assert.equal(store.list().length, 0);
  await rejects(store.remove('lab-1'), 'REMOTE_HOST_NOT_FOUND');
});

// ---- Block 19: docker entry --------------------------------------------------------------------------------
test('a host starts without a docker confirmation; setDocker stores and withdraws it', async t => {
  const { store, reopen } = await fixture(t);
  assert.equal((await store.create(input())).docker, null);
  const confirmed = await store.setDocker('lab-1', { mode: 'ROOTFUL', confirmedAt: '2026-11-09T10:00:00.000Z' });
  assert.deepEqual(confirmed.docker, { mode: 'ROOTFUL', confirmedAt: '2026-11-09T10:00:00.000Z' });
  assert.deepEqual((await reopen()).get('lab-1').docker, confirmed.docker);
  assert.equal((await store.setDocker('lab-1', null)).docker, null);
  await rejects(store.setDocker('nope', null), 'REMOTE_HOST_NOT_FOUND');
});

test('an invalid docker entry is refused, also in a stored file; a file without the key loads as not confirmed', async t => {
  const { store, file, reopen } = await fixture(t);
  await store.create(input());
  for (const bad of [{ mode: 'ROOT', confirmedAt: '2026-11-09T10:00:00.000Z' }, { mode: 'NO_DOCKER', confirmedAt: '2026-11-09T10:00:00.000Z' }, { mode: 'ROOTLESS' }, { mode: 'ROOTLESS', confirmedAt: 'yesterday' },
    { mode: 'ROOTLESS', confirmedAt: '2026-11-09T10:00:00.000Z', extra: 1 }, 'ROOTLESS', []])
    await rejects(store.setDocker('lab-1', bad), 'REMOTE_HOST_INVALID');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  delete raw.hosts[0].docker; // as written by 4.18.24
  await fs.writeFile(file, JSON.stringify(raw));
  assert.equal((await reopen()).get('lab-1').docker, null);
  raw.hosts[0].docker = { mode: 'ROOT', confirmedAt: '2026-11-09T10:00:00.000Z' };
  await fs.writeFile(file, JSON.stringify(raw));
  await rejects(reopen(), 'REMOTE_HOST_STORE_INVALID');
});
