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

test('B3 manager dashboard: health checks, root cause, logs and redacted config view', async t => {
  const { manager, b3Service, create, store, environment } = await fixture(t);
  await create('b3-dash');
  let board = await b3Service.dashboard('b3-dash');
  assert.deepEqual([board.status, board.diagnosis], ['STOPPED', ['COD4X_OFFLINE']]);
  await manager.launch('b3-dash');
  await b3Service.start('b3-dash');
  const logFile = path.join(store.get('b3-dash').homePath, 'b3', 'b3.log');
  await fs.writeFile(logFile, "x BOT 'Starting Cod4XParser v0.4 for server 127.0.0.1:1 (autorestart = True)'\nx BOT 'Using database file: /x/b3.db'\nx VERBOSE2 \"RCON: received 'print\\nmap: mp_backlot'\"\nx BOT 'Start reading game events'\n");
  board = await b3Service.dashboard('b3-dash', { fresh: true });
  assert.deepEqual(Object.fromEntries(Object.entries(board.checks).map(([key, value]) => [key, value.ok])), { python: true, b3: true, mysql: null, database: true, parser: true, rcon: true, cod4x: true });
  assert.deepEqual([board.diagnosis, board.parser, board.version.commit], [[], 'Cod4XParser v0.4', '9096624']);
  // Server stop: B3 keeps running, the dashboard names CoD4X as root cause.
  await manager.stop('b3-dash');
  await fs.appendFile(logFile, "x ERROR \"RCON: too many tries: aborting ('status')\"\n");
  board = await b3Service.dashboard('b3-dash');
  assert.deepEqual([board.status, board.diagnosis, board.primary, board.rconCause], ['RUNNING', ['COD4X_OFFLINE', 'RCON_OFFLINE'], 'COD4X_OFFLINE', 'COD4X_OFFLINE']);
  // Regression (Block 13 native run): the answer contains "rconpassword"; the
  // redacted logs view hides that line, but the dashboard must still classify it.
  await manager.launch('b3-dash');
  await fs.appendFile(logFile, "261019 01:07:28 DEBUG    'Get cvar fs_game = [No rconpassword set on server or password is shorter than 8 characters.\\n]'\n");
  board = await b3Service.dashboard('b3-dash');
  assert.deepEqual([board.rcon, board.primary, board.checks.cod4x.ok], ['AUTH_FAILED', 'RCON_OFFLINE', true]);
  assert.ok(!(await b3Service.logs('b3-dash')).b3Log.includes('rconpassword'), 'logs view stays redacted');
  await manager.stop('b3-dash');
  // Dashboards reuse a recent dependency check; starts always re-check.
  const before = environment.checks;
  await b3Service.dashboard('b3-dash'); await b3Service.dashboard('b3-dash');
  assert.equal(environment.checks, before);
  const logs = await b3Service.logs('b3-dash');
  assert.match(logs.b3Log, /Start reading game events/);
  const config = await b3Service.config('b3-dash');
  assert.deepEqual([config.exists, config.summary.parser, config.summary.databaseKind], [true, 'cod4x', 'sqlite']);
  assert.match(config.text, /<set name="rcon_password">\[redacted\]<\/set>/);
});

test('regression: dependency checks are shared, invalidated on new paths and never cached from a stale run', async () => {
  const { InstanceB3Service } = await import('../lib/instance-b3-service.mjs');
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const environment = { check: async () => { const call = ++calls; if (call === 1) await gate; return { overall: 'READY_FOR_RUNTIME_TEST', marker: call }; } };
  const service = new InstanceB3Service({ store: { get: () => ({}) }, environment, dependencyCacheMs: 60000 });
  const concurrent = [service.dependencies(), service.dependencies(), service.dependencies()];
  // Settings saved while the first (old) check is still running.
  service.invalidateDependencies();
  const afterChange = service.dependencies();
  release();
  const [first, second, third] = await Promise.all(concurrent);
  assert.equal(first, second); assert.equal(second, third);
  assert.equal((await afterChange).marker, 2, 'a check after the change runs separately');
  assert.equal(calls, 2, 'three concurrent callers shared one probe');
  assert.equal((await service.dependencies()).marker, 2, 'the cache holds the post-change result, not the stale one');
  assert.equal(calls, 2);
});

test('regression: a failing server status lookup is shown as unknown, not CoD4X offline', async t => {
  const { b3Service, create } = await fixture(t);
  await create('b3-unknown');
  b3Service.serverStatus = async () => { throw Object.assign(new Error('Windows process inspection returned no result'), { code: 'RUNTIME_INSPECTION_FAILED' }); };
  const board = await b3Service.dashboard('b3-unknown');
  assert.deepEqual([board.checks.cod4x.ok, board.checks.cod4x.state, board.diagnosis.includes('COD4X_OFFLINE')], [null, 'UNKNOWN', false]);
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

test('B3 start writes the MySQL DSN only when the database is ready; locked vault keeps the previous b3.xml', async t => {
  const { b3Service, create, store } = await fixture(t);
  await create('b3-db');
  const config = path.join(store.get('b3-db').homePath, 'b3', 'b3.xml');
  let ready = false, locked = false;
  const password = 'Db-Secret-Pass!9';
  b3Service.database = {
    read: async () => ({ ready }),
    connectionFor: async (id, buffer) => (ready ? { dsn: `mysql://b3:${buffer.toString()}@127.0.0.1:3306/b3` } : null),
  };
  b3Service.credentials = {
    async withRuntimeCredentials(id, fn) {
      if (locked) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
      const b3db = Buffer.from(password);
      try { return await fn({ b3db }); } finally { b3db.fill(0); }
    },
  };
  await b3Service.start('b3-db');
  assert.match(await fs.readFile(config, 'utf8'), /<set name="database">sqlite:\/\//);
  await b3Service.stop('b3-db');
  ready = true;
  await b3Service.start('b3-db');
  const xml = await fs.readFile(config, 'utf8');
  assert.ok(xml.includes(`<set name="database">mysql://b3:${password}@127.0.0.1:3306/b3</set>`));
  const view = await b3Service.config('b3-db');
  assert.ok(!JSON.stringify(view).includes(password));
  assert.equal(view.summary.databaseKind, 'mysql');
  await b3Service.stop('b3-db');
  locked = true;
  await assert.rejects(b3Service.start('b3-db'), { code: 'VAULT_LOCKED' });
  assert.equal(await fs.readFile(config, 'utf8'), xml);
});
