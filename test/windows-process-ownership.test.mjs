import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWindowsArguments, assertWindowsInstanceOwnership } from '../lib/windows-process-ownership.mjs';

const expected = { homePath: 'C:\\Servers\\Public 01', port: 28960, createdAt: '2026-10-01T12:00:00.0000000Z' };
const info = { commandLine: '"C:\\Core\\cod4x18_dedrun.exe" +set fs_homepath "C:\\Servers\\Public 01" +set net_port 28960', createdAt: expected.createdAt };
test('quoted Windows paths are parsed and owned instance is accepted', () => {
  assert.deepEqual(parseWindowsArguments(info.commandLine), ['C:\\Core\\cod4x18_dedrun.exe', '+set', 'fs_homepath', expected.homePath, '+set', 'net_port', '28960']);
  assert.doesNotThrow(() => assertWindowsInstanceOwnership(info, expected));
});
test('same Core but other home, port or creation time is rejected', () => {
  for (const other of [{ ...expected, homePath: 'C:\\Servers\\Public 02' }, { ...expected, port: 28961 }, { ...expected, createdAt: '2026-10-01T13:00:00Z' }]) assert.throws(() => assertWindowsInstanceOwnership(info, other), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
});
test('missing, malformed or duplicate ownership arguments fail closed', () => {
  for (const value of [{ ...info, commandLine: '' }, { ...info, createdAt: null }, { ...info, commandLine: `${info.commandLine} +set fs_homepath "C:\\Servers\\Public 02"` }, { ...info, commandLine: `${info.commandLine} "unterminated` }]) assert.throws(() => assertWindowsInstanceOwnership(value, expected));
});
