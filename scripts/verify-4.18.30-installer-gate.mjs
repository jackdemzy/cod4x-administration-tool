import { spawnSync } from 'node:child_process';

// Block 23 (4.18.30) gate: Installer Installation + First Run + Core Discovery + Server Start.
// Runs the installer test of this platform against the release build in COD4X_RELEASE_DIR.
// Without COD4X_RELEASE_DIR (normal preflight, no build) the gate says SKIP. With it, a skipped
// test is a failure: the gate must have really installed and started the build.
//   Linux:   test/installer-linux.test.mjs   (AppImage, full gate with the E2E test core)
//   Windows: test/installer-windows.test.mjs (NSIS silent install, first run, silent uninstall;
//            core discovery and server start with a real core are manual, see the checklist)
const file = process.platform === 'win32' ? 'test/installer-windows.test.mjs' : process.platform === 'linux' ? 'test/installer-linux.test.mjs' : null;
if (!file) { console.log(`SKIP 4.18.30 installer gate: no installer target for ${process.platform}`); process.exit(0); }
if (!process.env.COD4X_RELEASE_DIR) { console.log('SKIP 4.18.30 installer gate: COD4X_RELEASE_DIR not set (no release build)'); process.exit(0); }

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', timeout: 900000 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
const count = name => Number((new RegExp(`^# ${name} (\\d+)$`, 'm').exec(run.stdout || '') || [])[1] ?? NaN);
if (run.status !== 0 || count('fail') !== 0) { console.error('4.18.30 installer gate FAIL'); process.exit(run.status || 1); }
if (!(count('pass') > 0) || count('skipped') !== 0) { console.error('4.18.30 installer gate FAIL: the installer test was skipped although COD4X_RELEASE_DIR is set'); process.exit(1); }
console.log('4.18.30 Installer Installation + First Run + Core Discovery + Server Start gate PASS');
