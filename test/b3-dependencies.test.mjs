import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { B3_DEPENDENCY_MATRIX, B3_SOURCE, parseInterpreterProbe, probeInterpreter, validInterpreterPath, inspectB3Source, evaluateB3Dependencies, B3Environment } from '../lib/b3-dependencies.mjs';

const modules = (ok = []) => Object.fromEntries(['dateutil', 'pymysql', 'mysql.connector', 'MySQLdb', 'feedparser', 'requests', 'paramiko', 'psycopg2'].map(name => [name, { ok: ok.includes(name), version: ok.includes(name) ? '1.0' : null }]));
const python = (version, ok) => ({ version, major: Number(version.split('.')[0]), minor: Number(version.split('.')[1]), bits: 64, modules: modules(ok) });
const auditedSource = { b3Version: '1.10.10', complete: true, audited: true, authPlugin: true, destructiveSql: ['b3/sql/mysql/b3-update-ebc.sql'], files: {} };
const status = (result, id) => result.results.find(item => item.id === id).status;

test('dependency matrix and audit report cover every roadmap Block 11 audit item', async () => {
  const report = await fs.readFile(new URL('../docs/EBC-B3-AUDIT.md', import.meta.url), 'utf8');
  assert.match(report, new RegExp(B3_SOURCE.commit));
  for (const item of ['Python-Version', 'MySQL', 'PyMySQL', 'python-dateutil', 'feedparser', 'Parser', 'RCON', 'Log', 'b3hide', 'Schema', 'Plugins', 'Konfigurationsformat', 'Startskripte']) {
    assert.ok(report.toLowerCase().includes(item.toLowerCase()), `audit report covers ${item}`);
  }
  for (const failure of ['veraltete Python-Abhängigkeit', 'inkompatible Python-Version', 'fehlende DB', 'fehlende Plugins', 'veraltete B3-API', 'kaputte SQL-Migration', 'inkompatible CoD4X-Version']) assert.ok(report.includes(failure), failure);
  const ids = B3_DEPENDENCY_MATRIX.map(entry => entry.id);
  for (const id of ['python', 'dateutil', 'mysql-driver', 'mysql-server', 'feedparser', 'b3-source', 'b3hide-auth', 'cod4x-status', 'cod4x-log', 'rcon', 'ebc-pm-schema']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
});

test('evaluation detects incompatible Python, missing packages, driver fallback and source problems', () => {
  const ready = evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'pymysql']), source: auditedSource });
  assert.deepEqual([ready.overall, ready.blocking], ['READY_FOR_RUNTIME_TEST', []]);
  assert.equal(status(ready, 'feedparser'), 'OPTIONAL_MISSING');
  assert.equal(status(ready, 'cod4x-status'), 'UNVERIFIED', 'status format is never claimed without a native test');
  assert.equal(status(ready, 'mysql-server'), 'NOT_CHECKED');
  assert.deepEqual(ready.blockedSql, ['b3/sql/mysql/b3-update-ebc.sql']);
  const py3 = evaluateB3Dependencies({ python: python('3.11.5', ['dateutil', 'pymysql']), source: auditedSource });
  assert.deepEqual([py3.overall, status(py3, 'python')], ['BLOCKED', 'INCOMPATIBLE']);
  const noDateutil = evaluateB3Dependencies({ python: python('2.7.18', ['pymysql']), source: auditedSource });
  assert.deepEqual(noDateutil.blocking, ['dateutil']);
  const connector = evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'mysql.connector']), source: auditedSource });
  assert.match(connector.results.find(item => item.id === 'mysql-driver').found, /^mysql\.connector/);
  assert.equal(evaluateB3Dependencies({ python: python('2.7.18', ['dateutil']), source: auditedSource }).blocking.includes('mysql-driver'), true);
  assert.equal(status(evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'pymysql']), source: { ...auditedSource, b3Version: '1.8.2' } }), 'b3-source'), 'INCOMPATIBLE');
  const modified = evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'pymysql']), source: { ...auditedSource, audited: false } });
  assert.deepEqual([modified.overall, status(modified, 'b3-source')], ['UNAUDITED', 'UNAUDITED']);
  // d44c05e fails on every start (NameError in b3/config.py); recognized by hash.
  const broken = evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'pymysql']), source: { ...auditedSource, audited: false, brokenCommit: 'd44c05eaa809c7047073e0d3776bcdb5d1827fee' } });
  assert.deepEqual([broken.overall, status(broken, 'b3-source'), broken.results.find(item => item.id === 'b3-source').detail], ['BLOCKED', 'INCOMPATIBLE', 'B3_KNOWN_BROKEN_COMMIT']);
  assert.equal(B3_SOURCE.commit, '90966246ab1953ceeca5e8b62c714851a120b28a');
  assert.ok(Object.values(B3_SOURCE.knownBroken['b3/config.py']).includes('d44c05eaa809c7047073e0d3776bcdb5d1827fee'));
  const nothing = evaluateB3Dependencies({});
  assert.deepEqual(nothing.blocking.sort(), ['b3-source', 'python']);
});

test('probe parsing, interpreter path validation and isolated execution contract', async () => {
  assert.equal(parseInterpreterProbe('{"version":[2,7,18],"bits":32,"modules":{"dateutil":{"ok":true,"version":"2.8.2"}}}').modules.dateutil.version, '2.8.2');
  assert.throws(() => parseInterpreterProbe('Python 2.7.18'), { code: 'B3_PYTHON_PROBE_INVALID' });
  for (const bad of ['python.exe', '/usr/bin/bash', '/usr/bin/python3; rm -rf /', 'C:\\Tools\\b3_run.py']) assert.throws(() => validInterpreterPath(bad), { code: 'B3_PYTHON_PATH_INVALID' }, bad);
  assert.equal(validInterpreterPath(path.resolve('/opt/py/python2.7')), path.resolve('/opt/py/python2.7'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-python-'));
  try {
    const fake = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python2.7');
    await fs.writeFile(fake, 'not executed by this test');
    let call;
    const result = await probeInterpreter(fake, { execFileAsync: async (file, args, options) => { call = { file, args, options }; return { stdout: '{"version":[2,7,18],"bits":64,"modules":{}}' }; } });
    assert.equal(result.version, '2.7.18');
    assert.deepEqual([call.file, call.args[0], call.args[1], call.options.shell], [fake, '-E', '-c', false]);
    assert.notEqual(path.resolve(call.options.cwd), path.resolve(process.cwd()), 'probe never runs in a directory with B3 or project code');
    assert.ok(!Object.keys(call.options.env).some(key => /^PYTHON/i.test(key)));
    await assert.rejects(probeInterpreter(fake, { execFileAsync: async () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } }), { code: 'B3_PYTHON_PROBE_FAILED' });
    await assert.rejects(probeInterpreter(path.join(root, 'python2.7')), error => ['B3_PYTHON_NOT_FOUND', 'B3_PYTHON_PROBE_FAILED'].includes(error.code));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

let realPython = null;
try { realPython = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim(); } catch { realPython = null; }
test('a real local interpreter is probed and reported honestly (Python 3 is incompatible)', { skip: realPython && /python(?:2(?:\.7)?)?(?:\.exe)?$/i.test(path.basename(realPython)) ? false : 'no python interpreter with a matching name on PATH' }, async () => {
  const probe = await probeInterpreter(realPython);
  assert.match(probe.version, /^\d+\.\d+\.\d+$/);
  const result = evaluateB3Dependencies({ python: probe, source: auditedSource });
  assert.equal(status(result, 'python'), probe.major === 2 && probe.minor === 7 ? 'OK' : 'INCOMPATIBLE');
});

test('static source inspection checks layout, version, audited hashes (CRLF-safe) and destructive SQL', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), text); };
  for (const file of Object.keys(B3_SOURCE.auditedFiles)) await write(file, `# ${file}\n`);
  await write('b3/__init__.py', "__version__ = '1.10.10'\n");
  await write('b3/sql/mysql/b3-update-custom.sql', 'TRUNCATE TABLE clients;\n');
  const source = await inspectB3Source(root);
  assert.deepEqual([source.b3Version, source.complete, source.audited, source.authPlugin], ['1.10.10', true, false, true]);
  assert.deepEqual(source.destructiveSql, ['b3/sql/mysql/b3-update-custom.sql']);
  const lf = source.files['b3_run.py'].sha256;
  await write('b3_run.py', '# b3_run.py\r\n');
  assert.equal((await inspectB3Source(root)).files['b3_run.py'].sha256, lf, 'Windows CRLF checkouts hash like the audited LF source');
  await fs.unlink(path.join(root, 'b3', 'parsers', 'cod4x.py'));
  assert.equal((await inspectB3Source(root)).complete, false);
  await assert.rejects(inspectB3Source('relative/path'), { code: 'B3_SOURCE_PATH_INVALID' });
  await assert.rejects(inspectB3Source(path.join(root, 'missing')), { code: 'B3_SOURCE_NOT_FOUND' });
  const evaluation = evaluateB3Dependencies({ python: python('2.7.18', ['dateutil', 'pymysql']), source: await inspectB3Source(root) });
  assert.deepEqual(evaluation.blockedSql, ['b3/sql/mysql/b3-update-custom.sql', 'b3/sql/mysql/b3-update-ebc.sql']);
});

test('environment settings persist and the check combines probe and source without starting B3', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const interpreter = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python2.7');
  await fs.writeFile(interpreter, 'not executed');
  const calls = [];
  const environment = new B3Environment(path.join(root, 'config', 'b3-environment.json'), { execFileAsync: async (file, args) => { calls.push(args.slice(0, 2)); return { stdout: JSON.stringify({ version: [2, 7, 18], bits: 64, modules: { dateutil: { ok: true, version: '2.8' }, pymysql: { ok: true, version: '0.9' } } }) }; } });
  assert.deepEqual(await environment.read(), { pythonPath: null, b3Path: null, updatedAt: null });
  await assert.rejects(environment.save({ pythonPath: interpreter, extra: 1 }), { code: 'B3_ENVIRONMENT_INVALID' });
  await environment.save({ pythonPath: interpreter, b3Path: path.join(root, 'no-b3') });
  const result = await environment.check();
  assert.equal(result.python.version, '2.7.18');
  assert.deepEqual(result.blocking, ['b3-source']);
  assert.equal(result.results.find(item => item.id === 'b3-source').detail, 'B3_SOURCE_NOT_FOUND');
  assert.deepEqual(calls, [['-E', '-c']], 'only the fixed probe is executed');
});
