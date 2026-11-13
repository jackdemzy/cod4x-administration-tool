import fs from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.version !== "4.18.30" || pkg.scripts?.preflight !== "node scripts/preflight-4.18.30.mjs") {
  console.error("4.18.30 preflight FAIL: package metadata is inconsistent.");
  process.exit(1);
}

for (const file of ["installer-server.mjs", "electron-main.cjs", "electron-preload.cjs", "scripts/verify-4.18.30-runtime.mjs", "scripts/release.mjs", "scripts/release-lib.mjs", "scripts/release-verify.mjs", "scripts/verify-4.18.30-installer-gate.mjs", "scripts/verify-4.18.28-e2e-gate.mjs", "scripts/verify-4.18.28-e2e-native.mjs", "scripts/verify-4.18.27-recovery-gate.mjs", "scripts/verify-4.18.26-security-gate.mjs", "scripts/security-audit-report.mjs", "scripts/verify-4.18.25-docker-gate.mjs", "scripts/verify-4.18.25-docker-native.mjs", "scripts/verify-4.18.24-remote-rcon-gate.mjs", "scripts/verify-4.18.23-remote-linux-gate.mjs", "scripts/verify-4.18.23-remote-linux-native.mjs", "scripts/verify-4.18.22-multi-server-gate.mjs", "scripts/verify-4.18.22-multi-server-native.mjs", "scripts/verify-4.18.19-actions-gate.mjs", "scripts/verify-4.18.20-b3-integration-gate.mjs", "scripts/verify-4.18.20-b3-integration-native.mjs", "scripts/verify-4.18.21-b3-plugins-gate.mjs", "scripts/verify-4.18.21-b3-plugins-native.mjs", "scripts/generate-b3-plugin-catalog.mjs", "scripts/verify-4.18.18-alerts-gate.mjs", "scripts/verify-4.18.17-runtime-update-gate.mjs", "scripts/verify-4.18.16-remote-gate.mjs", "scripts/verify-4.18.15-monitor-gate.mjs", "scripts/verify-4.18.4-config-gate.mjs", "scripts/verify-4.18.5-rcon-gate.mjs", "scripts/verify-4.18.6-master-gate.mjs", "scripts/verify-4.18.7-listing-gate.mjs", "scripts/verify-4.18.8-plugin-gate.mjs", "scripts/verify-4.18.9-b3-audit-gate.mjs", "scripts/verify-4.18.10-b3-runtime-gate.mjs", "scripts/verify-4.18.10-b3-native.mjs", "scripts/verify-4.18.11-b3-dashboard-gate.mjs", "scripts/verify-4.18.11-b3-dashboard-native.mjs", ...fs.readdirSync("lib").filter(file => file.endsWith(".mjs")).map(file => `lib/${file}`)]) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    console.error(`Node syntax FAIL: ${file}`);
    console.error(check.stderr || check.stdout);
    process.exit(check.status || 1);
  }
}

const regression = spawnSync(process.execPath, ["scripts/verify-4.18.30-runtime.mjs"], { encoding: "utf8" });
process.stdout.write(regression.stdout || "");
process.stderr.write(regression.stderr || "");
if (regression.status !== 0) {
  console.error("4.18.30 runtime regression checks FAIL");
  process.exit(regression.status || 1);
}
// Block 23 (4.18.30): release configuration, artifact verification, pipeline order and Release
// workflow; the installer gate itself needs a release build (COD4X_RELEASE_DIR) and says SKIP without.
const release = spawnSync(process.execPath, ["--test", "test/release-config.test.mjs", "test/release-verify.test.mjs", "test/release-pipeline.test.mjs", "test/release-workflow.test.mjs"], { encoding: "utf8" });
process.stdout.write(release.stdout || "");
process.stderr.write(release.stderr || "");
if (release.status !== 0) {
  console.error("4.18.30 release checks FAIL");
  process.exit(release.status || 1);
}
const installerGate = spawnSync(process.execPath, ["scripts/verify-4.18.30-installer-gate.mjs"], { encoding: "utf8", timeout: 900000 });
process.stdout.write(installerGate.stdout || "");
process.stderr.write(installerGate.stderr || "");
if (installerGate.status !== 0) {
  console.error("4.18.30 installer gate FAIL");
  process.exit(installerGate.status || 1);
}
// Block 22 (4.18.28): the roadmap flow, three servers and the ten intentional failures against the
// real backend over HTTP with the native E2E test core; on Linux with gcc a skipped E2E test fails.
const e2e = spawnSync(process.execPath, ["scripts/verify-4.18.28-e2e-gate.mjs"], { encoding: "utf8", timeout: 900000 });
process.stdout.write(e2e.stdout || "");
process.stderr.write(e2e.stderr || "");
if (e2e.status !== 0) {
  console.error("4.18.28 E2E gate FAIL");
  process.exit(e2e.status || 1);
}
// Block 21 (4.18.27): each of the six changes rolls back byte-identical after a failed check; manual
// restore with and without the B3 confirmation; RECOVERY_REQUIRED blocks starts until a restore.
const recovery = spawnSync(process.execPath, ["scripts/verify-4.18.27-recovery-gate.mjs"], { encoding: "utf8" });
process.stdout.write(recovery.stdout || "");
process.stderr.write(recovery.stderr || "");
if (recovery.status !== 0) {
  console.error("4.18.27 recovery gate FAIL");
  process.exit(recovery.status || 1);
}
// Block 20 (4.18.26): every area reviewed, no open Critical/High/Medium finding, every fixed
// finding's regression test green, npm audit of production dependencies clean. Since 4.18.29 the
// fixed Low findings (issues #40 to #45) and their tests are part of it; the rate limit of issue #49
// is checked in test/audit-http.test.mjs.
const security = spawnSync(process.execPath, ["scripts/verify-4.18.26-security-gate.mjs"], { encoding: "utf8" });
process.stdout.write(security.stdout || "");
process.stderr.write(security.stderr || "");
if (security.status !== 0) {
  console.error("4.18.26 security audit gate FAIL");
  process.exit(security.status || 1);
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
for (const [script, label] of [["scripts/verify-4.18.10-b3-runtime-gate.mjs", "4.18.10 B3 Lifecycle gate"], ["scripts/verify-4.18.10-b3-native.mjs", "4.18.10 native B3 check"], ["scripts/verify-4.18.20-b3-integration-gate.mjs", "4.18.20 B3 integration gate"], ["scripts/verify-4.18.20-b3-integration-native.mjs", "4.18.20 native B3 integration check"], ["scripts/verify-4.18.21-b3-plugins-gate.mjs", "4.18.21 B3 plugins gate"], ["scripts/verify-4.18.21-b3-plugins-native.mjs", "4.18.21 native B3 plugins check"], ["scripts/verify-4.18.25-docker-gate.mjs", "4.18.25 Docker deployment gate"], ["scripts/verify-4.18.25-docker-native.mjs", "4.18.25 native Docker check"], ["scripts/verify-4.18.24-remote-rcon-gate.mjs", "4.18.24 remote RCON and B3 gate"], ["scripts/verify-4.18.23-remote-linux-gate.mjs", "4.18.23 remote Linux gate"], ["scripts/verify-4.18.23-remote-linux-native.mjs", "4.18.23 native remote Linux check (with RCON since 4.18.24)"], ["scripts/verify-4.18.22-multi-server-gate.mjs", "4.18.22 multi-server gate"], ["scripts/verify-4.18.22-multi-server-native.mjs", "4.18.22 native multi-server check"], ["scripts/verify-4.18.19-actions-gate.mjs", "4.18.19 Remote Actions gate"], ["scripts/verify-4.18.18-alerts-gate.mjs", "4.18.18 Alerts gate"], ["scripts/verify-4.18.17-runtime-update-gate.mjs", "4.18.17 Runtime Update gate"], ["scripts/verify-4.18.16-remote-gate.mjs", "4.18.16 Remote Access gate"], ["scripts/verify-4.18.15-monitor-gate.mjs", "4.18.15 Monitoring gate"], ["scripts/verify-4.18.14-kick-gate.mjs", "4.18.14 Live Kick gate"], ["scripts/verify-4.18.14-kick-native.mjs", "4.18.14 native live kick check"], ["scripts/verify-4.18.13-b3-admin-gate.mjs", "4.18.13 B3 Admin gate"], ["scripts/verify-4.18.13-b3-admin-native.mjs", "4.18.13 native B3 admin check"], ["scripts/verify-4.18.12-b3-database-gate.mjs", "4.18.12 B3 Database gate"], ["scripts/verify-4.18.12-b3-database-native.mjs", "4.18.12 native B3 database check"], ["scripts/verify-4.18.11-b3-dashboard-gate.mjs", "4.18.11 B3 Manager Health Dashboard gate"], ["scripts/verify-4.18.11-b3-dashboard-native.mjs", "4.18.11 native B3 dashboard check"]]) {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  if (run.status !== 0) { console.error(`${label} FAIL`); process.exit(run.status || 1); }
}
const version = spawnSync(process.execPath, ["scripts/verify-4.18.30-version.mjs"], { encoding: "utf8" });
process.stdout.write(version.stdout || "");
process.stderr.write(version.stderr || "");
if (version.status !== 0) {
  console.error("4.18.30 version consistency FAIL");
  process.exit(version.status || 1);
}
const behavior = spawnSync(process.execPath, ["--test", "test/instance-console-log.test.mjs", "test/windows-runtime-process-guard.test.mjs", "test/base-game-manager.test.mjs", "test/runtime-layout.test.mjs", "test/runtime-basegame-state.test.mjs", "test/runtime-http-integration.test.mjs", "test/server-instance-store.test.mjs", "test/server-instance-runtime.test.mjs", "test/windows-process-ownership.test.mjs", "test/windows-native-process-inspection.test.mjs", "test/windows-process-inspection-timeout.test.mjs"], { encoding: "utf8" });
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
const rcon = spawnSync(process.execPath, ["--test", "test/rcon-protocol.test.mjs", "test/rcon-client.test.mjs", "test/instance-rcon-service.test.mjs", "test/instance-rcon-console.test.mjs", "test/instance-master-service.test.mjs", "test/instance-master-status.test.mjs", "test/master-list-verification.test.mjs", "test/plugin-manager.test.mjs", "test/instance-plugin-manager.test.mjs", "test/b3-dependencies.test.mjs", "test/b3-dependency-panel.test.mjs", "test/b3-runtime.test.mjs", "test/instance-b3-service.test.mjs", "test/instance-b3-runtime.test.mjs", "test/b3-manager.test.mjs", "test/b3-database.test.mjs", "test/b3-database-helper.test.mjs", "test/instance-b3-database-service.test.mjs", "test/instance-b3-database.test.mjs", "test/server-instance-manager-b3db.test.mjs", "test/b3-admin.test.mjs", "test/instance-b3-admin-service.test.mjs", "test/instance-b3-admin.test.mjs", "test/rcon-status.test.mjs", "test/instance-rcon-kick.test.mjs", "test/instance-online-players.test.mjs"], { encoding: "utf8" });
process.stdout.write(rcon.stdout || "");
process.stderr.write(rcon.stderr || "");
if (rcon.status !== 0) {
  console.error("RCON behavior checks FAIL");
  process.exit(rcon.status || 1);
}
const monitoring = spawnSync(process.execPath, ["--test", "test/monitor.test.mjs", "test/monitor-dashboard.test.mjs", "test/monitor-http.test.mjs", "test/remote.test.mjs", "test/remote-ui.test.mjs", "test/remote-http.test.mjs", "test/alerts.test.mjs", "test/alerts-http.test.mjs", "test/remote-actions.test.mjs", "test/remote-actions-http.test.mjs"], { encoding: "utf8" });
process.stdout.write(monitoring.stdout || "");
process.stderr.write(monitoring.stderr || "");
if (monitoring.status !== 0) {
  console.error("Monitoring, remote access, alert and remote action behavior checks FAIL");
  process.exit(monitoring.status || 1);
}
const integration = spawnSync(process.execPath, ["--test", "test/b3-integration.test.mjs", "test/server-instance-store-b3integration.test.mjs", "test/b3-config-integration.test.mjs", "test/server-instance-manager-b3integration.test.mjs", "test/b3-integration-http.test.mjs", "test/instance-b3-integration.test.mjs", "test/b3-integration-review.test.mjs"], { encoding: "utf8" });
process.stdout.write(integration.stdout || "");
process.stderr.write(integration.stderr || "");
if (integration.status !== 0) {
  console.error("B3 integration behavior checks FAIL");
  process.exit(integration.status || 1);
}
const b3Plugins = spawnSync(process.execPath, ["--test", "test/b3-plugin-catalog.test.mjs", "test/b3-plugin-registry.test.mjs", "test/b3-plugin-template.test.mjs", "test/b3-plugin-plan.test.mjs", "test/instance-b3-plugin-service.test.mjs", "test/b3-plugins-http.test.mjs", "test/instance-b3-plugins.test.mjs", "test/b3-plugins-final-review.test.mjs"], { encoding: "utf8" });
process.stdout.write(b3Plugins.stdout || "");
process.stderr.write(b3Plugins.stderr || "");
if (b3Plugins.status !== 0) {
  console.error("B3 plugin management behavior checks FAIL");
  process.exit(b3Plugins.status || 1);
}
const multiServer = spawnSync(process.execPath, ["--test", "test/multi-server-isolation.test.mjs", "test/b3-database.test.mjs", "test/instance-b3-database-service.test.mjs", "test/instance-b3-service.test.mjs", "test/instance-credential-service.test.mjs", "test/instance-credential-editor.test.mjs", "test/managed-config-text.test.mjs", "test/config-engine-parser.test.mjs", "test/server-instance-runtime.test.mjs"], { encoding: "utf8" });
process.stdout.write(multiServer.stdout || "");
process.stderr.write(multiServer.stderr || "");
if (multiServer.status !== 0) {
  console.error("Multi-server isolation behavior checks FAIL");
  process.exit(multiServer.status || 1);
}
console.log("4.18.30 source preflight PASS (release checks: build targets, SHA-256 and app.asar policy, pipeline order, Release workflow; installer gate against a release build in CI; security Low findings A1 to A6 fixed except A1-5 and covered by the security gate, write rate limit; E2E gate: roadmap flow, three servers and ten intentional failures against the real backend; recovery gate: six changes rolled back byte-identical, manual restore with the B3 confirmation, RECOVERY_REQUIRED; security audit gate: six areas reviewed, no open Critical/High/Medium finding, native Docker check against a real sshd, Docker daemon and core, native remote Linux check with RCON against a real sshd and core, native lifecycle and native core RCON / real master registration/listing / native plugin load / native B3-with-server gates remain separate; the native B3 plugins check runs when Python 2.7 and eBc-B3 are present; the native MySQL and B3 admin checks run when a test database is configured, the native live kick check when a CoD4x core is present)");
