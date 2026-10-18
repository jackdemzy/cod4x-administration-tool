import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { B3Environment } from "../lib/b3-dependencies.mjs";
import { B3Runtime } from "../lib/b3-runtime.mjs";
import { prepareB3Runtime } from "../lib/b3-config.mjs";
import { parseB3Log, parseB3ConfigSummary, buildB3Dashboard } from "../lib/b3-manager.mjs";
import { RconClient } from "../lib/rcon-client.mjs";

// Native Block 13 check on Linux: real CoD4x Linux core + real Python 2.7 +
// eBc-B3, local only (net_ip 127.0.0.1, dedicated 1 = LAN, no master contact).
// The server has no rcon_password (vault transfer to B3 is Block 16), so B3's
// RCON must be diagnosed as AUTH_FAILED while CoD4X itself is reachable.
// Usage (non-root): COD4X_CORE=... COD4X_BASEGAME=... node scripts/verify-4.18.11-b3-dashboard-native.mjs
if (process.platform !== "linux") { console.log("SKIP native B3 dashboard check runs on Linux only"); process.exit(0); }
const core = process.env.COD4X_CORE || path.join(os.homedir(), "core-21.2", "cod4x18_dedrun");
const baseGame = process.env.COD4X_BASEGAME || "/mnt/c/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare";
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
const port = 28997;
try { await fs.access(core); await fs.access(path.join(baseGame, "main")); } catch { console.log("SKIP native B3 dashboard check: CoD4x Linux core or BaseGame not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(500)) if (await predicate()) return true; return false; }
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-dashboard-"));
const home = path.join(root, "home");
let server = null, runtime = null;
const serverStatus = async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return { status: "STOPPED", reachable: false };
  try { await new RconClient({ port, timeoutMs: 800 }).probe(); return { status: "RUNNING", reachable: true }; } catch { return { status: "RUNNING", reachable: false }; }
};
try {
  const environment = new B3Environment(path.join(root, "b3-environment.json"));
  await environment.save({ pythonPath, b3Path });
  const dependencies = await environment.check();
  await fs.mkdir(path.join(home, "main", "logs"), { recursive: true });
  server = spawn(core, ["+set", "dedicated", "1", "+set", "net_ip", "127.0.0.1", "+set", "net_port", String(port), "+set", "fs_basepath", baseGame, "+set", "fs_homepath", home,
    "+set", "g_log", "logs/games_mp.log", "+set", "g_logsync", "1", "+set", "sv_hostname", "B3DashboardGate", "+map", "mp_backlot"], { cwd: path.dirname(core), stdio: "ignore", detached: true });
  check("Real CoD4x Linux core answers getinfo on 127.0.0.1", await until(async () => (await serverStatus()).reachable, 90000));

  const prepared = await prepareB3Runtime({ id: "b3-dashboard", homePath: home, port }, "logs/games_mp.log");
  runtime = new B3Runtime({ instanceId: "b3-dashboard", platform: "linux", stateFile: path.join(home, "logs", "b3-runtime-state.json"), paths: prepared, startupGraceMs: 4000 });
  await runtime.load();
  await runtime.start({ pythonPath, b3Path, configPath: prepared.config });
  const board = async () => {
    // Same path as InstanceB3Service.dashboard: classify the raw log, return codes only.
    const [snapshot, health, log] = [await runtime.reconcile(), await runtime.health(), await runtime.inspectLog(parseB3Log)];
    return buildB3Dashboard({ dependencies, runtime: snapshot, health, log, config: parseB3ConfigSummary(await fs.readFile(prepared.config, "utf8")), server: await serverStatus() });
  };
  check("B3 reaches HEALTHY next to the real server", await until(async () => (await runtime.health()).status === "HEALTHY", 60000));
  const settled = await until(async () => (await board()).checks.rcon.ok !== null, 30000);
  let dashboard = await board();
  const marks = Object.entries(dashboard.checks).map(([key, value]) => `${key}=${value.ok === true ? "✓" : value.ok === false ? "✗" : "–"}`).join(" ");
  check("Health checks: Python ✓ B3 ✓ Parser ✓ CoD4X ✓", ["python", "b3", "parser", "cod4x"].every(key => dashboard.checks[key].ok === true), marks);
  check("Database ✓ (SQLite connected), MySQL – until Block 14", dashboard.checks.database.ok === true && dashboard.checks.mysql.ok === null, `${dashboard.database} / ${dashboard.checks.mysql.state}`);
  check("RCON answer without password is AUTH_FAILED, not 'connected'", settled && dashboard.rcon === "AUTH_FAILED" && dashboard.checks.rcon.ok === false, dashboard.rcon);
  check("Diagnosis: RCON_OFFLINE is the primary cause while CoD4X is up", dashboard.primary === "RCON_OFFLINE" && !dashboard.diagnosis.includes("COD4X_OFFLINE"), dashboard.diagnosis.join(","));
  check("Parser is the CoD4x parser of eBc-B3", dashboard.parser === "Cod4XParser v0.4", dashboard.parser);
  const rawLog = await runtime.inspectLog(parseB3Log);
  check("publist (B3 must-have plugin) stays silent: public_ip 127.0.0.1, B3 confirms in its log", dashboard.publist === "SUPPRESSED" && rawLog.publist === "SUPPRESSED", `${dashboard.publist} / ${rawLog.publist}`);

  process.kill(-server.pid, "SIGTERM");
  await until(async () => (await serverStatus()).status === "STOPPED", 20000);
  dashboard = await board();
  check("Server stopped: B3 keeps RUNNING, CoD4X_OFFLINE is the primary cause", dashboard.status === "RUNNING" && dashboard.primary === "COD4X_OFFLINE", `${dashboard.status} ${dashboard.diagnosis.join(",")}`);
  await runtime.stop();
  check("B3 stopped cleanly afterwards", runtime.state.status === "STOPPED");
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message}`);
} finally {
  if (runtime?.running) await runtime.stop().catch(() => {});
  if (server && server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } }
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.11 native B3 Manager Health Dashboard check PASS (real CoD4x 21.2 Linux core + Python 2.7 + eBc-B3, loopback only)");
