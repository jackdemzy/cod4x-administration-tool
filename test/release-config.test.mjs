import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Block 23 (4.18.30): the three release targets and the allowlist of packaged files.
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const build = pkg.build;

test('Windows builds the NSIS installer and the portable exe', () => {
  assert.deepEqual(build.win.target, ['nsis', 'portable']);
  assert.equal(build.win.artifactName, 'COD4X-CONTROL-Setup-${version}-${arch}.exe');
  assert.equal(build.portable.artifactName, 'COD4X-CONTROL-Portable-${version}-${arch}.exe');
  assert.match(pkg.scripts['dist:win'], /electron-builder --win nsis portable --publish never/);
});

test('Linux builds an AppImage with a fixed executable name', () => {
  assert.deepEqual(build.linux.target, ['AppImage']);
  assert.equal(build.linux.executableName, 'cod4x-control');
  assert.equal(build.linux.artifactName, 'COD4X-CONTROL-${version}-${arch}.AppImage');
  assert.match(pkg.scripts['dist:linux'], /electron-builder --linux AppImage --publish never/);
});

test('every artifact name carries the version', () => {
  for (const name of [build.win.artifactName, build.portable.artifactName, build.linux.artifactName, build.artifactName]) assert.match(name, /\$\{version\}/);
});

test('release scripts point at the pipeline and the verifier', () => {
  assert.equal(pkg.scripts['release:win'], 'node scripts/release.mjs --platform win');
  assert.equal(pkg.scripts['release:linux'], 'node scripts/release.mjs --platform linux');
  assert.equal(pkg.scripts['release:verify'], 'node scripts/release-verify.mjs');
});

test('packaged files stay an allowlist without tests, docs, config or secrets', () => {
  assert.ok(Array.isArray(build.files) && build.files.length > 0);
  for (const pattern of build.files) {
    assert.doesNotMatch(pattern, /^(test|docs|config|data|backups|credential-vault|scripts)(\/|$)/, pattern);
    assert.doesNotMatch(pattern, /\.env|\.pem|\.key|^\*\*\/\*$|^\*$/, pattern);
  }
});
