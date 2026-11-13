import crypto from "node:crypto";
import fs from "node:fs/promises";
import { RconClient } from "../lib/rcon-client.mjs";
import path from "node:path";
import { e2eBackend, consecutiveUdpPorts, createInstance, adoptCore, udpAsk, answers, silent, until, ok } from "../test/support/e2e-backend.mjs";

// Block 22 native E2E (4.18.28): the roadmap flow with the REAL cod4x18_dedrun and real game
// files, through the real backend over HTTP: Install (adopt) -> Detect Core -> BaseGame ->
// Create Server -> Config -> Start -> Map -> RCON -> Master List -> B3 -> Stop -> Restart,
// three servers on consecutive ports, and a core crash. What a fake core cannot show: the real
// process answers, changes maps, and dies/restarts on its own port.
// Client Join with a real iw3mp client stays a manual step (docs/WSL-NATIVE-CHECKLIST.md).
// Usage (Linux/WSL, non-root, umask 022):
//   COD4X_CORE=~/core-21.2/cod4x18_dedrun COD4X_BASEGAME=~/cod4-base node scripts/verify-4.18.28-e2e-native.mjs
// Optional: COD4X_E2E_MASTER_TOKEN=<token> also checks the master list state with a real token
// (the instance stays loopback-bound, so "listed" is not expected; only a named state).
if (process.platform !== "linux") { console.log("SKIP native E2E runs on Linux/WSL only"); process.exit(0); }
if (process.getuid?.() === 0) { console.log("SKIP native E2E must not run as root (the runtime refuses root)"); process.exit(0); }
const core = process.env.COD4X_CORE, baseGame = process.env.COD4X_BASEGAME;
if (!core || !baseGame) { console.log("SKIP native E2E: set COD4X_CORE and COD4X_BASEGAME"); process.exit(0); }
try { for (const file of [core, path.join(baseGame, "main"), path.join(baseGame, "zone")]) await fs.access(file); }
catch { console.log("SKIP native E2E: core or base game not found"); process.exit(0); }

const checks = [];
const cleanups = [];
const t = { after: fn => cleanups.unshift(fn) };
const step = async (name, action) => {
  try { await action(); await backend.assertAlive(name); checks.push([name, true, ""]); console.log(`PASS ${name}`); }
  catch (error) { checks.push([name, false, error.message]); console.log(`FAIL ${name}: ${error.message.slice(0, 600)}`); throw error; }
};
const coreAnswers = port => answers(port, 30000);
let backend;
try {
  backend = await e2eBackend(t, { prefix: "cod4x-e2e-native-" });
  const { request } = backend;
  const ports = await consecutiveUdpPorts(3);
  const servers = ports.map((port, index) => ({ id: `native-${index + 1}`, port, hostname: `NativeE2E${index + 1}`, rcon: `NativeE2eRcon${index + 1}x${crypto.randomBytes(6).toString("hex")}` }));
  const [first] = servers;
  let firstPid;

  await step("Install: adopt the real core", () => adoptCore(backend, { core, baseGame }));
  await step("Detect Core + BaseGame: verified core, valid base game", async () => {
    const query = new URLSearchParams({ path: path.join(backend.root, "legacy-home"), executablePath: core, baseGamePath: baseGame, cod4x: "21.2", platform: "linux" });
    const preflight = await request(`/api/runtime/preflight?${query}`);
    ok(preflight, "preflight");
    if (preflight.json.core.verified !== true || preflight.json.baseGame.valid !== true) throw new Error(JSON.stringify({ core: preflight.json.core, baseGame: preflight.json.baseGame }));
  });
  await step("Create Server + Config (three instances)", async () => { for (const server of servers) await createInstance(backend, { ...server, core, baseGame }); });
  if (process.env.COD4X_E2E_MASTER_TOKEN) await step("Master token stored", async () => {
    const { sha256 } = (await request(`/api/instances/${first.id}/credentials`)).json.credentials;
    ok(await request(`/api/instances/${first.id}/credentials/master`, { expectedSha256: sha256, value: process.env.COD4X_E2E_MASTER_TOKEN }), "set master token");
  });
  await step("Start: the real core answers on its port", async () => {
    const started = await request(`/api/instances/${first.id}/start`, {});
    ok(started, "start");
    firstPid = started.json.runtime.pid;
    if (!await coreAnswers(first.port)) throw new Error(`no answer on ${first.port}`);
    const info = await udpAsk(first.port, "getinfo native");
    if (!info.includes(`hostname\\${first.hostname}`)) throw new Error(`unexpected identity: ${info}`);
  });
  await step("Map: rcon map mp_crash", async () => {
    const connected = await request(`/api/instances/${first.id}/rcon/connect`, {});
    ok(connected, "rcon connect");
    if (connected.json.rcon.provisioning !== "PROVISIONED") throw new Error(`provisioning ${connected.json.rcon.provisioning}`);
    ok(await request(`/api/instances/${first.id}/rcon/command`, { command: "map mp_crash" }), "map");
    if (!await until(async () => (await udpAsk(first.port, "getinfo native", 500)).includes("mapname\\mp_crash"), 30000)) throw new Error("map did not change");
  });
  await step("RCON: status", async () => {
    const status = await request(`/api/instances/${first.id}/rcon/command`, { command: "status" });
    ok(status, "status");
    if (!/map:\s*mp_crash/.test(JSON.stringify(status.json.result))) throw new Error(JSON.stringify(status.json.result).slice(0, 300));
  });
  await step("Master List: named state, no 5xx", async () => {
    const master = await request(`/api/instances/${first.id}/master/verify`, {}, "POST", { timeoutMs: 60000 });
    ok(master, "master verify");
    if (!/^[A-Z_]+$/.test(master.json.master?.state || "")) throw new Error(`no named master state: ${JSON.stringify(master.json.master)}`);
    console.log(`INFO master state ${master.json.master.state} ${master.json.master.reason || ""} list=${JSON.stringify(master.json.master.list)}`);
  });
  await step("B3: status and start answer with a named state", async () => {
    ok(await request(`/api/instances/${first.id}/b3`), "b3 status");
    const started = await request(`/api/instances/${first.id}/b3/start`, {});
    if (started.status >= 500 || (started.status >= 400 && !/^B3_[A-Z_]+$/.test(started.json?.code || ""))) throw new Error(`HTTP ${started.status} ${JSON.stringify(started.json)}`);
    console.log(`INFO b3 start HTTP ${started.status} ${started.json?.code || "started"}`);
    if (started.status < 300) ok(await request(`/api/instances/${first.id}/b3/stop`, {}), "b3 stop");
  });
  await step("Multi-Server: three real cores on consecutive ports, own passwords only", async () => {
    for (const server of servers.slice(1)) ok(await request(`/api/instances/${server.id}/start`, {}), `start ${server.id}`);
    for (const server of servers) {
      if (!await coreAnswers(server.port)) throw new Error(`${server.id} does not answer`);
      if (!(await udpAsk(server.port, "getinfo native")).includes(`hostname\\${server.hostname}`)) throw new Error(`${server.id} wrong identity`);
      const rcon = password => new RconClient({ port: server.port, timeoutMs: 2000 }).execute(Buffer.from(password), "serverinfo");
      await rcon(server.rcon);
      for (const other of servers.filter(value => value !== server)) {
        // The real core answers a wrong password at most once per 100 ms.
        await new Promise(resolve => setTimeout(resolve, 150));
        const accepted = await rcon(other.rcon).then(() => true, error => error.code !== "RCON_AUTH_FAILED" ? Promise.reject(error) : false);
        if (accepted) throw new Error(`${server.id} accepted the password of ${other.id}`);
      }
    }
    ok(await request(`/api/instances/${servers[1].id}/stop`, {}), "stop native-2");
    if (!await silent(servers[1].port, 15000)) throw new Error("native-2 still answers");
    if (!await answers(servers[0].port, 3000) || !await answers(servers[2].port, 3000)) throw new Error("a sibling went down");
    ok(await request(`/api/instances/${servers[1].id}/start`, {}), "start native-2 again");
    if (!await coreAnswers(servers[1].port)) throw new Error("native-2 did not come back");
  });
  await step("Stop + Restart: same port, new process", async () => {
    ok(await request(`/api/instances/${first.id}/stop`, {}), "stop");
    if (!await silent(first.port, 15000)) throw new Error("still answers after stop");
    const again = await request(`/api/instances/${first.id}/start`, {});
    ok(again, "start");
    if (!await coreAnswers(first.port)) throw new Error("no answer after start");
    const restarted = await request(`/api/instances/${first.id}/restart`, {});
    ok(restarted, "restart");
    if (restarted.json.runtime.pid === again.json.runtime.pid || restarted.json.runtime.pid === firstPid) throw new Error("same pid after restart");
    if (!await coreAnswers(first.port)) throw new Error("no answer after restart");
  });
  await step("Server crash: SIGKILL is detected, start works again", async () => {
    const status = await request(`/api/instances/${first.id}`);
    process.kill(status.json.instance.runtime.pid, "SIGKILL");
    if (!await until(async () => (await request(`/api/instances/${first.id}`)).json.instance.runtime?.status === "FAILED", 15000)) throw new Error("crash not detected");
    ok(await request(`/api/instances/${first.id}/start`, {}), "start after crash");
    if (!await coreAnswers(first.port)) throw new Error("no answer after crash restart");
  });
  await step("Backend restart: instances survive and start", async () => {
    for (const server of servers) await request(`/api/instances/${server.id}/stop`, {});
    await backend.restart();
    ok(await request(`/api/instances/${first.id}/start`, {}), "start after backend restart");
    if (!await coreAnswers(first.port)) throw new Error("no answer after backend restart");
    ok(await request(`/api/instances/${first.id}/rcon/command`, { command: "serverinfo" }), "rcon after backend restart");
  });
} catch (error) {
  if (!checks.some(([, passed]) => !passed)) checks.push(["setup", false, error.message]);
} finally {
  for (const cleanup of cleanups) await cleanup().catch(error => console.log(`WARN cleanup: ${error.message}`));
}
if (checks.some(([, passed]) => !passed)) {
  console.log(`last diagnostics: ${backend?.diagnostics?.().slice(-1500) || ""}`);
  console.error("4.18.28 native E2E FAIL");
  process.exit(1);
}
console.log("Manual: Client Join with a real CoD4 client (iw3mp) and the Windows run stay on docs/WSL-NATIVE-CHECKLIST.md");
console.log("4.18.28 native E2E PASS");
