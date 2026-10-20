import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createRuntimeManager } from '../lib/runtime-manager.mjs';

test('real Windows tasklist/CIM inspection returns path, command line and creation time for an owned helper', { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
  // Two inspections, each up to 3 s tasklist + 10 s PowerShell, plus spawn and cleanup.
  // Not a Dedicated Core. Only the helper created here may be terminated.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'cod4x-process-inspection-test'], { windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  try {
    await once(child, 'spawn');
    const runtime = createRuntimeManager({ path, fs, crypto, process, dataPath: (...parts) => path.join(os.tmpdir(), ...parts), SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' } }, execFileAsync: promisify(execFile) });
    const info = await runtime.inspectProcess(child.pid);
    assert.equal(info.alive, true, info.error || 'Owned helper process was not detected');
    assert.equal(path.win32.normalize(info.executablePath).toLowerCase(), path.win32.normalize(process.execPath).toLowerCase());
    assert.match(info.commandLine, /cod4x-process-inspection-test/);
    assert.ok(Number.isFinite(Date.parse(info.createdAt)));
    child.kill(); await closed;
    assert.equal((await runtime.inspectProcess(child.pid)).alive, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});
