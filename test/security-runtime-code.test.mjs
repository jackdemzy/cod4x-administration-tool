import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend, password } from './support/security-backend.mjs';
import { createLinuxRuntimeAdapter } from '../lib/linux-runtime-adapter.mjs';

// Security audit 4.18.26, area 1 (local runtime).
// A1-1: an operator (server.manage) could make CONTROL run code of their choice: pick any
// executable as core, adopt it, install a plugin from any folder, pass free start arguments.
// Decision 2026-11-11: only admin may bring code; the operator starts, stops and configures.
// A1-2: a manifest file next to the core (writable by whoever can write the core folder)
// counted as proof that the core was verified.

async function sessions(t) {
  const server = await backend(t);
  const admin = (await server.call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const secret = password();
  assert.equal((await server.call('/api/users', { body: { username: 'operator1', password: secret, role: 'operator' }, token: admin })).status, 201);
  const operator = (await server.call('/api/auth/login', { body: { username: 'operator1', password: secret } })).json.token;
  assert.ok(operator, 'operator logged in');
  return { ...server, admin, operator };
}

test('A1-1: an operator cannot bring code that CONTROL would run', { timeout: 60000 }, async t => {
  const { call, admin, operator } = await sessions(t);
  const core = { executablePath: '/tmp/elsewhere/cod4x18_dedrun', version: '21.5' };
  const attempts = [
    ['/api/runtime/adopt', { path: './server', executablePath: core.executablePath, platform: 'linux', cod4x: '21.5' }],
    ['/api/runtime/config', { path: './server', executablePath: core.executablePath, platform: 'linux', cod4x: '21.5' }],
    ['/api/runtime/start', { args: ['+set', 'net_port', '28960', '+loadPlugin', 'evil'] }],
    ['/api/runtime/start', { executablePath: core.executablePath }],
    ['/api/runtime/restart', { args: ['+loadPlugin', 'evil'] }],
    ['/api/server/start', { args: ['+loadPlugin', 'evil'] }],
    ['/api/instances', { name: 'x', platform: 'linux', serverCore: core, basePath: '/tmp', port: 28960 }],
    ['/api/instances/x/clone', { name: 'y', serverCore: core }],
    ['/api/instances/x/plugins/install', { sourcePath: '/tmp/evil.so' }],
    ['/api/instances/x/plugins/approve', { name: 'evil' }],
  ];
  for (const [route, body] of attempts) {
    const refused = await call(route, { body, token: operator });
    assert.equal(refused.status, 403, `${route} ${JSON.stringify(body)} must need admin`);
    assert.equal(refused.json.permission, 'server.code');
    const allowed = await call(route, { body, token: admin });
    assert.notEqual(allowed.status, 403, `${route} stays open to admin`);
  }
  const plainStart = await call('/api/runtime/start', { body: {}, token: operator });
  assert.notEqual(plainStart.status, 403, 'the operator may still start the configured core without extra arguments');
  const cloneOnly = await call('/api/instances/x/clone', { body: { name: 'y' }, token: operator });
  assert.notEqual(cloneOnly.status, 403, 'cloning with the same core stays an operator task');
});

test('A1-2: a manifest next to the core does not make it verified; only the registry does', { timeout: 60000 }, async t => {
  const { call, root, admin } = await sessions(t);
  const target = path.join(root, 'installations', 'server');
  await fs.mkdir(target, { recursive: true });
  const exe = path.join(target, 'cod4x18_dedrun');
  await fs.writeFile(exe, '#!/bin/sh\necho planted\n', { mode: 0o755 });
  const executableSha256 = crypto.createHash('sha256').update(await fs.readFile(exe)).digest('hex');
  await fs.writeFile(path.join(target, 'cod4x-control-manifest.json'), JSON.stringify({ cod4x: '21.5', executable: 'cod4x18_dedrun', executableSha256, verification: 'installer' }));
  const status = (await call('/api/security/status?path=./server&platform=linux&cod4x=21.5', { token: admin })).json;
  assert.equal(status.verifiedCore.verified, false, 'a planted sidecar manifest is not proof');
});

test('A1-2: a Linux core in a folder others can write to is refused', { skip: process.platform !== 'linux' && 'Linux only' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a12-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exe = path.join(directory, 'cod4x18_dedrun');
  await fs.writeFile(exe, 'core', { mode: 0o700 });
  await fs.chmod(exe, 0o700);
  const adapter = createLinuxRuntimeAdapter();
  await adapter.validateExecutable(exe);
  await fs.chmod(exe, 0o722);
  await assert.rejects(adapter.validateExecutable(exe), { code: 'RUNTIME_EXECUTABLE_BLOCKED' }, 'group/world-writable core');
  await fs.chmod(exe, 0o700);
  await fs.chmod(directory, 0o777);
  await assert.rejects(adapter.validateExecutable(exe), { code: 'RUNTIME_EXECUTABLE_BLOCKED' }, 'core folder writable by others');
  await fs.chmod(directory, 0o755);
  await adapter.validateExecutable(exe);
  const foreign = createLinuxRuntimeAdapter({ hostProcess: { platform: 'linux', getuid: () => process.getuid() + 1, geteuid: () => process.getuid() + 1 } });
  await assert.rejects(foreign.validateExecutable(exe), { code: 'RUNTIME_EXECUTABLE_BLOCKED' }, 'core owned by another non-root user');
});

test('A1-2 (final review): umask 002 folders pass when the group is the user\'s private group', { skip: process.platform !== 'linux' && 'Linux only' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a12g-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exe = path.join(directory, 'cod4x18_dedrun');
  await fs.writeFile(exe, 'core');
  await fs.chmod(exe, 0o775);
  await fs.chmod(directory, 0o775);
  await createLinuxRuntimeAdapter({ privateGroup: () => true }).validateExecutable(exe);
  await assert.rejects(createLinuxRuntimeAdapter({ privateGroup: () => false }).validateExecutable(exe), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
  await fs.chmod(directory, 0o777);
  await assert.rejects(createLinuxRuntimeAdapter({ privateGroup: () => true }).validateExecutable(exe), { code: 'RUNTIME_EXECUTABLE_BLOCKED' }, 'world write never passes');
});
