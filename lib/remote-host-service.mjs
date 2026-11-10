import path from 'node:path';
import { validHostId } from './remote-safety.mjs';
import { probeCommand, parseProbe } from './remote-commands.mjs';
import { openSession as realOpenSession, probeHostKey as realProbeHostKey } from './ssh-transport.mjs';
import { dockerProbeCommand, parseDockerProbe, imageInspectCommand, parseImageInspect, imageBuildCommand } from './docker-commands.mjs';
import { DOCKERFILE, DOCKERFILE_SHA256, IMAGE_TAG } from './docker-image.mjs';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';

// Block 18: ties the host registry, the credential vault and the SSH transport
// together. The private key exists only inside one vault runtime scope: it is read,
// handed to the transport for the login and wiped afterwards.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BUILD_OUTPUT_BYTES = 4096;
// The end of what `docker build` printed, as valid text of at most MAX_BUILD_OUTPUT_BYTES bytes, secrets blacked out.
function buildOutput(result) {
  const all = Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)]);
  let bytes = Buffer.from(redactRuntimeOutput(all.subarray(Math.max(0, all.length - MAX_BUILD_OUTPUT_BYTES)).toString('utf8')).replace(/^\ufffd+/, ''));
  let cut = Math.max(0, bytes.length - MAX_BUILD_OUTPUT_BYTES);
  while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut++;
  return bytes.subarray(cut).toString('utf8');
}
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

// Block 19. Membership in the docker group lets the SSH user become root on that host; the operator
// confirms that with this exact word (same pattern as PUBLIC_EXPOSURE).
export const DOCKER_ROOTFUL_CONFIRMATION = 'DOCKER_ROOT_EQUIVALENT';
const DOCKER_NOTES = { ROOTFUL: 'ROOTFUL_ROOT_EQUIVALENT', ROOTLESS: 'ROOTLESS_SOURCE_ADDRESS', NO_DOCKER: null };

async function probeDocker(session) {
  return parseDockerProbe(await session.exec(dockerProbeCommand(), { timeoutMs: 15_000 }));
}
// -> { id, current } of the runtime image, or null when the tag does not exist.
export async function runtimeImage(session) {
  const image = parseImageInspect(await session.exec(imageInspectCommand(IMAGE_TAG), { timeoutMs: 15_000 }));
  return image && { id: image.id, current: image.dockerfile === DOCKERFILE_SHA256 };
}

// What must hold before a Docker instance is installed, switched to or started: the host still
// reaches Docker the way the operator confirmed, and (image: true) the runtime image exists and was
// built from this version's Dockerfile. -> { mode, imageId }
export async function assertDockerReady(session, host, { image = true } = {}) {
  if (!host.docker) fail('REMOTE_DOCKER_NOT_CONFIRMED');
  const { mode } = await probeDocker(session);
  if (mode === 'NO_DOCKER') fail('REMOTE_DOCKER_UNAVAILABLE');
  if (mode !== host.docker.mode) fail('REMOTE_DOCKER_MODE_CHANGED');
  if (!image) return { mode, imageId: null };
  const found = await runtimeImage(session);
  if (!found?.current) fail('REMOTE_DOCKER_IMAGE_MISSING');
  return { mode, imageId: found.id };
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
  // ---- Block 19: Docker on a host -----------------------------------------------------------------
  async #withSession(hostId, action) {
    const { session } = await this.connect(hostId);
    try { return await action(session); } finally { session.close(); }
  }
  // Read-only. image: PRESENT (built from this version's Dockerfile), OUTDATED (the tag exists, from
  // another Dockerfile), MISSING, or null without Docker.
  async dockerStatus(hostId) {
    const host = this.store.get(hostId);
    return this.#withSession(hostId, async session => {
      const { mode, version } = await probeDocker(session);
      let image = null;
      if (mode !== 'NO_DOCKER') {
        const found = await runtimeImage(session).catch(() => null);
        image = !found ? 'MISSING' : found.current ? 'PRESENT' : 'OUTDATED';
      }
      return { mode, version, confirmed: Boolean(host.docker) && host.docker.mode === mode, image, note: DOCKER_NOTES[mode] };
    });
  }
  // Stores how this host reaches Docker. The mode is what the host shows now, never what the caller says.
  async confirmDocker(hostId, input = {}) {
    this.store.get(hostId);
    const { mode } = await this.#withSession(hostId, probeDocker);
    if (mode === 'NO_DOCKER') fail('REMOTE_DOCKER_UNAVAILABLE');
    if (mode === 'ROOTFUL' && input?.confirm !== DOCKER_ROOTFUL_CONFIRMATION) fail('REMOTE_DOCKER_CONFIRMATION_REQUIRED');
    const host = await this.store.setDocker(hostId, { mode, confirmedAt: new Date().toISOString() });
    this.audit('info', 'remote.host.docker_confirmed', { hostId, mode });
    return host;
  }
  // Takes the confirmation back. Docker instances on this host can then not be installed, switched to or
  // started until Docker is confirmed again; a running container is not touched.
  async withdrawDocker(hostId) {
    this.store.get(hostId);
    const host = await this.store.setDocker(hostId, null);
    this.audit('info', 'remote.host.docker_confirmation_withdrawn', { hostId });
    return host;
  }
  // Builds the runtime image from the fixed Dockerfile (stdin, no build context). -> { tag, id }
  async buildDockerImage(hostId) {
    const host = this.store.get(hostId);
    if (!host.docker) fail('REMOTE_DOCKER_NOT_CONFIRMED');
    try {
      const built = await this.#withSession(hostId, async session => {
        await assertDockerReady(session, host, { image: false });
        const result = await session.exec(imageBuildCommand({ tag: IMAGE_TAG, dockerfileSha256: DOCKERFILE_SHA256 }), { timeoutMs: 600_000, maxBytes: 64 * 1024, stdin: Buffer.from(DOCKERFILE, 'utf8') });
        if (result.code !== 0) throw Object.assign(new Error('REMOTE_DOCKER_BUILD_FAILED'), { code: 'REMOTE_DOCKER_BUILD_FAILED', output: buildOutput(result) });
        const image = await runtimeImage(session);
        if (!image?.current) fail('REMOTE_DOCKER_BUILD_FAILED');
        return { tag: IMAGE_TAG, id: image.id };
      });
      this.audit('info', 'remote.host.docker_image_built', { hostId });
      return built;
    } catch (error) {
      const code = typeof error?.code === 'string' && (error.code.startsWith('REMOTE_') || error.code.startsWith('VAULT_')) ? error.code : 'REMOTE_DOCKER_BUILD_FAILED';
      this.audit('warn', 'remote.host.docker_image_build_failed', { hostId, code }); // the output goes to the operator, not into the audit log
      throw Object.assign(new Error(code), { code, ...(typeof error?.output === 'string' && error.output ? { output: error.output } : {}) });
    }
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
