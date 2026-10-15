import path from 'node:path';
import { readInstanceConsoleLog } from './instance-console-log.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { CONFIG_SCHEMA } from './config-engine.mjs';

export class ServerInstanceManager {
  constructor({ store, runtimeFactory, legacyRuntime = null, credentialService = null }) {
    this.store = store;
    this.runtimeFactory = runtimeFactory;
    this.legacyRuntime = legacyRuntime;
    this.runtimes = new Map();
    this.operations = new Set();
    this.configEngine = new ConfigEngineStorage();
    this.credentialService = credentialService;
  }
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
      await this.configEngine.read(instance);
      const legacyHome = this.legacyRuntime?.state.filesystemHomePath;
      if (this.legacyRuntime?.busy && legacyHome && path.resolve(legacyHome).toLowerCase() === instance.homePath.toLowerCase()) throw Object.assign(new Error('Homepath wird von der bisherigen Einzel-Runtime verwendet.'), { code: 'INSTANCE_LEGACY_HOME_BUSY' });
      // On restart the owned process still holds its UDP port; check after it stops.
      if (restart) await runtime.stopRuntime('instance-restart');
      await this.store.checkPort(instance.port);
      const state = await runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: instance.serverCore.version, platform: instance.platform, args: ['+set', 'net_port', String(instance.port), '+set', 'net_ip', '127.0.0.1', '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', '::1', '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'] });
      await runtime.persistRuntimeState();
      return structuredClone(state);
    });
  }
  async stop(id) { return this.exclusive(id, async () => { const runtime = await this.runtime(id); const state = await runtime.stopRuntime('instance-manual'); await runtime.persistRuntimeState(); return structuredClone(state); }); }
  async configuration(id) {
    const instance = this.store.get(id);
    try { return { ...await this.configEngine.read(instance), schema: CONFIG_SCHEMA }; }
    catch (error) {
      if (!['INSTANCE_CONFIG_INVALID', 'CONFIG_PARSE_INVALID', 'CONFIG_SCHEMA_INVALID'].includes(error.code)) throw error;
      // Recovery still performs the same path/file/UTF-8 checks; unsafe paths fail closed.
      const snapshot = await this.configEngine.recoverySnapshot(instance);
      if (snapshot.valid) throw error;
      return { ...snapshot, entries: [], schema: CONFIG_SCHEMA, code: 'CONFIG_RECOVERY_REQUIRED' };
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
  async archive(id) {
    return this.exclusive(id, async () => {
      const runtime = await this.runtime(id);
      await runtime.reconcileRuntimeState();
      if (runtime.busy) throw Object.assign(new Error('Instanz vor dem Löschen vollständig stoppen.'), { code: 'INSTANCE_RUNTIME_BUSY' });
      await runtime.persistRuntimeState();
      const result = await this.store.archive(id);
      this.runtimes.delete(id);
      return result;
    });
  }
}
