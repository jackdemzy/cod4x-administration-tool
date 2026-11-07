import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { RemoteHostStore } from "../lib/remote-host-store.mjs";
import { RemoteInstanceStore } from "../lib/remote-instance-store.mjs";
import { RemoteStateStore } from "../lib/remote-runtime-state.mjs";
import { RemoteHostService } from "../lib/remote-host-service.mjs";
import { RemoteInstanceManager } from "../lib/remote-instance-manager.mjs";
import { createRemoteLinuxAdapter } from "../lib/remote-linux-runtime.mjs";
import { createRemoteFiles } from "../lib/remote-files.mjs";
import { makeDirectoriesCommand } from "../lib/remote-commands.mjs";

// Native Block 18 check: a real sshd, a real CoD4x Linux core, a base game that already exists on the server.
// It runs the whole chain through the same classes the application uses (host store, host-key pinning, SSH
// transport, SFTP, instance manager); only the vault is replaced by a reader for the test key file, because the
// vault has its own tests and this check is about the SSH and process layer.
// Usage (on the control machine, non-root):
//   REMOTE_TEST_HOST=server.example.org REMOTE_TEST_USER=cod4x REMOTE_TEST_KEY=~/.ssh/id_ed25519 \
//   REMOTE_TEST_ROOT=/home/cod4x/remote-gate COD4X_CORE=/path/cod4x18_dedrun COD4X_BASEGAME=/home/cod4x/cod4-base \
//   node scripts/verify-4.18.23-remote-linux-native.mjs
// Optional: REMOTE_TEST_PORT (SSH, default 22), REMOTE_TEST_KEY_PASSPHRASE, COD4X_CORE_VERSION (default 21.5).
// COD4X_BASEGAME is a path ON THE SERVER (read only). REMOTE_TEST_ROOT must be an absolute path on the server
// and is used for the instance directories created by this check.
const env = process.env;
const missing = ["REMOTE_TEST_HOST", "REMOTE_TEST_USER", "REMOTE_TEST_KEY", "REMOTE_TEST_ROOT", "COD4X_CORE", "COD4X_BASEGAME"].filter(name => !env[name]);
if (missing.length) { console.log(`SKIP native remote Linux check: set ${missing.join(", ")}`); process.exit(0); }
if (process.getuid?.() === 0) { console.log("FAIL run the native remote Linux check as a normal user"); process.exit(1); }
const expand = file => file.replace(/^~(?=$|\/)/, os.homedir());
const corePath = expand(env.COD4X_CORE), keyFile = expand(env.REMOTE_TEST_KEY);
try { await fs.access(corePath); await fs.access(keyFile); } catch { console.log("SKIP native remote Linux check: core or key file not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => { checks.push([name, Boolean(ok), detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const code = promise => promise.then(() => null, error => error.code || error.message);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(1000)) if (await predicate()) return true; return false; }

const local = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-remote-native-"));
const keyBytes = await fs.readFile(keyFile);
const id = `gate${crypto.randomBytes(3).toString("hex")}`;
const root = path.posix.join(env.REMOTE_TEST_ROOT, `run-${id}`);
const port = 29000 + Math.floor(Math.random() * 900);
const coreSha256 = crypto.createHash("sha256").update(await fs.readFile(corePath)).digest("hex");
let manager, hostService;

try {
  const hostStore = new RemoteHostStore({ file: path.join(local, "hosts.json") });
  await hostStore.load();
  const instances = new RemoteInstanceStore({ file: path.join(local, "instances.json"), hosts: hostStore });
  await instances.load();
  const credentials = { async withRuntimeCredentials(subject, action) { return action({ privateKey: Buffer.from(keyBytes), passphrase: env.REMOTE_TEST_KEY_PASSPHRASE ? Buffer.from(env.REMOTE_TEST_KEY_PASSPHRASE) : undefined }); } };
  hostService = new RemoteHostService({ store: hostStore, credentials });
  manager = new RemoteInstanceManager({ instances, hosts: hostService, state: new RemoteStateStore({ root: path.join(local, "state") }), backupRoot: path.join(local, "backups") });
  const lab = { id: "native", label: "native gate", host: env.REMOTE_TEST_HOST, port: Number(env.REMOTE_TEST_PORT || 22), username: env.REMOTE_TEST_USER };
  await hostService.createHost(lab);

  // host key: first contact never logs in and nothing is sent before it is pinned
  check("an unpinned host is refused before any login", await code(hostService.connect("native")) === "REMOTE_HOST_KEY_UNVERIFIED");
  const fingerprint = await hostService.probeHostKey("native");
  check("the host key can be read without logging in", /^[0-9a-f]{64}$/.test(fingerprint.sha256Hex), `SHA256:${fingerprint.sha256Base64.replace(/=+$/, "")}`);
  check("trusting a different value pins nothing", await code(hostService.trustHostKey("native", "00".repeat(32))) === "REMOTE_HOST_KEY_MISMATCH" && hostStore.get("native").hostKeySha256 === null);
  await hostService.trustHostKey("native", fingerprint.sha256Hex);
  check("the confirmed host key is pinned", hostStore.get("native").hostKeySha256 === fingerprint.sha256Hex);

  // deliberate errors before anything is created
  const wrongName = path.join(local, "core-wrong"); await fs.copyFile(corePath, wrongName);
  const install = (overrides = {}) => manager.install({ id, name: `Gate ${id}`, hostId: "native", port, remoteRoot: root, basePath: env.COD4X_BASEGAME, corePath, coreVersion: env.COD4X_CORE_VERSION || "21.5", expectedCoreSha256: coreSha256, ...overrides });
  const { session, uid, gid } = await hostService.connect("native");
  try {
    check("the login works and the user is not root", uid > 0, `uid ${uid}`);
    const adapter = await createRemoteLinuxAdapter(session, { uid, gid });
    const files = createRemoteFiles({ sftp: adapter.sftp, filesystem: adapter.filesystem });
    await session.exec(makeDirectoriesCommand(env.REMOTE_TEST_ROOT, [`run-${id}`]), { timeoutMs: 15000 });
    await session.exec(makeDirectoriesCommand(root, ["no-main", "no-zone/main"]), { timeoutMs: 15000 });
    await files.writeFileExclusive(path.posix.join(root, "no-zone/main/pak0.iwd"), Buffer.from("iwd"), { mode: 0o600 });
    check("a wrong core file name is refused", await code(install({ corePath: wrongName })) === "REMOTE_CORE_INVALID");
    check("a wrong core hash is refused", await code(install({ expectedCoreSha256: "11".repeat(32) })) === "REMOTE_CORE_INVALID");
    check("a base game without main is refused", await code(install({ basePath: path.posix.join(root, "no-main") })) === "REMOTE_BASEGAME_INVALID");
    check("a base game without zone is refused", await code(install({ basePath: path.posix.join(root, "no-zone") })) === "REMOTE_BASEGAME_INVALID");
  } finally { session.close(); }
  check("nothing was registered by the failed installs", instances.list().length === 0);

  // install, start, health, logs, stop
  const installed = await install();
  check("Install creates the instance", installed.id === id && instances.list().length === 1);
  check("a second instance on the same port of that host is refused", await code(install({ id: `${id}b`, remoteRoot: path.posix.join(root, "other") })) === "REMOTE_PORT_CONFLICT");
  await manager.start(id);
  const running = await until(async () => (await manager.status(id)).runtime.status === "RUNNING", 60000);
  check("Start: the core runs under its own identity", running, JSON.stringify((await manager.status(id)).runtime.pid));
  let health = null;
  const answered = await until(async () => { health = await manager.health(id); return health.getinfo === "OK"; }, 90000);
  check("Health: process ALIVE and getinfo answered on the server", answered && health.process === "ALIVE", JSON.stringify(health));
  let logs = null;
  const logged = await until(async () => { logs = await manager.logs(id); return (logs.stdout + logs.console).length > 0; }, 30000);
  check("Logs: output of this run", logged, `${(logs?.stdout || "").length} bytes stdout, ${(logs?.console || "").length} bytes console`);
  await manager.stop(id);
  check("Stop: the process is gone", (await manager.status(id)).runtime.status === "STOPPED");
  await manager.restart(id);
  check("Restart: running again with a new run", await until(async () => (await manager.status(id)).runtime.status === "RUNNING", 60000));
  await manager.stop(id);

  // config, backup, restore
  const original = await manager.readConfig(id);
  const backup = await manager.createBackup(id);
  const changed = original.text.replace(/^(set sv_hostname ).*$/m, '$1"Remote Gate Changed"');
  await manager.writeConfig(id, { text: changed, expectedSha256: original.sha256 });
  check("Config: the change is written", (await manager.readConfig(id)).text === changed && changed !== original.text);
  await manager.restoreBackup(id, backup.backupId);
  check("Restore: the original config is back, byte for byte", (await manager.readConfig(id)).sha256 === original.sha256);

  // a changed host key is a hard stop
  await hostService.createHost({ ...lab, id: "native-bad", label: "wrong key" });
  await hostStore.pinHostKey("native-bad", "ff".repeat(32));
  check("a changed host key stops before login", await code(hostService.connect("native-bad")) === "REMOTE_HOST_KEY_CHANGED");
} catch (error) {
  check("native remote Linux run completed", false, `${error.code || ""} ${error.message}`.trim());
} finally {
  try { await manager?.stop(id); } catch { /* not running */ }
  await fs.rm(local, { recursive: true, force: true });
}
if (checks.some(([, ok]) => !ok)) { console.log(`Leftover on the server for inspection: ${root}`); process.exit(1); }
console.log(`Server directories created by this check: ${root} (not deleted automatically)`);
console.log("Remote Linux Install -> Start -> Stop -> Logs PASS");
