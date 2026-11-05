import crypto from 'node:crypto';

// Block 24b: sessions of the remote gateway, separate from the bearer tokens of
// the local UI. The cookie carries a random token; only its SHA-256 is kept, so
// a heap dump or the session list never reveals a usable token. 30 min idle,
// 12 h absolute, as for local sessions.
export const REMOTE_IDLE_MS = 30 * 60e3;
export const REMOTE_MAX_MS = 12 * 3600e3;
const digest = token => crypto.createHash('sha256').update(String(token)).digest('hex');

export class RemoteSessions {
  #sessions = new Map(); #idleMs; #maxMs; #now; #maxSessions;
  constructor({ idleMs = REMOTE_IDLE_MS, maxMs = REMOTE_MAX_MS, now = Date.now, maxSessions = 200 } = {}) { this.#idleMs = idleMs; this.#maxMs = maxMs; this.#now = now; this.#maxSessions = maxSessions; }
  create({ username, role, mfa = false, client = null, tailscaleUser = null }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.#now();
    const session = { sessionId: crypto.randomBytes(12).toString('hex'), username, role, mfa: Boolean(mfa), client, tailscaleUser, createdAt: now, lastSeenAt: now, expiresAt: now + this.#idleMs, absoluteExpiresAt: now + this.#maxMs };
    this.#sessions.set(digest(token), session);
    // Oldest first out when the cap is reached.
    while (this.#sessions.size > this.#maxSessions) this.#sessions.delete(this.#sessions.keys().next().value);
    return { token, session: { ...session } };
  }
  get(token) {
    if (!token) return null;
    const key = digest(token), session = this.#sessions.get(key), now = this.#now();
    if (!session) return null;
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) { this.#sessions.delete(key); return null; }
    session.lastSeenAt = now;
    session.expiresAt = Math.min(now + this.#idleMs, session.absoluteExpiresAt);
    return { ...session };
  }
  destroy(token) { return token ? this.#sessions.delete(digest(token)) : false; }
  revoke(sessionId) {
    for (const [key, session] of this.#sessions) if (session.sessionId === sessionId) { this.#sessions.delete(key); return true; }
    return false;
  }
  revokeUser(username) {
    let count = 0;
    const name = String(username || '').toLowerCase();
    for (const [key, session] of this.#sessions) if (session.username.toLowerCase() === name) { this.#sessions.delete(key); count++; }
    return count;
  }
  setRole(username, role) { const name = String(username || '').toLowerCase(); for (const session of this.#sessions.values()) if (session.username.toLowerCase() === name) session.role = role; }
  revokeAll() { const count = this.#sessions.size; this.#sessions.clear(); return count; }
  list() {
    const now = this.#now();
    return [...this.#sessions.values()].filter(session => session.expiresAt > now && session.absoluteExpiresAt > now).map(session => ({ ...session })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}
