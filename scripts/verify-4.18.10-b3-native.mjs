import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { B3Environment } from "../lib/b3-dependencies.mjs";
import { B3Runtime, linuxProcessIdentity } from "../lib/b3-runtime.mjs";
import { prepareB3Runtime } from "../lib/b3-config.mjs";

// Native Block 12 check on Linux: real Python 2.7, real eBc-B3, real processes.
// Uses SQLite storage and an empty game log; no CoD4x server and no MySQL needed.
// Usage (non-root): B3_PYTHON=/path/python2.7 B3_SOURCE=/path/ebc-b3 node scripts/verify-4.18.10-b3-native.mjs
if (process.platform !== "linux") { console.log("SKIP native B3 lifecycle check runs on Linux only"); process.exit(0); }
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
// Hosts without a Python 2.7 / eBc-B3 setup (e.g. CI runners) skip instead of failing,
// like the Block 13 dashboard check does for a missing CoD4x core.
try { await fs.access(pythonPath); await fs.access(path.join(b3Path, "b3_run.py")); }
catch { console.log("SKIP native B3 lifecycle check: Python 2.7 or eBc-B3 not found"); process.exit(0); }
const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(250)) if (await predicate()) return true; return false; }

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-native-"));
let sibling;
try {
  const environment = new B3Environment(path.join(root, "b3-environment.json"));
  await environment.save({ pythonPath, b3Path });
  const dependencies = await environment.check();
  check("Dependency gate READY_FOR_RUNTIME_TEST", dependencies.overall === "READY_FOR_RUNTIME_TEST", `${dependencies.overall} ${dependencies.blocking.join(",")}`);

  const instance = { id: "b3-native", homePath: path.join(root, "home"), port: 28999, platform: "linux" };
  await fs.mkdir(path.join(instance.homePath, "logs"), { recursive: true });
  const prepared = await prepareB3Runtime(instance, "logs/games_mp.log");
  const events = [];
  const make = () => new B3Runtime({ instanceId: instance.id, platform: "linux", stateFile: path.join(instance.homePath, "logs", "b3-runtime-state.json"), paths: prepared, onEvent: event => events.push(event), startupGraceMs: 4000 });
  const options = { pythonPath, b3Path, configPath: prepared.config };

  // Stand-in for an independent server process next to B3.
  sibling = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  const siblingAlive = async () => (await linuxProcessIdentity(sibling.pid)).alive === true;

  const runtime = make(); await runtime.load();
  const started = await runtime.start(options);
  check("START -> RUNNING with verified PID", started.status === "RUNNING" && Number.isInteger(started.pid), `pid ${started.pid}`);
  const identity = await linuxProcessIdentity(started.pid);
  check("Process is python2.7 b3_run.py --config <instance b3.xml>, not root", identity.argv?.[0] === pythonPath && identity.argv?.includes(prepared.config) && identity.uid !== 0, (identity.argv || []).slice(1, 4).join(" "));
  const healthy = await until(async () => (await runtime.health()).status === "HEALTHY", 45000);
  const health = await runtime.health();
  check("Health HEALTHY (B3 log: 'Start reading game events')", healthy, `${health.status} ready=${health.ready} errors=${health.errors}`);
  // No CoD4x server runs here: B3 must stay up and report RCON as unreachable.
  const rconReported = await until(async () => (await runtime.health()).rcon === "UNREACHABLE", 20000);
  check("B3 stays RUNNING without a CoD4x server; health reports RCON UNREACHABLE", rconReported && runtime.state.status === "RUNNING", (await runtime.health()).rcon);

  process.kill(started.pid, "SIGKILL");
  const crashed = await until(async () => runtime.state.status === "CRASHED", 10000);
  check("Crash detection: SIGKILL -> CRASHED with signal", crashed && runtime.state.signal === "SIGKILL", `${runtime.state.status} ${runtime.state.signal}`);
  check("Independent process keeps running after B3 crash", await siblingAlive());

  const second = await runtime.start(options);
  check("RESTART after crash -> RUNNING with new PID", second.status === "RUNNING" && second.pid !== started.pid, `pid ${second.pid}`);
  // Backend restart: a fresh runtime object only has the persisted state.
  runtime.release();
  const adopted = make(); await adopted.load();
  check("Backend restart: persisted run is re-identified via /proc", adopted.snapshot().status === "RUNNING" && adopted.snapshot().pid === second.pid);
  const stoppedByAdopter = await adopted.stop();
  check("STOP without child handle -> STOPPED, process gone", stoppedByAdopter.status === "STOPPED" && (await linuxProcessIdentity(second.pid)).alive === false);

  // The released object is stale like a dead backend; continue with the adopter.
  const third = await adopted.start(options);
  const graceful = await adopted.stop();
  check("START -> RUNNING -> STOP -> STOPPED (SIGTERM)", third.status === "RUNNING" && graceful.status === "STOPPED" && (await linuxProcessIdentity(third.pid)).alive === false);
  check("Independent process unaffected by B3 start/stop/restart", await siblingAlive());
  check("Lifecycle events recorded", ["b3.started", "b3.crashed", "b3.stopped"].every(name => events.some(event => event.event === name)), events.map(event => event.event).join(","));
  check("No B3 process left over", (await linuxProcessIdentity(third.pid)).alive === false && (await linuxProcessIdentity(second.pid)).alive === false);
  const output = await adopted.outputTail();
  check("Captured output is redacted and bounded", output.length <= 32 * 1024 && !/rcon_password\s*=\s*\S/.test(output));
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message} ${error.output ? "\n" + error.output.slice(-1500) : ""}`);
} finally {
  if (sibling) { try { process.kill(sibling.pid, "SIGKILL"); } catch { /* already gone */ } }
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.10 native B3 lifecycle check PASS (real Python 2.7 + eBc-B3, SQLite; no CoD4x server process)");
