import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const module = await import('../lib/runtime-credential-file.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const execute = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windows = { skip: process.platform !== 'win32' };
async function fixture(t) {
  assert.equal(typeof module.withPrivateRuntimeConfig, 'function', 'Private runtime file channel must exist');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-private-channel-'));
  t.after(async () => {
    const main = path.join(root, 'servers/private-01/main'), archive = path.join(main, 'q3config_server.cfg');
    // Only restore permissions on this fixture's own regular archive, so test
    // teardown can remove its deliberately persistent read-only guard.
    try {
      if (!(await fs.lstat(main)).isSymbolicLink() && !(await fs.lstat(archive)).isSymbolicLink()) {
        const script = `$ErrorActionPreference='Stop';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');$p=${quote(archive)};$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));Set-Acl -LiteralPath $p -AclObject $a;$i=Get-Item -LiteralPath $p;$i.Attributes=$i.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)`;
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  // Sandbox/host Temp may grant other accounts write access. Establish a real
  // private trust anchor on this newly-created empty fixture, not product data.
  const secureFixture = `$ErrorActionPreference='Stop';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($who in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))){$r=New-Object System.Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath ${quote(root)} -AclObject $a`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', secureFixture], { windowsHide: true });
  const homePath = path.join(root, 'servers', 'private-01');
  await fs.mkdir(path.join(homePath, 'main'), { recursive: true });
  const controller = new AbortController();
  const credentials = { rcon: Buffer.from('Disposable-Rcon-123!'), join: Buffer.from('Disposable-Join-123!') };
  t.after(() => Object.values(credentials).forEach(value => value?.fill(0)));
  return { root, homePath, controller, credentials, options: { homePath, credentials, signal: controller.signal } };
}
async function assertEmpty(home) { assert.deepEqual((await fs.readdir(path.join(home, 'main'))).filter(name => name !== 'q3config_server.cfg'), []); }
async function assertWriteBlocked(file) {
  let handle;
  try { handle = await fs.open(file, 'w'); }
  catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code)); return; }
  finally { await handle?.close(); }
  assert.fail('Archive must not be writable');
}

test('Windows private channel writes only RCON/Join, with restricted ACL, and removes its files', windows, async t => {
  const { homePath, options } = await fixture(t);
  let config;
  const result = await module.withPrivateRuntimeConfig(options, async descriptor => {
    assert.deepEqual(Object.keys(descriptor), ['relativeConfig']);
    assert.ok(Buffer.byteLength(descriptor.relativeConfig) < 64, 'Core exec uses a 64-byte QPATH including the terminating NUL');
    assert.match(descriptor.relativeConfig, /^control-private-[a-f0-9-]+\/run\.cfg$/);
    config = path.join(homePath, 'main', descriptor.relativeConfig);
    assert.equal(await fs.readFile(config, 'utf8'), 'set rcon_password "Disposable-Rcon-123!"\nset g_password "Disposable-Join-123!"\n');
    // Independently inspect actual Windows rights, not a mock ACL response.
    const script = `$ErrorActionPreference='Stop';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath ${quote(config)};$rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sid=$sid;bad=@($rules|Where-Object{$_.IdentityReference.Value -notin @($sid,'S-1-5-18') -or $_.AccessControlType -ne 'Allow'}).Count;count=$rules.Count}|ConvertTo-Json -Compress`;
    const acl = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout);
    assert.equal(acl.owner, acl.sid); assert.equal(acl.bad, 0); assert.ok(acl.count >= 1);
    return { verified: true };
  });
  assert.deepEqual(result, { verified: true });
  await assert.rejects(fs.lstat(config), { code: 'ENOENT' });
  await assertEmpty(homePath);
});

test('private channel aborts before writing and cleans up when aborted during consumption', windows, async t => {
  const { homePath, options, controller } = await fixture(t);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(module.withPrivateRuntimeConfig({ ...options, signal: pre.signal }, () => assert.fail('No consumer after abort')), { code: 'CREDENTIAL_RUNTIME_ABORTED' });
  await assertEmpty(homePath);
  await assert.rejects(module.withPrivateRuntimeConfig(options, async () => { controller.abort(); }), { code: 'CREDENTIAL_RUNTIME_ABORTED' });
  await assertEmpty(homePath);
});

test('private channel sanitizes consumer errors and still removes plaintext', windows, async t => {
  const { homePath, options } = await fixture(t);
  await assert.rejects(module.withPrivateRuntimeConfig(options, async () => { throw new Error('Disposable-Rcon-123!'); }), error => {
    assert.equal(error.code, 'CREDENTIAL_RUNTIME_HANDOFF_FAILED');
    assert.ok(!String(error.stack).includes('Disposable-Rcon-123!'));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assertEmpty(homePath);
});

test('invalid credentials, unexpected Master token and aliased main never create a private file', windows, async t => {
  const { root, homePath, options } = await fixture(t);
  for (const credentials of [{ rcon: Buffer.from('bad";quit'), join: null }, { ...options.credentials, master: Buffer.from('A'.repeat(32)) }, { rcon: 'not-a-buffer', join: null }, { rcon: null, join: null }]) {
    await assert.rejects(module.withPrivateRuntimeConfig({ ...options, credentials }, () => assert.fail('Invalid channel must not consume')), { code: 'CREDENTIAL_RUNTIME_FILE_INVALID' });
    await assertEmpty(homePath);
  }
  const foreign = path.join(root, 'foreign'); await fs.mkdir(foreign);
  await fs.rmdir(path.join(homePath, 'main'));
  await fs.symlink(foreign, path.join(homePath, 'main'), 'junction');
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Alias must not consume')), { code: 'CREDENTIAL_RUNTIME_FILE_INVALID' });
  assert.deepEqual(await fs.readdir(foreign), []);
});

test('foreign-writable instance parents are rejected without changing their ACL', windows, async t => {
  const { homePath, options } = await fixture(t);
  const script = `$ErrorActionPreference='Stop';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');$p=${quote(homePath)};$a=Get-Acl -LiteralPath $p;$who=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($who,'Write','Allow');$a.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $a;(Get-Acl -LiteralPath $p).Sddl`;
  const before = (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout.trim();
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Unsafe parent must not consume')), { code: 'CREDENTIAL_RUNTIME_ACL_BLOCKED' });
  const after = (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');(Get-Acl -LiteralPath ${quote(homePath)}).Sddl`], { windowsHide: true })).stdout.trim();
  assert.equal(after, before);
  await assertEmpty(homePath);
});

test('cleanup failure is reported and never deletes a replaced foreign file', windows, async t => {
  const { homePath, options } = await fixture(t);
  let replacement;
  await assert.rejects(module.withPrivateRuntimeConfig(options, async ({ relativeConfig }) => {
    replacement = path.join(homePath, 'main', relativeConfig);
    await fs.unlink(replacement);
    await fs.writeFile(replacement, 'foreign replacement - preserve');
  }), { code: 'CREDENTIAL_RUNTIME_CLEANUP_FAILED' });
  assert.equal(await fs.readFile(replacement, 'utf8'), 'foreign replacement - preserve');
});

test('Join channel seals a persistent nonsecret archive before consumption and reuses it without rewriting', windows, async t => {
  const { homePath, options } = await fixture(t);
  const archive = path.join(homePath, 'main/q3config_server.cfg');
  await module.withPrivateRuntimeConfig(options, async () => {
    assert.ok((await fs.lstat(archive)).isFile());
    await assertWriteBlocked(archive);
  });
  const before = await fs.stat(archive), bytes = await fs.readFile(archive);
  assert.ok(!bytes.includes(options.credentials.join));
  assert.ok(!bytes.includes(options.credentials.rcon));
  await assertWriteBlocked(archive);
  await module.withPrivateRuntimeConfig(options, async () => {});
  const after = await fs.stat(archive);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(archive), bytes);
  await assertEmpty(homePath);
});

test('Join channel never adopts or overwrites an existing user archive', windows, async t => {
  const { homePath, options } = await fixture(t);
  const archive = path.join(homePath, 'main/q3config_server.cfg');
  await fs.writeFile(archive, 'seta user_setting "preserve"\n');
  const before = await fs.stat(archive);
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Conflicting archive must block secret transfer')), { code: 'CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT' });
  assert.equal(await fs.readFile(archive, 'utf8'), 'seta user_setting "preserve"\n');
  assert.equal((await fs.stat(archive)).mtimeMs, before.mtimeMs);
  await assertEmpty(homePath);
});

test('writable archive lookalikes and hardlinks are rejected rather than repaired', windows, async t => {
  const { root, homePath, options } = await fixture(t);
  const archive = path.join(homePath, 'main/q3config_server.cfg');
  const marker = '// COD4X CONTROL managed archive guard v1\n// Runtime credentials must not be archived here.\n';
  await fs.writeFile(archive, marker);
  const before = await fs.stat(archive);
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Writable lookalike must not consume')), { code: 'CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT' });
  assert.equal((await fs.stat(archive)).mtimeMs, before.mtimeMs);
  await fs.unlink(archive);
  const foreign = path.join(root, 'foreign-archive.cfg');
  await fs.writeFile(foreign, marker);
  await fs.link(foreign, archive);
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Hardlinked archive must not consume')), { code: 'CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT' });
  assert.equal(await fs.readFile(foreign, 'utf8'), marker);
  assert.equal((await fs.stat(foreign)).nlink, 2);
  await assertEmpty(homePath);
});

test('failed first archive verification removes only the newly-created sealed guard and permits retry', windows, async t => {
  const { homePath, options } = await fixture(t);
  const archive = path.join(homePath, 'main/q3config_server.cfg');
  const lstat = fs.lstat.bind(fs);
  let inject = true;
  const mock = t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0] === archive && inject) {
      inject = false;
      throw Object.assign(new Error('Controlled failure after sealing'), { code: 'EIO' });
    }
    return lstat(...args);
  });
  await assert.rejects(module.withPrivateRuntimeConfig(options, () => assert.fail('Failed setup must not transfer')), { code: 'CREDENTIAL_RUNTIME_ARCHIVE_SETUP_FAILED' });
  mock.mock.restore();
  await assert.rejects(fs.lstat(archive), { code: 'ENOENT' });
  await module.withPrivateRuntimeConfig(options, async () => {});
  await assertWriteBlocked(archive);
  await assertEmpty(homePath);
});
