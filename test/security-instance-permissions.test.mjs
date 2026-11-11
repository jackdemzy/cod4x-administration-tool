import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';
import { prepareB3Runtime } from '../lib/b3-config.mjs';

// Security audit 4.18.26, finding A2-2: game and console logs can hold typed B3 "!auth"
// passwords. With umask 022 an instance home was 0755 and the game log 0644, readable by
// every local user who can reach the data folder.
const posix = process.platform !== 'win32';
const mode = async file => (await fs.stat(file)).mode & 0o777;

test('A2-2: a new instance home is private to the CONTROL user', { skip: !posix && 'POSIX modes only' }, async t => {
  const { create, store, cleanup } = await createRconFixture();
  t.after(cleanup);
  await create('perm-a');
  assert.equal(await mode(store.get('perm-a').homePath) & 0o077, 0);
});

test('A2-2: starting an instance tightens an existing home created before 4.18.26', { skip: !posix && 'POSIX modes only' }, async t => {
  const { create, store, manager, cleanup } = await createRconFixture();
  t.after(cleanup);
  await create('perm-b');
  const home = store.get('perm-b').homePath;
  await fs.chmod(home, 0o755);
  await manager.launch('perm-b');
  assert.equal(await mode(home) & 0o077, 0);
});

test('A2-2: B3 creates the game log readable only by the CONTROL user', { skip: !posix && 'POSIX modes only' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a22-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareB3Runtime({ id: 'b3p', port: 28960, homePath: root }, 'games_mp.log', { rconPassword: 'Rcon-Pass-1' });
  const logs = (await fs.readdir(root, { recursive: true })).filter(name => name.endsWith('games_mp.log'));
  assert.equal(logs.length, 1);
  assert.equal(await mode(path.join(root, logs[0])) & 0o077, 0);
});
