import net from 'node:net';
import { shellQuote, assertRemotePosixPath, validRemoteInstanceId } from './remote-safety.mjs';

// Block 19: the ONLY `docker` command lines CONTROL runs on a server, and the parsers of what
// they print. Same rules as lib/remote-commands.mjs: fixed words, values through shellQuote or a
// fixed pattern, --format templates as constants. No operator text reaches a docker flag.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMAGE_TAG = /^cod4x-control-runtime:[a-f0-9]{16}$/;
const NAME = /^cod4x-[a-z][a-z0-9-]{0,47}$/;
const USER = /^\d{1,10}:\d{1,10}$/;
const STATUSES = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];
const MAX_ARGUMENTS = 256;
const MAX_LOG_BYTES = 1024 * 1024;
const text = value => Buffer.from(value ?? '').toString('utf8');

export const LABEL_INSTANCE = 'cod4x.control.instance';
export const LABEL_RUN = 'cod4x.control.run';
export const LABEL_DOCKERFILE = 'cod4x.control.dockerfile';
export const CONTAINER_BASE = '/cod4/base';
export const CONTAINER_CORE = '/cod4/core';
export const CONTAINER_HOME = '/cod4/home';

export function containerName(instanceId) {
  if (!validRemoteInstanceId(instanceId)) fail('REMOTE_ARGUMENT_INVALID');
  return `cod4x-${instanceId}`;
}

// A bind mount is written as type=bind,source=<path>,target=<path>; a comma or a double quote in
// the path would change the meaning of that list, so such a path is refused, not escaped.
// Security audit 4.18.26 (A4-7): a rootful daemon mounts as root, so the parent checks of the SSH
// user do not protect these; system folders are never mounted.
const SYSTEM_PATHS = ['/etc', '/run', '/var/run', '/proc', '/sys', '/dev', '/boot', '/root', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/var/lib/docker'];
export function assertDockerMountPath(value) {
  const path = assertRemotePosixPath(value);
  if (/[,"]/.test(path)) fail('REMOTE_DOCKER_PATH_UNSUPPORTED');
  if (path === '/' || SYSTEM_PATHS.some(system => path === system || path.startsWith(`${system}/`))) fail('REMOTE_DOCKER_PATH_UNSUPPORTED');
  return path;
}

const containerId = value => (typeof value === 'string' && HEX64.test(value) ? value : fail('REMOTE_ARGUMENT_INVALID'));
const containerRef = value => (typeof value === 'string' && (HEX64.test(value) || NAME.test(value)) ? value : fail('REMOTE_ARGUMENT_INVALID'));
const imageTag = value => (typeof value === 'string' && IMAGE_TAG.test(value) ? value : fail('REMOTE_ARGUMENT_INVALID'));

// ---- host probe -------------------------------------------------------------
export const dockerProbeCommand = () => "docker info --format '{{.ServerVersion}} {{json .SecurityOptions}}'";

// -> { mode: 'NO_DOCKER' | 'ROOTLESS' | 'ROOTFUL', version }. Anything that is not the expected
// line (no docker, daemon down, no permission) is NO_DOCKER.
export function parseDockerProbe({ code, stdout }) {
  const none = { mode: 'NO_DOCKER', version: null };
  if (code !== 0) return none;
  const match = /^(\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][A-Za-z0-9.~+-]{1,40})?) (.{1,4000})\n$/.exec(text(stdout));
  if (!match) return none;
  let options;
  try { options = JSON.parse(match[2]); } catch { return none; }
  if (options !== null && !(Array.isArray(options) && options.every(option => typeof option === 'string'))) return none;
  const rootless = (options || []).some(option => option.split(',').includes('name=rootless'));
  return { mode: rootless ? 'ROOTLESS' : 'ROOTFUL', version: match[1] };
}

// ---- image ------------------------------------------------------------------
const IMAGE_FORMAT = `[{{json .Id}},{{json (index .Config.Labels "${LABEL_DOCKERFILE}")}}]`;
export const imageInspectCommand = tag => `LC_ALL=C docker image inspect --format ${shellQuote(IMAGE_FORMAT)} ${imageTag(tag)}`;

function notFound({ code, stdout, stderr }) {
  return code === 1 && !text(stdout).trim() && /no such (image|container|object)/i.test(text(stderr));
}
function jsonLine(stdout, length) {
  const value = text(stdout);
  if (!value.endsWith('\n') || value.slice(0, -1).includes('\n')) fail('REMOTE_DOCKER_INSPECT_FAILED');
  let fields;
  try { fields = JSON.parse(value); } catch { fail('REMOTE_DOCKER_INSPECT_FAILED'); }
  if (!Array.isArray(fields) || fields.length !== length) fail('REMOTE_DOCKER_INSPECT_FAILED');
  return fields;
}

// -> { id, dockerfile } or null when there is no such image.
export function parseImageInspect(result) {
  if (notFound(result)) return null;
  if (result.code !== 0) fail('REMOTE_DOCKER_INSPECT_FAILED');
  const [id, dockerfile] = jsonLine(result.stdout, 2);
  if (typeof id !== 'string' || !IMAGE_ID.test(id) || typeof dockerfile !== 'string') fail('REMOTE_DOCKER_INSPECT_FAILED');
  return { id, dockerfile };
}

// The Dockerfile arrives on stdin; "-" means there is no build context, so no file of the
// server can enter the image.
export function imageBuildCommand({ tag, dockerfileSha256 }) {
  if (typeof dockerfileSha256 !== 'string' || !HEX64.test(dockerfileSha256)) fail('REMOTE_ARGUMENT_INVALID');
  return `docker build --quiet --tag ${imageTag(tag)} --label ${LABEL_DOCKERFILE}=${dockerfileSha256} -`;
}

// ---- run --------------------------------------------------------------------
// user: '<uid>:<gid>' (rootful: the SSH user; rootless: '0:0', which is the SSH user outside).
// publish: the host IPv4 addresses the game port is published on. image: an image ID.
export function runContainerCommand({ instanceId, runId, image, user, basePath, home, port, publish, args }) {
  const name = containerName(instanceId);
  if (typeof runId !== 'string' || !UUID.test(runId) || typeof image !== 'string' || !IMAGE_ID.test(image) || typeof user !== 'string' || !USER.test(user)) fail('REMOTE_ARGUMENT_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('REMOTE_ARGUMENT_INVALID');
  if (!Array.isArray(publish) || !publish.length || publish.length > 4 || publish.some(address => typeof address !== 'string' || !net.isIPv4(address))) fail('REMOTE_ARGUMENT_INVALID');
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some(argument => typeof argument !== 'string')) fail('REMOTE_ARGUMENT_INVALID');
  const base = assertDockerMountPath(basePath), root = assertDockerMountPath(home);
  const mount = (source, target, readonly) => `--mount ${shellQuote(`type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`)}`;
  return [
    `docker run --detach --name ${name}`,
    `--label ${LABEL_INSTANCE}=${instanceId} --label ${LABEL_RUN}=${runId}`,
    '--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --cpus 2',
    // the output Docker keeps is bounded on every host: json-file has no limit by default, journald takes no max-size
    '--log-driver local --log-opt max-size=10m --log-opt max-file=3',
    `--restart no --network bridge --user ${user} --workdir ${CONTAINER_BASE}`,
    mount(base, CONTAINER_BASE, true), mount(`${root}/core`, CONTAINER_CORE, true), mount(root, CONTAINER_HOME, false),
    // the home is writable, the core inside it is not: the same directory read-only over home/core
    mount(`${root}/core`, `${CONTAINER_HOME}/core`, true),
    publish.map(address => `--publish ${address}:${port}:${port}/udp --publish ${address}:${port}:${port}/tcp`).join(' '),
    `${image} ${CONTAINER_CORE}/cod4x18_dedrun`,
    ...args.map(shellQuote),
  ].join(' ');
}

export function parseContainerId(stdout) {
  const match = /^([a-f0-9]{64})\n$/.exec(text(stdout));
  if (!match) fail('REMOTE_DOCKER_START_FAILED');
  return match[1];
}

// ---- inspect ----------------------------------------------------------------
const CONTAINER_FORMAT = `[{{json .Id}},{{json .Name}},{{json (index .Config.Labels "${LABEL_INSTANCE}")}},{{json (index .Config.Labels "${LABEL_RUN}")}},{{json .Image}},{{json .State.Status}},{{json .State.ExitCode}},{{json .State.OOMKilled}}]`;
export const inspectContainerCommand = ref => `LC_ALL=C docker container inspect --format ${shellQuote(CONTAINER_FORMAT)} ${containerRef(ref)}`;

// -> the container, or null when there is none. Anything else throws: "cannot tell" is never "gone".
export function parseContainerInspect(result) {
  if (notFound(result)) return null;
  if (result.code === 127) fail('REMOTE_DOCKER_NOT_INSTALLED'); // the shell found no docker program
  if (result.code !== 0) fail('REMOTE_DOCKER_INSPECT_FAILED');
  const [id, name, instanceLabel, runLabel, image, status, exitCode, oomKilled] = jsonLine(result.stdout, 8);
  // a container without the label: Docker prints null. It is then nobody's, which the caller sees as ''.
  const instance = instanceLabel ?? '', run = runLabel ?? '';
  if (typeof id !== 'string' || !HEX64.test(id) || typeof name !== 'string' || typeof instance !== 'string' || typeof run !== 'string'
    || typeof image !== 'string' || !STATUSES.includes(status) || !Number.isInteger(exitCode) || typeof oomKilled !== 'boolean') fail('REMOTE_DOCKER_INSPECT_FAILED');
  return { id, name: name.replace(/^\//, ''), instance, run, image, status, exitCode, oomKilled };
}

// ---- stop, remove, logs -----------------------------------------------------
// By ID only: a name could be taken by another container between two commands.
export function stopContainerCommand(id, graceSeconds) {
  if (!Number.isInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > 300) fail('REMOTE_ARGUMENT_INVALID');
  return `docker stop -t ${graceSeconds} ${containerId(id)}`;
}
export const removeContainerCommand = id => `docker rm ${containerId(id)}`;

// The last `bytes` bytes of one stream of the core.
export function containerLogsCommand(id, stream, bytes) {
  if (!['stdout', 'stderr'].includes(stream) || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_LOG_BYTES + 1) fail('REMOTE_ARGUMENT_INVALID');
  const redirect = stream === 'stdout' ? '2>/dev/null' : '2>&1 >/dev/null';
  return `docker logs ${containerId(id)} ${redirect} | tail -c ${bytes}`;
}
