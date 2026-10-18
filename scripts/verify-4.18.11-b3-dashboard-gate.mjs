import fs from "node:fs/promises";
import path from "node:path";
import { createB3InstanceFixture } from "../test/support/b3-instance-fixture.mjs";

// Block 13 gate: B3 Manager Health Dashboard. Real ServerInstanceManager and
// InstanceB3Service with test doubles for the CoD4x core and B3 processes; B3
// log lines use the exact eBc-B3 9096624 format seen in the native runs.
// Native evidence: scripts/verify-4.18.11-b3-dashboard-native.mjs (real core + B3).
const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const LOG = [
  "261019 01:07:24 BOT      'Starting Cod4XParser v0.4 for server 127.0.0.1:28996 (autorestart = True)'",
  "261019 01:07:24 BOT      'Using database file: /home/x/b3/b3.db'",
  "261019 01:07:28 DEBUG    'Get cvar fs_game = [main]'",
  "261019 01:07:33 INFO     'PublistPlugin: publist will not send heartbeat to master server as publicIp is not public'",
  "261019 01:07:33 BOT      'Start reading game events'",
].join("\n") + "\n";
const marks = board => Object.entries(board.checks).filter(([key]) => key !== "database").map(([key, value]) => `${key}=${value.ok === true ? "✓" : value.ok === false ? "✗" : "–"}`).join(" ");

async function scenario(name, dependencies, action) {
  const fixture = await createB3InstanceFixture(dependencies ? { dependencies } : undefined);
  try { await fixture.create("dash"); await action(fixture); }
  catch (error) { check(`${name}: unexpected error`, false, `${error.code || ""} ${error.message}`); }
  finally { await fixture.cleanup(); }
}

await scenario("healthy", null, async ({ manager, b3Service, store }) => {
  await manager.launch("dash");
  await b3Service.start("dash");
  const logFile = path.join(store.get("dash").homePath, "b3", "b3.log");
  await fs.writeFile(logFile, LOG);
  let board = await b3Service.dashboard("dash", { fresh: true });
  check("Dashboard: Status RUNNING, Version eBc/B3 1.10.10 @ 9096624, Parser Cod4XParser, Database sqlite:CONNECTED, RCON CONNECTED",
    board.status === "RUNNING" && board.version.label === "eBc/B3" && board.version.commit === "9096624" && board.parser === "Cod4XParser v0.4" && board.database === "sqlite:CONNECTED" && board.rcon === "CONNECTED");
  check("Health checks: Python ✓ B3 ✓ MySQL – (SQLite until Block 14) Parser ✓ RCON ✓ CoD4X ✓", marks(board) === "python=✓ b3=✓ mysql=– parser=✓ rcon=✓ cod4x=✓", marks(board));
  check("No diagnosis while healthy; publist suppressed", board.diagnosis.length === 0 && board.publist === "SUPPRESSED");
  await fs.appendFile(logFile, "261019 01:08:00 DEBUG    'Get cvar fs_game = [No rconpassword set on server or password is shorter than 8 characters.\\n]'\n");
  board = await b3Service.dashboard("dash");
  check("RCON offline (password rejected) while CoD4X is up", board.primary === "RCON_OFFLINE" && board.checks.cod4x.ok === true, board.diagnosis.join(","));
  await fs.appendFile(logFile, "261019 01:08:01 ERROR    'Database connection failed: (2003)'\n");
  check("DB offline", (await b3Service.dashboard("dash")).diagnosis.includes("DB_OFFLINE"));
  await fs.appendFile(logFile, "261019 01:08:02 CRITICAL 'Cannot setup RCON: boom'\n");
  check("Parser offline on a critical B3 error", (await b3Service.dashboard("dash")).diagnosis.includes("PARSER_OFFLINE"));
  await manager.stop("dash");
  board = await b3Service.dashboard("dash");
  check("CoD4X offline is the primary cause; B3 keeps running", board.primary === "COD4X_OFFLINE" && board.status === "RUNNING", board.diagnosis.join(","));
  const logs = await b3Service.logs("dash"), config = await b3Service.config("dash");
  check("[ Logs ] returns the redacted B3 log", logs.b3Log.includes("Start reading game events") && !logs.b3Log.includes("rconpassword"));
  check("[ Config ] returns the generated config with credentials redacted", config.exists && /<set name="rcon_password">\[redacted\]<\/set>/.test(config.text) && config.summary.publicIp === "127.0.0.1");
});
for (const [label, code, dependencies] of [
  ["Python fehlt", "PYTHON_MISSING", { overall: "BLOCKED", blocking: ["python"], results: [{ id: "python", status: "MISSING" }, { id: "b3-source", status: "OK" }, { id: "dateutil", status: "OK" }, { id: "mysql-driver", status: "OK" }] }],
  ["B3 fehlt", "B3_MISSING", { overall: "BLOCKED", blocking: ["b3-source"], results: [{ id: "python", status: "OK", found: "2.7.18" }, { id: "b3-source", status: "MISSING" }, { id: "dateutil", status: "OK" }, { id: "mysql-driver", status: "OK" }] }],
  ["Dependency fehlt", "DEPENDENCY_MISSING", { overall: "BLOCKED", blocking: ["dateutil"], results: [{ id: "python", status: "OK", found: "2.7.18" }, { id: "b3-source", status: "OK" }, { id: "dateutil", status: "MISSING" }, { id: "mysql-driver", status: "OK" }] }],
]) {
  await scenario(label, dependencies, async ({ manager, b3Service }) => {
    await manager.launch("dash");
    const board = await b3Service.dashboard("dash", { fresh: true });
    check(`Diagnosis: ${label} -> ${code} (primary)`, board.primary === code, board.diagnosis.join(","));
  });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.11 B3 Manager Health Dashboard gate PASS (test doubles; native: scripts/verify-4.18.11-b3-dashboard-native.mjs)");
