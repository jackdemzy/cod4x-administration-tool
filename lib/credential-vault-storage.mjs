import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sealVault, openVault, openVaultSession } from './credential-vault-codec.mjs';

const LIMIT = 100000;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const hash = data => createHash('sha256').update(data).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class CredentialVaultStorage {
  #plaintext = null;
  #busy = false;
  #generation = 0;
  #session = null;
  #snapshot = null;
  #onLock;
  constructor(dataRoot, { onLock = null } = {}) {
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || (onLock !== null && typeof onLock !== 'function')) fail('VAULT_FILE_INVALID');
    this.#onLock = onLock;
    this.root = path.resolve(dataRoot);
    this.directory = path.join(this.root, 'credential-vault');
    this.file = path.join(this.directory, 'vault.json');
  }
  get locked() { return this.#plaintext === null; }
  lock() {
    ++this.#generation;
    this.#plaintext?.fill(0);
    this.#plaintext = null;
    this.#session?.destroy();
    this.#session = null;
    this.#snapshot = null;
    // Every lock path, including self-locks on conflicts detected by concurrent
    // readers, must revoke dependent plaintext scopes synchronously.
    this.#onLock?.();
  }
  readUnlocked() {
    if (this.locked) fail('VAULT_LOCKED');
    return Buffer.from(this.#plaintext);
  }
  async readVerifiedUnlocked() {
    if (this.locked) fail('VAULT_LOCKED');
    const generation = this.#generation;
    const current = await this.#read();
    if (generation !== this.#generation || this.locked) fail('VAULT_LOCKED');
    if (hash(current.data) !== this.#snapshot) {
      this.lock();
      fail('VAULT_CONFLICT');
    }
    return this.readUnlocked();
  }
  async #exclusive(action) {
    if (this.#busy) fail('VAULT_OPERATION_BUSY');
    this.#busy = true;
    try { return await action(); } finally { this.#busy = false; }
  }
  async #directory(create = false) {
    const root = await fs.lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || !samePath(await fs.realpath(this.root), this.root)) fail('VAULT_FILE_INVALID');
    if (process.platform === 'linux' && (root.uid !== process.getuid() || (root.mode & 0o022))) fail('VAULT_FILE_INVALID');
    if (create) {
      try { await fs.mkdir(this.directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(this.directory), this.directory) ||
        (process.platform === 'linux' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) fail('VAULT_FILE_INVALID');
    return stat;
  }
  async #read(file = this.file) {
    await this.#directory();
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > LIMIT ||
        (process.platform === 'linux' && (before.uid !== process.getuid() || (before.mode & 0o077)))) fail('VAULT_FILE_INVALID');
    const handle = await fs.open(file, 'r');
    let data;
    try {
      if (!sameFile(before, await handle.stat())) fail('VAULT_FILE_INVALID');
      const buffer = Buffer.alloc(LIMIT + 1);
      let count = 0;
      while (count < buffer.length) {
        const result = await handle.read(buffer, count, buffer.length - count, null);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count !== before.size || count > LIMIT || !sameFile(before, await handle.stat())) fail('VAULT_FILE_INVALID');
      data = buffer.subarray(0, count);
    } finally { await handle.close(); }
    if (!sameFile(before, await fs.lstat(file))) fail('VAULT_FILE_INVALID');
    await this.#directory();
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { fail('VAULT_INVALID'); }
    return { envelope, data };
  }
  async initialize(plaintext, passphrase) {
    return this.#exclusive(async () => {
      await this.#directory(true);
      try { await fs.lstat(this.file); fail('VAULT_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const envelope = await sealVault(plaintext, passphrase);
      const temporary = path.join(this.directory, '.vault-' + randomUUID());
      let created = false;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(JSON.stringify(envelope) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await this.#directory();
        // Link is exclusive: unlike rename, it cannot overwrite an existing vault.
        try { await fs.link(temporary, this.file); }
        catch (error) { if (error.code === 'EEXIST') fail('VAULT_EXISTS'); throw error; }
      } finally { if (created) await fs.unlink(temporary); }
      const persisted = await this.#read();
      const verified = await openVault(persisted.envelope, passphrase);
      try { if (!verified.equals(plaintext)) fail('VAULT_FILE_INVALID'); }
      finally { verified.fill(0); }
      return { initialized: true, locked: this.locked };
    });
  }
  async unlock(passphrase) {
    return this.#exclusive(async () => {
      this.lock();
      const generation = this.#generation;
      const before = await this.#read();
      const session = await openVaultSession(before.envelope, passphrase);
      let adopted = false;
      const plaintext = session.open(before.envelope);
      try {
        const after = await this.#read();
        if (!before.data.equals(after.data)) fail('VAULT_FILE_INVALID');
        if (generation !== this.#generation) fail('VAULT_LOCKED');
        this.#plaintext = Buffer.from(plaintext);
        this.#session = session;
        this.#snapshot = hash(before.data);
        adopted = true;
        return { unlocked: true };
      } finally { plaintext.fill(0); if (!adopted) session.destroy(); }
    });
  }
  async snapshot() {
    const current = await this.#read();
    return { sha256: hash(current.data), locked: this.locked };
  }
  async #writeExclusive(file, data) {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    catch (error) {
      await handle.close();
      await fs.unlink(file);
      throw error;
    }
    finally { await handle.close(); }
  }
  async #change(plaintext, expectedSha256) {
    if (this.locked || !this.#session) fail('VAULT_LOCKED');
    const generation = this.#generation;
    const session = this.#session;
    // Encrypt first, validating bounded input before making any backup.
    const candidate = session.seal(plaintext);
    const before = await this.#read();
    if (generation !== this.#generation || this.locked) fail('VAULT_LOCKED');
    if (typeof expectedSha256 !== 'string' || expectedSha256 !== this.#snapshot || hash(before.data) !== expectedSha256) fail('VAULT_CONFLICT');
    if (this.#plaintext.equals(plaintext)) return { changed: false, verified: true, sha256: expectedSha256, backupId: null };
    const backupId = randomUUID();
    const backup = path.join(this.directory, 'backup-' + backupId + '.json');
    await this.#writeExclusive(backup, before.data);
    const saved = await this.#read(backup);
    if (!saved.data.equals(before.data)) fail('VAULT_FILE_INVALID');
    const original = session.open(saved.envelope);
    try { if (!original.equals(this.#plaintext)) fail('VAULT_FILE_INVALID'); }
    finally { original.fill(0); }
    const temporary = path.join(this.directory, '.vault-' + randomUUID());
    let created = false;
    let renamed = false;
    try {
      await this.#writeExclusive(temporary, Buffer.from(JSON.stringify(candidate) + '\n'));
      created = true;
      const current = await this.#read();
      if (hash(current.data) !== expectedSha256) fail('VAULT_CONFLICT');
      if (generation !== this.#generation || this.locked) fail('VAULT_LOCKED');
      await fs.rename(temporary, this.file);
      renamed = true;
      const persisted = await this.#read();
      const verified = session.open(persisted.envelope);
      try {
        if (!verified.equals(plaintext)) fail('VAULT_FILE_INVALID');
        if (generation !== this.#generation || this.locked) fail('VAULT_LOCKED');
        this.#plaintext.fill(0);
        this.#plaintext = Buffer.from(verified);
        this.#snapshot = hash(persisted.data);
      } finally { verified.fill(0); }
      return { changed: true, verified: true, sha256: this.#snapshot, backupId };
    } catch (error) {
      // Once rename happened, preserve the backup and fail closed; do not claim
      // an unverified rollback or leave stale credentials usable in memory.
      if (renamed) this.lock();
      throw error;
    } finally { if (created && !renamed) await fs.unlink(temporary); }
  }
  async #mutation(action) {
    return this.#exclusive(async () => {
      await this.#directory();
      const lockFile = path.join(this.directory, '.operation.lock');
      let handle;
      try { handle = await fs.open(lockFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('VAULT_OPERATION_BUSY'); throw error; }
      try { return await action(); }
      finally { await handle.close(); await fs.unlink(lockFile); }
    });
  }
  async update(plaintext, expectedSha256) {
    // Own the input across asynchronous boundaries, never retain caller data.
    if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > 65536) fail('VAULT_INVALID');
    const copy = Buffer.from(plaintext);
    try { return await this.#mutation(() => this.#change(copy, expectedSha256)); }
    finally { copy.fill(0); }
  }
  async restore(backupId, expectedSha256) {
    if (typeof backupId !== 'string' || !UUID.test(backupId)) fail('VAULT_FILE_INVALID');
    return this.#mutation(async () => {
      if (this.locked || !this.#session) fail('VAULT_LOCKED');
      const session = this.#session;
      const generation = this.#generation;
      const backup = await this.#read(path.join(this.directory, 'backup-' + backupId + '.json'));
      if (generation !== this.#generation || this.locked) fail('VAULT_LOCKED');
      const plaintext = session.open(backup.envelope);
      try { return await this.#change(plaintext, expectedSha256); }
      finally { plaintext.fill(0); }
    });
  }
}
