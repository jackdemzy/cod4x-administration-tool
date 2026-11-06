import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashB3Module } from '../lib/b3-plugin-hash.mjs';
import { B3_PLUGIN_CATALOG, B3_FIXED_PLUGINS, catalogEntry, isAvailable, modulePath } from '../lib/b3-plugin-catalog.mjs';

const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-hash-'));

test('hashes a file module with CRLF normalized', async () => {
  const dir = await temporary();
  try {
    await fs.writeFile(path.join(dir, 'x.py'), 'a\r\nb\n');
    await fs.writeFile(path.join(dir, 'y.py'), 'a\nb\n');
    const x = await hashB3Module(path.join(dir, 'x.py'));
    const y = await hashB3Module(path.join(dir, 'y.py'));
    assert.equal(x.ok, true);
    assert.equal(x.kind, 'file');
    assert.match(x.sha256, /^[0-9a-f]{64}$/);
    assert.equal(x.sha256, y.sha256);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('hashes a package over sorted relative paths and skips .pyc and __pycache__', async () => {
  const dir = await temporary();
  try {
    const pkg = path.join(dir, 'pkg');
    await fs.mkdir(path.join(pkg, 'sub'), { recursive: true });
    await fs.writeFile(path.join(pkg, '__init__.py'), 'x = 1\n');
    await fs.writeFile(path.join(pkg, 'sub', 'm.py'), 'y = 2\n');
    await fs.writeFile(path.join(pkg, '__init__.pyc'), 'compiled');
    const first = await hashB3Module(pkg);
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'package');
    await fs.mkdir(path.join(pkg, '__pycache__'));
    await fs.writeFile(path.join(pkg, '__pycache__', 'x.pyc'), 'cache');
    await fs.writeFile(path.join(pkg, 'sub', 'm.pyo'), 'opt');
    assert.equal((await hashB3Module(pkg)).sha256, first.sha256);
    await fs.writeFile(path.join(pkg, 'sub', 'm.py'), 'y = 3\n');
    assert.notEqual((await hashB3Module(pkg)).sha256, first.sha256);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rejects symlinks and files over 4 MB', async () => {
  const dir = await temporary();
  try {
    const big = path.join(dir, 'big.py');
    await fs.writeFile(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    assert.deepEqual(await hashB3Module(big), { ok: false, code: 'INVALID' });
    const pkg = path.join(dir, 'pkg');
    await fs.mkdir(pkg);
    await fs.writeFile(path.join(pkg, '__init__.py'), 'x\n');
    await fs.writeFile(path.join(pkg, 'big.py'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    assert.deepEqual(await hashB3Module(pkg), { ok: false, code: 'INVALID' });
    const target = path.join(dir, 'real.py');
    await fs.writeFile(target, 'a\n');
    let linked = true;
    try { await fs.symlink(target, path.join(dir, 'link.py')); } catch { linked = false; }
    if (linked) {
      assert.deepEqual(await hashB3Module(path.join(dir, 'link.py')), { ok: false, code: 'INVALID' });
      const inner = path.join(dir, 'pkg2');
      await fs.mkdir(inner);
      await fs.symlink(target, path.join(inner, 'link.py'));
      assert.deepEqual(await hashB3Module(inner), { ok: false, code: 'INVALID' });
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('missing module', async () => {
  const dir = await temporary();
  try {
    assert.deepEqual(await hashB3Module(path.join(dir, 'nope.py')), { ok: false, code: 'MISSING' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('catalog shape', () => {
  for (const name of B3_FIXED_PLUGINS) assert.equal(catalogEntry(name), null, name);
  assert.deepEqual([...B3_FIXED_PLUGINS], ['admin', 'publist', 'auth']);
  assert.equal(isAvailable(catalogEntry('callvote')), false);
  assert.equal(isAvailable(catalogEntry('welcome')), true);
  assert.deepEqual(catalogEntry('geowelcome').requiresPlugins, ['geolocation']);
  assert.deepEqual(catalogEntry('countryfilter').requiresPlugins, ['geolocation']);
  assert.equal(catalogEntry('duel').requiresConfigFile, false);
  assert.equal(catalogEntry('welcome').requiresConfigFile, true);
  assert.ok(catalogEntry('discord').pythonModules.includes('requests'));
  assert.equal(catalogEntry('discord').location, 'extplugins');
  assert.equal(catalogEntry('discord').module, 'file');
  assert.equal(catalogEntry('mute').module, 'package');
  assert.equal(catalogEntry('nope'), null);
  for (const entry of B3_PLUGIN_CATALOG) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.name);
    assert.equal(entry.configTemplate === null, entry.configTemplateSha256 === null, entry.name);
  }
  assert.equal(modulePath('/srv/b3', catalogEntry('welcome')), path.join('/srv/b3', 'b3', 'plugins', 'welcome'));
  assert.equal(modulePath('/srv/b3', catalogEntry('discord')), path.join('/srv/b3', 'b3', 'extplugins', 'discord.py'));
});

const candidates = [process.env.B3_SOURCE, 'C:\\Users\\r4f1k1\\cod4x-b3\\ebc-b3', path.join(os.homedir(), 'ebc-b3')].filter(Boolean);
let sourcePath = null;
for (const candidate of candidates) { if (await fs.stat(path.join(candidate, 'b3', '__init__.py')).catch(() => null)) { sourcePath = candidate; break; } }

test('catalog matches the real source', { skip: sourcePath ? false : 'no local eBc-B3 checkout' }, async () => {
  for (const entry of B3_PLUGIN_CATALOG) {
    const result = await hashB3Module(modulePath(sourcePath, entry));
    assert.equal(result.ok, true, entry.name);
    assert.equal(result.kind, entry.module, entry.name);
    assert.equal(result.sha256, entry.sha256, entry.name);
  }
});
