import fs, { constants as fsConstants } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRemoteLinuxAdapter } from './remote-linux-runtime.mjs';
import { createRemoteFiles } from './remote-files.mjs';
import { assertRemoteBaseGame } from './remote-basegame.mjs';
import { makeDirectoriesCommand, diskFreeCommand, parseDiskFree, recoverHomeCommand, startCoreCommand, parsePid, getinfoProbeCommand, removeRconFilesCommand } from './remote-commands.mjs';
import { assertLinuxInstanceOwnership } from './linux-runtime-adapter.mjs';
import { bindAddresses, networkChangeRequest } from './instance-network.mjs';
import { parsePacket, parseInfoResponse, checkPassword } from './rcon-protocol.mjs';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';
import { validateManagedConfigText } from './instance-config-validator.mjs';
import { createContainerRuntime, containerCoreArguments, containerUser, exitReason } from './remote-container-runtime.mjs';
import { assertDockerReady, runtimeImage } from './remote-host-service.mjs';
import { assertDockerMountPath } from './docker-commands.mjs';
import { DEPLOYMENTS } from './remote-instance-store.mjs';

// Block 18: install, update and (in later parts) run the game servers on an SSH host.
// Every operation connects through RemoteHostService (host key checked, root refused),
// works through the fixed commands and SFTP, and closes the connection again.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const CORE_NAME = 'cod4x18_dedrun';
const MAX_CORE_BYTES = 64 * 1024 * 1024;
const FOLDERS = ['main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs', 'core'];
const ACTIVE = ['STARTING', 'RUNNING', 'STOPPING'];
const LOOPBACK = Object.freeze({ scope: 'LOOPBACK', publicAddress: null });
const MAX_CONFIG_BYTES = 256 * 1024;
const IDLE = Object.freeze({ status: 'STOPPED', runId: null, pid: null, createdAt: null, startedAt: null, recoveryBlocked: false, exitReason: null });
const isDocker = instance => instance.deployment === 'docker';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const BACKUP_ID = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const BACKUP_FILES = ['server.cfg', 'instance.json'];
const BACKUP_ACTIONS = ['manual', 'config.change', 'core.update', 'restore.safety'];
const MAX_LOG_BYTES = 1024 * 1024;
const invalidConfig = () => Object.assign(new Error('INSTANCE_CONFIG_INVALID'), { code: 'INSTANCE_CONFIG_INVALID' });
const invalidBackup = () => Object.assign(new Error('REMOTE_BACKUP_INVALID'), { code: 'REMOTE_BACKUP_INVALID' });
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

// At most `limit` bytes of text from the end of a buffer, starting on a character boundary.
function boundedTail(buffer, limit) {
  let offset = 0;
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset++;
  let text = buffer.subarray(offset).toString('utf8');
  if (Buffer.byteLength(text) > limit) { // invalid bytes grew when they became replacement characters
    const bytes = Buffer.from(text); let cut = bytes.length - limit;
    while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut++;
    text = bytes.subarray(cut).toString('utf8');
  }
  return text;
}

// The core file on this PC: a regular file with the exact name, of plausible size and the
// SHA-256 the operator confirmed. Nothing is sent before all of this holds.
// 4.18.25: only below the import directory of CONTROL. The answer is built from the real path of that
// directory and of the folder the file is in, so neither ".." nor a linked folder leads out of it.
async function importedCorePath(importRoot, corePath) {
  const error = code => Object.assign(new Error(code), { code });
  const below = (root, candidate) => candidate === root || candidate[root.length] === path.sep;
  if (typeof importRoot !== 'string' || !importRoot) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  const relative = path.relative(path.resolve(importRoot), path.resolve(corePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  let root;
  try { root = await fs.realpath(importRoot); } catch { throw error('REMOTE_CORE_OUTSIDE_IMPORT'); }
  // checked as text before the file system is asked, and again below on the real path
  const wanted = path.resolve(root, path.dirname(relative));
  if (!wanted.startsWith(root)) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  if (!below(root, wanted)) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  let folder;
  try { folder = await fs.realpath(wanted); }
  catch (cause) { throw error(['ENOENT', 'ENOTDIR'].includes(cause.code) ? 'REMOTE_CORE_INVALID' : 'REMOTE_CORE_OUTSIDE_IMPORT'); }
  if (!folder.startsWith(root)) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  if (!below(root, folder)) throw error('REMOTE_CORE_OUTSIDE_IMPORT');
  return path.join(folder, CORE_NAME);
}
async function inspectLocalCore(importRoot, corePath, expectedSha256) {
  if (typeof corePath !== 'string' || !path.isAbsolute(corePath) || path.basename(corePath) !== CORE_NAME
      || typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) fail('REMOTE_CORE_INVALID');
  const file = await importedCorePath(importRoot, corePath);
  let handle;
  try {
    // O_NOFOLLOW: a link under the name is refused by the open itself, so nothing can be swapped in between a
    // check and the open. What was opened must then still be the file of that name in the checked folder.
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino || await fs.realpath(path.dirname(file)) !== path.dirname(file)) fail('REMOTE_CORE_INVALID');
    if (!info.isFile() || info.size < 1n || info.size > BigInt(MAX_CORE_BYTES)) fail('REMOTE_CORE_INVALID');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (hash.digest('hex') !== expectedSha256) fail('REMOTE_CORE_INVALID');
    return { file, bytes: Number(info.size), sha256: expectedSha256 };
  } catch (error) {
    throw error.code === 'REMOTE_CORE_INVALID' ? error : Object.assign(new Error('REMOTE_CORE_INVALID'), { code: 'REMOTE_CORE_INVALID', cause: error.code });
  } finally { await handle?.close(); }
}

// Security audit 4.18.26 (A4-5): text from the host's getinfo answer reaches the UI bounded and
// without control characters.
const infoText = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) : null);
const initialConfig = definition => `// Generated initial configuration; no credentials.\nset sv_hostname "${definition.name}"\nset net_port "${definition.port}"\nset g_log "logs/games_mp.log"\n`;
// Codes that the layers below define and the caller needs to see unchanged (locked vault, root, identity).
const PASS_THROUGH = new Set(['RECOVERY_REQUIRED', 'RUNTIME_ROOT_BLOCKED', 'INSTANCE_PROCESS_IDENTITY_BLOCKED', 'INSTANCE_CONFIG_INVALID', 'INSTANCE_NETWORK_INVALID', 'INSTANCE_NETWORK_CONFIRMATION_REQUIRED']);
const known = (error, fallback) => (typeof error?.code === 'string' && (error.code.startsWith('REMOTE_') || error.code.startsWith('VAULT_') || PASS_THROUGH.has(error.code))
  ? error : Object.assign(new Error(fallback), { code: fallback, cause: error?.code }));

export class RemoteInstanceManager {
  #busy = new Set();
  // credentials (Block 18b): the vault as seen for remote instances (lib/remote-subjects.mjs prefixedCredentials).
  // onProvisioned(id, runId, { rcon }) tells the RCON service whether this run has a password.
  constructor({ instances, hosts, audit = () => {}, state = null, uploadChunkBytes = 256 * 1024, pollMs = 250, startConfirmMs = 5000, startSettleMs = 1000, stopGraceMs = 10_000, killWaitMs = 5000, backupRoot = null,
    credentials = null, onProvisioned = () => {}, provisionWaitMs = 15_000, coreImportRoot = null, restorePoints = null }) {
    Object.assign(this, { instances, hosts, audit, state, uploadChunkBytes, pollMs, startConfirmMs, startSettleMs, stopGraceMs, killWaitMs, backupRoot: backupRoot ? path.resolve(backupRoot) : null,
      credentials, onProvisioned, provisionWaitMs, coreImportRoot: coreImportRoot ? path.resolve(coreImportRoot) : null, restorePoints });
  }
  // Block 21: a core update whose own rollback failed marks the instance; nothing starts until rollbackCore.
  #subject(id) { return `remote:${id}`; }
  async #recovery(id) {
    if (!this.restorePoints) return null;
    try { return await this.restorePoints.recovery(this.#subject(id)); }
    catch (error) { if (error.code === 'RESTORE_POINT_INVALID') return null; throw error; } // ids the point store cannot name (e.g. "con")
  }
  async #assertNoRecovery(id) { if (await this.#recovery(id)) fail('RECOVERY_REQUIRED'); }
  async #exclusive(id, action) {
    if (this.#busy.has(id)) fail('REMOTE_OPERATION_BUSY');
    this.#busy.add(id);
    try { return await action(); } finally { this.#busy.delete(id); }
  }
  async #withServer(hostId, action) {
    const { session, uid, gid } = await this.hosts.connect(hostId);
    try {
      const adapter = await createRemoteLinuxAdapter(session, { uid, gid });
      const files = createRemoteFiles({ sftp: adapter.sftp, filesystem: adapter.filesystem, chunkBytes: this.uploadChunkBytes, onTimeout: () => session.close() });
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

  // input: { id, name, hostId, port, remoteRoot, basePath, corePath, coreVersion, expectedCoreSha256 }; corePath lies below coreImportRoot
  async install(input) {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string') fail('REMOTE_INSTANCE_INVALID');
    return this.#exclusive(input.id, async () => {
      const { corePath, coreVersion, expectedCoreSha256, ...rest } = input;
      // Everything that can be decided here is decided before the network is touched.
      const definition = this.instances.definition({ ...rest, core: { version: coreVersion, sha256: expectedCoreSha256 } });
      this.instances.checkAgainst(definition, this.instances.instances.values());
      const core = await inspectLocalCore(this.coreImportRoot, corePath, expectedCoreSha256);
      const config = initialConfig(definition);
      validateManagedConfigText(config, { port: definition.port, network: LOOPBACK });
      try {
        return await this.#withServer(definition.hostId, async ({ session, adapter, files, filesystem, uid, gid }) => {
          try { // the instance root: a real directory this login may write in
            const root = await filesystem.lstat(definition.remoteRoot);
            if (!root.isDirectory()) fail('REMOTE_ROOT_INVALID');
            // Security audit 4.18.26 (A4-4): owned by the SSH user, no group/world write unless sticky.
            if (root.uid !== uid || ((root.mode & 0o022) && !(root.mode & 0o1000))) fail('REMOTE_ROOT_UNSAFE');
            await filesystem.access(definition.remoteRoot, 3);
          } catch (error) { throw ['REMOTE_ROOT_INVALID', 'REMOTE_ROOT_UNSAFE'].includes(error.code) || !error.code || !['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? error : Object.assign(new Error('REMOTE_ROOT_INVALID'), { code: 'REMOTE_ROOT_INVALID' }); }
          await assertRemoteBaseGame(filesystem, definition.basePath, { uid, gid });
          // Block 19: the host must reach Docker the way the operator confirmed; the image is asked for at the first start.
          if (isDocker(definition)) await assertDockerReady(session, this.hosts.store.get(definition.hostId), { image: false });
          await this.#enoughSpace(session, definition.remoteRoot, core.bytes);
          const present = await filesystem.lstat(definition.home).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (present) fail('REMOTE_HOME_EXISTS'); // never adopt or overwrite
          try {
            const made = await session.exec(makeDirectoriesCommand(definition.home, FOLDERS), { timeoutMs: 15_000 });
            if (made.code !== 0) fail('REMOTE_INSTALL_FAILED');
            const temporary = `${definition.home}/core/.${CORE_NAME}.upload`;
            await this.#uploadVerified(files, core.file, temporary, expectedCoreSha256, core.bytes);
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
  async #assertStopped(instance, adapter, session) {
    if (!this.state) fail('REMOTE_STATE_UNAVAILABLE');
    const saved = await this.state.read(instance.id);
    if (!saved) return;
    if (saved.recoveryBlocked) fail('REMOTE_INSTANCE_RUNNING');
    if (!ACTIVE.includes(saved.status)) return;
    if (isDocker(instance)) {
      if ((await this.#containers({ session }).identify(instance, saved)).process !== 'GONE') fail('REMOTE_INSTANCE_RUNNING');
      return;
    }
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
      const core = await inspectLocalCore(this.coreImportRoot, input.corePath, input.expectedCoreSha256);
      try {
        const updated = await this.#withServer(instance.hostId, async context => {
          const { session, adapter, files, filesystem } = context;
          await this.#assertStopped(instance, adapter, session);
          const current = await filesystem.lstat(instance.core.path).catch(error => { if (error.code === 'ENOENT') fail('REMOTE_CORE_MISSING'); throw error; });
          if (!current.isFile()) fail('REMOTE_CORE_MISSING');
          await this.#enoughSpace(session, instance.home, core.bytes);
          // Block 21: config, record and the hash the kept .previous will have, before the first change.
          const backup = this.backupRoot ? await this.#saveBackup(instance, (await this.#configFile(instance, context, { strict: false })).buffer, 'core.update') : null;
          const temporary = `${instance.home}/core/.${CORE_NAME}.upload`, previous = `${instance.core.path}.previous`;
          await this.#uploadVerified(files, core.file, temporary, input.expectedCoreSha256, core.bytes);
          let moved = false;
          try {
            await files.unlink(previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await files.rename(instance.core.path, previous); moved = true;
            await files.rename(temporary, instance.core.path);
            await adapter.validateExecutable(instance.core.path);
          } catch (error) {
            let recoveryRequired = false;
            if (moved) { // put the old core back
              await files.unlink(instance.core.path).catch(() => {});
              const back = await files.rename(previous, instance.core.path).then(() => true, () => false);
              if (!back && backup && this.restorePoints) {
                recoveryRequired = await this.restorePoints.markRecovery(this.#subject(id), backup.backupId).then(() => true, () => false);
                this.audit('error', 'change.rollback_failed', { subject: this.#subject(id), action: 'core.update', restorePointId: backup.backupId });
              }
            }
            await files.unlink(temporary).catch(() => {});
            throw Object.assign(new Error('REMOTE_UPDATE_FAILED'), { code: 'REMOTE_UPDATE_FAILED', cause: error.code, ...(recoveryRequired ? { recoveryRequired: true, restorePointId: backup.backupId } : {}) });
          }
          const saved = await this.instances.setCore(id, next);
          return backup ? { ...saved, restorePointId: backup.backupId } : saved;
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

  // Block 21: puts the kept core back (cod4x18_dedrun.previous). Its hash must match the newest core.update
  // backup that recorded it; the version comes from that backup. Clears the recovery mark on success.
  async rollbackCore(id) {
    this.#requireState(); this.#requireBackups();
    return this.#guarded(id, 'core_rolled_back', async instance => this.#withServer(instance.hostId, async ({ session, adapter, files, filesystem }) => {
      await this.#assertStopped(instance, adapter, session);
      const previous = `${instance.core.path}.previous`, parked = `${instance.home}/core/.${CORE_NAME}.rollback`;
      const kept = await filesystem.lstat(previous).catch(error => { if (error.code === 'ENOENT') throw invalidBackup(); throw error; });
      if (!kept.isFile()) throw invalidBackup();
      const keptSha256 = await files.sha256(previous);
      let source = null;
      for (const entry of await this.listBackups(id)) {
        if (entry.invalid || entry.action !== 'core.update') continue;
        const { manifest } = await this.#verifiedBackup(instance, entry.backupId);
        if (manifest.core?.previousSha256 === keptSha256) { source = manifest; break; }
      }
      if (!source) throw invalidBackup();
      const current = await filesystem.lstat(instance.core.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && !current.isFile()) fail('REMOTE_CORE_MISSING');
      await files.unlink(parked).catch(error => { if (error.code !== 'ENOENT') throw error; });
      // current -> parked, previous -> core, parked -> previous; undone step by step when one fails.
      let step = 0;
      try {
        if (current) { await files.rename(instance.core.path, parked); step = 1; }
        await files.rename(previous, instance.core.path); step = 2;
        await adapter.validateExecutable(instance.core.path);
        if (current) await files.rename(parked, previous);
      } catch (error) {
        if (step === 2) await files.rename(instance.core.path, previous).catch(() => {});
        if (step >= 1) await files.rename(parked, instance.core.path).catch(() => {});
        throw Object.assign(new Error('REMOTE_UPDATE_FAILED'), { code: 'REMOTE_UPDATE_FAILED', cause: error.code });
      }
      const updated = await this.instances.setCore(id, { version: source.core.version, sha256: keptSha256 }); // the record first, then the mark goes
      if (this.restorePoints) await this.restorePoints.clearRecovery(this.#subject(id)).catch(error => { if (error.code !== 'RESTORE_POINT_INVALID') throw error; });
      return { core: updated.core, backupId: source.backupId };
    }));
  }

  // ---- running the server ----------------------------------------------------
  #requireState() { if (!this.state) fail('REMOTE_STATE_UNAVAILABLE'); }

  // Who is the process in the saved state? ALIVE (ours and running), GONE, NOT_OURS (the pid belongs to
  // another program now) or UNKNOWN (cannot tell; never acted on).
  #identify(instance, saved, info, { uid, gid }) {
    if (info.alive === false) return 'GONE';
    if (info.alive !== true) return 'UNKNOWN';
    if (saved.createdAt && info.createdAt !== saved.createdAt) return 'NOT_OURS';
    try { assertLinuxInstanceOwnership(info, { homePath: instance.home, port: instance.port, createdAt: saved.createdAt || undefined, uid, gid }); }
    catch { return 'UNKNOWN'; }
    return info.executablePath === instance.core.path ? 'ALIVE' : 'UNKNOWN';
  }

  // Compares the saved state with the server and records what changed. -> { runtime, process }
  // Security audit 4.18.26 (A4-3): status(), statusAll() and health() reconcile without the lock.
  // A state a lifecycle operation wrote after `saved` was read is never overwritten.
  async #writeIfUnchanged(id, saved, next) {
    const current = await this.state.read(id);
    if (!current || current.updatedAt !== saved.updatedAt || current.runId !== saved.runId || current.status !== saved.status) return current || saved;
    return this.state.write(id, next);
  }

  async #reconcile(instance, saved, context) {
    if (!saved) return { runtime: { ...IDLE }, process: 'GONE' };
    if (!ACTIVE.includes(saved.status)) return { runtime: saved, process: 'GONE' };
    if (isDocker(instance)) return this.#reconcileContainer(instance, saved, context);
    if (saved.pid === null) return { runtime: saved, process: 'UNKNOWN' };
    const info = await context.adapter.inspectProcess(saved.pid);
    const process = this.#identify(instance, saved, info, context);
    if (process === 'ALIVE') {
      // a start that was interrupted after the pid was known: it is running, so it is recorded as such
      if (saved.status === 'STARTING') return { runtime: await this.#writeIfUnchanged(instance.id, saved, { ...saved, status: 'RUNNING', createdAt: info.createdAt, recoveryBlocked: false }), process };
      return { runtime: saved, process };
    }
    if (process === 'GONE' || process === 'NOT_OURS') {
      const planned = saved.status === 'STOPPING';
      const runtime = await this.#writeIfUnchanged(instance.id, saved, { ...saved, status: planned ? 'STOPPED' : 'FAILED', pid: null, createdAt: null, recoveryBlocked: false, exitReason: planned ? null : 'PROCESS_GONE' });
      return { runtime, process: 'GONE' };
    }
    return { runtime: saved, process };
  }

  // ---- Block 19: the same questions for an instance that runs in a container -------------------------
  #containers({ session }) { return createContainerRuntime({ session, stopGraceMs: this.stopGraceMs }); }

  async #reconcileContainer(instance, saved, context) {
    if (!saved.containerId) return { runtime: saved, process: 'UNKNOWN' }; // a start was interrupted before the ID was known
    const { process, container } = await this.#containers(context).identify(instance, saved);
    if (process === 'ALIVE') {
      if (saved.status === 'STARTING') return { runtime: await this.#writeIfUnchanged(instance.id, saved, { ...saved, status: 'RUNNING', recoveryBlocked: false }), process };
      return { runtime: saved, process };
    }
    if (process === 'GONE') {
      const planned = saved.status === 'STOPPING';
      // An exited container stays (with its ID in the state) so that its output and exit reason can be read;
      // the next start or stop removes it.
      const runtime = await this.#writeIfUnchanged(instance.id, saved, { ...saved, status: planned ? 'STOPPED' : 'FAILED', containerId: container ? saved.containerId : null,
        recoveryBlocked: false, exitReason: planned ? null : exitReason(container) });
      return { runtime, process: 'GONE' };
    }
    return { runtime: saved, process };
  }

  // What must hold on the server before a container is created. Nothing is written before this passed.
  async #containerPreflight(instance, context) {
    const ready = await assertDockerReady(context.session, this.hosts.store.get(instance.hostId)); // REMOTE_DOCKER_*
    await this.#containers(context).clearLeftover(instance); // INSTANCE_PROCESS_IDENTITY_BLOCKED / REMOTE_DOCKER_CONTAINER_EXISTS
    return ready;
  }

  async #runAndConfirmContainer(instance, context, runId, args, ready) {
    const containers = this.#containers(context);
    let current = await this.state.write(instance.id, { status: 'STARTING', runId, pid: null, createdAt: null, startedAt: new Date().toISOString(), recoveryBlocked: false, exitReason: null });
    const blocked = async cause => {
      await this.state.write(instance.id, { ...current, recoveryBlocked: true });
      throw Object.assign(new Error('REMOTE_RECOVERY_BLOCKED'), { code: 'REMOTE_RECOVERY_BLOCKED', cause });
    };
    const failed = async reason => {
      await this.state.write(instance.id, { ...current, status: 'FAILED', exitReason: reason });
      throw Object.assign(new Error('REMOTE_START_FAILED'), { code: 'REMOTE_START_FAILED' });
    };
    let containerId;
    try { containerId = await containers.run(instance, { runId, imageId: ready.imageId, user: containerUser(ready.mode, context), args }); }
    catch (error) {
      if (error.code !== 'REMOTE_DOCKER_START_FAILED') await blocked(error.code); // the answer was lost: a container may exist
      // Docker refused. A created but never started container of this run is removed; anything else blocks.
      let discarded = false;
      try { discarded = await containers.discardFailedRun(instance, runId); } catch { /* blocked below */ }
      if (!discarded) await blocked('REMOTE_DOCKER_START_FAILED');
      await failed('START_FAILED');
    }
    current = await this.state.write(instance.id, { ...current, containerId });
    // Docker reports "running" from the moment the process exists. A core that ends right away (missing library,
    // bad file) would be reported RUNNING by one look, so the container must stay up for startSettleMs.
    // Not seen alive within startConfirmMs, or not settled within startConfirmMs + startSettleMs: blocked.
    const begun = Date.now(), cap = begun + this.startConfirmMs + this.startSettleMs;
    for (let aliveSince = null; ;) {
      const { process, container } = await containers.identify(instance, current);
      if (process === 'GONE') await failed('EXITED_ON_START'); // the container stays for its output
      if (process === 'ALIVE') {
        if (container.image !== ready.imageId) await blocked('REMOTE_DOCKER_IMAGE_MISMATCH'); // not the image this start asked for
        aliveSince ??= Date.now();
        if (Date.now() - aliveSince >= this.startSettleMs) return this.state.write(instance.id, { ...current, status: 'RUNNING' });
      } else aliveSince = null;
      if (Date.now() >= (aliveSince === null ? begun + this.startConfirmMs : cap)) await blocked('REMOTE_TIMEOUT');
      await sleep(Math.min(this.pollMs, this.startSettleMs || this.pollMs));
    }
  }

  async #stopContainer(instance, runtime, context) {
    const stopping = await this.state.write(instance.id, { ...runtime, status: 'STOPPING' });
    await this.#containers(context).stop(instance, stopping);
    return this.state.write(instance.id, { ...stopping, status: 'STOPPED', containerId: null, recoveryBlocked: false, exitReason: null });
  }
  // A container that already ended is removed when the operator stops or restarts the instance.
  async #removeEnded(instance, runtime, context) {
    if (!isDocker(instance) || !runtime.containerId) return runtime;
    await this.#containers(context).stop(instance, runtime);
    return this.state.write(instance.id, { ...runtime, containerId: null });
  }

  async #recoverContainer(instance, saved, context) {
    const containers = this.#containers(context);
    const container = await containers.find(instance); // INSTANCE_PROCESS_IDENTITY_BLOCKED
    await this.#sweepRconFiles(instance, context.session);
    const stopped = { ...saved, status: 'STOPPED', pid: null, createdAt: null, containerId: null, recoveryBlocked: false, exitReason: null };
    if (!container) return this.state.write(instance.id, stopped);
    if (container.run !== saved.runId) fail('REMOTE_RECOVERY_AMBIGUOUS'); // of this instance, but not the run that was in flight
    // a running container is adopted only when it runs the runtime image of this host
    if (container.status === 'running' && container.image !== (await runtimeImage(context.session))?.id) fail('REMOTE_RECOVERY_AMBIGUOUS');
    if (container.status === 'running') return this.state.write(instance.id, { ...saved, status: 'RUNNING', pid: null, createdAt: null, containerId: container.id, recoveryBlocked: false, exitReason: null });
    if (!['exited', 'dead', 'created'].includes(container.status)) fail('REMOTE_RECOVERY_BLOCKED');
    await containers.remove(container.id);
    return this.state.write(instance.id, stopped);
  }

  // server.cfg as a plain file (not a link, one name) of reasonable size that did not change while it was
  // read. strict: also valid UTF-8 text without control characters. -> { buffer, text | null }
  async #configFile(instance, { files, filesystem }, { strict = true } = {}) {
    const file = `${instance.home}/main/server.cfg`;
    const inspect = async () => {
      const info = await filesystem.lstat(file).catch(error => { throw error.code === 'ENOENT' ? invalidConfig() : error; });
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_CONFIG_BYTES) throw invalidConfig();
      return info;
    };
    const before = await inspect();
    let buffer;
    try { buffer = await files.readFile(file, { maxBytes: MAX_CONFIG_BYTES }); }
    catch (error) { throw error.code === 'REMOTE_FILE_TOO_LARGE' ? invalidConfig() : error; }
    const after = await inspect();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw invalidConfig();
    if (!strict) return { buffer, text: null };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw invalidConfig(); }
    if (!text.trim() || CONTROL.test(text)) throw invalidConfig();
    return { buffer, text };
  }
  async #checkedConfig(instance, context) {
    validateManagedConfigText((await this.#configFile(instance, context)).text, instance); // INSTANCE_CONFIG_INVALID
  }

  // Block 18b: the RCON password for this run, as a private file the core reads with +exec. It never
  // becomes an argument (the server's process list shows arguments). No password, a locked vault or a
  // value the config line cannot carry: the core starts without RCON, as a local one does.
  // The upload happens inside the vault scope: a lock while it runs aborts the scope (signal), the file is
  // swept and the core starts without RCON. Any failure after the file may exist is swept the same way.
  async #rconFile(instance, runId, files, session) {
    if (!this.credentials) return null;
    const name = `rcon-${runId}.cfg`;
    try {
      return await this.credentials.withRuntimeCredentials(instance.id, async ({ rcon }, signal) => {
        if (!rcon) return null;
        try { checkPassword(rcon); } catch { return null; }
        const content = Buffer.concat([Buffer.from('set rcon_password "'), rcon, Buffer.from('"\n')]);
        try { await files.writeFileExclusive(`${instance.home}/main/${name}`, content, { mode: 0o600 }); }
        finally { content.fill(0); }
        if (signal?.aborted) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
        return name;
      });
    } catch (error) {
      await this.#sweepRconFiles(instance, session);
      this.audit('warn', 'remote.instance.rcon_unavailable', { instanceId: instance.id, code: error?.code || 'REMOTE_RCON_UNAVAILABLE' });
      return null;
    }
  }
  // Removes every rcon-*.cfg in main/. Never fails the operation; a file that stays is audited.
  async #sweepRconFiles(instance, session) {
    try {
      const result = await session.exec(removeRconFilesCommand(instance.home), { timeoutMs: 10_000 });
      if (result.code === 0) return true;
    } catch { /* reported below */ }
    this.audit('warn', 'remote.instance.rcon_file_left', { instanceId: instance.id, hostId: instance.hostId });
    return false;
  }
  // The core prints "execing <file>" when it has read a config file; the file is removed only after that.
  async #waitExecuted(adapter, instance, runId, name, read = () => adapter.readOutput(instance.home, runId, 65536)) {
    for (const deadline = Date.now() + this.provisionWaitMs; ;) {
      try { if ((await read()).stdout.includes(`execing ${name}`)) return true; } catch { /* not readable yet */ }
      if (Date.now() >= deadline) return false;
      await sleep(this.pollMs);
    }
  }

  // Everything is checked before the first state is written, so a refused start leaves no trace.
  async #launch(instance, context) {
    const { session, adapter, files, filesystem, uid, gid } = context;
    await adapter.validateExecutable(instance.core.path);
    if (await files.sha256(instance.core.path) !== instance.core.sha256) fail('REMOTE_CORE_CHANGED');
    await assertRemoteBaseGame(filesystem, instance.basePath, { uid, gid });
    await this.#checkedConfig(instance, context);
    if (isDocker(instance)) return this.#launchContainer(instance, context);
    const runId = crypto.randomUUID();
    const { stdoutFile, stderrFile } = await adapter.prepareRemoteOutput(instance.home, runId);
    const bind = bindAddresses(instance.network), port = String(instance.port);
    const rconFile = await this.#rconFile(instance, runId, files, session);
    const args = ['+set', 'dedicated', '2', '+set', 'fs_basepath', instance.basePath, '+set', 'fs_homepath', instance.home,
      '+set', 'net_port', port, '+set', 'net_ip', bind.ipv4, '+set', 'net_port6', port, '+set', 'net_ip6', bind.ipv6,
      ...(rconFile ? ['+exec', rconFile] : []), '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'];
    let running, provisioned = false;
    try {
      running = await this.#spawnAndConfirm(instance, context, runId, args, stdoutFile, stderrFile);
      if (rconFile) provisioned = await this.#waitExecuted(adapter, instance, runId, rconFile);
    } finally {
      if (rconFile) await this.#sweepRconFiles(instance, session);
    }
    try { this.onProvisioned(instance.id, runId, { rcon: provisioned }); } catch { /* informational */ }
    return running;
  }

  // The same start for a container: the checks above passed, the RCON file follows the Block 18b path.
  async #launchContainer(instance, context) {
    const { session, adapter, files } = context;
    const ready = await this.#containerPreflight(instance, context);
    const runId = crypto.randomUUID();
    const rconFile = await this.#rconFile(instance, runId, files, session);
    let running, provisioned = false;
    try {
      running = await this.#runAndConfirmContainer(instance, context, runId, containerCoreArguments(instance.port, rconFile), ready);
      if (rconFile) provisioned = await this.#waitExecuted(adapter, instance, runId, rconFile, () => this.#containers(context).readOutput(running.containerId, 65536));
    } finally {
      if (rconFile) await this.#sweepRconFiles(instance, session);
    }
    try { this.onProvisioned(instance.id, runId, { rcon: provisioned }); } catch { /* informational */ }
    return running;
  }

  async #spawnAndConfirm(instance, context, runId, args, stdoutFile, stderrFile) {
    const { session, adapter } = context;
    // Written before the process exists: whatever happens next, a later start sees that one may.
    let current = await this.state.write(instance.id, { status: 'STARTING', runId, pid: null, createdAt: null, startedAt: new Date().toISOString(), recoveryBlocked: false, exitReason: null });
    let result;
    try { result = await session.exec(startCoreCommand({ core: instance.core.path, cwd: instance.basePath, args, stdoutFile, stderrFile }), { timeoutMs: 20_000 }); }
    catch (error) {
      await this.state.write(instance.id, { ...current, recoveryBlocked: true });
      throw Object.assign(new Error('REMOTE_RECOVERY_BLOCKED'), { code: 'REMOTE_RECOVERY_BLOCKED', cause: error.code });
    }
    let pid;
    try { pid = parsePid(result.stdout); }
    catch { // nothing was started: no pid was printed
      await this.state.write(instance.id, { ...current, status: 'FAILED', exitReason: 'START_FAILED' });
      throw Object.assign(new Error('REMOTE_START_FAILED'), { code: 'REMOTE_START_FAILED' });
    }
    current = await this.state.write(instance.id, { ...current, pid });
    // As for a container: a core that ends right after it was seen alive is a failed start, so it must stay up
    // for startSettleMs. The creation time of the first look is kept; a later look with another one is not ALIVE.
    const begun = Date.now(), cap = begun + this.startConfirmMs + this.startSettleMs;
    for (let aliveSince = null, createdAt = null; ;) {
      const info = await adapter.inspectProcess(pid);
      const process = this.#identify(instance, { ...current, createdAt }, info, context);
      if (process === 'GONE') {
        await this.state.write(instance.id, { ...current, status: 'FAILED', pid: null, exitReason: 'EXITED_ON_START' });
        throw Object.assign(new Error('REMOTE_START_FAILED'), { code: 'REMOTE_START_FAILED' });
      }
      if (process === 'ALIVE') {
        aliveSince ??= Date.now(); createdAt ??= info.createdAt;
        if (Date.now() - aliveSince >= this.startSettleMs) return this.state.write(instance.id, { ...current, status: 'RUNNING', createdAt });
      } else { aliveSince = null; createdAt = null; }
      if (Date.now() >= (aliveSince === null ? begun + this.startConfirmMs : cap)) {
        await this.state.write(instance.id, { ...current, recoveryBlocked: true });
        throw Object.assign(new Error('REMOTE_RECOVERY_BLOCKED'), { code: 'REMOTE_RECOVERY_BLOCKED' });
      }
      await sleep(Math.min(this.pollMs, this.startSettleMs || this.pollMs));
    }
  }

  async #waitGone(adapter, pid, createdAt, milliseconds) {
    for (const deadline = Date.now() + milliseconds; ;) {
      const info = await adapter.inspectProcess(pid);
      if (info.alive === false || (info.alive === true && info.createdAt !== createdAt)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(this.pollMs);
    }
  }

  // TERM first, KILL if it does not end; every signal goes through the identity check of the adapter.
  async #stopRunning(instance, runtime, context) {
    if (isDocker(instance)) return this.#stopContainer(instance, runtime, context);
    const { adapter } = context;
    if (!runtime.createdAt) fail('REMOTE_RECOVERY_BLOCKED'); // the birth of the process is not known, so it cannot be verified
    const stopping = await this.state.write(instance.id, { ...runtime, status: 'STOPPING' });
    const expected = { homePath: instance.home, port: instance.port, executablePath: instance.core.path, createdAt: runtime.createdAt };
    await adapter.signal(runtime.pid, expected, 'SIGTERM');
    if (!await this.#waitGone(adapter, runtime.pid, runtime.createdAt, this.stopGraceMs)) {
      await adapter.signal(runtime.pid, expected, 'SIGKILL');
      if (!await this.#waitGone(adapter, runtime.pid, runtime.createdAt, this.killWaitMs)) fail('REMOTE_STOP_FAILED');
    }
    return this.state.write(instance.id, { ...stopping, status: 'STOPPED', pid: null, createdAt: null, recoveryBlocked: false, exitReason: null });
  }

  async #operation(id, event, action) {
    this.#requireState();
    const instance = this.instances.get(id);
    return this.#exclusive(id, async () => {
      try {
        const runtime = await action(instance);
        this.audit('info', `remote.instance.${event}`, { instanceId: id, hostId: instance.hostId });
        return { instance: this.instances.get(id), runtime };
      } catch (error) {
        const reported = known(error, `REMOTE_${event.toUpperCase()}_FAILED`);
        this.audit('warn', `remote.instance.${event}_failed`, { instanceId: id, hostId: instance.hostId, code: reported.code });
        throw reported;
      }
    });
  }

  async start(id) {
    return this.#operation(id, 'started', async instance => {
      await this.#assertNoRecovery(id);
      const saved = await this.state.read(id);
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (process === 'ALIVE') fail('REMOTE_ALREADY_RUNNING');
        if (runtime.recoveryBlocked || (process === 'UNKNOWN' && ACTIVE.includes(runtime.status))) fail('REMOTE_RECOVERY_BLOCKED');
        await this.#sweepRconFiles(instance, context.session);
        return this.#launch(instance, context);
      });
    });
  }

  async stop(id) {
    return this.#operation(id, 'stopped', async instance => {
      const saved = await this.state.read(id);
      // an ended container that was kept for its output is removed by a stop
      const ended = Boolean(saved) && isDocker(instance) && Boolean(saved.containerId) && !ACTIVE.includes(saved.status) && !saved.recoveryBlocked;
      if (!ended && (!saved || !ACTIVE.includes(saved.status))) return saved || { ...IDLE }; // nothing to stop, no connection needed
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        await this.#sweepRconFiles(instance, context.session);
        if (process === 'UNKNOWN') fail('REMOTE_RECOVERY_BLOCKED');
        if (ended && process === 'ALIVE') fail('REMOTE_RECOVERY_BLOCKED'); // the state said ended, Docker says running
        if (process === 'GONE') return this.state.write(id, { ...await this.#removeEnded(instance, runtime, context), status: 'STOPPED', pid: null, createdAt: null, recoveryBlocked: false });
        return this.#stopRunning(instance, runtime, context);
      });
    });
  }

  async restart(id) {
    return this.#operation(id, 'restarted', async instance => {
      await this.#assertNoRecovery(id);
      const saved = await this.state.read(id);
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (runtime.recoveryBlocked || process === 'UNKNOWN') fail('REMOTE_RECOVERY_BLOCKED');
        if (process === 'ALIVE') await this.#stopRunning(instance, runtime, context);
        await this.#sweepRconFiles(instance, context.session);
        return this.#launch(instance, context);
      });
    });
  }

  // Every process on the server that is a core of this instance (its executable, its home, its port, this login).
  async #coreProcesses(instance, context) {
    const { adapter, filesystem } = context;
    const found = [];
    for (const name of await filesystem.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const exe = await filesystem.readlink(`/proc/${name}/exe`).catch(() => null);
      if (exe !== instance.core.path) continue;
      const info = await adapter.inspectProcess(Number(name));
      if (this.#identify(instance, { createdAt: null }, info, context) === 'ALIVE') found.push({ pid: Number(name), createdAt: info.createdAt });
    }
    return found;
  }

  // Block 19: switches a stopped instance between a plain process and a container. The directories on
  // the server are the same for both, so no file is moved. Refused unless nothing of the instance runs:
  // by the saved state, and by what the server shows (a core process, a container under the name).
  async setDeployment(id, input) {
    this.#requireState();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'deployment' || !DEPLOYMENTS.includes(input.deployment)) fail('REMOTE_INSTANCE_INVALID');
    const { deployment } = input;
    const instance = this.instances.get(id);
    if (instance.deployment === deployment) return { instance, previous: deployment };
    return this.#exclusive(id, async () => {
      try {
        const saved = await this.state.read(id);
        if (saved && (ACTIVE.includes(saved.status) || saved.recoveryBlocked)) fail('REMOTE_INSTANCE_RUNNING');
        if (deployment === 'docker') { assertDockerMountPath(instance.home); assertDockerMountPath(instance.basePath); }
        await this.#withServer(instance.hostId, async context => {
          if (deployment === 'docker') await assertDockerReady(context.session, this.hosts.store.get(instance.hostId), { image: false });
          if ((await this.#coreProcesses(instance, context)).length) fail('REMOTE_INSTANCE_RUNNING');
          // Docker is asked whenever the instance is or becomes a container. Only a host where the docker program
          // itself is gone has no container to ask about; a daemon that does not answer still blocks.
          const containers = this.#containers(context);
          const container = await containers.find(instance).catch(error => (error.code === 'REMOTE_DOCKER_NOT_INSTALLED' && deployment === 'native' ? null : Promise.reject(error))); // INSTANCE_PROCESS_IDENTITY_BLOCKED
          if (container && !['exited', 'dead', 'created'].includes(container.status)) fail('REMOTE_INSTANCE_RUNNING');
          if (container) await containers.remove(container.id);
        });
        const updated = await this.instances.setDeployment(id, deployment);
        await this.state.clear(id); // a pid is never read as a container, or the other way round
        this.audit('info', 'remote.instance.deployment_changed', { instanceId: id, hostId: instance.hostId, from: instance.deployment, to: deployment });
        return { instance: updated, previous: instance.deployment };
      } catch (error) {
        const reported = known(error, 'REMOTE_DEPLOYMENT_CHANGE_FAILED');
        this.audit('warn', 'remote.instance.deployment_change_failed', { instanceId: id, hostId: instance.hostId, code: reported.code });
        throw reported;
      }
    });
  }

  // After an interrupted start CONTROL does not know whether a process exists. This looks for a core of
  // this instance on the server and adopts it, or records that there is none.
  async recover(id) {
    return this.#operation(id, 'recovered', async instance => {
      const saved = await this.state.read(id);
      if (!saved || !saved.recoveryBlocked) fail('REMOTE_NOTHING_TO_RECOVER');
      return this.#withServer(instance.hostId, async context => {
        if (isDocker(instance)) return this.#recoverContainer(instance, saved, context);
        const found = await this.#coreProcesses(instance, context);
        await this.#sweepRconFiles(instance, context.session);
        if (found.length > 1) fail('REMOTE_RECOVERY_AMBIGUOUS');
        if (!found.length) return this.state.write(id, { ...saved, status: 'STOPPED', pid: null, createdAt: null, recoveryBlocked: false, exitReason: null });
        return this.state.write(id, { ...saved, status: 'RUNNING', pid: found[0].pid, createdAt: found[0].createdAt, recoveryBlocked: false, exitReason: null });
      });
    });
  }

  // Block 18b: the saved state only, without a connection (e.g. to refuse an RCON password change while active).
  async savedRuntime(id) {
    this.#requireState();
    this.instances.get(id);
    return (await this.state.read(id)) || { ...IDLE };
  }

  // Read-only: no lock. While an operation is running the saved state is returned without looking at the server.
  async status(id) {
    this.#requireState();
    const instance = this.instances.get(id);
    const saved = await this.state.read(id);
    if (!saved || !ACTIVE.includes(saved.status)) return { instance, runtime: saved || { ...IDLE } };
    if (this.#busy.has(id)) return { instance, runtime: saved, busy: true };
    return this.#withServer(instance.hostId, async context => {
      const { runtime, process } = await this.#reconcile(instance, saved, context);
      if (process === 'GONE') await this.#sweepRconFiles(instance, context.session); // the run that read the file is over
      return { instance, runtime };
    });
  }

  // All instances, one connection per host and only for hosts that have an active instance.
  async statusAll() {
    this.#requireState();
    const entries = [];
    for (const instance of this.instances.list()) {
      try { entries.push({ instance, saved: await this.state.read(instance.id) }); }
      catch (error) { entries.push({ instance, error: error.code || 'REMOTE_STATE_INVALID' }); }
    }
    const hostsNeeded = [...new Set(entries.filter(entry => entry.saved && ACTIVE.includes(entry.saved.status) && !this.#busy.has(entry.instance.id)).map(entry => entry.instance.hostId))];
    const contexts = new Map(), errors = new Map();
    for (const hostId of hostsNeeded) {
      try {
        const { session, uid, gid } = await this.hosts.connect(hostId);
        const adapter = await createRemoteLinuxAdapter(session, { uid, gid });
        contexts.set(hostId, { session, adapter, uid, gid });
      } catch (error) { errors.set(hostId, error.code || 'REMOTE_CONNECT_FAILED'); }
    }
    try {
      const result = [];
      for (const { instance, saved, error } of entries) {
        if (error) { result.push({ instance, runtime: null, error }); continue; }
        if (!saved || !ACTIVE.includes(saved.status)) { result.push({ instance, runtime: saved || { ...IDLE } }); continue; }
        const context = contexts.get(instance.hostId);
        if (!context) { result.push({ instance, runtime: saved, error: errors.get(instance.hostId) || 'REMOTE_OPERATION_BUSY' }); continue; }
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (process === 'GONE') await this.#sweepRconFiles(instance, context.session); // as in status()
        result.push({ instance, runtime });
      }
      return result;
    } finally { for (const { session } of contexts.values()) session.close(); }
  }

  // The process, and what the server itself answers to a getinfo.
  async health(id) {
    this.#requireState();
    const instance = this.instances.get(id);
    if (this.#busy.has(id)) return { process: 'UNKNOWN', getinfo: 'SKIPPED', busy: true }; // A4-3
    const saved = await this.state.read(id);
    if (!saved || !ACTIVE.includes(saved.status)) return { process: 'GONE', getinfo: 'SKIPPED' };
    return this.#withServer(instance.hostId, async context => {
      const { process } = await this.#reconcile(instance, saved, context);
      if (process !== 'ALIVE') return { process, getinfo: 'SKIPPED' };
      const probe = await context.session.exec(getinfoProbeCommand(instance.port), { timeoutMs: 8000 });
      if (probe.code === 3 && !probe.stdout.length) return { process, getinfo: 'NO_TOOL' };
      const packet = parsePacket(probe.stdout);
      if (packet?.type !== 'infoResponse') return { process, getinfo: 'NO_ANSWER' };
      const fields = parseInfoResponse(packet.body);
      return { process, getinfo: 'OK', hostname: infoText(fields.hostname), map: infoText(fields.mapname), players: Number(fields.clients ?? 0), maxPlayers: Number(fields.sv_maxclients ?? 0) };
    });
  }

  // ---- logs ------------------------------------------------------------------------------------------------
  // At most `limit` bytes of each stream. The run is the current or the last one; secrets are blacked out.
  async logs(id, { limit = 65536 } = {}) {
    this.#requireState();
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_BYTES) fail('REMOTE_ARGUMENT_INVALID');
    const instance = this.instances.get(id);
    const saved = await this.state.read(id);
    if (!saved?.runId) return { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, console: '', consoleTruncated: false };
    try {
      return await this.#withServer(instance.hostId, async ({ adapter, filesystem, session }) => {
        const output = isDocker(instance) ? await this.#containers({ session }).readOutput(saved.containerId ?? null, limit) : await adapter.readOutput(instance.home, saved.runId, limit);
        const consoleLog = await this.#tail(`${instance.home}/main/qconsole.log`, limit, filesystem);
        return {
          stdout: redactRuntimeOutput(output.stdout), stderr: redactRuntimeOutput(output.stderr),
          stdoutTruncated: output.stdoutTruncated, stderrTruncated: output.stderrTruncated,
          console: redactRuntimeOutput(consoleLog.text), consoleTruncated: consoleLog.truncated,
        };
      });
    } catch (error) { throw known(error, 'REMOTE_LOGS_FAILED'); }
  }

  async #tail(file, limit, filesystem) {
    const empty = { text: '', truncated: false };
    let handle;
    try {
      const before = await filesystem.lstat(file);
      if (!before.isFile() || before.nlink !== 1) return empty; // a link or a second name is not followed
      handle = await filesystem.open(file, 'r');
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) return empty;
      const wanted = Math.min(Math.max(1, limit | 0), MAX_LOG_BYTES); // never more than the fixed maximum
      const buffer = Buffer.alloc(Math.min(wanted, opened.size)), start = Math.max(0, opened.size - wanted);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return { text: boundedTail(buffer.subarray(0, filled), limit), truncated: opened.size > limit };
    } catch (error) {
      if (error.code === 'ENOENT') return empty;
      throw error;
    } finally { await handle?.close(); }
  }

  // ---- config ----------------------------------------------------------------------------------------------
  async readConfig(id) {
    const instance = this.instances.get(id);
    return this.#withServer(instance.hostId, async context => {
      const { buffer, text } = await this.#configFile(instance, context);
      return { text, sha256: sha256Of(buffer), bytes: buffer.length };
    });
  }

  async #guarded(id, event, action) {
    const instance = this.instances.get(id);
    return this.#exclusive(id, async () => {
      try {
        const result = await action(instance);
        this.audit('info', `remote.instance.${event}`, { instanceId: id, hostId: instance.hostId });
        return result;
      } catch (error) {
        const reported = known(error, `REMOTE_${event.toUpperCase()}_FAILED`);
        this.audit('warn', `remote.instance.${event}_failed`, { instanceId: id, hostId: instance.hostId, code: reported.code });
        throw reported;
      }
    });
  }
  #requireBackups() { if (!this.backupRoot) fail('REMOTE_BACKUP_UNAVAILABLE'); }

  // Replaces the config on the server: the new text goes to a temporary file first and takes the place of
  // the old one in one step; the old one is kept as a backup. Only while the instance is stopped.
  async writeConfig(id, input) {
    this.#requireState(); this.#requireBackups();
    if (!input || typeof input !== 'object' || typeof input.text !== 'string' || typeof input.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedSha256)) fail('REMOTE_ARGUMENT_INVALID');
    return this.#guarded(id, 'config_written', async instance => {
      const bytes = Buffer.from(input.text, 'utf8');
      if (!input.text.trim() || bytes.length > MAX_CONFIG_BYTES || CONTROL.test(input.text)) throw invalidConfig();
      validateManagedConfigText(input.text, instance);
      return this.#withServer(instance.hostId, async context => {
        await this.#assertStopped(instance, context.adapter, context.session);
        const current = await this.#configFile(instance, context, { strict: false }); // a damaged config can be replaced
        if (sha256Of(current.buffer) !== input.expectedSha256) fail('REMOTE_CONFIG_CONFLICT');
        const backup = await this.#saveBackup(instance, current.buffer, 'config.change');
        await this.#replaceConfig(instance, context, bytes);
        return { sha256: sha256Of(bytes), backupId: backup.backupId };
      });
    });
  }
  async #replaceConfig(instance, { files }, bytes) {
    const file = `${instance.home}/main/server.cfg`, temporary = `${instance.home}/main/.server.cfg.${crypto.randomUUID()}.tmp`;
    await files.writeFileExclusive(temporary, bytes, { mode: 0o600 });
    try { await files.replace(temporary, file); }
    catch (error) { await files.unlink(temporary).catch(() => {}); throw error; }
  }

  // ---- backup and restore ------------------------------------------------------------------------------------
  // On this PC, per instance: server.cfg and the instance record, with a manifest of hashes. Not the game data,
  // not the logs, not the core.
  async #saveBackup(instance, configBuffer, action = 'manual') {
    const createdAt = new Date();
    const backupId = `${createdAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(4).toString('hex')}`;
    const directory = path.join(this.backupRoot, instance.id, BACKUP_ID.exec(backupId)[0]); // the whole ID matched above
    const contents = { 'server.cfg': configBuffer, 'instance.json': Buffer.from(JSON.stringify(instance, null, 2)) };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const files = BACKUP_FILES.map(name => ({ name, sha256: sha256Of(contents[name]), bytes: contents[name].length }));
    for (const name of BACKUP_FILES) await fs.writeFile(path.join(directory, name), contents[name], { flag: 'wx', mode: 0o600 });
    // core.previousSha256: the core a core update keeps as .previous (the one in place now).
    const manifest = { version: 1, instanceId: instance.id, backupId, action, createdAt: createdAt.toISOString(), core: { version: instance.core.version, sha256: instance.core.sha256, previousSha256: action === 'core.update' ? instance.core.sha256 : null }, files };
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return { backupId, files };
  }

  // Reads a backup from this PC and proves it is whole before anything is done with it.
  async #verifiedBackup(instance, backupId) {
    if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) throw invalidBackup();
    const directory = path.join(this.backupRoot, instance.id, backupId);
    await fs.lstat(directory).catch(error => { throw error.code === 'ENOENT' ? Object.assign(new Error('REMOTE_BACKUP_NOT_FOUND'), { code: 'REMOTE_BACKUP_NOT_FOUND' }) : error; });
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
      const names = Array.isArray(manifest?.files) ? manifest.files.map(entry => entry?.name).sort().join() : '';
      if (manifest?.version !== 1 || manifest.instanceId !== instance.id || manifest.backupId !== backupId || !isoTime(manifest.createdAt) || names !== [...BACKUP_FILES].sort().join()) throw invalidBackup();
      // Block 21 fields; backups written before 4.18.27 have neither.
      if (manifest.action !== undefined && !BACKUP_ACTIONS.includes(manifest.action)) throw invalidBackup();
      const previousSha256 = manifest.core?.previousSha256;
      if (previousSha256 !== undefined && previousSha256 !== null && !/^[0-9a-f]{64}$/.test(previousSha256)) throw invalidBackup();
      const contents = {};
      for (const entry of manifest.files) {
        if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isInteger(entry.bytes)) throw invalidBackup();
        // only the two fixed names are ever opened, whatever the manifest says (the name list was compared above)
        const name = BACKUP_FILES.find(candidate => candidate === entry.name);
        if (!name) throw invalidBackup();
        const file = path.resolve(directory, name);
        if (!file.startsWith(path.resolve(this.backupRoot) + path.sep)) throw invalidBackup(); // stays inside the backup root
        const bytes = await fs.readFile(file);
        if (bytes.length !== entry.bytes || sha256Of(bytes) !== entry.sha256) throw invalidBackup();
        contents[name] = bytes;
      }
      return { manifest, config: contents['server.cfg'] };
    } catch (error) { throw error.code === 'REMOTE_BACKUP_INVALID' ? error : invalidBackup(); }
  }

  async createBackup(id) {
    this.#requireBackups();
    return this.#guarded(id, 'backed_up', instance => this.#withServer(instance.hostId, async context => {
      const current = await this.#configFile(instance, context, { strict: false });
      return this.#saveBackup(instance, current.buffer);
    }));
  }

  async listBackups(id) {
    this.#requireBackups();
    const instance = this.instances.get(id);
    const names = await fs.readdir(path.join(this.backupRoot, instance.id)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const entries = [];
    for (const backupId of names.filter(name => BACKUP_ID.test(name)).sort().reverse()) {
      try {
        const { manifest } = await this.#verifiedBackup(instance, backupId);
        entries.push({ backupId, action: manifest.action || null, createdAt: manifest.createdAt, files: manifest.files, invalid: false });
      } catch { entries.push({ backupId, action: null, createdAt: null, files: [], invalid: true }); }
    }
    return entries;
  }

  // Puts the config of a backup back. The backup is verified on this PC first; the config has to pass the same
  // rules as a write; what it replaces is kept as a new backup. Only while the instance is stopped.
  async restoreBackup(id, backupId) {
    this.#requireState(); this.#requireBackups();
    if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) fail('REMOTE_ARGUMENT_INVALID');
    return this.#guarded(id, 'restored', async instance => {
      const { config } = await this.#verifiedBackup(instance, backupId);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(config);
      if (!text.trim() || CONTROL.test(text)) throw invalidConfig();
      validateManagedConfigText(text, instance);
      return this.#withServer(instance.hostId, async context => {
        await this.#assertStopped(instance, context.adapter, context.session);
        const safety = await this.#saveBackup(instance, (await this.#configFile(instance, context, { strict: false })).buffer, 'restore.safety');
        await this.#replaceConfig(instance, context, config);
        return { sha256: sha256Of(config), backupId, safetyBackupId: safety.backupId };
      });
    });
  }

  // ---- network exposure ------------------------------------------------------------------------------------
  // Loopback is the default; PUBLIC needs the confirmation phrase of lib/instance-network.mjs and is only
  // changed while the server cannot be running. The new bind addresses are used by the next start.
  async changeNetwork(id, input) {
    this.#requireState();
    const network = networkChangeRequest(input); // INSTANCE_NETWORK_INVALID / INSTANCE_NETWORK_CONFIRMATION_REQUIRED
    return this.#guarded(id, 'network_changed', async instance => {
      const saved = await this.state.read(id);
      if (saved && (ACTIVE.includes(saved.status) || saved.recoveryBlocked)) fail('REMOTE_INSTANCE_RUNNING');
      const updated = await this.instances.setNetwork(id, network);
      return { previous: instance.network, network: updated.network };
    });
  }
}
