import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validRemoteInstanceId } from './remote-safety.mjs';

// Block 18: what CONTROL knows about the process of a remote instance, kept on this PC. It is the
// memory of which run and which process belong together; the truth about the process is read from
// the server each time. The file holds only the fixed fields below: no arguments, paths or secrets.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const STATUSES = ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'FAILED'];
const FIELDS = ['status', 'runId', 'pid', 'createdAt', 'startedAt', 'recoveryBlocked', 'exitReason'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Block 19: a Docker instance is identified by its container ID instead of pid and creation time.
// The key is optional and only written when set, so states of native instances keep their exact shape.
const OPTIONAL = ['containerId'];
const HEX64 = /^[a-f0-9]{64}$/;
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function checked(input, { stored = false } = {}) {
  const names = stored ? [...FIELDS, ...OPTIONAL, 'updatedAt'] : [...FIELDS, ...OPTIONAL];
  const given = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).filter(key => !(key === 'updatedAt' && !stored)) : null;
  if (!given || given.some(key => !names.includes(key)) || FIELDS.some(key => !(key in input))) fail('REMOTE_STATE_INVALID');
  const { status, runId, pid, createdAt, startedAt, recoveryBlocked, exitReason } = input;
  if (!STATUSES.includes(status) || (runId !== null && !(typeof runId === 'string' && UUID.test(runId)))) fail('REMOTE_STATE_INVALID');
  if (pid !== null && !(Number.isSafeInteger(pid) && pid > 1 && pid <= 4_194_304)) fail('REMOTE_STATE_INVALID');
  if (createdAt !== null && !(typeof createdAt === 'string' && /^[a-f0-9-]{36}:\d+$/.test(createdAt))) fail('REMOTE_STATE_INVALID');
  if (startedAt !== null && !isoTime(startedAt)) fail('REMOTE_STATE_INVALID');
  if (typeof recoveryBlocked !== 'boolean') fail('REMOTE_STATE_INVALID');
  if (exitReason !== null && !(typeof exitReason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(exitReason))) fail('REMOTE_STATE_INVALID');
  if (stored && !isoTime(input.updatedAt)) fail('REMOTE_STATE_INVALID');
  const containerId = input.containerId ?? null;
  if (containerId !== null && !(typeof containerId === 'string' && HEX64.test(containerId))) fail('REMOTE_STATE_INVALID');
  if (containerId !== null && (pid !== null || createdAt !== null)) fail('REMOTE_STATE_INVALID'); // one identity, never both
  return { status, runId, pid, createdAt, startedAt, recoveryBlocked, exitReason, ...(containerId ? { containerId } : {}), ...(stored ? { updatedAt: input.updatedAt } : {}) };
}

export class RemoteStateStore {
  constructor({ root }) { this.root = path.resolve(root); }
  file(id) {
    if (!validRemoteInstanceId(id)) fail('REMOTE_STATE_INVALID');
    return path.join(this.root, id, 'runtime-state.json');
  }
  // -> the stored state, or null when nothing is stored. A damaged file throws; it is never replaced
  // silently, because without it CONTROL cannot tell whether a process may still be running.
  async read(id) {
    const file = this.file(id);
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let document;
    try { document = JSON.parse(text); } catch { fail('REMOTE_STATE_INVALID'); }
    if (!document || document.version !== 1) fail('REMOTE_STATE_INVALID');
    return checked(document.state, { stored: true });
  }
  async write(id, state) {
    const file = this.file(id);
    const value = { ...checked(state), updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, state: value }, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temporary, file); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    return value;
  }
  async clear(id) { await fs.rm(this.file(id), { force: true }); }
}
