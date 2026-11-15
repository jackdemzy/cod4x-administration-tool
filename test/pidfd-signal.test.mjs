// Security audit 4.18.26 (A1-5): the pidfd helper against the real kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openPidfdSignaler } from '../lib/pidfd-signal.mjs';

const probe = process.platform === 'linux'
  ? spawnSync('python3', ['-I', '-S', '-c', 'import os,signal;os.close(os.pidfd_open(os.getpid()));signal.pidfd_send_signal'], { encoding: 'utf8' })
  : { status: 1 };
const skip = probe.status === 0 ? false : 'needs Linux 5.3+ and python3 3.9+ with pidfd';

test('pidfd helper signals the process it opened', { skip }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const signaler = await openPidfdSignaler(child.pid);
  assert.equal(signaler.state, 'ready');
  const exited = once(child, 'exit');
  assert.equal(await signaler.send('SIGTERM'), true);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
});

test('pidfd helper reports a PID that is gone', { skip }, async () => {
  const child = spawn('true', [], { stdio: 'ignore' });
  await once(child, 'exit');
  const result = await openPidfdSignaler(child.pid);
  // the PID may already belong to someone else; then it is "ready" for that process,
  // which is why the adapter checks the identity after opening the pidfd
  if (result.state === 'ready') result.close(); else assert.equal(result.state, 'gone');
});

test('pidfd held across the exit of its process never reaches a new owner of the PID', { skip }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const signaler = await openPidfdSignaler(child.pid);
  assert.equal(signaler.state, 'ready');
  child.kill('SIGKILL');
  await once(child, 'exit'); // reaped: the PID is free for reuse from here on
  assert.equal(await signaler.send('SIGTERM'), false, 'ESRCH through the pidfd instead of a kill by PID');
});

test('missing python3 is reported as unsupported', async () => {
  const result = await openPidfdSignaler(process.pid, { python: 'python3-does-not-exist-a1-5' });
  assert.equal(result.state, 'unsupported');
});
