import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDockerFixture } from './support/docker-fixture.mjs';
import { until } from './support/remote-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';

const skip = await loopbackAvailable() ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const HEX64 = /^[a-f0-9]{64}$/;
const runCalls = async f => (await f.fake.calls()).filter(call => call[0] === 'run');
const running = async f => (await f.fake.containers()).filter(container => container.status === 'running');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('start runs the core in a restricted container and reports RUNNING with a container id', { skip }, async t => {
  const f = await createDockerFixture(t);
  const instance = await f.install('public-01');
  assert.equal(instance.deployment, 'docker');
  const { runtime } = await f.manager.start('public-01');
  assert.equal(runtime.status, 'RUNNING');
  assert.match(runtime.containerId, HEX64);
  assert.deepEqual([runtime.pid, runtime.createdAt, runtime.recoveryBlocked], [null, null, false]);
  const [call] = await runCalls(f);
  const image = JSON.parse(await fs.readFile(path.join(f.fake.directory, 'images.json'), 'utf8'));
  const imageId = Object.values(image)[0].id;
  const uid = `${process.getuid()}:${process.getgid()}`;
  assert.deepEqual(call, ['run', '--detach', '--name', 'cod4x-public-01', '--label', 'cod4x.control.instance=public-01', '--label', `cod4x.control.run=${runtime.runId}`,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '1g',
    '--restart', 'no', '--network', 'bridge', '--user', uid, '--workdir', '/cod4/base',
    '--mount', `type=bind,source=${instance.basePath},target=/cod4/base,readonly`, '--mount', `type=bind,source=${instance.home}/core,target=/cod4/core,readonly`, '--mount', `type=bind,source=${instance.home},target=/cod4/home`, '--mount', `type=bind,source=${instance.home}/core,target=/cod4/home/core,readonly`,
    '--publish', `127.0.0.1:${instance.port}:${instance.port}/udp`, '--publish', `127.0.0.1:${instance.port}:${instance.port}/tcp`, imageId, '/cod4/core/cod4x18_dedrun',
    '+set', 'dedicated', '2', '+set', 'fs_basepath', '/cod4/base', '+set', 'fs_homepath', '/cod4/home', '+set', 'net_port', String(instance.port), '+set', 'net_ip', '0.0.0.0',
    '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', '::', '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot']);
  assert.ok(!call.some(argument => /rcon_password|sv_authtoken|password|token/i.test(argument)));
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.containerId, saved.pid], ['RUNNING', runtime.containerId, null]);
  assert.ok(f.audits.some(entry => entry.event === 'remote.instance.started' && entry.instanceId === 'public-01'));
  assert.equal(f.closes.length, f.connects.length, 'every connection was closed');
  await rejects(f.manager.start('public-01'), 'REMOTE_ALREADY_RUNNING');
  assert.equal((await running(f)).length, 1);
});

test('a rootless host runs the container as user 0, and a public network publishes on every IPv4 address', { skip }, async t => {
  const f = await createDockerFixture(t, { mode: 'ROOTLESS' });
  const instance = await f.install('public-01');
  await f.manager.start('public-01');
  let [call] = await runCalls(f);
  assert.equal(call[call.indexOf('--user') + 1], '0:0');
  await f.manager.stop('public-01');
  await f.instances.setNetwork('public-01', { scope: 'PUBLIC', publicAddress: '203.0.113.7' });
  await f.manager.start('public-01');
  call = (await runCalls(f))[1];
  // the public address of an instance is how the master sees it, not an address of the server: all IPv4 addresses are published
  assert.deepEqual(call.filter((_, index) => call[index - 1] === '--publish'), [`0.0.0.0:${instance.port}:${instance.port}/udp`, `0.0.0.0:${instance.port}:${instance.port}/tcp`]);
});

test('stop removes the container; restart creates a new one and keeps every file', { skip }, async t => {
  const f = await createDockerFixture(t);
  const instance = await f.install('public-01');
  const first = (await f.manager.start('public-01')).runtime;
  const starts = `${instance.home}/players/core-starts.txt`;
  assert.ok(await until(async () => (await fs.readFile(starts, 'utf8').catch(() => '')) === 'start\n'));
  await fs.writeFile(`${instance.home}/players/profile.dat`, Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(`${instance.home}/mods/readme.txt`, 'mod');
  const second = (await f.manager.restart('public-01')).runtime;
  assert.equal(second.status, 'RUNNING');
  assert.notEqual(second.containerId, first.containerId);
  assert.ok(await until(async () => (await fs.readFile(starts, 'utf8')) === 'start\nstart\n'), 'the new container sees what the old one wrote');
  assert.deepEqual(await fs.readFile(`${instance.home}/players/profile.dat`), Buffer.from([0, 1, 2, 255]));
  assert.equal(await fs.readFile(`${instance.home}/mods/readme.txt`, 'utf8'), 'mod');
  assert.deepEqual((await f.fake.containers()).map(container => container.id), [second.containerId], 'the old container is gone');
  const stopped = (await f.manager.stop('public-01')).runtime;
  assert.deepEqual([stopped.status, stopped.pid, 'containerId' in stopped], ['STOPPED', null, false]);
  assert.deepEqual(await f.fake.containers(), []);
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'STOPPED');
  await f.manager.start('public-01');
  assert.ok(await until(async () => (await fs.readFile(starts, 'utf8')) === 'start\nstart\nstart\n'));
});

test('a core that ignores SIGTERM is killed by docker stop after the grace period', { skip }, async t => {
  const f = await createDockerFixture(t, { ignoreTerm: true });
  await f.install('public-01');
  await f.manager.start('public-01');
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'STOPPED');
  assert.deepEqual(await f.fake.containers(), []);
  const stop = (await f.fake.calls()).find(call => call[0] === 'stop');
  assert.deepEqual(stop.slice(0, 3), ['stop', '--time', '1'], 'the grace period of the manager, in whole seconds');
});

test('start is refused before any state is written: host not confirmed, image missing or outdated, mode changed, core changed', { skip }, async t => {
  const f = await createDockerFixture(t, { ready: false });
  await f.confirm();
  const instance = await f.install('public-01');
  const refused = async code => { await rejects(f.manager.start('public-01'), code); assert.equal(await f.state.read('public-01'), null); assert.deepEqual(await runCalls(f), []); };
  await f.hostStore.setDocker('lab-1', null); // the confirmation is withdrawn after the install
  await refused('REMOTE_DOCKER_NOT_CONFIRMED');
  await f.confirm();
  await refused('REMOTE_DOCKER_IMAGE_MISSING');
  await f.buildImage();
  await f.fake.set({ mode: 'ROOTLESS' });
  await refused('REMOTE_DOCKER_MODE_CHANGED');
  await f.fake.set({ mode: 'NO_DOCKER' });
  await refused('REMOTE_DOCKER_UNAVAILABLE');
  await f.fake.set({ mode: 'ROOTFUL' });
  await fs.appendFile(instance.core.path, 'x');
  await refused('REMOTE_CORE_CHANGED');
});

test('a container under the name with foreign labels is never stopped, removed or adopted', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  for (const labels of [{}, { 'cod4x.control.instance': 'public-02' }]) {
    for (const status of ['running', 'exited']) {
      const foreign = await f.fake.addForeign('cod4x-public-01', { labels, status });
      await rejects(f.manager.start('public-01'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
      assert.equal(await f.state.read('public-01'), null, 'nothing was started');
      await rejects(f.manager.restart('public-01'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
      assert.deepEqual((await f.fake.containers()).map(container => container.id), [foreign], 'still there');
      assert.ok(!(await f.fake.calls()).some(call => ['stop', 'rm', 'run'].includes(call[0])));
      await fs.rm(path.join(f.fake.directory, `container-${foreign}.json`));
    }
  }
  // recover: the saved state says a start was interrupted, the container under the name is not ours
  await f.state.write('public-01', { status: 'STARTING', runId: '0123abcd-0123-0123-0123-0123456789ab', pid: null, createdAt: null, startedAt: new Date().toISOString(), recoveryBlocked: true, exitReason: null });
  const foreign = await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'other' } });
  await rejects(f.manager.recover('public-01'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  await rejects(f.manager.stop('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  assert.deepEqual((await f.fake.containers()).map(container => container.id), [foreign]);
  assert.ok(!(await f.fake.calls()).some(call => ['stop', 'rm'].includes(call[0])));
});

test('a leftover stopped container of this instance is replaced by the next start', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  const old = await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'public-01', 'cod4x.control.run': 'x' }, status: 'exited' });
  const { runtime } = await f.manager.start('public-01');
  assert.deepEqual((await f.fake.containers()).map(container => container.id), [runtime.containerId]);
  assert.notEqual(runtime.containerId, old);
});

test('a running container of this instance that the saved state does not know blocks the start', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  const orphan = await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'public-01', 'cod4x.control.run': '0123abcd-0123-0123-0123-0123456789ab' } });
  await rejects(f.manager.start('public-01'), 'REMOTE_DOCKER_CONTAINER_EXISTS');
  assert.deepEqual((await f.fake.containers()).map(container => container.id), [orphan]);
});

test('the connection drops after docker run was sent: blocked, never a second container, recover adopts the right run only', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  f.fake.dropAnswerOf('docker run ');
  await rejects(f.manager.start('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.recoveryBlocked, 'containerId' in saved], ['STARTING', true, false]);
  assert.equal((await running(f)).length, 1, 'the container was created on the server');
  await rejects(f.manager.start('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  await rejects(f.manager.restart('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  assert.equal((await runCalls(f)).length, 1, 'no second docker run');
  const [container] = await running(f);
  const recovered = (await f.manager.recover('public-01')).runtime;
  assert.deepEqual([recovered.status, recovered.containerId, recovered.recoveryBlocked], ['RUNNING', container.id, false]);
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'STOPPED');

  // nothing was created: recover records STOPPED
  await f.state.write('public-01', { ...saved });
  assert.equal((await f.manager.recover('public-01')).runtime.status, 'STOPPED');
  // a running container of this instance from another run is not adopted
  await f.state.write('public-01', { ...saved });
  await f.fake.addForeign('cod4x-public-01', { labels: { 'cod4x.control.instance': 'public-01', 'cod4x.control.run': 'ffffffff-0123-0123-0123-0123456789ab' } });
  await rejects(f.manager.recover('public-01'), 'REMOTE_RECOVERY_AMBIGUOUS');
  assert.equal((await f.fake.containers()).length, 1);
});

test('docker run fails: the start fails cleanly and a created-but-not-started container of this run is removed', { skip }, async t => {
  const f = await createDockerFixture(t);
  const instance = await f.install('public-01');
  // the image disappears between the check and the run
  const images = path.join(f.fake.directory, 'images.json');
  const stored = await fs.readFile(images, 'utf8');
  const original = f.fake.session.exec;
  f.fake.session.exec = async (command, options) => { if (command.startsWith('docker run ')) await fs.writeFile(images, '{}'); return original(command, options); };
  await rejects(f.manager.start('public-01'), 'REMOTE_START_FAILED');
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.exitReason, saved.recoveryBlocked], ['FAILED', 'START_FAILED', false]);
  assert.deepEqual(await f.fake.containers(), []);
  await fs.writeFile(images, stored);
  f.fake.session.exec = original;
  assert.equal((await f.manager.start('public-01')).runtime.status, 'RUNNING');
  assert.equal(instance.deployment, 'docker');
});

test('the container exits by itself: FAILED with the exit code, or OOM_KILLED, and the next start works', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  let { runtime } = await f.manager.start('public-01');
  const [container] = await f.fake.containers();
  process.kill(Number(await fs.readFile(path.join(container.dir, 'pid'), 'utf8')), 'SIGKILL');
  assert.ok(await until(() => !alive(container.supervisor)));
  let status = (await f.manager.status('public-01')).runtime;
  assert.deepEqual([status.status, status.exitReason], ['FAILED', 'EXITED_137']);
  assert.equal(status.containerId, runtime.containerId, 'kept so its output can still be read');
  assert.match((await f.manager.logs('public-01')).stdout, /fs_homepath/);
  ({ runtime } = await f.manager.start('public-01'));
  assert.equal(runtime.status, 'RUNNING');
  await f.fake.patch(runtime.containerId, { status: 'exited', exitCode: 137, oomKilled: true });
  status = (await f.manager.status('public-01')).runtime;
  assert.deepEqual([status.status, status.exitReason], ['FAILED', 'OOM_KILLED']);
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'FAILED', 'nothing to stop');
});

test('docker cannot be asked: the state is kept and nothing is acted on', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  await f.fake.set({ failInspect: true });
  assert.equal((await f.manager.status('public-01')).runtime.status, 'RUNNING');
  await rejects(f.manager.stop('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  await rejects(f.manager.restart('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  assert.deepEqual((await running(f)).map(container => container.id), [runtime.containerId]);
  await f.fake.set({ failInspect: false });
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'STOPPED');
});

test('logs of the container are bounded, valid text with secrets blacked out', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  assert.deepEqual(await f.manager.logs('public-01'), { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, console: '', consoleTruncated: false });
  await f.manager.start('public-01');
  const [container] = await f.fake.containers();
  let logs = await f.manager.logs('public-01');
  assert.match(logs.stdout, /fs_homepath\n/); // the scripted docker runs the core with the host paths
  assert.match(logs.stderr, /fixture stderr/);
  assert.equal(logs.stdoutTruncated, false);
  const noise = Buffer.alloc(2 * 1024 * 1024, 0xfe);
  await fs.writeFile(path.join(container.dir, 'stdout'), Buffer.concat([noise, Buffer.from('\nset rcon_password "hunter2secret"\nlast line\n')]));
  logs = await f.manager.logs('public-01', { limit: 4096 });
  assert.ok(Buffer.byteLength(logs.stdout) <= 4096 * 3, 'bounded');
  assert.equal(logs.stdoutTruncated, true);
  assert.ok(logs.stdout.endsWith('last line\n'));
  assert.ok(!logs.stdout.includes('hunter2secret'));
  assert.equal(Buffer.from(logs.stdout).toString('utf8'), logs.stdout);
  await rejects(f.manager.logs('public-01', { limit: 2 * 1024 * 1024 }), 'REMOTE_ARGUMENT_INVALID');
});

test('health asks the server through the port published on loopback', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  assert.deepEqual(await f.manager.health('public-01'), { process: 'GONE', getinfo: 'SKIPPED' });
  await f.manager.start('public-01');
  let health;
  assert.ok(await until(async () => (health = await f.manager.health('public-01')).getinfo === 'OK', 5000), JSON.stringify(health));
  assert.deepEqual([health.process, health.hostname, health.map], ['ALIVE', 'container', 'mp_backlot']);
});

test('updateCore, writeConfig and restoreBackup are refused while the container runs', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  await f.manager.start('public-01');
  await rejects(f.manager.updateCore('public-01', { corePath: f.corePath, coreVersion: '21.5', expectedCoreSha256: f.coreSha256 }), 'REMOTE_INSTANCE_RUNNING');
  const config = await f.manager.readConfig('public-01');
  await rejects(f.manager.writeConfig('public-01', { text: config.text, expectedSha256: config.sha256 }), 'REMOTE_INSTANCE_RUNNING');
  await f.manager.stop('public-01');
  await f.manager.updateCore('public-01', { corePath: f.corePath, coreVersion: '21.5', expectedCoreSha256: f.coreSha256 });
});

test('statusAll reports docker and native instances of one host over one connection', { skip }, async t => {
  const f = await createDockerFixture(t);
  await f.install('public-01');
  await f.installNative('public-02');
  await f.manager.start('public-01'); await f.manager.start('public-02');
  const before = f.connects.length;
  const all = await f.manager.statusAll();
  assert.equal(f.connects.length, before + 1);
  assert.deepEqual(all.map(entry => [entry.instance.id, entry.instance.deployment, entry.runtime.status]), [['public-01', 'docker', 'RUNNING'], ['public-02', 'native', 'RUNNING']]);
  assert.ok(all[0].runtime.containerId && all[1].runtime.pid);
  await f.manager.stop('public-01'); await f.manager.stop('public-02');
});

test('the RCON password reaches the container through the private file, never through the run line', { skip }, async t => {
  const provisioned = [];
  const f = await createDockerFixture(t, { managerOptions: {
    credentials: { async withRuntimeCredentials(id, action) { return action({ rcon: Buffer.from('hunter2secret') }); } },
    onProvisioned: (id, runId, info) => provisioned.push({ id, runId, ...info }),
  } });
  const instance = await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  const [call] = await runCalls(f);
  const name = `rcon-${runtime.runId}.cfg`;
  assert.ok(call.includes(name) && call.indexOf(name) < call.indexOf('server.cfg'), 'exec of the file before server.cfg');
  assert.ok(!call.some(argument => argument.includes('hunter2secret')));
  assert.ok(!JSON.stringify(await f.fake.containers()).includes('hunter2secret'), 'not in a label or any other container setting');
  assert.deepEqual((await fs.readdir(`${instance.home}/main`)).filter(file => /^rcon-/.test(file)), [], 'the file is removed once the core has read it');
  assert.deepEqual(provisioned, [{ id: 'public-01', runId: runtime.runId, rcon: true }]);
  assert.match((await f.manager.logs('public-01')).stdout, /rcon password provisioned/);
});
