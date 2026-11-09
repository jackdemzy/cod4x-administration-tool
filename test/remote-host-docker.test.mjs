import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteHostStore } from '../lib/remote-host-store.mjs';
import { RemoteHostService, DOCKER_ROOTFUL_CONFIRMATION, assertDockerReady } from '../lib/remote-host-service.mjs';
import { DOCKERFILE, DOCKERFILE_SHA256, IMAGE_TAG } from '../lib/docker-image.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';
import { installFakeDocker } from './support/docker-fixture.mjs';

const skip = await loopbackAvailable() ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

// Real host store and service; the connection is the loopback server with the scripted docker.
async function fixture(t, { mode = 'ROOTFUL', docker = true } = {}) {
  const loopback = await createLoopbackServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-host-docker-'));
  t.after(async () => { await loopback.cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  const fake = docker ? await installFakeDocker(loopback, { mode }) : null;
  const store = new RemoteHostStore({ file: path.join(root, 'hosts.json') });
  await store.load();
  await store.create({ id: 'lab-1', label: 'Lab', host: 'lab.example.org', port: 22, username: 'cod4x' });
  const audits = [], closes = [];
  const service = new RemoteHostService({ store, credentials: null, audit: (level, event, details) => audits.push({ level, event, ...details }) });
  service.connect = async () => {
    const session = Object.create(fake ? fake.session : loopback.session);
    // without the fake, `docker` must not be found even where a real one is installed
    if (!fake) session.exec = (command, options) => loopback.session.exec(`PATH=/nonexistent; ${command}`, options);
    session.close = () => { closes.push(1); };
    return { session, uid: process.getuid(), gid: process.getgid() };
  };
  return { service, store, fake, audits, closes, loopback };
}

test('status tells rootful, rootless and no docker apart and carries the matching note', { skip }, async t => {
  const rootful = await fixture(t);
  assert.deepEqual(await rootful.service.dockerStatus('lab-1'), { mode: 'ROOTFUL', version: '29.0.0', confirmed: false, image: 'MISSING', note: 'ROOTFUL_ROOT_EQUIVALENT' });
  const rootless = await fixture(t, { mode: 'ROOTLESS' });
  assert.deepEqual(await rootless.service.dockerStatus('lab-1'), { mode: 'ROOTLESS', version: '29.0.0', confirmed: false, image: 'MISSING', note: 'ROOTLESS_SOURCE_ADDRESS' });
  const down = await fixture(t, { mode: 'NO_DOCKER' });
  assert.deepEqual(await down.service.dockerStatus('lab-1'), { mode: 'NO_DOCKER', version: null, confirmed: false, image: null, note: null });
  const none = await fixture(t, { docker: false });
  assert.deepEqual(await none.service.dockerStatus('lab-1'), { mode: 'NO_DOCKER', version: null, confirmed: false, image: null, note: null });
  assert.equal(rootful.closes.length, 1, 'the connection was closed');
});

test('the docker group needs the exact confirmation; rootless does not', { skip }, async t => {
  const rootful = await fixture(t);
  for (const confirm of [undefined, '', 'yes', 'docker_root_equivalent', 'PUBLIC_EXPOSURE']) await rejects(rootful.service.confirmDocker('lab-1', { confirm }), 'REMOTE_DOCKER_CONFIRMATION_REQUIRED');
  await rejects(rootful.service.confirmDocker('lab-1'), 'REMOTE_DOCKER_CONFIRMATION_REQUIRED');
  assert.equal(rootful.store.get('lab-1').docker, null);
  assert.equal(DOCKER_ROOTFUL_CONFIRMATION, 'DOCKER_ROOT_EQUIVALENT');
  const host = await rootful.service.confirmDocker('lab-1', { confirm: DOCKER_ROOTFUL_CONFIRMATION });
  assert.equal(host.docker.mode, 'ROOTFUL');
  assert.match(host.docker.confirmedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await rootful.service.dockerStatus('lab-1')).confirmed, true);
  assert.ok(rootful.audits.some(entry => entry.event === 'remote.host.docker_confirmed' && entry.mode === 'ROOTFUL'));

  const rootless = await fixture(t, { mode: 'ROOTLESS' });
  assert.equal((await rootless.service.confirmDocker('lab-1', {})).docker.mode, 'ROOTLESS');
});

test('no docker: nothing can be confirmed or built', { skip }, async t => {
  for (const options of [{ mode: 'NO_DOCKER' }, { docker: false }]) {
    const f = await fixture(t, options);
    await rejects(f.service.confirmDocker('lab-1', { confirm: DOCKER_ROOTFUL_CONFIRMATION }), 'REMOTE_DOCKER_UNAVAILABLE');
    await rejects(f.service.buildDockerImage('lab-1'), 'REMOTE_DOCKER_NOT_CONFIRMED');
    assert.equal(f.store.get('lab-1').docker, null);
  }
});

test('build sends the Dockerfile on stdin without a context and the status then shows the image', { skip }, async t => {
  const f = await fixture(t);
  await rejects(f.service.buildDockerImage('lab-1'), 'REMOTE_DOCKER_NOT_CONFIRMED');
  await f.service.confirmDocker('lab-1', { confirm: DOCKER_ROOTFUL_CONFIRMATION });
  const built = await f.service.buildDockerImage('lab-1');
  assert.equal(built.tag, IMAGE_TAG);
  assert.match(built.id, /^sha256:[a-f0-9]{64}$/);
  const build = (await f.fake.calls()).find(call => call[0] === 'build');
  assert.deepEqual(build, ['build', '--quiet', '--tag', IMAGE_TAG, '--label', `cod4x.control.dockerfile=${DOCKERFILE_SHA256}`, '-']);
  assert.ok(DOCKERFILE.startsWith('FROM '));
  assert.equal((await f.service.dockerStatus('lab-1')).image, 'PRESENT');
  assert.ok(f.audits.some(entry => entry.event === 'remote.host.docker_image_built'));
});

test('a failed build is reported by code only', { skip }, async t => {
  const f = await fixture(t);
  await f.service.confirmDocker('lab-1', { confirm: DOCKER_ROOTFUL_CONFIRMATION });
  await f.fake.set({ failBuild: true });
  await rejects(f.service.buildDockerImage('lab-1'), 'REMOTE_DOCKER_BUILD_FAILED');
  assert.equal((await f.service.dockerStatus('lab-1')).image, 'MISSING');
  const entry = f.audits.find(audit => audit.event === 'remote.host.docker_image_build_failed');
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'event', 'hostId', 'level']);
});

test('assertDockerReady: confirmed mode unchanged and the image built from this Dockerfile', { skip }, async t => {
  const f = await fixture(t);
  const { session } = await f.service.connect('lab-1');
  await rejects(assertDockerReady(session, f.store.get('lab-1')), 'REMOTE_DOCKER_NOT_CONFIRMED');
  await f.service.confirmDocker('lab-1', { confirm: DOCKER_ROOTFUL_CONFIRMATION });
  await rejects(assertDockerReady(session, f.store.get('lab-1')), 'REMOTE_DOCKER_IMAGE_MISSING');
  assert.deepEqual(await assertDockerReady(session, f.store.get('lab-1'), { image: false }), { mode: 'ROOTFUL', imageId: null });
  const built = await f.service.buildDockerImage('lab-1');
  assert.deepEqual(await assertDockerReady(session, f.store.get('lab-1')), { mode: 'ROOTFUL', imageId: built.id });
  // the tag exists but was built from another Dockerfile
  const images = path.join(f.fake.directory, 'images.json');
  const stored = JSON.parse(await fs.readFile(images, 'utf8'));
  stored[IMAGE_TAG].labels['cod4x.control.dockerfile'] = 'd'.repeat(64);
  await fs.writeFile(images, JSON.stringify(stored));
  await rejects(assertDockerReady(session, f.store.get('lab-1')), 'REMOTE_DOCKER_IMAGE_MISSING');
  assert.equal((await f.service.dockerStatus('lab-1')).image, 'OUTDATED');
  // the host changes from the docker group to rootless after the confirmation
  await f.fake.set({ mode: 'ROOTLESS' });
  await rejects(assertDockerReady(session, f.store.get('lab-1')), 'REMOTE_DOCKER_MODE_CHANGED');
  await f.fake.set({ mode: 'NO_DOCKER' });
  await rejects(assertDockerReady(session, f.store.get('lab-1')), 'REMOTE_DOCKER_UNAVAILABLE');
});
