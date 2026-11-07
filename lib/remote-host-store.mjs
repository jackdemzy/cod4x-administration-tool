import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validHostId, validHostName, validRemoteUser } from './remote-safety.mjs';

// Block 18: the SSH hosts CONTROL may connect to. A host only carries the
// address, the login name and the pinned SHA-256 of its host key. The private
// key lives in the credential vault, never here.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const copy = value => structuredClone(value);
const HEX64 = /^[0-9a-f]{64}$/;
const FIELDS = ['id', 'label', 'host', 'port', 'username'];

function validLabel(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= 80 && !/[\u0000-\u001f\u007f"\\]/.test(value);
}

function checked(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) fail('REMOTE_HOST_INVALID');
  const { id, label, host, port, username } = input;
  if (!validHostId(id) || !validLabel(label) || !validHostName(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !validRemoteUser(username)) fail('REMOTE_HOST_INVALID');
  return { id, label: label.trim(), host, port, username };
}

export class RemoteHostStore {
  constructor({ file, inUse = () => false }) {
    this.file = path.resolve(file);
    this.inUse = inUse;
    this.hosts = new Map();
    this.ready = false;
    this.queue = Promise.resolve();
  }
  async load() {
    this.ready = false;
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') raw = { version: 1, hosts: [] };
      else fail('REMOTE_HOST_STORE_INVALID', 'Remote host list is not readable.');
    }
    if (raw?.version !== 1 || !Array.isArray(raw.hosts)) fail('REMOTE_HOST_STORE_INVALID', 'Remote host list has an unsupported version or structure.');
    const loaded = new Map();
    for (const value of raw.hosts) {
      let host;
      try {
        host = { ...checked({ id: value.id, label: value.label, host: value.host, port: value.port, username: value.username }), hostKeySha256: value.hostKeySha256, createdAt: value.createdAt };
      } catch { fail('REMOTE_HOST_STORE_INVALID', 'Remote host list contains an invalid host.'); }
      if ((host.hostKeySha256 !== null && !HEX64.test(host.hostKeySha256)) || typeof host.createdAt !== 'string' || loaded.has(host.id)) fail('REMOTE_HOST_STORE_INVALID', 'Remote host list contains an invalid or duplicate host.');
      loaded.set(host.id, host);
    }
    this.hosts = loaded;
    this.ready = true;
  }
  ensureReady() { if (!this.ready) fail('REMOTE_HOST_STORE_INVALID', 'Remote host list was not loaded successfully.'); }
  list() { this.ensureReady(); return [...this.hosts.values()].map(copy); }
  get(id) {
    this.ensureReady();
    const host = typeof id === 'string' ? this.hosts.get(id) : undefined;
    if (!host) fail('REMOTE_HOST_NOT_FOUND');
    return copy(host);
  }
  exclusive(action) {
    const result = this.queue.then(() => { this.ensureReady(); return action(); });
    this.queue = result.catch(() => {});
    return result;
  }
  async persist(next) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, hosts: [...next.values()] }, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    this.hosts = next;
  }
  create(input) {
    return this.exclusive(async () => {
      const entry = checked(input);
      if (this.hosts.has(entry.id)) fail('REMOTE_HOST_EXISTS');
      const host = { ...entry, hostKeySha256: null, createdAt: new Date().toISOString() };
      await this.persist(new Map(this.hosts).set(host.id, host));
      return copy(host);
    });
  }
  // A host key is pinned once. Pinning the same value again is a no-op; a different
  // value means the server key changed and is never accepted here.
  pinHostKey(id, sha256Hex) {
    return this.exclusive(async () => {
      if (typeof sha256Hex !== 'string' || !HEX64.test(sha256Hex)) fail('REMOTE_HOST_INVALID');
      const current = this.hosts.get(id);
      if (!current) fail('REMOTE_HOST_NOT_FOUND');
      if (current.hostKeySha256 === sha256Hex) return copy(current);
      if (current.hostKeySha256 !== null) fail('REMOTE_HOST_KEY_CHANGED');
      const host = { ...current, hostKeySha256: sha256Hex };
      await this.persist(new Map(this.hosts).set(id, host));
      return copy(host);
    });
  }
  remove(id) {
    return this.exclusive(async () => {
      if (!this.hosts.has(id)) fail('REMOTE_HOST_NOT_FOUND');
      if (await this.inUse(id)) fail('REMOTE_HOST_IN_USE');
      const next = new Map(this.hosts); next.delete(id);
      await this.persist(next);
    });
  }
}
