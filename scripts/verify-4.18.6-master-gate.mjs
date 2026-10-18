import fs from "node:fs/promises";
import path from "node:path";
import { createRconFixture } from "../test/support/rcon-instance-fixture.mjs";

// Block 8 gate: local server operation independent of master registration.
// Real store, runtime manager, credential vault and master status service; the
// Dedicated Core is the UDP test double. No real master server is contacted.
// NOT a native gate: registration against cod4master.cod4x.ovh remains open.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const token = "GateToken0123456789abcdefABCDEF0";
const running = async (manager, id, pid) => { const state = (await manager.status(id)).runtime; return state.status === "RUNNING" && state.pid === pid; };

const fixture = await createRconFixture();
try {
  const { manager, children, masterService, credentialService, auditEvents, runtimeEvents, store } = fixture;
  await fixture.create("master-none"); await fixture.create("master-token"); await fixture.create("master-locked");

  const none = await manager.launch("master-none");
  const noneStatus = await masterService.status("master-none");
  check("Without token: server starts and runs locally", await running(manager, "master-none", none.pid));
  check("Without token: no sv_authtoken passed, Master = NOT_CONFIGURED", !children.get(none.pid).args.includes("sv_authtoken") && noneStatus.state === "NOT_CONFIGURED");

  await fixture.setMaster("master-token", token);
  const stopped = await masterService.status("master-token");
  check("Token stored: TOKEN_CONFIGURED before start", stopped.state === "TOKEN_CONFIGURED" && stopped.reason === "SERVER_STOPPED");
  const withToken = await manager.launch("master-token");
  const args = children.get(withToken.pid).args;
  check("With token: sv_authtoken reaches the core before server.cfg", args[args.indexOf("sv_authtoken") + 1] === token && args.indexOf("sv_authtoken") < args.indexOf("+exec"));
  check("With token: server runs locally", await running(manager, "master-token", withToken.pid));
  const loopback = await masterService.status("master-token");
  check("Loopback binding is reported instead of a false registration", loopback.state === "TOKEN_CONFIGURED" && loopback.reason === "LOOPBACK_BINDING" && loopback.verified === false);

  await fs.appendFile(path.join(store.get("master-token").homePath, "main", "qconsole.log"), "sv_authtoken is invalid! Abandoning master server registration\n");
  const failed = await masterService.status("master-token");
  check("Registration failure is diagnosed from the core message", failed.state === "REGISTRATION_FAILED" && failed.reason === "MASTER_TOKEN_INVALID");
  check("Registration failure does not touch the local server", await running(manager, "master-token", withToken.pid));

  await fixture.setMaster("master-locked", token);
  credentialService.lock();
  const locked = await manager.launch("master-locked");
  check("Locked vault: server still starts, without token", await running(manager, "master-locked", locked.pid) && !children.get(locked.pid).args.includes("sv_authtoken"));

  const instances = await Promise.all(["master-none", "master-token", "master-locked"].map(id => manager.status(id)));
  const persisted = await fs.readFile(path.join(store.get("master-token").homePath, "logs", "runtime-state.json"), "utf8");
  check("Token never appears in status, runtime events, persisted state or audit", ![instances, runtimeEvents, auditEvents, failed].some(value => JSON.stringify(value).includes(token)) && !persisted.includes(token));
  check("Audit: master.registration.started and master.registration.failed", auditEvents.some(entry => entry.event === "master.registration.started") && auditEvents.filter(entry => entry.event === "master.registration.failed").length === 1);
} finally {
  await fixture.cleanup();
}

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.6 Lokaler Serverbetrieb unabhängig von Master-Registration gate PASS (test double; real master registration remains open)");
