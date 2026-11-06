import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-instance-store-b3i-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'unverified fixture');
  const options = { root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} };
  const store = new ServerInstanceStore(options);
  await store.load();
  const input = { id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 };
  return { store, input, options };
}

test('b3Integration defaults on create and on legacy records', async t => {
  const { store, input, options } = await fixture(t);
  const created = await store.create(input);
  assert.deepEqual(created.b3Integration, { hideCommands: false, prefix: '!', hideLevel: 20 });
  const raw = JSON.parse(await fs.readFile(options.registryFile, 'utf8'));
  delete raw.instances[0].b3Integration;
  await fs.writeFile(options.registryFile, JSON.stringify(raw));
  const reloaded = new ServerInstanceStore(options); await reloaded.load();
  assert.deepEqual(reloaded.get('public-01').b3Integration, { hideCommands: false, prefix: '!', hideLevel: 20 });
});

test('setB3Integration persists across a reload and rejects invalid values', async t => {
  const { store, input, options } = await fixture(t);
  await store.create(input);
  const updated = await store.setB3Integration('public-01', { hideCommands: true, prefix: '#', hideLevel: 40 });
  assert.deepEqual(updated.b3Integration, { hideCommands: true, prefix: '#', hideLevel: 40 });
  const reloaded = new ServerInstanceStore(options); await reloaded.load();
  assert.deepEqual(reloaded.get('public-01').b3Integration, { hideCommands: true, prefix: '#', hideLevel: 40 });
  await assert.rejects(store.setB3Integration('public-01', { prefix: '!!' }), { code: 'B3_PREFIX_INVALID' });
});
