import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLinuxInstanceOwnership, createLinuxRuntimeAdapter } from '../lib/linux-runtime-adapter.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const expected = { homePath: '/srv/instance-a', port: 28960, createdAt: 'boot:123', uid: 1000, gid: 1000 };
const info = { argv: ['/core/cod4x18_dedrun', '+set', 'fs_homepath', '/srv/instance-a', '+set', 'net_port', '28960'], createdAt: 'boot:123', uid: 1000, gid: 1000 };
test('Linux ownership accepts exact home port user group and birth', () => assertLinuxInstanceOwnership(info, expected));
test('Linux ownership rejects case changes duplicate overrides and PID reuse', () => {
  for (const changed of [{ ...info, argv: info.argv.map(value => value === '/srv/instance-a' ? '/srv/Instance-a' : value) }, { ...info, argv: [...info.argv, '+set', 'net_port', '28960'] }, { ...info, createdAt: 'boot:124' }, { ...info, uid: 0 }, { ...info, gid: 0 }]) assert.throws(() => assertLinuxInstanceOwnership(changed, expected), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
});
test('Linux adapter refuses root and non-Linux host', () => {
  assert.throws(() => createLinuxRuntimeAdapter({ hostProcess: { platform: 'linux', getuid: () => 0, geteuid: () => 0 } }).assertHost(), { code: 'RUNTIME_ROOT_BLOCKED' });
  assert.throws(() => createLinuxRuntimeAdapter({ hostProcess: { platform: 'win32' } }).assertHost(), { code: 'RUNTIME_PLATFORM_NOT_SUPPORTED' });
});
test('a zombie group leader with surviving threads is not confirmed process absence', async () => {
  const stat = `42 (cod4x18_dedrun) Z ${Array(18).fill('0').join(' ')} 123 0`;
  const filesystem = {
    async open() { let sent = false; return { async read(buffer) { if (sent) return { bytesRead: 0 }; sent = true; return { bytesRead: buffer.write(stat) }; }, async close() {} }; },
    async readdir() { return ['42', '43']; },
  };
  const result = await createLinuxRuntimeAdapter({ filesystem }).inspectProcess(42);
  assert.notEqual(result.alive, false);
});
test('native Linux procfs inspection returns actual executable argv credentials and stable birth', { skip: process.platform !== 'linux' }, async () => {
  const adapter = createLinuxRuntimeAdapter();
  adapter.assertHost();
  const first = await adapter.inspectProcess(process.pid);
  assert.equal(first.alive, true, first.error);
  assert.equal(first.executablePath, await fs.realpath(process.execPath));
  assert.equal(first.uid, process.getuid());
  assert.equal(first.gid, process.getgid());
  assert.equal(first.argv[0], process.execPath);
  assert.match(first.createdAt, /^[a-f0-9-]{36}:\d+$/);
  assert.equal((await adapter.inspectProcess(process.pid)).createdAt, first.createdAt);
  assert.equal((await adapter.inspectProcess(-1)).alive, null);
});
test('native Linux executable validation rejects missing bit, symlink and setuid', { skip: process.platform !== 'linux' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-adapter-'));
  const file = path.join(directory, 'cod4x18_dedrun');
  const link = path.join(directory, 'alias');
  const adapter = createLinuxRuntimeAdapter();
  try {
    await fs.writeFile(file, 'isolated executable-permission fixture');
    await fs.chmod(file, 0o600);
    await assert.rejects(adapter.validateExecutable(file), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
    await fs.chmod(file, 0o700);
    await adapter.validateExecutable(file);
    await fs.symlink(file, link);
    await assert.rejects(adapter.validateExecutable(link), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
    await fs.chmod(file, 0o4700);
    await assert.rejects(adapter.validateExecutable(file), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('native Linux output is run-owned, bounded even for invalid UTF8, and rejects aliases', { skip: process.platform !== 'linux' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-output-'));
  const adapter = createLinuxRuntimeAdapter();
  const runId = crypto.randomUUID();
  try {
    const handles = await adapter.prepareOutput(home, runId);
    await handles[0].write(Buffer.alloc(300, 255));
    await handles[1].write('fixture stderr');
    await Promise.all(handles.map(handle => handle.close()));
    const output = await adapter.readOutput(home, runId, 16);
    assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 16);
    assert.equal(output.stdoutTruncated, true);
    assert.equal(output.stderr, 'fixture stderr');
    await assert.rejects(adapter.prepareOutput(home, runId), { code: 'EEXIST' });
    const stdout = path.join(home, 'logs', `runtime-${runId}-stdout.log`);
    await fs.link(stdout, path.join(home, 'foreign-alias'));
    await assert.rejects(adapter.readOutput(home, runId, 16), /exclusively owned/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
