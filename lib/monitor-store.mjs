import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

// Block 24: monitoring history. One JSON line per instance and poll in a daily
// UTC file (samples-YYYY-MM-DD.jsonl), outage events in events-YYYY-MM-DD.jsonl.
// The last 24 h stay in memory for the live view; longer ranges are read from
// disk and reduced to buckets. Files older than the retention are deleted.
const DAY_MS = 864e5;
export const MONITOR_RANGES = Object.freeze({ '24h': { ms: DAY_MS, bucketMs: 60e3 }, '7d': { ms: 7 * DAY_MS, bucketMs: 15 * 60e3 }, '30d': { ms: 30 * DAY_MS, bucketMs: 60 * 60e3 } });
const FILE = /^(samples|events)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const day = t => new Date(t).toISOString().slice(0, 10);
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function monitorRange(value = '24h') {
  const range = MONITOR_RANGES[value];
  if (!range) fail('MONITOR_RANGE_INVALID');
  return { name: value, ...range };
}

export class MonitorStore {
  #directory; #retentionDays; #now; #recent = new Map(); #events = []; #writes = Promise.resolve();
  constructor({ directory, retentionDays = 30, now = Date.now }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('MONITOR_STORE_INVALID');
    this.#directory = directory; this.#retentionDays = retentionDays; this.#now = now;
  }
  get directory() { return this.#directory; }
  async load() {
    await fsp.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const since = this.#now() - DAY_MS;
    for await (const sample of this.#read('samples', since)) this.#remember(sample);
    for await (const event of this.#read('events', this.#now() - 30 * DAY_MS)) this.#events.push(event);
  }
  #remember(sample) {
    const list = this.#recent.get(sample.id) || [];
    list.push(sample);
    const since = this.#now() - DAY_MS;
    while (list.length && list[0].t < since) list.shift();
    this.#recent.set(sample.id, list);
  }
  #append(kind, record) {
    const file = path.join(this.#directory, `${kind}-${day(record.t)}.jsonl`);
    // Serialized so lines never interleave; a failed write is reported, not fatal.
    this.#writes = this.#writes.then(() => fsp.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })).catch(error => { console.error(`[monitor] ${kind} not written: ${error.code || error.message}`); });
    return this.#writes;
  }
  append(sample) { this.#remember(sample); return this.#append('samples', sample); }
  appendEvent(event) { this.#events.push(event); if (this.#events.length > 2000) this.#events.shift(); return this.#append('events', event); }
  flush() { return this.#writes; }
  latest(id) { const list = this.#recent.get(id); return list?.length ? list.at(-1) : null; }
  async *#read(kind, since) {
    let names = [];
    try { names = await fsp.readdir(this.#directory); } catch { return; }
    const first = day(since);
    for (const name of names.filter(value => FILE.test(value) && value.startsWith(`${kind}-`) && FILE.exec(value)[2] >= first).sort()) {
      const lines = readline.createInterface({ input: createReadStream(path.join(this.#directory, name), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; } // a torn last line after a crash
        if (record && Number.isFinite(record.t) && record.t >= since && typeof record.id === 'string') yield record;
      }
    }
  }
  // Buckets per range: players = highest count, up = share of answered polls,
  // latency = mean of answered polls. availability = answered / all polls.
  async history(id, rangeName = '24h') {
    const range = monitorRange(rangeName);
    const end = this.#now(), start = end - range.ms;
    const buckets = new Map();
    let polls = 0, answered = 0;
    const add = sample => {
      if (sample.id !== id || sample.t < start) return;
      polls++; if (sample.up) answered++;
      const key = Math.floor(sample.t / range.bucketMs) * range.bucketMs;
      const bucket = buckets.get(key) || { t: key, polls: 0, answered: 0, players: 0, latency: 0 };
      bucket.polls++;
      if (sample.up) { bucket.answered++; bucket.players = Math.max(bucket.players, sample.p ?? 0); bucket.latency += sample.ms ?? 0; }
      buckets.set(key, bucket);
    };
    if (range.ms <= DAY_MS) for (const sample of this.#recent.get(id) || []) add(sample);
    else for await (const sample of this.#read('samples', start)) add(sample);
    const points = [...buckets.values()].sort((a, b) => a.t - b.t).map(bucket => ({ t: bucket.t, up: bucket.answered / bucket.polls, players: bucket.answered ? bucket.players : null, latencyMs: bucket.answered ? Math.round(bucket.latency / bucket.answered) : null }));
    return { range: range.name, start, end, bucketMs: range.bucketMs, polls, availability: polls ? answered / polls : null, points };
  }
  events(id, rangeName = '7d') {
    const since = this.#now() - monitorRange(rangeName).ms;
    return this.#events.filter(event => event.id === id && event.t >= since).sort((a, b) => b.t - a.t);
  }
  async prune() {
    const oldest = day(this.#now() - this.#retentionDays * DAY_MS);
    let names = [];
    try { names = await fsp.readdir(this.#directory); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const match = FILE.exec(name);
      if (match && match[2] < oldest) { await fsp.rm(path.join(this.#directory, name), { force: true }); removed++; }
    }
    return removed;
  }
}
