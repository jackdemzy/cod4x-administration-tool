import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { e2eBackend } from './support/e2e-backend.mjs';
import { matchArtifacts } from '../scripts/release-lib.mjs';

// Block 23 (4.18.30) installer gate, Windows: silent NSIS install, first run of the installed
// backend (the installed "COD4X CONTROL.exe" with ELECTRON_RUN_AS_NODE=1 and
// resources\app.asar\installer-server.mjs, as electron-main.cjs starts it), silent uninstall.
// Core discovery and server start need a real Windows core and stay manual (checklist).
// Runs only on Windows with COD4X_RELEASE_DIR; then a missing installer is a failure.
const releaseDir = process.env.COD4X_RELEASE_DIR;
const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const skip = process.platform !== 'win32' ? 'Windows only' : !releaseDir ? 'COD4X_RELEASE_DIR not set (no release build to test)' : false;
const EXE = 'COD4X CONTROL.exe';
const UNINSTALLER = 'Uninstall COD4X CONTROL.exe';
const waitFor = async (predicate, ms) => { for (const end = Date.now() + ms; Date.now() < end; await delay(500)) if (predicate()) return true; return predicate(); };

test('Windows NSIS: silent install, first run, silent uninstall', { skip, timeout: 600000 }, async t => {
  assert.ok(existsSync(releaseDir), `${releaseDir} not found`);
  const { files, missing } = matchArtifacts(readdirSync(releaseDir), 'win', version);
  assert.deepEqual(missing, [], `artifacts for ${version} missing in ${releaseDir}`);
  const setup = path.join(releaseDir, files.find(name => name.includes('-Setup-')));

  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-nsis-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'app');
  // NSIS takes /D= as the last argument, unquoted, so the path must not contain spaces.
  assert.doesNotMatch(target, /\s/, `install path must not contain spaces: ${target}`);

  // Installation
  const installed = spawnSync(setup, ['/S', `/D=${target}`], { windowsVerbatimArguments: true, timeout: 300000 });
  assert.equal(installed.status, 0, `setup exit ${installed.status} ${installed.error?.message || ''}`);
  const exe = path.join(target, EXE);
  assert.ok(await waitFor(() => existsSync(exe), 60000), `${exe} not installed`);
  const asar = path.join(target, 'resources', 'app.asar');
  assert.ok(existsSync(asar), 'resources\\app.asar missing');
  assert.ok(existsSync(path.join(target, UNINSTALLER)), 'uninstaller missing');

  // First Run of the installed backend with an empty data root.
  const backend = await e2eBackend(t, { prefix: 'cod4x-nsis-run-', server: { command: exe, args: [path.join(asar, 'installer-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const health = await backend.request('/api/installer/health');
  assert.equal(health.status, 200);
  assert.equal(health.json?.service, 'cod4x-control-installer');
  await backend.assertAlive('first run');
  await backend.stop();

  // Uninstall: the NSIS uninstaller copies itself to TEMP and returns at once, so wait for it.
  const removed = spawnSync(path.join(target, UNINSTALLER), ['/S'], { timeout: 300000 });
  assert.equal(removed.status, 0, `uninstall exit ${removed.status} ${removed.error?.message || ''}`);
  assert.ok(await waitFor(() => !existsSync(target), 120000), `install folder still present after uninstall: ${existsSync(target) ? readdirSync(target).join(', ') : ''}`);
});
