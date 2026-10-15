import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { CredentialVaultStorage } from './credential-vault-storage.mjs';

const KINDS = Object.freeze(['rcon', 'master', 'join']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const keysAre = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names;

// CONTROL policy: printable single-token credentials, excluding config/command
// delimiters. Shape validation is not evidence that a Master token is accepted.
function validSecret(kind, value) {
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
    this.#storage = new CredentialVaultStorage(dataRoot);
    this.#resolveInstance = resolveInstance;
  }
  lock() {
    this.#storage.lock();
    if (this.#runtimeLease) {
      for (const value of Object.values(this.#runtimeLease.credentials)) value?.fill(0);
      this.#runtimeLease.controller.abort();
    }
  }
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
  async instanceStatus(id) {
    const instanceKey = this.#instance(id);
    const status = await this.status();
    const credentials = status.locked || !status.initialized ? null : (await this.#document()).credentials;
    const result = { locked: status.locked, initialized: status.initialized, sha256: status.sha256 };
    for (const kind of KINDS) {
      const record = credentials?.find(value => value.instanceId === id && value.instanceKey === instanceKey && value.kind === kind);
      result[kind] = { configured: credentials === null ? null : Boolean(record), referenceId: record?.id || null,
        state: credentials === null ? 'LOCKED' : record ? 'CONFIGURED' : 'NOT_CONFIGURED' };
    }
    return result;
  }
  async #change(id, kind, input, remove) {
    const instanceKey = this.#instance(id);
    if (!KINDS.includes(kind) || !keysAre(input, remove ? 'expectedSha256' : 'expectedSha256,value')) fail('CREDENTIAL_INVALID');
    if (!remove) validSecret(kind, input.value);
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
  async set(id, kind, input) { return this.#exclusive(() => this.#change(id, kind, input, false)); }
  async remove(id, kind, input) { return this.#exclusive(() => this.#change(id, kind, input, true)); }
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
