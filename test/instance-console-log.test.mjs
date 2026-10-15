import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readInstanceConsoleLog } from '../lib/instance-console-log.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-console-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'server');
  await fs.mkdir(path.join(home, 'main'), { recursive: true });
  return { root, home, file: path.join(home, 'main', 'qconsole.log') };
}
test('missing console is waiting, then native file updates appear without a process pipe', async t => {
  const { home, file } = await fixture(t);
  assert.equal((await readInstanceConsoleLog(home)).status, 'waiting');
  await fs.writeFile(file, 'first native line\n');
  assert.equal((await readInstanceConsoleLog(home)).text, 'first native line\n');
  await fs.appendFile(file, 'second native line\n');
  assert.match((await readInstanceConsoleLog(home)).text, /second native line/);
});
test('bounded UTF-8 tail removes partial leading lines and labeled secrets', async t => {
  const { home, file } = await fixture(t);
  await fs.writeFile(file, `${'ä'.repeat(40000)}\nsafe line\nrcon_password secret-value\nmasterToken secret-token\nlast line\n`);
  const result = await readInstanceConsoleLog(home);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 65536);
  assert.ok(!result.text.includes('\ufffd'));
  assert.ok(!result.text.includes('secret-value'));
  assert.ok(!result.text.includes('secret-token'));
  assert.match(result.text, /safe line/);
});
test('two homes and replacement/truncation are read independently', async t => {
  const a = await fixture(t), b = await fixture(t);
  await fs.writeFile(a.file, 'instance A\n');
  await fs.writeFile(b.file, 'instance B\n');
  assert.equal((await readInstanceConsoleLog(a.home)).text, 'instance A\n');
  assert.equal((await readInstanceConsoleLog(b.home)).text, 'instance B\n');
  await fs.rename(a.file, `${a.file}.old`);
  await fs.writeFile(a.file, 'new run\n');
  assert.equal((await readInstanceConsoleLog(a.home)).text, 'new run\n');
});
test('redaction expansion stays bounded and unfinished lines wait for newline', async t => {
  const { home, file } = await fixture(t);
  await fs.writeFile(file, 'secret\n'.repeat(8000) + 'unfinished secret-value');
  const result = await readInstanceConsoleLog(home);
  assert.ok(Buffer.byteLength(result.text) <= 65536);
  assert.ok(!result.text.includes('unfinished'));
  assert.equal(result.truncated, true);
});
test('home junction and hardlinked console are blocked', async t => {
  const { root, home, file } = await fixture(t);
  const alias = path.join(root, 'alias');
  await fs.symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readInstanceConsoleLog(alias)).status, 'blocked');
  const foreign = path.join(root, 'foreign.log');
  await fs.writeFile(foreign, 'foreign secret content\n');
  await fs.link(foreign, file);
  assert.equal((await readInstanceConsoleLog(home)).status, 'blocked');
});
test('junction home/main and non-file console cannot expose foreign content', async t => {
  const { root, home, file } = await fixture(t);
  await fs.mkdir(path.join(root, 'foreign'));
  await fs.writeFile(path.join(root, 'foreign', 'qconsole.log'), 'foreign content');
  await fs.rmdir(path.join(home, 'main'));
  await fs.symlink(path.join(root, 'foreign'), path.join(home, 'main'), process.platform === 'win32' ? 'junction' : 'dir');
  const blocked = await readInstanceConsoleLog(home);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.text, '');
  await fs.unlink(path.join(home, 'main'));
  await fs.mkdir(file, { recursive: true });
  assert.equal((await readInstanceConsoleLog(home)).status, 'blocked');
});
