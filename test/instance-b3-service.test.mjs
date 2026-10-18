import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createB3InstanceFixture } from './support/b3-instance-fixture.mjs';

async function fixture(t, options) { const value = await createB3InstanceFixture(options); t.after(value.cleanup); return value; }
const until = async (predicate, ms = 1000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 5))) if (await predicate()) return true; return false; };

test('B3 lifecycle is independent of the CoD4x lifecycle in both directions', async t => {
  const { manager, b3Service, fake, create, store } = await fixture(t);
  await create('b3-a');
  const server = await manager.launch('b3-a');
  const b3 = (await b3Service.start('b3-a')).runtime;
  assert.deepEqual([server.status, b3.status], ['RUNNING', 'RUNNING']);
  // B3 crash: server keeps its PID and status.
  fake.crash(b3.pid, 1);
  const runtime = await b3Service.runtime('b3-a');
  assert.ok(await until(() => runtime.state.status === 'CRASHED'));
  let current = await manager.status('b3-a');
  assert.deepEqual([current.runtime.status, current.runtime.pid], ['RUNNING', server.pid]);
  // B3 restart: server untouched.
  const restarted = (await b3Service.start('b3-a', true)).runtime;
  current = await manager.status('b3-a');
  assert.deepEqual([current.runtime.status, current.runtime.pid], ['RUNNING', server.pid]);
  // Server stop and restart: B3 keeps its PID.
  await manager.stop('b3-a');
  assert.deepEqual([(await b3Service.status('b3-a')).runtime.status, (await b3Service.status('b3-a')).runtime.pid], ['RUNNING', restarted.pid]);
  const second = await manager.launch('b3-a');
  assert.notEqual(second.pid, server.pid);
  assert.equal((await b3Service.status('b3-a')).runtime.pid, restarted.pid);
  // B3 stop: server untouched.
  await b3Service.stop('b3-a');
  current = await manager.status('b3-a');
  assert.deepEqual([current.runtime.status, current.runtime.pid], ['RUNNING', second.pid]);
  // B3 may start without a running server (game log is created, never truncated).
  await manager.stop('b3-a');
  const gameLog = path.join(store.get('b3-a').homePath, 'main', 'logs', 'games_mp.log');
  await fs.appendFile(gameLog, 'kept\n');
  assert.equal((await b3Service.start('b3-a')).runtime.status, 'RUNNING');
  assert.match(await fs.readFile(gameLog, 'utf8'), /kept\n$/);
  await assert.rejects(manager.archive('b3-a'), { code: 'B3_RUNNING' });
});

test('B3 never starts with blocked or unaudited dependencies and keeps instances separate', async t => {
  const blocked = await fixture(t, { dependencies: { overall: 'BLOCKED', blocking: ['python'] } });
  await blocked.create('b3-x');
  await assert.rejects(blocked.b3Service.start('b3-x'), error => error.code === 'B3_DEPENDENCIES_BLOCKED' && error.blocking.includes('python'));
  assert.equal(blocked.fake.spawned.length, 0);
  const unaudited = await fixture(t, { dependencies: { overall: 'UNAUDITED', blocking: [] } });
  await unaudited.create('b3-y');
  await assert.rejects(unaudited.b3Service.start('b3-y'), { code: 'B3_DEPENDENCIES_BLOCKED' });
  const { b3Service, create, fake, store } = await fixture(t);
  await create('b3-one'); await create('b3-two');
  const one = (await b3Service.start('b3-one')).runtime;
  const two = (await b3Service.start('b3-two')).runtime;
  fake.crash(one.pid);
  const runtimeOne = await b3Service.runtime('b3-one');
  assert.ok(await until(() => runtimeOne.state.status === 'CRASHED'));
  assert.deepEqual([(await b3Service.status('b3-two')).runtime.status, (await b3Service.status('b3-two')).runtime.pid], ['RUNNING', two.pid]);
  // Each instance gets its own config with its own port, database and game log.
  const startedOne = await b3Service.start('b3-one');
  const configOne = await fs.readFile(startedOne.config.path, 'utf8');
  const configTwo = await fs.readFile(path.join(store.get('b3-two').homePath, 'b3', 'b3.xml'), 'utf8');
  assert.ok(configOne.includes(`<set name="port">${store.get('b3-one').port}</set>`));
  assert.ok(configTwo.includes(`<set name="port">${store.get('b3-two').port}</set>`));
  assert.ok(configOne.includes(path.join(store.get('b3-one').homePath, 'b3', 'b3.db').replace(/\\/g, '/')) && !configOne.includes(store.get('b3-two').homePath));
});
