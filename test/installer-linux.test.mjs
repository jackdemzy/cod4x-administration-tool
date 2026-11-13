import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildE2eCore, e2eCoreAvailable } from './support/e2e-core.mjs';
import { e2eBackend, baseGameFixture, consecutiveUdpPorts, answers, silent, ok, adoptCore, createInstance } from './support/e2e-backend.mjs';
import { matchArtifacts } from '../scripts/release-lib.mjs';

// Block 23 (4.18.30) installer gate, Linux: Installation + First Run + Core Discovery + Server Start
// against the backend packaged in the AppImage (not the source tree). The AppImage is unpacked
// with --appimage-extract (no FUSE needed) and its backend runs the way electron-main.cjs starts it:
// the packaged Electron binary with ELECTRON_RUN_AS_NODE=1 and resources/app.asar/installer-server.mjs.
// Runs only with COD4X_RELEASE_DIR; then a missing AppImage is a failure, not a skip.
const run = promisify(execFile);
const releaseDir = process.env.COD4X_RELEASE_DIR;
const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const coreSkip = await e2eCoreAvailable();
const skip = process.platform !== 'linux' ? 'Linux only'
  : !releaseDir ? 'COD4X_RELEASE_DIR not set (no release build to test)'
  : coreSkip || false;

test('Linux AppImage: install, first run, core discovery, server start', { skip, timeout: 300000 }, async t => {
  assert.ok(existsSync(releaseDir), `${releaseDir} not found`);
  const { files, missing } = matchArtifacts(readdirSync(releaseDir), 'linux', version);
  assert.deepEqual(missing, [], `no AppImage for ${version} in ${releaseDir}`);

  // Installation: an AppImage is installed by copying it and making it executable.
  const install = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-appimage-')));
  t.after(() => fs.rm(install, { recursive: true, force: true }));
  const image = path.join(install, files[0]);
  await fs.copyFile(path.join(releaseDir, files[0]), image);
  await fs.chmod(image, 0o755);
  await run(image, ['--appimage-extract'], { cwd: install, maxBuffer: 64 * 1024 * 1024 });
  const unpacked = path.join(install, 'squashfs-root');
  const binary = path.join(unpacked, 'cod4x-control');
  const script = path.join(unpacked, 'resources', 'app.asar', 'installer-server.mjs');
  assert.ok(existsSync(binary), 'packaged executable cod4x-control missing');
  assert.ok(existsSync(path.join(unpacked, 'resources', 'app.asar')), 'app.asar missing');

  // First Run: the packaged backend starts with an empty data root; admin and vault are set up.
  const backend = await e2eBackend(t, { prefix: 'cod4x-installer-', server: { command: binary, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const { request, assertAlive, root } = backend;
  const health = await request('/api/installer/health');
  ok(health, 'health');
  assert.equal(health.json?.service, 'cod4x-control-installer');
  await assertAlive('first run');

  // Core Discovery: adopt the core and let the preflight verify it.
  const core = await buildE2eCore(path.join(root, 'cores', 'e2e'));
  const baseGame = await baseGameFixture(root);
  await adoptCore(backend, { core, baseGame });
  const query = new URLSearchParams({ path: path.join(root, 'legacy-home'), executablePath: core, baseGamePath: baseGame, cod4x: '21.2', platform: 'linux' });
  const preflight = await request(`/api/runtime/preflight?${query}`);
  ok(preflight, 'core discovery');
  assert.equal(preflight.json.core.verified, true, JSON.stringify(preflight.json.core));
  await assertAlive('core discovery');

  // Server Start: one instance answers on its port, then stops.
  const [port] = await consecutiveUdpPorts(1);
  await createInstance(backend, { id: 'release-01', port, core, baseGame, hostname: 'Release Gate', rcon: 'ReleaseGateRcon2026' });
  ok(await request('/api/instances/release-01/start', {}), 'start');
  assert.ok(await answers(port, 10000), 'server does not answer on its port');
  ok(await request('/api/instances/release-01/stop', {}), 'stop');
  assert.ok(await silent(port), 'server still answers after stop');
  await assertAlive('server stop');
});
