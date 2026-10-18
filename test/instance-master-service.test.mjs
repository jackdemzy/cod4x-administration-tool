import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyMasterLog, describeMasterStatus, MASTER_STATES } from '../lib/instance-master-service.mjs';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

// Launch -> vault -> spawn arguments -> console evidence. Not a native core or
// real master server test: the test double never contacts cod4master.cod4x.ovh.
const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
async function fixture(t) { const value = await createRconFixture(); t.after(value.cleanup); return value; }
const noToken = (value, label) => assert.ok(!JSON.stringify(value).includes(token), `${label} must not contain the master token`);

test('master log classification uses the exact CoD4x sv_main.c messages and returns codes only', () => {
  assert.deepEqual(classifyMasterLog(''), { outcome: null, code: null });
  assert.deepEqual(classifyMasterLog('^1Error: Failure registering server on masterserver. Errorcode: 0x3\n'), { outcome: 'FAILED', code: 'MASTER_REJECTED' });
  assert.deepEqual(classifyMasterLog('^1Error: Failure registering server on masterserver. Server address is banned: x\n'), { outcome: 'FAILED', code: 'MASTER_ADDRESS_BANNED' });
  assert.deepEqual(classifyMasterLog('Masterserver needs token to complete registration\nsv_authtoken is invalid! Abandoning master server registration\n'), { outcome: 'FAILED', code: 'MASTER_TOKEN_INVALID' });
  // The latest relevant line wins: a retry after a failure is in progress again.
  assert.deepEqual(classifyMasterLog('Connection to masterserver timeout\nMasterserver needs token to complete registration\n'), { outcome: 'REGISTERING', code: 'MASTER_TOKEN_REQUESTED' });
  assert.deepEqual(classifyMasterLog('Server is registered on the masterserver\n'), { outcome: 'REGISTERED', code: 'MASTER_REGISTERED' });
});

test('master status: missing token never blocks, loopback cannot register, evidence decides outcome', () => {
  const states = new Set(MASTER_STATES);
  const cases = [
    [{ tokenConfigured: false, running: false }, 'NOT_CONFIGURED', 'MASTER_TOKEN_NOT_CONFIGURED'],
    [{ tokenConfigured: true, running: false }, 'TOKEN_CONFIGURED', 'SERVER_STOPPED'],
    [{ tokenConfigured: null, running: false }, 'UNKNOWN', 'VAULT_LOCKED'],
    [{ tokenConfigured: false, running: true, transfer: 'NOT_CONFIGURED' }, 'NOT_CONFIGURED', 'MASTER_TOKEN_NOT_CONFIGURED'],
    [{ tokenConfigured: null, running: true, transfer: 'VAULT_LOCKED' }, 'UNKNOWN', 'VAULT_LOCKED_AT_START'],
    [{ tokenConfigured: true, running: true, transfer: 'UNKNOWN' }, 'TOKEN_CONFIGURED', 'RUN_TRANSFER_UNKNOWN'],
    [{ tokenConfigured: true, running: true, transfer: 'PROVISIONED', networkScope: 'LOOPBACK' }, 'TOKEN_CONFIGURED', 'LOOPBACK_BINDING'],
    [{ tokenConfigured: true, running: true, transfer: 'PROVISIONED', networkScope: 'PUBLIC' }, 'REGISTERING', 'MASTER_AWAITING_RESPONSE'],
    [{ tokenConfigured: true, running: true, transfer: 'PROVISIONED', networkScope: 'PUBLIC', log: { outcome: 'FAILED', code: 'MASTER_TOKEN_INVALID' } }, 'REGISTRATION_FAILED', 'MASTER_TOKEN_INVALID'],
    [{ tokenConfigured: true, running: true, transfer: 'PROVISIONED', networkScope: 'PUBLIC', log: { outcome: 'REGISTERED', code: 'MASTER_REGISTERED' } }, 'REGISTERED', 'MASTER_REGISTERED'],
  ];
  for (const [input, state, reason] of cases) {
    const result = describeMasterStatus({ networkScope: 'LOOPBACK', log: null, transfer: null, ...input });
    assert.deepEqual([result.state, result.reason], [state, reason], JSON.stringify(input));
    assert.ok(states.has(result.state));
    assert.equal(result.verified, false, 'Listing is only verified by Block 9');
  }
});

test('local server runs with or without a master token; the token reaches only the spawned core', async t => {
  const { manager, children, create, setMaster, masterService, auditEvents, runtimeEvents, store } = await fixture(t);
  await create('master-a'); await create('master-b');
  const plain = await manager.launch('master-a');
  assert.equal(plain.status, 'RUNNING');
  assert.ok(!children.get(plain.pid).args.includes('sv_authtoken'));
  assert.equal((await masterService.status('master-a')).state, 'NOT_CONFIGURED');
  await setMaster('master-b', token);
  const listed = await manager.launch('master-b');
  const args = children.get(listed.pid).args, index = args.indexOf('sv_authtoken');
  assert.ok(index > 0 && args[index - 1] === '+set' && args[index + 1] === token && index < args.indexOf('+exec'), 'core receives sv_authtoken before server.cfg');
  const status = await masterService.status('master-b');
  assert.deepEqual([status.state, status.reason, status.transfer], ['TOKEN_CONFIGURED', 'LOOPBACK_BINDING', 'PROVISIONED']);
  assert.ok(auditEvents.some(entry => entry.event === 'master.registration.started' && entry.details.instanceId === 'master-b'));
  noToken(await manager.status('master-b'), 'instance status');
  noToken(runtimeEvents, 'runtime events');
  noToken(auditEvents, 'audit');
  noToken(status, 'master status');
  noToken(await fs.readFile(path.join(store.get('master-b').homePath, 'logs', 'runtime-state.json'), 'utf8'), 'persisted runtime state');
  // Sibling instance is unaffected by the other instance's token.
  assert.equal((await masterService.status('master-a')).state, 'NOT_CONFIGURED');
});

test('registration failure is reported once per run while the local server keeps running', async t => {
  const { manager, create, setMaster, masterService, auditEvents, store } = await fixture(t);
  await create('master-a');
  await setMaster('master-a', token);
  const state = await manager.launch('master-a');
  await fs.appendFile(path.join(store.get('master-a').homePath, 'main', 'qconsole.log'), 'Masterserver needs token to complete registration\nsv_authtoken is invalid! Abandoning master server registration\n');
  for (let poll = 0; poll < 3; poll++) {
    const status = await masterService.status('master-a');
    assert.deepEqual([status.state, status.reason], ['REGISTRATION_FAILED', 'MASTER_TOKEN_INVALID']);
  }
  assert.equal(auditEvents.filter(entry => entry.event === 'master.registration.failed').length, 1);
  const current = await manager.status('master-a');
  assert.deepEqual([current.runtime.status, current.runtime.pid], ['RUNNING', state.pid]);
  // The sensitive console line stays hidden from the normal console view.
  assert.ok(!current.consoleLog.text.includes('sv_authtoken is invalid'));
});

test('a locked vault starts the server without a token and the run reports that honestly', async t => {
  const { manager, children, create, setMaster, credentialService, masterService } = await fixture(t);
  await create('master-a');
  await setMaster('master-a', token);
  credentialService.lock();
  const state = await manager.launch('master-a');
  assert.equal(state.status, 'RUNNING');
  assert.ok(!children.get(state.pid).args.includes('sv_authtoken'));
  const status = await masterService.status('master-a');
  assert.deepEqual([status.state, status.reason, status.transfer], ['UNKNOWN', 'VAULT_LOCKED_AT_START', 'VAULT_LOCKED']);
  await manager.stop('master-a');
  assert.equal((await masterService.status('master-a')).state, 'UNKNOWN');
});
