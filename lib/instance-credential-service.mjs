import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { CredentialVaultStorage } from './credential-vault-storage.mjs';
import { validDatabasePassword } from './b3-database.mjs';
import { validB3AuthPassword, validB3AuthLevel } from './b3-integration.mjs';

const KINDS = Object.freeze(['rcon', 'master', 'join', 'b3db', 'b3auth']);
// b3auth holds a JSON object { "<B3 level>": "<!auth password>" } and is only
// changed through setB3AuthPassword, never through the generic set/remove path.
const GENERIC_KINDS = Object.freeze(['rcon', 'master', 'join', 'b3db']);
// Block 17: a value held by two instances is reported, never blocked. The value
// itself is compared in memory only; results carry instance IDs, nothing else.
const SHARED_WARNING = Object.freeze({ master: 'MASTER_TOKEN_SHARED', rcon: 'RCON_PASSWORD_SHARED' });
const sameValue = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); try { return left.length === right.length && timingSafeEqual(left, right); } finally { left.fill(0); right.fill(0); } };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const keysAre = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names;

// CONTROL policy: printable single-token credentials, excluding config/command
// delimiters. Shape validation is not evidence that a Master token is accepted.
function validSecret(kind, value) {
  // B3 database password: must survive eBc-B3 splitDSN (no '@'), see b3-database.mjs.
  if (kind === 'b3db') return validDatabasePassword(value);
  if (kind === 'b3auth') {
    let map;
    try { map = JSON.parse(value); } catch { fail('CREDENTIAL_INVALID'); }
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) fail('CREDENTIAL_INVALID');
    for (const [level, password] of Object.entries(map)) { validB3AuthLevel(/^\d{1,3}$/.test(level) ? Number(level) : NaN); validB3AuthPassword(password); }
    return;
  }
  if (!KINDS.includes(kind) || typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value) || /[";\\]/.test(value) ||
      value.length < 8 || value.length > (kind === 'join' ? 64 : 128) ||
      (kind === 'master' && !/^[A-Za-z0-9]{32}$/.test(value))) fail('CREDENTIAL_INVALID');
}

function decodeDocument(bytes) {
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('CREDENTIAL_DOCUMENT_INVALID'); }
  if (!keysAre(doc, 'credentials,version') || doc.version !== 1 || !Array.isArray(doc.credentials) || doc.credentials.length > 256) fail('CREDENTIAL_DOCUMENT_INVALID');
  const ids = new Set(), assignments = new Set();
  for (const record of doc.credentials) {
    if (!keysAre(record, 'id,instanceId,instanceKey,kind,updatedAt,value') || typeof record.id !== 'string' || !UUID.test(record.id) || typeof record.instanceId !== 'string' || !INSTANCE_ID.test(record.instanceId) ||
        typeof record.instanceKey !== 'string' || !/^[a-f0-9]{64}$/.test(record.instanceKey) ||
        typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt ||
        ids.has(record.id) || assignments.has(record.instanceKey + ':' + record.kind)) fail('CREDENTIAL_DOCUMENT_INVALID');
    try { validSecret(record.kind, record.value); }
    catch { fail('CREDENTIAL_DOCUMENT_INVALID'); }
    ids.add(record.id); assignments.add(record.instanceKey + ':' + record.kind);
  }
  return doc;
}

export class InstanceCredentialService {
  #storage;
  #resolveInstance;
  #busy = false;
  #runtimeLease = null;
  constructor({ dataRoot, resolveInstance }) {
    if (typeof resolveInstance !== 'function') fail('CREDENTIAL_INVALID');
    this.#storage = new CredentialVaultStorage(dataRoot, { onLock: () => this.#revokeRuntimeLease() });
    this.#resolveInstance = resolveInstance;
  }
  #revokeRuntimeLease() {
    if (!this.#runtimeLease) return;
    for (const value of Object.values(this.#runtimeLease.credentials)) value?.fill(0);
    this.#runtimeLease.controller.abort();
  }
  lock() { this.#storage.lock(); }
  async status() {
    try { return { initialized: true, ...await this.#storage.snapshot() }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { initialized: false, locked: true, sha256: null }; }
  }
  async #exclusive(action) {
    if (this.#busy) fail('VAULT_OPERATION_BUSY');
    this.#busy = true;
    try { return await action(); } finally { this.#busy = false; }
  }
  async initialize(passphrase) {
    return this.#exclusive(async () => {
      const bytes = Buffer.from(JSON.stringify({ version: 1, credentials: [] }));
      try { await this.#storage.initialize(bytes, passphrase); return await this.status(); }
      finally { bytes.fill(0); }
    });
  }
  async #document() {
    const bytes = await this.#storage.readVerifiedUnlocked();
    try { return decodeDocument(bytes); } finally { bytes.fill(0); }
  }
  async unlock(passphrase) {
    return this.#exclusive(async () => {
      await this.#storage.unlock(passphrase);
      try { await this.#document(); return await this.status(); }
      catch (error) { this.lock(); throw error; }
    });
  }
  #instance(id) {
    if (typeof id !== 'string' || !INSTANCE_ID.test(id)) fail('CREDENTIAL_INVALID');
    const instance = this.#resolveInstance(id); // Authoritative registry, not ID alone.
    if (!instance || instance.id !== id || typeof instance.homePath !== 'string' || !path.isAbsolute(instance.homePath) ||
        typeof instance.createdAt !== 'string' || !Number.isFinite(Date.parse(instance.createdAt)) || new Date(instance.createdAt).toISOString() !== instance.createdAt) fail('CREDENTIAL_INVALID');
    const home = process.platform === 'win32' ? path.resolve(instance.homePath).toLowerCase() : path.resolve(instance.homePath);
    return createHash('sha256').update(JSON.stringify([id, home, instance.createdAt])).digest('hex');
  }
  // IDs of other, still existing instances that hold the same value for this kind.
  // Records of archived or recreated instances (instance key no longer matches) are ignored.
  #sharedWith(credentials, id, kind, value) {
    const ids = [];
    for (const record of credentials) {
      if (record.kind !== kind || record.instanceId === id || !sameValue(record.value, value)) continue;
      try { if (this.#instance(record.instanceId) !== record.instanceKey) continue; } catch { continue; }
      if (!ids.includes(record.instanceId)) ids.push(record.instanceId);
    }
    return ids.sort();
  }
  async instanceStatus(id) {
    const instanceKey = this.#instance(id);
    const status = await this.status();
    const credentials = status.locked || !status.initialized ? null : (await this.#document()).credentials;
    const result = { locked: status.locked, initialized: status.initialized, sha256: status.sha256 };
    // Block 16: changes to this instance's records only (ids and change times,
    // never values), for the "restart needed" hints.
    const own = credentials?.filter(value => value.instanceId === id && value.instanceKey === instanceKey).map(value => [value.kind, value.id, value.updatedAt]).sort((a, b) => a[0].localeCompare(b[0]));
    result.digest = own ? createHash('sha256').update(JSON.stringify(own)).digest('hex') : null;
    for (const kind of KINDS) {
      const record = credentials?.find(value => value.instanceId === id && value.instanceKey === instanceKey && value.kind === kind);
      result[kind] = { configured: credentials === null ? null : Boolean(record), referenceId: record?.id || null,
        state: credentials === null ? 'LOCKED' : record ? 'CONFIGURED' : 'NOT_CONFIGURED' };
      // Levels only, never the passwords.
      if (SHARED_WARNING[kind]) result[kind].sharedWith = credentials === null ? null : record ? this.#sharedWith(credentials, id, kind, record.value) : [];
      if (kind === 'b3auth') result[kind].levels = credentials === null ? null : record ? Object.keys(JSON.parse(record.value)).map(Number).sort((a, b) => a - b) : [];
    }
    return result;
  }
  async #change(id, kind, input, remove, internal = false) {
    const instanceKey = this.#instance(id);
    if (!(internal ? KINDS : GENERIC_KINDS).includes(kind) || !keysAre(input, remove ? 'expectedSha256' : 'expectedSha256,value')) fail('CREDENTIAL_INVALID');
    if (!remove) validSecret(kind, input.value);
    // New RCON values must survive the CoD4x command line, which splits at '+'.
    // Not part of document decoding, so older stored values stay readable.
    if (!remove && kind === 'rcon' && input.value.includes('+')) fail('CREDENTIAL_INVALID');
    const doc = await this.#document();
    if (this.#instance(id) !== instanceKey) fail('VAULT_CONFLICT');
    const old = doc.credentials.find(record => record.instanceKey === instanceKey && record.kind === kind);
    doc.credentials = doc.credentials.filter(record => record.instanceKey !== instanceKey || record.kind !== kind);
    if (!remove) doc.credentials.push({ id: old?.id || randomUUID(), instanceId: id, instanceKey, kind, value: input.value,
      updatedAt: old?.value === input.value ? old.updatedAt : new Date().toISOString() });
    doc.credentials.sort((a, b) => (a.instanceKey + ':' + a.kind).localeCompare(b.instanceKey + ':' + b.kind));
    const bytes = Buffer.from(JSON.stringify(doc));
    try { decodeDocument(bytes); return await this.#storage.update(bytes, input.expectedSha256); }
    finally { bytes.fill(0); }
  }
  async set(id, kind, input) {
    return this.#exclusive(async () => {
      const result = await this.#change(id, kind, input, false);
      if (!SHARED_WARNING[kind]) return result;
      // After the change: the stored document is the authority for who else holds the value.
      const instances = this.#sharedWith((await this.#document()).credentials, id, kind, input.value);
      return instances.length ? { ...result, warnings: [{ code: SHARED_WARNING[kind], instances }] } : result;
    });
  }
  async remove(id, kind, input) { return this.#exclusive(() => this.#change(id, kind, input, true)); }
  // One !auth password per B3 level; value null clears that level.
  async setB3AuthPassword(id, input) {
    if (!keysAre(input, 'expectedSha256,level,value')) fail('B3_AUTH_PASSWORD_INVALID');
    const { level, value, expectedSha256 } = input;
    validB3AuthLevel(level);
    if (value !== null) validB3AuthPassword(value);
    return this.#exclusive(async () => {
      const instanceKey = this.#instance(id);
      const record = (await this.#document()).credentials.find(entry => entry.instanceKey === instanceKey && entry.kind === 'b3auth');
      const map = record ? JSON.parse(record.value) : {};
      if (value === null) delete map[level]; else map[level] = value;
      const remove = !Object.keys(map).length;
      await this.#change(id, 'b3auth', remove ? { expectedSha256 } : { expectedSha256, value: JSON.stringify(map) }, remove, true);
      return { level, set: value !== null };
    });
  }
  // Internal transfer scope, never an HTTP read API. Consumers must honor the
  // abort signal before irreversible work and own any further copies they make.
  async withRuntimeCredentials(id, action) {
    if (typeof action !== 'function') fail('CREDENTIAL_INVALID');
    return this.#exclusive(async () => {
      const instanceKey = this.#instance(id);
      const doc = await this.#document();
      if (this.#instance(id) !== instanceKey) fail('VAULT_CONFLICT');
      if (this.#storage.locked) fail('VAULT_LOCKED');
      const credentials = Object.fromEntries(KINDS.map(kind => {
        const record = doc.credentials.find(value => value.instanceId === id && value.instanceKey === instanceKey && value.kind === kind);
        return [kind, record ? Buffer.from(record.value) : null];
      }));
      const controller = new AbortController();
      const lease = { credentials, controller };
      this.#runtimeLease = lease;
      try {
        const result = await action(Object.freeze(credentials), controller.signal);
        if (controller.signal.aborted || this.#storage.locked) fail('VAULT_LOCKED');
        const verified = await this.#storage.readVerifiedUnlocked();
        verified.fill(0);
        if (controller.signal.aborted || this.#storage.locked) fail('VAULT_LOCKED');
        if (this.#instance(id) !== instanceKey) fail('VAULT_CONFLICT');
        if (controller.signal.aborted || this.#storage.locked) fail('VAULT_LOCKED');
        return result;
      } finally {
        for (const value of Object.values(credentials)) value?.fill(0);
        this.#runtimeLease = null;
      }
    });
  }
  // Internal runtime seam only: callers own/wipe the returned Buffer. Never
  // expose this through a read endpoint, diagnostics, logs or runtime history.
  async resolve(id, kind) {
    const instanceKey = this.#instance(id);
    if (!KINDS.includes(kind)) fail('CREDENTIAL_INVALID');
    const record = (await this.#document()).credentials.find(value => value.instanceId === id && value.instanceKey === instanceKey && value.kind === kind);
    if (this.#instance(id) !== instanceKey) fail('VAULT_CONFLICT');
    if (!record) fail('CREDENTIAL_NOT_CONFIGURED');
    return Buffer.from(record.value);
  }
}
