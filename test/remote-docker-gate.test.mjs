import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createDockerFixture, realDockerAvailable } from './support/docker-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';

// Block 19 gate, "Container Restart ohne Datenverlust": the whole sequence of the roadmap gate on one instance.
// Run once against the scripted docker of the fixture and once against a real daemon (skipped where none answers).
const linux = (await loopbackAvailable()) ? false : 'needs Linux, a non-root user, gcc and setsid';
const real = linux || ((await realDockerAvailable()) ? false : 'no Docker daemon');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FILES = ['players/profile.dat', 'mods/readme.txt', 'usermaps/map.txt', 'main/server.cfg', 'core/cod4x18_dedrun'];

async function sequence(t, options) {
  const f = await createDockerFixture(t, options);
  const instance = await f.install('gate-01', { port: 28995 });
  const digests = async () => Object.fromEntries(await Promise.all(FILES.map(async file => [file, sha(await fs.readFile(`${instance.home}/${file}`))])));
  const starts = async () => (await fs.readFile(`${instance.home}/players/core-starts.txt`, 'utf8')).split('\n').filter(Boolean).length;

  const first = (await f.manager.start('gate-01')).runtime;
  assert.equal(first.status, 'RUNNING');
  assert.match(first.containerId, /^[a-f0-9]{64}$/);
  // the marker: data of the operator next to data the core itself writes
  await fs.writeFile(`${instance.home}/players/profile.dat`, crypto.randomBytes(4096));
  await fs.writeFile(`${instance.home}/mods/readme.txt`, 'mod');
  await fs.writeFile(`${instance.home}/usermaps/map.txt`, 'map');
  const before = await digests();

  const second = (await f.manager.restart('gate-01')).runtime;
  assert.equal(second.status, 'RUNNING');
  assert.notEqual(second.containerId, first.containerId, 'a restart is a new container');
  assert.deepEqual(await digests(), before, 'restart');

  assert.equal((await f.manager.stop('gate-01')).runtime.status, 'STOPPED');
  assert.deepEqual(await digests(), before, 'stop');
  const third = (await f.manager.start('gate-01')).runtime;
  assert.equal(third.status, 'RUNNING');
  assert.deepEqual(await digests(), before, 'stop and start');
  assert.equal(await starts(), 3, 'the file the core appends to survived every container');
  await f.manager.stop('gate-01');

  // the same files serve a native process and a container
  assert.equal((await f.manager.setDeployment('gate-01', { deployment: 'native' })).instance.deployment, 'native');
  const native = (await f.manager.start('gate-01')).runtime;
  assert.ok(native.status === 'RUNNING' && native.pid && !native.containerId);
  assert.deepEqual(await digests(), before, 'native');
  await f.manager.stop('gate-01');
  assert.equal((await f.manager.setDeployment('gate-01', { deployment: 'docker' })).instance.deployment, 'docker');
  const last = (await f.manager.start('gate-01')).runtime;
  assert.ok(last.status === 'RUNNING' && last.containerId && !last.pid);
  assert.deepEqual(await digests(), before, 'back in a container');
  assert.equal(await starts(), 5);
  await f.manager.stop('gate-01');
  assert.equal((await f.manager.status('gate-01')).runtime.status, 'STOPPED');
  assert.equal(f.closes.length, f.connects.length, 'every connection was closed');
}

test('gate: Container Restart ohne Datenverlust (scripted docker)', { skip: linux }, t => sequence(t, {}));
test('gate: Container Restart ohne Datenverlust (real Docker daemon)', { skip: real, timeout: 600_000 }, t => sequence(t, { real: true, timing: { stopGraceMs: 2000, startConfirmMs: 10_000, startSettleMs: 1000 } }));
