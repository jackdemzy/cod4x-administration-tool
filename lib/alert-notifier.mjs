import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ALERT_DEFAULTS, validateAlertRules } from './monitor-alerts.mjs';
import { maskDiscordWebhookUrl, sendDiscord, validateDiscordWebhookUrl } from './discord-webhook.mjs';
import { createVapidKeys, sendPush, validatePushSubscription, validateVapidKeys } from './web-push.mjs';

// Block 24c: delivery of alerts to Discord and Web Push. Settings and push
// subscriptions live in 0600 files outside the vault, so alerts still go out
// while the vault is locked. The webhook URL is a secret: the API and the audit
// only ever see it masked. A push message carries server name, state and
// cause only, never console lines.
export const PUSH_MAX_PER_USER = 5;
export const PUSH_MAX_TOTAL = 100;
const fail = (code, field) => { throw Object.assign(new Error(code), { code, field }); };

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}

export class AlertNotifier {
  #settingsFile; #subscriptionsFile; #audit; #eligible; #fetch; #now; #subject;
  #settings = { rules: { ...ALERT_DEFAULTS }, discordUrl: null, push: true, vapid: null };
  #subscriptions = [];
  #last = { discord: null, push: null };
  constructor({ directory, audit = () => {}, eligible = () => false, fetchImpl = fetch, now = Date.now, subject = 'https://github.com/jackdemzy/cod4x-administration-tool' }) {
    if (!directory) fail('ALERTS_INVALID');
    this.#settingsFile = path.join(directory, 'alerts.json'); this.#subscriptionsFile = path.join(directory, 'push-subscriptions.json');
    this.#audit = audit; this.#eligible = eligible; this.#fetch = fetchImpl; this.#now = now; this.#subject = subject;
  }
  async load() {
    const stored = await readJson(this.#settingsFile, {});
    let rules = { ...ALERT_DEFAULTS }, discordUrl = null, vapid = null;
    try { rules = validateAlertRules(stored.rules || {}); } catch { /* defaults */ }
    try { discordUrl = stored.discordUrl ? validateDiscordWebhookUrl(stored.discordUrl) : null; } catch { discordUrl = null; }
    try { vapid = stored.vapid ? validateVapidKeys(stored.vapid) : null; } catch { vapid = null; }
    this.#settings = { rules, discordUrl, push: stored.push !== false, vapid };
    if (!vapid) { this.#settings.vapid = createVapidKeys(); await this.#saveSettings(); }
    const list = await readJson(this.#subscriptionsFile, []);
    this.#subscriptions = (Array.isArray(list) ? list : []).flatMap(item => { try { return [{ ...validatePushSubscription(item), id: String(item.id), username: String(item.username), createdAt: item.createdAt || null }]; } catch { return []; } });
  }
  #saveSettings() { return writeJson(this.#settingsFile, this.#settings); }
  #saveSubscriptions() { return writeJson(this.#subscriptionsFile, this.#subscriptions); }
  rules() { return this.#settings.rules; }
  get vapidPublicKey() { return this.#settings.vapid?.publicKey || null; }

  status(username = null) {
    return {
      rules: { ...this.#settings.rules },
      discord: { configured: Boolean(this.#settings.discordUrl), url: maskDiscordWebhookUrl(this.#settings.discordUrl), last: this.#last.discord },
      push: { enabled: this.#settings.push, subscriptions: this.#subscriptions.length, users: [...new Set(this.#subscriptions.map(item => item.username))], last: this.#last.push, mine: username ? this.#subscriptions.filter(item => item.username.toLowerCase() === username.toLowerCase()).length : undefined },
    };
  }
  // discordUrl: undefined keeps it, null or '' removes it, a string replaces it.
  async configure({ rules, discordUrl, push } = {}, actor = null) {
    const next = { ...this.#settings, rules: rules === undefined ? this.#settings.rules : validateAlertRules(rules, this.#settings.rules) };
    if (discordUrl !== undefined) next.discordUrl = discordUrl === null || discordUrl === '' ? null : validateDiscordWebhookUrl(discordUrl);
    if (push !== undefined) { if (typeof push !== 'boolean') fail('ALERT_SETTINGS_INVALID', 'push'); next.push = push; }
    const discordChanged = next.discordUrl !== this.#settings.discordUrl;
    this.#settings = next;
    await this.#saveSettings();
    this.#audit('warn', 'alert.configured', { actor, enabled: next.rules.enabled, discord: Boolean(next.discordUrl), discordChanged, push: next.push });
    return this.status();
  }

  async subscribe(username, input) {
    const subscription = validatePushSubscription(input);
    const name = String(username);
    const existing = this.#subscriptions.find(item => item.endpoint === subscription.endpoint);
    if (existing && existing.username.toLowerCase() !== name.toLowerCase()) this.#subscriptions = this.#subscriptions.filter(item => item !== existing);
    else if (existing) { existing.keys = subscription.keys; await this.#saveSubscriptions(); return { id: existing.id, renewed: true }; }
    const own = this.#subscriptions.filter(item => item.username.toLowerCase() === name.toLowerCase());
    // Oldest device of this user goes when the limit is reached.
    if (own.length >= PUSH_MAX_PER_USER) this.#subscriptions = this.#subscriptions.filter(item => item !== own[0]);
    if (this.#subscriptions.length >= PUSH_MAX_TOTAL) fail('PUSH_LIMIT_REACHED');
    const record = { ...subscription, id: crypto.randomBytes(8).toString('hex'), username: name, createdAt: new Date(this.#now()).toISOString() };
    this.#subscriptions.push(record);
    await this.#saveSubscriptions();
    this.#audit('info', 'alert.push.subscribed', { username: name, subscriptionId: record.id, service: new URL(record.endpoint).hostname });
    return { id: record.id, renewed: false };
  }
  async unsubscribe(username, endpoint) {
    const before = this.#subscriptions.length;
    this.#subscriptions = this.#subscriptions.filter(item => !(item.username.toLowerCase() === String(username).toLowerCase() && item.endpoint === endpoint));
    if (this.#subscriptions.length !== before) { await this.#saveSubscriptions(); this.#audit('info', 'alert.push.unsubscribed', { username }); }
    return { removed: before - this.#subscriptions.length };
  }
  async removeUser(username) {
    const before = this.#subscriptions.length;
    this.#subscriptions = this.#subscriptions.filter(item => item.username.toLowerCase() !== String(username).toLowerCase());
    if (this.#subscriptions.length !== before) await this.#saveSubscriptions();
    return before - this.#subscriptions.length;
  }

  // One alert to every channel. Never throws; the result says what happened.
  async send(alert) {
    const details = { type: alert.type, instanceId: alert.instanceId ?? null };
    const result = { discord: null, push: [] };
    if (this.#settings.discordUrl) {
      const sent = await sendDiscord(this.#settings.discordUrl, alert, { fetchImpl: this.#fetch }).catch(error => ({ ok: false, code: error.code || 'DISCORD_FAILED' }));
      result.discord = sent; this.#last.discord = { at: this.#now(), ok: sent.ok, code: sent.code || null };
      this.#audit(sent.ok ? 'info' : 'warn', sent.ok ? 'alert.sent' : 'alert.failed', { ...details, channel: 'discord', status: sent.status ?? null, code: sent.code || null });
    }
    if (this.#settings.push && this.#settings.vapid) {
      const payload = JSON.stringify({ title: alert.title, body: alert.body || '', type: alert.type, tag: alert.key, t: alert.t ?? this.#now() });
      const gone = new Set();
      for (const subscription of [...this.#subscriptions]) {
        if (!this.#eligible(subscription.username)) continue;
        const sent = await sendPush(subscription, payload, { keys: this.#settings.vapid, subject: this.#subject, fetchImpl: this.#fetch, now: this.#now() }).catch(error => ({ ok: false, code: error.code || 'PUSH_FAILED' }));
        if (sent.gone) gone.add(subscription.id);
        result.push.push({ id: subscription.id, ...sent });
        this.#audit(sent.ok ? 'info' : 'warn', sent.ok ? 'alert.sent' : 'alert.failed', { ...details, channel: 'push', username: subscription.username, subscriptionId: subscription.id, status: sent.status ?? null, code: sent.code || null });
      }
      if (result.push.length) this.#last.push = { at: this.#now(), ok: result.push.every(item => item.ok), sent: result.push.filter(item => item.ok).length, failed: result.push.filter(item => !item.ok).length };
      if (gone.size) { this.#subscriptions = this.#subscriptions.filter(item => !gone.has(item.id)); await this.#saveSubscriptions(); }
    }
    return result;
  }
  test(actor) {
    return this.send({ key: `test:${this.#now()}`, type: 'test', severity: 'info', title: 'Testalarm von COD4X CONTROL', body: `Ausgelöst von ${actor || 'unbekannt'}. Wenn du das liest, kommen Alarme an.`, t: this.#now() });
  }
}
