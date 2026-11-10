import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRemoteFixture } from './remote-fixture.mjs';
import { imageBuildCommand, parseDockerProbe, dockerProbeCommand } from '../../lib/docker-commands.mjs';
import { DOCKERFILE, DOCKERFILE_SHA256, IMAGE_TAG } from '../../lib/docker-image.mjs';

// Block 19 test doubles.
//  - installFakeDocker: a scripted `docker` for the loopback "server". It implements exactly the
//    sub-commands lib/docker-commands.mjs builds and runs the "core" as a real process, so the
//    manager can be exercised where no Docker daemon exists and failures can be injected.
//  - buildContainerCore: a static stand-in for cod4x18_dedrun that runs natively and inside the
//    real 32-bit image, and reports what it may write and which capabilities it has.
//  - realDockerAvailable: whether a real daemon answers.
const run = promisify(execFile);

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const state = __dirname;
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')); } catch { return fallback; } };
const write = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value));
const die = (message, code = 1) => { process.stderr.write(message + '\n'); process.stdout.write('\n'); process.exit(code); };
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'calls.log'), JSON.stringify(argv) + '\n');
const settings = read('settings.json', { mode: 'ROOTFUL' });
if (settings.mode === 'NO_DOCKER') die('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
const containers = () => fs.readdirSync(state).filter(name => name.startsWith('container-')).map(name => read(name));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const refresh = container => {
  // the exit file counts too: where PID 1 reaps late, an ended supervisor is still a zombie that kill(0) finds
  if (container.status === 'running' && (!alive(container.supervisor) || fs.existsSync(path.join(container.dir, 'exit')))) {
    container.status = 'exited';
    try { container.exitCode = Number(fs.readFileSync(path.join(container.dir, 'exit'), 'utf8')); } catch { container.exitCode = 137; }
    write('container-' + container.id + '.json', container);
  }
  return container;
};
const find = ref => containers().map(refresh).find(container => container.id === ref || container.name === ref);
const sleep = ms => spawnSync('sleep', [String(ms / 1000)]);

const [command] = argv;
if (command === 'info') {
  process.stdout.write('29.0.0 ' + JSON.stringify(settings.mode === 'ROOTLESS' ? ['name=seccomp,profile=builtin', 'name=rootless'] : ['name=seccomp,profile=builtin']) + '\n');
} else if (command === 'build') {
  const dockerfile = fs.readFileSync(0, 'utf8');
  if (settings.failBuild || !dockerfile.startsWith('FROM ')) die('ERROR: failed to solve');
  const tag = argv[argv.indexOf('--tag') + 1], label = argv[argv.indexOf('--label') + 1].split('=');
  const id = 'sha256:' + crypto.createHash('sha256').update(tag + dockerfile).digest('hex');
  const images = read('images.json', {}); images[tag] = { id, labels: { [label[0]]: label[1] } }; write('images.json', images);
  process.stdout.write(id + '\n');
} else if (command === 'image' && argv[1] === 'inspect') {
  const image = read('images.json', {})[argv[argv.length - 1]];
  if (!image) die('Error response from daemon: No such image: ' + argv[argv.length - 1]);
  process.stdout.write(JSON.stringify([image.id, image.labels['cod4x.control.dockerfile'] || '']) + '\n');
} else if (command === 'run') {
  const options = { labels: {}, mounts: [], publish: [] };
  let index = 1;
  const flags = { '--detach': 0, '--read-only': 0, '--name': 1, '--label': 1, '--tmpfs': 1, '--cap-drop': 1, '--security-opt': 1, '--pids-limit': 1, '--memory': 1, '--restart': 1, '--network': 1, '--user': 1, '--workdir': 1, '--mount': 1, '--publish': 1 };
  for (; index < argv.length && argv[index].startsWith('--'); index++) {
    const flag = argv[index];
    if (!(flag in flags)) die('unknown flag: ' + flag, 125);
    if (!flags[flag]) continue;
    const value = argv[++index];
    if (flag === '--label') { const at = value.indexOf('='); options.labels[value.slice(0, at)] = value.slice(at + 1); }
    else if (flag === '--mount') options.mounts.push(Object.fromEntries(value.split(',').map(part => part.includes('=') ? part.split('=') : [part, true])));
    else if (flag === '--publish') options.publish.push(value);
    else options[flag.slice(2)] = value;
  }
  const image = argv[index++], program = argv[index++], args = argv.slice(index);
  if (!Object.values(read('images.json', {})).some(entry => entry.id === image)) die('Unable to find image ' + image + ' locally', 125);
  if (find(options.name)) die('docker: Error response from daemon: Conflict. The container name "/' + options.name + '" is already in use', 125);
  // what the mounts do in a real container: container paths are the host paths
  const translate = value => options.mounts.sort((a, b) => b.target.length - a.target.length).reduce((text, mount) => text === mount.target || text.startsWith(mount.target + '/') ? mount.source + text.slice(mount.target.length) : text, value);
  const id = crypto.randomBytes(32).toString('hex'), dir = path.join(state, 'run-' + id);
  fs.mkdirSync(dir);
  const out = fs.openSync(path.join(dir, 'stdout'), 'w'), err = fs.openSync(path.join(dir, 'stderr'), 'w');
  const supervisor = spawn('sh', ['-c', '"$@" & echo $! > "$0/pid"; wait $!; echo $? > "$0/exit"', dir, translate(program), ...args.map(translate)],
    { cwd: translate(options.workdir || '/'), detached: true, stdio: ['ignore', out, err] });
  supervisor.unref();
  write('container-' + id + '.json', { id, name: options.name, labels: options.labels, image, status: 'running', exitCode: 0, oomKilled: false, supervisor: supervisor.pid, dir, user: options.user, publish: options.publish, mounts: options.mounts });
  if (settings.exitOnStart) sleep(50);
  process.stdout.write(id + '\n');
} else if (command === 'container' && argv[1] === 'inspect') {
  const container = find(argv[argv.length - 1]);
  if (settings.failInspect) die('Cannot connect to the Docker daemon');
  if (!container) die('Error response from daemon: No such container: ' + argv[argv.length - 1]);
  process.stdout.write(JSON.stringify([container.id, '/' + container.name, container.labels['cod4x.control.instance'] || '', container.labels['cod4x.control.run'] || '', container.image, container.status, container.exitCode, container.oomKilled]) + '\n');
} else if (command === 'stop') {
  const container = find(argv[argv.length - 1]);
  if (!container) die('Error response from daemon: No such container');
  if (container.status === 'running') {
    const pid = Number(fs.readFileSync(path.join(container.dir, 'pid'), 'utf8'));
    const grace = Number(argv[argv.indexOf('--time') + 1]) * 1000;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let waited = 0; alive(container.supervisor) && waited < Math.min(grace, settings.graceMs ?? 400); waited += 20) sleep(20);
    if (alive(container.supervisor)) { try { process.kill(pid, 'SIGKILL'); } catch {} for (let waited = 0; alive(container.supervisor) && waited < 2000; waited += 20) sleep(20); }
    refresh(container);
  }
  process.stdout.write(container.id + '\n');
} else if (command === 'rm') {
  const container = find(argv[argv.length - 1]);
  if (!container) die('Error response from daemon: No such container');
  if (container.status === 'running') die('Error response from daemon: cannot remove container: container is running');
  fs.rmSync(path.join(state, 'container-' + container.id + '.json'));
  process.stdout.write(container.id + '\n');
} else if (command === 'logs') {
  const container = find(argv[argv.length - 1]);
  if (!container) die('Error response from daemon: No such container');
  process.stdout.write(fs.readFileSync(path.join(container.dir, 'stdout')));
  process.stderr.write(fs.readFileSync(path.join(container.dir, 'stderr')));
} else die('fake docker: unsupported command ' + argv.join(' '), 64);
`;

// loopback: createLoopbackServer(). Returns a session that finds the fake `docker` first in PATH.
export async function installFakeDocker(loopback, { mode = 'ROOTFUL' } = {}) {
  const directory = loopback.path('.fake-docker');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const settingsFile = path.join(directory, 'settings.json');
  let settings = { mode };
  const save = () => fs.writeFile(settingsFile, JSON.stringify(settings));
  await save();
  let failAfter = null;
  const session = Object.create(loopback.session);
  session.exec = async (command, options) => {
    const result = await loopback.session.exec(`PATH='${directory}':"$PATH"; ${command}`, options);
    if (failAfter && command.includes(failAfter)) { failAfter = null; throw Object.assign(new Error('REMOTE_CONNECT_FAILED'), { code: 'REMOTE_CONNECT_FAILED' }); }
    return result;
  };
  const containerFiles = async () => (await fs.readdir(directory)).filter(name => name.startsWith('container-'));
  return {
    session, directory,
    async set(change) { settings = { ...settings, ...change }; await save(); },
    // The next command containing `text` runs on the server, but its answer is lost (dropped connection).
    dropAnswerOf(text) { failAfter = text; },
    async calls() { return (await fs.readFile(path.join(directory, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    async containers() { return Promise.all((await containerFiles()).map(async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')))); },
    // A container somebody else created under a name CONTROL would use.
    async addForeign(name, { labels = {}, status = 'running' } = {}) {
      const id = 'f'.repeat(56) + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      const record = { id, name, labels, image: `sha256:${'e'.repeat(64)}`, status, exitCode: 0, oomKilled: false, supervisor: process.pid, dir: directory, user: '0:0', publish: [], mounts: [] };
      await fs.writeFile(path.join(directory, `container-${id}.json`), JSON.stringify(record));
      return id;
    },
    async patch(id, change) {
      const file = path.join(directory, `container-${id}.json`);
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...change }));
    },
  };
}

const containerCoreSource = ignoreTerm => `#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
static void try_write(const char *label, const char *file) {
  int fd = open(file, O_WRONLY | O_CREAT, 0600);
  printf("write %s: %s\\n", label, fd < 0 ? "DENIED" : "ALLOWED");
  if (fd >= 0) { close(fd); unlink(file); }
}
int main(int argc, char **argv) {
  ${ignoreTerm ? 'signal(SIGTERM, SIG_IGN);' : ''}
  const char *home = "", *base = ""; int port = 0; char path[4096], line[512];
  for (int i = 0; i < argc; i++) printf("%s\\n", argv[i]);
  for (int i = 0; i + 2 < argc; i++) if (!strcmp(argv[i], "+set")) {
    if (!strcmp(argv[i + 1], "fs_homepath")) home = argv[i + 2];
    if (!strcmp(argv[i + 1], "fs_basepath")) base = argv[i + 2];
    if (!strcmp(argv[i + 1], "net_port")) port = atoi(argv[i + 2]);
  }
  for (int i = 0; i + 1 < argc; i++) if (!strcmp(argv[i], "+exec")) {
    snprintf(path, sizeof path, "%s/main/%s", home, argv[i + 1]);
    FILE *file = fopen(path, "r");
    if (!file) { printf("couldn't exec %s\\n", argv[i + 1]); continue; }
    printf("execing %s\\n", argv[i + 1]);
    while (fgets(line, sizeof line, file)) if (!strncmp(line, "set rcon_password \\"", 19)) printf("rcon password provisioned\\n");
    fclose(file);
  }
  /* persistent data: one line per start */
  snprintf(path, sizeof path, "%s/players/core-starts.txt", home);
  FILE *starts = fopen(path, "a");
  if (starts) { fprintf(starts, "start\\n"); fclose(starts); printf("write home: ALLOWED\\n"); } else printf("write home: DENIED\\n");
  snprintf(path, sizeof path, "%s/probe-base", base); try_write("base", path);
  snprintf(path, sizeof path, "%s/core/probe-core", home); try_write("homecore", path);
  try_write("corepath", "/cod4/core/probe-core");
  try_write("root", "/probe-root");
  FILE *status = fopen("/proc/self/status", "r");
  if (status) { while (fgets(line, sizeof line, status)) if (!strncmp(line, "CapEff:", 7) || !strncmp(line, "Uid:", 4)) fputs(line, stdout); fclose(status); }
  fflush(stdout);
  fprintf(stderr, "fixture stderr\\n");
  int sock = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in address; memset(&address, 0, sizeof address);
  address.sin_family = AF_INET; address.sin_port = htons(port); address.sin_addr.s_addr = htonl(INADDR_ANY);
  if (sock < 0 || bind(sock, (struct sockaddr *)&address, sizeof address) < 0) { for (;;) usleep(100000); }
  for (;;) {
    char packet[1500]; struct sockaddr_in from; socklen_t length = sizeof from;
    ssize_t got = recvfrom(sock, packet, sizeof packet - 1, 0, (struct sockaddr *)&from, &length);
    if (got < 4) continue;
    packet[got] = 0;
    if (!strncmp(packet + 4, "getinfo", 7) || !strncmp(packet + 4, "getstatus", 9)) {
      const char *answer = "\\377\\377\\377\\377infoResponse\\n\\\\hostname\\\\container\\\\mapname\\\\mp_backlot\\\\clients\\\\0\\\\sv_maxclients\\\\16";
      sendto(sock, answer, strlen(answer), 0, (struct sockaddr *)&from, length);
    }
  }
  return 0;
}
`;

// A static executable, so it also runs inside the 32-bit image (the kernel runs it directly).
export async function buildContainerCore(directory, name = 'cod4x18_dedrun', { ignoreTerm = false } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, `${name}.c`), executable = path.join(directory, name);
  await fs.writeFile(source, containerCoreSource(ignoreTerm));
  await run('gcc', ['-static', source, '-o', executable]);
  await fs.rm(source);
  await fs.chmod(executable, 0o755);
  return executable;
}

export async function realDockerAvailable() {
  if (process.platform !== 'linux' || process.getuid() === 0) return false;
  try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 }); return true; } catch { return false; }
}

// The remote fixture with Docker on the "server": the scripted docker by default, the real daemon with
// real: true. ready: the host is confirmed and the runtime image is built. install() installs as docker.
export async function createDockerFixture(t, { mode = 'ROOTFUL', ready = true, real = false, ...options } = {}) {
  const f = await createRemoteFixture(t, { buildCore: buildContainerCore, ...options });
  const fake = real ? null : await installFakeDocker(f.loopback, { mode });
  if (fake) f.control.session = fake.session;
  const session = f.control.session;
  const hostMode = real ? parseDockerProbe(await session.exec(dockerProbeCommand())).mode : mode;
  const used = new Set();
  if (real) t.after(async () => { for (const id of used) await run('docker', ['rm', '--force', `cod4x-${id}`]).catch(() => {}); });
  const buildImage = async () => {
    const result = await session.exec(imageBuildCommand({ tag: IMAGE_TAG, dockerfileSha256: DOCKERFILE_SHA256 }), { timeoutMs: 600_000, stdin: Buffer.from(DOCKERFILE) });
    if (result.code !== 0) throw new Error(`image build failed: ${result.stderr}`);
  };
  const confirm = (hostId = 'lab-1') => f.hostStore.setDocker(hostId, { mode: hostMode, confirmedAt: new Date().toISOString() });
  if (ready) { await confirm(); await buildImage(); }
  const install = (id, overrides = {}) => { used.add(id); return f.install(id, { deployment: 'docker', ...overrides }); };
  return { ...f, fake, mode: hostMode, install, installNative: f.install, buildImage, confirm, track: id => used.add(id) };
}
