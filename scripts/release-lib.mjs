import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Block 23 (4.18.30): pure helpers of the release pipeline and the artifact verification.
// No build is needed to test them; scripts/release-verify.mjs wires them to real files.

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const PLATFORMS = ['win', 'linux'];

// One file per artifact, matched by name (electron-builder writes x64 or x86_64 depending on target).
export function artifactPatterns(platform, version) {
  const v = escape(version);
  if (platform === 'win') return [
    { label: 'Windows installer', pattern: new RegExp(`^COD4X-CONTROL-Setup-${v}-x64\\.exe$`) },
    { label: 'Windows portable', pattern: new RegExp(`^COD4X-CONTROL-Portable-${v}-x64\\.exe$`) },
  ];
  if (platform === 'linux') return [
    { label: 'Linux AppImage', pattern: new RegExp(`^COD4X-CONTROL-${v}-(x64|x86_64)\\.AppImage$`) },
  ];
  throw new Error(`UNKNOWN_PLATFORM ${platform}`);
}

export const unpackedDir = platform => (platform === 'win' ? 'win-unpacked' : 'linux-unpacked');

// Returns { files: [name], missing: [label], ambiguous: [label] } for the names in a folder.
export function matchArtifacts(names, platform, version) {
  const files = [], missing = [], ambiguous = [];
  for (const { label, pattern } of artifactPatterns(platform, version)) {
    const hits = names.filter(name => pattern.test(name));
    if (hits.length === 0) missing.push(label);
    else if (hits.length > 1) ambiguous.push(label);
    else files.push(hits[0]);
  }
  return { files, missing, ambiguous };
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// Same format as GNU sha256sum, so `sha256sum -c SHA256SUMS` works on Linux.
export const formatSums = entries => entries.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join('');

export function parseSums(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match || match[2].includes('/') || match[2].includes('\\') || match[2] === '..') throw new Error(`SUMS_LINE_INVALID ${line}`);
    entries.push({ sha256: match[1], name: match[2] });
  }
  return entries;
}

// Recomputes every listed hash; returns the names that do not match or are missing.
export function checkSums(dir, text) {
  const failures = [];
  const entries = parseSums(text);
  if (!entries.length) failures.push('SHA256SUMS is empty');
  for (const { name, sha256 } of entries) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) failures.push(`${name}: missing`);
    else if (sha256File(file) !== sha256) failures.push(`${name}: SHA-256 mismatch`);
  }
  return failures;
}

export const manifest = ({ version, commit, platform, entries, node = process.versions.node, electron = null, created = new Date().toISOString() }) => ({
  product: 'COD4X CONTROL', version, platform, commit, created, node, electron,
  files: entries.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
});

// Packaged app content (paths as @electron/asar lists them, with a leading slash).
export const REQUIRED_ENTRIES = [
  '/package.json', '/installer-server.mjs', '/electron-main.cjs', '/electron-preload.cjs', '/LICENSE',
  '/dist/index.html', '/dist/remote/remote.html', '/lib/electron-navigation-policy.cjs',
  '/node_modules/express/package.json', '/node_modules/ssh2/package.json', '/node_modules/tar/package.json',
  '/node_modules/adm-zip/package.json', '/node_modules/express-rate-limit/package.json',
  '/node_modules/react/package.json', '/node_modules/react-dom/package.json',
];

export const FORBIDDEN_ENTRIES = [
  /(^|\/)\.env(\.|$)/,
  /^\/config\/(users|auth-user)\.json$/,
  /^\/(data|credential-vault|backups|servers|installations|monitor|logs|test|docs|scripts|src)(\/|$)/,
  /\.(pem|key)$/i,
  /(^|\/)remembered-login\.json$/,
  /^\/node_modules\/(electron|electron-builder|app-builder-lib|vite|@vitejs|esbuild)(\/|$)/,
];

export function asarPolicy(entries, version, packageJsonText) {
  const set = new Set(entries.map(entry => entry.replace(/\\/g, '/')));
  const missing = REQUIRED_ENTRIES.filter(entry => !set.has(entry));
  const forbidden = [...set].filter(entry => FORBIDDEN_ENTRIES.some(pattern => pattern.test(entry)));
  let versionOk = false;
  try { versionOk = JSON.parse(packageJsonText).version === version; } catch {}
  return { ok: !missing.length && !forbidden.length && versionOk, missing, forbidden, versionOk };
}
