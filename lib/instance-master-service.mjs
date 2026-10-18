import { readInstanceConsoleLog } from './instance-console-log.mjs';
import { RconClient } from './rcon-client.mjs';
import { fetchMasterList, matchMasterListing, tokenHash } from './master-list.mjs';

// Roadmap Block 8 states. HEARTBEAT_OK / HEARTBEAT_LOST come only from external
// evidence (Block 9 master list verification): CoD4x logs heartbeats and successful
// registration only with developer output (Com_DPrintf), which CONTROL never enables.
export const MASTER_STATES = Object.freeze(['NOT_CONFIGURED', 'TOKEN_CONFIGURED', 'REGISTERING', 'REGISTERED', 'REGISTRATION_FAILED', 'HEARTBEAT_OK', 'HEARTBEAT_LOST', 'UNKNOWN']);

// Exact console messages of CoD4x_Server src/sv_main.c (SV_HeartBeatMessageLoop,
// SV_SendReceiveHeartbeatTCP, SV_CreateAndSendMasterheartbeatMessage, SV_MasterHeartbeatInit).
const MESSAGES = Object.freeze([
  ['Server is registered on the masterserver', 'REGISTERED', 'MASTER_REGISTERED'],
  ['Server address is banned', 'FAILED', 'MASTER_ADDRESS_BANNED'],
  ['Failure registering server on masterserver. Errorcode', 'FAILED', 'MASTER_REJECTED'],
  ['sv_authtoken is invalid', 'FAILED', 'MASTER_TOKEN_INVALID'],
  ['Server needs to provide a valid token in cvar sv_authtoken', 'FAILED', 'MASTER_TOKEN_MISSING'],
  ['Connection to masterserver timeout', 'FAILED', 'MASTER_TIMEOUT'],
  ['Invalid or empty response from masterserver', 'FAILED', 'MASTER_RESPONSE_INVALID'],
  ['Corrupted Masterserver response', 'FAILED', 'MASTER_RESPONSE_INVALID'],
  ["Couldn't resolve masterserver", 'FAILED', 'MASTER_UNRESOLVED'],
  ['Masterserver needs token to complete registration', 'REGISTERING', 'MASTER_TOKEN_REQUESTED'],
  ["Masterserver didn't load token database yet", 'REGISTERING', 'MASTER_TOKEN_DATABASE_PENDING'],
  ['Bad challenge! Retrying', 'REGISTERING', 'MASTER_CHALLENGE_RETRY'],
  ['Sending master heartbeat', 'REGISTERING', 'MASTER_HEARTBEAT_SENT'],
]);

// The latest relevant line wins. Returns only fixed codes, never log text.
export function classifyMasterLog(text) {
  let result = { outcome: null, code: null };
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = MESSAGES.find(([message]) => line.includes(message));
    if (match) result = { outcome: match[1], code: match[2] };
  }
  return result;
}

// tokenConfigured: true/false from the vault, null when locked/unknown.
// transfer: whether the current run received sv_authtoken (PROVISIONED, NOT_CONFIGURED, VAULT_LOCKED, UNKNOWN).
// listing: master list verification of the current run (Block 9), or null.
export function describeMasterStatus({ tokenConfigured, running, transfer, networkScope, log, listing = null, seenAliveThisRun = false }) {
  const base = { tokenConfigured, transfer: running ? transfer : null, networkScope, verified: Boolean(running && listing?.listed === true) };
  // Registration is optional: every state below leaves the local server running.
  if (!running) {
    if (tokenConfigured === true) return { ...base, state: 'TOKEN_CONFIGURED', reason: 'SERVER_STOPPED' };
    if (tokenConfigured === false) return { ...base, state: 'NOT_CONFIGURED', reason: 'MASTER_TOKEN_NOT_CONFIGURED' };
    return { ...base, state: 'UNKNOWN', reason: 'VAULT_LOCKED' };
  }
  const evidence = log?.outcome ? log : null;
  // Listing is the strongest, externally observed evidence of the current run.
  if (listing?.listed === true) return { ...base, state: listing.alive ? 'HEARTBEAT_OK' : 'HEARTBEAT_LOST', reason: listing.code };
  if (listing?.listed === false && seenAliveThisRun) return { ...base, state: 'HEARTBEAT_LOST', reason: 'MASTER_LIST_MISSING' };
  if (transfer !== 'PROVISIONED') {
    // CoD4x reports a missing token itself; anything else stays unproven.
    if (evidence?.code === 'MASTER_TOKEN_MISSING' || transfer === 'NOT_CONFIGURED') return { ...base, state: 'NOT_CONFIGURED', reason: transfer === 'VAULT_LOCKED' ? 'VAULT_LOCKED_AT_START' : 'MASTER_TOKEN_NOT_CONFIGURED' };
    return { ...base, state: tokenConfigured === true ? 'TOKEN_CONFIGURED' : 'UNKNOWN', reason: transfer === 'VAULT_LOCKED' ? 'VAULT_LOCKED_AT_START' : 'RUN_TRANSFER_UNKNOWN' };
  }
  if (evidence?.outcome === 'FAILED') return { ...base, state: 'REGISTRATION_FAILED', reason: evidence.code };
  if (evidence?.outcome === 'REGISTERED') return { ...base, state: 'REGISTERED', reason: evidence.code };
  // sv_main.c SV_SendHeartbeatThread skips 127.x / fe80+ sources: a loopback-only
  // server never sends a master heartbeat, so it cannot register.
  if (networkScope === 'LOOPBACK') return { ...base, state: 'TOKEN_CONFIGURED', reason: 'LOOPBACK_BINDING' };
  // Not (yet) listed: unreachable master, port mismatch, NAT/firewall or pending heartbeat.
  if (listing && listing.listed !== true) return { ...base, state: 'REGISTERING', reason: listing.code };
  return { ...base, state: 'REGISTERING', reason: evidence?.code || 'MASTER_AWAITING_RESPONSE' };
}

export class InstanceMasterService {
  #resolveInstance; #runtimeFor; #credentials; #audit; #readLog; #fetchList; #probeLocal;
  #runs = new Map();
  #reported = new Map();
  #listings = new Map();
  #verifying = new Set();
  constructor({ resolveInstance, runtimeFor, credentialService, audit = () => {}, readLog = homePath => readInstanceConsoleLog(homePath, { inspect: classifyMasterLog }),
    fetchList = () => fetchMasterList(), probeLocal = port => new RconClient({ port }).probe() }) {
    if (typeof resolveInstance !== 'function' || typeof runtimeFor !== 'function') throw Object.assign(new Error('MASTER_UNAVAILABLE'), { code: 'MASTER_UNAVAILABLE' });
    this.#resolveInstance = resolveInstance; this.#runtimeFor = runtimeFor; this.#credentials = credentialService; this.#audit = audit; this.#readLog = readLog;
    this.#fetchList = fetchList; this.#probeLocal = probeLocal;
  }
  #listingFor(id, runId) {
    const value = this.#listings.get(id);
    return value && value.runId === runId ? value : null;
  }
  // Explicit operator action: one outbound HTTPS request to the fixed master list URL.
  async verify(id, actor = null) {
    const instance = this.#resolveInstance(id);
    if (!instance || instance.id !== id) throw Object.assign(new Error('INSTANCE_NOT_FOUND'), { code: 'INSTANCE_NOT_FOUND' });
    if (this.#verifying.has(id)) throw Object.assign(new Error('MASTER_VERIFY_BUSY'), { code: 'MASTER_VERIFY_BUSY' });
    this.#verifying.add(id);
    try {
      const runtime = await this.#runtimeFor(id);
      try { await runtime.reconcileRuntimeState(); } catch { /* Keep the last known runtime state. */ }
      const state = runtime.state || {};
      const checkedAt = new Date().toISOString();
      let listing;
      if (state.status !== 'RUNNING' || !state.pid) listing = { listed: false, code: 'SERVER_NOT_RUNNING' };
      else if ((instance.network?.scope || 'LOOPBACK') !== 'PUBLIC') listing = { listed: false, code: 'LOOPBACK_BINDING' };
      else {
        let local = null;
        try { local = await this.#probeLocal(instance.port); } catch { local = null; }
        let expectedTokenHash = null;
        try {
          const buffer = await this.#credentials?.resolve(id, 'master');
          if (buffer) { expectedTokenHash = tokenHash(buffer); buffer.fill(0); }
        } catch { expectedTokenHash = null; }
        try {
          const list = await this.#fetchList();
          listing = { ...matchMasterListing(list, { port: instance.port, publicAddress: instance.network.publicAddress, local, tokenHash: expectedTokenHash }), masterTime: list.masterTime, serverCount: list.serverCount, localReachable: Boolean(local) };
        } catch (error) {
          listing = { listed: null, code: ['MASTER_LIST_UNREACHABLE', 'MASTER_LIST_INVALID'].includes(error.code) ? error.code : 'MASTER_LIST_UNREACHABLE' };
        }
      }
      const previous = this.#listingFor(id, state.runId);
      const lastSeenAt = listing.listed === true && listing.alive ? checkedAt : previous?.lastSeenAt || null;
      const record = { ...listing, runId: state.runId || null, checkedAt, lastSeenAt };
      this.#listings.set(id, record);
      this.#audit(listing.listed === true ? 'info' : 'warn', 'master.list.verified', { instanceId: id, runId: record.runId, actor, listed: listing.listed, code: listing.code, matchedBy: listing.matchedBy || null });
      if (listing.listed === true && listing.alive) this.#audit('info', 'master.heartbeat.detected', { instanceId: id, runId: record.runId, matchedBy: listing.matchedBy });
      else if (previous?.lastSeenAt) this.#audit('warn', 'master.heartbeat.lost', { instanceId: id, runId: record.runId, code: listing.code });
      return this.status(id);
    } finally { this.#verifying.delete(id); }
  }
  // Called by the launch path with what this run received. Never the token.
  recordProvisioning(id, runId, transfer, actor = null) {
    this.#runs.set(id, { runId, transfer });
    if (transfer === 'PROVISIONED') this.#audit('info', 'master.registration.started', { instanceId: id, runId, actor });
  }
  async status(id) {
    const instance = this.#resolveInstance(id);
    if (!instance || instance.id !== id) throw Object.assign(new Error('INSTANCE_NOT_FOUND'), { code: 'INSTANCE_NOT_FOUND' });
    const runtime = await this.#runtimeFor(id);
    try { await runtime.reconcileRuntimeState(); } catch { /* Keep the last known runtime state. */ }
    const state = runtime.state || {};
    const running = state.status === 'RUNNING' && Boolean(state.pid);
    let tokenConfigured = null;
    try { tokenConfigured = this.#credentials ? (await this.#credentials.instanceStatus(id)).master?.configured ?? null : null; } catch { tokenConfigured = null; }
    const run = this.#runs.get(id);
    const transfer = run && run.runId === state.runId ? run.transfer : 'UNKNOWN';
    const console = running ? await this.#readLog(instance.homePath) : null;
    // Binding as passed by ServerInstanceManager.launch: loopback unless explicitly public.
    const networkScope = instance.network?.scope === 'PUBLIC' ? 'PUBLIC' : 'LOOPBACK';
    const listing = running ? this.#listingFor(id, state.runId) : null;
    const result = describeMasterStatus({ tokenConfigured, running, transfer, networkScope, log: console?.inspection || null, listing, seenAliveThisRun: Boolean(listing?.lastSeenAt) });
    this.#report(id, state.runId, result);
    const list = listing ? { listed: listing.listed, code: listing.code, matchedBy: listing.matchedBy || null, alive: listing.alive ?? null, identityMatch: listing.identityMatch ?? null, tokenHashMatch: listing.tokenHashMatch ?? null,
      entry: listing.entry || null, listedPorts: listing.listedPorts || [], masterTime: listing.masterTime || null, checkedAt: listing.checkedAt, lastSeenAt: listing.lastSeenAt } : null;
    // Roadmap UI summary: Registration / Heartbeat / Listed / Last seen.
    const summary = {
      registration: result.state === 'REGISTRATION_FAILED' ? false : ['REGISTERED', 'HEARTBEAT_OK', 'HEARTBEAT_LOST'].includes(result.state) ? true : null,
      heartbeat: result.state === 'HEARTBEAT_OK' ? true : result.state === 'HEARTBEAT_LOST' ? false : null,
      listed: list ? list.listed : null, lastSeenAt: list?.lastSeenAt || null,
    };
    return { instanceId: id, runId: running ? state.runId : null, logStatus: console?.status || null, ...result, publicAddress: instance.network?.publicAddress || null, list, summary };
  }
  // One audit event per run and observed outcome; polling never floods the log.
  #report(id, runId, result) {
    // Heartbeat events are emitted by verify(); here only log-derived registration outcomes.
    const event = result.state === 'REGISTRATION_FAILED' ? 'master.registration.failed' : result.state === 'REGISTERED' ? 'master.registration.succeeded' : null;
    if (!event || !runId) return;
    const key = `${runId}:${event}:${result.reason}`;
    if (this.#reported.get(id) === key) return;
    this.#reported.set(id, key);
    this.#audit(event === 'master.registration.failed' ? 'warn' : 'info', event, { instanceId: id, runId, code: result.reason });
  }
}
