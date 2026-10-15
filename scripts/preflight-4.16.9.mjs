import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const server=fs.readFileSync('installer-server.mjs','utf8');
const ui=fs.readFileSync('cod4x-control-improved.jsx','utf8');
const reqS=['evaluateBackupLifecycle','/api/backups/lifecycle','/api/backups/lifecycle/cleanup','backup.lifecycle.checked','backup.lifecycle.cleaned','backup.lifecycle.cleanup.failed','BACKUP_LIFECYCLE_MAX_REGULAR','BACKUP_LIFECYCLE_MAX_SAFETY'];
const reqU=['Lifecycle prüfen','Lifecycle bereinigen','/api/backups/lifecycle','/api/backups/lifecycle/cleanup','Backup-Lifecycle'];
const ms=reqS.filter(x=>!server.includes(x)), mu=reqU.filter(x=>!ui.includes(x));
if(ms.length||mu.length){console.error('4.16.9 preflight FAIL');if(ms.length)console.error('Server missing:',ms.join(', '));if(mu.length)console.error('UI missing:',mu.join(', '));process.exit(1)}
const check=spawnSync(process.execPath,['--check','installer-server.mjs'],{encoding:'utf8'});
if(check.status!==0){console.error('Node syntax FAIL');console.error(check.stderr||check.stdout);process.exit(check.status||1)}
console.log('4.16.9 preflight PASS');console.log('Node syntax PASS');console.log('Lifecycle endpoints PASS');console.log('Lifecycle audit events PASS');console.log('UI lifecycle controls PASS');
