import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  containerName, dockerProbeCommand, parseDockerProbe, imageInspectCommand, parseImageInspect, imageBuildCommand,
  runContainerCommand, parseContainerId, inspectContainerCommand, parseContainerInspect, stopContainerCommand,
  removeContainerCommand, containerLogsCommand, assertDockerMountPath,
} from '../lib/docker-commands.mjs';

const code = fn => { try { fn(); return null; } catch (error) { return error.code || 'THROWN'; } };
const RUN = '0b1c2d3e-4f50-4a61-8b72-9c8d0e1f2a3b';
const ID = 'a'.repeat(64);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const base = {
  instanceId: 'public-01', runId: RUN, image: IMAGE, user: '1000:1000', basePath: '/srv/cod4', home: '/srv/servers/public-01',
  port: 28960, publish: ['127.0.0.1'], args: ['+set', 'dedicated', '2'],
};

test('containerName derives the name from a valid instance id only', () => {
  assert.equal(containerName('public-01'), 'cod4x-public-01');
  for (const bad of ['a;b', 'a b', '$(x)', '', 'A', '-a', null, 'a'.repeat(49)]) assert.equal(code(() => containerName(bad)), 'REMOTE_ARGUMENT_INVALID', String(bad));
});

test('runContainerCommand is one fixed line', () => {
  assert.equal(runContainerCommand(base), [
    'docker run --detach --name cod4x-public-01',
    "--label cod4x.control.instance=public-01 --label cod4x.control.run=0b1c2d3e-4f50-4a61-8b72-9c8d0e1f2a3b",
    '--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g',
    '--log-driver local --log-opt max-size=10m --log-opt max-file=3',
    '--restart no --network bridge --user 1000:1000 --workdir /cod4/base',
    "--mount 'type=bind,source=/srv/cod4,target=/cod4/base,readonly'",
    "--mount 'type=bind,source=/srv/servers/public-01/core,target=/cod4/core,readonly'",
    "--mount 'type=bind,source=/srv/servers/public-01,target=/cod4/home'",
    "--mount 'type=bind,source=/srv/servers/public-01/core,target=/cod4/home/core,readonly'",
    '--publish 127.0.0.1:28960:28960/udp --publish 127.0.0.1:28960:28960/tcp',
    `${IMAGE} /cod4/core/cod4x18_dedrun '+set' 'dedicated' '2'`,
  ].join(' '));
  const both = runContainerCommand({ ...base, publish: ['127.0.0.1', '203.0.113.7'] });
  assert.ok(both.includes('--publish 127.0.0.1:28960:28960/udp --publish 127.0.0.1:28960:28960/tcp --publish 203.0.113.7:28960:28960/udp --publish 203.0.113.7:28960:28960/tcp'));
});

test('no builder grants more than the fixed flags', () => {
  const lines = [
    dockerProbeCommand(), imageInspectCommand('cod4x-control-runtime:0123456789abcdef'), imageBuildCommand({ tag: 'cod4x-control-runtime:0123456789abcdef', dockerfileSha256: 'c'.repeat(64) }),
    runContainerCommand(base), inspectContainerCommand(ID), inspectContainerCommand('cod4x-public-01'), stopContainerCommand(ID, 10), removeContainerCommand(ID),
    containerLogsCommand(ID, 'stdout', 100), containerLogsCommand(ID, 'stderr', 100),
  ];
  for (const line of lines) {
    assert.match(line, /^(LC_ALL=C )?docker /, line);
    for (const forbidden of ['--privileged', '--network host', '--net=host', 'docker.sock', ' -e ', '--env', ' -v ', '--volume', '--cap-add', '--device', '--pid ', '--pid=', '--ipc', '--userns'])
      assert.ok(!line.includes(forbidden), `${forbidden} in ${line}`);
  }
});

test('hostile values are refused with a named code', () => {
  const bad = (change, expected) => assert.equal(code(() => runContainerCommand({ ...base, ...change })), expected, JSON.stringify(change));
  for (const instanceId of ['a;b', 'a b', '$(x)']) bad({ instanceId }, 'REMOTE_ARGUMENT_INVALID');
  for (const runId of ['x', `${RUN};id`, '', null]) bad({ runId }, 'REMOTE_ARGUMENT_INVALID');
  for (const port of [0, 70000, '28960', 1.5]) bad({ port }, 'REMOTE_ARGUMENT_INVALID');
  for (const publish of [[], ['0.0.0.0; rm -rf /'], ['::1'], ['localhost'], '127.0.0.1', ['127.0.0.1', 5]]) bad({ publish }, 'REMOTE_ARGUMENT_INVALID');
  for (const user of ['root', '0', '1000:1000 --privileged', '']) bad({ user }, 'REMOTE_ARGUMENT_INVALID');
  for (const image of ['debian', 'sha256:xyz', `${IMAGE} --privileged`]) bad({ image }, 'REMOTE_ARGUMENT_INVALID');
  for (const home of ['/srv/a,b', '/srv/a"b']) bad({ home }, 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  for (const home of ['/srv/a\nb', '/srv/../etc', 'srv/x', '/srv//x']) bad({ home }, 'REMOTE_PATH_INVALID');
  bad({ basePath: '/srv/a,b' }, 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  bad({ args: 'x' }, 'REMOTE_ARGUMENT_INVALID');
  bad({ args: [5] }, 'REMOTE_ARGUMENT_INVALID');
  bad({ args: Array(300).fill('x') }, 'REMOTE_ARGUMENT_INVALID');
  for (const ref of ['abc', `${ID}0`, 'cod4x-a;b', 'other-name', `${ID} ${ID}`, null]) assert.equal(code(() => inspectContainerCommand(ref)), 'REMOTE_ARGUMENT_INVALID', String(ref));
  for (const fn of [() => stopContainerCommand('cod4x-public-01', 10), () => removeContainerCommand('cod4x-public-01'), () => stopContainerCommand(ID, 0), () => stopContainerCommand(ID, 500),
    () => containerLogsCommand(ID, 'both', 10), () => containerLogsCommand(ID, 'stdout', 0), () => containerLogsCommand(ID, 'stdout', 2_000_000),
    () => imageInspectCommand('debian; id'), () => imageBuildCommand({ tag: 'cod4x-control-runtime:0123456789abcdef', dockerfileSha256: 'x' })])
    assert.equal(code(fn), 'REMOTE_ARGUMENT_INVALID');
});

test('paths with spaces and quotes, and core arguments with shell characters, arrive unchanged', () => {
  const args = ['+set', 'sv_hostname', "it's $(id) `x` ; \"q\"", 'a b'];
  const line = runContainerCommand({ ...base, basePath: "/srv/my games/it's", args });
  // run the line with `docker` replaced by a printer of its arguments
  const printed = execFileSync('sh', ['-c', `docker() { printf '%s\\n' "$@"; }; ${line}`], { encoding: 'utf8' }).split('\n').slice(0, -1);
  assert.deepEqual(printed.slice(-args.length), args);
  assert.ok(printed.includes("type=bind,source=/srv/my games/it's,target=/cod4/base,readonly"));
  assert.equal(printed[printed.length - args.length - 1], '/cod4/core/cod4x18_dedrun');
});

test('assertDockerMountPath', () => {
  assert.equal(assertDockerMountPath('/srv/x y/'), '/srv/x y');
  assert.equal(code(() => assertDockerMountPath('/srv/x,y')), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  assert.equal(code(() => assertDockerMountPath('/srv/x"y')), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  assert.equal(code(() => assertDockerMountPath('relative')), 'REMOTE_PATH_INVALID');
});

test('parseDockerProbe tells rootless, rootful and no docker apart', () => {
  const out = text => ({ code: 0, stdout: Buffer.from(text) });
  assert.deepEqual(parseDockerProbe(out('29.9.2 ["name=seccomp,profile=builtin","name=cgroupns"]\n')), { mode: 'ROOTFUL', version: '29.9.2' });
  assert.deepEqual(parseDockerProbe(out('27.3.1 ["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n')), { mode: 'ROOTLESS', version: '27.3.1' });
  assert.deepEqual(parseDockerProbe(out('24.0.7 null\n')), { mode: 'ROOTFUL', version: '24.0.7' });
  const none = { mode: 'NO_DOCKER', version: null };
  assert.deepEqual(parseDockerProbe({ code: 127, stdout: Buffer.alloc(0) }), none);
  assert.deepEqual(parseDockerProbe({ code: 1, stdout: Buffer.from(' null\n') }), none);
  for (const garbage of ['', 'hello', '29.9.2', '29.9.2 [oops', '29.9.2 {"a":1}', '29.9.2 ["x"]\nmore\n', '; rm ["x"]\n']) assert.deepEqual(parseDockerProbe(out(garbage)), none, garbage);
});

test('parseContainerId and parseContainerInspect', () => {
  assert.equal(parseContainerId(Buffer.from(`${ID}\n`)), ID);
  for (const bad of ['', ID, `${ID}\n\n`, `x${ID}\n`, 'abc\n']) assert.equal(code(() => parseContainerId(Buffer.from(bad))), 'REMOTE_DOCKER_START_FAILED');
  const line = (status, exit, oom, extra = {}) => Buffer.from(`${JSON.stringify([extra.id ?? ID, '/cod4x-public-01', extra.instance ?? 'public-01', RUN, IMAGE, status, exit, oom])}\n`);
  assert.deepEqual(parseContainerInspect({ code: 0, stdout: line('running', 0, false), stderr: Buffer.alloc(0) }),
    { id: ID, name: 'cod4x-public-01', instance: 'public-01', run: RUN, image: IMAGE, status: 'running', exitCode: 0, oomKilled: false });
  assert.deepEqual(parseContainerInspect({ code: 0, stdout: line('exited', 137, true, { instance: '' }), stderr: Buffer.alloc(0) }).instance, '');
  assert.equal(parseContainerInspect({ code: 0, stdout: line('exited', 137, true), stderr: Buffer.alloc(0) }).oomKilled, true);
  // a container without labels: a real daemon prints null for a missing label
  const bare = parseContainerInspect({ code: 0, stdout: Buffer.from(`${JSON.stringify([ID, '/cod4x-public-01', null, null, IMAGE, 'running', 0, false])}\n`), stderr: Buffer.alloc(0) });
  assert.deepEqual([bare.instance, bare.run], ['', '']);
  assert.equal(parseContainerInspect({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Error response from daemon: No such container: cod4x-public-01\n') }), null);
  assert.equal(parseContainerInspect({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('error: no such object: x\n') }), null);
  const failing = [
    { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Cannot connect to the Docker daemon\n') },
    { code: 0, stdout: Buffer.from('garbage'), stderr: Buffer.alloc(0) },
    { code: 0, stdout: line('running', 0, false, { id: 'short' }), stderr: Buffer.alloc(0) },
    { code: 0, stdout: line('flying', 0, false), stderr: Buffer.alloc(0) },
    { code: 0, stdout: line('running', '0', false), stderr: Buffer.alloc(0) },
  ];
  for (const result of failing) assert.equal(code(() => parseContainerInspect(result)), 'REMOTE_DOCKER_INSPECT_FAILED');
  // no docker program at all is told apart from a daemon that does not answer
  assert.equal(code(() => parseContainerInspect({ code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from('docker: not found') })), 'REMOTE_DOCKER_NOT_INSTALLED');
});

test('parseImageInspect', () => {
  assert.deepEqual(parseImageInspect({ code: 0, stdout: Buffer.from(`${JSON.stringify([IMAGE, 'c'.repeat(64)])}\n`), stderr: Buffer.alloc(0) }), { id: IMAGE, dockerfile: 'c'.repeat(64) });
  assert.deepEqual(parseImageInspect({ code: 0, stdout: Buffer.from(`${JSON.stringify([IMAGE, ''])}\n`), stderr: Buffer.alloc(0) }), { id: IMAGE, dockerfile: '' });
  assert.equal(parseImageInspect({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Error response from daemon: No such image: x\n') }), null);
  assert.equal(code(() => parseImageInspect({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('permission denied') })), 'REMOTE_DOCKER_INSPECT_FAILED');
  assert.equal(code(() => parseImageInspect({ code: 0, stdout: Buffer.from('["x",""]\n'), stderr: Buffer.alloc(0) })), 'REMOTE_DOCKER_INSPECT_FAILED');
});
