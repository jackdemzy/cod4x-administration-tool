import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { B3_SOURCE, normalizedHash, validInterpreterPath } from './b3-dependencies.mjs';
import { validateDatabaseSettings, classifyDatabaseError } from './b3-database.mjs';

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

// Fixed helper run with the B3 interpreter (Python 2.7 or 3.x). It reads one
// JSON request line from stdin (op, connection, password) and prints exactly
// one JSON line. Driver order matches eBc-B3 b3/storage/mysql.py.
export const DATABASE_HELPER = String.raw`
import sys, os, json, hashlib, time

BT = chr(96)

def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

class BackupUnsupported(Exception):
    pass

def error_code(exc):
    if isinstance(exc, BackupUnsupported):
        return 'BACKUP_DRIVER_UNSUPPORTED'
    if exc.__class__.__name__ == 'AdminError' and exc.args:
        return exc.args[0]
    args = getattr(exc, 'args', ())
    if args and isinstance(args[0], int):
        return args[0]
    errno = getattr(exc, 'errno', None)
    if isinstance(errno, int) and errno > 0:
        return errno
    return 'HELPER'

def text(value):
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    return value

def quote(name):
    return BT + name.replace(BT, BT + BT) + BT

def literal(conn, value):
    if value is None:
        return 'NULL'
    # PyMySQL and MySQLdb: literal() escapes with the connection's encoders.
    # mysql.connector has no such API; refuse instead of writing a broken backup.
    convert = getattr(conn, 'literal', None)
    if convert is None:
        raise BackupUnsupported()
    out = convert(value)
    if isinstance(out, bytes):
        out = out.decode('utf-8', 'replace')
    return out

def backup(conn, cur, target):
    temporary = target + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 384)
    counts = {}
    try:
        handle = os.fdopen(fd, 'wb')
        def write(line):
            handle.write((line + '\n').encode('utf-8'))
        write('-- COD4X CONTROL B3 backup v1')
        write('SET NAMES utf8;')
        cur.execute('SHOW TABLES')
        for table in [text(row[0]) for row in cur.fetchall()]:
            cur.execute('SHOW CREATE TABLE ' + quote(table))
            create = text(cur.fetchone()[1])
            cur.execute('SELECT * FROM ' + quote(table))
            rows = cur.fetchall()
            counts[table] = len(rows)
            write('-- TABLE %s ROWS %d' % (table, len(rows)))
            write('DROP TABLE IF EXISTS ' + quote(table) + ';')
            write(create + ';')
            for start in range(0, len(rows), 100):
                values = ['(' + ', '.join(literal(conn, value) for value in row) + ')' for row in rows[start:start + 100]]
                write('INSERT INTO ' + quote(table) + ' VALUES ' + ', '.join(values) + ';')
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.rename(temporary, target)
    except Exception:
        try:
            os.remove(temporary)
        except Exception:
            pass
        raise
    digest = hashlib.sha256()
    with open(target, 'rb') as stream:
        digest.update(stream.read())
    return {'ok': True, 'path': target, 'sha256': digest.hexdigest(), 'tables': counts}

# --- Block 15: named admin queries. The SQL lives only here; every value is bound.
class AdminError(Exception):
    pass

def rows(cur):
    return [[text(value) for value in row] for row in cur.fetchall()]

def like(value):
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'

def require(cur, sql, params, code):
    cur.execute(sql, params)
    if not cur.fetchone():
        raise AdminError(code)

CLIENT_COLUMNS = 'id, name, guid, ip, group_bits, connections, time_add, time_edit'

def q_players(cur, p, now):
    where = " WHERE (%s = '' OR name LIKE %s OR guid LIKE %s)"
    args = (p['search'], like(p['search']), like(p['search']))
    cur.execute('SELECT COUNT(*) FROM clients' + where, args)
    total = int(cur.fetchone()[0])
    cur.execute('SELECT ' + CLIENT_COLUMNS + ' FROM clients' + where + ' ORDER BY time_edit DESC LIMIT %s OFFSET %s', args + (p['limit'], p['offset']))
    return {'total': total, 'rows': rows(cur)}

def q_admins(cur, p, now):
    cur.execute('SELECT ' + CLIENT_COLUMNS + ' FROM clients WHERE group_bits >= %s ORDER BY group_bits DESC, name LIMIT 500', (8,))
    return {'rows': rows(cur)}

def q_player(cur, p, now):
    cur.execute('SELECT ' + CLIENT_COLUMNS + ' FROM clients WHERE id = %s', (p['clientId'],))
    client = cur.fetchone()
    if not client:
        raise AdminError('CLIENT_NOT_FOUND')
    cur.execute('SELECT alias, num_used, time_add, time_edit FROM aliases WHERE client_id = %s ORDER BY time_edit DESC LIMIT 200', (p['clientId'],))
    aliases = rows(cur)
    cur.execute('SELECT ip, num_used, time_add, time_edit FROM ipaliases WHERE client_id = %s ORDER BY time_edit DESC LIMIT 200', (p['clientId'],))
    return {'client': [text(value) for value in client], 'aliases': aliases, 'ips': rows(cur)}

PENALTY_TYPE = {'Ban': " AND p.type = 'Ban'", 'Permanent': " AND p.type = 'Ban'", 'TempBan': " AND p.type = 'TempBan'",
                'Kick': " AND p.type = 'Kick'", 'Warning': " AND p.type = 'Warning'", 'any': ''}
PENALTY_STATUS = {'active': (" AND p.inactive = 0 AND (p.time_expire = -1 OR p.time_expire > %s)", True),
                  'expired': (" AND p.inactive = 0 AND p.time_expire <> -1 AND p.time_expire <= %s", True),
                  'lifted': (" AND p.inactive = 1", False), 'any': ('', False)}

def q_penalties(cur, p, now):
    if p.get('type') not in PENALTY_TYPE or p.get('status') not in PENALTY_STATUS:
        raise AdminError('QUERY_INVALID')
    status_sql, uses_now = PENALTY_STATUS[p['status']]
    where = ' WHERE 1 = 1' + PENALTY_TYPE[p['type']] + status_sql
    args = (now,) if uses_now else ()
    cur.execute('SELECT COUNT(*) FROM penalties p' + where, args)
    total = int(cur.fetchone()[0])
    cur.execute('SELECT p.id, p.type, p.client_id, c.name, c.guid, p.admin_id, p.duration, p.inactive, p.reason, p.time_add, p.time_expire FROM penalties p '
                'LEFT JOIN clients c ON c.id = p.client_id' + where + ' ORDER BY p.time_add DESC LIMIT %s OFFSET %s', args + (p['limit'], p['offset']))
    return {'total': total, 'rows': rows(cur)}

def q_groups(cur, p, now):
    cur.execute('SELECT id, name, keyword, level FROM groups ORDER BY level', ())
    return {'rows': rows(cur)}

def q_unban(cur, p, now):
    require(cur, 'SELECT id FROM clients WHERE id = %s', (p['clientId'],), 'CLIENT_NOT_FOUND')
    cur.execute("UPDATE penalties SET inactive = 1, time_edit = %s WHERE client_id = %s AND type IN ('Ban', 'TempBan') AND inactive = 0", (now, p['clientId']))
    return {'affected': cur.rowcount}

def q_add_ban(cur, p, now):
    require(cur, 'SELECT id FROM clients WHERE id = %s', (p['clientId'],), 'CLIENT_NOT_FOUND')
    temporary = p['kind'] == 'TempBan'
    minutes = int(p['durationMinutes']) if temporary else 0
    expire = now + minutes * 60 if temporary else -1
    cur.execute("INSERT INTO penalties (type, client_id, admin_id, duration, inactive, keyword, reason, data, time_add, time_edit, time_expire) "
                "VALUES (%s, %s, 0, %s, 0, 'control', %s, '', %s, %s, %s)", ('TempBan' if temporary else 'Ban', p['clientId'], minutes, p['reason'], now, now, expire))
    return {'id': cur.lastrowid}

def q_set_group(cur, p, now):
    require(cur, 'SELECT id FROM clients WHERE id = %s', (p['clientId'],), 'CLIENT_NOT_FOUND')
    require(cur, 'SELECT id FROM groups WHERE id = %s', (p['groupId'],), 'GROUP_NOT_FOUND')
    cur.execute('UPDATE clients SET group_bits = %s, time_edit = %s WHERE id = %s', (p['groupId'], now, p['clientId']))
    return {'affected': cur.rowcount}

def q_lift_warning(cur, p, now):
    require(cur, "SELECT id FROM penalties WHERE id = %s AND type = 'Warning' AND inactive = 0", (p['penaltyId'],), 'PENALTY_NOT_FOUND')
    cur.execute('UPDATE penalties SET inactive = 1, time_edit = %s WHERE id = %s', (now, p['penaltyId']))
    return {'affected': cur.rowcount}

QUERIES = {'players': q_players, 'admins': q_admins, 'player': q_player, 'penalties': q_penalties, 'groups': q_groups,
           'unban': q_unban, 'addBan': q_add_ban, 'setGroup': q_set_group, 'liftWarning': q_lift_warning}
WRITES = ('unban', 'addBan', 'setGroup', 'liftWarning')

def main():
    try:
        req = json.loads(sys.stdin.readline())
        info = req['connection']
        op = req['op']
    except Exception:
        return emit({'ok': False, 'error': {'code': 'HELPER'}})
    driver = None
    for name in ('pymysql', 'mysql.connector', 'MySQLdb'):
        try:
            driver = __import__(name, fromlist=['connect'])
            break
        except Exception:
            driver = None
    if driver is None:
        return emit({'ok': False, 'error': {'code': 'DRIVER_MISSING'}})
    options = dict(host=info['host'], port=int(info['port']), user=info['username'], charset='utf8')
    if driver.__name__ == 'pymysql':
        options.update(password=req['password'], database=info['database'], connect_timeout=5)
    elif driver.__name__ == 'mysql.connector':
        options.update(password=req['password'], database=info['database'], connection_timeout=5)
    else:
        options.update(passwd=req['password'], db=info['database'], connect_timeout=5)
    req['password'] = None
    try:
        conn = driver.connect(**options)
    except Exception as exc:
        return emit({'ok': False, 'error': {'code': error_code(exc)}})
    options = None
    try:
        cur = conn.cursor()
        if op == 'probe':
            cur.execute('SELECT VERSION()')
            version = text(cur.fetchone()[0])
            cur.execute('SHOW TABLES')
            tables = {}
            for table in [text(row[0]) for row in cur.fetchall()]:
                cur.execute('SHOW COLUMNS FROM ' + quote(table))
                tables[table] = [text(row[0]) for row in cur.fetchall()]
            return emit({'ok': True, 'version': version, 'tables': tables})
        if op == 'backup':
            return emit(backup(conn, cur, req['target']))
        if op == 'apply':
            for index, statement in enumerate(req['statements']):
                try:
                    cur.execute(statement)
                except Exception as exc:
                    return emit({'ok': False, 'error': {'code': error_code(exc), 'statement': index}})
            conn.commit()
            return emit({'ok': True, 'statements': len(req['statements'])})
        if op == 'query':
            handler = QUERIES.get(req.get('name'))
            if handler is None or not isinstance(req.get('params'), dict):
                raise AdminError('QUERY_INVALID')
            result = handler(cur, req['params'], int(time.time()))
            if req['name'] in WRITES:
                conn.commit()
            result['ok'] = True
            return emit(result)
        return emit({'ok': False, 'error': {'code': 'HELPER'}})
    except Exception as exc:
        return emit({'ok': False, 'error': {'code': error_code(exc)}})
    finally:
        try:
            conn.close()
        except Exception:
            pass

main()
`;

const OPS = new Set(['probe', 'backup', 'apply', 'query']);
const MAX_OUTPUT = 1024 * 1024;

// Runs DATABASE_HELPER with the configured B3 interpreter: shell:false,
// isolated empty cwd, -E, minimal env, bounded time and output. Secrets are
// written to stdin only; never to argv, env or logs.
// onRequestWritten fires once the request (with the password) is flushed to the
// child's stdin; callers end their vault scope there instead of waiting minutes.
export async function runDatabaseHelper({ pythonPath, op, connection, password, target, statements, name, params }, { spawnImpl = spawn, timeoutMs = 120000, onRequestWritten = () => {} } = {}) {
  const executable = validInterpreterPath(pythonPath);
  if (!OPS.has(op) || !Buffer.isBuffer(password)) fail('DB_HELPER_FAILED');
  if (op === 'backup' && (typeof target !== 'string' || !path.isAbsolute(target))) fail('DB_HELPER_FAILED');
  if (op === 'apply' && (!Array.isArray(statements) || !statements.every(sql => typeof sql === 'string' && sql))) fail('DB_HELPER_FAILED');
  // Block 15: only a catalog name and plain params; the SQL lives in the helper.
  if (op === 'query' && (typeof name !== 'string' || !/^[A-Za-z]{1,32}$/.test(name) || !params || typeof params !== 'object' || Array.isArray(params))) fail('DB_HELPER_FAILED');
  const request = Buffer.from(JSON.stringify({ op, connection: validateDatabaseSettings(connection), password: password.toString('utf8'), target, statements, name, params }) + '\n');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-db-'));
  try {
    const { stdout, status } = await new Promise((resolve, reject) => {
      const child = spawnImpl(executable, ['-E', '-c', DATABASE_HELPER], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '' } });
      const chunks = [];
      let size = 0, outcome = null;
      const finish = code => { if (!outcome) { outcome = code; child.kill('SIGKILL'); } };
      const timer = setTimeout(() => finish('DB_HELPER_TIMEOUT'), timeoutMs);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_OUTPUT) finish('DB_HELPER_FAILED'); else chunks.push(chunk); });
      child.on('error', () => finish('DB_HELPER_FAILED'));
      child.on('close', exitCode => {
        clearTimeout(timer);
        if (outcome) reject(Object.assign(new Error(outcome), { code: outcome }));
        else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), status: exitCode });
      });
      child.stdin.on('error', () => finish('DB_HELPER_FAILED'));
      child.stdin.end(request, () => { request.fill(0); onRequestWritten(); });
    });
    const line = stdout.trim();
    let data = null;
    if (status === 0 && line && !line.includes('\n')) { try { data = JSON.parse(line); } catch { data = null; } }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') fail('DB_HELPER_FAILED');
    if (!data.ok) {
      const reported = data.error?.code;
      const code = reported === 'HELPER' ? 'DB_HELPER_FAILED' : classifyDatabaseError(reported);
      throw Object.assign(new Error(code), { code, mysqlCode: typeof reported === 'number' ? reported : null, statement: Number.isInteger(data.error?.statement) ? data.error.statement : null });
    }
    const { ok, ...result } = data;
    return result;
  } finally {
    request.fill(0);
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
