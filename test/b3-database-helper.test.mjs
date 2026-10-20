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
