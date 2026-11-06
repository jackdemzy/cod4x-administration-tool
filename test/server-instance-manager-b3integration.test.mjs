import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

const pluginBytes = label => Buffer.from(`fake plugin ${label} `.padEnd(256, '#'));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function fixture(t) { const value = await createRconFixture(); t.after(value.cleanup); return value; }
async function approvedB3hide({ manager, create, store, setRcon }, id) {
  await create(id);
  const file = path.join(store.get(id).homePath, 'plugins', 'b3hide.dll'), bytes = pluginBytes('b3hide');
  await fs.writeFile(file, bytes);
  await manager.approvePlugin(id, { name: 'b3hide', sha256: sha(bytes) });
  await setRcon(id, 'Rcon-Secret-1');
  return file;
}

test('switching on enables the b3hide record with the plan dvars and locks its config', async t => {
  const context = await fixture(t);
  const { manager } = context;
  await approvedB3hide(context, 'b3i-on');
  const result = await manager.configureB3Integration('b3i-on', { hideCommands: true, prefix: '!', hideLevel: 20 });
  assert.deepEqual(result.settings, { hideCommands: true, prefix: '!', hideLevel: 20 });
  const b3hide = (await manager.plugins('b3i-on')).plugins.find(plugin => plugin.name === 'b3hide');
  assert.equal(b3hide.state, 'ENABLED');
  assert.deepEqual(b3hide.config, { b3Prefix: '!', b3Hide: '1', b3HideLvl: '20' });
  await assert.rejects(manager.configurePlugin('b3i-on', 'b3hide', { b3HideLvl: '40' }), { code: 'B3_INTEGRATION_CONTROLLED' });
  await manager.configureB3Integration('b3i-on', { hideCommands: false, prefix: '!', hideLevel: 20 });
  assert.equal((await manager.plugins('b3i-on')).plugins.find(plugin => plugin.name === 'b3hide').state, 'DISABLED');
  await manager.configurePlugin('b3i-on', 'b3hide', { b3HideLvl: '40' });
});

test('settings changes need a stopped server', async t => {
  const context = await fixture(t);
  await approvedB3hide(context, 'b3i-busy');
  await context.manager.launch('b3i-busy');
  await assert.rejects(context.manager.configureB3Integration('b3i-busy', { hideCommands: true, prefix: '!', hideLevel: 20 }), { code: 'B3_INTEGRATION_BUSY' });
});

test('the launch passes the plan dvars and blocks a tampered b3hide before spawning', async t => {
  const context = await fixture(t);
  const { manager, children } = context;
  const file = await approvedB3hide(context, 'b3i-launch');
  await manager.configureB3Integration('b3i-launch', { hideCommands: true, prefix: '!', hideLevel: 40 });
  const state = await manager.launch('b3i-launch');
  const args = children.get(state.pid).args, load = args.indexOf('+loadPlugin');
  assert.deepEqual(args.slice(load, load + 11), ['+loadPlugin', 'b3hide', '+set', 'b3Prefix', '!', '+set', 'b3Hide', '1', '+set', 'b3HideLvl', '40']);
  assert.match(manager.launchedWith('b3i-launch').fingerprint, /^[0-9a-f]{64}$/);
  await manager.stop('b3i-launch');
  const spawned = children.size;
  await fs.writeFile(file, pluginBytes('tampered'));
  await assert.rejects(manager.launch('b3i-launch'), { code: 'B3HIDE_INTEGRITY_FAILED' });
  assert.equal(children.size, spawned);
});

test('b3Integration reports the plan and whether the file matches a release hash', async t => {
  const context = await fixture(t);
  await approvedB3hide(context, 'b3i-view');
  const view = await context.manager.b3Integration('b3i-view');
  assert.deepEqual(view.settings, { hideCommands: false, prefix: '!', hideLevel: 20 });
  assert.equal(view.plan.enabled, false);
  assert.equal(view.knownHash, false);
  assert.equal(view.b3hide.state, 'DISABLED');
});
