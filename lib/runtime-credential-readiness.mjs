import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const fail = code => { throw Object.assign(new Error(code), { code }); };
function abort(signal) { if (signal.aborted) fail('CREDENTIAL_RUNTIME_ABORTED'); }
const prefix = Buffer.from([255,255,255,255]);

async function exchange(port, command, responsePrefix, signal, timeoutMs) {
  abort(signal);
  const socket = dgram.createSocket('udp4');
  const packet = Buffer.concat([prefix, command]);
  const expected = Buffer.from(responsePrefix);
  try {
    return await new Promise((resolve, reject) => {
      let done = false, messages = 0;
      const finish = (code, value) => {
        if (done) { value?.fill(0); return; }
        done = true; clearTimeout(timer); signal.removeEventListener('abort', cancelled);
        try { socket.close(); } catch {}
        if (code) reject(Object.assign(new Error(code), { code })); else resolve(value);
      };
      const cancelled = () => finish('CREDENTIAL_RUNTIME_ABORTED');
      const timer = setTimeout(() => finish('CREDENTIAL_RUNTIME_QUERY_TIMEOUT'), timeoutMs);
      socket.once('error', () => finish('CREDENTIAL_RUNTIME_QUERY_FAILED'));
      socket.on('message', bytes => {
        // Connected UDP filters peer address/port. Still bound both payload and
        // invalid packet count, and never forward response text to diagnostics.
        const valid = bytes.length <= 16384 && bytes.length >= 4 + expected.length && bytes.subarray(0,4).equals(prefix) && bytes.subarray(4,4 + expected.length).equals(expected);
        const body = valid ? Buffer.from(bytes.subarray(4 + expected.length)) : null;
        bytes.fill(0);
        if (valid) finish(null, body);
        else if (++messages >= 8) finish('CREDENTIAL_RUNTIME_QUERY_INVALID');
      });
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      socket.connect(port, '127.0.0.1', () => {
        if (done) { try { socket.close(); } catch {} return; }
        if (signal.aborted) { cancelled(); return; }
        socket.send(packet, error => { if (error) finish('CREDENTIAL_RUNTIME_QUERY_FAILED'); });
      });
    });
  } finally { packet.fill(0); }
}

function infoFields(bytes) {
  const fields = bytes.toString('utf8').replace(/[\r\n]+$/, '').split('\\');
  if (fields.shift() !== '' || fields.length % 2 !== 0) return null;
  const result = Object.create(null);
  for (let index = 0; index < fields.length; index += 2) {
    if (!fields[index] || Object.hasOwn(result, fields[index])) return null;
    result[fields[index]] = fields[index + 1];
  }
  return result;
}

// Internal startup gate only, not an arbitrary command/remote-host interface.
// Caller must independently verify the owning PID/home/port/birth and keep the
// vault lease alive. This observes a Join flag, not full client authentication.
export async function waitForCredentialRuntime({ port, rcon, joinRequired, signal, map = 'mp_backlot', timeoutMs = 30000, attemptTimeoutMs = 1000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Buffer.isBuffer(rcon) || rcon.length < 8 || rcon.length > 128 ||
      rcon.some(byte => byte < 33 || byte > 126 || [34,59,92].includes(byte)) || typeof joinRequired !== 'boolean' ||
      !signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 || !Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 20 || attemptTimeoutMs > 2000 ||
      typeof map !== 'string' || !/^mp_[a-z0-9_]{1,64}$/.test(map)) fail('CREDENTIAL_RUNTIME_READINESS_INVALID');
  abort(signal);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    abort(signal);
    let info, status, query, authenticated;
    try {
      const challenge = randomBytes(12).toString('hex');
      query = Buffer.from(`getinfo ${challenge}`);
      info = await exchange(port, query, 'infoResponse\n', signal, Math.max(1, Math.min(attemptTimeoutMs, deadline - performance.now())));
      const fields = infoFields(info);
      if (fields?.challenge !== challenge || !['0','1'].includes(fields?.pswrd) || (fields.pswrd === '1') !== joinRequired) throw new Error('NOT_READY');
      abort(signal);
      authenticated = Buffer.concat([Buffer.from('rcon '), rcon, Buffer.from(' status\n')]);
      if (performance.now() >= deadline) break;
      status = await exchange(port, authenticated, 'print\n', signal, Math.max(1, Math.min(attemptTimeoutMs, deadline - performance.now())));
      abort(signal);
      const text = status.toString('utf8');
      if (/Bad rcon|No rconpassword/i.test(text) || !new RegExp(`(?:^|\\n)map\\s*:\\s*${map}(?:\\s|$)`).test(text)) throw new Error('NOT_READY');
      return { rconAuthenticated: true, joinPasswordFlag: joinRequired, map };
    } catch {
      abort(signal); // Preserve cancellation, not a raw socket/parser error.
    } finally {
      query?.fill(0); authenticated?.fill(0); info?.fill(0); status?.fill(0);
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      try { await delay(Math.min(75, remaining), undefined, { signal }); }
      catch { abort(signal); }
    }
  }
  abort(signal);
  fail('CREDENTIAL_RUNTIME_READINESS_TIMEOUT');
}
