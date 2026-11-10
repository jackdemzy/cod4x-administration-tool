import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { RemoteHostStore } from "../lib/remote-host-store.mjs";
import { RemoteInstanceStore } from "../lib/remote-instance-store.mjs";
import { RemoteStateStore } from "../lib/remote-runtime-state.mjs";
import { RemoteHostService, DOCKER_ROOTFUL_CONFIRMATION } from "../lib/remote-host-service.mjs";
import { RemoteInstanceManager } from "../lib/remote-instance-manager.mjs";
import { createRemoteLinuxAdapter } from "../lib/remote-linux-runtime.mjs";
import { createRemoteFiles } from "../lib/remote-files.mjs";
import { shellQuote } from "../lib/remote-safety.mjs";
import { assertDockerMountPath, CONTAINER_CORE } from "../lib/docker-commands.mjs";
import { IMAGE_TAG } from "../lib/docker-image.mjs";

// Native Block 19 check: a real sshd, a real Docker daemon on that server, a real CoD4x Linux core and a base
// game that already exists on the server. It runs the roadmap gate "Container Restart ohne Datenverlust"
// through the same classes the application uses; only the vault is replaced by a reader for the test key file.
// Usage (on the control machine, non-root):
//   REMOTE_TEST_HOST=server.example.org REMOTE_TEST_USER=cod4x REMOTE_TEST_KEY=~/.ssh/id_ed25519 \
//   REMOTE_TEST_ROOT=/home/cod4x/docker-gate COD4X_CORE=/path/cod4x18_dedrun COD4X_BASEGAME=/home/cod4x/cod4-base \
//   node scripts/verify-4.18.25-docker-native.mjs
// Optional: REMOTE_TEST_PORT (SSH, default 22), REMOTE_TEST_KEY_PASSPHRASE, COD4X_CORE_VERSION (default 21.5).
// If the SSH user reaches Docker through the docker group (root-equivalent on that server), the check runs only
// with DOCKER_TEST_CONFIRM=DOCKER_ROOT_EQUIVALENT. With rootless Docker nothing has to be confirmed.
// COD4X_BASEGAME is a path ON THE SERVER (read only). The server needs access to Docker Hub and the Debian
// mirrors for the first image build.
const env = process.env;
const missing = ["REMOTE_TEST_HOST", "REMOTE_TEST_USER", "REMOTE_TEST_KEY", "REMOTE_TEST_ROOT", "COD4X_CORE", "COD4X_BASEGAME"].filter(name => !env[name]);
if (missing.length) { console.log(`SKIP native Docker check: set ${missing.join(", ")}`); process.exit(0); }
if (process.getuid?.() === 0) { console.log("FAIL run the native Docker check as a normal user"); process.exit(1); }
const expand = file => file.replace(/^~(?=$|\/)/, os.homedir());
const corePath = expand(env.COD4X_CORE), keyFile = expand(env.REMOTE_TEST_KEY);
try { await fs.access(corePath); await fs.access(keyFile); } catch { console.log("SKIP native Docker check: core or key file not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => { checks.push([name, Boolean(ok), detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const code = promise => promise.then(() => null, error => error.code || error.message);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(1000)) if (await predicate()) return true; return false; }

const local = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-docker-native-"));
const keyBytes = await fs.readFile(keyFile);
const id = `dock${crypto.randomBytes(3).toString("hex")}`;
const root = path.posix.join(env.REMOTE_TEST_ROOT, `run-${id}`);
const port = 29000 + Math.floor(Math.random() * 900);
const coreSha256 = crypto.createHash("sha256").update(await fs.readFile(corePath)).digest("hex");
let manager, hostService, skipped = null;

try {
  const hostStore = new RemoteHostStore({ file: path.join(local, "hosts.json") });
  await hostStore.load();
  const instances = new RemoteInstanceStore({ file: path.join(local, "instances.json"), hosts: hostStore });
  await instances.load();
  const credentials = { async withRuntimeCredentials(subject, action) { return action({ privateKey: Buffer.from(keyBytes), passphrase: env.REMOTE_TEST_KEY_PASSPHRASE ? Buffer.from(env.REMOTE_TEST_KEY_PASSPHRASE) : undefined }); } };
  hostService = new RemoteHostService({ store: hostStore, credentials });
  await fs.mkdir(path.join(local, "core-import")); await fs.copyFile(corePath, path.join(local, "core-import", "cod4x18_dedrun")); // cores are read from the import directory only
  manager = new RemoteInstanceManager({ instances, hosts: hostService, coreImportRoot: path.join(local, "core-import"), state: new RemoteStateStore({ root: path.join(local, "state") }), backupRoot: path.join(local, "backups") });
  await hostService.createHost({ id: "native", label: "docker gate", host: env.REMOTE_TEST_HOST, port: Number(env.REMOTE_TEST_PORT || 22), username: env.REMOTE_TEST_USER });
  const fingerprint = await hostService.probeHostKey("native");
  console.log(`Host key of ${env.REMOTE_TEST_HOST}: SHA256:${fingerprint.sha256Base64.replace(/=+$/, "")} (pinned for this run only)`);
  await hostService.trustHostKey("native", fingerprint.sha256Hex);

  // how the host reaches Docker, and the confirmation
  const before = await hostService.dockerStatus("native");
  check("Docker answers the SSH user", before.mode !== "NO_DOCKER", `${before.mode} ${before.version || ""}`.trim());
  if (before.mode === "NO_DOCKER") throw Object.assign(new Error("install Docker on the server and let the SSH user reach it (rootless, or the docker group)"), { code: "REMOTE_DOCKER_UNAVAILABLE" });
  const install = (overrides = {}) => manager.install({ id, name: `Docker ${id}`, hostId: "native", port, remoteRoot: root, basePath: env.COD4X_BASEGAME, corePath: path.join(local, "core-import", "cod4x18_dedrun"), coreVersion: env.COD4X_CORE_VERSION || "21.5", expectedCoreSha256: coreSha256, deployment: "docker", ...overrides });
  if (before.mode === "ROOTFUL") {
    console.log("NOTE the SSH user reaches Docker through the docker group: that is equivalent to root on this server.");
    check("a docker-group host is not confirmed without the word", await code(hostService.confirmDocker("native", { confirm: "yes" })) === "REMOTE_DOCKER_CONFIRMATION_REQUIRED" && hostStore.get("native").docker === null);
    if (env.DOCKER_TEST_CONFIRM !== DOCKER_ROOTFUL_CONFIRMATION) { skipped = `set DOCKER_TEST_CONFIRM=${DOCKER_ROOTFUL_CONFIRMATION} to accept that for this run`; throw Object.assign(new Error(skipped), { code: "SKIP" }); }
  } else console.log("NOTE rootless Docker: the server may not see the real source address of players.");
  const { session } = await hostService.connect("native");
  try { await session.exec(`mkdir -p -- ${shellQuote(assertDockerMountPath(root))}`, { timeoutMs: 15000 }); } finally { session.close(); }
  check("an install as container is refused before the host is confirmed", await code(install()) === "REMOTE_DOCKER_NOT_CONFIRMED" && instances.list().length === 0);
  await hostService.confirmDocker("native", { confirm: before.mode === "ROOTFUL" ? DOCKER_ROOTFUL_CONFIRMATION : null });
  check("the host is confirmed with the mode it shows", hostStore.get("native").docker?.mode === before.mode);

  // image
  const started = Date.now();
  const image = await hostService.buildDockerImage("native");
  check("the runtime image is built from the fixed Dockerfile", image.tag === IMAGE_TAG && /^sha256:[a-f0-9]{64}$/.test(image.id), `${image.tag}, ${Math.round((Date.now() - started) / 1000)} s`);
  check("the host reports the image as present", (await hostService.dockerStatus("native")).image === "PRESENT");

  // install and first start
  const installed = await install();
  check("Install creates the instance as a container instance", installed.id === id && installed.deployment === "docker");
  const home = installed.home;
  const withFiles = async action => {
    const { session, uid, gid } = await hostService.connect("native");
    try { const adapter = await createRemoteLinuxAdapter(session, { uid, gid }); try { return await action(createRemoteFiles({ sftp: adapter.sftp, filesystem: adapter.filesystem }), session); } finally { adapter.sftp.end?.(); } } finally { session.close(); }
  };
  let first = null, startError = await code(manager.start(id).then(result => { first = result.runtime; }));
  const running = !startError && await until(async () => (await manager.status(id)).runtime.status === "RUNNING", 60000);
  check("Start: the core runs in a container", running, startError || String(first?.containerId || "").slice(0, 12));
  if (!running) {
    // the usual cause: a 32-bit library the image does not have. ldd inside the image names it.
    await withFiles(async (_files, session) => {
      const ldd = await session.exec(`docker run --rm --network none --mount ${shellQuote(`type=bind,source=${home}/core,target=${CONTAINER_CORE},readonly`)} ${IMAGE_TAG} ldd ${CONTAINER_CORE}/cod4x18_dedrun 2>&1`, { timeoutMs: 60000 });
      console.log(`ldd of the core inside the image:\n${ldd.stdout.toString("utf8")}`);
    }).catch(error => console.log(`ldd could not be run: ${error.code || error.message}`));
    const logs = await manager.logs(id).catch(() => null);
    if (logs) console.log(`Output of the container:\n${logs.stdout}\n${logs.stderr}`);
    throw Object.assign(new Error("the core did not start in the container"), { code: startError || "REMOTE_DOCKER_START_FAILED" });
  }
  let health = null;
  const answered = await until(async () => { health = await manager.health(id); return health.getinfo === "OK"; }, 90000);
  check("Health: getinfo answered through the port published on 127.0.0.1 of the server", answered && health.process === "ALIVE", JSON.stringify(health));
  const logs = await manager.logs(id);
  check("Logs: output of the container", (logs.stdout + logs.console).length > 0, `${logs.stdout.length} bytes stdout, ${logs.console.length} bytes console`);

  // the marker: a file of the operator in the home, compared after every step
  const marker = crypto.randomBytes(4096), markerSha = crypto.createHash("sha256").update(marker).digest("hex");
  await withFiles(files => files.writeFileExclusive(`${home}/mods/gate-marker.bin`, marker, { mode: 0o600 }));
  const config = (await manager.readConfig(id)).sha256;
  const intact = async () => (await withFiles(files => files.sha256(`${home}/mods/gate-marker.bin`))) === markerSha && (await manager.readConfig(id)).sha256 === config;

  await manager.restart(id);
  const second = (await manager.status(id)).runtime;
  check("Restart: a new container runs", second.status === "RUNNING" && second.containerId !== first.containerId);
  check("Restart: marker file and server.cfg are unchanged", await intact());
  await manager.stop(id);
  check("Stop: the container is gone", (await manager.status(id)).runtime.status === "STOPPED");
  await manager.start(id);
  check("Start after stop: running again, files unchanged", (await manager.status(id)).runtime.status === "RUNNING" && await intact());
  check("after the restarts the server answers again", await until(async () => (await manager.health(id)).getinfo === "OK", 90000));
  check("the deployment cannot be switched while the container runs", await code(manager.setDeployment(id, { deployment: "native" })) === "REMOTE_INSTANCE_RUNNING");
  await manager.stop(id);

  // the same directory as a native process, and back
  await manager.setDeployment(id, { deployment: "native" });
  await manager.start(id);
  const native = (await manager.status(id)).runtime;
  check("Switched to native: the same files run as a process", native.status === "RUNNING" && Boolean(native.pid) && !native.containerId && await intact());
  await manager.stop(id);
  await manager.setDeployment(id, { deployment: "docker" });
  await manager.start(id);
  const last = (await manager.status(id)).runtime;
  check("Switched back: a container again, files unchanged", last.status === "RUNNING" && Boolean(last.containerId) && await intact());
  await manager.stop(id);
} catch (error) {
  if (error.code !== "SKIP") check("native Docker run completed", false, `${error.code || ""} ${error.message}`.trim());
} finally {
  try { await manager?.stop(id); } catch { /* not running */ }
  await fs.rm(local, { recursive: true, force: true });
}
if (checks.some(([, ok]) => !ok)) { console.log(`Leftover on the server for inspection: ${root}`); process.exit(1); }
if (skipped) { console.log(`SKIP native Docker check: ${skipped}`); process.exit(0); }
console.log(`Server directories created by this check: ${root} (not deleted automatically). The image ${IMAGE_TAG} stays on the server.`);
console.log("Container Restart ohne Datenverlust PASS (real sshd, real Docker, real core)");
