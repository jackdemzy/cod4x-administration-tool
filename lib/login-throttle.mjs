// Block 24b: login brake. After maxFailures failed logins for one client and
// user inside windowMs the pair is locked for lockMs; a success clears it. Used
// by the local login and the remote gateway. Bounded so a flood of random user
// names cannot grow memory without limit.
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60e3;
export const LOGIN_LOCK_MS = 15 * 60e3;

export class LoginThrottle {
  #entries = new Map(); #maxFailures; #windowMs; #lockMs; #now; #maxEntries;
  constructor({ maxFailures = LOGIN_MAX_FAILURES, windowMs = LOGIN_WINDOW_MS, lockMs = LOGIN_LOCK_MS, now = Date.now, maxEntries = 10_000 } = {}) {
    this.#maxFailures = maxFailures; this.#windowMs = windowMs; this.#lockMs = lockMs; this.#now = now; this.#maxEntries = maxEntries;
  }
  static key(client, username) { return `${String(client || 'unknown')}|${String(username || '').trim().toLowerCase()}`; }
  #entry(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const now = this.#now();
    if (entry.lockedUntil && entry.lockedUntil <= now) { this.#entries.delete(key); return null; }
    entry.failures = entry.failures.filter(t => t > now - this.#windowMs);
    if (!entry.failures.length && !entry.lockedUntil) { this.#entries.delete(key); return null; }
    return entry;
  }
  check(key) {
    const entry = this.#entry(key);
    const retryAfterMs = entry?.lockedUntil ? entry.lockedUntil - this.#now() : 0;
    return { locked: retryAfterMs > 0, retryAfterMs };
  }
  // Returns true when this failure locked the pair.
  fail(key) {
    const now = this.#now();
    const entry = this.#entry(key) || { failures: [], lockedUntil: 0 };
    entry.failures.push(now);
    if (entry.failures.length >= this.#maxFailures) entry.lockedUntil = now + this.#lockMs;
    this.#entries.delete(key); this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    return entry.lockedUntil > now;
  }
  succeed(key) { this.#entries.delete(key); }
  get size() { return this.#entries.size; }
}

// Security audit 4.18.26 (A5-3): every loopback address (all of 127.0.0.0/8 and ::1) is
// the same local client, so a local caller cannot pick a fresh address per attempt.
export function loginClient(address) {
  const value = String(address || '');
  if (value === '::1' || /^(?:::ffff:)?127\./i.test(value)) return 'loopback';
  return value || 'unknown';
}
