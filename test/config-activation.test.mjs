import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordConfigActivation, readConfigActivation, describeConfigActivation } from '../lib/config-activation.mjs';

const sha = character => character.repeat(64);
async function fixture(action) {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-activation-'));
  try { await action({ id: 'activation-test', homePath }); }
  finally { await fs.rm(homePath, { recursive: true, force: true }); }
}

test('activation record roundtrips and distinguishes active, restart-required, unknown and stopped runs', () => fixture(async instance => {
  assert.deepEqual(await readConfigActivation(instance), { valid: true, record: null });
  await recordConfigActivation(instance, { sha256: sha('a'), runId: 'run-1', pid: 4501 });
  const activation = await readConfigActivation(instance);
  assert.equal(activation.record.sha256, sha('a'));
  const running = { status: 'RUNNING', pid: 4501, runId: 'run-1' };
  assert.equal(describeConfigActivation(activation, running, sha('a')).state, 'ACTIVE');
  assert.deepEqual([describeConfigActivation(activation, running, sha('b')).state, describeConfigActivation(activation, running, sha('b')).restartRequired], ['RESTART_REQUIRED', true]);
  // A record from another run must not vouch for the current process.
  assert.equal(describeConfigActivation(activation, { ...running, runId: 'run-2' }, sha('a')).state, 'UNKNOWN');
  const stopped = describeConfigActivation(activation, { status: 'STOPPED', pid: null }, sha('b'));
  assert.deepEqual([stopped.state, stopped.changedSinceLastStart, stopped.restartRequired], ['STOPPED', true, false]);
}));

test('corrupt, foreign or invalid activation evidence is never trusted', () => fixture(async instance => {
  await assert.rejects(recordConfigActivation(instance, { sha256: 'not-a-hash', runId: 'run-1', pid: 1 }), { code: 'CONFIG_ACTIVATION_INVALID' });
  await recordConfigActivation(instance, { sha256: sha('a'), runId: 'run-1', pid: 4501 });
  const file = path.join(instance.homePath, 'logs', 'config-activation.json');
  await fs.writeFile(file, '{broken');
  const corrupt = await readConfigActivation(instance);
  assert.equal(corrupt.valid, false);
  assert.equal(describeConfigActivation(corrupt, { status: 'RUNNING', pid: 4501, runId: 'run-1' }, sha('a')).state, 'UNKNOWN');
  await fs.writeFile(file, JSON.stringify({ version: 1, instanceId: 'other-instance', sha256: sha('a'), runId: 'run-1', pid: 4501, startedAt: new Date().toISOString() }));
  assert.equal((await readConfigActivation(instance)).valid, false);
}));
