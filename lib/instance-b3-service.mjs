import fs from 'node:fs/promises';
import path from 'node:path';
import { B3Runtime } from './b3-runtime.mjs';
import { b3Paths, prepareB3Runtime } from './b3-config.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { parseB3Log, parseB3ConfigSummary, redactB3Config, redactB3PluginAuth, buildB3Dashboard } from './b3-manager.mjs';
import { integrationRow } from './b3-integration.mjs';

// Puts back the b3.xml that existed before a failed MySQL start (atomic, 0600).
async function restoreConfig(file, previous) {
  if (previous === null) { await fs.rm(file, { force: true }); return; }
  const temporary = `${file}.restore-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, previous, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const hostPlatform = () => process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unsupported';

// Per-instance B3 lifecycle. Independent of ServerInstanceManager's CoD4x
// runtime: separate process, state file and lock. Only the dependency gate of
// Block 11 and the instance's own g_log setting are shared inputs. The server
// state is only read (serverStatus) for the Block 13 dashboard, never changed.
export class InstanceB3Service {
  #runtimes = new Map();
  #dependencies = null;
  #inflight = null;
  #generation = 0;
  #startedWith = new Map();
  #starting = new Map();
  #configuring = new Set();
  constructor({ store, environment, onEvent = () => {}, runtimeFactory = options => new B3Runtime(options), configEngine = new ConfigEngineStorage(), platform = hostPlatform,
    serverStatus = async () => ({ status: 'UNKNOWN', reachable: null }), dependencyCacheMs = 30000, now = () => Date.now(), database = null, credentials = null, integration = null, plugins = null }) {
    Object.assign(this, { store, environment, onEvent, runtimeFactory, configEngine, platform, serverStatus, dependencyCacheMs, now, database, credentials, integration, plugins });
  }
  async runtime(id) {
    const instance = this.store.get(id);
    if (!this.#runtimes.has(id)) {
      const runtime = this.runtimeFactory({ instanceId: id, platform: instance.platform, stateFile: path.join(instance.homePath, 'logs', 'b3-runtime-state.json'), paths: b3Paths(instance), onEvent: this.onEvent });
      this.#runtimes.set(id, Promise.resolve(runtime.load()).then(() => runtime));
    }
    return this.#runtimes.get(id);
  }
  // The interpreter probe spawns Python; dashboards reuse a recent result and
  // concurrent callers share one running check of the same settings generation.
  async dependencies({ fresh = false } = {}) {
    if (!fresh && this.#dependencies && this.now() - this.#dependencies.at < this.dependencyCacheMs) return this.#dependencies.value;
    if (this.#inflight?.generation === this.#generation) return this.#inflight.promise;
    const generation = this.#generation;
    const promise = Promise.resolve().then(() => this.environment.check()).then(value => {
      // A check that started before a settings change never fills the cache.
      if (generation === this.#generation) this.#dependencies = { at: this.now(), value };
      return value;
    }).finally(() => { if (this.#inflight?.promise === promise) this.#inflight = null; });
    this.#inflight = { generation, promise };
    return promise;
  }
  // Called after the B3 environment (Python/B3 paths) was saved.
  invalidateDependencies() { this.#generation++; this.#dependencies = null; this.#inflight = null; }
  async isRunning(id) { return (await this.runtime(id)).running; }
  // Block 16: integration changes and B3 starts exclude each other. The claim is
  // taken synchronously, before any await, so neither side can slip in between.
  async whileIdle(id, action) {
    if (this.#configuring.has(id) || this.#starting.get(id)) fail('B3_INTEGRATION_BUSY');
    this.#configuring.add(id);
    try {
      if (await this.isRunning(id)) fail('B3_INTEGRATION_BUSY');
      return await action();
    } finally { this.#configuring.delete(id); }
  }
  async status(id) {
    const runtime = await this.runtime(id);
    return { runtime: await runtime.reconcile(), health: await runtime.health(), output: await runtime.outputTail() };
  }
  async start(id, restart = false) {
    if (this.#configuring.has(id)) fail('B3_INTEGRATION_BUSY');
    this.#starting.set(id, (this.#starting.get(id) || 0) + 1);
    try { return await this.#start(id, restart); }
    finally {
      const left = this.#starting.get(id) - 1;
      if (left > 0) this.#starting.set(id, left); else this.#starting.delete(id);
    }
  }
  async #start(id, restart) {
    const instance = this.store.get(id);
    if (instance.platform !== this.platform()) fail('B3_PLATFORM_MISMATCH');
    // A start always uses a fresh dependency check, never the dashboard cache.
    const dependencies = await this.dependencies({ fresh: true });
    // UNAUDITED or BLOCKED never starts; only the audited eBc-B3 source runs.
    if (dependencies.overall !== 'READY_FOR_RUNTIME_TEST') fail('B3_DEPENDENCIES_BLOCKED', { overall: dependencies.overall, blocking: dependencies.blocking });
    const configuration = await this.configEngine.read(instance);
    const gLog = configuration.entries.find(entry => entry.name === 'g_log')?.value;
    // Block 14: a ready database switches b3.xml to MySQL. The password only
    // exists inside the vault transfer scope; a locked vault leaves b3.xml as is.
    // Once MySQL was in use, B3 never silently falls back to SQLite.
    // The database start guard (per-instance lock) covers the readiness check,
    // b3.xml and the spawn, so no migration can start in between.
    const guard = this.database?.withStartGuard ? action => this.database.withStartGuard(id, action) : action => action();
    return guard(async () => {
      if (this.database?.isBusy?.(id) && !this.database?.withStartGuard) fail('B3_DATABASE_BUSY');
      const setup = this.database ? await this.database.read(id) : null;
      if (!setup?.ready && setup?.mysqlEnabled) fail('B3_DATABASE_NOT_READY');
      // Block 17: two instances never write the same B3 database.
      if (setup?.mysqlEnabled) {
        const otherInstanceId = await this.database.sharedTarget?.(id);
        if (otherInstanceId) fail('B3_DATABASE_TARGET_SHARED', { otherInstanceId });
      }
      // Block 16: the integration plan decides RCON and auth; any blocker stops
      // the start before a file is written.
      const plan = this.integration ? await this.integration.plan(id) : null;
      if (plan?.blockers.length) fail(plan.blockers[0].code, { blockers: plan.blockers });
      // Block 16b: every enabled plugin must match its hash, requirements and config.
      const pluginPlan = this.plugins ? await this.plugins.plan(id, dependencies) : null;
      if (pluginPlan?.blockers.length) fail(pluginPlan.blockers[0].code, { blockers: pluginPlan.blockers });
      const plugins = pluginPlan?.plugins || [];
      const runtime = await this.runtime(id);
      const launch = async (prepared, credentialDigest) => {
        const options = { pythonPath: dependencies.environment.pythonPath, b3Path: dependencies.environment.b3Path, configPath: prepared.config };
        const result = { runtime: restart ? await runtime.restart(options) : await runtime.start(options), config: { path: prepared.config, fingerprint: prepared.fingerprint, gameLog: prepared.gameLog } };
        this.#startedWith.set(id, { fingerprint: plan?.fingerprint || null, credentialDigest: credentialDigest || null, pluginsRevision: pluginPlan ? pluginPlan.revision : null, at: new Date(this.now()).toISOString() });
        return result;
      };
      // Without MySQL the vault is optional: a locked or missing vault starts
      // B3 as before (no RCON password), unless the integration needs RCON.
      const vault = this.credentials?.status ? await this.credentials.status() : { initialized: false, locked: true, sha256: null };
      const vaultOpen = vault.initialized && !vault.locked;
      if (!setup?.ready && !vaultOpen) {
        if (plan?.enabled) fail('VAULT_LOCKED');
        return launch(await prepareB3Runtime(instance, gLog, { plugins }), null);
      }
      // b3.xml, plugin_auth.ini and the spawn happen inside the verified vault
      // scope. If the vault locks before the scope is confirmed, B3 is stopped and
      // both previous files are restored, so no started B3 or written password
      // outlives the lock.
      const paths = b3Paths(instance);
      const digest = this.credentials.instanceStatus ? (await this.credentials.instanceStatus(id).catch(() => null))?.digest : null;
      const read = file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const previous = await read(paths.config), previousAuth = await read(paths.authConfig);
      let written = false, started = false;
      try {
        return await this.credentials.withRuntimeCredentials(id, async (credentials, signal) => {
          if (signal?.aborted) fail('VAULT_LOCKED');
          let dsn = null;
          if (setup?.ready) {
            if (!credentials.b3db) fail('B3_DATABASE_PASSWORD_MISSING');
            const connection = await this.database.connectionFor(id, credentials.b3db);
            if (!connection) fail('B3_DATABASE_NOT_READY');
            dsn = connection.dsn;
          }
          if (plan?.rcon.required && !credentials.rcon) fail('RCON_PASSWORD_MISSING');
          if (signal?.aborted) fail('VAULT_LOCKED');
          let auth = null;
          if (plan?.auth.enabled) {
            const stored = credentials.b3auth ? JSON.parse(credentials.b3auth.toString()) : {};
            auth = { passwords: Object.fromEntries(plan.auth.passwordLevels.filter(level => typeof stored[level] === 'string').map(level => [level, stored[level]])) };
          }
          written = true;
          const prepared = await prepareB3Runtime(instance, gLog, { databaseDsn: dsn, rconPassword: credentials.rcon ? credentials.rcon.toString() : '', auth, plugins });
          if (signal?.aborted) fail('VAULT_LOCKED');
          const result = await launch(prepared, digest);
          started = true;
          return result;
        });
      } catch (error) {
        if (started) { try { await runtime.stop('vault-locked'); } catch { /* reported by the B3 runtime state */ } }
        if (written) {
          this.#startedWith.delete(id);
          await restoreConfig(paths.config, previous);
          await restoreConfig(paths.authConfig, previousAuth);
        }
        throw error;
      }
    });
  }
  async stop(id) { return { runtime: await (await this.runtime(id)).stop('manual') }; }
  async #configText(id) {
    try { return await fs.readFile(b3Paths(this.store.get(id)).config, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async logs(id) { return (await this.runtime(id)).logs(); }
  // Plan fingerprint and vault snapshot of the last successful start (memory only).
  startedWith(id) { return this.#startedWith.get(id) || null; }
  async config(id) {
    const text = await this.#configText(id);
    const auth = await fs.readFile(b3Paths(this.store.get(id)).authConfig, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const authConfig = auth === null ? { exists: false, text: null } : { exists: true, text: redactB3PluginAuth(auth) };
    return text === null ? { exists: false, text: null, summary: null, authConfig } : { exists: true, text: redactB3Config(text), summary: parseB3ConfigSummary(text), authConfig };
  }
  // Block 13 health dashboard: Python, B3, MySQL, parser, RCON, CoD4x.
  async dashboard(id, { fresh = false } = {}) {
    const runtime = await this.runtime(id);
    const snapshot = await runtime.reconcile();
    const health = await runtime.health();
    const [dependencies, log, text] = await Promise.all([this.dependencies({ fresh }), runtime.inspectLog(parseB3Log), this.#configText(id)]);
    let server;
    try { server = await this.serverStatus(id); } catch { server = { status: 'UNKNOWN', reachable: null }; }
    let database = null;
    try { database = this.database ? await this.database.read(id) : null; } catch { database = null; }
    // Block 16: "b3hide/auth connected"; a failing lookup shows as unknown.
    let integration = null;
    if (this.integration) {
      try {
        const plan = await this.integration.plan(id);
        const b3hideLoad = this.integration.b3hideLoad ? await this.integration.b3hideLoad(id) : null;
        integration = integrationRow({ plan, b3hideLoad, b3Running: Boolean(snapshot?.running) && health?.alive === true, startedWith: this.startedWith(id), authStarted: log?.auth === 'STARTED' });
        if (plan.enabled && log?.authExposed) integration = { ...integration, authExposed: true };
      } catch { integration = { status: 'UNKNOWN', code: null }; }
    }
    return { instanceId: id, checkedAt: new Date(this.now()).toISOString(), ...buildB3Dashboard({ dependencies, runtime: snapshot, health, log, config: text ? parseB3ConfigSummary(text) : null, server, database }), runtime: snapshot, integration };
  }
  forget(id) { this.#runtimes.delete(id); }
}
