import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Roadmap Block 11: eBc-B3 audit (docs/EBC-B3-AUDIT.md) as data plus the checks
// derived from it. Nothing here starts B3; the runtime follows in Block 12.
// Pinned to 9096624 (operator decision, Block 12): the newest commit d44c05e
// ("Syntax update") fails on every start with NameError getAbsolutePath in
// b3/config.py load(); 9096624 is its direct parent and runs natively.
export const B3_SOURCE = Object.freeze({
  repository: 'https://github.com/kristiandz/ebc-b3',
  commit: '90966246ab1953ceeca5e8b62c714851a120b28a',
  b3Version: '1.10.10',
  // SHA-256 of the audited files with CRLF normalized to LF (Windows checkouts).
  auditedFiles: Object.freeze({
    'b3_run.py': '27dea6218ca370ed3f0454ec1d5e7039728cdfcbe7396d74352919cd71412650',
    'b3/__init__.py': 'b1e87b31665a0039b20e0f119e789cb2c44a7d639dd73518059ee0f10f0ffb9d',
    'b3/config.py': 'd0f36ff5a28bb361aee8112997fc51cf131657c42318e60c8e143913ec9a5dee',
    'b3/parser.py': '6c1fe15e60ff70c7381113944e1fc58864ca1797401ac27766e7e5dc41b390ce',
    'b3/parsers/cod4.py': '28e9418bd82b3d8d53bc6eaa2244be75031f7f0d19222691b48fe06a16c2d436',
    'b3/parsers/cod4x.py': 'f8b61b229d0a71d4fb4cea91590a84cefe356d5ef4136df55f0facdced87e8f3',
    'b3/parsers/q3a/rcon.py': '1999ff1e35376ca05d77ff4ec7ed15b85afa1a32b45d5b2b44105629418f15b3',
    'b3/storage/mysql.py': 'a8d9480447306b6d5988add4729e5e8c2938ac0537a8d280010ddb547fade720',
    'b3/sql/mysql/b3.sql': '9a41fb5fd455f3941063807a8b8a36462599534d167e026a3e3c4d4658a6b976',
    'b3/extplugins/auth.py': 'e12f715df61732f413028986e8b2cbf7270a34b576bb405d21e8772d3238933b',
  }),
  // Known broken sources, recognized by file hash: never "just unaudited".
  knownBroken: Object.freeze({
    'b3/config.py': Object.freeze({ '8266a68f0854e670a5b77fc6ddf78807150fd8a482dab70995f47afaa5db5f32': 'd44c05eaa809c7047073e0d3776bcdb5d1827fee' }),
  }),
  // Never applied automatically (DROP TABLE IF EXISTS on the eBc promod schema).
  blockedSql: Object.freeze(['b3/sql/mysql/b3-update-ebc.sql']),
});

const row = (id, component, requirement, required, evidence, check) => Object.freeze({ id, component, requirement, required, evidence, check });
export const B3_DEPENDENCY_MATRIX = Object.freeze([
  row('python', 'Python', '>= 2.7, < 3', true, 'b3_run.py version guard', 'interpreter'),
  row('dateutil', 'python-dateutil', 'importable', true, 'b3/parser.py import dateutil.tz', 'module'),
  row('mysql-driver', 'MySQL driver', 'PyMySQL, else mysql-connector, else MySQLdb', true, 'b3/storage/mysql.py driver order', 'module'),
  row('mysql-server', 'MySQL/MariaDB server', 'reachable, schema b3/sql/mysql/b3.sql', true, 'b3.sql CREATE TABLE IF NOT EXISTS x6', 'block-14'),
  row('feedparser', 'feedparser', 'importable', false, 'plugins/adv (RSS), b3/gui', 'module'),
  row('requests', 'requests', 'importable', false, 'extplugins/discord.py, plugins/geolocation', 'module'),
  row('paramiko', 'paramiko', 'importable', false, 'plugins/sftpytail', 'module'),
  row('psycopg2', 'psycopg2', 'importable', false, 'b3/storage/postgresql.py', 'module'),
  row('b3-source', 'eBc-B3 source', `B3 ${'1.10.10'} layout with cod4x parser`, true, 'b3/__init__.py, b3/parsers/cod4x.py', 'source'),
  row('b3hide-auth', 'B3 auth plugin for b3hide', 'b3/extplugins/auth.py (client_checkin)', false, 'extplugins/auth.py; not enabled in shipped b3.xml', 'source'),
  row('cod4x-status', 'CoD4x 21.x status format', 'one GUID column (sv_legacyguidmode 1) or verified parser', true, 'src/sv_cmds.c SV_Status_f vs b3/parsers/cod4x.py', 'native-block-12'),
  row('cod4x-log', 'CoD4x game log', 'g_log + g_logsync, local path', true, 'b3/parser.py game_log', 'block-16'),
  row('rcon', 'RCON', 'UDP rcon, password from the vault', true, 'b3/parsers/q3a/rcon.py', 'block-16'),
  // kristiandz/ebc-pm README: promod MySQL statistics use this schema plus GSCLIB.
  row('ebc-pm-schema', 'eBc promod statistics schema', 'b3-update-ebc.sql, opt-in with backup only', false, 'ebc-pm README; DROP TABLE IF EXISTS x2', 'block-14'),
  row('gsclib', 'GSCLIB plugin + custom CoD4X build', 'only for eBc promod MySQL live mode', false, 'ebc-pm README', 'operator-decision'),
]);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const MODULES = Object.freeze({ dateutil: 'dateutil', pymysql: 'pymysql', 'mysql.connector': 'mysql.connector', MySQLdb: 'MySQLdb', feedparser: 'feedparser', requests: 'requests', paramiko: 'paramiko', psycopg2: 'psycopg2' });
// Runs under Python 2.7 and 3.x; prints one JSON line, imports nothing from cwd.
const PROBE = [
  'import sys, json, importlib',
  'out = {"version": list(sys.version_info[:3]), "bits": 64 if sys.maxsize > 2**32 else 32, "modules": {}}',
  `for name in ${JSON.stringify(Object.values(MODULES))}:`,
  '    try:',
  '        m = importlib.import_module(name)',
  '        out["modules"][name] = {"ok": True, "version": str(getattr(m, "__version__", getattr(m, "VERSION", "")))[:32]}',
  '    except Exception:',
  '        out["modules"][name] = {"ok": False, "version": None}',
  'sys.stdout.write(json.dumps(out))',
].join('\n');

export function validInterpreterPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.length > 512) fail('B3_PYTHON_PATH_INVALID');
  if (!/^python(?:2(?:\.7)?)?(?:\.exe)?$/i.test(path.basename(value))) fail('B3_PYTHON_PATH_INVALID');
  return path.resolve(value);
}

export function parseInterpreterProbe(stdout) {
  let data;
  try { data = JSON.parse(String(stdout || '').trim()); } catch { fail('B3_PYTHON_PROBE_INVALID'); }
  if (!data || !Array.isArray(data.version) || data.version.length !== 3 || !data.version.every(Number.isInteger) || typeof data.modules !== 'object') fail('B3_PYTHON_PROBE_INVALID');
  const modules = {};
  for (const name of Object.values(MODULES)) {
    const entry = data.modules[name];
    modules[name] = { ok: entry?.ok === true, version: typeof entry?.version === 'string' && entry.version ? entry.version.slice(0, 32) : null };
  }
  return { version: data.version.join('.'), major: data.version[0], minor: data.version[1], bits: data.bits === 32 ? 32 : 64, modules };
}

// Executes the operator-chosen interpreter with a fixed probe: shell:false,
// isolated empty cwd, -E (ignore PYTHON* environment), bounded time and output.
export async function probeInterpreter(pythonPath, { execFileAsync = promisify(execFile), timeoutMs = 15000 } = {}) {
  const executable = validInterpreterPath(pythonPath);
  const stats = await fs.stat(executable).catch(() => null);
  if (!stats?.isFile()) fail('B3_PYTHON_NOT_FOUND');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-probe-'));
  try {
    const { stdout } = await execFileAsync(executable, ['-E', '-c', PROBE], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, shell: false, env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '' } });
    return parseInterpreterProbe(stdout);
  } catch (error) {
    if (/^B3_/.test(error.code || '')) throw error;
    fail('B3_PYTHON_PROBE_FAILED');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

const normalizedHash = buffer => crypto.createHash('sha256').update(Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');

// Static inspection only: reads files, never imports or executes B3 code.
export async function inspectB3Source(b3Path) {
  if (typeof b3Path !== 'string' || !path.isAbsolute(b3Path) || /[\x00-\x1f]/.test(b3Path)) fail('B3_SOURCE_PATH_INVALID');
  const root = path.resolve(b3Path);
  const rootStats = await fs.lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) fail('B3_SOURCE_NOT_FOUND');
  const files = {};
  for (const [relative, expected] of Object.entries(B3_SOURCE.auditedFiles)) {
    const file = path.join(root, ...relative.split('/'));
    const stats = await fs.lstat(file).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 4 * 1024 * 1024) { files[relative] = { present: false, audited: false }; continue; }
    const sha256 = normalizedHash(await fs.readFile(file));
    files[relative] = { present: true, audited: sha256 === expected, sha256 };
  }
  let b3Version = null;
  if (files['b3/__init__.py'].present) b3Version = /^__version__\s*=\s*'([^']{1,32})'/m.exec(await fs.readFile(path.join(root, 'b3', '__init__.py'), 'latin1'))?.[1] || null;
  const destructiveSql = [];
  const sqlDirectory = path.join(root, 'b3', 'sql', 'mysql');
  for (const name of await fs.readdir(sqlDirectory).catch(() => [])) {
    if (!name.endsWith('.sql')) continue;
    const text = await fs.readFile(path.join(sqlDirectory, name), 'latin1').catch(() => '');
    if (/\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(text)) destructiveSql.push(`b3/sql/mysql/${name}`);
  }
  const required = ['b3_run.py', 'b3/__init__.py', 'b3/config.py', 'b3/parser.py', 'b3/parsers/cod4.py', 'b3/parsers/cod4x.py', 'b3/parsers/q3a/rcon.py', 'b3/storage/mysql.py', 'b3/sql/mysql/b3.sql'];
  const brokenCommit = Object.entries(B3_SOURCE.knownBroken).map(([file, hashes]) => hashes[files[file]?.sha256]).find(Boolean) || null;
  return {
    b3Version, files, destructiveSql: destructiveSql.sort(), brokenCommit,
    complete: required.every(file => files[file].present),
    audited: Object.values(files).every(file => file.present && file.audited),
    authPlugin: files['b3/extplugins/auth.py'].present,
  };
}

// One status per matrix row: OK, MISSING, INCOMPATIBLE, OPTIONAL_MISSING,
// UNAUDITED, NOT_CHECKED (later block) or UNVERIFIED (needs native test).
export function evaluateB3Dependencies({ python = null, pythonError = null, source = null, sourceError = null } = {}) {
  const modules = python?.modules || {};
  const has = name => modules[name]?.ok === true;
  const results = B3_DEPENDENCY_MATRIX.map(entry => {
    const result = (status, detail = null, found = null) => ({ ...entry, status, detail, found });
    switch (entry.id) {
      case 'python':
        if (!python) return result('MISSING', pythonError || 'B3_PYTHON_NOT_CONFIGURED');
        return python.major === 2 && python.minor === 7 ? result('OK', null, python.version) : result('INCOMPATIBLE', 'PYTHON_INCOMPATIBLE', python.version);
      case 'dateutil': return !python ? result('NOT_CHECKED', 'B3_PYTHON_NOT_CONFIGURED') : has('dateutil') ? result('OK', null, modules.dateutil.version) : result('MISSING', 'DEPENDENCY_MISSING');
      case 'mysql-driver': {
        if (!python) return result('NOT_CHECKED', 'B3_PYTHON_NOT_CONFIGURED');
        const driver = ['pymysql', 'mysql.connector', 'MySQLdb'].find(has);
        return driver ? result('OK', null, `${driver} ${modules[driver].version || ''}`.trim()) : result('MISSING', 'DEPENDENCY_MISSING');
      }
      case 'feedparser': case 'requests': case 'paramiko': case 'psycopg2':
        return !python ? result('NOT_CHECKED', 'B3_PYTHON_NOT_CONFIGURED') : has(entry.id) ? result('OK', null, modules[entry.id].version) : result('OPTIONAL_MISSING', 'DEPENDENCY_OPTIONAL_MISSING');
      case 'b3-source':
        if (!source) return result('MISSING', sourceError || 'B3_SOURCE_NOT_CONFIGURED');
        if (!source.complete) return result('MISSING', 'B3_SOURCE_INCOMPLETE', source.b3Version);
        if (source.brokenCommit) return result('INCOMPATIBLE', 'B3_KNOWN_BROKEN_COMMIT', `${source.b3Version} @ ${source.brokenCommit.slice(0, 7)}`);
        if (source.b3Version !== B3_SOURCE.b3Version) return result('INCOMPATIBLE', 'B3_VERSION_MISMATCH', source.b3Version);
        return source.audited ? result('OK', null, source.b3Version) : result('UNAUDITED', 'B3_SOURCE_DIFFERS_FROM_AUDIT', source.b3Version);
      case 'b3hide-auth': return !source ? result('NOT_CHECKED', 'B3_SOURCE_NOT_CONFIGURED') : source.authPlugin ? result('OK') : result('OPTIONAL_MISSING', 'B3_AUTH_PLUGIN_MISSING');
      case 'cod4x-status': return result('UNVERIFIED', 'NATIVE_TEST_REQUIRED');
      default: return result('NOT_CHECKED', `PLANNED_${entry.check.toUpperCase().replace(/-/g, '_')}`);
    }
  });
  const blocking = results.filter(item => item.required && ['MISSING', 'INCOMPATIBLE'].includes(item.status));
  return {
    overall: blocking.length ? 'BLOCKED' : results.some(item => item.status === 'UNAUDITED') ? 'UNAUDITED' : 'READY_FOR_RUNTIME_TEST',
    blocking: blocking.map(item => item.id), results,
    destructiveSql: source?.destructiveSql || [],
    // SQL files that must never run automatically, whether audited or newly found.
    blockedSql: [...new Set([...B3_SOURCE.blockedSql, ...(source?.destructiveSql || [])])].sort(),
    source: { repository: B3_SOURCE.repository, commit: B3_SOURCE.commit, b3Version: B3_SOURCE.b3Version },
  };
}

// Global B3 environment (interpreter + source path). Per-instance B3 follows later.
export class B3Environment {
  constructor(file, { execFileAsync } = {}) { this.file = path.resolve(file); this.execFileAsync = execFileAsync; }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data?.version !== 1) return { pythonPath: null, b3Path: null, updatedAt: null };
      return { pythonPath: typeof data.pythonPath === 'string' ? data.pythonPath : null, b3Path: typeof data.b3Path === 'string' ? data.b3Path : null, updatedAt: data.updatedAt || null };
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { pythonPath: null, b3Path: null, updatedAt: null }; throw error; }
  }
  async save(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['pythonPath', 'b3Path'].includes(key))) fail('B3_ENVIRONMENT_INVALID');
    const pythonPath = input.pythonPath ? validInterpreterPath(input.pythonPath) : null;
    if (input.b3Path && (typeof input.b3Path !== 'string' || !path.isAbsolute(input.b3Path) || /[\x00-\x1f]/.test(input.b3Path))) fail('B3_SOURCE_PATH_INVALID');
    const record = { version: 1, pythonPath, b3Path: input.b3Path ? path.resolve(input.b3Path) : null, updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, this.file);
    return { pythonPath: record.pythonPath, b3Path: record.b3Path, updatedAt: record.updatedAt };
  }
  async check() {
    const environment = await this.read();
    let python = null, pythonError = null, source = null, sourceError = null;
    if (environment.pythonPath) { try { python = await probeInterpreter(environment.pythonPath, this.execFileAsync ? { execFileAsync: this.execFileAsync } : {}); } catch (error) { pythonError = error.code || 'B3_PYTHON_PROBE_FAILED'; } }
    if (environment.b3Path) { try { source = await inspectB3Source(environment.b3Path); } catch (error) { sourceError = error.code || 'B3_SOURCE_NOT_FOUND'; } }
    return { environment, python: python ? { version: python.version, bits: python.bits } : null, checkedAt: new Date().toISOString(), ...evaluateB3Dependencies({ python, pythonError, source, sourceError }) };
  }
}
