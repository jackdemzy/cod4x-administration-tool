import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { InstanceRconService } from "../lib/instance-rcon-service.mjs";

// Native Block 15b check on Linux with the real CoD4x core: two bots
// (developer 1 + developer_script 1 + scr_testclients 2, verified on build 1154)
// are kicked through the real RCON client and the verified kick path.
// Usage (non-root): COD4X_CORE=... COD4X_BASEGAME=... node scripts/verify-4.18.14-kick-native.mjs
if (process.platform !== "linux") { console.log("SKIP native live kick check runs on Linux only"); process.exit(0); }
const core = process.env.COD4X_CORE || path.join(os.homedir(), "core-21.2", "cod4x18_dedrun");
const baseGame = process.env.COD4X_BASEGAME || "/mnt/c/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare";
try { await fs.access(core); await fs.access(path.join(baseGame, "main")); }
catch { console.log("SKIP native live kick check: CoD4x core or base game not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-kick-native-"));
const port = 28970 + Math.floor(Math.random() * 20);
const rconPassword = `Native${crypto.randomBytes(6).toString("hex")}`;
const server = spawn(core, ["+set", "dedicated", "1", "+set", "net_ip", "127.0.0.1", "+set", "net_port", String(port), "+set", "fs_basepath", baseGame, "+set", "fs_homepath", home,
  "+set", "rcon_password", rconPassword, "+set", "developer", "1", "+set", "developer_script", "1", "+set", "scr_testclients", "2", "+set", "sv_hostname", "KickGate", "+map", "mp_backlot"],
  { cwd: path.dirname(core), stdio: "ignore", detached: true });
const audits = [];
const rcon = new InstanceRconService({
  resolveInstance: id => ({ id, port }),
  runtimeFor: async () => ({ reconcileRuntimeState: async () => {}, state: { status: "RUNNING", pid: server.pid, runId: "native-kick" } }),
  credentialService: { withRuntimeCredentials: async (id, fn) => { const value = Buffer.from(rconPassword); try { return await fn({ rcon: value }, new AbortController().signal); } finally { value.fill(0); } } },
  audit: (level, event, details) => audits.push({ event, ...details }),
});
const names = async () => (await rcon.online("kick-native", { full: true })).players.map(player => `${player.slot}:${player.name}`).sort();

try {
  let online = [];
  for (const end = Date.now() + 90000; Date.now() < end && online.length < 2; await sleep(2000)) online = await names().catch(() => []);
  check("Online list shows the two bots of the real core", online.join(",") === "0:bot0,1:bot1", online.join(","));
  const changed = await rcon.kick("kick-native", { slot: 1, playerid: "1234567890", name: "bot1" }, "native").then(() => "kicked", error => error.code);
  check("Wrong playerid -> TARGET_CHANGED, bot stays", changed === "RCON_KICK_TARGET_CHANGED" && (await names()).includes("1:bot1"), changed);
  const wrongName = await rcon.kick("kick-native", { slot: 1, name: "bot0" }, "native").then(() => "kicked", error => error.code);
  check("Slot with another name -> TARGET_CHANGED, bot stays", wrongName === "RCON_KICK_TARGET_CHANGED" && (await names()).includes("1:bot1"), wrongName);
  const kicked = await rcon.kick("kick-native", { slot: 1, playerid: "0", name: "bot1", reason: "Native kick test" }, "native");
  await sleep(1500);
  const after = await names();
  check("Kick of slot 1 confirmed; only bot0 remains", kicked.kicked === true && after.join(",") === "0:bot0", after.join(","));
  const empty = await rcon.kick("kick-native", { slot: 5, name: "nobody" }, "native").then(() => "kicked", error => error.code);
  check("Empty slot -> NOT_ONLINE", empty === "RCON_KICK_NOT_ONLINE", empty);
  const consoleBlocked = [];
  for (const input of ["clientkick 0", "kick all", "onlykick 0"]) consoleBlocked.push(await rcon.execute("kick-native", input, "native").then(() => "sent", error => error.code));
  check("RCON console still blocks kick commands; bot0 stays", consoleBlocked.every(code => code === "RCON_COMMAND_BLOCKED") && (await names()).includes("0:bot0"), consoleBlocked.join(","));
  // B3 kick / ban-and-kick match B3 guid = CoD4x playerid: prove it with eBc-B3's own parser.
  const python = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
  const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
  const parsed = spawnSync(python, ["-E", "-c", "import sys; sys.path.insert(0, sys.argv[1]); from b3.parsers.cod4x import Cod4XParser; m = Cod4XParser._regPlayer.match(sys.argv[2].strip()); print(m.group('guid') + ' ' + m.group('slot'))",
    b3Path, "  3    12   48 1234567890          7654321           ^1Big ^7Bad Wolf 42^7                       0 203.0.113.7:28960                                     1234 25000"], { encoding: "utf8" });
  if (parsed.status === 0) check("eBc-B3's cod4x parser reads the CoD4x playerid column as guid", parsed.stdout.trim() === "1234567890 3", parsed.stdout.trim());
  else console.log("SKIP eBc-B3 guid mapping check: Python 2.7 or eBc-B3 not found");
  check("Kick audit carries slots only", audits.filter(entry => entry.event === "rcon.kick").length === 4 && !/bot0|bot1|Native kick test|127\.0\.0\.1/.test(JSON.stringify(audits.filter(entry => entry.event === "rcon.kick"))));
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message}`);
} finally {
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
  await fs.rm(home, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.14 native live kick check PASS (real CoD4x core, bots kicked by verified slot)");
