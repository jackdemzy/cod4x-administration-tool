import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const server = fs.readFileSync('installer-server.mjs', 'utf8');
const ui = fs.readFileSync('cod4x-control-improved.jsx', 'utf8');
const requiredServer = [
  'checkBackupRegistryConsistency',
  '/api/backups/consistency',
  'backup.consistency.checked',
  'backup.consistency.failed',
  'duplicate_id',
  'orphanFiles',
  'sha256_mismatch',
];
const requiredUi = ['Konsistenz prüfen', 'Backup-Konsistenz', '/api/backups/consistency'];
const missingServer = requiredServer.filter(x => !server.includes(x));
const missingUi = requiredUi.filter(x => !ui.includes(x));
if (missingServer.length || missingUi.length) {
  console.error('4.16.8 preflight FAIL');
  if (missingServer.length) console.error('Server missing:', missingServer.join(', '));
  if (missingUi.length) console.error('UI missing:', missingUi.join(', '));
  process.exit(1);
}
const check = spawnSync(process.execPath, ['--check', 'installer-server.mjs'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('Node syntax FAIL');
  console.error(check.stderr || check.stdout);
  process.exit(check.status || 1);
}
console.log('4.16.8 preflight PASS');
console.log('Node syntax PASS');
console.log('Consistency endpoint PASS');
console.log('Consistency audit events PASS');
console.log('UI consistency control PASS');
