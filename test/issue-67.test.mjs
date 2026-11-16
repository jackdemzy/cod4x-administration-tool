import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELEASE_FUSES, fuseFindings } from '../scripts/release-lib.mjs';

// Issue #67: the three Low findings of audit 4.18.31 (A6-8 Electron fuses, A2-7 vault passphrase
// change, A4-8 game log rotation on remote and Docker homes).
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('A6-8: the release build sets the Electron fuses; RunAsNode is off', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.build.electronFuses, {
    runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  });
  assert.notEqual(pkg.build.disableAsarIntegrity, true, 'electron-builder embeds the asar hash into the Windows exe');
  assert.equal(RELEASE_FUSES.length, 6);
});

test('A6-8: release-verify reads the fuse wire of the packaged executable', () => {
  const on = 49, off = 48;
  assert.deepEqual(fuseFindings({ version: '1', 0: off, 1: on, 2: off, 3: off, 4: on, 5: on, 6: off, 7: on }), []);
  // the stock Electron binary (all defaults) fails on every security fuse
  const stock = fuseFindings({ version: '1', 0: on, 1: off, 2: on, 3: on, 4: off, 5: off, 6: off, 7: on });
  assert.equal(stock.length, 6);
  assert.match(stock[0], /RunAsNode should be off \(wire 49\)/);
  assert.deepEqual(fuseFindings(null), ['fuse wire version 1 not found']);
  assert.match(read('scripts/release-verify.mjs'), /fuseFindings\(await createRequire\(import\.meta\.url\)\('@electron\/fuses'\)\.getCurrentFuseWire\(appExe\)\)/);
});

test('A6-8: the backend runs in a utility process, not as electron + ELECTRON_RUN_AS_NODE', () => {
  const main = read('electron-main.cjs');
  assert.match(main, /server=utilityProcess\.fork\(serverPath,\[\],\{env,/);
  assert.match(main, /delete env\.ELECTRON_RUN_AS_NODE;/);
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE:'1'/);
  assert.doesNotMatch(main, /require\('child_process'\)/);
  // the release installer gate starts the packaged backend this way
  assert.match(main, /const BACKEND_ONLY=process\.argv\.includes\('--cod4x-backend-only'\);/);
  assert.match(read('test/installer-linux.test.mjs'), /args: \['--cod4x-backend-only', '--no-sandbox', '--ozone-platform=headless'\]/);
  assert.match(read('test/installer-windows.test.mjs'), /args: \['--cod4x-backend-only'\]/);
  assert.doesNotMatch(read('test/installer-linux.test.mjs') + read('test/installer-windows.test.mjs'), /ELECTRON_RUN_AS_NODE: '1'/);
});
