// Block 18b: one SSH session per host, reused while it is in use and closed after it has been idle
// for idleMs. Monitoring polls every 15 s and RCON is interactive; without this every poll and every
// command would be a new SSH login. A transport failure drops the session so the next use logs in again.
const TRANSPORT = /^REMOTE_(?:CONNECT_FAILED|TIMEOUT|AUTH_FAILED|HOST_KEY_[A-Z_]+|SFTP_UNAVAILABLE)$/;

export class RemoteSessionPool {
  #entries = new Map();
  constructor({ connect, idleMs = 60_000 }) {
    if (typeof connect !== 'function') throw new TypeError('connect is required');
    Object.assign(this, { connect, idleMs });
  }

  async use(hostId, action) {
    const entry = this.#entry(hostId);
    entry.users++;
    clearTimeout(entry.timer);
    try {
      const context = await entry.ready;
      return await action(context);
    } catch (error) {
      if (TRANSPORT.test(error?.code || '')) this.#drop(hostId, entry);
      throw error;
    } finally {
      entry.users--;
      if (entry.users === 0 && this.#entries.get(hostId) === entry) {
        entry.timer = setTimeout(() => this.#drop(hostId, entry), this.idleMs);
        entry.timer.unref?.();
      }
    }
  }

  closeAll() { for (const [hostId, entry] of [...this.#entries]) this.#drop(hostId, entry); }

  #entry(hostId) {
    const existing = this.#entries.get(hostId);
    if (existing) return existing;
    const entry = { users: 0, timer: null, context: null };
    entry.ready = this.connect(hostId).then(context => { entry.context = context; return context; });
    // a failed login is not cached; the waiting users get the error
    entry.ready.catch(() => { if (this.#entries.get(hostId) === entry) this.#entries.delete(hostId); });
    this.#entries.set(hostId, entry);
    return entry;
  }

  #drop(hostId, entry) {
    clearTimeout(entry.timer);
    if (this.#entries.get(hostId) === entry) this.#entries.delete(hostId);
    try { entry.context?.session?.close(); } catch { /* already closed */ }
  }
}
