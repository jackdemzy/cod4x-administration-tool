import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';

// Roadmap Block 12: B3 as a separate process per instance. Deliberately shares
// no state with the CoD4x runtime manager: a B3 crash, stop or restart never
// touches the server process and vice versa. Like the server, B3 is spawned
// detached (survives a backend restart) with shell:false.
const OUTPUT_LIMIT = 32 * 1024;
const HISTORY_LIMIT = 50;
const READY_MARKER = 'Start reading game events'; // b3/parser.py start()
const ERROR_MARKER = /\b(?:CRITICAL|Traceback \(most recent call last\))/;
// b3/parsers/q3a/rcon.py: logged when the CoD4x server does not answer RCON.
const RCON_FAILURE = /RCON: too many tries: aborting|RCON: error reading/;
const SENSITIVE_LINE = /(?:password|passwd|(?:master|auth|api|server)[_ -]?token|api[_ -]?key|secret|authorization|mysql:\/\/)/i;
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sanitize = text => redactRuntimeOutput(String(text || '')).split(/(?<=\n)/).map(line => SENSITIVE_LINE.test(line) ? '[sensitive line hidden]\n' : line).join('');
const bounded = text => text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function b3LaunchArguments({ b3Path, configPath }) {
  // No "-r": CONTROL owns the lifecycle; B3's own auto-restart would hide crashes.
  // -B: never write .pyc files into the audited source tree; -E: ignore PYTHON* env.
  return ['-B', '-E', path.join(b3Path, 'b3_run.py'), '--config', configPath];
}

// Linux: argv, owner and kernel start time from /proc (PID reuse protection).
export async function linuxProcessIdentity(pid, { readFile = fs.readFile } = {}) {
  try {
    const [cmdline, status, stat] = await Promise.all([readFile(`/proc/${pid}/cmdline`), readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
    const argv = cmdline.toString('utf8').split('\0').filter((value, index, all) => index < all.length - 1 || value);
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const zombie = fields[0] === 'Z';
    return { alive: !zombie, argv, uid, startTime: fields[19] || null };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { alive: false };
    return { alive: null, error: error.code || 'PROC_UNREADABLE' };
  }
}

export async function windowsProcessIdentity(pid, { execFileAsync = promisify(execFile) } = {}) {
  const command = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; if($p){[Console]::Out.Write((@{found=$true;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))}else{[Console]::Out.Write('{"found":false}')}`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(String(stdout || ''));
    return data.found ? { alive: true, commandLine: data.commandLine || '', startTime: data.createdAt || null } : { alive: false };
  } catch { return { alive: null, error: 'PROCESS_INSPECTION_FAILED' }; }
}

export function identityMatches(identity, expected, platform, uid) {
  if (!identity?.alive) return false;
  if (expected.startTime && identity.startTime !== expected.startTime) return false;
  if (platform === 'linux') return JSON.stringify(identity.argv) === JSON.stringify(expected.argv) && identity.uid === uid;
  const line = String(identity.commandLine || '').toLowerCase();
  return expected.argv.slice(1).every(argument => line.includes(String(argument).toLowerCase()));
}

export class B3Runtime {
  #child = null;
  #expectedStop = false;
  #busy = false;
  #waiters = new Set();
  constructor({ instanceId, platform, stateFile, paths, spawn = nodeSpawn, inspect = null, kill = (pid, signal) => process.kill(pid, signal),
    execFileAsync = promisify(execFile), onEvent = () => {}, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
    startupGraceMs = 3000, stopTimeoutMs = 10000, pollMs = 100 }) {
    Object.assign(this, { instanceId, platform, stateFile, paths, spawn, kill, execFileAsync, onEvent, getuid, startupGraceMs, stopTimeoutMs, pollMs });
    this.inspect = inspect || (pid => platform === 'linux' ? linuxProcessIdentity(pid) : windowsProcessIdentity(pid, { execFileAsync }));
    this.state = { version: 1, instanceId, status: 'STOPPED', pid: null, runId: null, startedAt: null, stoppedAt: null, exitCode: null, signal: null, expected: null, lastError: null, output: '', history: [] };
  }
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (raw?.version === 1 && raw.instanceId === this.instanceId) this.state = { ...this.state, ...raw, output: typeof raw.output === 'string' ? raw.output : '', history: Array.isArray(raw.history) ? raw.history.slice(0, HISTORY_LIMIT) : [] };
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await this.reconcile();
  }
  async persist() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, this.stateFile);
  }
  #event(event, details = {}) {
    const entry = { timestamp: new Date().toISOString(), event, instanceId: this.instanceId, runId: this.state.runId, pid: this.state.pid, ...details };
    this.state.history.unshift(entry);
    this.state.history.length = Math.min(this.state.history.length, HISTORY_LIMIT);
    this.onEvent(entry);
  }
  #append(chunk) { this.state.output = bounded(sanitize(this.state.output + chunk.toString('utf8'))); this.state.lastOutputAt = new Date().toISOString(); }
  #settle() { for (const resolve of this.#waiters) resolve(); this.#waiters.clear(); }
  async #exclusive(action) {
    if (this.#busy) fail('B3_RUNTIME_BUSY');
    this.#busy = true;
    try { return await action(); } finally { this.#busy = false; await this.persist().catch(() => {}); }
  }
  // Backend shutdown: drop the child handle without touching the detached process.
  release() { this.#child = null; }
  get running() { return ['STARTING', 'RUNNING', 'STOPPING'].includes(this.state.status) && Boolean(this.state.pid); }

  async start({ pythonPath, b3Path, configPath }) {
    return this.#exclusive(async () => {
      if (this.platform === 'linux' && this.getuid() === 0) fail('B3_ROOT_BLOCKED');
      await this.reconcile();
      if (this.running) fail('B3_ALREADY_RUNNING');
      const argv = b3LaunchArguments({ b3Path, configPath });
      const runId = crypto.randomUUID();
      Object.assign(this.state, { status: 'STARTING', runId, pid: null, exitCode: null, signal: null, lastError: null, startedAt: new Date().toISOString(), stoppedAt: null, output: '', lastOutputAt: null });
      let stdio = ['ignore', 'pipe', 'pipe'], handles = [];
      if (this.platform === 'linux') {
        // Files survive a backend restart; pipes would break B3's output.
        handles = await Promise.all([this.paths.stdout, this.paths.stderr].map(file => fs.open(file, 'w', 0o600)));
        stdio = ['ignore', handles[0].fd, handles[1].fd];
      }
      let child;
      try {
        child = await new Promise((resolve, reject) => {
          const value = this.spawn(pythonPath, argv, { cwd: b3Path, detached: true, windowsHide: true, shell: false, stdio, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: 'C.UTF-8', SYSTEMROOT: process.env.SYSTEMROOT || '' } });
          value.once('spawn', () => resolve(value));
          value.once('error', reject);
        });
      } catch (error) {
        Object.assign(this.state, { status: 'FAILED', lastError: 'B3_SPAWN_FAILED' });
        this.#event('b3.start.failed', { code: 'B3_SPAWN_FAILED', cause: error.code || null });
        fail('B3_SPAWN_FAILED');
      } finally { await Promise.all(handles.map(handle => handle.close())); }
      this.#child = child; this.#expectedStop = false;
      this.state.pid = child.pid;
      child.stdout?.on('data', chunk => this.#append(chunk));
      child.stderr?.on('data', chunk => this.#append(chunk));
      child.once('exit', (code, signal) => this.#exited(child, code, signal));
      child.unref?.();
      // Identity of exactly this run; later stops and reconciles compare against it.
      let identity = null;
      for (let attempt = 0; attempt < 20 && !identity?.alive; attempt++) { identity = await this.inspect(child.pid); if (!identity?.alive) await delay(this.pollMs); }
      this.state.expected = { argv: [pythonPath, ...argv], startTime: identity?.startTime || null };
      this.#event('b3.starting', {});
      // B3 exits with 220 on critical startup errors after ~2 s; do not claim RUNNING early.
      await Promise.race([new Promise(resolve => this.#waiters.add(resolve)), delay(this.startupGraceMs)]);
      if (this.state.status !== 'STARTING') fail('B3_START_FAILED', { exitCode: this.state.exitCode, output: await this.outputTail() });
      if (!identityMatches(await this.inspect(child.pid), this.state.expected, this.platform, this.getuid())) {
        this.#expectedStop = true; child.kill();
        Object.assign(this.state, { status: 'FAILED', lastError: 'B3_IDENTITY_MISMATCH' });
        fail('B3_IDENTITY_MISMATCH');
      }
      this.state.status = 'RUNNING';
      this.#event('b3.started', {});
      return this.snapshot();
    });
  }
  #exited(child, code, signal) {
    if (child !== this.#child) return; // late exit of an older run
    this.#child = null;
    const expected = this.#expectedStop || this.state.status === 'STOPPING';
    Object.assign(this.state, { exitCode: code, signal, stoppedAt: new Date().toISOString(), status: expected ? 'STOPPED' : this.state.status === 'STARTING' ? 'FAILED' : 'CRASHED', lastError: expected ? null : 'B3_PROCESS_EXITED' });
    this.#event(expected ? 'b3.stopped' : this.state.status === 'FAILED' ? 'b3.start.failed' : 'b3.crashed', { exitCode: code, signal, expected });
    this.state.pid = null;
    this.persist().catch(() => {});
    this.#settle();
  }
  // Without a child handle (backend restarted), only /proc or CIM decide.
  async reconcile() {
    if (!this.running || this.#child) return this.snapshot();
    const identity = await this.inspect(this.state.pid);
    if (identity?.alive === null) { this.state.lastError = 'B3_INSPECTION_FAILED'; return this.snapshot(); }
    if (identityMatches(identity, this.state.expected || {}, this.platform, this.getuid())) return this.snapshot();
    Object.assign(this.state, { status: 'LOST', exitCode: null, stoppedAt: new Date().toISOString(), lastError: 'B3_PROCESS_LOST' });
    this.#event('b3.lost', {});
    this.state.pid = null;
    await this.persist().catch(() => {});
    return this.snapshot();
  }
  async stop(reason = 'manual') {
    return this.#exclusive(() => this.#stopUnlocked(reason));
  }
  async #stopUnlocked(reason) {
    await this.reconcile();
    if (!this.running) { if (['RUNNING', 'STARTING'].includes(this.state.status)) this.state.status = 'STOPPED'; return this.snapshot(); }
    const pid = this.state.pid;
    // Never signal a PID that is not provably this B3 run.
    if (!identityMatches(await this.inspect(pid), this.state.expected || {}, this.platform, this.getuid())) fail('B3_IDENTITY_MISMATCH');
    this.#expectedStop = true;
    this.state.status = 'STOPPING';
    this.#event('b3.stopping', { reason });
    const gone = async timeout => {
      for (const until = Date.now() + timeout; Date.now() < until;) { const identity = await this.inspect(pid); if (identity?.alive === false || !identityMatches(identity, this.state.expected, this.platform, this.getuid())) return true; await delay(this.pollMs); }
      return false;
    };
    const graceful = () => this.platform === 'linux' ? this.kill(pid, 'SIGTERM') : this.execFileAsync('taskkill.exe', ['/PID', String(pid), '/T'], { windowsHide: true }).catch(() => {});
    const forced = () => this.platform === 'linux' ? this.kill(pid, 'SIGKILL') : this.execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    try { await graceful(); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    let stopped = await gone(this.stopTimeoutMs);
    if (!stopped) {
      // Re-check identity right before forcing.
      if (identityMatches(await this.inspect(pid), this.state.expected, this.platform, this.getuid())) { try { await forced(); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      stopped = await gone(3000);
    }
    if (!stopped) { this.state.status = 'RUNNING'; this.#expectedStop = false; fail('B3_STOP_FAILED'); }
    if (this.#child) await Promise.race([new Promise(resolve => this.#waiters.add(resolve)), delay(1000)]);
    Object.assign(this.state, { status: 'STOPPED', pid: null, stoppedAt: this.state.stoppedAt || new Date().toISOString() });
    if (!this.state.history.some(entry => entry.event === 'b3.stopped' && entry.runId === this.state.runId)) this.#event('b3.stopped', { expected: true, forced: !stopped });
    return this.snapshot();
  }
  async restart(options) {
    if (this.running) await this.stop('restart');
    return this.start(options);
  }
  async outputTail() {
    let text = this.state.output;
    if (this.platform === 'linux') {
      for (const file of [this.paths.stdout, this.paths.stderr]) text += await readTail(file);
    }
    return bounded(sanitize(text));
  }
  // Health: process identity plus B3's own log markers. Never touches CoD4x.
  async health() {
    await this.reconcile();
    const log = sanitize(await readTail(this.paths.logFile));
    const identity = this.running ? await this.inspect(this.state.pid) : null;
    const alive = this.running && identityMatches(identity, this.state.expected || {}, this.platform, this.getuid());
    const ready = log.includes(READY_MARKER), errors = ERROR_MARKER.test(log);
    // RCON failures are reported separately: B3 keeps running without the server.
    const rcon = !alive ? null : RCON_FAILURE.test(log.slice(-4096)) ? 'UNREACHABLE' : 'NO_RECENT_ERRORS';
    const status = !this.running ? 'DOWN' : !alive ? 'UNKNOWN' : this.state.status === 'STARTING' ? 'STARTING' : errors ? 'DEGRADED' : ready ? 'HEALTHY' : 'STARTING';
    return { status, alive, ready, errors, rcon, uptimeSec: alive && this.state.startedAt ? Math.round((Date.now() - Date.parse(this.state.startedAt)) / 1000) : null, logTail: log.slice(-4096) };
  }
  snapshot() {
    const { expected, output, ...rest } = this.state;
    return structuredClone({ ...rest, running: this.running });
  }
}

async function readTail(file, limit = OUTPUT_LIMIT) {
  let handle;
  try {
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) return '';
    handle = await fs.open(file, 'r');
    const start = Math.max(0, stats.size - limit), buffer = Buffer.alloc(Math.min(limit, stats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch { return ''; } finally { await handle?.close(); }
}
