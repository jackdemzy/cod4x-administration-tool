import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAuditedSql } from '../lib/b3-database-helper.mjs';
import { B3_SOURCE } from '../lib/b3-dependencies.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const rejects = async (promise, code) => assert.equal(await promise.then(() => null, error => error.code), code);

async function b3Tree() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-sql-')));
  const sql = path.join(root, 'b3', 'sql', 'mysql');
  await fs.mkdir(sql, { recursive: true });
  await fs.copyFile(new URL('b3-mysql-b3.sql', fixtures), path.join(sql, 'b3.sql'));
  await fs.copyFile(new URL('b3-mysql-b3-update-ebc.sql', fixtures), path.join(sql, 'b3-update-ebc.sql'));
  await fs.writeFile(path.join(sql, 'b3-update-1.9.0.sql'), 'ALTER TABLE `clients` ADD `x` INT;');
  return { root, sql };
}

test('audited SQL hashes are pinned for the core and eBc schema', () => {
  assert.equal(B3_SOURCE.auditedSql['b3/sql/mysql/b3.sql'], B3_SOURCE.auditedFiles['b3/sql/mysql/b3.sql']);
  assert.equal(B3_SOURCE.auditedSql['b3/sql/mysql/b3-update-ebc.sql'], '37af9d3f190d0ad8cebad0996547edd3e800f56440e86390deffdc106f4cc97a');
  assert.ok(B3_SOURCE.blockedSql.includes('b3/sql/mysql/b3-update-ebc.sql'), 'eBc SQL stays blocked for automatic use');
  assert.ok(!('b3/sql/mysql/b3-update-ebc.sql' in B3_SOURCE.auditedFiles), 'optional eBc SQL must not gate the B3 runtime');
});

test('readAuditedSql accepts the pinned files and rejects others', async () => {
  const { root } = await b3Tree();
  try {
    const core = await readAuditedSql(root, 'b3/sql/mysql/b3.sql');
    assert.equal(core.sha256, B3_SOURCE.auditedSql['b3/sql/mysql/b3.sql']);
    assert.match(core.text, /CREATE TABLE IF NOT EXISTS `aliases`/);
    assert.equal((await readAuditedSql(root, 'b3/sql/mysql/b3-update-ebc.sql')).sha256, B3_SOURCE.auditedSql['b3/sql/mysql/b3-update-ebc.sql']);
    await rejects(readAuditedSql(root, 'b3/sql/mysql/b3-update-1.9.0.sql'), 'B3_SQL_NOT_ALLOWED');
    await rejects(readAuditedSql(root, '../b3.sql'), 'B3_SQL_NOT_ALLOWED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('readAuditedSql rejects a modified file', async () => {
  const { root, sql } = await b3Tree();
  try {
    await fs.appendFile(path.join(sql, 'b3.sql'), ' ');
    await rejects(readAuditedSql(root, 'b3/sql/mysql/b3.sql'), 'B3_SQL_HASH_MISMATCH');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('readAuditedSql rejects a symlinked or oversized file', async () => {
  const { root, sql } = await b3Tree();
  try {
    const target = path.join(sql, 'b3.sql');
    await fs.rename(target, path.join(root, 'real.sql'));
    let linked = true;
    try { await fs.symlink(path.join(root, 'real.sql'), target); } catch { linked = false; }
    if (linked) await rejects(readAuditedSql(root, 'b3/sql/mysql/b3.sql'), 'B3_SQL_UNSAFE');
    await fs.rm(target, { force: true });
    await fs.writeFile(target, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await rejects(readAuditedSql(root, 'b3/sql/mysql/b3.sql'), 'B3_SQL_UNSAFE');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// --- Task 3: helper runner -------------------------------------------------
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { runDatabaseHelper, DATABASE_HELPER } from '../lib/b3-database-helper.mjs';

const PASSWORD = 'S3cure!pass:/x';
const connection = { host: '127.0.0.1', port: 3306, database: 'b3', username: 'b3' };
const python = process.platform === 'win32' ? String.raw`C:\Python27\python.exe` : '/usr/bin/python2.7';

function fakeSpawn({ reply, exitCode = 0, hang = false, chunks } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    let stdin = '';
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; };
    child.stdin = new Writable({ write(chunk, _enc, done) { stdin += chunk; done(); }, final(done) {
      done();
      if (hang) return;
      setImmediate(() => {
        for (const part of chunks || [reply]) child.stdout.write(part);
        child.stdout.end();
        setImmediate(() => child.emit('close', exitCode, null));
      });
    } });
    calls.push({ file, args, options, stdin: () => stdin });
    return child;
  };
  return { spawnImpl, calls };
}

test('password and DSN never appear in argv or env; request goes to stdin', async () => {
  const { spawnImpl, calls } = fakeSpawn({ reply: '{"ok":true,"version":"10.11","tables":{}}\n' });
  const password = Buffer.from(PASSWORD);
  const result = await runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password }, { spawnImpl });
  assert.deepEqual(result, { version: '10.11', tables: {} });
  const [{ args, options, stdin }] = calls;
  assert.deepEqual(args.slice(0, 2), ['-E', '-c']);
  assert.equal(args[2], DATABASE_HELPER);
  assert.equal(options.shell, false);
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'SYSTEMROOT']);
  assert.ok(!JSON.stringify(args).includes(PASSWORD) && !JSON.stringify(options).includes(PASSWORD));
  const request = JSON.parse(stdin());
  assert.equal(request.password, PASSWORD);
  assert.deepEqual(request.connection, connection);
  assert.equal(request.op, 'probe');
});

test('maps helper error codes', async () => {
  for (const [reported, expected] of [[1045, 'DB_AUTH_FAILED'], [2003, 'DB_UNREACHABLE'], ['DRIVER_MISSING', 'DB_DRIVER_MISSING'], ['HELPER', 'DB_HELPER_FAILED']]) {
    const { spawnImpl } = fakeSpawn({ reply: JSON.stringify({ ok: false, error: { code: reported } }) });
    await rejects(runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), expected);
  }
  const { spawnImpl } = fakeSpawn({ reply: JSON.stringify({ ok: false, error: { code: 1062, statement: 3 } }) });
  const error = await runDatabaseHelper({ pythonPath: python, op: 'apply', connection, password: Buffer.from(PASSWORD), statements: ['SELECT 1'] }, { spawnImpl }).catch(e => e);
  assert.deepEqual([error.code, error.mysqlCode, error.statement], ['DB_ERROR', 1062, 3]);
});

test('times out and kills the child', async () => {
  const { spawnImpl, calls } = fakeSpawn({ hang: true });
  await rejects(runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl, timeoutMs: 50 }), 'DB_HELPER_TIMEOUT');
  assert.equal(calls.length, 1);
});

test('rejects non-JSON, multi-line or failing output', async () => {
  for (const options of [{ reply: 'Traceback (most recent call last)' }, { reply: '{"ok":true}\n{"ok":true}\n' }, { reply: '', exitCode: 1 }, { reply: '["ok"]' }]) {
    const { spawnImpl } = fakeSpawn(options);
    await rejects(runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'DB_HELPER_FAILED');
  }
});

test('caps stdout at 1 MiB', async () => {
  const { spawnImpl } = fakeSpawn({ chunks: [Buffer.alloc(600 * 1024, 0x61), Buffer.alloc(600 * 1024, 0x61)] });
  await rejects(runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'DB_HELPER_FAILED');
});

test('validates the request before spawning', async () => {
  const { spawnImpl, calls } = fakeSpawn({ reply: '{"ok":true}' });
  await rejects(runDatabaseHelper({ pythonPath: 'relative/python', op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'B3_PYTHON_PATH_INVALID');
  await rejects(runDatabaseHelper({ pythonPath: python, op: 'drop', connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'DB_HELPER_FAILED');
  await rejects(runDatabaseHelper({ pythonPath: python, op: 'probe', connection: { ...connection, host: 'a/b' }, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'B3_DATABASE_SETTINGS_INVALID');
  assert.equal(calls.length, 0);
});

const realPython = process.env.B3_PYTHON || path.join(os.homedir(), '.pyenv/versions/2.7.18/bin/python2.7');
test('Python helper source compiles under python2.7', { skip: process.platform === 'linux' && spawnSync(realPython, ['-V']).status === 0 ? false : 'Python 2.7 not available' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-helper-compile-'));
  try {
    const file = path.join(dir, 'helper.py');
    await fs.writeFile(file, DATABASE_HELPER);
    const result = spawnSync(realPython, ['-m', 'py_compile', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reports when the request is written so the caller can end its vault scope', async () => {
  const { spawnImpl } = fakeSpawn({ reply: '{"ok":true,"version":"10.11","tables":{}}' });
  const order = [];
  const result = runDatabaseHelper({ pythonPath: python, op: 'probe', connection, password: Buffer.from(PASSWORD) }, { spawnImpl, onRequestWritten: () => order.push('written') }).then(() => order.push('done'));
  await result;
  assert.deepEqual(order, ['written', 'done']);
});

test('C1: backup values use the driver literal API and refuse unsupported drivers clearly', { skip: process.platform === 'linux' && spawnSync(realPython, ['-V']).status === 0 ? false : 'Python 2.7 not available' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-helper-literal-'));
  try {
    const file = path.join(dir, 'probe.py');
    const functions = DATABASE_HELPER.replace(/\nmain\(\)\s*$/, '\n');
    await fs.writeFile(file, functions + [
      'class Connector(object): pass',
      'class MySQLdbLike(object):',
      '    def escape(self, value, mapping): return "wrong"',
      '    def literal(self, value): return "\'%s\'" % value',
      'try:',
      '    literal(Connector(), "x")',
      '    print("no-error")',
      'except Exception as exc:',
      '    print(error_code(exc))',
      'print(literal(MySQLdbLike(), "x"))',
      'print(literal(Connector(), None))',
    ].join('\n'));
    const result = spawnSync(realPython, [file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['BACKUP_DRIVER_UNSUPPORTED', "'x'", 'NULL']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('C1: the unsupported backup driver code reaches the operator', async () => {
  const { spawnImpl } = fakeSpawn({ reply: JSON.stringify({ ok: false, error: { code: 'BACKUP_DRIVER_UNSUPPORTED' } }) });
  await rejects(runDatabaseHelper({ pythonPath: python, op: 'backup', target: path.resolve('x.sql'), connection, password: Buffer.from(PASSWORD) }, { spawnImpl }), 'DB_BACKUP_DRIVER_UNSUPPORTED');
});
