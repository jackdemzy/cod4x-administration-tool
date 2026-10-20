import test from 'node:test';
import assert from 'node:assert/strict';
import { parseB3Log, parseB3ConfigSummary, redactB3Config, buildB3Dashboard, B3_DIAGNOSES } from '../lib/b3-manager.mjs';

// Log lines in the format eBc-B3 9096624 actually wrote in WSL (Block 12 native run).
const startup = [
  '261019 00:41:50 BOT      \'Starting Cod4XParser v0.4 for server 127.0.0.1:28999 (autorestart = True)\'',
  '261019 00:41:50 BOT      \'Using database file: /home/x/b3/b3.db\'',
  '261019 00:41:52 WARNING  "RCON: error reading: error(111, \'Connection refused\')"',
  '261019 00:41:52 ERROR    "RCON: too many tries: aborting (\'status\')"',
  '261019 00:41:55 BOT      \'Start reading game events\'',
].join('\n');
const okModules = { status: 'OK', found: '2.7.18' };
const deps = (overrides = {}) => ({
  source: { b3Version: '1.10.10', commit: '90966246ab1953ceeca5e8b62c714851a120b28a' },
  results: [{ id: 'python', ...okModules }, { id: 'b3-source', status: 'OK', found: '1.10.10' }, { id: 'dateutil', status: 'OK' }, { id: 'mysql-driver', status: 'OK' }]
    .map(row => ({ ...row, ...(overrides[row.id] || {}) })),
});
const running = { runtime: { status: 'RUNNING', running: true }, health: { status: 'HEALTHY', alive: true } };
const serverUp = { status: 'RUNNING', reachable: true };

test('B3 log parser reads parser, database and RCON state from the real message format', () => {
  const log = parseB3Log(startup);
  assert.deepEqual(log.parser, { name: 'Cod4XParser', version: '0.4', started: true, reading: true });
  assert.deepEqual(log.database, { kind: 'sqlite', state: 'CONNECTED' });
  assert.equal(log.rcon.state, 'OFFLINE');
  assert.equal(parseB3Log(startup + '\n261019 00:42:10 VERBOSE2 "RCON: received \'\\xff\\xff\\xff\\xffprint\\nmap: mp_backlot\'"').rcon.state, 'CONNECTED', 'latest RCON line wins');
  assert.equal(parseB3Log('x VERBOSE2 "RCON: received \'\\xff\\xff\\xff\\xffprint\\nBad rcon\'"').rcon.state, 'AUTH_FAILED', 'a rejected password is not a connection');
  // Real lines from the Block 13 native run (log_level 9 has no verbose2).
  assert.equal(parseB3Log("261019 01:07:28 DEBUG    'Get cvar fs_game = [No rconpassword set on server or password is shorter than 8 characters.\\n]'").rcon.state, 'AUTH_FAILED');
  assert.equal(parseB3Log("261019 01:07:28 DEBUG    'Get cvar fs_game = [main]'").rcon.state, 'CONNECTED');
  assert.equal(parseB3Log("261019 01:07:33 INFO     'PublistPlugin: publist will not send heartbeat to master server as publicIp is not public'").publist, 'SUPPRESSED');
  assert.deepEqual(parseB3Log("x BOT 'Successfully established a connection with MySQL database'\nx ERROR 'Database connection failed: (2003)'").database, { kind: 'mysql', state: 'OFFLINE' });
  assert.equal(parseB3Log("x CRITICAL 'Missing MySQL database tables. You need to create'").database.state, 'SCHEMA_MISSING');
  assert.equal(parseB3Log("x CRITICAL 'Cannot setup RCON: boom'").critical, 'RCON_SETUP_FAILED');
});

test('regression: evidence from a previous B3 run never describes the current run', () => {
  // B3 appends to b3.log (RotatingFileHandler); a new parser start is the run boundary.
  const previous = [startup, "261019 01:00:02 DEBUG    'Get cvar fs_game = [main]'", "261019 01:00:05 CRITICAL 'Cannot setup RCON: old'"].join('\n');
  const fresh = parseB3Log(`${previous}\n261019 02:00:00 BOT      'Starting Cod4XParser v0.4 for server 127.0.0.1:28999 (autorestart = True)'`);
  assert.deepEqual([fresh.database.state, fresh.rcon.state, fresh.critical, fresh.parser.reading, fresh.publist], ['UNKNOWN', 'UNKNOWN', null, false, 'UNKNOWN']);
  const board = buildB3Dashboard({ dependencies: deps(), ...running, log: fresh, config: null, server: serverUp });
  assert.deepEqual([board.checks.database.ok, board.checks.rcon.ok, board.checks.parser.state, board.diagnosis], [null, null, 'STARTING', []]);
});

test('regression: undated lines keep their first character', () => {
  assert.equal(parseB3Log('Start reading game events').parser.reading, true);
  assert.equal(parseB3Log('Using database file: /x/b3.db').database.state, 'CONNECTED');
  assert.equal(parseB3Log("261019 01:07:24 BOT      'Using database file: /x/b3.db'").database.state, 'CONNECTED');
});

test('regression: an unknown server state is not diagnosed as CoD4X offline', () => {
  for (const server of [{ status: 'UNKNOWN', reachable: null }, { status: 'RUNNING', reachable: null }, null]) {
    const board = buildB3Dashboard({ dependencies: deps(), ...running, log: { ...parseB3Log(startup), rcon: { state: 'CONNECTED' } }, config: null, server });
    assert.deepEqual([board.checks.cod4x.ok, board.checks.cod4x.state, board.diagnosis], [null, 'UNKNOWN', []], JSON.stringify(server));
  }
  const offline = buildB3Dashboard({ dependencies: deps(), ...running, log: { ...parseB3Log(startup), rcon: { state: 'CONNECTED' } }, config: null, server: { status: 'RUNNING', reachable: false } });
  assert.deepEqual([offline.checks.cod4x.state, offline.primary], ['UNREACHABLE', 'COD4X_OFFLINE']);
});

test('config summary never returns credentials and the config view is redacted', () => {
  // Regression: an "@" inside the password must not leak the remainder.
  const tricky = redactB3Config('<set name="database">mysql://b3:p@ss@w0rd@127.0.0.1:3306/b3</set>');
  assert.equal(tricky, '<set name="database">mysql://b3:[redacted]@127.0.0.1:3306/b3</set>');
  const xml = '<set name="parser">cod4x</set><set name="database">mysql://b3:Sup3r-Secret@127.0.0.1/b3</set><set name="rcon_password">Rcon-Secret-1</set><set name="port">28960</set>';
  assert.deepEqual(parseB3ConfigSummary(xml), { parser: 'cod4x', databaseKind: 'mysql', port: 28960, publicIp: null });
  // publist (B3 must-have plugin) only stays silent for public_ip 127.0.0.1.
  const board = publicIp => buildB3Dashboard({ dependencies: deps(), ...running, log: parseB3Log(startup), config: { parser: 'cod4x', databaseKind: 'sqlite', publicIp }, server: serverUp }).publist;
  assert.deepEqual([board('127.0.0.1'), board('203.0.113.7')], ['SUPPRESSED', 'EXPOSED']);
  const shown = redactB3Config(xml);
  assert.ok(!shown.includes('Sup3r-Secret') && !shown.includes('Rcon-Secret-1'));
  assert.match(shown, /mysql:\/\/b3:\[redacted\]@127\.0\.0\.1/);
});

test('dashboard distinguishes every roadmap failure cause and orders the root cause first', () => {
  const healthyInput = { dependencies: deps(), ...running, log: { ...parseB3Log(startup), rcon: { state: 'CONNECTED' } }, config: { parser: 'cod4x', databaseKind: 'sqlite' }, server: serverUp };
  const healthy = buildB3Dashboard(healthyInput);
  assert.deepEqual(Object.fromEntries(Object.entries(healthy.checks).map(([key, value]) => [key, value.ok])), { python: true, b3: true, mysql: null, database: true, parser: true, rcon: true, cod4x: true });
  assert.deepEqual([healthy.diagnosis, healthy.version.commit, healthy.parser, healthy.database], [[], '9096624', 'Cod4XParser v0.4', 'sqlite:CONNECTED']);
  assert.match(healthy.checks.mysql.state, /SQLITE \(MySQL: NOT_SET_UP\)/);
  assert.ok(!JSON.stringify(healthy).includes('Block 14'));
  const prepared = buildB3Dashboard({ ...healthyInput, database: { ready: true, lastCheck: { code: null } } });
  assert.equal(prepared.checks.mysql.state, 'SQLITE (MySQL: READY, restart B3)');
  const failing = buildB3Dashboard({ ...healthyInput, database: { ready: false, lastCheck: { code: 'DB_AUTH_FAILED' } } });
  assert.equal(failing.checks.mysql.state, 'SQLITE (MySQL: DB_AUTH_FAILED)');
  const cases = [
    ['PYTHON_MISSING', { dependencies: deps({ python: { status: 'MISSING' } }) }],
    ['PYTHON_INCOMPATIBLE', { dependencies: deps({ python: { status: 'INCOMPATIBLE', found: '3.11.5' } }) }],
    ['B3_MISSING', { dependencies: deps({ 'b3-source': { status: 'MISSING' } }) }],
    ['B3_INCOMPATIBLE', { dependencies: deps({ 'b3-source': { status: 'INCOMPATIBLE', detail: 'B3_KNOWN_BROKEN_COMMIT' } }) }],
    ['DEPENDENCY_MISSING', { dependencies: deps({ dateutil: { status: 'MISSING' } }) }],
    ['DB_OFFLINE', { log: { ...parseB3Log(startup), database: { kind: 'mysql', state: 'OFFLINE' }, rcon: { state: 'CONNECTED' } } }],
    ['PARSER_OFFLINE', { log: { parser: { started: true, reading: false }, database: { kind: 'sqlite', state: 'CONNECTED' }, rcon: { state: 'CONNECTED' }, critical: 'B3_CRITICAL' } }],
    ['RCON_OFFLINE', { log: { ...parseB3Log(startup), rcon: { state: 'AUTH_FAILED' } } }],
    ['COD4X_OFFLINE', { server: { status: 'STOPPED', reachable: false }, log: { ...parseB3Log(startup), rcon: { state: 'CONNECTED' } } }],
  ];
  for (const [code, overrides] of cases) {
    const result = buildB3Dashboard({ dependencies: deps(), ...running, log: { ...parseB3Log(startup), rcon: { state: 'CONNECTED' } }, config: { parser: 'cod4x', databaseKind: 'sqlite' }, server: serverUp, ...overrides });
    assert.ok(result.diagnosis.includes(code), `${code} detected: ${result.diagnosis}`);
    assert.equal(result.primary, code, `${code} is the only/primary cause`);
  }
  assert.ok(B3_DIAGNOSES.length >= 7);
  // Server down explains RCON down: root cause first, RCON marked as consequence.
  const both = buildB3Dashboard({ dependencies: deps(), ...running, log: parseB3Log(startup), config: null, server: { status: 'STOPPED', reachable: false } });
  assert.deepEqual([both.diagnosis, both.primary, both.rconCause], [['COD4X_OFFLINE', 'RCON_OFFLINE'], 'COD4X_OFFLINE', 'COD4X_OFFLINE']);
  // A stopped B3 never reports stale runtime evidence as current.
  const stopped = buildB3Dashboard({ dependencies: deps(), runtime: { status: 'STOPPED', running: false }, health: { status: 'DOWN', alive: false }, log: parseB3Log(startup), config: null, server: serverUp });
  assert.deepEqual([stopped.checks.parser.ok, stopped.checks.rcon.ok, stopped.database, stopped.diagnosis], [null, null, 'NOT_RUNNING', []]);
});
