import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLATFORMS } from './release-lib.mjs';

// Block 23 (4.18.30): the one way to build a release, in the order of the roadmap:
// Preflight (syntax, runtime, security and block gates) -> full test suite -> Vite build ->
// electron-builder -> SHA-256 + artifact verification. Stops at the first failing step.
//   node scripts/release.mjs --platform win|linux [--dry-run]
const args = process.argv.slice(2);
const platform = args[args.indexOf('--platform') + 1];
if (!args.includes('--platform') || !PLATFORMS.includes(platform)) {
  console.error(`Usage: node scripts/release.mjs --platform ${PLATFORMS.join('|')} [--dry-run]`);
  process.exit(2);
}

// npm and electron-builder run through node itself, so no shell is needed on Windows either.
// Windows: <node dir>\node_modules\npm; Linux/macOS: <prefix>/lib/node_modules/npm.
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
if (!npmCli) { console.error('npm-cli.js not found next to this Node.js'); process.exit(2); }
const builderCli = path.join('node_modules', 'electron-builder', 'cli.js');
const targets = platform === 'win' ? ['--win', 'nsis', 'portable'] : ['--linux', 'AppImage'];

const steps = [
  ['Preflight', process.execPath, [npmCli, 'run', 'preflight']],
  ['Full test suite', process.execPath, ['--test', 'test/*.test.mjs']],
  ['Build (Vite)', process.execPath, [npmCli, 'run', 'build']],
  ['Package (electron-builder)', process.execPath, [builderCli, ...targets, '--publish', 'never']],
  ['SHA-256 + artifact verification', process.execPath, ['scripts/release-verify.mjs', '--platform', platform]],
];

if (args.includes('--dry-run')) {
  steps.forEach(([name, , stepArgs], index) => console.log(`${index + 1}. ${name}: ${stepArgs.map(arg => (arg === npmCli ? 'npm' : arg)).join(' ')}`));
  process.exit(0);
}

// The installer tests belong after the build (installer gate); before it they would test old artifacts.
const { COD4X_RELEASE_DIR, ...inherited } = process.env;
const env = { ...inherited, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false' };
for (const [index, [name, command, stepArgs]] of steps.entries()) {
  console.log(`\n=== [${index + 1}/${steps.length}] ${name} ===`);
  const run = spawnSync(command, stepArgs, { stdio: 'inherit', shell: false, env });
  if (run.status !== 0) {
    console.error(`\nRelease FAIL at step ${index + 1} (${name}), exit ${run.status ?? run.signal ?? run.error?.message}`);
    process.exit(run.status || 1);
  }
}
console.log(`\nRelease PASS (${platform})`);
