// Block 24d: step-up and limits for actions from the phone (say, kick,
// restart). A fresh TOTP code (never a recovery code) opens a short window
// bound to the remote session; say and kick work inside it, a restart always
// needs its own code. On top: at most 10 actions per session in 5 minutes and
// one restart per instance in 2 minutes.
export const STEP_UP_MS = 5 * 60e3;
export const ACTION_WINDOW_MS = 5 * 60e3;
export const ACTION_MAX_PER_WINDOW = 10;
export const RESTART_COOLDOWN_MS = 2 * 60e3;
export const REMOTE_ACTION_KINDS = Object.freeze(['say', 'kick', 'restart']);
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

export class RemoteActionGuard {
  #now; #stepUp = new Map(); #actions = new Map(); #restarts = new Map();
  constructor({ now = Date.now } = {}) { this.#now = now; }
  #prune() {
    const now = this.#now();
    for (const [key, until] of this.#stepUp) if (until <= now) this.#stepUp.delete(key);
    for (const [key, list] of this.#actions) { const recent = list.filter(t => t > now - ACTION_WINDOW_MS); if (recent.length) this.#actions.set(key, recent); else this.#actions.delete(key); }
    for (const [key, at] of this.#restarts) if (at <= now - RESTART_COOLDOWN_MS) this.#restarts.delete(key);
  }
  stepUpUntil(sessionId) { this.#prune(); return this.#stepUp.get(sessionId) || null; }
  // Called after a TOTP code for this session was verified.
  grant(sessionId) { const until = this.#now() + STEP_UP_MS; this.#stepUp.set(sessionId, until); return until; }
  revoke(sessionId) { this.#stepUp.delete(sessionId); this.#actions.delete(sessionId); }
  // Throws when the action may not run now. `freshCode` = a code was verified in this request.
  check(sessionId, kind, instanceId, { freshCode = false } = {}) {
    if (!REMOTE_ACTION_KINDS.includes(kind)) fail('REMOTE_ACTION_UNKNOWN');
    this.#prune();
    if (kind === 'restart' ? !freshCode : !freshCode && !this.#stepUp.has(sessionId)) fail('REMOTE_STEP_UP_REQUIRED');
    if ((this.#actions.get(sessionId) || []).length >= ACTION_MAX_PER_WINDOW) fail('REMOTE_ACTION_LIMIT', { retryAfterMs: ACTION_WINDOW_MS });
    if (kind === 'restart' && this.#restarts.has(instanceId)) fail('REMOTE_RESTART_COOLDOWN', { retryAfterMs: this.#restarts.get(instanceId) + RESTART_COOLDOWN_MS - this.#now() });
  }
  record(sessionId, kind, instanceId) {
    const list = this.#actions.get(sessionId) || [];
    list.push(this.#now()); this.#actions.set(sessionId, list);
    if (kind === 'restart') this.#restarts.set(instanceId, this.#now());
  }
  // A restart that did not happen does not hold the instance back.
  failed(kind, instanceId) { if (kind === 'restart') this.#restarts.delete(instanceId); }
}
