import {
  containerName, runContainerCommand, parseContainerId, inspectContainerCommand, parseContainerInspect,
  stopContainerCommand, removeContainerCommand, containerLogsCommand, CONTAINER_BASE, CONTAINER_HOME,
} from './docker-commands.mjs';

// Block 19: the container of one remote instance, over an open session. The counterpart of the
// process code in lib/remote-instance-manager.mjs: where that identifies a core by pid, creation time
// and /proc, this identifies it by container ID, name and the two labels CONTROL sets.
// Nothing here stops or removes a container whose labels are not this instance's.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const MAX_LOG_BYTES = 1024 * 1024;

// The arguments of the core inside the container: fixed paths, and all addresses of the container
// (which addresses of the server reach it is decided by the published ports).
export function containerCoreArguments(port, rconFile) {
  const value = String(port);
  return ['+set', 'dedicated', '2', '+set', 'fs_basepath', CONTAINER_BASE, '+set', 'fs_homepath', CONTAINER_HOME,
    '+set', 'net_port', value, '+set', 'net_ip', '0.0.0.0', '+set', 'net_port6', value, '+set', 'net_ip6', '::',
    ...(rconFile ? ['+exec', rconFile] : []), '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot'];
}
// Loopback is always enough for CONTROL itself (getinfo, getstatus and RCON run on the server against
// 127.0.0.1). A public instance is published on every IPv4 address, which includes loopback.
export const publishAddresses = network => (network?.scope === 'PUBLIC' ? ['0.0.0.0'] : ['127.0.0.1']);
// Rootful: the SSH user, so files in the home keep their owner. Rootless: user 0 inside the container
// is the unprivileged SSH user outside.
export const containerUser = (mode, { uid, gid }) => (mode === 'ROOTLESS' ? '0:0' : `${uid}:${gid}`);

export function exitReason(container) {
  if (!container) return 'PROCESS_GONE';
  if (container.oomKilled) return 'OOM_KILLED';
  return Number.isInteger(container.exitCode) && container.exitCode >= 0 && container.exitCode <= 255 ? `EXITED_${container.exitCode}` : 'PROCESS_GONE';
}

// At most `limit` bytes of text from the end, starting on a character boundary.
function boundedText(buffer, limit) {
  let text = buffer.subarray(Math.max(0, buffer.length - limit)).toString('utf8');
  if (Buffer.byteLength(text) > limit) { // invalid bytes grew when they became replacement characters
    const bytes = Buffer.from(text); let cut = bytes.length - limit;
    while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut++;
    text = bytes.subarray(cut).toString('utf8');
  }
  return text.replace(/^\ufffd+/, '');
}

export function createContainerRuntime({ session, stopGraceMs = 10_000 }) {
  const graceSeconds = Math.min(300, Math.max(1, Math.ceil(stopGraceMs / 1000)));
  const mine = (instance, container) => container.name === containerName(instance.id) && container.instance === instance.id;

  // -> the container, or null when there is none. Throws when Docker cannot say.
  async function inspect(ref) {
    return parseContainerInspect(await session.exec(inspectContainerCommand(ref), { timeoutMs: 15_000 }));
  }
  // The container in the saved state: ALIVE (ours and running), GONE (removed, or ours and not running)
  // or UNKNOWN (Docker cannot say, or the labels are not ours: never acted on). -> { process, container }
  async function identify(instance, saved) {
    const id = saved?.containerId ?? null;
    if (!id) return { process: 'UNKNOWN', container: null };
    let container;
    try { container = await inspect(id); } catch { return { process: 'UNKNOWN', container: null }; }
    if (!container) return { process: 'GONE', container: null };
    if (container.id !== id || !mine(instance, container) || container.run !== saved.runId) return { process: 'UNKNOWN', container };
    return { process: container.status === 'running' ? 'ALIVE' : ['exited', 'dead', 'created'].includes(container.status) ? 'GONE' : 'UNKNOWN', container };
  }
  // Whatever holds the name of this instance. A container that is not this instance's blocks.
  async function find(instance) {
    const container = await inspect(containerName(instance.id));
    if (container && !mine(instance, container)) fail('INSTANCE_PROCESS_IDENTITY_BLOCKED');
    return container;
  }
  async function remove(id) {
    const result = await session.exec(removeContainerCommand(id), { timeoutMs: 30_000 });
    if (result.code !== 0 && await inspect(id)) fail('REMOTE_DOCKER_REMOVE_FAILED');
  }
  // Before a start: a stopped container of this instance is removed, a running one blocks.
  async function clearLeftover(instance) {
    const container = await find(instance);
    if (!container) return;
    if (!['exited', 'dead', 'created'].includes(container.status)) fail('REMOTE_DOCKER_CONTAINER_EXISTS');
    await remove(container.id);
  }
  // -> the ID of the new container. Throws the transport error when the answer is lost (the container
  // may exist), REMOTE_DOCKER_START_FAILED when Docker refused.
  async function run(instance, { runId, imageId, user, args }) {
    const result = await session.exec(runContainerCommand({
      instanceId: instance.id, runId, image: imageId, user, basePath: instance.basePath, home: instance.home,
      port: instance.port, publish: publishAddresses(instance.network), args,
    }), { timeoutMs: 60_000 });
    if (result.code !== 0) fail('REMOTE_DOCKER_START_FAILED');
    return parseContainerId(result.stdout);
  }
  // After a refused run Docker can leave a created, never started container under the name.
  async function discardFailedRun(instance, runId) {
    const container = await find(instance);
    if (!container) return true;
    if (container.run !== runId || container.status === 'running') return false;
    await remove(container.id);
    return true;
  }
  // SIGTERM, after the grace period SIGKILL (both by Docker), then the container is removed.
  async function stop(instance, saved) {
    const { process, container } = await identify(instance, saved);
    if (process === 'UNKNOWN') fail('REMOTE_RECOVERY_BLOCKED');
    if (!container) return;
    if (process === 'ALIVE') {
      await session.exec(stopContainerCommand(container.id, graceSeconds), { timeoutMs: graceSeconds * 1000 + 30_000 });
      const after = await inspect(container.id);
      if (after && after.status === 'running') fail('REMOTE_STOP_FAILED');
      if (!after) return;
    }
    await remove(container.id);
  }
  async function readOutput(containerId, limit) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LOG_BYTES) fail('REMOTE_ARGUMENT_INVALID');
    const output = {};
    for (const stream of ['stdout', 'stderr']) {
      // one byte more than wanted tells whether something was cut off
      const result = containerId ? await session.exec(containerLogsCommand(containerId, stream, limit + 1), { timeoutMs: 20_000, maxBytes: limit + 4096 }) : { stdout: Buffer.alloc(0) };
      output[stream] = boundedText(result.stdout, limit);
      output[`${stream}Truncated`] = result.stdout.length > limit;
    }
    return output;
  }
  return { inspect, identify, find, clearLeftover, run, discardFailedRun, stop, remove, readOutput };
}
