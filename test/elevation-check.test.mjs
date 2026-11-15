// Security audit 4.18.26 (A1-3): CONTROL warns when it runs as root or as Windows administrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectElevation } from '../lib/elevation-check.mjs';

test('A1-3: root on Linux is reported, a normal user is not', async () => {
  assert.deepEqual(await detectElevation({ platform: 'linux', getuid: () => 0 }), { elevated: true, kind: 'root' });
  assert.deepEqual(await detectElevation({ platform: 'linux', getuid: () => 1000 }), { elevated: false, kind: null });
});

test('A1-3: an elevated Windows process is reported through net session', async () => {
  const calls = [];
  const ok = async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; };
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: ok }), { elevated: true, kind: 'windows-admin' });
  assert.deepEqual(calls, [['net.exe', 'session']]);
  const denied = async () => { throw Object.assign(new Error('Access is denied.'), { code: 2 }); };
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: denied }), { elevated: false, kind: null });
  assert.deepEqual(await detectElevation({ platform: 'win32' }), { elevated: false, kind: null });
});
