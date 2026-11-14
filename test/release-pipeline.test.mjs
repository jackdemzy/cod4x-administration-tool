import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Block 23 (4.18.30): the release pipeline keeps the order of the roadmap.
const RELEASE = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const dry = platform => spawnSync(process.execPath, [RELEASE, '--platform', platform, '--dry-run'], { encoding: 'utf8', cwd });

for (const [platform, targets] of [['win', '--win nsis portable'], ['linux', '--linux AppImage']]) {
  test(`${platform}: preflight, full suite, build, package, verify`, () => {
    const run = dry(platform);
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.deepEqual(lines.map(line => line.replace(/:.*/, '')), ['1. Preflight', '2. Full test suite', '3. Build (Vite)', '4. Package (electron-builder)', '5. SHA-256 + artifact verification']);
    assert.match(lines[0], /npm run preflight$/);
    assert.match(lines[1], /--test test\/\*\.test\.mjs$/);
    assert.match(lines[2], /npm run build$/);
    assert.ok(lines[3].includes(`${targets} --publish never`), lines[3]);
    assert.match(lines[4], new RegExp(`release-verify\\.mjs --platform ${platform}$`));
  });
}

test('unknown or missing platform is refused', () => {
  assert.equal(dry('mac').status, 2);
  assert.equal(spawnSync(process.execPath, [RELEASE], { encoding: 'utf8', cwd }).status, 2);
});

// Code signing: Windows can be built in two stages (app folder, then installers from it) so that
// the app exe is signed before it is packed. The one-step pipeline above stays unchanged.
test('win stages: unpacked = checks + app folder, installers = prepackaged setup + portable', () => {
  const stage = name => spawnSync(process.execPath, [RELEASE, '--platform', 'win', '--stage', name, '--dry-run'], { encoding: 'utf8', cwd });
  const unpacked = stage('unpacked');
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const lines = unpacked.stdout.trim().split('\n');
  assert.deepEqual(lines.map(line => line.replace(/:.*/, '')), ['1. Preflight', '2. Full test suite', '3. Build (Vite)', '4. Package app folder (electron-builder --dir)']);
  assert.ok(lines[3].endsWith('--win --dir --publish never'), lines[3]);
  const installers = stage('installers');
  assert.equal(installers.status, 0, installers.stderr);
  const [only, ...rest] = installers.stdout.trim().split('\n');
  assert.equal(rest.length, 0);
  assert.match(only, /--win nsis portable --prepackaged dist-installer[\\/]win-unpacked --publish never$/);
});

test('stages are refused for linux and unknown names', () => {
  const run = (...extra) => spawnSync(process.execPath, [RELEASE, ...extra, '--dry-run'], { encoding: 'utf8', cwd });
  assert.equal(run('--platform', 'linux', '--stage', 'unpacked').status, 2);
  assert.equal(run('--platform', 'win', '--stage', 'sign').status, 2);
  assert.equal(run('--platform', 'win', '--stage').status, 2);
});
