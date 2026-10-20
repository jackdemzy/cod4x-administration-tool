import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRuntimeManager } from '../lib/runtime-manager.mjs';

// A cold PowerShell start (fresh boot, AV scan, CI runner) can take longer than 3 s.
// Timing out turns into alive:null and blocks stop/recovery with RUNTIME_PROCESS_INSPECTION_FAILED.
test('Windows process inspection allows a slow PowerShell cold start', async () => {
  const calls = [];
  const execFileAsync = async (file, args, options) => {
    calls.push({ file, options });
    if (file === 'tasklist.exe') return { stdout: '"node.exe","4242","Console","1","10.000 K"\r\n' };
    return { stdout: '{"found":false}' };
  };
  const windowsProcess = Object.create(process, { platform: { value: 'win32' } });
  const runtime = createRuntimeManager({ path, fs, crypto, process: windowsProcess, dataPath: (...parts) => path.join(os.tmpdir(), ...parts), SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' } }, execFileAsync });
  const info = await runtime.inspectProcess(4242);
  assert.equal(info.alive, false, info.error);
  const powershell = calls.find(call => call.file === 'powershell.exe');
  assert.ok(powershell, 'PowerShell CIM inspection was not called');
  assert.ok(powershell.options.timeout >= 10_000, `PowerShell timeout ${powershell.options.timeout} ms is too short for a cold start`);
});
