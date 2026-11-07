import ssh2 from 'ssh2';

// Block 18: the one place that talks SSH. Public-key login only; the host key
// is checked before any login data is sent. The module keeps no state of its own:
// the caller owns (and wipes) the key buffer.
const { Client } = ssh2;

function remoteError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Client-side errors from ssh2 carry a `level`; only the code is passed on.
function mapConnectError(error) {
  if (error?.level === 'client-authentication') return remoteError('REMOTE_AUTH_FAILED');
  if (error?.level === 'client-timeout') return remoteError('REMOTE_TIMEOUT');
  return remoteError('REMOTE_CONNECT_FAILED');
}

const base64Fingerprint = hex => Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');

class RemoteSession {
  #client;
  constructor(client, hostKeySha256) {
    this.#client = client;
    this.hostKeySha256 = hostKeySha256;
  }
  // Runs one command string on the remote server through ssh2's Client#exec (this is
  // not child_process). The string is built only by lib/remote-commands.mjs from fixed
  // words and shellQuote()d values. stdout and stderr together are limited to maxBytes;
  // hitting the limit or the time closes the channel.
  exec(command, { timeoutMs = 30_000, maxBytes = 256 * 1024 } = {}) {
    if (typeof command !== 'string' || !command || command.includes('\u0000')) throw remoteError('REMOTE_ARGUMENT_INVALID');
    return new Promise((resolve, reject) => {
      this.#client.exec(command, (error, stream) => {
        if (error) return reject(remoteError('REMOTE_CONNECT_FAILED'));
        const stdout = [], stderr = [];
        let kept = 0, truncated = false, finished = false;
        const finish = (settle, value) => { if (finished) return; finished = true; clearTimeout(timer); settle(value); };
        const timer = setTimeout(() => { stream.close(); finish(reject, remoteError('REMOTE_TIMEOUT')); }, timeoutMs);
        const collect = target => chunk => {
          const room = maxBytes - kept;
          if (room <= 0) return;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          kept += part.length;
          target.push(Buffer.from(part));
          if (part.length < chunk.length) { truncated = true; stream.close(); }
        };
        stream.on('data', collect(stdout));
        stream.stderr.on('data', collect(stderr));
        stream.on('error', () => finish(reject, remoteError('REMOTE_CONNECT_FAILED')));
        // code -1: the channel was closed by the limit or the server sent no exit status
        stream.on('close', (code, signal) => finish(resolve, {
          code: typeof code === 'number' ? code : -1, signal: signal || null,
          stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated,
        }));
      });
    });
  }
  // The raw ssh2 SFTP object; lib/remote-linux-runtime.mjs builds a file system on top of it.
  sftp() {
    return new Promise((resolve, reject) => {
      this.#client.sftp((error, sftp) => (error ? reject(remoteError('REMOTE_SFTP_UNAVAILABLE')) : resolve(sftp)));
    });
  }
  close() { this.#client.end(); }
}

// host: { host, port, username, hostKeySha256 | null }. A host without a pinned
// key, or with a different key, is refused in hostVerifier, i.e. before any login.
export function openSession({ host, privateKey, passphrase, readyTimeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented = null, rejection = null, settled = false;
    const settle = (action, value) => { if (settled) return; settled = true; action(value); };
    client.on('ready', () => settle(resolve, new RemoteSession(client, presented)));
    client.on('error', error => { client.end(); settle(reject, rejection || mapConnectError(error)); });
    client.on('close', () => settle(reject, rejection || remoteError('REMOTE_CONNECT_FAILED')));
    try {
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        privateKey,
        // ssh2 only accepts a string here; it is not kept beyond the login.
        passphrase: passphrase ? Buffer.from(passphrase).toString('utf8') : undefined,
        readyTimeout: readyTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (hash, verify) => {
          presented = hash;
          if (!host.hostKeySha256) {
            rejection = remoteError('REMOTE_HOST_KEY_UNVERIFIED', { presentedSha256: hash });
            return verify(false);
          }
          if (hash !== host.hostKeySha256) {
            rejection = remoteError('REMOTE_HOST_KEY_CHANGED', { presentedSha256: hash, pinnedSha256: host.hostKeySha256 });
            return verify(false);
          }
          verify(true);
        },
      });
    } catch { settle(reject, remoteError('REMOTE_CONNECT_FAILED')); }
  });
}

// Reads the key the server presents and stops. It never logs in.
export function probeHostKey(host, { readyTimeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const settle = (action, value) => { if (settled) return; settled = true; client.end(); action(value); };
    client.on('error', error => settle(reject, mapConnectError(error)));
    client.on('close', () => settle(reject, remoteError('REMOTE_CONNECT_FAILED')));
    try {
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: readyTimeoutMs,
        hostHash: 'sha256',
        hostVerifier: (hash, verify) => {
          // report first: refusing the key closes the connection at once
          settle(resolve, { sha256Hex: hash, sha256Base64: base64Fingerprint(hash) });
          verify(false);
        },
      });
    } catch { settle(reject, remoteError('REMOTE_CONNECT_FAILED')); }
  });
}
