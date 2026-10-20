import fs from 'node:fs/promises';
import path from 'node:path';
import { B3_SOURCE, normalizedHash } from './b3-dependencies.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_SQL_BYTES = 1024 * 1024;

// Reads one of the SQL files CONTROL may execute from the configured eBc-B3
// tree and verifies its pinned hash. Called directly before every execution.
export async function readAuditedSql(b3Path, relative) {
  const expected = Object.hasOwn(B3_SOURCE.auditedSql, relative) ? B3_SOURCE.auditedSql[relative] : null;
  if (!expected || typeof b3Path !== 'string' || !path.isAbsolute(b3Path)) fail('B3_SQL_NOT_ALLOWED');
  const file = path.join(path.resolve(b3Path), ...relative.split('/'));
  const stats = await fs.lstat(file).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > MAX_SQL_BYTES) fail('B3_SQL_UNSAFE');
  const bytes = await fs.readFile(file);
  const sha256 = normalizedHash(bytes);
  if (sha256 !== expected) fail('B3_SQL_HASH_MISMATCH');
  return { path: file, sha256, text: bytes.toString('latin1').replace(/\r\n/g, '\n') };
}
