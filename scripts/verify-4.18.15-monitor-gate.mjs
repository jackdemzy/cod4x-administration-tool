import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStatusPacket, parseStatusResponse } from "../lib/rcon-protocol.mjs";
import { MonitorStore } from "../lib/monitor-store.mjs";
import { MonitorCollector } from "../lib/monitor-collector.mjs";
import { diagnoseConsole } from "../lib/monitor-diagnose.mjs";

// Block 24a gate: read-only monitoring. Status comes from the unauthenticated
// getstatus query (no RCON password), an outage is declared only after the
// grace period (map change) or at once for a crash, and the monitor role reads
// monitoring and nothing else. Behaviour is exercised directly; wiring and
// permissions are checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs");
const collectorSource = read("lib/monitor-collector.mjs");
const attribution = /cod4-monitor[\s\S]{0,200}Florian Martinez[\s\S]{0,80}AGPL-3\.0/;

const packet = buildStatusPacket("abcdEFGH1234").toString("latin1");
const invalidChallenge = (() => { try { buildStatusPacket("a b;c"); return false; } catch { return true; } })();
const parsed = parseStatusResponse('\\sv_hostname\\^1Gate^7 Host\\mapname\\mp_crash\\g_gametype\\war\\sv_maxclients\\18\n1 40 "Low"\n9 35 "^2High"\n');

async function scenario(statuses) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cod4x-monitor-gate-"));
  let now = Date.UTC(2026, 10, 5, 12);
  const state = { status: "RUNNING", pid: 1, runId: "r" };
  const events = [];
  const store = new MonitorStore({ directory, now: () => now });
  await store.load();
  const collector = new MonitorCollector({
    listInstances: async () => [{ id: "g", name: "Gate", port: 28960, homePath: directory }],
    runtimeFor: async () => ({ state, reconcileRuntimeState: async () => {} }),
    probe: async () => { if (state.answer === false) throw Object.assign(new Error("RCON_TIMEOUT"), { code: "RCON_TIMEOUT" }); return { reachable: true, latencyMs: 3, players: [] }; },
    readConsole: async () => ({ text: "ERROR: Hunk_Alloc failed\n" }),
    store, now: () => now, onEvent: event => events.push(event),
  });
  await collector.tick();
  for (const step of statuses) { Object.assign(state, step); now += 15e3; await collector.tick(); }
  await store.flush();
  fs.rmSync(directory, { recursive: true, force: true });
  return events.map(event => `${event.kind}:${event.cause?.kind ?? ""}`);
}
const mapChange = await scenario([{ answer: false }, { answer: false }, { answer: true }]);
const hang = await scenario([{ answer: false }, { answer: false }, { answer: false }, { answer: false }]);
const crash = await scenario([{ status: "FAILED", pid: null }]);
const stop = await scenario([{ status: "STOPPED", pid: null }, { status: "STOPPED", pid: null }]);

const checks = [
  ["getstatus is a plain OOB query with a validated challenge", packet === "\xff\xff\xff\xffgetstatus abcdEFGH1234" && invalidChallenge],
  ["status parser strips colours and sorts players by score", parsed.hostname === "Gate Host" && parsed.mapname === "mp_crash" && parsed.maxClients === 18 && parsed.players.map(player => player.name).join() === "High,Low"],
  ["a 30 s map change is no outage", mapChange.length === 0],
  ["a server that stops answering is down after 45 s, cause unresponsive", hang.join() === "down:unresponsive"],
  ["a crash is reported at once, a planned stop once", crash.join() === "down:crash" && stop.join() === "down:stopped"],
  ["the cause is read from the end of the console log", diagnoseConsole("x\nERROR: Hunk_Alloc failed\n").reason === "ERROR: Hunk_Alloc failed"],
  ["the collector never uses RCON commands or credentials", !/execute\(|withRuntimeCredentials|withPassword|rcon_password|credential/i.test(collectorSource) && (server.includes("probe: port => new RconClient({ port, timeoutMs: 1500 }).queryStatus()") || (server.includes(": new RconClient({ port, timeoutMs: 1500 }).queryStatus())") && !/execute\(|withRuntimeCredentials|withPassword|rcon_password|credential/i.test(read("lib/remote-monitor.mjs"))))],
  ["monitor role holds monitor.read only", server.includes('monitor: Object.freeze(["monitor.read"])')],
  ["monitoring routes need monitor.read and do not audit every poll", server.includes('const monitorRead = requirePermission("monitor.read", { quietAllowed: true });')
    && ["/api/monitor/overview", "/api/monitor/instances/:id/history", "/api/monitor/instances/:id/events"].every(route => server.includes(`app.get("${route}", monitorRead,`))
    && !/app\.(post|put|patch|delete)\("\/api\/monitor/.test(server)],
  ["outage console lines need diagnostics.read", server.includes('consoleAllowed = hasPermission(req.auth.role, "diagnostics.read")') && server.includes("cause: { ...event.cause, console: [] }")],
  ["ported cod4-monitor code carries the AGPL attribution", attribution.test(read("lib/monitor-diagnose.mjs")) && attribution.test(read("lib/rcon-protocol.mjs"))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.15 monitoring gate PASS (read-only, no RCON password, map change tolerated)");
