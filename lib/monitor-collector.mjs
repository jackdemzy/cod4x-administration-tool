import { diagnoseConsole, explainCause, lastConsoleLines } from './monitor-diagnose.mjs';

// Block 24: polls every instance on a fixed interval and records one sample per
// instance: runtime state, unauthenticated getstatus (map, players, latency).
// No RCON password is used. A server that stops answering is declared down only
// after offlineAfterMs (a map change does not answer for 20-40 s); the outage
// event carries the probable cause from the end of the console log.
export const MONITOR_INTERVAL_MS = 15_000;
export const MONITOR_OFFLINE_AFTER_MS = 45_000;

const causeKind = status => status === 'FAILED' ? 'crash' : status === 'STOPPED' || status === 'STOPPING' ? 'stopped' : 'unresponsive';

export class MonitorCollector {
  #listInstances; #runtimeFor; #probe; #readConsole; #b3Running; #store; #host; #now; #intervalMs; #offlineAfterMs; #onEvent; #onTick;
  #live = new Map(); #track = new Map(); #hostSample = null; #timer = null; #ticking = null; #lastPrune = 0; #checkedAt = null;
  constructor({ listInstances, runtimeFor, probe, readConsole, b3Running = () => null, store, host = null, now = Date.now, intervalMs = MONITOR_INTERVAL_MS, offlineAfterMs = MONITOR_OFFLINE_AFTER_MS, onEvent = () => {}, onTick = () => {} }) {
    if (typeof listInstances !== 'function' || typeof runtimeFor !== 'function' || typeof probe !== 'function' || !store) throw Object.assign(new Error('MONITOR_UNAVAILABLE'), { code: 'MONITOR_UNAVAILABLE' });
    this.#listInstances = listInstances; this.#runtimeFor = runtimeFor; this.#probe = probe; this.#readConsole = readConsole || (async () => ({ text: '' }));
    this.#b3Running = b3Running; this.#store = store; this.#host = host; this.#now = now; this.#intervalMs = intervalMs; this.#offlineAfterMs = offlineAfterMs; this.#onEvent = onEvent; this.#onTick = onTick;
  }
  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.#intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }
  stop() { clearInterval(this.#timer); this.#timer = null; }
  // One poll at a time; an overlapping timer tick waits for the running one.
  tick() {
    if (!this.#ticking) this.#ticking = this.#poll().finally(() => { this.#ticking = null; });
    return this.#ticking;
  }
  async #poll() {
    const instances = await this.#listInstances();
    const known = new Set(instances.map(instance => instance.id));
    for (const id of [...this.#live.keys()]) if (!known.has(id)) { this.#live.delete(id); this.#track.delete(id); }
    await Promise.all(instances.map(instance => this.#pollInstance(instance).catch(error => console.error(`[monitor] ${instance.id}: ${error.code || error.message}`))));
    if (this.#host) { try { this.#hostSample = await this.#host.sample(instances.map(instance => instance.homePath)); } catch { /* keep the last host sample */ } }
    this.#checkedAt = this.#now();
    if (this.#checkedAt - this.#lastPrune > 6 * 3600e3) { this.#lastPrune = this.#checkedAt; void this.#store.prune().catch(() => {}); }
    // Block 24c: alert rules that look at the whole picture (disk, B3, players).
    try { await this.#onTick(this.overview()); } catch { /* listeners never break polling */ }
  }
  async #pollInstance(instance) {
    const t = this.#now();
    let state = {};
    try { const runtime = await this.#runtimeFor(instance.id); try { await runtime.reconcileRuntimeState(); } catch { /* last known state */ } state = runtime.state || {}; } catch { state = {}; }
    const status = state.status || 'UNKNOWN';
    let reply = null;
    if (status === 'RUNNING' && state.pid) { try { reply = await this.#probe(instance.port); } catch { reply = null; } }
    const up = Boolean(reply?.reachable);
    const track = this.#track.get(instance.id) || { lastUpAt: null, downSince: null, declared: null };
    if (up) {
      if (track.declared) this.#emit({ t, id: instance.id, kind: 'up', downMs: t - track.declared.since, runId: state.runId || null });
      track.lastUpAt = t; track.downSince = null; track.declared = null;
    } else if (track.lastUpAt !== null) {
      // Only a server that answered before can go down; a stopped one stays stopped.
      track.downSince ??= t;
      // A process that is gone (crash, stop) is down at once; a running one that
      // does not answer (or is starting again) only after the grace period.
      const planned = status === 'STOPPED' || status === 'STOPPING';
      if (!track.declared && (planned || status === 'FAILED' || t - track.downSince >= this.#offlineAfterMs)) {
        const log = await this.#readConsole(instance.homePath).catch(() => ({ text: '' }));
        const { reason, clean } = diagnoseConsole(log?.text);
        const hint = explainCause(reason);
        const kind = causeKind(status);
        track.declared = { since: track.downSince };
        this.#emit({ t, id: instance.id, kind: 'down', since: track.downSince, cause: { kind, status, exitCode: state.exitCode ?? null, exitSignal: state.exitSignal ?? null, lastError: state.lastError || null, reason, clean, hint, console: lastConsoleLines(log?.text) }, runId: state.runId || null });
        // A planned stop is recorded once and not tracked further until the next answer.
        if (planned) { track.lastUpAt = null; track.downSince = null; }
      }
    }
    this.#track.set(instance.id, track);
    let b3 = null;
    try { b3 = await this.#b3Running(instance.id); } catch { b3 = null; }
    const live = { id: instance.id, name: instance.name || instance.id, port: instance.port, status, runId: state.runId || null, startedAt: status === 'RUNNING' ? state.startedAt || null : null, up, latencyMs: up ? reply.latencyMs : null,
      hostname: reply?.hostname || null, map: reply?.mapname || null, gametype: reply?.gametype || null, players: up ? reply.players || [] : [], maxClients: reply?.maxClients ?? null,
      lastUpAt: track.lastUpAt, downSince: track.downSince, down: Boolean(track.declared), b3, checkedAt: t };
    this.#live.set(instance.id, live);
    await this.#store.append({ t, id: instance.id, s: status, up, ms: live.latencyMs, p: up ? live.players.length : null, max: live.maxClients, map: live.map });
  }
  #emit(event) {
    void this.#store.appendEvent(event);
    try { this.#onEvent(event); } catch { /* listeners never break polling */ }
  }
  overview() {
    return { checkedAt: this.#checkedAt, intervalMs: this.#intervalMs, offlineAfterMs: this.#offlineAfterMs, host: this.#hostSample, instances: [...this.#live.values()].map(value => structuredClone(value)) };
  }
  live(id) { const value = this.#live.get(id); return value ? structuredClone(value) : null; }
}
