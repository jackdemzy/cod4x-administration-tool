import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const quote = value => `'${value.replaceAll("'", "''")}'`;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const ARCHIVE_MARKER = Buffer.from('// COD4X CONTROL managed archive guard v1\n// Runtime credentials must not be archived here.\n');
function checkAbort(signal) { if (signal.aborted) fail('CREDENTIAL_RUNTIME_ABORTED'); }

async function security(script) {
  // Only paths, never credentials, enter the PowerShell command line. The
  // module comes from the OS runtime, not an autoload search path.
  const executable = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const result = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;${script}`],
    { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
    const value = JSON.parse(result.stdout);
    if (value.ok !== true) fail('CREDENTIAL_RUNTIME_ACL_BLOCKED');
  } catch { fail('CREDENTIAL_RUNTIME_ACL_BLOCKED'); }
}

async function checkParents(parents) {
  // Administrators and SYSTEM are privileged OS principals; they can inspect
  // the Core's memory regardless. Other accounts must not mutate these paths.
  const names = parents.map(quote).join(',');
  await security(`$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544');$ok=$true;foreach($p in @(${names})){$a=Get-Acl -LiteralPath $p;if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted){$ok=$false};foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $r.IdentityReference.Value -notin $trusted -and ([int64]$r.FileSystemRights -band 0x500d0156) -ne 0){$ok=$false}}};@{ok=$ok}|ConvertTo-Json -Compress`);
}

async function protectNewEmpty(target, directory) {
  const type = directory ? 'DirectorySecurity' : 'FileSecurity';
  const rule = directory ? "'FullControl','ContainerInherit,ObjectInherit','None','Allow'" : "'FullControl','Allow'";
  await security(`$a=New-Object System.Security.AccessControl.${type};$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($who in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))){$r=New-Object System.Security.AccessControl.FileSystemAccessRule($who,${rule});$a.AddAccessRule($r)};Set-Acl -LiteralPath ${quote(target)} -AclObject $a;@{ok=$true}|ConvertTo-Json -Compress`);
}

async function checkPrivateAcl(target) {
  await security(`$a=Get-Acl -LiteralPath ${quote(target)};$rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));$bad=@($rules|Where-Object{$_.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $_.AccessControlType -ne 'Allow'});@{ok=($a.AreAccessRulesProtected -and $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $bad.Count -eq 0 -and $rules.Count -ge 1)}|ConvertTo-Json -Compress`);
}

async function sealNewArchive(file) {
  await security(`$p=${quote(file)};$item=Get-Item -LiteralPath $p;$item.Attributes=$item.Attributes -bor [IO.FileAttributes]::ReadOnly;$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($who in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))){$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who,'Read','Allow')))};Set-Acl -LiteralPath $p -AclObject $a;@{ok=$true}|ConvertTo-Json -Compress`);
}

async function verifyArchive(file, expected) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== ARCHIVE_MARKER.length || !samePath(await fs.realpath(file), file) || (expected && !sameFile(stat, expected))) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (!sameFile(opened, stat) || opened.nlink !== 1) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
    const bytes = Buffer.alloc(ARCHIVE_MARKER.length + 1);
    try {
      const result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== ARCHIVE_MARKER.length || !bytes.subarray(0, result.bytesRead).equals(ARCHIVE_MARKER)) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
    } finally { bytes.fill(0); }
    await security(`$p=${quote(file)};$a=Get-Acl -LiteralPath $p;$rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));$bad=@($rules|Where-Object{$_.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $_.AccessControlType -ne 'Allow' -or ([int64]$_.FileSystemRights -band 0x500d0156) -ne 0});$item=Get-Item -LiteralPath $p;@{ok=($a.AreAccessRulesProtected -and $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $bad.Count -eq 0 -and $rules.Count -ge 1 -and ($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0)}|ConvertTo-Json -Compress`);
    const after = await fs.lstat(file);
    if (!sameFile(stat, after) || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
    return stat;
  } catch { fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT'); }
  finally { await handle?.close(); }
}

async function ensureArchive(main, signal) {
  const file = path.join(main, 'q3config_server.cfg');
  const mainIdentity = await directoryIdentity(main);
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT'); }
  if (handle) {
    // This new nonsecret marker deliberately outlives the transfer and backend:
    // the trusted Core's automatic archive must stay non-writable for the run.
    // Never modify, repair or adopt an existing user archive.
    let identity;
    try {
      identity = await handle.stat();
      await protectNewEmpty(file, false);
      await handle.writeFile(ARCHIVE_MARKER); await handle.sync();
      await handle.close(); handle = null;
      await sealNewArchive(file);
      await verifyArchive(file, identity);
    } catch {
      let cleanupFailed = false;
      try { await handle?.close(); } catch { cleanupFailed = true; }
      try {
        await directoryIdentity(main, mainIdentity);
        const current = await fs.lstat(file);
        if (!identity || !sameFile(current, identity) || current.isSymbolicLink() || current.nlink !== 1 || !samePath(await fs.realpath(file), file)) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
        // Only this failed attempt's own nonsecret object. A completed seal may
        // have removed write rights before verification failed; restore just
        // enough ownership permissions to remove it, never an existing archive.
        await protectNewEmpty(file, false);
        await security(`$p=${quote(file)};$item=Get-Item -LiteralPath $p;$item.Attributes=$item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly);@{ok=$true}|ConvertTo-Json -Compress`);
        await directoryIdentity(main, mainIdentity);
        const after = await fs.lstat(file);
        if (!sameFile(after, identity) || after.isSymbolicLink() || after.nlink !== 1) fail('CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT');
        await fs.unlink(file);
      } catch { cleanupFailed = true; }
      fail(cleanupFailed ? 'CREDENTIAL_RUNTIME_ARCHIVE_CLEANUP_FAILED' : 'CREDENTIAL_RUNTIME_ARCHIVE_SETUP_FAILED');
    }
  }
  const identity = await verifyArchive(file);
  checkAbort(signal);
  return { file, identity };
}

async function directoryIdentity(target, expected) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(target), target) || (expected && !sameFile(stat, expected))) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
  return stat;
}

function validate({ homePath, credentials, signal }, consume) {
  if (process.platform !== 'win32') fail('CREDENTIAL_RUNTIME_PLATFORM_UNSUPPORTED');
  if (typeof homePath !== 'string' || !path.isAbsolute(homePath) || /[\x00-\x1f]/.test(homePath) || typeof consume !== 'function' ||
      !signal || typeof signal.aborted !== 'boolean' || typeof signal.throwIfAborted !== 'function' ||
      !credentials || typeof credentials !== 'object' || Object.keys(credentials).sort().join(',') !== 'join,rcon') fail('CREDENTIAL_RUNTIME_FILE_INVALID');
  let present = false;
  for (const kind of ['rcon', 'join']) {
    const value = credentials[kind];
    if (value === null) continue;
    if (!Buffer.isBuffer(value) || value.length < 8 || value.length > (kind === 'join' ? 64 : 128) ||
        value.some(byte => byte < 33 || byte > 126 || [34, 59, 92].includes(byte))) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
    present = true;
  }
  if (!present) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
}

// Windows-only building block. The caller must keep the vault scope alive,
// honor its AbortSignal, and wait for the Core to consume the configuration
// before returning. This function alone does not certify credential activation.
// The managed instance root and its ancestors are a deployment trust boundary;
// this checks root/home/main, rejects aliases, and never repairs their ACLs.
export async function withPrivateRuntimeConfig(options, consume) {
  validate(options, consume);
  const { credentials, signal } = options;
  checkAbort(signal);
  const home = path.resolve(options.homePath), main = path.join(home, 'main');
  const parents = [path.dirname(home), home, main];
  let parentIdentities;
  try { parentIdentities = await Promise.all(parents.map(target => directoryIdentity(target))); }
  catch { fail('CREDENTIAL_RUNTIME_FILE_INVALID'); }
  await checkParents(parents);
  checkAbort(signal);
  const archive = credentials.join === null ? null : await ensureArchive(main, signal);
  const name = `control-private-${randomUUID()}`;
  // Cmd_Exec_f copies into MAX_QPATH (64 bytes including NUL).
  const directory = path.join(main, name), file = path.join(directory, 'run.cfg');
  let directoryStat, fileStat, handle, encoded, created = false, result, failure;
  async function checkPaths() {
    await Promise.all(parents.map((target, index) => directoryIdentity(target, parentIdentities[index])));
    await directoryIdentity(directory, directoryStat);
    if (archive) await verifyArchive(archive.file, archive.identity);
    if (handle) {
      const current = await fs.lstat(file), opened = await handle.stat();
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || opened.nlink !== 1 || !sameFile(current, fileStat) || !sameFile(opened, fileStat)) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
    }
  }
  try {
    await fs.mkdir(directory, { mode: 0o700 }); created = true;
    directoryStat = await directoryIdentity(directory);
    await protectNewEmpty(directory, true);
    await checkPrivateAcl(directory);
    checkAbort(signal);
    await checkPaths();
    handle = await fs.open(file, 'wx+', 0o600);
    fileStat = await handle.stat();
    await protectNewEmpty(file, false);
    await checkPrivateAcl(file);
    await checkPaths();
    checkAbort(signal);
    const parts = [];
    for (const [kind, cvar] of [['rcon', 'rcon_password'], ['join', 'g_password']]) {
      if (credentials[kind] !== null) parts.push(Buffer.from(`set ${cvar} "`), credentials[kind], Buffer.from('"\n'));
    }
    encoded = Buffer.concat(parts);
    await handle.writeFile(encoded);
    await handle.sync();
    checkAbort(signal);
    await checkPaths();
    await checkPrivateAcl(file);
    checkAbort(signal);
    const readback = Buffer.alloc(encoded.length + 1);
    try {
      const read = await handle.read(readback, 0, readback.length, 0);
      if (read.bytesRead !== encoded.length || !readback.subarray(0, read.bytesRead).equals(encoded)) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
    } finally { readback.fill(0); }
    checkAbort(signal);
    try { result = await consume(Object.freeze({ relativeConfig: `${name}/run.cfg` })); }
    catch { fail('CREDENTIAL_RUNTIME_HANDOFF_FAILED'); }
    checkAbort(signal);
    await checkPaths();
  } catch (error) {
    failure = /^CREDENTIAL_RUNTIME_[A-Z_]+$/.test(error.code || '') ? Object.assign(new Error(error.code), { code: error.code }) : Object.assign(new Error('CREDENTIAL_RUNTIME_FILE_FAILED'), { code: 'CREDENTIAL_RUNTIME_FILE_FAILED' });
  } finally {
    encoded?.fill(0);
    let cleanupFailed = false;
    // Clear through the owned open handle even if a pathname was replaced.
    // This is best-effort plaintext removal, not physical secure erasure.
    if (handle) {
      try { await handle.truncate(0); await handle.sync(); } catch { cleanupFailed = true; }
      try { await handle.close(); } catch { cleanupFailed = true; }
      try {
        await directoryIdentity(directory, directoryStat);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !sameFile(stat, fileStat)) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
        await fs.unlink(file);
      } catch { cleanupFailed = true; }
    }
    if (created) {
      try { await directoryIdentity(directory, directoryStat); await fs.rmdir(directory); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) failure = Object.assign(new Error('CREDENTIAL_RUNTIME_CLEANUP_FAILED'), { code: 'CREDENTIAL_RUNTIME_CLEANUP_FAILED' });
  }
  if (failure) throw failure;
  return result;
}
