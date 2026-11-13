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
