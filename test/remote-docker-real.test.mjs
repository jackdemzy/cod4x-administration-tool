import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDockerFixture, realDockerAvailable } from './support/docker-fixture.mjs';
import { until } from './support/remote-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';

// Block 19 against a real Docker daemon: the real image, a real container, real mounts and ports. The core
// is a static stand-in (test/support/docker-fixture.mjs). Skipped where no daemon answers.
const run = promisify(execFile);
const skip = !(await loopbackAvailable()) ? 'needs Linux, a non-root user, gcc and setsid' : !(await realDockerAvailable()) ? 'no Docker daemon' : false;
const docker = (...args) => run('docker', args).then(result => result.stdout);
const hash = async file => (await run('sha256sum', [file])).stdout.split(' ')[0];

test('Container Restart ohne Datenverlust: restart, and stop + start, keep every file; the container is restricted', { skip, timeout: 600_000 }, async t => {
  const f = await createDockerFixture(t, { real: true, timing: { stopGraceMs: 2000, startConfirmMs: 10_000, startSettleMs: 1000 } });
  const instance = await f.install('real-01', { port: 28990 });
  const first = (await f.manager.start('real-01')).runtime;
  assert.equal(first.status, 'RUNNING');

  // the core answers on the port published on loopback
  let health;
  assert.ok(await until(async () => (health = await f.manager.health('real-01')).getinfo === 'OK', 10_000), JSON.stringify(health));
  assert.equal(health.hostname, 'container');

  // what the core reports from inside
  let logs;
  assert.ok(await until(async () => /CapEff/.test((logs = await f.manager.logs('real-01')).stdout), 5000), logs?.stdout);
  assert.match(logs.stdout, /fs_homepath\n\/cod4\/home\n/);
  assert.match(logs.stdout, /write home: ALLOWED/);
  assert.match(logs.stdout, /write base: DENIED/, 'the base game is read-only');
  assert.match(logs.stdout, /write homecore: DENIED/, 'the core directory is read-only, also through the home');
  assert.match(logs.stdout, /write corepath: DENIED/);
  assert.match(logs.stdout, /write root: DENIED/, 'the root file system is read-only');
  assert.match(logs.stdout, /CapEff:\t0000000000000000/, 'no capabilities');
  assert.match(logs.stderr, /fixture stderr/);

  // the container as Docker sees it
  const inspect = JSON.parse(await docker('container', 'inspect', first.containerId))[0];
  assert.equal(inspect.Name, '/cod4x-real-01');
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
  assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(inspect.HostConfig.RestartPolicy.Name, 'no');
  assert.equal(inspect.HostConfig.NetworkMode, 'bridge');
  assert.deepEqual(inspect.HostConfig.PortBindings['28990/udp'], [{ HostIp: '127.0.0.1', HostPort: '28990' }]);
  assert.deepEqual(inspect.Config.Env.filter(entry => !entry.startsWith('PATH=')), [], 'no environment of ours');
  assert.deepEqual(Object.keys(inspect.Config.Labels).filter(label => label.startsWith('cod4x.control.') && label !== 'cod4x.control.dockerfile').sort(), ['cod4x.control.instance', 'cod4x.control.run']);

  // data written by the core and by the operator
  const starts = `${instance.home}/players/core-starts.txt`;
  assert.equal(await fs.readFile(starts, 'utf8'), 'start\n');
  const owner = await fs.stat(starts);
  if (f.mode === 'ROOTFUL') assert.deepEqual([owner.uid, owner.gid], [process.getuid(), process.getgid()], 'files in the home keep the owner of the SSH user');
  await fs.writeFile(`${instance.home}/players/profile.dat`, Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251)));
  await fs.writeFile(`${instance.home}/mods/readme.txt`, 'mod');
  await fs.writeFile(`${instance.home}/usermaps/map.txt`, 'map');
  const watched = [`${instance.home}/main/server.cfg`, `${instance.home}/players/profile.dat`, `${instance.home}/mods/readme.txt`, `${instance.home}/usermaps/map.txt`, instance.core.path];
  const before = await Promise.all(watched.map(hash));

  // restart: a new container
  const second = (await f.manager.restart('real-01')).runtime;
  assert.equal(second.status, 'RUNNING');
  assert.notEqual(second.containerId, first.containerId);
  await assert.rejects(docker('container', 'inspect', first.containerId), 'the old container is removed');
  assert.ok(await until(async () => (await fs.readFile(starts, 'utf8')) === 'start\nstart\n', 5000));
  assert.deepEqual(await Promise.all(watched.map(hash)), before);

  // stop removes the container, start creates the next one
  assert.equal((await f.manager.stop('real-01')).runtime.status, 'STOPPED');
  assert.equal((await docker('ps', '--all', '--quiet', '--filter', 'name=cod4x-real-01')).trim(), '');
  assert.deepEqual(await Promise.all(watched.map(hash)), before);
  const third = (await f.manager.start('real-01')).runtime;
  assert.ok(await until(async () => (await fs.readFile(starts, 'utf8')) === 'start\nstart\nstart\n', 5000));
  assert.deepEqual(await Promise.all(watched.map(hash)), before);

  // the container is removed behind CONTROL's back: noticed, and the data is still there
  await docker('rm', '--force', third.containerId);
  const status = (await f.manager.status('real-01')).runtime;
  assert.deepEqual([status.status, status.exitReason], ['FAILED', 'PROCESS_GONE']);
  assert.equal((await f.manager.start('real-01')).runtime.status, 'RUNNING');
  assert.deepEqual(await Promise.all(watched.map(hash)), before);
  assert.equal((await f.manager.stop('real-01')).runtime.status, 'STOPPED');
});

test('a public instance is published on every IPv4 address, and two instances run side by side', { skip, timeout: 600_000 }, async t => {
  const f = await createDockerFixture(t, { real: true, timing: { stopGraceMs: 2000, startConfirmMs: 10_000, startSettleMs: 1000 } });
  await f.install('real-02', { port: 28991 });
  await f.install('real-03', { port: 28992 });
  await f.instances.setNetwork('real-02', { scope: 'PUBLIC', publicAddress: null });
  const one = (await f.manager.start('real-02')).runtime, two = (await f.manager.start('real-03')).runtime;
  const bindings = async id => JSON.parse(await docker('container', 'inspect', id))[0].HostConfig.PortBindings;
  assert.deepEqual((await bindings(one.containerId))['28991/udp'], [{ HostIp: '0.0.0.0', HostPort: '28991' }]);
  assert.deepEqual((await bindings(two.containerId))['28992/udp'], [{ HostIp: '127.0.0.1', HostPort: '28992' }]);
  for (const id of ['real-02', 'real-03']) assert.ok(await until(async () => (await f.manager.health(id)).getinfo === 'OK', 10_000), id);
  const all = await f.manager.statusAll();
  assert.deepEqual(all.map(entry => entry.runtime.status), ['RUNNING', 'RUNNING']);
  await f.manager.stop('real-02'); await f.manager.stop('real-03');
});

test('a core that exits at once is reported as a failed start with its output kept', { skip, timeout: 600_000 }, async t => {
  const f = await createDockerFixture(t, { real: true, timing: { stopGraceMs: 2000, startConfirmMs: 10_000, startSettleMs: 1000 } });
  const instance = await f.install('real-04', { port: 28993 });
  // a "core" that prints one line and exits with 3
  await fs.writeFile(instance.core.path, '#!/bin/sh\necho gone early\nexit 3\n');
  await f.instances.setCore('real-04', { version: '21.5', sha256: await hash(instance.core.path) });
  await assert.rejects(f.manager.start('real-04'), error => error.code === 'REMOTE_START_FAILED');
  const saved = await f.state.read('real-04');
  assert.deepEqual([saved.status, saved.exitReason], ['FAILED', 'EXITED_ON_START']);
  assert.match((await f.manager.logs('real-04')).stdout, /gone early/);
  assert.equal((await f.manager.stop('real-04')).runtime.status, 'FAILED');
});
