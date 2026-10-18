import path from 'node:path';
import { B3Runtime } from './b3-runtime.mjs';
import { b3Paths, prepareB3Runtime } from './b3-config.mjs';
import { ConfigEngineStorage } from './config-engine-storage.mjs';

const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const hostPlatform = () => process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unsupported';

// Per-instance B3 lifecycle. Independent of ServerInstanceManager's CoD4x
// runtime: separate process, state file and lock. Only the dependency gate of
// Block 11 and the instance's own g_log setting are shared inputs.
export class InstanceB3Service {
  #runtimes = new Map();
  constructor({ store, environment, onEvent = () => {}, runtimeFactory = options => new B3Runtime(options), configEngine = new ConfigEngineStorage(), platform = hostPlatform }) {
    Object.assign(this, { store, environment, onEvent, runtimeFactory, configEngine, platform });
  }
  async runtime(id) {
    const instance = this.store.get(id);
    if (!this.#runtimes.has(id)) {
      const runtime = this.runtimeFactory({ instanceId: id, platform: instance.platform, stateFile: path.join(instance.homePath, 'logs', 'b3-runtime-state.json'), paths: b3Paths(instance), onEvent: this.onEvent });
      this.#runtimes.set(id, Promise.resolve(runtime.load()).then(() => runtime));
    }
    return this.#runtimes.get(id);
  }
  async isRunning(id) { return (await this.runtime(id)).running; }
  async status(id) {
    const runtime = await this.runtime(id);
    return { runtime: await runtime.reconcile(), health: await runtime.health(), output: await runtime.outputTail() };
  }
  async start(id, restart = false) {
    const instance = this.store.get(id);
    if (instance.platform !== this.platform()) fail('B3_PLATFORM_MISMATCH');
    const dependencies = await this.environment.check();
    // UNAUDITED or BLOCKED never starts; only the audited eBc-B3 source runs.
    if (dependencies.overall !== 'READY_FOR_RUNTIME_TEST') fail('B3_DEPENDENCIES_BLOCKED', { overall: dependencies.overall, blocking: dependencies.blocking });
    const configuration = await this.configEngine.read(instance);
    const gLog = configuration.entries.find(entry => entry.name === 'g_log')?.value;
    const prepared = await prepareB3Runtime(instance, gLog);
    const runtime = await this.runtime(id);
    const options = { pythonPath: dependencies.environment.pythonPath, b3Path: dependencies.environment.b3Path, configPath: prepared.config };
    return { runtime: restart ? await runtime.restart(options) : await runtime.start(options), config: { path: prepared.config, sha256: prepared.sha256, gameLog: prepared.gameLog } };
  }
  async stop(id) { return { runtime: await (await this.runtime(id)).stop('manual') }; }
  forget(id) { this.#runtimes.delete(id); }
}
