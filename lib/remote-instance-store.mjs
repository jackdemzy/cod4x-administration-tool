import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertRemotePosixPath, validRemoteInstanceId } from './remote-safety.mjs';
import { normalizeNetwork } from './instance-network.mjs';

// Block 18: the game servers that live on an SSH host. The record is the definition only;
// whether the server runs is read from the server (Task 9). The home and the core path are
// derived from the id and the root, never accepted from the caller.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const copy = value => structuredClone(value);
const VERSIONS = ['21.2', '21.3', '21.4', '21.5'];
const FIELDS = ['id', 'name', 'hostId', 'port', 'remoteRoot', 'basePath', 'core'];
const sameKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
const contains = (parent, child) => child === parent || child.startsWith(`${parent}/`);

function posixPath(value) {
  try { return assertRemotePosixPath(value); } catch { return fail('REMOTE_INSTANCE_INVALID'); }
}
function checkedCore(core) {
  if (!sameKeys(core, ['version', 'sha256']) || !VERSIONS.includes(core.version) || typeof core.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(core.sha256)) fail('REMOTE_INSTANCE_INVALID');
  return { version: core.version, sha256: core.sha256 };
}
function checkedNetwork(network) {
  try { return normalizeNetwork(network); } catch { return fail('REMOTE_INSTANCE_INVALID'); }
}

export class RemoteInstanceStore {
  constructor({ file, hosts }) {
    this.file = path.resolve(file);
    this.hosts = hosts;
    this.instances = new Map();
    this.ready = false;
    this.queue = Promise.resolve();
  }
  // Everything that can be said about one definition without looking at the others.
  definition(input) {
    if (!sameKeys(input, FIELDS)) fail('REMOTE_INSTANCE_INVALID');
    const { id, name, hostId, port } = input;
    if (!validRemoteInstanceId(id) || typeof hostId !== 'string') fail('REMOTE_INSTANCE_INVALID');
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /["\\\u0000-\u001f\u007f]/.test(name)) fail('REMOTE_INSTANCE_INVALID');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('REMOTE_INSTANCE_INVALID');
    const remoteRoot = posixPath(input.remoteRoot), basePath = posixPath(input.basePath), home = `${remoteRoot}/${id}`;
    if (contains(basePath, home) || contains(home, basePath)) fail('REMOTE_PATH_OVERLAP');
    this.hosts.get(hostId); // REMOTE_HOST_NOT_FOUND
    return { id, name: name.trim(), hostId, port, remoteRoot, home, basePath, core: { path: `${home}/core/cod4x18_dedrun`, ...checkedCore(input.core) } };
  }
  // What can be said only against the instances that exist.
  checkAgainst(instance, others) {
    for (const other of others) {
      if (other.id === instance.id) fail('REMOTE_INSTANCE_EXISTS');
      if (other.hostId !== instance.hostId) continue;
      if (other.port === instance.port) fail('REMOTE_PORT_CONFLICT');
      if (contains(other.home, instance.home) || contains(instance.home, other.home)) fail('REMOTE_PATH_OVERLAP');
    }
  }
  async load() {
    this.ready = false;
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') raw = { version: 1, instances: [] };
      else fail('REMOTE_INSTANCE_STORE_INVALID', 'Remote instance list is not readable.');
    }
    if (raw?.version !== 1 || !Array.isArray(raw.instances)) fail('REMOTE_INSTANCE_STORE_INVALID', 'Remote instance list has an unsupported version or structure.');
    const loaded = new Map();
    try {
      for (const value of raw.instances) {
        const instance = this.definition({ id: value.id, name: value.name, hostId: value.hostId, port: value.port, remoteRoot: value.remoteRoot, basePath: value.basePath, core: { version: value.core?.version, sha256: value.core?.sha256 } });
        if (value.home !== instance.home || value.core.path !== instance.core.path || typeof value.createdAt !== 'string') fail('REMOTE_INSTANCE_STORE_INVALID');
        this.checkAgainst(instance, loaded.values());
        loaded.set(instance.id, { ...instance, network: checkedNetwork(value.network), createdAt: value.createdAt });
      }
    } catch { fail('REMOTE_INSTANCE_STORE_INVALID', 'Remote instance list contains an invalid, duplicate or orphaned instance.'); }
    this.instances = loaded;
    this.ready = true;
  }
  ensureReady() { if (!this.ready) fail('REMOTE_INSTANCE_STORE_INVALID', 'Remote instance list was not loaded successfully.'); }
  list() { this.ensureReady(); return [...this.instances.values()].map(copy); }
  listByHost(hostId) { return this.list().filter(instance => instance.hostId === hostId); }
  hasInstancesFor(hostId) { this.ensureReady(); return [...this.instances.values()].some(instance => instance.hostId === hostId); }
  get(id) {
    this.ensureReady();
    const instance = typeof id === 'string' ? this.instances.get(id) : undefined;
    if (!instance) fail('REMOTE_INSTANCE_NOT_FOUND');
    return copy(instance);
  }
  exclusive(action) {
    const result = this.queue.then(() => { this.ensureReady(); return action(); });
    this.queue = result.catch(() => {});
    return result;
  }
  async persist(next) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, instances: [...next.values()] }, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    this.instances = next;
  }
  create(input) {
    return this.exclusive(async () => {
      const definition = this.definition(input);
      this.checkAgainst(definition, this.instances.values());
      const instance = { ...definition, network: checkedNetwork(undefined), createdAt: new Date().toISOString() };
      await this.persist(new Map(this.instances).set(instance.id, instance));
      return copy(instance);
    });
  }
  // Takes an already confirmed network (lib/instance-network.mjs networkChangeRequest).
  setNetwork(id, network) {
    return this.exclusive(async () => {
      const current = this.instances.get(id);
      if (!current) fail('REMOTE_INSTANCE_NOT_FOUND');
      const instance = { ...current, network: checkedNetwork(network) };
      await this.persist(new Map(this.instances).set(id, instance));
      return copy(instance);
    });
  }
  setCore(id, core) {
    return this.exclusive(async () => {
      const current = this.instances.get(id);
      if (!current) fail('REMOTE_INSTANCE_NOT_FOUND');
      const instance = { ...current, core: { path: current.core.path, ...checkedCore(core) } };
      await this.persist(new Map(this.instances).set(id, instance));
      return copy(instance);
    });
  }
  remove(id) {
    return this.exclusive(async () => {
      if (!this.instances.has(id)) fail('REMOTE_INSTANCE_NOT_FOUND');
      const next = new Map(this.instances); next.delete(id);
      await this.persist(next);
    });
  }
}
