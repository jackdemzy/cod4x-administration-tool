import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  validateDatabaseSettings, validDatabasePassword, buildMysqlDsn, parseSchemaFile, classifySchema, classifyDatabaseError,
  planMigration, splitSqlStatements, statementTable, EBC_CONFIRMATION, CORE_SQL, EBC_SQL, EBC_TABLES,
} from '../lib/b3-database.mjs';

const fixture = new URL('./fixtures/b3-mysql-b3.sql', import.meta.url);
const normalizedHash = buffer => crypto.createHash('sha256').update(Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');
const code = fn => { try { fn(); } catch (error) { return error.code; } return null; };
// eBc-B3 b3/functions.py splitDSN, ported verbatim.
const splitDSN = url => /^(?:(?<protocol>[a-z]+):\/\/)?(?:(?<user>[^:]+)(?::(?<password>[^@]*?))?@)?(?<host>[^/:]+)?(?::(?<port>\d+))?(?<path>.*)/.exec(url).groups;
const CORE_TABLES = ['aliases', 'ipaliases', 'clients', 'groups', 'penalties', 'data'];

test('settings validation rejects DSN-breaking input', () => {
  const ok = { host: '127.0.0.1', database: 'b3', username: 'b3' };
  assert.deepEqual(validateDatabaseSettings(ok), { ...ok, port: 3306 });
  for (const bad of [{ host: 'a/b' }, { host: 'a:b' }, { database: 'b3-db' }, { username: 'b3:x' }, { username: 'b3@x' }, { port: 0 }, { port: 65536 }, { port: '3306' }, { extra: 1 }]) {
    assert.equal(code(() => validateDatabaseSettings({ ...ok, ...bad })), 'B3_DATABASE_SETTINGS_INVALID', JSON.stringify(bad));
  }
  assert.equal(code(() => validateDatabaseSettings(null)), 'B3_DATABASE_SETTINGS_INVALID');
});

test('password policy rejects @, quotes, spaces and short values', () => {
  for (const bad of ['pass@word1', 'pass word1', 'short', 'pass"word1', 'pass;word1', 'pass\\word1', 'x'.repeat(129), 'pässwörd12', 12345678]) {
    assert.equal(code(() => validDatabasePassword(bad)), 'CREDENTIAL_INVALID', String(bad));
  }
  assert.doesNotThrow(() => validDatabasePassword('S3cure!pass'));
  assert.doesNotThrow(() => validDatabasePassword('a:b/c?d#e%f'));
});

test('DSN round-trips through the eBc-B3 splitDSN regex', () => {
  const alphabet = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).filter(char => !'@";\\'.includes(char));
  for (let i = 0; i < 50; i++) {
    const password = Array.from({ length: 8 + (i % 20) }, (_, j) => alphabet[(i * 31 + j * 7) % alphabet.length]).join('');
    const settings = { host: `db${i}.example-host.test`, port: 1000 + i, database: `b3_${i}`, username: `user_${i}` };
    const parts = splitDSN(buildMysqlDsn(settings, password));
    assert.deepEqual([parts.protocol, parts.user, parts.password, parts.host, Number(parts.port), parts.path], ['mysql', settings.username, password, settings.host, settings.port, `/${settings.database}`]);
  }
});

test('parses the real audited b3.sql', async () => {
  const bytes = await fs.readFile(fixture);
  assert.equal(normalizedHash(bytes), '9a41fb5fd455f3941063807a8b8a36462599534d167e026a3e3c4d4658a6b976');
  const { tables } = parseSchemaFile(bytes.toString('latin1'));
  assert.deepEqual(Object.keys(tables), CORE_TABLES);
  for (const column of ['guid', 'group_bits', 'login']) assert.ok(tables.clients.includes(column), column);
  assert.ok(!tables.clients.includes('id`') && !tables.clients.some(column => /KEY/.test(column)));
  assert.deepEqual(tables.data, ['data_key', 'data_value']);
});

test('classifies EMPTY, PARTIAL, COMPLETE, OUTDATED and ignores foreign tables', async () => {
  const { tables } = parseSchemaFile(await fs.readFile(fixture, 'latin1'));
  assert.equal(classifySchema(tables, { xlr_playerstats: ['id'] }).state, 'EMPTY');
  const complete = Object.fromEntries(Object.entries(tables).map(([name, columns]) => [name, [...columns]]));
  assert.deepEqual(classifySchema(tables, { ...complete, xlr_playerstats: ['id'] }), { state: 'COMPLETE', missingTables: [], missingColumns: {} });
  const { penalties, data, ...partial } = complete;
  assert.deepEqual(classifySchema(tables, partial), { state: 'PARTIAL', missingTables: ['penalties', 'data'], missingColumns: {} });
  const outdated = { ...partial, clients: complete.clients.filter(column => column !== 'login') };
  assert.deepEqual(classifySchema(tables, outdated), { state: 'OUTDATED', missingTables: ['penalties', 'data'], missingColumns: { clients: ['login'] } });
});

test('maps MySQL error codes', () => {
  assert.equal(classifyDatabaseError(2003), 'DB_UNREACHABLE');
  assert.equal(classifyDatabaseError(2013), 'DB_UNREACHABLE');
  assert.equal(classifyDatabaseError('TIMEOUT'), 'DB_UNREACHABLE');
  assert.equal(classifyDatabaseError(1045), 'DB_AUTH_FAILED');
  // MariaDB answers an unknown user over TCP with 1698 (seen against MariaDB 10.11).
  assert.equal(classifyDatabaseError(1698), 'DB_AUTH_FAILED');
  assert.equal(classifyDatabaseError(1044), 'DB_ACCESS_DENIED');
  assert.equal(classifyDatabaseError(1049), 'DB_NOT_FOUND');
  assert.equal(classifyDatabaseError('DRIVER_MISSING'), 'DB_DRIVER_MISSING');
  assert.equal(classifyDatabaseError(9999), 'DB_ERROR');
});

test('plans migrations', () => {
  assert.deepEqual(planMigration({ schema: { state: 'EMPTY' }, tableCount: 0, ebcOptIn: false }), { files: [CORE_SQL], backup: false });
  assert.deepEqual(planMigration({ schema: { state: 'EMPTY' }, tableCount: 2, ebcOptIn: false }), { files: [CORE_SQL], backup: true });
  assert.deepEqual(planMigration({ schema: { state: 'PARTIAL' }, tableCount: 4, ebcOptIn: false }), { files: [CORE_SQL], backup: true });
  assert.deepEqual(planMigration({ schema: { state: 'COMPLETE' }, tableCount: 6, ebcOptIn: true, confirmation: EBC_CONFIRMATION }), { files: [EBC_SQL], backup: true });
  assert.deepEqual(planMigration({ schema: { state: 'EMPTY' }, tableCount: 0, ebcOptIn: true, confirmation: EBC_CONFIRMATION }), { files: [CORE_SQL, EBC_SQL], backup: false });
  assert.equal(code(() => planMigration({ schema: { state: 'COMPLETE' }, tableCount: 6, ebcOptIn: true, confirmation: 'drop player_core and prestige_log' })), 'EBC_CONFIRMATION_REQUIRED');
  assert.equal(code(() => planMigration({ schema: { state: 'OUTDATED' }, tableCount: 6, ebcOptIn: false })), 'SCHEMA_OUTDATED');
  assert.equal(code(() => planMigration({ schema: { state: 'COMPLETE' }, tableCount: 6, ebcOptIn: false })), 'B3_DATABASE_NOTHING_TO_DO');
  assert.equal(EBC_CONFIRMATION, 'DROP player_core AND prestige_log');
  assert.deepEqual(EBC_TABLES, ['player_core', 'prestige_log']);
});

test('splits SQL into statements and finds each target table', async () => {
  const statements = splitSqlStatements(await fs.readFile(fixture, 'latin1'));
  assert.equal(statements.filter(sql => /^CREATE TABLE/i.test(sql)).length, 6);
  assert.equal(statements.filter(sql => /^INSERT INTO/i.test(sql)).length, 8);
  assert.deepEqual([...new Set(statements.map(statementTable))], CORE_TABLES);
  // Quotes, comments and versioned comments.
  const mixed = splitSqlStatements("-- note; x\nSET NAMES utf8;\n/* a; b */ INSERT INTO `t` VALUES ('a;b', \"c;d\", 'it''s');\n/*!40101 SET @X=1 */;\n");
  assert.deepEqual(mixed, ['SET NAMES utf8', "INSERT INTO `t` VALUES ('a;b', \"c;d\", 'it''s')", '/*!40101 SET @X=1 */']);
  assert.equal(statementTable('DROP TABLE IF EXISTS `player_core`'), 'player_core');
  assert.equal(statementTable('ALTER TABLE `prestige_log` ADD KEY `x` (`x`)'), 'prestige_log');
  assert.equal(statementTable('SET time_zone = "+00:00"'), null);
});
