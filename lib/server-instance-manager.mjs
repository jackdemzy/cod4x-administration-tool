import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readInstanceConsoleLog } from './instance-console-log.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { CONFIG_SCHEMA } from './config-engine.mjs';
import { assertCredentialChangeInput } from './instance-credential-service.mjs';

export class ServerInstanceManager {
  constructor({ store, runtimeFactory, legacyRuntime = null, credentialService = null, credentialRuntime = null }) {
    this.store = store;
    this.runtimeFactory = runtimeFactory;
    this.legacyRuntime = legacyRuntime;
    this.runtimes = new Map();
    this.operations = new Set();
    this.configEngine = new ConfigEngineStorage();
    this.credentialService = credentialService;
    this.credentialRuntime = credentialRuntime;
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
      values.push({ ...instance, runtime: runtime.state, consoleLog: await this.consoleLog(instance, runtime), inspectionError });
    }
    return structuredClone(values);
  }
  async status(id) {
    const runtime = await this.runtime(id);
    await runtime.reconcileRuntimeState();
    const instance = this.store.get(id);
    return { ...instance, runtime: structuredClone(runtime.state), consoleLog: await this.consoleLog(instance, runtime) };
  }
  async consoleLog(instance, runtime) {
    // Sticky across later public runs: old qconsole bytes may still belong to a
    // private run. Never reopen that file merely because stdout is public now.
    if (runtime.state.recoveryBlocked || runtime.state.consoleOutputPrivate === true || runtime.state.outputPolicy === 'private') return { source: 'qconsole.log', status: 'suppressed', text: '', truncated: false };
    return readInstanceConsoleLog(instance.homePath);
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
      const policy = { ...instance.credentialPolicy };
      if (Object.values(policy).includes('unclassified')) {
        const status = await this.credentialService?.instanceStatus(id);
        for (const kind of ['join', 'rcon']) if (policy[kind] === 'unclassified' && typeof status?.[kind]?.configured !== 'boolean') throw Object.assign(new Error('Credential-Anforderung der Altinstanz ist unbekannt. Tresor zur einmaligen Prüfung entsperren.'), { code: 'CREDENTIAL_POLICY_UNCLASSIFIED' });
        for (const kind of ['join', 'rcon']) if (policy[kind] === 'unclassified') {
          policy[kind] = status[kind].configured ? 'required' : 'none';
          await this.store.setCredentialRequirement(instance, kind, policy[kind]);
        }
      }
      const legacyHome = this.legacyRuntime?.state.filesystemHomePath;
      if (this.legacyRuntime?.busy && legacyHome && path.resolve(legacyHome).toLowerCase() === instance.homePath.toLowerCase()) throw Object.assign(new Error('Homepath wird von der bisherigen Einzel-Runtime verwendet.'), { code: 'INSTANCE_LEGACY_HOME_BUSY' });
      if (policy.join === 'required' || policy.rcon === 'required') return this.launchWithCredentials(instance, runtime, restart, policy);
      // On restart the owned process still holds its UDP port; check after it stops.
      if (restart) await runtime.stopRuntime('instance-restart');
      await this.store.checkPort(instance.port);
      const state = await runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: instance.serverCore.version, platform: instance.platform, args: ['+set', 'net_port', String(instance.port), '+set', 'net_ip', '127.0.0.1', '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', '::1', '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'] });
      await runtime.persistRuntimeState();
      return structuredClone(state);
    });
  }
  async launchWithCredentials(instance, runtime, restart, policy = instance.credentialPolicy) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const driver = this.credentialRuntime;
    const joinRequired = policy.join === 'required', rconRequired = policy.rcon === 'required';
    if (instance.platform !== 'windows' || !this.credentialService || typeof driver?.withConfig !== 'function' || typeof driver?.waitReady !== 'function') fail('CREDENTIAL_RUNTIME_NOT_READY');
    await runtime.reconcileRuntimeState();
    if (runtime.busy && !restart) fail('INSTANCE_RUNTIME_BUSY');
    const beforeRunId = runtime.state.runId;
    let startRequested = false, startedRun;
    const verifyRun = async () => {
      await runtime.reconcileRuntimeState();
      if (!startedRun || runtime.state.runId !== startedRun.runId || runtime.state.pid !== startedRun.pid || runtime.state.status !== 'RUNNING') fail('CREDENTIAL_RUNTIME_PROCESS_LOST');
    };
    try {
      const ready = await this.credentialService.withRuntimeCredentials(instance.id, async (credentials, signal) => {
        const checkAbort = () => { if (signal.aborted) fail('CREDENTIAL_RUNTIME_ABORTED'); };
        checkAbort();
        if ((joinRequired && !credentials.join) || (rconRequired && !credentials.rcon)) fail('CREDENTIAL_NOT_CONFIGURED');
        // A Join-only server still needs an unguessable RCON readiness probe.
        // It is ephemeral, never stored, returned or placed on the command line.
        const ephemeral = credentials.rcon ? null : Buffer.from(randomBytes(24).toString('hex'));
        const rcon = credentials.rcon || ephemeral;
        let consumerFailure;
        try {
          return await driver.withConfig({ homePath: instance.homePath, credentials: { rcon, join: joinRequired ? credentials.join : null }, signal }, async ({ relativeConfig }) => {
            try {
              checkAbort();
              if (typeof relativeConfig !== 'string' || !/^control-[a-zA-Z0-9-]+\/run\.cfg$/.test(relativeConfig) || relativeConfig.length >= 64) fail('CREDENTIAL_RUNTIME_FILE_INVALID');
              await this.store.validatePaths(instance);
              await this.configEngine.read(instance);
              checkAbort();
              if (restart) await runtime.stopRuntime('instance-credential-restart');
              checkAbort();
              await this.store.checkPort(instance.port);
              checkAbort();
              startRequested = true;
              const state = await runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: instance.serverCore.version, platform: instance.platform, outputPolicy: 'private', args: ['+set', 'net_port', String(instance.port), '+set', 'net_ip', '127.0.0.1', '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', '::1', '+exec', 'server.cfg', '+exec', relativeConfig, '+set', 'logfile', '0', '+set', 'com_logrcon', '0', '+map', 'mp_backlot'] });
              startedRun = { runId: state.runId, pid: state.pid };
              runtime.state.credentialActivation = { state: 'PENDING', runId: state.runId };
              checkAbort();
              const observed = await driver.waitReady({ port: instance.port, rcon, joinRequired, signal });
              checkAbort();
              if (observed?.rconAuthenticated !== true || observed?.joinPasswordFlag !== joinRequired || observed?.map !== 'mp_backlot') fail('CREDENTIAL_RUNTIME_READINESS_INVALID');
              await verifyRun();
              checkAbort();
              return { rconAuthenticated: true, joinPasswordFlag: joinRequired, map: 'mp_backlot' };
            } catch (error) { consumerFailure = error; throw error; }
          });
        } catch (error) {
          // The file helper intentionally hides arbitrary consumer exceptions.
          // Preserve our internal cause unless cleanup itself failed.
          throw error.code === 'CREDENTIAL_RUNTIME_HANDOFF_FAILED' && consumerFailure ? consumerFailure : error;
        } finally { ephemeral?.fill(0); }
      });
      // File cleanup and the vault's final integrity check must both complete
      // before activation becomes READY. Recheck process identity afterwards.
      await verifyRun();
      runtime.state.credentialActivation = { state: 'READY', runId: startedRun.runId, ...ready };
      await runtime.persistRuntimeState();
      await verifyRun();
      return structuredClone(runtime.state);
    } catch (error) {
      const newRun = startRequested && runtime.state.runId && runtime.state.runId !== beforeRunId;
      if (newRun && runtime.busy) {
        try { await runtime.stopRuntime('instance-credential-failed'); }
        catch { fail('CREDENTIAL_RUNTIME_RECOVERY_REQUIRED'); }
      }
      if (newRun || !runtime.busy) {
        runtime.state.credentialActivation = { state: 'FAILED', runId: runtime.state.runId || null };
        await runtime.persistRuntimeState();
      }
      const safeCodes = new Set(['VAULT_LOCKED', 'VAULT_CONFLICT', 'VAULT_BUSY', 'CREDENTIAL_NOT_CONFIGURED', 'CREDENTIAL_RUNTIME_ABORTED', 'CREDENTIAL_RUNTIME_READINESS_TIMEOUT', 'CREDENTIAL_RUNTIME_READINESS_INVALID', 'CREDENTIAL_RUNTIME_PROCESS_LOST', 'CREDENTIAL_RUNTIME_FILE_INVALID', 'CREDENTIAL_RUNTIME_FILE_FAILED', 'CREDENTIAL_RUNTIME_ACL_BLOCKED', 'CREDENTIAL_RUNTIME_ARCHIVE_CONFLICT', 'CREDENTIAL_RUNTIME_HANDOFF_FAILED', 'CREDENTIAL_RUNTIME_CLEANUP_FAILED', 'VERIFIED_CORE_BLOCKED', 'INSTANCE_PORT_UNAVAILABLE', 'INSTANCE_RUNTIME_BUSY']);
      fail(safeCodes.has(error.code) ? error.code : 'CREDENTIAL_RUNTIME_START_FAILED');
    }
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
      assertCredentialChangeInput(kind, input, remove);
      // Two durable files cannot commit together. Fail closed across either
      // failure window: mark protection before adding; clear only after removal.
      if (['join', 'rcon'].includes(kind) && !remove) await this.store.setCredentialRequirement(instance, kind, 'required');
      const result = remove ? await this.credentialService.remove(id, kind, input) : await this.credentialService.set(id, kind, input);
      if (['join', 'rcon'].includes(kind) && remove) await this.store.setCredentialRequirement(instance, kind, 'none');
      return result;
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
