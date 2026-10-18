import path from 'node:path';
import { readInstanceConsoleLog } from './instance-console-log.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { CONFIG_SCHEMA, CONFIG_SECTIONS } from './config-engine.mjs';
import { bindAddresses, networkChangeRequest } from './instance-network.mjs';
import { pluginLaunchArguments, discoverPlugins, describePlugins, installPluginFile, retirePluginFile, normalizePluginRecords, validPluginName, classifyPluginLog, parsePluginInfoVersion } from './plugin-manager.mjs';
import { recordConfigActivation, readConfigActivation, describeConfigActivation } from './config-activation.mjs';

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
  constructor({ store, runtimeFactory, legacyRuntime = null, credentialService = null, rconService = null, masterService = null, b3Service = null }) {
    this.store = store;
    this.runtimeFactory = runtimeFactory;
    this.legacyRuntime = legacyRuntime;
    this.runtimes = new Map();
    this.operations = new Set();
    this.configEngine = new ConfigEngineStorage();
    this.credentialService = credentialService;
    this.rconService = rconService;
    this.masterService = masterService;
    this.b3Service = b3Service;
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
      const instance = this.store.get(id);
      const runtime = await this.runtime(id);
      await this.store.validatePaths(instance);
      // Validate before a restart can stop the currently owned process.
      const configuration = await this.configEngine.read(instance);
      const legacyHome = this.legacyRuntime?.state.filesystemHomePath;
      if (this.legacyRuntime?.busy && legacyHome && path.resolve(legacyHome).toLowerCase() === instance.homePath.toLowerCase()) throw Object.assign(new Error('Homepath wird von der bisherigen Einzel-Runtime verwendet.'), { code: 'INSTANCE_LEGACY_HOME_BUSY' });
      // Vault state and plugin integrity are checked before a restart can stop the running process.
      const provisioning = await this.credentialProvisioning(id);
      const plugins = await pluginLaunchArguments(instance);
      // On restart the owned process still holds its UDP port; check after it stops.
      if (restart) await runtime.stopRuntime('instance-restart');
      await this.store.checkPort(instance.port);
      // Loopback unless this instance was explicitly switched to public exposure.
      const bind = bindAddresses(instance.network);
      const network = ['+set', 'net_port', String(instance.port), '+set', 'net_ip', bind.ipv4, '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', bind.ipv6];
      const tail = [...plugins.args, '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'];
      const start = args => runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: instance.serverCore.version, platform: instance.platform, args });
      let state = null;
      if (KINDS.some(kind => provisioning[kind] === 'CONFIGURED')) {
        try {
          // Short-lived transfer: the vault buffer is wiped when the scope ends;
          // runtime history/state only ever see a redacted argument list.
          await this.credentialService.withRuntimeCredentials(id, async (credentials, signal) => {
            const secrets = [];
            if (provisioning.rcon === 'CONFIGURED') {
              if (!credentials.rcon) throw Object.assign(new Error('RCON_NOT_CONFIGURED'), { code: 'RCON_NOT_CONFIGURED' });
              secrets.push('+set', 'rcon_password', rconLaunchValue(credentials.rcon));
            }
            if (provisioning.master === 'CONFIGURED') {
              if (!credentials.master) throw Object.assign(new Error('MASTER_TOKEN_NOT_CONFIGURED'), { code: 'MASTER_TOKEN_NOT_CONFIGURED' });
              secrets.push('+set', 'sv_authtoken', masterLaunchValue(credentials.master));
            }
            if (signal.aborted) throw Object.assign(new Error('VAULT_LOCKED'), { code: 'VAULT_LOCKED' });
            state = await start([...network, ...secrets, ...tail]);
          });
        } catch (error) {
          // A vault lock after spawn cannot revoke what the process received.
          if (!state) throw error;
        }
      } else state = await start([...network, ...tail]);
      const transferred = kind => provisioning[kind] === 'CONFIGURED' ? 'PROVISIONED' : provisioning[kind];
      this.rconService?.recordProvisioning(id, state.runId, transferred('rcon'));
      this.masterService?.recordProvisioning(id, state.runId, transferred('master'));
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
      return restore ? this.configEngine.restore(instance, input) : this.configEngine.apply(instance, input);
    });
  }
  async changeCredential(id, kind, input, remove = false) {
    return this.exclusive(id, async () => {
      const instance = this.store.get(id), runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Stop the instance before changing credentials.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      await this.store.validatePaths(instance);
      if (!this.credentialService) throw Object.assign(new Error('Credential service unavailable.'), { code: 'CREDENTIAL_UNAVAILABLE' });
      return remove ? this.credentialService.remove(id, kind, input) : this.credentialService.set(id, kind, input);
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
      return action(instance);
    });
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
