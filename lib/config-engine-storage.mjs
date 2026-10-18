import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readValidatedInstanceConfig } from './instance-config-validator.mjs';
import { parseConfigAssignments, writeConfigAssignments, validateConfigModel, diffConfigAssignments } from './config-engine.mjs';

const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

export class ConfigEngineStorage {
  constructor() { this.operations = new Set(); }
  async read(instance) {
    const { text, bytes } = await readValidatedInstanceConfig(instance);
    const entries = parseConfigAssignments(text);
    validateConfigModel(entries, instance);
    return { text, bytes, entries, sha256: hash(text), valid: true };
  }
  async recoveryData(instance) {
    const { text, bytes } = await readValidatedInstanceConfig(instance, { allowMalformedText: true });
    try {
      const entries = parseConfigAssignments(text); validateConfigModel(entries, instance);
      return { text, bytes, sha256: hash(text), entries, valid: true };
    } catch (error) {
      if (!['CONFIG_PARSE_INVALID', 'CONFIG_SCHEMA_INVALID'].includes(error.code)) throw error;
      return { text, bytes, sha256: hash(text), entries: null, valid: false };
    }
  }
  async recoverySnapshot(instance) {
    const { bytes, sha256, valid } = await this.recoveryData(instance);
    return { bytes, sha256, valid };
  }
  async exclusive(instance, action) {
    const key = path.resolve(instance.homePath);
    if (this.operations.has(key)) fail('CONFIG_OPERATION_BUSY', 'Configuration operation already in progress.');
    this.operations.add(key);
    try { return await action(); } finally { this.operations.delete(key); }
  }
  async preview(instance, { entries, expectedSha256 }) {
    validateConfigModel(entries, instance);
    const text = writeConfigAssignments(entries);
    const before = await this.read(instance);
    if (typeof expectedSha256 !== 'string' || before.sha256 !== expectedSha256) fail('CONFIG_CONFLICT', 'Configuration changed since the snapshot.');
    const diff = diffConfigAssignments(before.entries, entries);
    return { valid: true, sha256: before.sha256, candidateSha256: hash(text), diff, restartRequired: diff.length > 0 };
  }
  async listBackups(instance) {
    await this.recoverySnapshot(instance); // Allow recovery from malformed syntax, never from unsafe paths.
    let directory;
    try { directory = await this.backupDirectory(instance); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const identifiers = [];
    let scanned = 0;
    for await (const entry of await fs.opendir(directory)) {
      if (++scanned > 512) fail('CONFIG_BACKUP_LIMIT', 'Configuration backup directory exceeds the listing limit.');
      if (entry.name.endsWith('.json') && UUID.test(entry.name.slice(0, -5))) identifiers.push(entry.name.slice(0, -5));
    }
    const records = [];
    for (const id of identifiers) {
      try {
        const backup = await this.readBackup(instance, id);
        records.push({ id, valid: true, createdAt: backup.createdAt, sha256: backup.sha256, bytes: Buffer.byteLength(backup.text, 'utf8') });
      } catch (error) {
        if (error.code !== 'CONFIG_BACKUP_INVALID') throw error;
        records.push({ id, valid: false, createdAt: null, sha256: null, bytes: null, code: 'CONFIG_BACKUP_INVALID' });
      }
    }
    return records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id));
  }
  async backupDirectory(instance, create = false) {
    const directory = path.join(instance.homePath, 'config-backups');
    if (create) await fs.mkdir(directory, { mode: 0o700 });
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !equalPath(await fs.realpath(directory), path.resolve(directory)) || (process.platform === 'linux' && (stats.uid !== process.getuid() || (stats.mode & 0o022)))) fail('CONFIG_BACKUP_INVALID', 'Unsafe configuration backup directory.');
    return directory;
  }
  async ensureBackupDirectory(instance) {
    try { return await this.backupDirectory(instance); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return this.backupDirectory(instance, true); }
  }
  async createBackup(instance, snapshot) {
    const directory = await this.ensureBackupDirectory(instance);
    const id = crypto.randomUUID(), file = path.join(directory, id + '.json');
    const record = { version: 1, id, instanceId: instance.id, createdAt: new Date().toISOString(), sha256: snapshot.sha256, text: snapshot.text, restorable: snapshot.valid !== false };
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await this.readBackup(instance, id, { allowNonRestorable: snapshot.valid === false });
    return id;
  }
  async readBackup(instance, id, { allowNonRestorable = false } = {}) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('CONFIG_BACKUP_INVALID', 'Invalid configuration backup identifier.');
    let handle;
    try {
      const directory = await this.backupDirectory(instance), file = path.join(directory, id + '.json');
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024 || (process.platform === 'linux' && (before.uid !== process.getuid() || (before.mode & 0o077)))) fail('CONFIG_BACKUP_INVALID', 'Unsafe configuration backup file.');
      handle = await fs.open(file, 'r');
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) fail('CONFIG_BACKUP_INVALID', 'Configuration backup was replaced.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 1024 * 1024) fail('CONFIG_BACKUP_INVALID', 'Configuration backup exceeds size limit.');
      const after = await fs.lstat(file);
      if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size || length !== after.size) fail('CONFIG_BACKUP_INVALID', 'Configuration backup changed while reading.');
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
      if (record.version !== 1 || record.id !== id || record.instanceId !== instance.id || typeof record.text !== 'string' || record.sha256 !== hash(record.text)) fail('CONFIG_BACKUP_INVALID', 'Configuration backup integrity failed.');
      if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt) fail('CONFIG_BACKUP_INVALID', 'Configuration backup timestamp is invalid.');
      if (record.restorable === false) {
        if (!allowNonRestorable) fail('CONFIG_BACKUP_INVALID', 'Damaged-config safety snapshots cannot be restored.');
      } else validateConfigModel(parseConfigAssignments(record.text), instance);
      return record;
    } catch (error) {
      if (error.code === 'CONFIG_BACKUP_INVALID') throw error;
      fail('CONFIG_BACKUP_INVALID', 'Configuration backup could not be validated.');
    } finally { await handle?.close(); }
  }
  async replace(instance, text, expectedSha256, recover = false) {
    const before = recover ? await this.recoveryData(instance) : await this.read(instance);
    if (before.sha256 !== expectedSha256) fail('CONFIG_CONFLICT', 'Configuration changed since the snapshot.');
    const temporary = path.join(path.dirname(instance.configPath), '.server.cfg-' + crypto.randomUUID());
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      const rechecked = recover ? await this.recoveryData(instance) : await this.read(instance);
      if (rechecked.sha256 !== expectedSha256) fail('CONFIG_CONFLICT', 'Configuration changed before apply.');
      await fs.rename(temporary, instance.configPath); created = false;
    } finally { if (created) await fs.unlink(temporary); }
    const result = await this.read(instance);
    if (result.sha256 !== hash(text)) fail('CONFIG_VERIFY_FAILED', 'Applied configuration failed verification. Backup remains available.');
    return result;
  }
  async apply(instance, { entries, expectedSha256 }) {
    return this.exclusive(instance, async () => {
      validateConfigModel(entries, instance);
      return this.applyText(instance, writeConfigAssignments(entries), expectedSha256);
    });
  }
  async applyText(instance, text, expectedSha256, recover = false) {
    const before = recover ? await this.recoveryData(instance) : await this.read(instance);
    if (typeof expectedSha256 !== 'string' || before.sha256 !== expectedSha256) fail('CONFIG_CONFLICT', 'Configuration changed since the snapshot.');
    const entries = parseConfigAssignments(text); validateConfigModel(entries, instance);
    const diff = before.entries ? diffConfigAssignments(before.entries, entries) : [{ name: 'configuration', change: 'recover-invalid', before: '[INVALID]', after: '[VALID]' }];
    if (!diff.length) return { changed: false, verified: true, previousSha256: before.sha256, sha256: before.sha256, backupId: null, diff, restartRequired: false };
    const backupId = await this.createBackup(instance, before);
    const after = await this.replace(instance, text, before.sha256, recover);
    return { changed: true, verified: true, previousSha256: before.sha256, sha256: after.sha256, backupId, diff, restartRequired: true };
  }
  async restore(instance, { backupId, expectedSha256 }) {
    return this.exclusive(instance, async () => {
      const backup = await this.readBackup(instance, backupId);
      return this.applyText(instance, backup.text, expectedSha256, true);
    });
  }
}
