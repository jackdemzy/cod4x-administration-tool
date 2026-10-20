import crypto from 'node:crypto';
import { RconClient } from './rcon-client.mjs';
import { RCON_COMMANDS, normalizeRconCommand, validKickReason } from './rcon-protocol.mjs';
import { parseStatus } from './rcon-status.mjs';
import { maskIp, maskGuid } from './b3-admin.mjs';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';

const HISTORY_LIMIT = 100;
const RESPONSE_LIMIT = 16 * 1024;
const TRANSIENT = new Set(['RCON_TIMEOUT', 'RCON_SOCKET_FAILED']);
// A dropped client can stay in status as ZMBI for a moment; it is gone for us.
const KICK_CONFIRM_DELAYS_MS = [0, 250, 750];
// B3 list views ask for the online state on every load: keep it brief and cheap.
const FIND_ONLINE_CACHE_MS = 3000;
const FIND_ONLINE_TIMEOUT_MS = 800;
// IPv4 a.b.c.x; IPv6 keeps everything but the last group; bots stay "bot".
function maskAddress(address) {
  const bracketed = /^\[([^\]]+)\]/.exec(address);
  if (bracketed) return bracketed[1].replace(/[^:]+$/, 'x');
  return maskIp(address.split(':')[0]);
}
const KNOWN_CODE = /^(?:RCON|VAULT|CREDENTIAL|INSTANCE)_[A-Z_]+$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const SENSITIVE_LINE = /(?:password|passwd|(?:master|auth|api|server)[_ -]?token|api[_ -]?key|secret|authorization)/i;

// Response text is untrusted server output: bounded and line-redacted before it
// enters history, the API or an export.
function sanitizeResponse(text) {
  let value = redactRuntimeOutput(String(text || '')).split(/(?<=\n)/).map(line => SENSITIVE_LINE.test(line) ? '[sensitive line hidden]\n' : line).join('');
  if (value.length > RESPONSE_LIMIT) value = value.slice(0, RESPONSE_LIMIT) + '\n[response truncated]\n';
  return value;
}
// Only a plain command name of a blocked input is auditable; arguments may hold a secret.
const blockedName = input => typeof input === 'string' && /^[A-Za-z_]{1,32}$/.test(input.trim().split(/ +/)[0] || '') ? input.trim().split(/ +/)[0].toLowerCase() : null;

// Per-instance RCON against 127.0.0.1:<instance.port>. The password is only
// read inside InstanceCredentialService.withRuntimeCredentials for one request.
export class InstanceRconService {
  #resolveInstance; #runtimeFor; #credentials; #audit; #clientFactory; #reconnectDelaysMs; #sleep;
  #states = new Map();
  #history = new Map();
  #queue = Promise.resolve();
  #onlineCache = new Map();
  constructor({ resolveInstance, runtimeFor, credentialService, audit = () => {}, clientFactory = options => new RconClient(options), reconnectDelaysMs = [0, 250, 750], sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (typeof resolveInstance !== 'function' || typeof runtimeFor !== 'function') fail('RCON_UNAVAILABLE');
    this.#resolveInstance = resolveInstance; this.#runtimeFor = runtimeFor; this.#credentials = credentialService;
    this.#audit = audit; this.#clientFactory = clientFactory; this.#reconnectDelaysMs = reconnectDelaysMs; this.#sleep = sleep;
  }
  #state(id) {
    if (!this.#states.has(id)) this.#states.set(id, { status: 'DISCONNECTED', runId: null, provisioning: 'UNKNOWN', provisionedRunId: null, lastOkAt: null, lastErrorCode: null, failures: 0, latencyMs: null, server: null });
    return this.#states.get(id);
  }
  // Called by the launch path: whether this run received rcon_password. Never the value.
  recordProvisioning(id, runId, provisioning) {
    const state = this.#state(id);
    Object.assign(state, { runId, provisionedRunId: runId, provisioning, status: provisioning === 'PROVISIONED' ? 'DISCONNECTED' : 'NOT_PROVISIONED', lastErrorCode: null, failures: 0, server: null });
  }
  #serial(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
  async #running(id, { timeoutMs } = {}) {
    const instance = this.#resolveInstance(id);
    if (!instance || instance.id !== id) fail('INSTANCE_NOT_FOUND');
    const runtime = await this.#runtimeFor(id);
    try { await runtime.reconcileRuntimeState(); } catch { /* Keep last known state; status decides below. */ }
    const state = this.#state(id), runtimeState = runtime.state || {};
    if (state.runId !== runtimeState.runId) {
      // New run (restart or backend reload): connection evidence is never carried over.
      Object.assign(state, { runId: runtimeState.runId || null, status: 'DISCONNECTED', failures: 0, server: null, lastErrorCode: null });
      if (state.provisionedRunId !== runtimeState.runId) state.provisioning = 'UNKNOWN';
    }
    if (runtimeState.status !== 'RUNNING' || !runtimeState.pid) { state.status = 'OFFLINE'; fail('RCON_SERVER_NOT_RUNNING'); }
    return { instance, state, client: this.#clientFactory({ host: '127.0.0.1', port: instance.port, ...(timeoutMs ? { timeoutMs } : {}) }) };
  }
  async #withPassword(id, action) {
    if (!this.#credentials) fail('CREDENTIAL_UNAVAILABLE');
    return this.#credentials.withRuntimeCredentials(id, async (credentials, signal) => {
      if (!credentials.rcon) fail('RCON_NOT_CONFIGURED');
      if (signal.aborted) fail('VAULT_LOCKED');
      return action(credentials.rcon);
    });
  }
  #fault(state, code) {
    state.lastErrorCode = code;
    if (code === 'RCON_AUTH_FAILED') state.status = 'AUTH_FAILED';
    else if (code === 'RCON_PASSWORD_NOT_ACTIVE') state.status = 'NOT_PROVISIONED';
    else if (TRANSIENT.has(code)) { state.failures++; state.status = 'DISCONNECTED'; }
  }
  #record(id, entry) {
    const history = this.#history.get(id) || [];
    history.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    this.#history.set(id, history);
  }
  status(id) {
    const instance = this.#resolveInstance(id);
    if (!instance || instance.id !== id) fail('INSTANCE_NOT_FOUND');
    const state = this.#state(id);
    return structuredClone({ instanceId: id, target: { host: '127.0.0.1', port: instance.port }, ...state, commands: RCON_COMMANDS, history: this.#history.get(id) || [] });
  }
  // Connect = health probe (getinfo), Authenticate = harmless `serverinfo`.
  // Transient failures are retried with backoff; authentication failures are not.
  async connect(id, actor = null) {
    return this.#serial(async () => {
      let context;
      try { context = await this.#running(id); }
      catch (error) { this.#audit('warn', 'rcon.failure', { instanceId: id, actor, stage: 'login', code: error.code || 'RCON_FAILED' }); throw error; }
      const { state, client } = context;
      state.status = 'RECONNECTING';
      let attempts = 0, lastCode = 'RCON_TIMEOUT';
      for (const delay of this.#reconnectDelaysMs) {
        attempts++;
        if (delay) await this.#sleep(delay);
        try {
          const health = await client.probe();
          const response = await this.#withPassword(id, password => client.execute(password, 'serverinfo'));
          Object.assign(state, { status: 'CONNECTED', lastOkAt: new Date().toISOString(), lastErrorCode: null, failures: 0, latencyMs: response.latencyMs,
            server: { hostname: health.hostname, mapname: health.mapname, clients: health.clients, maxClients: health.maxClients } });
          this.#audit('info', 'rcon.login', { instanceId: id, actor, ok: true, attempts, latencyMs: response.latencyMs, runId: state.runId });
          return this.status(id);
        } catch (error) {
          lastCode = error.code || 'RCON_FAILED';
          this.#fault(state, lastCode);
          if (!TRANSIENT.has(lastCode)) break;
        }
      }
      if (TRANSIENT.has(lastCode)) state.status = 'UNREACHABLE';
      this.#audit('warn', 'rcon.failure', { instanceId: id, actor, stage: 'login', code: lastCode, attempts, runId: state.runId });
      throw Object.assign(new Error(lastCode), { code: lastCode, rcon: this.status(id) });
    });
  }
  // Block 15b: connected players from `status` (masked unless full; steamid never).
  async online(id, { full = false } = {}) {
    return this.#serial(async () => {
      const context = await this.#running(id);
      const { text } = await this.#withPassword(id, password => context.client.execute(password, 'status'));
      const { map, players } = parseStatus(text);
      return { map, players: players.map(player => ({ slot: player.slot, name: player.name, ping: player.ping, score: player.score,
        playerid: full ? player.playerid : maskGuid(player.playerid), address: player.bot ? 'bot' : full ? player.address : maskAddress(player.address), bot: player.bot })) };
    });
  }
  // playerid -> slot for unique, real player ids (bots and unauthenticated
  // players share "0"). Never throws: null means the online state is unknown.
  // Cached for a few seconds with a short timeout; connecting (CNCT) and dropped
  // (ZMBI) clients are not online players.
  async findOnline(id) {
    const cached = this.#onlineCache.get(id);
    if (cached && Date.now() - cached.at < FIND_ONLINE_CACHE_MS) return cached.value;
    let value;
    try {
      const { players } = await this.#serial(async () => {
        const context = await this.#running(id, { timeoutMs: FIND_ONLINE_TIMEOUT_MS });
        return parseStatus((await this.#withPassword(id, password => context.client.execute(password, 'status'))).text);
      });
      const counts = new Map();
      for (const player of players) counts.set(player.playerid, (counts.get(player.playerid) || 0) + 1);
      value = new Map(players.filter(player => player.playerid !== '0' && counts.get(player.playerid) === 1 && !['CNCT', 'ZMBI'].includes(player.ping)).map(player => [player.playerid, player.slot]));
    } catch { value = null; }
    this.#onlineCache.set(id, { at: Date.now(), value });
    return value;
  }
  // Block 15b: kick one connected player by slot. The slot must still hold the
  // expected player right before the kick (no kick otherwise), and must be free
  // (or ZMBI) afterwards. Audit carries the slot only, never name/id/IP/reason.
  async kick(id, { slot, playerid, name, reason } = {}, actor = null) {
    const audit = (ok, code) => this.#audit(ok ? 'info' : 'warn', 'rcon.kick', { instanceId: id, actor, slot: Number.isInteger(slot) ? slot : null, ok, code });
    let text;
    try {
      // Target check: the playerid and/or the exact name (masked lists have no usable id).
      if (!Number.isInteger(slot) || slot < 0 || slot > 63 || (playerid !== undefined && (typeof playerid !== 'string' || !/^\d{1,20}$/.test(playerid)))
        || (name !== undefined && (typeof name !== 'string' || !name.trim())) || (playerid === undefined && name === undefined) || (playerid === '0' && name === undefined)) fail('RCON_KICK_INVALID');
      text = validKickReason(reason ?? '');
    } catch (error) { audit(false, error.code); throw error; }
    return this.#serial(async () => {
      try {
        const context = await this.#running(id);
        const read = async password => parseStatus((await context.client.execute(password, 'status')).text);
        // One short vault scope for check + kick; a kick without a reply may
        // still have worked, so the confirmation decides.
        const target = await this.#withPassword(id, async password => {
          const current = (await read(password)).players.find(player => player.slot === slot);
          if (!current) fail('RCON_KICK_NOT_ONLINE');
          if ((playerid !== undefined && current.playerid !== playerid) || (name !== undefined && current.name !== name.trim())) fail('RCON_KICK_TARGET_CHANGED');
          try { await context.client.kick(password, slot, text); }
          catch (error) { if (error.code !== 'RCON_TIMEOUT') throw error; }
          return current;
        });
        this.#onlineCache.delete(id);
        // Each confirmation has its own short scope; pauses happen outside the vault.
        // After the kick was sent, any failure to confirm is reported as NOT_CONFIRMED.
        for (const delay of KICK_CONFIRM_DELAYS_MS) {
          if (delay) await this.#sleep(delay);
          let status;
          try { status = await this.#withPassword(id, read); } catch { fail('RCON_KICK_NOT_CONFIRMED'); }
          if (!status.header) continue;
          const after = status.players.find(player => player.slot === slot);
          if (!after || after.ping === 'ZMBI' || after.playerid !== target.playerid || after.name !== target.name) { audit(true, null); return { kicked: true, slot }; }
        }
        fail('RCON_KICK_NOT_CONFIRMED');
      } catch (error) {
        const code = KNOWN_CODE.test(error.code || '') ? error.code : 'RCON_FAILED';
        audit(false, code);
        throw Object.assign(new Error(code), { code });
      }
    });
  }
  async execute(id, input, actor = null) {
    let command;
    try { command = normalizeRconCommand(input); }
    catch (error) {
      this.#audit('warn', 'rcon.failure', { instanceId: id, actor, stage: 'command', code: error.code, commandName: blockedName(input) });
      this.#record(id, { command: blockedName(input) || '[blocked]', ok: false, code: error.code, response: '' });
      throw error;
    }
    return this.#serial(async () => {
      let state;
      try {
        const context = await this.#running(id);
        state = context.state;
        const result = await this.#withPassword(id, password => context.client.execute(password, command));
        const response = sanitizeResponse(result.text);
        Object.assign(state, { status: 'CONNECTED', lastOkAt: new Date().toISOString(), lastErrorCode: null, failures: 0, latencyMs: result.latencyMs });
        this.#record(id, { command, ok: true, code: null, response, latencyMs: result.latencyMs });
        this.#audit('info', 'rcon.command', { instanceId: id, actor, command, ok: true, latencyMs: result.latencyMs, packets: result.packets, bytes: result.text.length, runId: state.runId });
        return { command, response, latencyMs: result.latencyMs, rcon: this.status(id) };
      } catch (error) {
        const code = /^(?:RCON|VAULT|CREDENTIAL|INSTANCE)_[A-Z_]+$/.test(error.code || '') ? error.code : 'RCON_FAILED';
        if (state) this.#fault(state, code);
        this.#record(id, { command, ok: false, code, response: '' });
        this.#audit('warn', 'rcon.failure', { instanceId: id, actor, stage: 'command', command, code, runId: state?.runId || null });
        throw Object.assign(new Error(code), { code });
      }
    });
  }
}
