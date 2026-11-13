import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installArtifacts, listArchiveEntries, restoreFilesPoint, artifactUrl, DEFAULT_RUNTIME_SUBJECT } from '../lib/archive-install.mjs';
import { RestorePointStore } from '../lib/restore-points.mjs';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const tar = require('tar');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-ai-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'server');
  await fs.mkdir(path.join(target, 'main'), { recursive: true });
  await fs.writeFile(path.join(target, 'cod4x18_dedrun'), 'old core');
  await fs.chmod(path.join(target, 'cod4x18_dedrun'), 0o755);
  await fs.writeFile(path.join(target, 'main', 'server.cfg'), 'old cfg');
  await fs.writeFile(path.join(target, 'keep.txt'), 'untouched');
  const store = new RestorePointStore({ root: path.join(root, 'points') });
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'main'), { recursive: true });
  await fs.mkdir(path.join(source, 'mods', 'pml'), { recursive: true });
  await fs.writeFile(path.join(source, 'cod4x18_dedrun'), 'new core');
  await fs.writeFile(path.join(source, 'main', 'server.cfg'), 'new cfg');
  await fs.writeFile(path.join(source, 'mods', 'pml', 'z_pml.iwd'), 'new mod');
  return { root, target, store, source };
}
async function snapshot(directory) {
  const result = {};
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result[`${name}/`] = 'dir'; await visit(name); }
      else {
        const stats = await fs.stat(path.join(directory, name));
        result[name] = `${(await fs.readFile(path.join(directory, name))).toString('hex')}:${(stats.mode & 0o777).toString(8)}`;
      }
    }
  }
  await visit('');
  return result;
}
function zipOf(source, file) {
  const zip = new AdmZip();
  zip.addLocalFolder(source);
  zip.writeZip(file);
  return file;
}
async function tarOf(source, file) {
  await tar.c({ file, gzip: true, cwd: source }, ['cod4x18_dedrun', 'main', 'mods']);
  return file;
}
const corruptOne = name => async (from, to) => { await fs.copyFile(from, to); if (to.endsWith(name)) await fs.appendFile(to, 'x'); };

for (const [label, make] of [['zip', (source, root) => zipOf(source, path.join(root, 'a.zip'))], ['tar.gz', (source, root) => tarOf(source, path.join(root, 'a.tar.gz'))]]) {
  test(`${label} overwriting two files and creating one rolls back byte-identical when verify fails`, async t => {
    const { root, target, store, source } = await fixture(t);
    const archive = await make(source, root);
    const before = await snapshot(target);
    const error = await installArtifacts({ artifacts: [archive], target, store, copy: corruptOne('z_pml.iwd') }).catch(caught => caught);
    assert.equal(error.code, 'INSTALL_VERIFY_FAILED');
    assert.equal(error.rolledBack, true);
    assert.deepEqual(await snapshot(target), before);
    const [point] = await store.list(DEFAULT_RUNTIME_SUBJECT);
    assert.equal(point.action, 'core.change');
  });
}

test('success writes the files and returns a restore point id; the point restores the old state', async t => {
  const { root, target, store, source } = await fixture(t);
  const before = await snapshot(target);
  const archive = zipOf(source, path.join(root, 'a.zip'));
  const result = await installArtifacts({ artifacts: [archive], target, store, extraFiles: { 'cod4x-control-manifest.json': Buffer.from('{}\n') } });
  assert.match(result.restorePointId, /Z-[0-9a-f]{8}$/);
  assert.equal(result.files, 4);
  assert.equal(await fs.readFile(path.join(target, 'cod4x18_dedrun'), 'utf8'), 'new core');
  assert.equal(await fs.readFile(path.join(target, 'mods', 'pml', 'z_pml.iwd'), 'utf8'), 'new mod');
  await restoreFilesPoint(target, await store.read(DEFAULT_RUNTIME_SUBJECT, result.restorePointId));
  assert.deepEqual(await snapshot(target), before);
});

test('entry ../evil is refused before any write', async t => {
  const { root, target, store } = await fixture(t);
  const zip = new AdmZip();
  zip.addFile('main/server.cfg', Buffer.from('evil cfg'));
  zip.addFile('placeholder', Buffer.from('x'));
  const archive = path.join(root, 'evil.zip');
  zip.writeZip(archive);
  // adm-zip normalises "../" on addFile; patch the stored name to a traversal of the same length.
  const bytes = await fs.readFile(archive);
  await fs.writeFile(archive, Buffer.from(bytes.toString('latin1').replaceAll('placeholder', '../evil.abc'), 'latin1'));
  const before = await snapshot(target);
  await assert.rejects(installArtifacts({ artifacts: [archive], target, store }), /Unsafe path rejected/);
  assert.deepEqual(await snapshot(target), before);
  await assert.rejects(fs.access(path.join(root, 'evil.abc')));
  assert.deepEqual(await store.list(DEFAULT_RUNTIME_SUBJECT).catch(() => []), []);
});

test('a tar with a symbolic link is refused', async t => {
  const { root, target, store, source } = await fixture(t);
  await fs.symlink('/etc/passwd', path.join(source, 'main', 'link'));
  const archive = await tarOf(source, path.join(root, 'link.tar.gz'));
  const before = await snapshot(target);
  await assert.rejects(installArtifacts({ artifacts: [archive], target, store }), { code: 'INSTALL_ARCHIVE_INVALID' });
  assert.deepEqual(await snapshot(target), before);
});

test('a linked directory in the target is refused before any write', { skip: process.platform === 'win32' }, async t => {
  const { root, target, store, source } = await fixture(t);
  await fs.mkdir(path.join(root, 'elsewhere'));
  await fs.symlink(path.join(root, 'elsewhere'), path.join(target, 'mods'));
  const archive = zipOf(source, path.join(root, 'a.zip'));
  await assert.rejects(installArtifacts({ artifacts: [archive], target, store }), { code: 'INSTALL_TARGET_INVALID' });
  assert.deepEqual(await fs.readdir(path.join(root, 'elsewhere')), []);
  assert.equal(await fs.readFile(path.join(target, 'cod4x18_dedrun'), 'utf8'), 'old core');
});

test('listArchiveEntries returns names, directories and hashes', async t => {
  const { root, source } = await fixture(t);
  const entries = await listArchiveEntries(zipOf(source, path.join(root, 'a.zip')));
  assert.deepEqual(entries.map(entry => entry.name), ['cod4x18_dedrun', 'main', 'main/server.cfg', 'mods', 'mods/pml', 'mods/pml/z_pml.iwd']);
  assert.match(entries[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(entries[1].directory, true);
});

// Security audit 4.18.26 (A1-3): setuid/setgid bits never reach the target, owners are not kept.
test('setuid and setgid bits from a tar are stripped', { skip: process.platform === 'win32' }, async t => {
  const { root, target, store, source } = await fixture(t);
  await fs.chmod(path.join(source, 'cod4x18_dedrun'), 0o6755);
  const archive = await tarOf(source, path.join(root, 'suid.tar.gz'));
  await installArtifacts({ artifacts: [archive], target, store });
  assert.equal((await fs.stat(path.join(target, 'cod4x18_dedrun'))).mode & 0o7000, 0);
  assert.equal(await fs.readFile(path.join(target, 'cod4x18_dedrun'), 'utf8'), 'new core');
});

// Security audit 4.18.26 (A1-6): size caps per entry and in total, zip and tar.
for (const [label, make] of [['zip', (source, root) => zipOf(source, path.join(root, 'big.zip'))], ['tar.gz', (source, root) => tarOf(source, path.join(root, 'big.tar.gz'))]]) {
  test(`${label}: an entry or a total above the cap is refused before any write`, async t => {
    const { root, target, store, source } = await fixture(t);
    const archive = await make(source, root);
    const before = await snapshot(target);
    await assert.rejects(installArtifacts({ artifacts: [archive], target, store, limits: { maxEntryBytes: 4, maxTotalBytes: 1 << 20 } }), { code: 'INSTALL_ARCHIVE_TOO_LARGE' });
    await assert.rejects(installArtifacts({ artifacts: [archive], target, store, limits: { maxEntryBytes: 1 << 20, maxTotalBytes: 10 } }), { code: 'INSTALL_ARCHIVE_TOO_LARGE' });
    assert.deepEqual(await snapshot(target), before);
  });
}

// Security audit 4.18.26 (A1-7): a later (FPS or mod) archive may not replace the core.
test('a later archive that carries a core executable is refused', async t => {
  const { root, target, store, source } = await fixture(t);
  const core = zipOf(source, path.join(root, 'core.zip'));
  const modSource = path.join(root, 'mod');
  await fs.mkdir(path.join(modSource, 'bin'), { recursive: true });
  await fs.writeFile(path.join(modSource, 'bin', 'COD4X18_DEDRUN.exe'), 'evil core');
  const mod = zipOf(modSource, path.join(root, 'mod.zip'));
  const before = await snapshot(target);
  await assert.rejects(installArtifacts({ artifacts: [core, mod], target, store }), { code: 'INSTALL_CORE_OVERWRITE' });
  assert.deepEqual(await snapshot(target), before);
});

test('artifact downloads accept https only', () => {
  assert.equal(artifactUrl({ url: 'https://example.org/core.zip' }).href, 'https://example.org/core.zip');
  for (const url of ['http://example.org/core.zip', 'ftp://example.org/x', 'file:///etc/passwd']) assert.throws(() => artifactUrl({ url }), /Only HTTPS artifacts are allowed/, url);
  assert.throws(() => artifactUrl({ url: '' }), /not configured/);
});
