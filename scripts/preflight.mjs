import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const required = ['package.json', 'electron-main.cjs', 'installer-server.mjs', 'vite.config.js', 'index.html', 'src/main.jsx'];
const missing = required.filter((p) => !fs.existsSync(path.resolve(p)));
if (missing.length) {
  console.error(`Missing required build files: ${missing.join(', ')}`);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.version !== '3.0.2') {
  console.error(`Version mismatch: expected 3.0.2, got ${pkg.version}`);
  process.exit(1);
}
if (pkg.main !== 'electron-main.cjs') {
  console.error('package.json must declare electron-main.cjs as the Electron entry point.');
  process.exit(1);
}
console.log(`Preflight OK — COD4X CONTROL ${pkg.version}`);
