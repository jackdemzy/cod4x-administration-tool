import fs from "node:fs/promises";
import path from "node:path";
import { createRconFixture } from "../test/support/rcon-instance-fixture.mjs";

// Block 7 gate: Live Output + RCON Command + Response + Reconnect + Audit.
// Real store, runtime manager, credential vault, RCON service and loopback UDP;
// the Dedicated Core is a UDP test double modelled on CoD4x_Server sv_main.c.
// NOT a native gate: RCON against a real cod4x18_dedrun remains open.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const secret = "Gate-Rcon-4185!";
async function rejectsWith(code, action) { try { await action(); return false; } catch (error) { return error.code === code; } }

const fixture = await createRconFixture();
try {
  const { manager, children, rconService, auditEvents, store } = fixture;
  await fixture.create("rcon-gate");
  await fixture.setRcon("rcon-gate", secret);
  const first = await manager.launch("rcon-gate");
  const core = children.get(first.pid);
  check("Vault password reaches the core only as short-lived +set argument", core.args.includes(secret) && rconService.status("rcon-gate").provisioning === "PROVISIONED");

  const live = await manager.status("rcon-gate");
  check("Live output: qconsole.log is readable", live.consoleLog.status === "available" && live.consoleLog.text.includes("Server: mp_backlot"));
  check("Live output: runtime stdout is captured", live.runtime.output.stdout.includes("fake core rcon-gate ready"));

  const connected = await rconService.connect("rcon-gate", "gate");
  check("Connect + Authenticate against 127.0.0.1:<instance.port>", connected.status === "CONNECTED" && connected.target.host === "127.0.0.1" && connected.target.port === store.get("rcon-gate").port);
  const status = await rconService.execute("rcon-gate", "status", "gate");
  check("RCON command status returns the multi-packet response", /^map: mp_backlot/.test(status.response) && (status.response.match(/Bot\d+/g) || []).length === 24);
  const map = await rconService.execute("rcon-gate", "map mp_crash", "gate");
  check("RCON command map changes the map", /Server: mp_crash/.test(map.response) && core.server.state.mapname === "mp_crash");
  check("Dangerous commands are blocked before any I/O", await rejectsWith("RCON_COMMAND_BLOCKED", () => rconService.execute("rcon-gate", "quit", "gate")) && !core.server.state.commands.includes("quit"));

  await core.server.close();
  check("Lost core socket is detected", await rejectsWith("RCON_TIMEOUT", () => rconService.execute("rcon-gate", "status", "gate")) && rconService.status("rcon-gate").status === "DISCONNECTED");
  const second = await manager.launch("rcon-gate", true);
  const reconnected = await rconService.connect("rcon-gate", "gate");
  check("Reconnect after restart uses the new run", reconnected.status === "CONNECTED" && reconnected.runId === second.runId && second.runId !== first.runId);
  check("Command works after reconnect", /map: mp_backlot/.test((await rconService.execute("rcon-gate", "status", "gate")).response));
  check("Server keeps running independently of the console", (await manager.status("rcon-gate")).runtime.status === "RUNNING");

  const events = auditEvents.map(entry => entry.event);
  check("Audit: rcon.login, rcon.command and rcon.failure recorded", ["rcon.login", "rcon.command", "rcon.failure"].every(name => events.includes(name)));
  check("Audit: commands are attributed to actor and instance", auditEvents.filter(entry => entry.event === "rcon.command").every(entry => entry.details.actor === "gate" && entry.details.instanceId === "rcon-gate"));
  const persisted = await fs.readFile(path.join(store.get("rcon-gate").homePath, "logs", "runtime-state.json"), "utf8");
  const surfaces = JSON.stringify([auditEvents, fixture.runtimeEvents, rconService.status("rcon-gate"), await manager.status("rcon-gate")]) + persisted;
  check("Password absent from audit, runtime events, history, API state and persisted state", !surfaces.includes(secret));
  await manager.stop("rcon-gate");
  check("Stopped server reports OFFLINE without hanging", await rejectsWith("RCON_SERVER_NOT_RUNNING", () => rconService.execute("rcon-gate", "status", "gate")) && rconService.status("rcon-gate").status === "OFFLINE");
} finally {
  await fixture.cleanup();
}

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.5 Live Output + RCON Command + Response + Reconnect + Audit gate PASS (UDP test double; native core RCON test remains open)");
