import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayActions } from '../lib/gateway-actions.mjs';

// Records which service saw which call, so local alpha and remote rmt_alpha can be told apart.
function setup() {
  const calls = [];
  const rconFor = side => ({
    online: async (id, options) => { calls.push([side, 'online', id, options]); return { map: `${side}-map`, players: [{ slot: 1, name: 'A', ping: 30, score: 2, bot: false, address: '1.2.3.4' }, { slot: 2, name: 'B', ping: 'CNCT', score: 0, bot: false }] }; },
    say: async (id, text, actor) => { calls.push([side, 'say', id, text, actor]); return { said: true }; },
    kick: async (id, target, actor) => { calls.push([side, 'kick', id, target, actor]); return { kicked: true }; },
  });
  const audits = [];
  const known = { alpha: { id: 'alpha', name: 'Local Alpha' }, rmt_alpha: { id: 'rmt_alpha', name: 'Remote Alpha' } };
  const actions = createGatewayActions({
    resolve: id => known[id] || (() => { throw Object.assign(new Error('INSTANCE_NOT_FOUND'), { code: 'INSTANCE_NOT_FOUND' }); })(),
    local: { rcon: rconFor('local'), restart: async id => { calls.push(['local', 'restart', id]); return { status: 'RUNNING' }; } },
    remote: { rcon: rconFor('remote'), restart: async id => { calls.push(['remote', 'restart', id]); return { status: 'RUNNING' }; } },
    audit: (level, event, details) => audits.push({ level, event, ...details }),
  });
  return { actions, calls, audits };
}

test('players: local alpha and remote rmt_alpha reach different services, the remote one by its own id', async () => {
  const { actions, calls } = setup();
  const local = await actions.players('alpha');
  const remote = await actions.players('rmt_alpha');
  assert.deepEqual([local.instance, local.map], [{ id: 'alpha', name: 'Local Alpha' }, 'local-map']);
  assert.deepEqual([remote.instance, remote.map], [{ id: 'rmt_alpha', name: 'Remote Alpha' }, 'remote-map']);
  assert.deepEqual(calls.map(call => call.slice(0, 4)), [['local', 'online', 'alpha', { full: false }], ['remote', 'online', 'alpha', { full: false }]]);
  assert.deepEqual(remote.players, [{ slot: 1, name: 'A', ping: 30, score: 2, bot: false }], 'connecting players and addresses are left out');
});

test('say, kick and restart on rmt_ ids go to the remote services, marked as remote actions', async () => {
  const { actions, calls, audits } = setup();
  await actions.say('rmt_alpha', 'hello', 'ops');
  assert.deepEqual(await actions.kick('rmt_alpha', { slot: 1, name: 'A', reason: 'afk' }, 'ops'), { kick: { kicked: true } });
  assert.deepEqual(await actions.restart('rmt_alpha', 'ops'), { restarted: true, status: 'RUNNING' });
  assert.deepEqual(calls, [['remote', 'say', 'alpha', 'hello', 'remote:ops'], ['remote', 'kick', 'alpha', { slot: 1, name: 'A', reason: 'afk' }, 'remote:ops'], ['remote', 'restart', 'alpha']]);
  assert.deepEqual(audits, [{ level: 'warn', event: 'instance.restart', instanceId: 'rmt_alpha', actor: 'remote:ops' }]);
});

test('the local path is unchanged', async () => {
  const { actions, calls } = setup();
  await actions.restart('alpha', 'ops');
  await actions.kick('alpha', { slot: 1, name: 'A', reason: '' }, 'ops');
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['local', 'restart', 'alpha'], ['local', 'kick', 'alpha']]);
});

test('an unknown or removed server is INSTANCE_NOT_FOUND before any service call; a kick needs a name', async () => {
  const { actions, calls } = setup();
  for (const id of ['rmt_gone', 'gone']) {
    await assert.rejects(actions.players(id), { code: 'INSTANCE_NOT_FOUND' });
    await assert.rejects(actions.restart(id, 'ops'), { code: 'INSTANCE_NOT_FOUND' });
  }
  await assert.rejects(actions.kick('rmt_alpha', { slot: 1 }, 'ops'), { code: 'RCON_KICK_INVALID' });
  assert.deepEqual(calls, []);
});
