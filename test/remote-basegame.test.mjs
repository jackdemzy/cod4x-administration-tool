import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { inspectRemoteBaseGame, assertRemoteBaseGame } from '../lib/remote-basegame.mjs';
import { createRemoteFilesystem } from '../lib/remote-linux-runtime.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux and a non-root user';
const ids = () => ({ uid: process.getuid(), gid: process.getgid() });
const codes = result => result.reasons.map(reason => reason.code);

async function fixture(t) {
  const loopback = await createLoopbackServer();
  t.after(() => loopback.cleanup());
  const filesystem = createRemoteFilesystem({ session: loopback.session, sftp: await loopback.session.sftp(), ...ids() });
  const base = loopback.path('game');
  const put = async (relative, content = 'data', mode) => { const file = `${base}/${relative}`; await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true }); await fs.writeFile(file, content, mode === undefined ? undefined : { mode }); };
  return { loopback, filesystem, base, put, inspect: (path = base, limits) => inspectRemoteBaseGame(filesystem, path, ids(), limits) };
}

test('a valid base game: non-empty .iwd files directly in main and non-empty files below zone', { skip }, async t => {
  const { put, inspect, base } = await fixture(t);
  await put('main/pak0.iwd'); await put('main/PAK1.IWD'); await put('main/readme.txt'); await put('zone/common.ff'); await put('zone/english/x.ff');
  const result = await inspect();
  assert.deepEqual([result.valid, result.reasons], [true, []]);
  assert.deepEqual(result.iwdFiles, ['main/PAK1.IWD', 'main/pak0.iwd']);
  assert.deepEqual(result.zoneFiles, ['zone/common.ff', 'zone/english/x.ff']);
  assert.equal(result.baseGamePath, base);
});

test('a missing or wrong base game path', { skip }, async t => {
  const { loopback, inspect, put } = await fixture(t);
  assert.deepEqual(codes(await inspect(loopback.path('nope'))), ['REMOTE_BASEGAME_NOT_FOUND']);
  await put('afile', 'x');
  assert.deepEqual(codes(await inspect(loopback.path('game', 'afile'))), ['REMOTE_BASEGAME_NOT_DIRECTORY']);
  await assert.rejects(inspect('relative/game'), error => error.code === 'REMOTE_PATH_INVALID');
  await assert.rejects(inspect('/srv/../game'), error => error.code === 'REMOTE_PATH_INVALID');
});

test('main: missing, empty, only empty or non-iwd files, and symlinked or unreadable iwd files', { skip }, async t => {
  const { put, inspect, base, loopback } = await fixture(t);
  await put('zone/common.ff');
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_MAIN_MISSING']);
  await fs.mkdir(`${base}/main`);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_MAIN_IWD_MISSING']);
  await put('main/empty.iwd', ''); await put('main/notes.txt', 'x'); await put('main/sub/deep.iwd', 'x');
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_MAIN_IWD_MISSING'], 'empty, wrong suffix and nested files do not count');
  await fs.writeFile(loopback.path('real.iwd'), 'x'); await fs.symlink(loopback.path('real.iwd'), `${base}/main/linked.iwd`);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_MAIN_IWD_MISSING'], 'a symlinked iwd is ignored, as locally');
  await put('main/locked.iwd', 'x', 0o000);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_ACCESS_DENIED']);
  await fs.chmod(`${base}/main/locked.iwd`, 0o644);
  assert.equal((await inspect()).valid, true);
});

test('zone: missing, only empty files, only symlinks', { skip }, async t => {
  const { put, inspect, base, loopback } = await fixture(t);
  await put('main/pak0.iwd');
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_ZONE_MISSING']);
  await fs.mkdir(`${base}/zone`);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_ZONE_ASSETS_MISSING']);
  await put('zone/empty.ff', '');
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_ZONE_ASSETS_MISSING']);
  await fs.writeFile(loopback.path('real.ff'), 'x'); await fs.symlink(loopback.path('real.ff'), `${base}/zone/linked.ff`);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_ZONE_ASSETS_MISSING']);
  await put('zone/en/a.ff');
  assert.equal((await inspect()).valid, true);
});

test('both folders missing give both reasons; the scan is limited in depth and in entries', { skip }, async t => {
  const { inspect, base, put } = await fixture(t);
  await fs.mkdir(base);
  assert.deepEqual(codes(await inspect()), ['REMOTE_BASEGAME_MAIN_MISSING', 'REMOTE_BASEGAME_ZONE_MISSING']);
  await put('main/pak0.iwd');
  let dir = `${base}/zone`;
  for (let level = 0; level < 18; level++) dir += '/d';
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(`${dir}/x.ff`, 'x');
  assert.ok(codes(await inspect()).includes('REMOTE_BASEGAME_ZONE_SCAN_LIMIT'), 'too deep');
  await fs.rm(`${base}/zone`, { recursive: true });
  for (let index = 0; index < 10; index++) await put(`zone/f${index}.ff`);
  assert.deepEqual(codes(await inspect(base, { maxEntries: 5 })), ['REMOTE_BASEGAME_ZONE_SCAN_LIMIT'], 'too many entries');
  assert.equal((await inspect(base, { maxEntries: 50 })).valid, true);
});

test('assertRemoteBaseGame throws REMOTE_BASEGAME_INVALID with the reasons, and returns the inspection when valid', { skip }, async t => {
  const { put, filesystem, base } = await fixture(t);
  await put('main/pak0.iwd');
  await assert.rejects(assertRemoteBaseGame(filesystem, base, ids()), error => {
    assert.equal(error.code, 'REMOTE_BASEGAME_INVALID');
    assert.deepEqual(error.reasons.map(reason => reason.code), ['REMOTE_BASEGAME_ZONE_MISSING']);
    return true;
  });
  await put('zone/common.ff');
  assert.equal((await assertRemoteBaseGame(filesystem, base, ids())).valid, true);
});
