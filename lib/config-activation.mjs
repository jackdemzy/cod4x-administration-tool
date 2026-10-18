import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Records which server.cfg fingerprint a run was started with, so CONTROL can
// tell "file changed" apart from "running server uses the change".
const MAX_BYTES = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const activeStatuses = ['STARTING', 'RUNNING', 'STOPPING'];

function activationFile(instance) { return path.join(instance.homePath, 'logs', 'config-activation.json'); }

async function safeLogsDirectory(instance) {
  const directory = path.dirname(activationFile(instance));
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), path.resolve(directory))) {
    throw Object.assign(new Error('Unsafe configuration activation directory.'), { code: 'CONFIG_ACTIVATION_INVALID' });
  }
  return directory;
}

export async function recordConfigActivation(instance, { sha256, runId, pid }) {
  if (!SHA256.test(sha256 || '') || typeof runId !== 'string' || !runId || !Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(new Error('Invalid configuration activation record.'), { code: 'CONFIG_ACTIVATION_INVALID' });
  }
  try { await safeLogsDirectory(instance); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(path.dirname(activationFile(instance)), { recursive: true }); await safeLogsDirectory(instance); }
  const file = activationFile(instance), temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const record = { version: 1, instanceId: instance.id, sha256, runId, pid, startedAt: new Date().toISOString() };
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600); created = true;
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file); created = false;
  } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  return record;
}

export async function readConfigActivation(instance) {
  try {
    await safeLogsDirectory(instance);
    const file = activationFile(instance), stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_BYTES) return { valid: false };
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!record || record.version !== 1 || record.instanceId !== instance.id || !SHA256.test(record.sha256 || '') || typeof record.runId !== 'string' ||
        !Number.isSafeInteger(record.pid) || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) return { valid: false };
    return { valid: true, record };
  } catch (error) {
    if (error.code === 'ENOENT') return { valid: true, record: null };
    return { valid: false };
  }
}

// States: ACTIVE, RESTART_REQUIRED, UNKNOWN (running without matching record), STOPPED.
export function describeConfigActivation(activation, runtimeState, currentSha256) {
  const record = activation?.valid ? activation.record : null;
  const running = Boolean(runtimeState?.pid) || activeStatuses.includes(runtimeState?.status);
  const changedSinceLastStart = record && currentSha256 ? record.sha256 !== currentSha256 : null;
  const base = { activeSha256: record?.sha256 || null, startedAt: record?.startedAt || null, changedSinceLastStart };
  if (!running) return { ...base, state: 'STOPPED', restartRequired: false };
  if (!record || record.runId !== runtimeState.runId || record.pid !== runtimeState.pid) return { ...base, state: 'UNKNOWN', restartRequired: null };
  return { ...base, state: changedSinceLastStart ? 'RESTART_REQUIRED' : 'ACTIVE', restartRequired: Boolean(changedSinceLastStart) };
}
