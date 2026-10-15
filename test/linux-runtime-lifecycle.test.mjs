import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntimeManager } from '../lib/runtime-manager.mjs';
import { createLinuxRuntimeAdapter, assertLinuxInstanceOwnership } from '../lib/linux-runtime-adapter.mjs';

const exec = promisify(execFile);
test('shared Linux lifecycle verifies native PID, captures output, recovers and stops only owned process', { skip: process.platform !== 'linux' }, async () => {
  assert.notEqual(process.getuid(), 0);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-lifecycle-'));
  const executable = path.join(directory, 'cod4x18_dedrun');
  const homePath = path.join(directory, 'instance');
  const stateFile = path.join(homePath, 'runtime.json');
  const source = path.join(directory, 'fixture.c');
  // A real native test process, NOT a verified CoD4X Core or server-gate proof.
  await fs.writeFile(source, 'extern long write(int,const void*,unsigned long); extern int usleep(unsigned); int main(void){write(1,"fixture stdout\\n",15);write(2,"fixture stderr\\n",15);for(;;)usleep(100000);return 0;}');
  await exec('gcc', [source, '-o', executable]);
  const adapter = createLinuxRuntimeAdapter();
  const dependencies = { path, fs, crypto, process, spawn, execFileAsync: exec,
    linuxRuntimeAdapter: adapter, assertLinuxInstanceOwnership,
    dataPath: (...parts) => path.join(directory, ...parts),
    SERVER_CORE_DEFINITIONS: { linux: { executable: 'cod4x18_dedrun' }, windows: { executable: 'cod4x18_dedrun.exe' } },
    serverCoreDefinition: platform => ({ executable: platform === 'linux' ? 'cod4x18_dedrun' : 'cod4x18_dedrun.exe' }),
    normalizeServerPlatform: value => value, normalizeRuntimePath: value => value,
    resolveServerTarget: async () => ({ target: homePath, root: directory }),
    resolveRuntimeExecutable: async () => executable,
    verifiedRuntimeCoreStatus: async () => ({ verified: true, reasons: [] }), // isolated fixture boundary
    selectRuntimeBaseGamePath: value => value,
    resolveRuntimeLayout: async () => ({ coreWorkingDirectory: directory, filesystemBasePath: directory, filesystemHomePath: homePath }),
    mergeBaseGameState: (state, raw) => ({ ...state, ...raw }),
    policyState: { security: { allowedCod4xVersions: ['21.2'] } }
  };
  const options = { stateFile, ownership: { homePath, port: 49231 }, seedState: { instanceId: 'linux-fixture', platform: 'linux' } };
  const runtime = createRuntimeManager(dependencies, options);
  let recovered;
  try {
    await runtime.loadRuntimeState();
    const launch = { relative: homePath, executablePath: executable, baseGamePath: directory, expectedCod4x: '21.2', platform: 'linux', args: ['+set', 'net_port', '49231'] };
    await runtime.startRuntime(launch);
    assert.equal(runtime.state.status, 'RUNNING');
    assert.ok(runtime.state.processCreatedAt);
    assert.match(runtime.state.output.stdout, /fixture stdout/);
    assert.match(runtime.state.output.stderr, /fixture stderr/);
    recovered = createRuntimeManager(dependencies, options);
    await recovered.loadRuntimeState();
    assert.equal(recovered.state.pid, runtime.state.pid);
    await recovered.stopRuntime();
    assert.equal(recovered.state.status, 'STOPPED');
    await runtime.reconcileRuntimeState();
    await runtime.startRuntime(launch);
    await runtime.restartRuntime(launch);
    assert.equal(runtime.state.status, 'RUNNING');
    await adapter.signal(runtime.state.pid, { executablePath: executable, homePath, port: 49231, createdAt: runtime.state.processCreatedAt }, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(runtime.state.status, 'FAILED');
    assert.equal(runtime.state.exitSignal, 'SIGKILL');
    await runtime.startRuntime(launch);
    await runtime.stopRuntime();
    assert.equal(runtime.state.status, 'STOPPED');
  } finally {
    // Production guard remains in force even during test cleanup.
    if (recovered?.state.pid) await recovered.stopRuntime();
    if (runtime.state.pid || runtime.busy) await runtime.stopRuntime();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
