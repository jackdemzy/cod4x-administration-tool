// Review findings on #64/#65 (Codex): the backend log stays capped while it is written, and the
// real-Docker lock admits one holder at a time and never goes stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { lockRealDocker } from './support/docker-fixture.mjs';

const require = createRequire(import.meta.url);
const { openCappedLog } = require('../lib/capped-log.cjs');

const tempDir = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cod4x-review-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('the backend log rotates while it is written and never grows past its limit', t => {
  const file = path.join(tempDir(t), 'logs', 'backend.log');
  const log = openCappedLog(file, { maxBytes: 1000 });
  for (let i = 0; i < 50; i++) log.write(Buffer.from(`${String(i).padStart(3, '0')} ${'x'.repeat(95)}\n`));
  log.close();
  assert.ok(fs.statSync(file).size <= 1000, 'live log is capped');
  assert.ok(fs.statSync(`${file}.1`).size <= 1000, 'rotation is capped');
  assert.match(fs.readFileSync(file, 'utf8'), /^049 x+$/m, 'the newest line is kept');
  // One chunk above the limit keeps only its tail.
  const big = openCappedLog(file, { maxBytes: 1000 });
  big.write('a'.repeat(1500) + 'END');
  big.close();
  assert.ok(fs.statSync(file).size <= 1000);
  assert.match(fs.readFileSync(file, 'utf8'), /END$/);
});

test('when the rotation cannot move the file, the log starts over instead of growing', { skip: process.platform === 'win32' ? 'directory permissions differ on Windows' : false }, t => {
  const dir = tempDir(t), file = path.join(dir, 'backend.log');
  // backend.log.1 is a non-empty directory: the rename fails on every platform this test runs on.
  fs.mkdirSync(`${file}.1`); fs.writeFileSync(path.join(`${file}.1`, 'keep'), '');
  const log = openCappedLog(file, { maxBytes: 1000 });
  for (let i = 0; i < 50; i++) log.write(Buffer.from(`${String(i).padStart(3, '0')} ${'x'.repeat(95)}\n`));
  log.close();
  assert.ok(fs.statSync(file).size <= 1000, 'live log stays capped although the rotation failed');
  assert.match(fs.readFileSync(file, 'utf8'), /^049 x+$/m);
});

test('an oversized log from an earlier run is rotated on open; an unwritable path is ignored', t => {
  const dir = tempDir(t), file = path.join(dir, 'backend.log');
  fs.writeFileSync(file, 'y'.repeat(2000));
  const log = openCappedLog(file, { maxBytes: 1000 });
  log.write('fresh\n'); log.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh\n');
  assert.equal(fs.statSync(`${file}.1`).size, 2000);
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  const broken = openCappedLog(path.join(dir, 'blocker', 'backend.log'));
  assert.doesNotThrow(() => { broken.write('x'); broken.close(); });
});

// The real-Docker lock is a kernel lock (flock); real Docker tests run on Linux only.
const flockSkip = process.platform !== 'linux' ? 'real Docker and flock are Linux only' : false;

test('the real-Docker lock admits one holder at a time, also among many waiting workers', { skip: flockSkip }, async t => {
  const lock = path.join(tempDir(t), 'docker.lock');
  let holders = 0, maxHolders = 0, done = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    const unlock = await lockRealDocker({ lock, timeoutMs: 30_000 });
    holders += 1; maxHolders = Math.max(maxHolders, holders);
    await new Promise(resolve => setTimeout(resolve, 5));
    holders -= 1; done += 1;
    await unlock();
  }));
  assert.equal(done, 20);
  assert.equal(maxHolders, 1, 'never two holders at once');
});

test('a held lock times out the waiter; a killed holder releases it at once', { skip: flockSkip }, async t => {
  const lock = path.join(tempDir(t), 'docker.lock');
  const unlock = await lockRealDocker({ lock, timeoutMs: 5_000 });
  await assert.rejects(lockRealDocker({ lock, timeoutMs: 200 }), /not released/);
  await unlock();
  // A test process killed while it holds the lock: the kernel drops the lock with it.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { lockRealDocker } from ${JSON.stringify(new URL('./support/docker-fixture.mjs', import.meta.url).href)}; await lockRealDocker({ lock: ${JSON.stringify(lock)} }); console.log('held'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => { holder.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(); }); holder.once('exit', code => reject(new Error(`holder exited ${code}`))); });
  await assert.rejects(lockRealDocker({ lock, timeoutMs: 200 }), /not released/);
  holder.kill('SIGKILL');
  const next = await lockRealDocker({ lock, timeoutMs: 5_000 });
  await next();
});
