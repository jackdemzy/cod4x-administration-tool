import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRemoteLinuxAdapter } from './remote-linux-runtime.mjs';
import { createRemoteFiles } from './remote-files.mjs';
import { assertRemoteBaseGame } from './remote-basegame.mjs';
import { makeDirectoriesCommand, diskFreeCommand, parseDiskFree, recoverHomeCommand } from './remote-commands.mjs';
import { validateManagedConfigText } from './instance-config-validator.mjs';

// Block 18: install, update and (in later parts) run the game servers on an SSH host.
// Every operation connects through RemoteHostService (host key checked, root refused),
// works through the fixed commands and SFTP, and closes the connection again.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const CORE_NAME = 'cod4x18_dedrun';
const MAX_CORE_BYTES = 64 * 1024 * 1024;
const FOLDERS = ['main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs', 'core'];
const ACTIVE = ['STARTING', 'RUNNING', 'STOPPING'];
const LOOPBACK = Object.freeze({ scope: 'LOOPBACK', publicAddress: null });

// The core file on this PC: a regular file with the exact name, of plausible size and the
// SHA-256 the operator confirmed. Nothing is sent before all of this holds.
async function inspectLocalCore(corePath, expectedSha256) {
  if (typeof corePath !== 'string' || !path.isAbsolute(corePath) || path.basename(corePath) !== CORE_NAME
      || typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) fail('REMOTE_CORE_INVALID');
  let handle;
  try {
    if ((await fs.lstat(corePath)).isSymbolicLink()) fail('REMOTE_CORE_INVALID');
    handle = await fs.open(corePath, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_CORE_BYTES) fail('REMOTE_CORE_INVALID');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (hash.digest('hex') !== expectedSha256) fail('REMOTE_CORE_INVALID');
    return { bytes: info.size, sha256: expectedSha256 };
  } catch (error) {
    throw error.code === 'REMOTE_CORE_INVALID' ? error : Object.assign(new Error('REMOTE_CORE_INVALID'), { code: 'REMOTE_CORE_INVALID', cause: error.code });
  } finally { await handle?.close(); }
}

const initialConfig = definition => `// Generated initial configuration; no credentials.\nset sv_hostname "${definition.name}"\nset net_port "${definition.port}"\nset g_log "logs/games_mp.log"\n`;
// Codes that the layers below define and the caller needs to see unchanged (locked vault, root, identity).
const PASS_THROUGH = new Set(['RUNTIME_ROOT_BLOCKED', 'INSTANCE_PROCESS_IDENTITY_BLOCKED']);
const known = (error, fallback) => (typeof error?.code === 'string' && (error.code.startsWith('REMOTE_') || error.code.startsWith('VAULT_') || PASS_THROUGH.has(error.code))
  ? error : Object.assign(new Error(fallback), { code: fallback, cause: error?.code }));

export class RemoteInstanceManager {
  #busy = new Set();
  constructor({ instances, hosts, audit = () => {}, state = null, uploadChunkBytes = 256 * 1024 }) {
    Object.assign(this, { instances, hosts, audit, state, uploadChunkBytes });
  }
  async #exclusive(id, action) {
    if (this.#busy.has(id)) fail('REMOTE_OPERATION_BUSY');
    this.#busy.add(id);
    try { return await action(); } finally { this.#busy.delete(id); }
  }
  async #withServer(hostId, action) {
    const { session, uid, gid } = await this.hosts.connect(hostId);
    try {
      const adapter = await createRemoteLinuxAdapter(session, { uid, gid });
      const files = createRemoteFiles({ sftp: adapter.sftp, filesystem: adapter.filesystem, chunkBytes: this.uploadChunkBytes });
      return await action({ session, adapter, files, filesystem: adapter.filesystem, uid, gid });
    } finally { session.close(); }
  }
  async #enoughSpace(session, path, bytes) {
    const free = parseDiskFree((await session.exec(diskFreeCommand(path), { timeoutMs: 10_000 })).stdout);
    if (free < Math.ceil(bytes / 1024) * 2 + 65_536) fail('REMOTE_DISK_FULL');
  }
  // Uploads to a temporary name and proves the bytes arrived: the hash of what was sent and the
  // hash of what the server now holds must both be the confirmed one.
  async #uploadVerified(files, corePath, temporary, expected, bytes) {
    const sent = await files.uploadFile(corePath, temporary, { mode: 0o755 });
    try {
      if (sent.sha256 !== expected || sent.bytes !== bytes || await files.sha256(temporary) !== expected) fail('REMOTE_UPLOAD_FAILED');
    } catch (error) {
      try { await files.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  // input: { id, name, hostId, port, remoteRoot, basePath, corePath, coreVersion, expectedCoreSha256 }
  async install(input) {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string') fail('REMOTE_INSTANCE_INVALID');
    return this.#exclusive(input.id, async () => {
      const { corePath, coreVersion, expectedCoreSha256, ...rest } = input;
      // Everything that can be decided here is decided before the network is touched.
      const definition = this.instances.definition({ ...rest, core: { version: coreVersion, sha256: expectedCoreSha256 } });
      this.instances.checkAgainst(definition, this.instances.instances.values());
      const core = await inspectLocalCore(corePath, expectedCoreSha256);
      const config = initialConfig(definition);
      validateManagedConfigText(config, { port: definition.port, network: LOOPBACK });
      try {
        return await this.#withServer(definition.hostId, async ({ session, adapter, files, filesystem, uid, gid }) => {
          try { // the instance root: a real directory this login may write in
            const root = await filesystem.lstat(definition.remoteRoot);
            if (!root.isDirectory()) fail('REMOTE_ROOT_INVALID');
            await filesystem.access(definition.remoteRoot, 3);
          } catch (error) { throw error.code === 'REMOTE_ROOT_INVALID' || !error.code || !['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? error : Object.assign(new Error('REMOTE_ROOT_INVALID'), { code: 'REMOTE_ROOT_INVALID' }); }
          await assertRemoteBaseGame(filesystem, definition.basePath, { uid, gid });
          await this.#enoughSpace(session, definition.remoteRoot, core.bytes);
          const present = await filesystem.lstat(definition.home).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (present) fail('REMOTE_HOME_EXISTS'); // never adopt or overwrite
          try {
            const made = await session.exec(makeDirectoriesCommand(definition.home, FOLDERS), { timeoutMs: 15_000 });
            if (made.code !== 0) fail('REMOTE_INSTALL_FAILED');
            const temporary = `${definition.home}/core/.${CORE_NAME}.upload`;
            await this.#uploadVerified(files, corePath, temporary, expectedCoreSha256, core.bytes);
            await files.rename(temporary, definition.core.path);
            await adapter.validateExecutable(definition.core.path);
            await files.writeFileExclusive(`${definition.home}/main/server.cfg`, Buffer.from(config), { mode: 0o600 });
            return await this.instances.create({ ...rest, core: { version: coreVersion, sha256: expectedCoreSha256 } });
          } catch (error) {
            // Move the half-built home aside, never delete it.
            try { await session.exec(recoverHomeCommand(definition.remoteRoot, definition.home, crypto.randomUUID()), { timeoutMs: 15_000 }); }
            catch { this.audit('error', 'remote.instance.recovery_failed', { instanceId: definition.id, hostId: definition.hostId }); }
            throw error;
          }
        });
      } catch (error) {
        const reported = known(error, 'REMOTE_INSTALL_FAILED');
        this.audit('warn', 'remote.instance.install_failed', { instanceId: definition.id, hostId: definition.hostId, code: reported.code });
        throw reported;
      }
    }).then(instance => { this.audit('info', 'remote.instance.installed', { instanceId: instance.id, hostId: instance.hostId }); return instance; });
  }

  // The instance must be stopped. An unknown or blocked state counts as running (fail closed).
  async #assertStopped(instance, adapter) {
    if (!this.state) fail('REMOTE_STATE_UNAVAILABLE');
    const saved = await this.state.read(instance.id);
    if (!saved) return;
    if (saved.recoveryBlocked) fail('REMOTE_INSTANCE_RUNNING');
    if (!ACTIVE.includes(saved.status)) return;
    if (!Number.isSafeInteger(saved.pid)) fail('REMOTE_INSTANCE_RUNNING');
    if ((await adapter.inspectProcess(saved.pid)).alive !== false) fail('REMOTE_INSTANCE_RUNNING');
  }

  // input: { corePath, coreVersion, expectedCoreSha256 }. The old core stays as cod4x18_dedrun.previous.
  async updateCore(id, input) {
    const instance = this.instances.get(id);
    return this.#exclusive(id, async () => {
      if (!input || typeof input !== 'object') fail('REMOTE_INSTANCE_INVALID');
      const next = { version: input.coreVersion, sha256: input.expectedCoreSha256 };
      const { id: instanceId, name, hostId, port, remoteRoot, basePath } = instance;
      this.instances.definition({ id: instanceId, name, hostId, port, remoteRoot, basePath, core: next }); // version and hash shape
      const core = await inspectLocalCore(input.corePath, input.expectedCoreSha256);
      try {
        const updated = await this.#withServer(instance.hostId, async ({ session, adapter, files, filesystem }) => {
          await this.#assertStopped(instance, adapter);
          const current = await filesystem.lstat(instance.core.path).catch(error => { if (error.code === 'ENOENT') fail('REMOTE_CORE_MISSING'); throw error; });
          if (!current.isFile()) fail('REMOTE_CORE_MISSING');
          await this.#enoughSpace(session, instance.home, core.bytes);
          const temporary = `${instance.home}/core/.${CORE_NAME}.upload`, previous = `${instance.core.path}.previous`;
          await this.#uploadVerified(files, input.corePath, temporary, input.expectedCoreSha256, core.bytes);
          let moved = false;
          try {
            await files.unlink(previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await files.rename(instance.core.path, previous); moved = true;
            await files.rename(temporary, instance.core.path);
            await adapter.validateExecutable(instance.core.path);
          } catch (error) {
            if (moved) { // put the old core back
              await files.unlink(instance.core.path).catch(() => {});
              await files.rename(previous, instance.core.path).catch(() => {});
            }
            await files.unlink(temporary).catch(() => {});
            throw Object.assign(new Error('REMOTE_UPDATE_FAILED'), { code: 'REMOTE_UPDATE_FAILED', cause: error.code });
          }
          return this.instances.setCore(id, next);
        });
        this.audit('info', 'remote.instance.updated', { instanceId: id, hostId: instance.hostId });
        return updated;
      } catch (error) {
        const reported = known(error, 'REMOTE_UPDATE_FAILED');
        this.audit('warn', 'remote.instance.update_failed', { instanceId: id, hostId: instance.hostId, code: reported.code });
        throw reported;
      }
    });
  }
}
