import path from 'node:path';
import { validHostId } from './remote-safety.mjs';
import { probeCommand, parseProbe } from './remote-commands.mjs';
import { openSession as realOpenSession, probeHostKey as realProbeHostKey } from './ssh-transport.mjs';

// Block 18: ties the host registry, the credential vault and the SSH transport
// together. The private key exists only inside one vault runtime scope: it is read,
// handed to the transport for the login and wiped afterwards.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const HEX64 = /^[0-9a-f]{64}$/;
const SUBJECT = /^ssh_([a-z][a-z0-9-]{0,39})$/;

// The vault knows an SSH host as the subject `ssh_<hostId>`. This resolver is the
// authoritative answer for such subjects (the instance registry answers for the rest).
export function sshSubjectResolver({ hosts, dataRoot }) {
  return id => {
    const match = SUBJECT.exec(typeof id === 'string' ? id : '');
    if (!match) fail('INSTANCE_NOT_FOUND');
    const host = hosts.get(match[1]); // throws REMOTE_HOST_NOT_FOUND
    return { id, homePath: path.join(path.resolve(dataRoot), 'ssh-hosts', host.id), createdAt: host.createdAt };
  };
}

export class RemoteHostService {
  constructor({ store, credentials, openSession = realOpenSession, probeHostKey = realProbeHostKey, audit = () => {}, readyTimeoutMs = 10_000 }) {
    Object.assign(this, { store, credentials, openSession, probe: probeHostKey, audit, readyTimeoutMs });
  }
  subject(hostId) {
    if (!validHostId(hostId)) fail('REMOTE_HOST_INVALID');
    return `ssh_${hostId}`;
  }
  async createHost(input) {
    const host = await this.store.create(input);
    this.audit('info', 'remote.host.created', { hostId: host.id });
    return host;
  }
  async removeHost(hostId) {
    await this.store.remove(hostId);
    // A stored key stays in the vault but can never be used again: the vault ties it to this
    // host's creation time, so a host added later under the same id does not inherit it.
    this.audit('info', 'remote.host.removed', { hostId });
  }
  // Reads the key the server presents. No login, no credentials.
  async probeHostKey(hostId) {
    const host = this.store.get(hostId);
    const presented = await this.probe(host, { readyTimeoutMs: this.readyTimeoutMs });
    this.audit('info', 'remote.host.key_probed', { hostId });
    return presented;
  }
  // Pins the key, but only if the server presents exactly the value the operator confirmed.
  async trustHostKey(hostId, expectedSha256Hex) {
    if (typeof expectedSha256Hex !== 'string' || !HEX64.test(expectedSha256Hex)) fail('REMOTE_HOST_INVALID');
    const host = this.store.get(hostId);
    const presented = await this.probe(host, { readyTimeoutMs: this.readyTimeoutMs });
    if (presented.sha256Hex !== expectedSha256Hex) fail('REMOTE_HOST_KEY_MISMATCH');
    const pinned = await this.store.pinHostKey(hostId, presented.sha256Hex);
    this.audit('info', 'remote.host.key_trusted', { hostId });
    return pinned;
  }
  // -> { session, uid, gid }. The login happens inside the vault scope; the host key is
  // checked by the transport before any login data is sent.
  async connect(hostId) {
    const host = this.store.get(hostId);
    const subject = this.subject(hostId);
    let session;
    try {
      session = await this.credentials.withRuntimeCredentials(subject, async ({ privateKey, passphrase }) => {
        if (!privateKey) fail('REMOTE_CREDENTIAL_MISSING');
        return this.openSession({ host, privateKey, passphrase: passphrase || undefined, readyTimeoutMs: this.readyTimeoutMs });
      });
    } catch (error) {
      this.audit('warn', 'remote.host.connect_failed', { hostId, code: error.code || 'REMOTE_CONNECT_FAILED' });
      throw error;
    }
    try {
      const identity = parseProbe((await session.exec(probeCommand(), { timeoutMs: 10_000 })).stdout);
      // The game core never runs as root.
      if (identity.uid === 0) fail('REMOTE_ROOT_BLOCKED');
      return { session, uid: identity.uid, gid: identity.gid };
    } catch (error) {
      session.close();
      this.audit('warn', 'remote.host.connect_failed', { hostId, code: error.code || 'REMOTE_CONNECT_FAILED' });
      throw error;
    }
  }
}
