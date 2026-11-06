import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { B3Runtime } from "../lib/b3-runtime.mjs";
import { prepareB3Runtime } from "../lib/b3-config.mjs";
import { parseB3Log } from "../lib/b3-manager.mjs";
import { planB3Integration, normalizeB3Integration, KNOWN_B3HIDE_HASHES } from "../lib/b3-integration.mjs";
import { pluginLaunchArguments, classifyPluginLog } from "../lib/plugin-manager.mjs";
import { readInstanceConsoleLog } from "../lib/instance-console-log.mjs";
import { parseStatus } from "../lib/rcon-status.mjs";
import { RconClient } from "../lib/rcon-client.mjs";
import { InstanceRconService } from "../lib/instance-rcon-service.mjs";

// Native Block 16 check on Linux: real CoD4x 21.2 core + the official 21.2
// release b3hide.so + real Python 2.7 + eBc-B3 (SQLite storage), loopback only,
// two bots. The launch arguments, b3.xml and plugin_auth.ini come from the same
// CONTROL functions the backend uses.
// Usage (non-root): COD4X_CORE=... COD4X_BASEGAME=... COD4X_B3HIDE_SO=... node scripts/verify-4.18.20-b3-integration-native.mjs
// COD4X_RELEASE_CORE: optional second core (from cod4x_server-linux_21.2.zip) tried when b3hide does not load in the first.
if (process.platform !== "linux") { console.log("SKIP native B3 integration check runs on Linux only"); process.exit(0); }
const cores = [process.env.COD4X_CORE || path.join(os.homedir(), "core-21.2", "cod4x18_dedrun"), process.env.COD4X_RELEASE_CORE].filter(Boolean);
const baseGame = process.env.COD4X_BASEGAME || "/mnt/c/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare";
const b3hideSo = process.env.COD4X_B3HIDE_SO || "/mnt/c/Users/r4f1k1/cod4x-b3/b3hide-21.2-release/b3hide.so";
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
try { for (const file of [cores[0], path.join(baseGame, "main"), b3hideSo, pythonPath, path.join(b3Path, "b3", "extplugins", "auth.py")]) await fs.access(file); }
catch { console.log("SKIP native B3 integration check: core, base game, release b3hide.so, Python 2.7 or eBc-B3 not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(500)) if (await predicate()) return true; return false; }
const sha256 = buffer => crypto.createHash("sha256").update(buffer).digest("hex");

const plugin = await fs.readFile(b3hideSo);
if (sha256(plugin) !== KNOWN_B3HIDE_HASHES.linux) { console.log(`FAIL release b3hide.so hash (${sha256(plugin)})`); process.exit(1); }
check("b3hide.so is the official 21.2 release build", true, KNOWN_B3HIDE_HASHES.linux.slice(0, 12));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-integration-"));
const home = path.join(root, "home");
const port = 28950 + Math.floor(Math.random() * 20);
const rconPassword = `Native${crypto.randomBytes(6).toString("hex")}`;
const authPassword = `Auth${crypto.randomBytes(5).toString("hex")}`;
const instance = { id: "b3-integration", homePath: home, port, platform: "linux", b3Integration: normalizeB3Integration({ hideCommands: true, prefix: "!", hideLevel: 40 }) };
let server = null, runtime = null, usedCore = null;
const rconClient = new RconClient({ port, timeoutMs: 1500 });
// Gate-only raw RCON for checks outside CONTROL's console allowlist (dvar reads,
// client_checkin). CONTROL itself never sends these.
const raw = command => new Promise((resolve, reject) => {
  const socket = dgram.createSocket("udp4"), parts = [];
  const done = () => { socket.close(); resolve(parts.join("")); };
  socket.on("message", message => { if (message.subarray(0, 4).equals(Buffer.from([255, 255, 255, 255]))) parts.push(message.subarray(4).toString("latin1").replace(/^print\n/, "")); });
  socket.on("error", error => { socket.close(); reject(error); });
  socket.send(Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from(`rcon ${rconPassword} ${command}`, "latin1")]), port, "127.0.0.1", error => { if (error) reject(error); else setTimeout(done, 1200); });
});
const audits = [];
const rcon = new InstanceRconService({
  resolveInstance: id => ({ id, port }),
  runtimeFor: async () => ({ reconcileRuntimeState: async () => {}, state: { status: "RUNNING", pid: server?.pid, runId: "native-b3i" } }),
  credentialService: { withRuntimeCredentials: async (id, fn) => { const value = Buffer.from(rconPassword); try { return await fn({ rcon: value }, new AbortController().signal); } finally { value.fill(0); } } },
  audit: (level, event, details) => audits.push({ event, ...details }),
  statusFormat: async () => "b3hide",
});

async function startServer(core) {
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(path.join(home, "plugins"), { recursive: true });
  await fs.mkdir(path.join(home, "main", "logs"), { recursive: true });
  await fs.writeFile(path.join(home, "plugins", "b3hide.so"), plugin);
  // Same plan and plugin launch path as ServerInstanceManager.launch.
  const plan = planB3Integration({ settings: instance.b3Integration, b3hideState: "ENABLED", authPluginPresent: true, credentialsPresent: { rcon: true, b3authLevels: [100] } });
  const launchInstance = { ...instance, plugins: [{ name: "b3hide", platform: "linux", sha256: sha256(plugin), bytes: plugin.length, enabled: true, approvedAt: new Date().toISOString(), source: "approved", config: plan.b3hide }] };
  const plugins = await pluginLaunchArguments(launchInstance);
  server = spawn(core, ["+set", "dedicated", "1", "+set", "net_ip", "127.0.0.1", "+set", "net_port", String(port), "+set", "fs_basepath", baseGame, "+set", "fs_homepath", home,
    "+set", "rcon_password", rconPassword, "+set", "developer", "1", "+set", "developer_script", "1", "+set", "scr_testclients", "2", "+set", "sv_hostname", "B3IntegrationGate",
    ...plugins.args, "+set", "g_log", "logs/games_mp.log", "+set", "g_logsync", "1", "+set", "logfile", "2", "+map", "mp_backlot"], { cwd: path.dirname(core), stdio: "ignore", detached: true });
  const up = await until(async () => { try { await rconClient.probe(); return true; } catch { return false; } }, 90000);
  const loads = up ? (await readInstanceConsoleLog(home, { inspect: classifyPluginLog })).inspection || {} : {};
  return { up, loaded: loads.b3hide === "LOADED", plan, load: loads.b3hide || "NONE" };
}
const stopServer = async () => { if (server && server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } await delay(1000); } };

try {
  let started = null;
  for (const core of cores) {
    started = await startServer(core);
    if (started.up && started.loaded) { usedCore = core; break; }
    console.log(`INFO b3hide not loaded with ${core} (up=${started.up}, load=${started.load})`);
    await stopServer();
  }
  check("The core loads b3hide (console load message)", Boolean(usedCore), usedCore || started?.load);
  if (!usedCore) throw Object.assign(new Error("b3hide did not load in any core"), { code: "B3HIDE_NOT_LOADED" });
  const dvars = await Promise.all(["b3Prefix", "b3Hide", "b3HideLvl"].map(raw));
  check("b3Prefix/b3Hide/b3HideLvl read back as CONTROL's !, 1, 40 (level 40, not the plugin default 20)", /"b3Prefix" is:\s*"!/.test(dvars[0]) && /"b3Hide" is:\s*"1/.test(dvars[1]) && /"b3HideLvl" is:\s*"40/.test(dvars[2]), dvars.map(value => value.trim().split("\n")[0]).join(" | "));

  let status = { players: [] };
  await until(async () => { status = parseStatus(await raw("status"), { format: "b3hide" }); return status.players.length >= 2; }, 60000);
  check("status is the b3hide format and lists the two bots", status.header && status.format === "b3hide" && status.players.map(player => `${player.slot}:${player.name}:${player.bot}`).join(",") === "0:bot0:true,1:bot1:true",
    status.players.map(player => `${player.slot}:${player.name}`).join(","));

  // B3 with the generated b3.xml (RCON password, auth entry) and plugin_auth.ini.
  const prepared = await prepareB3Runtime(instance, "logs/games_mp.log", { rconPassword, auth: { passwords: { 100: authPassword } } });
  runtime = new B3Runtime({ instanceId: instance.id, platform: "linux", stateFile: path.join(home, "logs", "b3-runtime-state.json"), paths: prepared, startupGraceMs: 4000 });
  await runtime.load();
  await runtime.start({ pythonPath, b3Path, configPath: prepared.config });
  check("B3 reaches HEALTHY with the generated config", await until(async () => (await runtime.health()).status === "HEALTHY", 60000));
  let log = parseB3Log("");
  await until(async () => { log = await runtime.inspectLog(parseB3Log); return log.auth === "STARTED" && log.rcon.state === "CONNECTED" && log.parser.reading; }, 60000);
  check("B3 reads the game log with the cod4x parser", log.parser.reading && log.parser.name === "Cod4XParser", `${log.parser.name} reading=${log.parser.reading}`);
  check("B3 talks to the core over RCON with the vault password", log.rcon.state === "CONNECTED", log.rcon.state);
  check("The auth plugin started (registered CLIENT_AUTH event)", log.auth === "STARTED", String(log.auth));

  const checkin = await raw("client_checkin 0 100"), usage = await raw("client_checkin x y");
  check("client_checkin is b3hide's command: a valid call is accepted, a malformed one prints its usage", !/Invalid Arguments|Unknown command/i.test(checkin) && /Invalid Arguments/.test(usage) && /checkinlvl <slot> <level>/.test(usage), usage.trim().split("\n")[0] || "(no output)");
  const b3log = await fs.readFile(prepared.logFile, "utf8").catch(() => "");
  const botCheckin = /Checked in client/.test(b3log);
  console.log(botCheckin ? "INFO B3 auth checked in a client by itself" : "INFO B3 auth did not check in a bot by itself (bots may not raise EVT_CLIENT_AUTH); covered by the manual RCON check above");

  // b3hide hides only "!", while B3 also runs @ & / commands: a public "@auth"
  // raises the dashboard alarm from B3's VERBOSE "Queueing event EVT_CLIENT_SAY :
  // <text>" line (b3/parser.py queueEvent). That line needs a real client: B3
  // queues only events with a handler (admin/auth: client events), and the cod4x
  // parser lists players from b3status with an IP regex, so bots never become B3
  // clients (connectClient() = {}). Natively only the log level is checked; the
  // line shape is covered by test/b3-manager.test.mjs.
  const verbose = b3log.split("\n").find(line => /^\d{6} \d{2}:\d{2}:\d{2}\s+VERBOSE\s/.test(line)) || null;
  check("B3 writes VERBOSE lines at log_level 9 (needed to see 'Queueing event EVT_CLIENT_SAY')", Boolean(verbose), verbose ? verbose.slice(0, 100) : "no VERBOSE line");

  const kicked = await rcon.kick("b3-integration", { slot: 1, playerid: "0", name: "bot1", reason: "Native b3hide kick" }, "native");
  await delay(1500);
  const after = parseStatus(await raw("status"), { format: "b3hide" }).players.map(player => `${player.slot}:${player.name}`).join(",");
  check("Verified slot kick works in the b3hide format", kicked.kicked === true && after === "0:bot0", after);

  const stdout = await fs.readFile(prepared.stdout, "utf8").catch(() => ""), stderr = await fs.readFile(prepared.stderr, "utf8").catch(() => "");
  const leak = [b3log, stdout, stderr, JSON.stringify(audits)].join("\n");
  check("No RCON or !auth password in B3 logs, B3 output or audit", !leak.includes(rconPassword) && !leak.includes(authPassword));
  await runtime.stop();
  check("B3 stopped cleanly", runtime.state.status === "STOPPED");
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message}`);
} finally {
  if (runtime?.running) await runtime.stop().catch(() => {});
  await stopServer();
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`4.18.20 native B3 integration check PASS (real CoD4x 21.2 core ${usedCore}, release b3hide.so, eBc-B3 auth over RCON)`);
