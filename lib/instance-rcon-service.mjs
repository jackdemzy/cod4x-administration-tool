import crypto from 'node:crypto';
import { RconClient } from './rcon-client.mjs';
import { RCON_COMMANDS, normalizeRconCommand } from './rcon-protocol.mjs';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';

const HISTORY_LIMIT = 100;
const RESPONSE_LIMIT = 16 * 1024;
const TRANSIENT = new Set(['RCON_TIMEOUT', 'RCON_SOCKET_FAILED']);
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
  async #running(id) {
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
    return { instance, state, client: this.#clientFactory({ host: '127.0.0.1', port: instance.port }) };
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
