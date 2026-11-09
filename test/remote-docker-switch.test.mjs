import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDockerFixture } from './support/docker-fixture.mjs';
import { alive, until } from './support/remote-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';

const run = promisify(execFile);
const skip = await loopbackAvailable() ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
// every file below a directory with its hash, without the per-run output files of the native runtime
const snapshot = async directory => (await run('sh', ['-c', 'cd "$0" && find . -type f ! -path "./logs/*" ! -name "core-starts.txt" -exec sha256sum {} + | sort -k2', directory])).stdout;
const RUN = '0123abcd-0123-0123-0123-0123456789ab';

test('install as docker needs a confirmed host whose mode did not change, before anything is uploaded', { skip }, async t => {
  const f = await createDockerFixture(t, { ready: false });
  await rejects(f.install('public-01'), 'REMOTE_DOCKER_NOT_CONFIRMED');
  await f.confirm();
  await f.fake.set({ mode: 'ROOTLESS' });
  await rejects(f.install('public-01'), 'REMOTE_DOCKER_MODE_CHANGED');
  await f.fake.set({ mode: 'NO_DOCKER' });
  await rejects(f.install('public-01'), 'REMOTE_DOCKER_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(f.loopback.path('servers')), [], 'nothing was created on the server');
  assert.deepEqual(f.instances.list(), []);
  await f.fake.set({ mode: 'ROOTFUL' });
  // the image is not needed to install; it is asked for at the first start
  assert.equal((await f.install('public-01')).deployment, 'docker');
  await rejects(f.install('public-02', { deployment: 'podman' }), 'REMOTE_INSTANCE_INVALID');
  // a native install on the same host asks nothing of Docker
  await f.hostStore.setDocker('lab-1', null);
  assert.equal((await f.installNative('public-03')).deployment, 'native');
});

test('a stopped instance switches native -> docker -> native; no file changes and each start uses the right runtime', { skip }, async t => {
  const f = await createDockerFixture(t);
  const instance = await f.installNative('public-01');
  await fs.writeFile(`${instance.home}/players/profile.dat`, Buffer.from([1, 2, 3]));
  await fs.writeFile(`${instance.home}/mods/readme.txt`, 'mod');
  const before = await snapshot(instance.home);

  let native = (await f.manager.start('public-01')).runtime;
  assert.ok(native.pid && !native.containerId);
  await f.manager.stop('public-01');

  const switched = await f.manager.setDeployment('public-01', { deployment: 'docker' });
  assert.deepEqual([switched.previous, switched.instance.deployment], ['native', 'docker']);
  assert.equal(await f.state.read('public-01'), null, 'the saved runtime state is reset');
  assert.equal(await snapshot(instance.home), before);
  const audit = f.audits.find(entry => entry.event === 'remote.instance.deployment_changed');
  assert.deepEqual([audit.instanceId, audit.from, audit.to], ['public-01', 'native', 'docker']);

  const container = (await f.manager.start('public-01')).runtime;
  assert.ok(container.containerId && !container.pid);
  assert.equal((await f.fake.containers()).length, 1);
  await f.manager.stop('public-01');
  assert.equal(await snapshot(instance.home), before);

  assert.equal((await f.manager.setDeployment('public-01', { deployment: 'native' })).instance.deployment, 'native');
  native = (await f.manager.start('public-01')).runtime;
  assert.ok(native.pid && alive(native.pid));
  assert.deepEqual(await f.fake.containers(), []);
  await f.manager.stop('public-01');
  assert.equal(await snapshot(instance.home), before);
  assert.equal(f.closes.length, f.connects.length);
});

test('the same deployment again is a no-op without a connection; bad input is refused', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.installNative('public-01');
  const connects = f.connects.length;
  assert.equal((await f.manager.setDeployment('public-01', { deployment: 'native' })).previous, 'native');
  assert.equal(f.connects.length, connects);
  assert.ok(!f.audits.some(entry => entry.event === 'remote.instance.deployment_changed'));
  for (const bad of [undefined, null, 'docker', {}, { deployment: 'podman' }, { deployment: 'docker', force: true }]) await rejects(f.manager.setDeployment('public-01', bad), 'REMOTE_INSTANCE_INVALID');
  await rejects(f.manager.setDeployment('nope', { deployment: 'docker' }), 'REMOTE_INSTANCE_NOT_FOUND');
});

test('a switch is refused while the instance is starting, running, stopping or blocked, and changes nothing', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.installNative('public-01');
  const idle = { runId: RUN, pid: null, createdAt: null, startedAt: new Date().toISOString(), recoveryBlocked: false, exitReason: null };
  for (const state of [{ ...idle, status: 'STARTING' }, { ...idle, status: 'RUNNING', pid: 4242, createdAt: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:777' }, { ...idle, status: 'STOPPING', pid: 4242, createdAt: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:777' },
    { ...idle, status: 'FAILED', recoveryBlocked: true }, { ...idle, status: 'STOPPED', recoveryBlocked: true }]) {
    await f.state.write('public-01', state);
    const connects = f.connects.length;
    await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_INSTANCE_RUNNING');
    assert.equal(f.connects.length, connects, 'decided from the saved state, without a connection');
    assert.equal(f.instances.get('public-01').deployment, 'native');
    assert.equal((await f.state.read('public-01')).status, state.status);
  }
  // really running
  await f.state.clear('public-01');
  const { runtime } = await f.manager.start('public-01');
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_INSTANCE_RUNNING');
  assert.ok(alive(runtime.pid));
  await f.manager.stop('public-01');
});

test('never a process and a container side by side: an orphan of the old deployment blocks the switch', { skip }, async t => {
  const f = await createDockerFixture(t);
  const instance = await f.installNative('public-01');
  // a core of this instance runs, but the saved state is lost
  const { runtime } = await f.manager.start('public-01');
  await f.state.clear('public-01');
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_INSTANCE_RUNNING');
  assert.equal(f.instances.get('public-01').deployment, 'native');
  process.kill(runtime.pid, 'SIGKILL');
  assert.ok(await until(() => !alive(runtime.pid)));
  await f.manager.setDeployment('public-01', { deployment: 'docker' });

  // docker -> native with a running container of this instance that the state does not know
  const orphan = await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'public-01', 'cod4x.control.run': RUN } });
  await rejects(f.manager.setDeployment('public-01', { deployment: 'native' }), 'REMOTE_INSTANCE_RUNNING');
  // a stopped leftover of this instance is removed by the switch
  await f.fake.patch(orphan, { status: 'exited' });
  await f.manager.setDeployment('public-01', { deployment: 'native' });
  assert.deepEqual(await f.fake.containers(), []);
  assert.equal(instance.id, 'public-01');
});

test('a foreign container under the name blocks the switch in both directions and is left alone', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.installNative('public-01');
  const foreign = await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'someone-else' }, status: 'exited' });
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  assert.equal(f.instances.get('public-01').deployment, 'native');
  await f.instances.setDeployment('public-01', 'docker');
  await rejects(f.manager.setDeployment('public-01', { deployment: 'native' }), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  assert.deepEqual((await f.fake.containers()).map(container => container.id), [foreign]);
  assert.ok(!(await f.fake.calls()).some(call => ['stop', 'rm'].includes(call[0])));
});

test('switching to docker needs the confirmed host and mount-safe paths; the image is asked for at the next start', { skip }, async t => {
  const f = await createDockerFixture(t, { ready: false });
  await f.installNative('public-01');
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_DOCKER_NOT_CONFIRMED');
  await f.confirm();
  await f.fake.set({ mode: 'ROOTLESS' });
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_DOCKER_MODE_CHANGED');
  await f.fake.set({ mode: 'ROOTFUL' });
  assert.equal((await f.manager.setDeployment('public-01', { deployment: 'docker' })).instance.deployment, 'docker');
  await rejects(f.manager.start('public-01'), 'REMOTE_DOCKER_IMAGE_MISSING');
  await f.buildImage();
  assert.equal((await f.manager.start('public-01')).runtime.status, 'RUNNING');
  await f.manager.stop('public-01');

  // a root with a comma: fine natively, refused for docker before the server is asked
  await fs.mkdir(f.loopback.path('odd,root'));
  await f.installNative('public-02', { remoteRoot: f.loopback.path('odd,root') });
  const connects = f.connects.length;
  await rejects(f.manager.setDeployment('public-02', { deployment: 'docker' }), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  assert.equal(f.connects.length, connects);
});

test('a switch racing another operation on the instance is refused as busy', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.installNative('public-01');
  const starting = f.manager.start('public-01');
  await rejects(f.manager.setDeployment('public-01', { deployment: 'docker' }), 'REMOTE_OPERATION_BUSY');
  await starting;
  await f.manager.stop('public-01');
  const switching = f.manager.setDeployment('public-01', { deployment: 'docker' });
  await rejects(f.manager.start('public-01'), 'REMOTE_OPERATION_BUSY');
  await switching;
  assert.equal(f.instances.get('public-01').deployment, 'docker');
  assert.equal(path.basename(f.instances.get('public-01').core.path), 'cod4x18_dedrun');
});
