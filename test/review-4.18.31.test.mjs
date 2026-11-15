// Review findings on #64 (Codex): the backend log stays capped while it is written, and a stale
// real-Docker lock is taken over by one worker only.
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

const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('exit', resolve));
  return child.pid;
};

test('a stale real-Docker lock is taken over by exactly one of several waiting workers', async t => {
  // Workers in this process share its PID, so a second one waits for the first like another process
  // would; the holder count shows whether two ever held the lock at once. Before the takeover guard,
  // this failed within a few rounds (a late removal deleted a freshly taken lock: ENOENT on its pid file).
  const dir = tempDir(t), dead = await deadPid();
  for (let round = 0; round < 15; round++) {
    const lock = path.join(dir, `docker-${round}.lock`);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(dead));
    let holders = 0, maxHolders = 0, done = 0;
    await Promise.all(Array.from({ length: 30 }, async () => {
      const unlock = await lockRealDocker({ lock, timeoutMs: 20_000, pollMs: 1 });
      holders += 1; maxHolders = Math.max(maxHolders, holders);
      await new Promise(resolve => setTimeout(resolve, 2));
      holders -= 1; done += 1;
      await unlock();
    }));
    assert.equal(done, 30);
    assert.equal(maxHolders, 1, 'never two holders at once');
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(`${lock}.takeover`), false);
  }
});

test('a takeover only removes the lock of the dead owner it saw, never a new live lock', async t => {
  const lock = path.join(tempDir(t), 'docker.lock');
  // A live owner (this process): the lock is not touched, the waiter times out.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  await assert.rejects(lockRealDocker({ lock, timeoutMs: 50, pollMs: 5 }), /not released/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  // A takeover file left behind by a killed process is cleared after a minute.
  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(await deadPid()));
  fs.writeFileSync(`${lock}.takeover`, '');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${lock}.takeover`, old, old);
  const unlock = await lockRealDocker({ lock, timeoutMs: 5_000, pollMs: 5 });
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  await unlock();
});
