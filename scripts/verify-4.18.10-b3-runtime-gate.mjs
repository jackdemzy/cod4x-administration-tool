import { createB3InstanceFixture } from "../test/support/b3-instance-fixture.mjs";

// Block 12 gate: B3 lifecycle independent of the CoD4x lifecycle.
// Real ServerInstanceManager + real InstanceB3Service/B3Runtime; CoD4x core and
// B3 processes are test doubles here. The real Python 2.7 + eBc-B3 run is
// scripts/verify-4.18.10-b3-native.mjs (Linux/WSL, recorded separately).
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const until = async (predicate, ms = 2000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 5))) if (await predicate()) return true; return false; };
async function rejectsWith(code, action) { try { await action(); return false; } catch (error) { return error.code === code; } }

const fixture = await createB3InstanceFixture();
try {
  const { manager, b3Service, fake, b3Events } = fixture;
  await fixture.create("b3-gate");
  const server = await manager.launch("b3-gate");
  const b3 = (await b3Service.start("b3-gate")).runtime;
  check("B3 Start -> RUNNING with own PID, separate from the CoD4x PID", b3.status === "RUNNING" && b3.pid && b3.pid !== server.pid);
  const call = fake.spawned.at(-1);
  check("B3 runs as python2.7 -B -E b3_run.py --config <instance b3.xml>, detached, shell:false", call.args[0] === "-B" && call.args.includes("--config") && call.options.detached === true && call.options.shell === false);
  fake.crash(b3.pid, 1);
  const runtime = await b3Service.runtime("b3-gate");
  check("Crash Detection: B3 exit -> CRASHED with exit code", await until(() => runtime.state.status === "CRASHED") && runtime.state.exitCode === 1);
  let current = await manager.status("b3-gate");
  check("B3 DOWN, CoD4x Server RUNNING (same PID)", current.runtime.status === "RUNNING" && current.runtime.pid === server.pid);
  const restarted = (await b3Service.start("b3-gate", true)).runtime;
  current = await manager.status("b3-gate");
  check("B3 Restart leaves the server untouched", restarted.status === "RUNNING" && current.runtime.pid === server.pid);
  await manager.stop("b3-gate");
  check("CoD4x Stop leaves B3 RUNNING", (await b3Service.status("b3-gate")).runtime.pid === restarted.pid);
  const relaunched = await manager.launch("b3-gate");
  check("CoD4x Restart leaves B3 PID unchanged", relaunched.pid !== server.pid && (await b3Service.status("b3-gate")).runtime.pid === restarted.pid);
  const stopped = (await b3Service.stop("b3-gate")).runtime;
  current = await manager.status("b3-gate");
  check("B3 Stop -> STOPPED, server still RUNNING", stopped.status === "STOPPED" && current.runtime.status === "RUNNING" && current.runtime.pid === relaunched.pid);
  const health = (await b3Service.status("b3-gate")).health;
  check("Health Check reports DOWN for a stopped B3", health.status === "DOWN");
  await manager.stop("b3-gate");
  check("B3 starts without a running server", (await b3Service.start("b3-gate")).runtime.status === "RUNNING");
  check("Instance cannot be archived while B3 runs", await rejectsWith("B3_RUNNING", () => manager.archive("b3-gate")));
  await b3Service.stop("b3-gate");
  check("Audited lifecycle events: started, crashed, stopped", ["b3.started", "b3.crashed", "b3.stopped"].every(name => b3Events.some(event => event.event === name)));
} finally {
  await fixture.cleanup();
}
const blocked = await createB3InstanceFixture({ dependencies: { overall: "BLOCKED", blocking: ["b3-source"] } });
try {
  await blocked.create("b3-blocked");
  check("Blocked dependencies (e.g. known broken d44c05e) never start B3", await rejectsWith("B3_DEPENDENCIES_BLOCKED", () => blocked.b3Service.start("b3-blocked")) && blocked.fake.spawned.length === 0);
} finally { await blocked.cleanup(); }

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.10 B3 Lifecycle unabhängig vom CoD4X Lifecycle gate PASS (test doubles; native Python 2.7 + eBc-B3 run: scripts/verify-4.18.10-b3-native.mjs)");
