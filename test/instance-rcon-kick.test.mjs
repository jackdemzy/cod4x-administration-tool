import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceRconService } from '../lib/instance-rcon-service.mjs';

const HEADER = 'map     : mp_crash\n\nnum score ping playerid            steamid           name                             lastmsg address                                              qport rate\n--- ----- ---- ----\n';
const row = (slot, playerid, name, address = '203.0.113.7:28960') => `${String(slot).padStart(3)}     0   48 ${playerid.padEnd(19)} 7654321           ${name}^7                            0 ${address.padEnd(52)} 1234 25000\n`;
const status = (...rows) => HEADER + rows.join('');

function service({ statuses = [], running = true, kickError = null, lockAfterScopes = Infinity } = {}) {
  const kicks = [], audits = [], commands = [];
  const vault = { scopes: 0 };
  const client = {
    async execute(password, command) { commands.push(command); if (command !== 'status') throw new Error('unexpected'); return { text: statuses.shift() ?? status(), latencyMs: 1, packets: 1 }; },
    async kick(password, slot, reason) { kicks.push({ slot, reason, password: password.toString() }); if (kickError) throw Object.assign(new Error(kickError), { code: kickError }); return { text: '', latencyMs: 1 }; },
    async probe() { return {}; },
  };
  const rcon = new InstanceRconService({
    resolveInstance: id => ({ id, port: 28960 }),
    runtimeFor: async () => ({ reconcileRuntimeState: async () => {}, state: running ? { status: 'RUNNING', pid: 42, runId: 'run-1' } : { status: 'STOPPED', pid: null, runId: null } }),
    credentialService: { withRuntimeCredentials: async (id, fn) => { if (++vault.scopes > lockAfterScopes) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' }); return fn({ rcon: Buffer.from('Kick-Rcon-123') }, new AbortController().signal); } },
    audit: (level, event, details) => audits.push({ level, event, ...details }),
    clientFactory: () => client,
    sleep: async () => {},
  });
  return { rcon, kicks, audits, commands, vault };
}

test('kick verifies the target, kicks the slot and confirms it left', async () => {
  const { rcon, kicks, audits } = service({ statuses: [status(row(3, '1234567890', 'Big Bad Wolf'), row(4, '2222222222', 'Other')), status(row(4, '2222222222', 'Other'))] });
  assert.deepEqual(await rcon.kick('srv', { slot: 3, playerid: '1234567890', name: 'Big Bad Wolf', reason: 'Cheating' }, 'admin1'), { kicked: true, slot: 3 });
  assert.deepEqual(kicks, [{ slot: 3, reason: 'Cheating', password: 'Kick-Rcon-123' }]);
  assert.deepEqual(audits.at(-1), { level: 'info', event: 'rcon.kick', instanceId: 'srv', actor: 'admin1', slot: 3, ok: true, code: null });
  assert.ok(!/Wolf|1234567890|Cheating|203\.0\.113/.test(JSON.stringify(audits)));
});

test('a reassigned slot is never kicked', async () => {
  for (const target of [{ slot: 3, playerid: '9999999999' }, { slot: 3, playerid: '1234567890', name: 'Someone Else' }]) {
    const { rcon, kicks, audits } = service({ statuses: [status(row(3, '1234567890', 'Big Bad Wolf'))] });
    await assert.rejects(rcon.kick('srv', target, 'admin1'), { code: 'RCON_KICK_TARGET_CHANGED' });
    assert.equal(kicks.length, 0);
    assert.deepEqual([audits.at(-1).event, audits.at(-1).ok, audits.at(-1).code], ['rcon.kick', false, 'RCON_KICK_TARGET_CHANGED']);
  }
});

test('empty slot, unconfirmed kick, invalid input and playerid 0 without a name', async () => {
  let ctx = service({ statuses: [status(row(4, '2222222222', 'Other'))] });
  await assert.rejects(ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { code: 'RCON_KICK_NOT_ONLINE' });
  ctx = service({ statuses: Array.from({ length: 4 }, () => status(row(3, '1234567890', 'Wolf'))) });
  await assert.rejects(ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { code: 'RCON_KICK_NOT_CONFIRMED' });
  // A dropped client may linger as ZMBI: that counts as gone.
  ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf')), status(row(3, '1234567890', 'Wolf').replace('   48 ', ' ZMBI '))] });
  assert.deepEqual(await ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { kicked: true, slot: 3 });
  ctx = service();
  for (const target of [{ slot: 64, playerid: '1' }, { slot: 3, playerid: '1', reason: 'a;b' }, { slot: 3, playerid: '0' }, { slot: 3 }]) {
    await assert.rejects(ctx.rcon.kick('srv', target, 'a'), { code: 'RCON_KICK_INVALID' }, JSON.stringify(target));
  }
  assert.equal(ctx.commands.length, 0, 'invalid input never reaches the server');
  ctx = service({ statuses: [status(row(0, '0', 'bot0', 'bot'), row(1, '0', 'bot1', 'bot')), status(row(0, '0', 'bot0', 'bot'))] });
  assert.deepEqual(await ctx.rcon.kick('srv', { slot: 1, playerid: '0', name: 'bot1' }, 'a'), { kicked: true, slot: 1 });
});

test('online list is masked without full and never returns steamid', async () => {
  const { rcon } = service({ statuses: [status(row(3, '1234567890', 'Wolf')), status(row(3, '1234567890', 'Wolf'))] });
  const masked = await rcon.online('srv');
  assert.deepEqual(masked, { map: 'mp_crash', players: [{ slot: 3, name: 'Wolf', ping: 48, score: 0, playerid: '…7890', address: '203.0.113.x', bot: false }] });
  const full = await rcon.online('srv', { full: true });
  assert.deepEqual([full.players[0].playerid, full.players[0].address], ['1234567890', '203.0.113.7:28960']);
  assert.ok(!JSON.stringify(full).includes('7654321'));
});

test('findOnline maps unique playerids to slots and never throws', async () => {
  const { rcon } = service({ statuses: [status(row(3, '1234567890', 'Wolf'), row(0, '0', 'bot0', 'bot'), row(1, '0', 'bot1', 'bot'))] });
  assert.deepEqual([...(await rcon.findOnline('srv')).entries()], [['1234567890', 3]]);
  assert.equal(await service({ running: false }).rcon.findOnline('srv'), null);
});

test('a kick can be verified by exact name alone, never by nothing', async () => {
  let ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf')), status()] });
  assert.deepEqual(await ctx.rcon.kick('srv', { slot: 3, name: 'Wolf' }, 'a'), { kicked: true, slot: 3 });
  ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf'))] });
  await assert.rejects(ctx.rcon.kick('srv', { slot: 3, name: 'Wolfgang' }, 'a'), { code: 'RCON_KICK_TARGET_CHANGED' });
  await assert.rejects(service().rcon.kick('srv', { slot: 3, playerid: '…7890' }, 'a'), { code: 'RCON_KICK_INVALID' });
});

// --- Review fixes -----------------------------------------------------------------
test('R2: a kick without a server reply is still confirmed by status', async () => {
  const ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf')), status()], kickError: 'RCON_TIMEOUT' });
  assert.deepEqual(await ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { kicked: true, slot: 3 });
});

test('R2: each confirmation uses its own short vault scope; a lock after sending reports NOT_CONFIRMED', async () => {
  let ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf')), status(row(3, '1234567890', 'Wolf')), status()] });
  await ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a');
  assert.equal(ctx.vault.scopes, 3, 'check+kick in one scope, then one scope per confirmation');
  ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf'))], lockAfterScopes: 1 });
  await assert.rejects(ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { code: 'RCON_KICK_NOT_CONFIRMED' });
  assert.equal(ctx.kicks.length, 1);
});

test('R8: a status reply without the player header never counts as confirmation', async () => {
  const ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf')), 'map     : mp_crash\n', 'map     : mp_crash\n', 'map     : mp_crash\n'] });
  await assert.rejects(ctx.rcon.kick('srv', { slot: 3, playerid: '1234567890' }, 'a'), { code: 'RCON_KICK_NOT_CONFIRMED' });
});

test('R1/R9: findOnline is cached briefly and ignores ZMBI and CNCT rows', async () => {
  const ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf'), row(4, '2222222222', 'Joiner').replace('   48 ', ' CNCT '), row(5, '3333333333', 'Gone').replace('   48 ', ' ZMBI '))] });
  assert.deepEqual([...(await ctx.rcon.findOnline('srv')).entries()], [['1234567890', 3]]);
  await ctx.rcon.findOnline('srv');
  assert.equal(ctx.commands.length, 1, 'second lookup within the cache window sends nothing');
});

test('R6: IPv6 addresses are masked without losing the prefix', async () => {
  const ctx = service({ statuses: [status(row(3, '1234567890', 'Wolf', '[2001:db8::7]:28960'))] });
  assert.equal((await ctx.rcon.online('srv')).players[0].address, '2001:db8::x');
});

test('R11: non-string JSON fields are refused before any I/O', async () => {
  const ctx = service();
  for (const target of [{ slot: '3', playerid: '1' }, { slot: 3, playerid: 5 }, { slot: 3, name: 5 }, { slot: 3, playerid: '1', reason: 5 }, { slot: 3.5, playerid: '1' }]) {
    await assert.rejects(ctx.rcon.kick('srv', target, 'a'), { code: 'RCON_KICK_INVALID' }, JSON.stringify(target));
  }
  assert.equal(ctx.commands.length, 0);
});
