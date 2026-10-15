import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const server = fs.readFileSync(path.join(root, 'installer-server.mjs'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'cod4x-control-improved.jsx'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(root, 'BUILD_INFO.json'), 'utf8'));

const checks = [
  ['package version 4.17.7', pkg.version === '4.17.7'],
  ['preflight points to 4.17.7', pkg.scripts?.preflight === 'node scripts/preflight-4.17.7.mjs'],
  ['fs_basepath launch argument present', server.includes('"+set","fs_basepath",filesystemBasePath')],
  ['fs_homepath launch argument present', server.includes('"+set","fs_homepath",filesystemHomePath')],
  ['native cwd uses executable directory', server.includes('cwd: filesystemBasePath')],
  ['filesystem override guard present', server.includes('RUNTIME_FILESYSTEM_OVERRIDE_BLOCKED')],
  ['basepath validation present', server.includes('RUNTIME_BASEPATH_INVALID')],
  ['runtime state stores filesystemBasePath', server.includes('filesystemBasePath: null')],
  ['runtime state stores filesystemHomePath', server.includes('filesystemHomePath: null')],
  ['UI exposes fs_homepath', ui.includes('fs_homepath')],
  ['UI exposes OS working directory', ui.includes('OS-Arbeitsverzeichnis')],
  ['build info version 4.17.7', info.version === '4.17.7'],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
console.log('4.17.7 static verification PASS');
