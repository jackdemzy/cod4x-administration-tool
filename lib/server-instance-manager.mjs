import fs from 'node:fs/promises';
import path from 'node:path';
import { readInstanceConsoleLog } from './instance-console-log.mjs';
import { removeLaunchFile, sweepLaunchFiles, waitExecuted, writeLaunchFile } from './launch-secrets-file.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { CONFIG_SCHEMA, CONFIG_SECTIONS } from './config-engine.mjs';
import { bindAddresses, networkChangeRequest } from './instance-network.mjs';
import { pluginLaunchArguments, discoverPlugins, describePlugins, installPluginFile, retirePluginFile, normalizePluginRecords, validPluginName, classifyPluginLog, parsePluginInfoVersion } from './plugin-manager.mjs';
import { recordConfigActivation, readConfigActivation, describeConfigActivation } from './config-activation.mjs';
import { planB3Integration, normalizeB3Integration, KNOWN_B3HIDE_HASHES } from './b3-integration.mjs';
import { guardedChange } from './restore-guard.mjs';
import { collectInstanceParts, restoreInstanceParts, pointBringsCode, PARTS_BY_ACTION } from './instance-restore-points.mjs';

export const B3_DATABASE_CONFIRMATION = 'B3-DATENBANK ZURÜCKSETZEN';
const CORE_VERSIONS = ['21.2', '21.3', '21.4', '21.5'];

const B3HIDE = 'b3hide';
const isB3hide = name => String(name).toLowerCase() === B3HIDE;
const b3Fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };

// CoD4x splits its command line at '+' (qcommon_parsecmdline.c) and the vault
// already excludes '"', ';' and '\'. Anything else would not arrive intact.
function rconLaunchValue(buffer) {
  const value = buffer.toString('latin1');
  if (!/^[\x21-\x7e]{8,128}$/.test(value) || /[+";\\]/.test(value)) throw Object.assign(new Error('RCON_PASSWORD_UNSUPPORTED'), { code: 'RCON_PASSWORD_UNSUPPORTED' });
  return value;
}
// sv_main.c: sv_authtoken is a 32 character token (host migration requires
// exactly 32). The vault already enforces [A-Za-z0-9]{32}; recheck fail-closed.
function masterLaunchValue(buffer) {
  const value = buffer.toString('latin1');
  if (!/^[A-Za-z0-9]{32}$/.test(value)) throw Object.assign(new Error('MASTER_TOKEN_UNSUPPORTED'), { code: 'MASTER_TOKEN_UNSUPPORTED' });
  return value;
}
const KINDS = ['rcon', 'master'];

export class ServerInstanceManager {
  constructor({ store, runtimeFactory, legacyRuntime = null, credentialService = null, rconService = null, masterService = null, b3Service = null, onCredentialChanged = () => {}, launchFileWaitMs = 15_000, restorePoints = null, b3Database = null, audit = () => {}, allowedCoreVersions = CORE_VERSIONS }) {
    this.store = store;
    this.restorePoints = restorePoints;
    this.b3Database = b3Database;
    this.audit = audit;
    this.allowedCoreVersions = allowedCoreVersions;
    this.launchFileWaitMs = launchFileWaitMs;
    this.runtimeFactory = runtimeFactory;
    this.legacyRuntime = legacyRuntime;
    this.runtimes = new Map();
    this.operations = new Set();
    this.configEngine = new ConfigEngineStorage();
    this.credentialService = credentialService;
    this.rconService = rconService;
    this.masterService = masterService;
    this.b3Service = b3Service;
    this.onCredentialChanged = onCredentialChanged;
    this.launches = new Map();
  }
  // Block 16: one plan for the server launch, the B3 start and the UI.
  // forLaunch skips the B3 source check (it spawns Python) because the core
  // launch only depends on b3hide, prefix and level.
  async b3IntegrationPlan(id, { forLaunch = false } = {}) {
    const instance = this.store.get(id);
    const states = describePlugins(normalizePluginRecords(instance.plugins, instance.platform), await discoverPlugins(instance));
    const b3hide = states.find(state => isB3hide(state.name)) || null;
    let credentialsPresent = { rcon: false, b3authLevels: [], locked: true };
    if (this.credentialService) {
      const status = await this.credentialService.instanceStatus(id);
      const locked = !status.initialized || status.locked;
      credentialsPresent = { rcon: status.rcon?.configured === true, b3authLevels: status.b3auth?.levels || [], locked };
    }
    let authPluginPresent = true, b3CommandPrefix = null;
    if (!forLaunch && instance.b3Integration?.hideCommands) {
      const dependencies = this.b3Service?.dependencies ? await this.b3Service.dependencies() : null;
      const row = dependencies?.results?.find(entry => entry.id === 'b3hide-auth');
      const prefixMismatch = row?.status === 'INCOMPATIBLE' && row.detail === 'B3_COMMAND_PREFIX_MISMATCH';
      authPluginPresent = row?.status === 'OK' || prefixMismatch;
      // Fail closed: a mismatch without a readable prefix still blocks.
      if (prefixMismatch) b3CommandPrefix = row.found ?? '';
    }
    const plan = planB3Integration({ settings: instance.b3Integration, b3hideState: b3hide?.state || null, authPluginPresent, b3CommandPrefix, credentialsPresent });
    return { plan, b3hide, instance };
  }
  async b3Integration(id) {
    const { plan, b3hide, instance } = await this.b3IntegrationPlan(id);
    const knownHash = Boolean(b3hide?.sha256) && b3hide.sha256 === KNOWN_B3HIDE_HASHES[instance.platform];
    return { settings: plan.settings, plan, b3hide: b3hide ? { state: b3hide.state, sha256: b3hide.sha256, registered: b3hide.registered } : null, knownHash, launchedWith: this.launchedWith(id) };
  }
  launchedWith(id) { return this.launches.get(id) || null; }
  // Server and B3 must be stopped; the registered b3hide record follows the switch.
  async configureB3Integration(id, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'hideCommands,hideLevel,prefix' || typeof input.hideCommands !== 'boolean') b3Fail('B3_INTEGRATION_INVALID');
    const settings = normalizeB3Integration(input);
    // While the B3 service holds the instance, no B3 start can begin (and a
    // start that already captured its plan makes this fail), so a running start
    // never launches with settings older than the ones saved here.
    const b3Idle = this.b3Service?.whileIdle ? action => this.b3Service.whileIdle(id, action) : action => action();
    return this.exclusive(id, () => b3Idle(async () => {
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy || (this.b3Service && !this.b3Service.whileIdle && await this.b3Service.isRunning(id))) b3Fail('B3_INTEGRATION_BUSY');
      const instance = this.store.get(id);
      const records = normalizePluginRecords(instance.plugins, instance.platform);
      const dvars = { b3Prefix: settings.prefix, b3Hide: '1', b3HideLvl: String(settings.hideLevel) };
      const plugins = records.some(record => isB3hide(record.name)) ? records.map(record => !isB3hide(record.name) ? record
        : settings.hideCommands ? { ...record, enabled: true, config: dvars } : { ...record, enabled: false }) : null;
      // Validate the plugin records (PLUGIN_LIMIT) before anything is saved, so a
      // refused switch never leaves hideCommands persisted without b3hide.
      if (plugins) normalizePluginRecords(plugins, instance.platform);
      await this.store.setB3Integration(id, settings);
      if (plugins) await this.store.setPlugins(id, plugins);
      return { settings, plan: (await this.b3IntegrationPlan(id)).plan };
    }));
  }
  // Only configured credentials are transferred; a locked vault starts the server
  // without RCON / master token instead of blocking it (the server runs independently).
  async credentialProvisioning(id) {
    if (!this.credentialService) return { rcon: 'VAULT_UNAVAILABLE', master: 'VAULT_UNAVAILABLE' };
    const status = await this.credentialService.instanceStatus(id);
    return Object.fromEntries(KINDS.map(kind => {
      const configured = status[kind]?.configured;
      return [kind, !status.initialized || configured === false || configured === undefined ? 'NOT_CONFIGURED' : configured === true ? 'CONFIGURED' : 'VAULT_LOCKED'];
    }));
  }
  async rconProvisioning(id) { return (await this.credentialProvisioning(id)).rcon; }
  async load() {
    await this.store.load();
    for (const instance of this.store.list()) await this.runtime(instance.id);
  }
  async runtime(id) {
    const instance = this.store.get(id);
    if (!this.runtimes.has(id)) {
      const configuration = { instanceId: id, platform: instance.platform, target: instance.homePath, executablePath: instance.serverCore.executablePath, cod4x: instance.serverCore.version, baseGamePath: instance.basePath, filesystemHomePath: instance.homePath };
      const manager = this.runtimeFactory(instance, { stateFile: path.join(instance.homePath, 'logs', 'runtime-state.json'), seedState: configuration, fixedConfiguration: configuration, ownership: { homePath: instance.homePath, port: instance.port } });
      // Cache readiness as well as manager so competing readers cannot load twice.
      this.runtimes.set(id, Promise.resolve(manager.loadRuntimeState()).then(() => manager));
    }
    return this.runtimes.get(id);
  }
  async exclusive(id, action) {
    this.store.get(id);
    if (this.operations.has(id)) throw Object.assign(new Error('Für diese Instanz läuft bereits ein Vorgang.'), { code: 'INSTANCE_OPERATION_BUSY' });
    this.operations.add(id);
    try { return await action(); } finally { this.operations.delete(id); }
  }
  async list() {
    const values = [];
    for (const instance of this.store.list()) {
      const runtime = await this.runtime(instance.id);
      let inspectionError = null;
      try { await runtime.reconcileRuntimeState(); } catch (error) { inspectionError = error.message; }
      values.push({ ...instance, runtime: runtime.state, consoleLog: await readInstanceConsoleLog(instance.homePath), inspectionError });
    }
    return structuredClone(values);
  }
  async status(id) {
    const runtime = await this.runtime(id);
    await runtime.reconcileRuntimeState();
    const instance = this.store.get(id);
    return { ...instance, runtime: structuredClone(runtime.state), consoleLog: await readInstanceConsoleLog(instance.homePath) };
  }
  async create(input) { const instance = await this.store.create(input); await this.runtime(instance.id); return this.status(instance.id); }
  async clone(id, input) { const instance = await this.store.clone(id, input); await this.runtime(instance.id); return this.status(instance.id); }
  async launch(id, restart = false) {
    return this.exclusive(id, async () => {
      await this.assertNoRecovery(id);
      const instance = this.store.get(id);
      const runtime = await this.runtime(id);
      await this.store.validatePaths(instance);
      // Validate before a restart can stop the currently owned process.
      const configuration = await this.configEngine.read(instance);
      const legacyHome = this.legacyRuntime?.state.filesystemHomePath;
      if (this.legacyRuntime?.busy && legacyHome && path.resolve(legacyHome).toLowerCase() === instance.homePath.toLowerCase()) throw Object.assign(new Error('Homepath wird von der bisherigen Einzel-Runtime verwendet.'), { code: 'INSTANCE_LEGACY_HOME_BUSY' });
      // Vault state and plugin integrity are checked before a restart can stop the running process.
      const provisioning = await this.credentialProvisioning(id);
      // Block 16: with "hide B3 commands" on, b3hide is loaded with the plan's
      // dvars whatever its record says; b3hide/prefix/level blockers stop here.
      const { plan } = await this.b3IntegrationPlan(id, { forLaunch: true });
      const launchBlocker = plan.blockers.find(entry => entry.code.startsWith('B3HIDE_'));
      if (launchBlocker) b3Fail(launchBlocker.code, { blockers: plan.blockers });
      const launchInstance = !plan.enabled ? instance : { ...instance, plugins: normalizePluginRecords(instance.plugins, instance.platform)
        .map(record => isB3hide(record.name) ? { ...record, enabled: true, config: plan.b3hide } : record) };
      const plugins = await pluginLaunchArguments(launchInstance);
      // On restart the owned process still holds its UDP port; check after it stops.
      if (restart) await runtime.stopRuntime('instance-restart');
      await this.store.checkPort(instance.port);
      // Loopback unless this instance was explicitly switched to public exposure.
      const bind = bindAddresses(instance.network);
      const network = ['+set', 'net_port', String(instance.port), '+set', 'net_ip', bind.ipv4, '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', bind.ipv6];
      const tail = [...plugins.args, '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'];
      const start = args => runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: instance.serverCore.version, platform: instance.platform, args });
      let state = null;
      // A2-1 (security audit 4.18.26): secrets reach the core through a private +exec file.
      const mainDir = path.join(instance.homePath, 'main');
      await sweepLaunchFiles(mainDir);
      // A2-2: homes created before 4.18.26 were 0755; logs in them can hold typed B3 passwords.
      if (process.platform !== 'win32') await fs.chmod(instance.homePath, 0o700);
      // Whether the core confirmed reading the launch file ("execing <file>"); without that the
      // transfer is UNKNOWN, never PROVISIONED (PR #46 review).
      let executed = true;
      if (KINDS.some(kind => provisioning[kind] === 'CONFIGURED')) {
        let launchFile = null;
        try {
          // Short-lived transfer: the vault buffer is wiped when the scope ends;
          // runtime history/state only ever see the file name.
          await this.credentialService.withRuntimeCredentials(id, async (credentials, signal) => {
            const lines = [];
            if (provisioning.rcon === 'CONFIGURED') {
              if (!credentials.rcon) throw Object.assign(new Error('RCON_NOT_CONFIGURED'), { code: 'RCON_NOT_CONFIGURED' });
              lines.push(`set rcon_password "${rconLaunchValue(credentials.rcon)}"`);
            }
            if (provisioning.master === 'CONFIGURED') {
              if (!credentials.master) throw Object.assign(new Error('MASTER_TOKEN_NOT_CONFIGURED'), { code: 'MASTER_TOKEN_NOT_CONFIGURED' });
              lines.push(`set sv_authtoken "${masterLaunchValue(credentials.master)}"`);
            }
            launchFile = await writeLaunchFile(mainDir, Buffer.from(`${lines.join('\n')}\n`, 'latin1'));
            if (signal.aborted) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
            state = await start([...network, '+exec', launchFile, ...tail]);
          });
        } catch (error) {
          // A vault lock after spawn cannot revoke what the process received.
          if (!state) throw error;
        } finally {
          if (launchFile) {
            executed = state ? await waitExecuted(async () => { await runtime.reconcileRuntimeState(); return runtime.state.output?.stdout || ''; }, launchFile, { timeoutMs: this.launchFileWaitMs }) : false;
            await removeLaunchFile(mainDir, launchFile);
          }
        }
      } else state = await start([...network, ...tail]);
      const transferred = kind => provisioning[kind] === 'CONFIGURED' ? (executed ? 'PROVISIONED' : 'UNKNOWN') : provisioning[kind];
      this.rconService?.recordProvisioning(id, state.runId, transferred('rcon'));
      this.masterService?.recordProvisioning(id, state.runId, transferred('master'));
      const own = this.credentialService ? await this.credentialService.instanceStatus(id).catch(() => null) : null;
      this.launches.set(id, { fingerprint: plan.fingerprint, serverFingerprint: plan.serverFingerprint, credentialDigest: own?.digest || null, runId: state.runId, b3hide: plan.enabled, at: new Date().toISOString() });
      await runtime.persistRuntimeState();
      // Missing evidence degrades to UNKNOWN activation; it never fails a started run.
      try { await recordConfigActivation(instance, { sha256: configuration.sha256, runId: state.runId, pid: state.pid }); }
      catch (error) { console.error(`[instances] config activation not recorded for ${id}: ${error.code || error.message}`); }
      return structuredClone(state);
    });
  }
  async activation(instance, sha256) {
    const runtime = await this.runtime(instance.id);
    try { await runtime.reconcileRuntimeState(); } catch { /* Inspection failure keeps the last known state. */ }
    return describeConfigActivation(await readConfigActivation(instance), runtime.state, sha256);
  }
  async stop(id) { return this.exclusive(id, async () => { const runtime = await this.runtime(id); const state = await runtime.stopRuntime('instance-manual'); await runtime.persistRuntimeState(); return structuredClone(state); }); }
  async configuration(id) {
    const instance = this.store.get(id);
    try {
      const current = await this.configEngine.read(instance);
      return { ...current, schema: CONFIG_SCHEMA, sections: CONFIG_SECTIONS, activation: await this.activation(instance, current.sha256) };
    }
    catch (error) {
      if (!['INSTANCE_CONFIG_INVALID', 'CONFIG_PARSE_INVALID', 'CONFIG_SCHEMA_INVALID'].includes(error.code)) throw error;
      // Recovery still performs the same path/file/UTF-8 checks; unsafe paths fail closed.
      const snapshot = await this.configEngine.recoverySnapshot(instance);
      if (snapshot.valid) throw error;
      return { ...snapshot, entries: [], schema: CONFIG_SCHEMA, sections: CONFIG_SECTIONS, activation: await this.activation(instance, snapshot.sha256), code: 'CONFIG_RECOVERY_REQUIRED' };
    }
  }
  async previewConfiguration(id, input) {
    return this.configEngine.preview(this.store.get(id), input);
  }
  async configurationBackups(id) {
    return this.configEngine.listBackups(this.store.get(id));
  }
  async changeConfiguration(id, input, restore = false) {
    return this.exclusive(id, async () => {
      const instance = this.store.get(id), runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Stop the instance before changing its configuration.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      await this.store.validatePaths(instance);
      return this.guardFor(id, 'config.change', {
        change: () => restore ? this.configEngine.restore(instance, input) : this.configEngine.apply(instance, input),
        // The engine re-reads after writing; a second read here proves the file on disk is the one reported.
        verify: async result => { if (result.verified !== true || (await this.configEngine.read(this.store.get(id))).sha256 !== result.sha256) throw Object.assign(new Error('CONFIG_VERIFY_FAILED'), { code: 'CONFIG_VERIFY_FAILED' }); },
      });
    });
  }
  async changeCredential(id, kind, input, remove = false) {
    return this.exclusive(id, async () => {
      const instance = this.store.get(id), runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      // The B3 database password is not used by the game server process.
      if (runtime.busy && kind !== 'b3db') throw Object.assign(new Error('Stop the instance before changing credentials.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      await this.store.validatePaths(instance);
      if (!this.credentialService) throw Object.assign(new Error('Credential service unavailable.'), { code: 'CREDENTIAL_UNAVAILABLE' });
      const result = remove ? await this.credentialService.remove(id, kind, input) : await this.credentialService.set(id, kind, input);
      // E.g. a changed b3db password clears the B3 database readiness.
      await this.onCredentialChanged(id, kind);
      return result;
    });
  }
  async changeNetwork(id, input) {
    return this.exclusive(id, async () => {
      const network = networkChangeRequest(input);
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Stop the instance before changing its network exposure.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      const instance = this.store.get(id);
      // A config that pins net_ip to the old binding would override the launch argument.
      const configuration = await this.configEngine.read(instance);
      const pinned = configuration.entries.find(entry => entry.name === 'net_ip');
      if (pinned && pinned.value !== bindAddresses(network).ipv4) throw Object.assign(new Error('Remove net_ip from server.cfg before changing the network exposure.'), { code: 'INSTANCE_NETWORK_CONFIG_PINNED' });
      const previous = instance.network;
      const updated = await this.store.setNetwork(id, network);
      return { previous, network: updated.network };
    });
  }
  // Plugin registry changes require a stopped instance, like configuration changes.
  async #stoppedPluginChange(id, action) {
    return this.exclusive(id, async () => {
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Stop the instance before changing plugins.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      const instance = this.store.get(id);
      await this.store.validatePaths(instance);
      return this.guardFor(id, 'plugin.change', { change: () => action(instance), verify: () => this.verifyPlugins(id) });
    });
  }
  // Every enabled plugin record has its file in place with the approved hash.
  async verifyPlugins(id) {
    const instance = this.store.get(id);
    const states = describePlugins(normalizePluginRecords(instance.plugins, instance.platform), await discoverPlugins(instance));
    const broken = states.find(state => state.enabled && state.state !== 'ENABLED');
    if (broken) throw Object.assign(new Error('PLUGIN_INTEGRITY_FAILED'), { code: broken.state === 'MISSING' ? 'PLUGIN_MISSING' : 'PLUGIN_INTEGRITY_FAILED' });
  }

  // ---- Block 21: restore points ------------------------------------------------------------------------------
  subject(id) { return `local:${this.store.get(id).id}`; }
  async assertNoRecovery(id) {
    if (this.restorePoints && await this.restorePoints.recovery(this.subject(id))) throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED' });
  }
  // Runs a change of a local instance through capture -> change -> verify -> rollback. The caller holds
  // the instance lock. Without a restore-point store the change runs as before (no verify, no point).
  async guardFor(id, action, { change, verify = async () => {}, actor = null }) {
    if (!this.restorePoints) return change();
    const parts = PARTS_BY_ACTION[action];
    if (!parts) throw Object.assign(new Error('RESTORE_POINT_INVALID'), { code: 'RESTORE_POINT_INVALID' });
    const { result, restorePointId } = await guardedChange({
      store: this.restorePoints, subject: this.subject(id), action, actor, audit: this.audit,
      capture: () => collectInstanceParts(this.store.get(id), parts),
      change, verify,
      rollback: point => restoreInstanceParts(this.store.get(id), point, parts, { store: this.store }),
    });
    return result && typeof result === 'object' && !Array.isArray(result) ? { ...result, restorePointId } : result;
  }
  #requireRestorePoints() { if (!this.restorePoints) throw Object.assign(new Error('RESTORE_POINT_UNAVAILABLE'), { code: 'RESTORE_POINT_UNAVAILABLE' }); }
  // Server and B3 stopped, B3 starts excluded for the duration (same rule as the B3 integration switch).
  async #stoppedAll(id, action) {
    const b3Idle = this.b3Service?.whileIdle ? fn => this.b3Service.whileIdle(id, fn) : fn => fn();
    return this.exclusive(id, () => b3Idle(async () => {
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Stop the instance first.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      return action(this.store.get(id));
    }));
  }
  // Local core change (Rafiki 2026-11-12): admin only (server.code at the route), with rollback.
  async changeCore(id, input, actor = null) {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'executablePath,version') throw Object.assign(new Error('INSTANCE_CORE_INVALID'), { code: 'INSTANCE_CORE_INVALID' });
    return this.#stoppedAll(id, async instance => {
      if (!this.allowedCoreVersions.includes(input.version)) throw Object.assign(new Error('INSTANCE_CORE_VERSION_INVALID'), { code: 'INSTANCE_CORE_VERSION_INVALID' });
      if (typeof input.executablePath === 'string' && path.resolve(input.executablePath) === instance.serverCore.executablePath && input.version === instance.serverCore.version) throw Object.assign(new Error('INSTANCE_CORE_UNCHANGED'), { code: 'INSTANCE_CORE_UNCHANGED' });
      const previous = instance.serverCore;
      const result = await this.guardFor(id, 'core.change', {
        actor,
        change: async () => ({ serverCore: (await this.store.setCore(id, { executablePath: input.executablePath, version: input.version })).serverCore }),
        verify: async () => { const current = this.store.get(id); await this.store.validatePaths(current); if (!this.allowedCoreVersions.includes(current.serverCore.version)) throw Object.assign(new Error('INSTANCE_CORE_VERSION_INVALID'), { code: 'INSTANCE_CORE_VERSION_INVALID' }); },
      });
      return { previous, ...result };
    });
  }
  async listRestorePoints(id) {
    this.#requireRestorePoints();
    const subject = this.subject(id);
    return { points: await this.restorePoints.list(subject), recovery: await this.restorePoints.recovery(subject) };
  }
  async restorePointIntegrity(id, pointId) {
    this.#requireRestorePoints();
    try { const { manifest } = await this.restorePoints.read(this.subject(id), pointId); return { pointId, valid: true, files: manifest.files.length, totalBytes: manifest.totalBytes }; }
    catch (error) { if (error.code === 'RESTORE_POINT_INVALID') return { pointId, valid: false }; throw error; }
  }
  async createRestorePoint(id, { actor = null, includeB3Database = false } = {}) {
    this.#requireRestorePoints();
    if (includeB3Database && !this.b3Database?.dumpForPoint) throw Object.assign(new Error('B3_DATABASE_NOT_READY'), { code: 'B3_DATABASE_NOT_READY' });
    return this.exclusive(id, async () => {
      const parts = await collectInstanceParts(this.store.get(id), PARTS_BY_ACTION.manual);
      if (includeB3Database) parts.refs.b3mysql = await this.b3Database.dumpForPoint(id);
      const { pointId, manifest } = await this.restorePoints.capture(this.subject(id), { action: 'manual', actor, manual: true, ...parts });
      this.audit('info', 'restore_point.created', { subject: this.subject(id), action: 'manual', restorePointId: pointId });
      return { pointId, parts: manifest.parts, totalBytes: manifest.totalBytes };
    });
  }
  // Manual restore. canCode: whether the caller holds server.code (code parts need it). The B3 database
  // is only reset with includeB3Database and the exact confirmation text (Rafiki 2026-11-12).
  async restoreRestorePoint(id, pointId, { includeB3Database = false, confirmation } = {}, { actor = null, canCode = false } = {}) {
    this.#requireRestorePoints();
    if (typeof includeB3Database !== 'boolean') throw Object.assign(new Error('RESTORE_POINT_INVALID'), { code: 'RESTORE_POINT_INVALID' });
    if (includeB3Database && confirmation !== B3_DATABASE_CONFIRMATION) throw Object.assign(new Error('RESTORE_POINT_CONFIRMATION_REQUIRED'), { code: 'RESTORE_POINT_CONFIRMATION_REQUIRED' });
    const subject = this.subject(id);
    return this.#stoppedAll(id, async instance => {
      const point = await this.restorePoints.read(subject, pointId);
      const parts = point.manifest.parts.filter(part => part !== 'b3mysql' || includeB3Database);
      if (pointBringsCode(point.manifest, parts) && !canCode) throw Object.assign(new Error('RESTORE_POINT_CODE_PERMISSION'), { code: 'RESTORE_POINT_CODE_PERMISSION' });
      if (parts.includes('b3mysql') && !this.b3Database?.restoreDump) throw Object.assign(new Error('B3_DATABASE_NOT_READY'), { code: 'B3_DATABASE_NOT_READY' });
      const safety = await this.restorePoints.capture(subject, { action: 'restore.safety', actor, ...(await collectInstanceParts(instance, PARTS_BY_ACTION['restore.safety'])) });
      const result = await restoreInstanceParts(instance, point, parts, { store: this.store });
      if (parts.includes('b3mysql')) { await this.b3Database.restoreDump(id, point.manifest.refs.b3mysql); result.restored.push('b3mysql'); }
      else if (point.manifest.parts.includes('b3mysql')) result.skipped.push('b3mysql');
      await this.restorePoints.clearRecovery(subject);
      this.audit('info', 'restore_point.restored', { subject, restorePointId: pointId, safetyPointId: safety.pointId, parts: result.restored });
      return { pointId, safetyPointId: safety.pointId, ...result };
    }).catch(error => { this.audit('warn', 'restore_point.restore_failed', { subject, restorePointId: typeof pointId === 'string' ? pointId.slice(0, 40) : null, code: error.code || null }); throw error; });
  }
  async plugins(id) {
    const instance = this.store.get(id);
    const states = describePlugins(normalizePluginRecords(instance.plugins, instance.platform), await discoverPlugins(instance));
    const runtime = await this.runtime(id);
    try { await runtime.reconcileRuntimeState(); } catch { /* keep last known state */ }
    const running = runtime.state?.status === 'RUNNING' && Boolean(runtime.state?.pid);
    const loads = running ? (await readInstanceConsoleLog(instance.homePath, { inspect: classifyPluginLog })).inspection || {} : {};
    const versions = this.pluginVersions?.get(id);
    const current = versions && versions.runId === runtime.state?.runId ? versions.values : {};
    return { instanceId: id, platform: instance.platform, running, plugins: states.map(state => ({ ...state, load: running && state.enabled ? loads[state.name.toLowerCase()] || 'PENDING' : null, version: current[state.name.toLowerCase()] || null })) };
  }
  async installPlugin(id, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'sourcePath') throw Object.assign(new Error('PLUGIN_SOURCE_INVALID'), { code: 'PLUGIN_SOURCE_INVALID' });
    return this.#stoppedPluginChange(id, async instance => {
      const installed = await installPluginFile(instance, input.sourcePath);
      const records = normalizePluginRecords(instance.plugins, instance.platform).filter(record => record.name.toLowerCase() !== installed.name.toLowerCase());
      await this.store.setPlugins(id, [...records, { name: installed.name, platform: instance.platform, sha256: installed.sha256, bytes: installed.bytes, enabled: false, approvedAt: new Date().toISOString(), source: 'installed', config: {} }]);
      return { name: installed.name, sha256: installed.sha256 };
    });
  }
  // A manually placed file is trusted only after the operator confirms its hash.
  async approvePlugin(id, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'name,sha256') throw Object.assign(new Error('PLUGIN_APPROVAL_INVALID'), { code: 'PLUGIN_APPROVAL_INVALID' });
    return this.#stoppedPluginChange(id, async instance => {
      const name = validPluginName(input.name);
      const file = (await discoverPlugins(instance)).find(entry => entry.platformMatch && entry.name.toLowerCase() === name.toLowerCase());
      if (!file?.valid) throw Object.assign(new Error('PLUGIN_MISSING'), { code: 'PLUGIN_MISSING' });
      if (file.sha256 !== String(input.sha256).toLowerCase()) throw Object.assign(new Error('PLUGIN_INTEGRITY_FAILED'), { code: 'PLUGIN_INTEGRITY_FAILED' });
      const records = normalizePluginRecords(instance.plugins, instance.platform);
      const previous = records.find(record => record.name.toLowerCase() === name.toLowerCase());
      const next = records.filter(record => record !== previous);
      // Re-approving a changed file always disables it until enabled again.
      await this.store.setPlugins(id, [...next, { name: file.name, platform: instance.platform, sha256: file.sha256, bytes: file.bytes, enabled: false, approvedAt: new Date().toISOString(), source: 'approved', config: previous?.config || {} }]);
      return { name: file.name, sha256: file.sha256, previousSha256: previous?.sha256 || null };
    });
  }
  async setPluginEnabled(id, name, enabled) {
    return this.#stoppedPluginChange(id, async instance => {
      validPluginName(name);
      const records = normalizePluginRecords(instance.plugins, instance.platform);
      const record = records.find(value => value.name.toLowerCase() === name.toLowerCase());
      if (!record) throw Object.assign(new Error('PLUGIN_NOT_APPROVED'), { code: 'PLUGIN_NOT_APPROVED' });
      if (enabled) {
        const state = describePlugins([record], await discoverPlugins(instance))[0];
        if (state.state === 'INTEGRITY_MISMATCH') throw Object.assign(new Error('PLUGIN_INTEGRITY_FAILED'), { code: 'PLUGIN_INTEGRITY_FAILED' });
        if (state.state !== 'DISABLED' && state.state !== 'ENABLED') throw Object.assign(new Error('PLUGIN_MISSING'), { code: 'PLUGIN_MISSING' });
      }
      await this.store.setPlugins(id, records.map(value => value === record ? { ...value, enabled } : value));
      return { name: record.name, enabled };
    });
  }
  async configurePlugin(id, name, config) {
    return this.#stoppedPluginChange(id, async instance => {
      validPluginName(name);
      if (isB3hide(name) && instance.b3Integration?.hideCommands) b3Fail('B3_INTEGRATION_CONTROLLED');
      const records = normalizePluginRecords(instance.plugins, instance.platform);
      const record = records.find(value => value.name.toLowerCase() === name.toLowerCase());
      if (!record) throw Object.assign(new Error('PLUGIN_NOT_APPROVED'), { code: 'PLUGIN_NOT_APPROVED' });
      const updated = await this.store.setPlugins(id, records.map(value => value === record ? { ...value, config } : value));
      return { name: record.name, config: updated.plugins.find(value => value.name === record.name).config };
    });
  }
  async removePlugin(id, name) {
    return this.#stoppedPluginChange(id, async instance => {
      validPluginName(name);
      const archived = await retirePluginFile(instance, name);
      const records = normalizePluginRecords(instance.plugins, instance.platform);
      await this.store.setPlugins(id, records.filter(value => value.name.toLowerCase() !== name.toLowerCase()));
      return { name, archived };
    });
  }
  // Versions exist only at runtime (OnInfoRequest); read via allowlisted RCON pluginInfo.
  async readPluginVersions(id, actor = null) {
    if (!this.rconService) throw Object.assign(new Error('RCON_UNAVAILABLE'), { code: 'RCON_UNAVAILABLE' });
    const instance = this.store.get(id), runtime = await this.runtime(id);
    const enabled = normalizePluginRecords(instance.plugins, instance.platform).filter(record => record.enabled);
    const values = {};
    for (const record of enabled) {
      const result = await this.rconService.execute(id, `pluginInfo ${record.name}`, actor);
      values[record.name.toLowerCase()] = parsePluginInfoVersion(result.response);
    }
    this.pluginVersions ??= new Map();
    this.pluginVersions.set(id, { runId: runtime.state?.runId || null, values });
    return this.plugins(id);
  }
  async archive(id) {
    return this.exclusive(id, async () => {
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Instanz vor dem Löschen vollständig stoppen.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      // B3 runs independently, but an instance home must not move away under it.
      if (await this.b3Service?.isRunning(id)) throw Object.assign(new Error('B3 vor dem Löschen stoppen.'), { code: 'B3_RUNNING' });
      await runtime.persistRuntimeState();
      const result = await this.store.archive(id);
      this.runtimes.delete(id);
      this.b3Service?.forget(id);
      return result;
    });
  }
}
