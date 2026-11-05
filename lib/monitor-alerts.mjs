// Block 24c: turns monitoring events into notifications. The debounce of an
// outage comes from the collector (45 s without an answer, a crash at once).
// On top of that a repeat brake: the same alert goes out at most once per
// repeatMinutes; the all-clear goes out exactly once, and only for an alert that
// was sent. An outage that falls into the brake is sent as soon as the brake
// ends if the server is still down, so a long outage is never hidden.
export const ALERT_DEFAULTS = Object.freeze({ enabled: false, onDown: true, onUp: true, onPlannedStop: false, diskFreeGb: 5, b3Stopped: false, playersAtLeast: null, repeatMinutes: 30 });
const GB = 1024 ** 3;
const fail = (code, field) => { throw Object.assign(new Error(code), { code, field }); };

export function validateAlertRules(input = {}, base = ALERT_DEFAULTS) {
  const next = { ...ALERT_DEFAULTS, ...base };
  for (const field of ['enabled', 'onDown', 'onUp', 'onPlannedStop', 'b3Stopped']) if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') fail('ALERT_SETTINGS_INVALID', field); next[field] = input[field]; }
  const number = (field, min, max, integer = false) => {
    if (input[field] === undefined) return;
    if (input[field] === null || input[field] === '') { if (field === 'repeatMinutes') fail('ALERT_SETTINGS_INVALID', field); next[field] = null; return; }
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail('ALERT_SETTINGS_INVALID', field);
    next[field] = value;
  };
  number('diskFreeGb', 0.5, 10_000); number('playersAtLeast', 1, 128, true); number('repeatMinutes', 5, 1440, true);
  return next;
}

const CAUSE = { crash: 'Absturz', unresponsive: 'keine Antwort', stopped: 'gestoppt' };
export const formatDuration = ms => {
  const minutes = Math.max(0, Math.round(ms / 60e3));
  if (minutes < 1) return 'unter 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};
const gb = bytes => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;

export class MonitorAlerts {
  #rules; #send; #now; #lastSent = new Map(); #open = new Map(); #pending = new Map(); #b3 = new Map(); #players = new Map();
  constructor({ rules = () => ALERT_DEFAULTS, send, now = Date.now }) {
    if (typeof send !== 'function') fail('ALERTS_INVALID');
    this.#rules = rules; this.#send = send; this.#now = now;
  }
  #brake(key, rules) { const last = this.#lastSent.get(key); return last !== undefined && this.#now() - last < rules.repeatMinutes * 60e3; }
  async #dispatch(alert) {
    this.#lastSent.set(alert.key, this.#now());
    try { return await this.#send({ t: this.#now(), ...alert }); } catch { return null; }
  }
  // Fire an alert unless the brake holds; returns whether it went out.
  async #raise(alert, rules, { openKey = alert.key } = {}) {
    if (this.#brake(alert.key, rules)) return false;
    this.#open.set(openKey, alert);
    await this.#dispatch(alert);
    return true;
  }
  async #clear(openKey, alert, rules, { notify = true } = {}) {
    if (!this.#open.has(openKey)) return false;
    this.#open.delete(openKey);
    if (!notify) return false;
    await this.#dispatch(alert);
    return true;
  }

  // Events of the collector: { kind: 'down'|'up', id, cause, downMs, since }.
  async handleEvent(event, live = null) {
    const rules = this.#rules();
    if (!rules.enabled) return;
    const name = live?.name || event.id, key = `server:${event.id}`;
    if (event.kind === 'down') {
      const kind = event.cause?.kind || 'unresponsive';
      if (kind === 'stopped' && !rules.onPlannedStop) return;
      if (!rules.onDown) return;
      const alert = { key, type: 'down', instanceId: event.id, severity: 'bad', title: `${name} ist ausgefallen`, body: `Ursache: ${CAUSE[kind] || kind}${event.cause?.hint?.[0] ? `. ${event.cause.hint[0]}` : ''}` };
      if (!(await this.#raise(alert, rules))) this.#pending.set(event.id, alert);
    } else if (event.kind === 'up') {
      // Recovered inside the brake: nothing was sent, nothing to clear.
      this.#pending.delete(event.id);
      await this.#clear(key, { key: `${key}:up`, type: 'up', instanceId: event.id, severity: 'good', title: `${name} ist wieder da`, body: `Ausfalldauer: ${formatDuration(event.downMs ?? 0)}` }, rules, { notify: rules.onUp });
    }
  }

  // After every poll: delayed outages, disk space, B3 and player thresholds.
  async handleTick(overview) {
    const rules = this.#rules();
    if (!rules.enabled) return;
    const instances = overview?.instances || [];
    for (const [id, alert] of [...this.#pending]) {
      const live = instances.find(item => item.id === id);
      if (!live?.down) { this.#pending.delete(id); continue; }
      if (await this.#raise({ ...alert, body: `${alert.body} (seit ${formatDuration(this.#now() - (live.downSince ?? this.#now()))})` }, rules)) this.#pending.delete(id);
    }
    for (const disk of overview?.host?.disks || []) {
      if (disk.freeBytes === null || disk.freeBytes === undefined) continue;
      const key = `disk:${disk.path}`;
      if (rules.diskFreeGb && disk.freeBytes < rules.diskFreeGb * GB) { if (!this.#open.has(key)) await this.#raise({ key, type: 'disk', severity: 'warn', title: 'Wenig freier Speicherplatz', body: `${disk.path}: noch ${gb(disk.freeBytes)} frei (Schwelle ${rules.diskFreeGb} GB)` }, rules); }
      // Reported once while low; 10 % hysteresis so a value around the threshold does not flap.
      else if (!rules.diskFreeGb || disk.freeBytes >= rules.diskFreeGb * GB * 1.1) await this.#clear(key, { key: `${key}:ok`, type: 'disk-ok', severity: 'good', title: 'Speicherplatz wieder ausreichend', body: `${disk.path}: ${gb(disk.freeBytes)} frei` }, rules);
    }
    for (const live of instances) {
      const name = live.name || live.id;
      // B3 counts as stopped only after it was seen running, while the server answers.
      const wasRunning = this.#b3.get(live.id);
      if (live.b3 === true) this.#b3.set(live.id, true);
      const b3Key = `b3:${live.id}`;
      if (rules.b3Stopped && live.up && live.b3 === false && wasRunning) { this.#b3.set(live.id, false); await this.#raise({ key: b3Key, type: 'b3', instanceId: live.id, severity: 'warn', title: `B3 auf ${name} ist gestoppt`, body: 'Der Server läuft, B3 aber nicht.' }, rules); }
      else if (live.b3 === true) await this.#clear(b3Key, { key: `${b3Key}:ok`, type: 'b3-ok', instanceId: live.id, severity: 'good', title: `B3 auf ${name} läuft wieder`, body: '' }, rules, { notify: rules.b3Stopped });
      const count = live.up ? (live.players || []).length : 0, playerKey = `players:${live.id}`, armed = this.#players.get(live.id) !== false;
      if (rules.playersAtLeast && count >= rules.playersAtLeast && armed) { this.#players.set(live.id, false); await this.#raise({ key: playerKey, type: 'players', instanceId: live.id, severity: 'info', title: `${name}: ${count} Spieler online`, body: `Schwelle ${rules.playersAtLeast} erreicht${live.map ? ` (Map ${live.map})` : ''}` }, rules, { openKey: `${playerKey}:open` }); this.#open.delete(`${playerKey}:open`); }
      else if (!rules.playersAtLeast || count < rules.playersAtLeast) this.#players.set(live.id, true);
    }
  }
  state() { return { open: [...this.#open.keys()], pending: [...this.#pending.keys()] }; }
}
