// Security audit 4.18.26 (A1-3): CONTROL warns when it runs as root or as Windows administrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectElevation } from '../lib/elevation-check.mjs';

const group = (name, sid) => `"${name}","Well-known group","${sid}","Mandatory group, Enabled by default, Enabled group"`;
const whoami = label => [group('Everyone', 'S-1-1-0'), group('BUILTIN\\Administrators', 'S-1-5-32-544'), `"Mandatory Label\\${label}","Label","${{ 'Medium Mandatory Level': 'S-1-16-8192', 'High Mandatory Level': 'S-1-16-12288', 'System Mandatory Level': 'S-1-16-16384' }[label]}",""`].join('\r\n');

test('A1-3: root on Linux is reported, a normal user is not', async () => {
  assert.deepEqual(await detectElevation({ platform: 'linux', getuid: () => 0 }), { elevated: true, kind: 'root' });
  assert.deepEqual(await detectElevation({ platform: 'linux', getuid: () => 1000 }), { elevated: false, kind: null });
});

test('A1-3: an elevated Windows token (High or System integrity) is reported', async () => {
  const calls = [];
  const run = label => async (file, args) => { calls.push([file, ...args]); return { stdout: whoami(label) }; };
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: run('High Mandatory Level') }), { elevated: true, kind: 'windows-admin' });
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: run('System Mandatory Level') }), { elevated: true, kind: 'windows-admin' });
  assert.deepEqual(calls[0], ['whoami.exe', '/groups', '/fo', 'csv', '/nh']);
});

test('A1-3: an administrator in a normal (Medium) token is not elevated; failures never block', async () => {
  // a member of Administrators without "Run as administrator" still has a Medium token (UAC)
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: async () => ({ stdout: whoami('Medium Mandatory Level') }) }), { elevated: false, kind: null });
  assert.deepEqual(await detectElevation({ platform: 'win32', execFileAsync: async () => { throw new Error('whoami missing'); } }), { elevated: false, kind: null });
  assert.deepEqual(await detectElevation({ platform: 'win32' }), { elevated: false, kind: null });
});
