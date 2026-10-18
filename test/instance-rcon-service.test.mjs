import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

// Launch -> vault transfer -> UDP test double -> RCON. Not a native core test.
const secret = 'Instance-Rcon-4185';
async function fixture(t) { const value = await createRconFixture(); t.after(value.cleanup); return value; }
const noSecret = (value, label) => assert.ok(!JSON.stringify(value).includes(secret), `${label} must not contain the RCON password`);

test('launch passes rcon_password from the vault only to the spawned core and redacts every record', async t => {
  const { manager, children, setRcon, create, runtimeEvents, store } = await fixture(t);
  await create('rcon-a');
  await setRcon('rcon-a', secret);
  const state = await manager.launch('rcon-a');
  const child = children.get(state.pid);
  const index = child.args.indexOf('rcon_password');
  assert.ok(index > 0 && child.args[index - 1] === '+set' && child.args[index + 1] === secret, 'core receives the password as +set argument');
  assert.ok(index < child.args.indexOf('+exec'), 'password is set before server.cfg is executed');
  const status = await manager.status('rcon-a');
  noSecret(status, 'instance status'); noSecret(runtimeEvents, 'runtime events');
  assert.ok(status.runtime.history.find(entry => entry.event === 'runtime.started').args.includes('[redacted]'));
  const persisted = await fs.readFile(path.join(store.get('rcon-a').homePath, 'logs', 'runtime-state.json'), 'utf8');
  assert.ok(persisted.length > 0); noSecret(persisted, 'persisted runtime state');
});

test('no configured credential or a locked vault starts without RCON instead of blocking the server', async t => {
  const { manager, children, create, credentialService, rconService, setRcon } = await fixture(t);
  await create('rcon-a'); await create('rcon-b');
  const plain = await manager.launch('rcon-a');
  assert.ok(!children.get(plain.pid).args.includes('rcon_password'));
  assert.equal(rconService.status('rcon-a').provisioning, 'NOT_CONFIGURED');
  await setRcon('rcon-b', secret);
  credentialService.lock();
  const locked = await manager.launch('rcon-b');
  assert.ok(!children.get(locked.pid).args.includes('rcon_password'));
  assert.deepEqual([rconService.status('rcon-b').provisioning, rconService.status('rcon-b').status], ['VAULT_LOCKED', 'NOT_PROVISIONED']);
});

test('values the CoD4x command line would split are rejected on save and blocked fail-closed at launch', async t => {
  const { manager, children, create, setRcon } = await fixture(t);
  await create('rcon-a');
  await assert.rejects(setRcon('rcon-a', 'Plus+Sign-123'), { code: 'CREDENTIAL_INVALID' });
  // A value stored before this rule existed is still blocked before any spawn.
  const vault = manager.credentialService;
  manager.credentialService = { instanceStatus: async () => ({ initialized: true, rcon: { configured: true } }), withRuntimeCredentials: async (id, action) => action({ rcon: Buffer.from('Old+Stored-123') }, new AbortController().signal) };
  await assert.rejects(manager.launch('rcon-a'), { code: 'RCON_PASSWORD_UNSUPPORTED' });
  assert.equal(children.size, 0);
  manager.credentialService = vault;
});

test('connect, command, multi-packet response, history and audit without the password', async t => {
  const { manager, children, create, setRcon, rconService, auditEvents } = await fixture(t);
  await create('rcon-a');
  await setRcon('rcon-a', secret);
  const state = await manager.launch('rcon-a');
  const connected = await rconService.connect('rcon-a', 'admin');
  assert.deepEqual([connected.status, connected.provisioning, connected.server.hostname], ['CONNECTED', 'PROVISIONED', 'RCON rcon-a']);
  const result = await rconService.execute('rcon-a', 'status', 'admin');
  assert.match(result.response, /^map: mp_backlot/);
  assert.equal((result.response.match(/Bot\d+/g) || []).length, 24);
  const map = await rconService.execute('rcon-a', 'map mp_crash', 'admin');
  assert.match(map.response, /Server: mp_crash/);
  assert.deepEqual(children.get(state.pid).server.state.commands, ['serverinfo', 'status', 'map mp_crash']);
  const status = rconService.status('rcon-a');
  assert.deepEqual(status.history.map(entry => entry.command), ['map mp_crash', 'status']);
  assert.deepEqual(auditEvents.map(entry => entry.event), ['rcon.login', 'rcon.command', 'rcon.command']);
  assert.deepEqual(auditEvents.map(entry => entry.details.command || null), [null, 'status', 'map mp_crash']);
  noSecret(auditEvents, 'audit'); noSecret(status, 'rcon status');
});

test('blocked commands never touch the vault or the network and audit only the command name', async t => {
  const { manager, children, create, setRcon, rconService, auditEvents, credentialService } = await fixture(t);
  await create('rcon-a');
  await setRcon('rcon-a', secret);
  const state = await manager.launch('rcon-a');
  credentialService.lock();
  for (const input of [`rcon_password ${secret}`, 'quit', 'status; quit', 'exec server.cfg', 'killserver']) {
    await assert.rejects(rconService.execute('rcon-a', input, 'admin'), { code: 'RCON_COMMAND_BLOCKED' });
  }
  assert.deepEqual(children.get(state.pid).server.state.commands, []);
  assert.ok(auditEvents.every(entry => entry.event === 'rcon.failure' && entry.details.code === 'RCON_COMMAND_BLOCKED'));
  assert.equal(auditEvents[0].details.commandName, 'rcon_password');
  noSecret(auditEvents, 'blocked audit'); noSecret(rconService.status('rcon-a'), 'blocked history');
  await assert.rejects(rconService.execute('rcon-a', 'status', 'admin'), { code: 'VAULT_LOCKED' });
});

test('wrong password, stopped server and unreachable core produce fixed codes and reconnect recovers', async t => {
  const { manager, children, create, setRcon, rconService, auditEvents } = await fixture(t);
  await create('rcon-a');
  await assert.rejects(rconService.execute('rcon-a', 'status'), { code: 'RCON_SERVER_NOT_RUNNING' });
  await setRcon('rcon-a', secret);
  const first = await manager.launch('rcon-a');
  await rconService.connect('rcon-a');
  // Core loses its socket (crash/hang) while the process is still "running".
  await children.get(first.pid).server.close();
  await assert.rejects(rconService.execute('rcon-a', 'status'), { code: 'RCON_TIMEOUT' });
  assert.deepEqual([rconService.status('rcon-a').status, rconService.status('rcon-a').failures], ['DISCONNECTED', 1]);
  await assert.rejects(rconService.connect('rcon-a'), { code: 'RCON_TIMEOUT' });
  assert.equal(rconService.status('rcon-a').status, 'UNREACHABLE');
  assert.equal(auditEvents.filter(entry => entry.event === 'rcon.failure' && entry.details.stage === 'login').at(-1).details.attempts, 3);
  // Restart: new run, new socket, connection evidence is not carried over.
  const second = await manager.launch('rcon-a', true);
  assert.notEqual(second.runId, first.runId);
  assert.equal(rconService.status('rcon-a').status, 'DISCONNECTED');
  const reconnected = await rconService.connect('rcon-a');
  assert.deepEqual([reconnected.status, reconnected.runId, reconnected.failures], ['CONNECTED', second.runId, 0]);
  children.get(second.pid).server.state.password = 'Changed-Elsewhere-1';
  await assert.rejects(rconService.execute('rcon-a', 'status'), { code: 'RCON_AUTH_FAILED' });
  assert.equal(rconService.status('rcon-a').status, 'AUTH_FAILED');
  await manager.stop('rcon-a');
  await assert.rejects(rconService.execute('rcon-a', 'status'), { code: 'RCON_SERVER_NOT_RUNNING' });
  assert.equal(rconService.status('rcon-a').status, 'OFFLINE');
  noSecret(auditEvents, 'failure audit');
});

test('instances keep separate RCON targets, state and history', async t => {
  const { manager, create, setRcon, rconService } = await fixture(t);
  await create('rcon-a'); await create('rcon-b');
  await setRcon('rcon-a', secret); await setRcon('rcon-b', 'Other-Instance-99');
  await manager.launch('rcon-a'); await manager.launch('rcon-b');
  await rconService.execute('rcon-a', 'serverinfo');
  assert.equal(rconService.status('rcon-b').history.length, 0);
  assert.notEqual(rconService.status('rcon-a').target.port, rconService.status('rcon-b').target.port);
  assert.match((await rconService.execute('rcon-b', 'serverinfo')).response, /RCON rcon-b/);
});
