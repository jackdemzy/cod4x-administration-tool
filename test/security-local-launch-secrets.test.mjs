import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

// Security audit 4.18.26, finding A2-1: on Linux every local user can read a process's
// command line (/proc/<pid>/cmdline). The RCON password and the master token must reach
// the local core through a private file it reads with +exec, never as arguments.
const rcon = 'RconPass-A21-local';
const master = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
async function fixture(t) { const value = await createRconFixture(); t.after(value.cleanup); return value; }

test('A2-1: a local launch keeps the RCON password and the master token out of the core arguments', async t => {
  const { manager, children, create, setRcon, setMaster, rconService, masterService, store } = await fixture(t);
  await create('argv-a');
  await setRcon('argv-a', rcon);
  await setMaster('argv-a', master);
  const state = await manager.launch('argv-a');
  const child = children.get(state.pid);
  const line = child.args.join(' ');
  for (const secret of [rcon, master, 'rcon_password', 'sv_authtoken']) assert.ok(!line.includes(secret), `argument list must not contain ${secret}`);
  const execs = child.args.flatMap((value, i) => value === '+exec' ? [child.args[i + 1]] : []);
  assert.equal(execs.length, 2, 'one private launch file, then server.cfg');
  assert.match(execs[0], /^launch-[0-9a-f-]{36}\.cfg$/);
  assert.equal(execs[1], 'server.cfg');
  const main = path.join(store.get('argv-a').homePath, 'main');
  assert.deepEqual((await fs.readdir(main)).filter(name => name.startsWith('launch-')), [], 'the launch file is gone once the core has read it');
  assert.equal(child.execedSettings.rcon_password, rcon, 'the core read the RCON password from the file');
  assert.equal(child.execedSettings.sv_authtoken, master, 'the core read the master token from the file');
  if (process.platform !== 'win32') assert.equal(child.launchFileMode & 0o077, 0, 'the launch file was private (0600)');
  assert.equal(rconService.status('argv-a').provisioning, 'PROVISIONED');
  assert.equal((await masterService.status('argv-a')).transfer, 'PROVISIONED');
  const reply = await rconService.execute('argv-a', 'status');
  assert.equal(typeof reply.response, 'string', 'RCON works with the password from the file (a wrong one throws)');
});

test('A2-1: a launch file left by a crash is removed before the next start', async t => {
  const { manager, create, setRcon, store } = await fixture(t);
  await create('argv-b');
  await setRcon('argv-b', rcon);
  const main = path.join(store.get('argv-b').homePath, 'main');
  await fs.mkdir(main, { recursive: true });
  await fs.writeFile(path.join(main, 'launch-00000000-0000-4000-8000-000000000000.cfg'), 'set rcon_password "old"\n', { mode: 0o600 });
  await manager.launch('argv-b');
  assert.deepEqual((await fs.readdir(main)).filter(name => name.startsWith('launch-')), []);
});

test('A2-1 (PR #46 review): without "execing <file>" the transfer is UNKNOWN, not PROVISIONED', async t => {
  const value = await createRconFixture({ printExecing: false, managerOptions: { launchFileWaitMs: 300 } });
  t.after(value.cleanup);
  const { manager, create, setRcon, setMaster, rconService, masterService, store } = value;
  await create('argv-c');
  await setRcon('argv-c', rcon);
  await setMaster('argv-c', master);
  await manager.launch('argv-c');
  assert.equal(rconService.status('argv-c').provisioning, 'UNKNOWN');
  assert.equal((await masterService.status('argv-c')).transfer, 'UNKNOWN');
  const main = path.join(store.get('argv-c').homePath, 'main');
  assert.deepEqual((await fs.readdir(main)).filter(name => name.startsWith('launch-')), [], 'the file is still removed after the timeout');
});
