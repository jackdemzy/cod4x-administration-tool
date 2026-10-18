import fs from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.version !== "4.18.11" || pkg.scripts?.preflight !== "node scripts/preflight-4.18.11.mjs") {
  console.error("4.18.11 preflight FAIL: package metadata is inconsistent.");
  process.exit(1);
}

for (const file of ["installer-server.mjs", "electron-main.cjs", "electron-preload.cjs", "scripts/verify-4.18.11-runtime.mjs", "scripts/verify-4.18.4-config-gate.mjs", "scripts/verify-4.18.5-rcon-gate.mjs", "scripts/verify-4.18.6-master-gate.mjs", "scripts/verify-4.18.7-listing-gate.mjs", "scripts/verify-4.18.8-plugin-gate.mjs", "scripts/verify-4.18.9-b3-audit-gate.mjs", "scripts/verify-4.18.10-b3-runtime-gate.mjs", "scripts/verify-4.18.10-b3-native.mjs", "scripts/verify-4.18.11-b3-dashboard-gate.mjs", "scripts/verify-4.18.11-b3-dashboard-native.mjs", ...fs.readdirSync("lib").filter(file => file.endsWith(".mjs")).map(file => `lib/${file}`)]) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    console.error(`Node syntax FAIL: ${file}`);
    console.error(check.stderr || check.stdout);
    process.exit(check.status || 1);
  }
}

const regression = spawnSync(process.execPath, ["scripts/verify-4.18.11-runtime.mjs"], { encoding: "utf8" });
process.stdout.write(regression.stdout || "");
process.stderr.write(regression.stderr || "");
if (regression.status !== 0) {
  console.error("4.18.11 runtime regression checks FAIL");
  process.exit(regression.status || 1);
}
// Block 6 gate stays part of every later preflight.
const gate = spawnSync(process.execPath, ["scripts/verify-4.18.4-config-gate.mjs"], { encoding: "utf8" });
process.stdout.write(gate.stdout || "");
process.stderr.write(gate.stderr || "");
if (gate.status !== 0) {
  console.error("Config Engine gate FAIL");
  process.exit(gate.status || 1);
}
const rconGate = spawnSync(process.execPath, ["scripts/verify-4.18.5-rcon-gate.mjs"], { encoding: "utf8" });
process.stdout.write(rconGate.stdout || "");
process.stderr.write(rconGate.stderr || "");
if (rconGate.status !== 0) {
  console.error("4.18.11 Live Output + RCON Command + Response + Reconnect + Audit gate FAIL");
  process.exit(rconGate.status || 1);
}
const masterGate = spawnSync(process.execPath, ["scripts/verify-4.18.6-master-gate.mjs"], { encoding: "utf8" });
process.stdout.write(masterGate.stdout || "");
process.stderr.write(masterGate.stderr || "");
if (masterGate.status !== 0) {
  console.error("4.18.6 Master gate FAIL");
  process.exit(masterGate.status || 1);
}
const listingGate = spawnSync(process.execPath, ["scripts/verify-4.18.7-listing-gate.mjs"], { encoding: "utf8" });
process.stdout.write(listingGate.stdout || "");
process.stderr.write(listingGate.stderr || "");
if (listingGate.status !== 0) {
  console.error("4.18.7 Registration + Listing Verification gate FAIL");
  process.exit(listingGate.status || 1);
}
const pluginGate = spawnSync(process.execPath, ["scripts/verify-4.18.8-plugin-gate.mjs"], { encoding: "utf8" });
process.stdout.write(pluginGate.stdout || "");
process.stderr.write(pluginGate.stderr || "");
if (pluginGate.status !== 0) {
  console.error("4.18.8 Plugin Discovery + Enable/Disable + Integrity gate FAIL");
  process.exit(pluginGate.status || 1);
}
const b3Gate = spawnSync(process.execPath, ["scripts/verify-4.18.9-b3-audit-gate.mjs"], { encoding: "utf8" });
process.stdout.write(b3Gate.stdout || "");
process.stderr.write(b3Gate.stderr || "");
if (b3Gate.status !== 0) {
  console.error("4.18.9 eBc-B3 Audit + Dependency Matrix gate FAIL");
  process.exit(b3Gate.status || 1);
}
for (const [script, label] of [["scripts/verify-4.18.10-b3-runtime-gate.mjs", "4.18.10 B3 Lifecycle gate"], ["scripts/verify-4.18.10-b3-native.mjs", "4.18.10 native B3 check"], ["scripts/verify-4.18.11-b3-dashboard-gate.mjs", "4.18.11 B3 Manager Health Dashboard gate"], ["scripts/verify-4.18.11-b3-dashboard-native.mjs", "4.18.11 native B3 dashboard check"]]) {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  if (run.status !== 0) { console.error(`${label} FAIL`); process.exit(run.status || 1); }
}
const version = spawnSync(process.execPath, ["scripts/verify-4.18.11-version.mjs"], { encoding: "utf8" });
process.stdout.write(version.stdout || "");
process.stderr.write(version.stderr || "");
if (version.status !== 0) {
  console.error("4.18.11 version consistency FAIL");
  process.exit(version.status || 1);
}
const behavior = spawnSync(process.execPath, ["--test", "test/instance-console-log.test.mjs", "test/windows-runtime-process-guard.test.mjs", "test/base-game-manager.test.mjs", "test/runtime-layout.test.mjs", "test/runtime-basegame-state.test.mjs", "test/runtime-http-integration.test.mjs", "test/server-instance-store.test.mjs", "test/server-instance-runtime.test.mjs", "test/windows-process-ownership.test.mjs", "test/windows-native-process-inspection.test.mjs"], { encoding: "utf8" });
process.stdout.write(behavior.stdout || "");
process.stderr.write(behavior.stderr || "");
if (behavior.status !== 0) {
  console.error("Windows process-control behavior checks FAIL");
  process.exit(behavior.status || 1);
}
const persistence = spawnSync(process.execPath, ["--test", "test/runtime-persistence.test.mjs", "test/runtime-persistence-warning.test.mjs", "test/runtime-ui-wording.test.mjs", "test/managed-config-text.test.mjs", "test/linux-runtime-adapter.test.mjs", "test/linux-runtime-lifecycle.test.mjs", "test/config-engine-parser.test.mjs", "test/config-engine-storage.test.mjs", "test/config-activation.test.mjs", "test/instance-config-editor.test.mjs", "test/credential-vault-codec.test.mjs", "test/credential-vault-storage.test.mjs", "test/instance-credential-service.test.mjs", "test/instance-credential-editor.test.mjs"], { encoding: "utf8" });
process.stdout.write(persistence.stdout || "");
process.stderr.write(persistence.stderr || "");
if (persistence.status !== 0) {
  console.error("Runtime persistence behavior checks FAIL");
  process.exit(persistence.status || 1);
}
const rcon = spawnSync(process.execPath, ["--test", "test/rcon-protocol.test.mjs", "test/rcon-client.test.mjs", "test/instance-rcon-service.test.mjs", "test/instance-rcon-console.test.mjs", "test/instance-master-service.test.mjs", "test/instance-master-status.test.mjs", "test/master-list-verification.test.mjs", "test/plugin-manager.test.mjs", "test/instance-plugin-manager.test.mjs", "test/b3-dependencies.test.mjs", "test/b3-dependency-panel.test.mjs", "test/b3-runtime.test.mjs", "test/instance-b3-service.test.mjs", "test/instance-b3-runtime.test.mjs", "test/b3-manager.test.mjs"], { encoding: "utf8" });
process.stdout.write(rcon.stdout || "");
process.stderr.write(rcon.stderr || "");
if (rcon.status !== 0) {
  console.error("RCON behavior checks FAIL");
  process.exit(rcon.status || 1);
}
console.log("4.18.11 source preflight PASS (native lifecycle and native core RCON / real master registration/listing / native plugin load / native B3-with-server / MySQL gates remain separate)");
