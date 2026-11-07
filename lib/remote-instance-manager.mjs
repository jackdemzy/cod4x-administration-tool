import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRemoteLinuxAdapter } from './remote-linux-runtime.mjs';
import { createRemoteFiles } from './remote-files.mjs';
import { assertRemoteBaseGame } from './remote-basegame.mjs';
import { makeDirectoriesCommand, diskFreeCommand, parseDiskFree, recoverHomeCommand, startCoreCommand, parsePid, getinfoProbeCommand } from './remote-commands.mjs';
import { assertLinuxInstanceOwnership } from './linux-runtime-adapter.mjs';
import { bindAddresses } from './instance-network.mjs';
import { parsePacket, parseInfoResponse } from './rcon-protocol.mjs';
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
const MAX_CONFIG_BYTES = 256 * 1024;
const IDLE = Object.freeze({ status: 'STOPPED', runId: null, pid: null, createdAt: null, startedAt: null, recoveryBlocked: false, exitReason: null });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
const PASS_THROUGH = new Set(['RUNTIME_ROOT_BLOCKED', 'INSTANCE_PROCESS_IDENTITY_BLOCKED', 'INSTANCE_CONFIG_INVALID']);
const known = (error, fallback) => (typeof error?.code === 'string' && (error.code.startsWith('REMOTE_') || error.code.startsWith('VAULT_') || PASS_THROUGH.has(error.code))
  ? error : Object.assign(new Error(fallback), { code: fallback, cause: error?.code }));

export class RemoteInstanceManager {
  #busy = new Set();
  constructor({ instances, hosts, audit = () => {}, state = null, uploadChunkBytes = 256 * 1024, pollMs = 250, startConfirmMs = 5000, stopGraceMs = 10_000, killWaitMs = 5000 }) {
    Object.assign(this, { instances, hosts, audit, state, uploadChunkBytes, pollMs, startConfirmMs, stopGraceMs, killWaitMs });
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
  async #reconcile(instance, saved, context) {
    if (!saved) return { runtime: { ...IDLE }, process: 'GONE' };
    if (!ACTIVE.includes(saved.status)) return { runtime: saved, process: 'GONE' };
    if (saved.pid === null) return { runtime: saved, process: 'UNKNOWN' };
    const info = await context.adapter.inspectProcess(saved.pid);
    const process = this.#identify(instance, saved, info, context);
    if (process === 'ALIVE') {
      // a start that was interrupted after the pid was known: it is running, so it is recorded as such
      if (saved.status === 'STARTING') return { runtime: await this.state.write(instance.id, { ...saved, status: 'RUNNING', createdAt: info.createdAt, recoveryBlocked: false }), process };
      return { runtime: saved, process };
    }
    if (process === 'GONE' || process === 'NOT_OURS') {
      const planned = saved.status === 'STOPPING';
      const runtime = await this.state.write(instance.id, { ...saved, status: planned ? 'STOPPED' : 'FAILED', pid: null, createdAt: null, recoveryBlocked: false, exitReason: planned ? null : 'PROCESS_GONE' });
      return { runtime, process: 'GONE' };
    }
    return { runtime: saved, process };
  }

  // server.cfg as a plain private file of reasonable size that did not change while it was read
  async #checkedConfig(instance, { files, filesystem }) {
    const file = `${instance.home}/main/server.cfg`;
    const invalid = () => Object.assign(new Error('INSTANCE_CONFIG_INVALID'), { code: 'INSTANCE_CONFIG_INVALID' });
    const inspect = async () => {
      const info = await filesystem.lstat(file).catch(error => { throw error.code === 'ENOENT' ? invalid() : error; });
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_CONFIG_BYTES) throw invalid();
      return info;
    };
    const before = await inspect();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await files.readFile(file, { maxBytes: MAX_CONFIG_BYTES })); }
    catch (error) { throw error.code === 'REMOTE_FILE_TOO_LARGE' || error instanceof TypeError ? invalid() : error; }
    const after = await inspect();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw invalid();
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw invalid();
    validateManagedConfigText(text, instance); // INSTANCE_CONFIG_INVALID
  }

  // Everything is checked before the first state is written, so a refused start leaves no trace.
  async #launch(instance, context) {
    const { session, adapter, files, filesystem, uid, gid } = context;
    await adapter.validateExecutable(instance.core.path);
    if (await files.sha256(instance.core.path) !== instance.core.sha256) fail('REMOTE_CORE_CHANGED');
    await assertRemoteBaseGame(filesystem, instance.basePath, { uid, gid });
    await this.#checkedConfig(instance, context);
    const runId = crypto.randomUUID();
    const { stdoutFile, stderrFile } = await adapter.prepareRemoteOutput(instance.home, runId);
    const bind = bindAddresses(instance.network), port = String(instance.port);
    const args = ['+set', 'dedicated', '2', '+set', 'fs_basepath', instance.basePath, '+set', 'fs_homepath', instance.home,
      '+set', 'net_port', port, '+set', 'net_ip', bind.ipv4, '+set', 'net_port6', port, '+set', 'net_ip6', bind.ipv6,
      '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'];
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
    for (const deadline = Date.now() + this.startConfirmMs; ;) {
      const info = await adapter.inspectProcess(pid);
      const process = this.#identify(instance, current, info, context);
      if (process === 'ALIVE') return this.state.write(instance.id, { ...current, status: 'RUNNING', createdAt: info.createdAt });
      if (process === 'GONE') {
        await this.state.write(instance.id, { ...current, status: 'FAILED', pid: null, exitReason: 'EXITED_ON_START' });
        throw Object.assign(new Error('REMOTE_START_FAILED'), { code: 'REMOTE_START_FAILED' });
      }
      if (Date.now() >= deadline) {
        await this.state.write(instance.id, { ...current, recoveryBlocked: true });
        throw Object.assign(new Error('REMOTE_RECOVERY_BLOCKED'), { code: 'REMOTE_RECOVERY_BLOCKED' });
      }
      await sleep(this.pollMs);
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
  async #stopRunning(instance, runtime, { adapter }) {
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

  start(id) {
    return this.#operation(id, 'started', async instance => {
      const saved = await this.state.read(id);
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (process === 'ALIVE') fail('REMOTE_ALREADY_RUNNING');
        if (runtime.recoveryBlocked || (process === 'UNKNOWN' && ACTIVE.includes(runtime.status))) fail('REMOTE_RECOVERY_BLOCKED');
        return this.#launch(instance, context);
      });
    });
  }

  stop(id) {
    return this.#operation(id, 'stopped', async instance => {
      const saved = await this.state.read(id);
      if (!saved || !ACTIVE.includes(saved.status)) return saved || { ...IDLE }; // nothing to stop, no connection needed
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (process === 'UNKNOWN') fail('REMOTE_RECOVERY_BLOCKED');
        if (process === 'GONE') return this.state.write(id, { ...runtime, status: 'STOPPED', pid: null, createdAt: null, recoveryBlocked: false });
        return this.#stopRunning(instance, runtime, context);
      });
    });
  }

  restart(id) {
    return this.#operation(id, 'restarted', async instance => {
      const saved = await this.state.read(id);
      return this.#withServer(instance.hostId, async context => {
        const { runtime, process } = await this.#reconcile(instance, saved, context);
        if (runtime.recoveryBlocked || process === 'UNKNOWN') fail('REMOTE_RECOVERY_BLOCKED');
        if (process === 'ALIVE') await this.#stopRunning(instance, runtime, context);
        return this.#launch(instance, context);
      });
    });
  }

  // After an interrupted start CONTROL does not know whether a process exists. This looks for a core of
  // this instance on the server and adopts it, or records that there is none.
  recover(id) {
    return this.#operation(id, 'recovered', async instance => {
      const saved = await this.state.read(id);
      if (!saved || !saved.recoveryBlocked) fail('REMOTE_NOTHING_TO_RECOVER');
      return this.#withServer(instance.hostId, async context => {
        const { adapter, filesystem } = context;
        const found = [];
        for (const name of await filesystem.readdir('/proc')) {
          if (!/^\d+$/.test(name)) continue;
          const exe = await filesystem.readlink(`/proc/${name}/exe`).catch(() => null);
          if (exe !== instance.core.path) continue;
          const info = await adapter.inspectProcess(Number(name));
          if (this.#identify(instance, { createdAt: null }, info, context) === 'ALIVE') found.push({ pid: Number(name), createdAt: info.createdAt });
        }
        if (found.length > 1) fail('REMOTE_RECOVERY_AMBIGUOUS');
        if (!found.length) return this.state.write(id, { ...saved, status: 'STOPPED', pid: null, createdAt: null, recoveryBlocked: false, exitReason: null });
        return this.state.write(id, { ...saved, status: 'RUNNING', pid: found[0].pid, createdAt: found[0].createdAt, recoveryBlocked: false, exitReason: null });
      });
    });
  }

  // Read-only: no lock. While an operation is running the saved state is returned without looking at the server.
  async status(id) {
    this.#requireState();
    const instance = this.instances.get(id);
    const saved = await this.state.read(id);
    if (!saved || !ACTIVE.includes(saved.status)) return { instance, runtime: saved || { ...IDLE } };
    if (this.#busy.has(id)) return { instance, runtime: saved, busy: true };
    return this.#withServer(instance.hostId, async context => ({ instance, runtime: (await this.#reconcile(instance, saved, context)).runtime }));
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
        result.push({ instance, runtime: (await this.#reconcile(instance, saved, context)).runtime });
      }
      return result;
    } finally { for (const { session } of contexts.values()) session.close(); }
  }

  // The process, and what the server itself answers to a getinfo.
  async health(id) {
    this.#requireState();
    const instance = this.instances.get(id);
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
      return { process, getinfo: 'OK', hostname: fields.hostname ?? null, map: fields.mapname ?? null, players: Number(fields.clients ?? 0), maxPlayers: Number(fields.sv_maxclients ?? 0) };
    });
  }
}
