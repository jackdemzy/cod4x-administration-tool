import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WINDOWS_APP_EXE, authenticodeInfo, authenticodeOfFile } from '../scripts/release-lib.mjs';

// Code signing (Windows): Authenticode detection, --require-signed and the signing steps of the
// Release workflow (only with SignPath configured, never on pull requests).
const VERIFY = fileURLToPath(new URL('../scripts/release-verify.mjs', import.meta.url));
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
// Artifact names carry the current package version, so the fake release folder must use it too.
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const V = VERSION.replace(/\./g, '\\.');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cod4x-sign-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// Minimal PE header: MZ, e_lfanew, "PE\0\0", COFF header, optional header with 16 data directories.
function pe({ plus = true, certOffset = 0, certSize = 0, directories = 16, size = 4096 } = {}) {
  const buffer = Buffer.alloc(size);
  buffer.write('MZ', 0, 'latin1');
  const peOffset = 0x80;
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'latin1');
  const optional = peOffset + 24;
  buffer.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  const dirs = optional + (plus ? 112 : 96);
  buffer.writeUInt32LE(directories, dirs - 4);
  buffer.writeUInt32LE(certOffset, dirs + 32);
  buffer.writeUInt32LE(certSize, dirs + 36);
  return buffer;
}

test('Authenticode: certificate table present = signed, PE32 and PE32+', () => {
  assert.deepEqual(authenticodeInfo(pe(), 4096), { pe: true, signed: false, offset: 0, size: 0 });
  assert.equal(authenticodeInfo(pe({ certOffset: 2048, certSize: 1024 }), 4096).signed, true);
  assert.equal(authenticodeInfo(pe({ plus: false, certOffset: 2048, certSize: 1024 }), 4096).signed, true);
});

test('Authenticode: no PE, truncated or out-of-file tables are not signed', () => {
  assert.deepEqual(authenticodeInfo(Buffer.from('not an exe'), 10), { pe: false, signed: false });
  assert.deepEqual(authenticodeInfo(Buffer.alloc(8192), 8192), { pe: false, signed: false });
  const header = pe({ certOffset: 2048, certSize: 1024 });
  header.writeUInt16LE(0x999, 0x80 + 24);
  assert.equal(authenticodeInfo(header, 4096).pe, false);
  assert.equal(authenticodeInfo(pe({ certOffset: 4000, certSize: 1024 }), 4096).signed, false);
  assert.equal(authenticodeInfo(pe({ certOffset: 2048, certSize: 4 }), 4096).signed, false);
  assert.deepEqual(authenticodeInfo(pe({ certOffset: 2048, certSize: 1024, directories: 4 }), 4096), { pe: true, signed: false });
});

// A fake release folder: setup, portable (> 1 MiB each) and the app exe, signed or not.
function release(dir, signed) {
  const exe = size => pe({ size, certOffset: signed ? size - 1024 : 0, certSize: signed ? 1024 : 0 });
  fs.writeFileSync(path.join(dir, `COD4X-CONTROL-Setup-${VERSION}-x64.exe`), exe(1100000));
  fs.writeFileSync(path.join(dir, `COD4X-CONTROL-Portable-${VERSION}-x64.exe`), exe(1100000));
  fs.mkdirSync(path.join(dir, 'win-unpacked'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'win-unpacked', WINDOWS_APP_EXE), exe(8192));
}
const verify = (dir, ...extra) => spawnSync(process.execPath, [VERIFY, '--platform', 'win', '--dir', dir, ...extra], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });

test('release-verify --require-signed fails on an unsigned exe, reports INFO without the flag', t => {
  const dir = tmp(t);
  release(dir, false);
  const strict = verify(dir, '--require-signed');
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, new RegExp(`COD4X-CONTROL-Setup-${V}-x64\\.exe has no Authenticode signature`));
  const lax = verify(dir);
  assert.match(lax.stdout, new RegExp(`INFO COD4X-CONTROL-Setup-${V}-x64\\.exe: not signed`));
  assert.match(lax.stdout, /INFO COD4X CONTROL\.exe: not signed/);
  assert.match(lax.stderr, /app\.asar not found/);
});

test('release-verify --require-signed passes the signature check when every exe is signed', t => {
  const dir = tmp(t);
  release(dir, true);
  assert.equal(authenticodeOfFile(path.join(dir, 'win-unpacked', WINDOWS_APP_EXE)).signed, true);
  const run = verify(dir, '--require-signed');
  assert.match(run.stdout, new RegExp(`PASS COD4X-CONTROL-Portable-${V}-x64\\.exe: Authenticode signature present`));
  assert.match(run.stdout, /PASS COD4X CONTROL\.exe: Authenticode signature present/);
  // The fake folder has no app.asar, so the verification stops there, after the signature check.
  assert.equal(run.status, 1);
  assert.match(run.stderr, /app\.asar not found/);
  assert.equal(spawnSync(process.execPath, [VERIFY, '--platform', 'linux', '--dir', dir, '--require-signed'], { encoding: 'utf8' }).status, 2);
});

test('workflow: signing only on Windows with SignPath configured, for a tag or a manual "sign"', () => {
  const condition = /SIGN_WINDOWS: \$\{\{ matrix\.platform == 'win' && secrets\.SIGNPATH_API_TOKEN != '' && vars\.SIGNPATH_ORGANIZATION_ID != '' && \(startsWith\(github\.ref, 'refs\/tags\/'\) \|\| inputs\.sign == true\) \}\}/;
  assert.match(workflow, condition);
  assert.match(workflow, /inputs:\n      sign:\n[\s\S]*?default: false/);
  const steps = workflow.split('\n      - ').filter(step => /^name: .*(SignPath\)|for signing|Use signed)/.test(step));
  assert.equal(steps.length, 6);
  for (const step of steps) assert.match(step, /\n        if: env\.SIGN_WINDOWS == 'true'\n/, step.split('\n')[0]);
});

test('workflow: two signing requests, verified signatures, strict verification when signing', () => {
  assert.equal(workflow.match(/uses: signpath\/github-action-submit-signing-request@v3\n/g).length, 2);
  assert.match(workflow, /artifact-configuration-slug: win-unpacked\n/);
  assert.match(workflow, /artifact-configuration-slug: win-installers\n/);
  assert.equal(workflow.match(/Get-AuthenticodeSignature/g).length, 2);
  assert.equal(workflow.match(/-ne 'Valid'/g).length, 2);
  assert.match(workflow, /npm run release:verify -- --platform win --require-signed/);
  assert.match(workflow, /run: node scripts\/release\.mjs --platform win --stage unpacked\n/);
  assert.match(workflow, /run: node scripts\/release\.mjs --platform win --stage installers\n/);
  // The token only goes to the SignPath action, never into a shell command.
  assert.equal(workflow.match(/secrets\.SIGNPATH_API_TOKEN/g).length, 4);
  assert.equal(workflow.match(/api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/g).length, 2);
  assert.match(workflow, /\n      actions: read\n/);
});

test('artifact configurations exist for both slugs and sign only own exe files', () => {
  const dir = new URL('../.signpath/artifact-configurations/', import.meta.url);
  const unpacked = fs.readFileSync(new URL('win-unpacked.xml', dir), 'utf8');
  const installers = fs.readFileSync(new URL('win-installers.xml', dir), 'utf8');
  for (const xml of [unpacked, installers]) {
    assert.match(xml, /<artifact-configuration xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1">/);
    assert.match(xml, /<zip-file>/);
    assert.doesNotMatch(xml, /\.dll/i);
  }
  assert.match(unpacked, /<pe-file path="COD4X CONTROL\.exe" product-name="COD4X CONTROL">/);
  assert.match(installers, /<include path="COD4X-CONTROL-Setup-\*-x64\.exe" \/>/);
  assert.match(installers, /<include path="COD4X-CONTROL-Portable-\*-x64\.exe" \/>/);
});
