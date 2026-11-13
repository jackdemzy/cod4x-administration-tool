import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Block 22 gate (4.18.28): End-to-End. Runs the E2E tests against the real backend process
// (installer-server.mjs over HTTP) with the native E2E test core (test/support/e2e-core.mjs):
// the roadmap flow Install -> ... -> Restart plus a backend restart, three servers on
// consecutive ports, and the ten intentional failures; CONTROL must answer after every step.
// On Linux with gcc a skipped E2E test is a FAIL. Elsewhere the gate says SKIP explicitly.
// The run with the real cod4x18_dedrun is scripts/verify-4.18.28-e2e-native.mjs.
const files = ["test/e2e-core.test.mjs", "test/e2e-flow.test.mjs", "test/e2e-multi-server.test.mjs", "test/e2e-failures.test.mjs"];
const tests = [
  "E2E core: answers getinfo, rcon and joins on net_port with the +exec password, and frees the port when stopped",
  "E2E core: a SIGKILLed core does not leave its responder behind",
  "E2E flow: install to restart through the real backend, CONTROL answers after every step",
  "E2E multi-server: three instances on consecutive ports stay isolated",
  "E2E failures: ten intentional faults, CONTROL and the reference server keep running",
];
const flowSteps = ["Install: adopt the core", "Detect Core: preflight reports a verified core and a valid base game", "Create Server", "Config: server.cfg and RCON password", "Start", "Map: rcon map mp_crash", "RCON: status", "Master List: controlled state, no crash", "B3: controlled state without Python, game server keeps running", "Client Join: CONTROL sees the player", "Stop", "Restart: same port, new process", "Backend restart: instance, config and credentials survive"];
const faults = ["falscher Core", "fehlende main-Datei", "fehlende zone-Datei", "falscher Port", "falscher RCON", "fehlender Master Token", "falsche DB", "B3 down", "Server crash", "Plugin fehlt"];

for (const file of files) if (!fs.existsSync(file)) { console.error(`FAIL missing ${file}`); process.exit(1); }
const gcc = process.platform === "linux" && spawnSync("gcc", ["--version"], { encoding: "utf8" }).status === 0;
if (!gcc) { console.log(`SKIP E2E gate needs Linux and gcc (platform ${process.platform}); the native checklist covers Windows`); process.exit(0); }

const started = Date.now();
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { encoding: "utf8", timeout: 600000 });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const result = (name, prefix = "") => {
  const match = new RegExp(`^\\s*(not ok|ok) \\d+ - ${prefix ? escape(prefix) : escape(name)}${prefix ? "[^\\n]*?" : ""}( # SKIP ?(.*))?$`, "m").exec(run.stdout);
  return !match ? "MISSING" : match[1] !== "ok" ? "FAIL" : match[2] ? "SKIP" : "PASS";
};
const checks = [
  ...tests.map(name => [name, result(name)]),
  ...flowSteps.map(name => [`flow step: ${name}`, result(name)]),
  ...faults.map(name => [`failure case: ${name}`, result(null, `${name}:`)]),
];
for (const [name, state] of checks) console.log(`${state} ${name}`);
const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
console.log(`E2E tests: ${summary.tests ?? "?"} / pass ${summary.pass ?? "?"} / fail ${summary.fail ?? "?"} / skipped ${summary.skipped ?? "?"} in ${seconds} s`);
if (run.status !== 0 || checks.some(([, state]) => state !== "PASS") || summary.fail !== 0 || summary.skipped !== 0) {
  process.stdout.write(run.stdout.split("\n").filter(line => /not ok|error:|expected|actual|HTTP/.test(line)).slice(0, 60).join("\n") + "\n");
  if (run.stderr) process.stderr.write(run.stderr.slice(-4000));
  console.error("4.18.28 E2E gate FAIL");
  process.exit(1);
}
console.log("4.18.28 E2E gate PASS (real backend over HTTP, native E2E test core; the native run with cod4x18_dedrun is separate)");
