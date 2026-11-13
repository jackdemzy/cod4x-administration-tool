import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_ENTRIES, asarPolicy, checkSums, formatSums, matchArtifacts, parseSums, sha256File } from '../scripts/release-lib.mjs';

// Block 23 (4.18.30): SHA-256 sums, expected artifacts and the app.asar policy.
const VERIFY = fileURLToPath(new URL('../scripts/release-verify.mjs', import.meta.url));
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cod4x-release-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const pkgJson = version => JSON.stringify({ version });

test('expected artifacts are matched by version, one file each', () => {
  const names = ['COD4X-CONTROL-Setup-4.18.30-x64.exe', 'COD4X-CONTROL-Portable-4.18.30-x64.exe', 'COD4X-CONTROL-Setup-4.18.29-x64.exe', 'SHA256SUMS'];
  assert.deepEqual(matchArtifacts(names, 'win', '4.18.30'), { files: names.slice(0, 2), missing: [], ambiguous: [] });
  assert.deepEqual(matchArtifacts(names.slice(1), 'win', '4.18.30').missing, ['Windows installer']);
  assert.deepEqual(matchArtifacts(['COD4X-CONTROL-4.18.30-x86_64.AppImage'], 'linux', '4.18.30').files, ['COD4X-CONTROL-4.18.30-x86_64.AppImage']);
  assert.deepEqual(matchArtifacts(['COD4X-CONTROL-4.18.30-x86_64.AppImage', 'COD4X-CONTROL-4.18.30-x64.AppImage'], 'linux', '4.18.30').ambiguous, ['Linux AppImage']);
  assert.throws(() => matchArtifacts([], 'mac', '4.18.30'), /UNKNOWN_PLATFORM/);
});

test('SHA256SUMS round-trips and catches a changed or missing file', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.exe'), 'alpha');
  fs.writeFileSync(path.join(dir, 'b.AppImage'), 'beta');
  const entries = ['a.exe', 'b.AppImage'].map(name => ({ name, sha256: sha256File(path.join(dir, name)) }));
  assert.equal(entries[0].sha256, '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8');
  const text = formatSums(entries);
  assert.deepEqual(parseSums(text), entries);
  assert.deepEqual(checkSums(dir, text), []);
  fs.writeFileSync(path.join(dir, 'a.exe'), 'alpha!');
  assert.deepEqual(checkSums(dir, text), ['a.exe: SHA-256 mismatch']);
  fs.rmSync(path.join(dir, 'b.AppImage'));
  assert.ok(checkSums(dir, text).includes('b.AppImage: missing'));
  assert.deepEqual(checkSums(dir, ''), ['SHA256SUMS is empty']);
  assert.throws(() => parseSums(`${'0'.repeat(64)}  ../evil.exe\n`), /SUMS_LINE_INVALID/);
});

test('app.asar policy requires the app files and refuses secrets, tests and build tools', () => {
  assert.deepEqual(asarPolicy(REQUIRED_ENTRIES, '4.18.30', pkgJson('4.18.30')), { ok: true, missing: [], forbidden: [], versionOk: true });
  const without = asarPolicy(REQUIRED_ENTRIES.filter(entry => entry !== '/dist/index.html'), '4.18.30', pkgJson('4.18.30'));
  assert.equal(without.ok, false);
  assert.deepEqual(without.missing, ['/dist/index.html']);
  const bad = ['/config/users.json', '/.env', '/.env.local', '/test/a.test.mjs', '/docs/RELEASE.md', '/node_modules/electron/index.js', '/node_modules/vite/package.json', '/data/x', '/server.key', '/credential-vault/v.json', '/node_modules/ssh2/test/fixtures/id_rsa', '/node_modules/ssh2/test/fixtures/id_rsa.ppk', '/cert.pfx', '/.npmrc', '/.git/config'];
  assert.deepEqual(asarPolicy([...REQUIRED_ENTRIES, ...bad], '4.18.30', pkgJson('4.18.30')).forbidden, bad);
  assert.equal(asarPolicy([...REQUIRED_ENTRIES, '/config/policy.json', '/node_modules/electron-to-chromium/package.json'], '4.18.30', pkgJson('4.18.30')).ok, true);
  assert.equal(asarPolicy(REQUIRED_ENTRIES, '4.18.30', pkgJson('4.18.29')).versionOk, false);
  assert.equal(asarPolicy(REQUIRED_ENTRIES, '4.18.30', 'not json').ok, false);
});

test('release-verify --check passes on intact sums and fails on a changed file', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'x.exe'), 'payload');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), formatSums([{ name: 'x.exe', sha256: sha256File(path.join(dir, 'x.exe')) }]));
  const ok = spawnSync(process.execPath, [VERIFY, '--check', dir], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  fs.appendFileSync(path.join(dir, 'x.exe'), '!');
  const bad = spawnSync(process.execPath, [VERIFY, '--check', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /x\.exe: SHA-256 mismatch/);
});

test('release-verify refuses an unknown platform and a missing artifact', t => {
  const unknown = spawnSync(process.execPath, [VERIFY, '--platform', 'mac'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  const dir = tmp(t);
  const missing = spawnSync(process.execPath, [VERIFY, '--platform', 'linux', '--dir', dir], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing artifact\(s\).*Linux AppImage/);
});
