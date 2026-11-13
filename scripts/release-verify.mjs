import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PLATFORMS, WINDOWS_APP_EXE, asarPolicy, authenticodeOfFile, checkSums, formatSums, manifest, matchArtifacts, sha256File, unpackedDir } from './release-lib.mjs';

// Block 23 (4.18.30): artifact verification of a release build.
//   node scripts/release-verify.mjs --platform win|linux [--dir dist-installer]
//     checks the expected artifacts and the packaged app.asar, then writes SHA256SUMS and
//     release-manifest.json next to the artifacts.
//     --require-signed (win): every exe and the packaged app exe must carry an Authenticode signature.
//   node scripts/release-verify.mjs --check <folder>
//     only recomputes the hashes listed in <folder>/SHA256SUMS (for downloaded releases).
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fail = (message, code = 1) => { console.error(`Release verification FAIL: ${message}`); process.exit(code); };

if (args.includes('--check')) {
  const dir = option('--check');
  if (!dir) fail('--check needs a folder', 2);
  const sums = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(sums)) fail(`${sums} not found`);
  const failures = checkSums(dir, fs.readFileSync(sums, 'utf8'));
  if (failures.length) fail(failures.join('; '));
  console.log(`PASS SHA-256 of every file in ${sums}`);
  process.exit(0);
}

const platform = option('--platform');
if (!PLATFORMS.includes(platform)) fail(`--platform must be one of ${PLATFORMS.join(', ')}`, 2);
if (args.includes('--require-signed') && platform !== 'win') fail('--require-signed applies to --platform win only', 2);
const dir = path.resolve(option('--dir') || 'dist-installer');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
if (!fs.existsSync(dir)) fail(`${dir} not found`);

const { files, missing, ambiguous } = matchArtifacts(fs.readdirSync(dir), platform, version);
if (missing.length) fail(`missing artifact(s) for ${version}: ${missing.join(', ')}`);
if (ambiguous.length) fail(`more than one file for: ${ambiguous.join(', ')}`);
for (const name of files) {
  const { size } = fs.statSync(path.join(dir, name));
  if (size < 1024 * 1024) fail(`${name} is only ${size} bytes`);
  console.log(`PASS artifact ${name} (${size} bytes)`);
}

// Code signing: report the state of every Windows exe; with --require-signed an unsigned one fails.
if (platform === 'win') {
  const requireSigned = args.includes('--require-signed');
  const exes = [...files.map(name => path.join(dir, name)), path.join(dir, unpackedDir(platform), WINDOWS_APP_EXE)];
  for (const exe of exes) {
    if (!fs.existsSync(exe)) fail(`${exe} not found`);
    const { pe, signed } = authenticodeOfFile(exe);
    if (!pe) fail(`${path.basename(exe)} is not a PE file`);
    if (!signed && requireSigned) fail(`${path.basename(exe)} has no Authenticode signature`);
    console.log(`${signed ? 'PASS' : 'INFO'} ${path.basename(exe)}: ${signed ? 'Authenticode signature present' : 'not signed'}`);
  }
}

const archive = path.join(dir, unpackedDir(platform), 'resources', 'app.asar');
if (!fs.existsSync(archive)) fail(`${archive} not found`);
const asar = createRequire(import.meta.url)('@electron/asar');
const entries = asar.listPackage(archive, { isPack: false });
const policy = asarPolicy(entries, version, asar.extractFile(archive, 'package.json').toString('utf8'));
if (policy.missing.length) fail(`app.asar lacks: ${policy.missing.join(', ')}`);
if (policy.forbidden.length) fail(`app.asar contains forbidden entries: ${policy.forbidden.slice(0, 20).join(', ')}`);
if (!policy.versionOk) fail(`package.json in app.asar is not version ${version}`);
console.log(`PASS app.asar content (${entries.length} entries, version ${version})`);

const entriesWithHash = files.map(name => ({ name, size: fs.statSync(path.join(dir, name)).size, sha256: sha256File(path.join(dir, name)) }));
const commit = (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim() || process.env.GITHUB_SHA || null;
let electron = null;
try { electron = JSON.parse(fs.readFileSync('node_modules/electron/package.json', 'utf8')).version; } catch {}
fs.writeFileSync(path.join(dir, 'SHA256SUMS'), formatSums(entriesWithHash));
fs.writeFileSync(path.join(dir, 'release-manifest.json'), `${JSON.stringify(manifest({ version, commit, platform, entries: entriesWithHash, electron }), null, 2)}\n`);
const recheck = checkSums(dir, fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'));
if (recheck.length) fail(recheck.join('; '));
for (const { name, sha256 } of entriesWithHash) console.log(`SHA-256 ${sha256}  ${name}`);
console.log(`Release verification PASS (${platform} ${version})`);
