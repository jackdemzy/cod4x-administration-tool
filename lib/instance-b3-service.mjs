import fs from 'node:fs/promises';
import path from 'node:path';
import { B3Runtime } from './b3-runtime.mjs';
import { b3Paths, prepareB3Runtime } from './b3-config.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';
import { parseB3Log, parseB3ConfigSummary, redactB3Config, buildB3Dashboard } from './b3-manager.mjs';

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
  constructor({ store, environment, onEvent = () => {}, runtimeFactory = options => new B3Runtime(options), configEngine = new ConfigEngineStorage(), platform = hostPlatform,
    serverStatus = async () => ({ status: 'UNKNOWN', reachable: null }), dependencyCacheMs = 30000, now = () => Date.now(), database = null, credentials = null }) {
    Object.assign(this, { store, environment, onEvent, runtimeFactory, configEngine, platform, serverStatus, dependencyCacheMs, now, database, credentials });
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
  async status(id) {
    const runtime = await this.runtime(id);
    return { runtime: await runtime.reconcile(), health: await runtime.health(), output: await runtime.outputTail() };
  }
  async start(id, restart = false) {
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
      const prepared = !setup?.ready ? await prepareB3Runtime(instance, gLog)
        : await this.credentials.withRuntimeCredentials(id, async (credentials, signal) => {
          if (signal?.aborted) fail('VAULT_LOCKED');
          if (!credentials.b3db) fail('B3_DATABASE_PASSWORD_MISSING');
          const connection = await this.database.connectionFor(id, credentials.b3db);
          if (!connection) fail('B3_DATABASE_NOT_READY');
          if (signal?.aborted) fail('VAULT_LOCKED');
          return prepareB3Runtime(instance, gLog, { databaseDsn: connection.dsn });
        });
      const runtime = await this.runtime(id);
      const options = { pythonPath: dependencies.environment.pythonPath, b3Path: dependencies.environment.b3Path, configPath: prepared.config };
      return { runtime: restart ? await runtime.restart(options) : await runtime.start(options), config: { path: prepared.config, sha256: prepared.sha256, gameLog: prepared.gameLog } };
    });
  }
  async stop(id) { return { runtime: await (await this.runtime(id)).stop('manual') }; }
  async #configText(id) {
    try { return await fs.readFile(b3Paths(this.store.get(id)).config, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async logs(id) { return (await this.runtime(id)).logs(); }
  async config(id) {
    const text = await this.#configText(id);
    return text === null ? { exists: false, text: null, summary: null } : { exists: true, text: redactB3Config(text), summary: parseB3ConfigSummary(text) };
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
    return { instanceId: id, checkedAt: new Date(this.now()).toISOString(), ...buildB3Dashboard({ dependencies, runtime: snapshot, health, log, config: text ? parseB3ConfigSummary(text) : null, server, database }), runtime: snapshot };
  }
  forget(id) { this.#runtimes.delete(id); }
}
