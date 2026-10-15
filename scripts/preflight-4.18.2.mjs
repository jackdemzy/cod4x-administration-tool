import fs from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.version !== "4.18.2" || pkg.scripts?.preflight !== "node scripts/preflight-4.18.2.mjs") {
  console.error("4.18.2 preflight FAIL: package metadata is inconsistent.");
  process.exit(1);
}

for (const file of ["installer-server.mjs", "electron-main.cjs", "electron-preload.cjs", "scripts/verify-4.18.2-runtime.mjs", ...fs.readdirSync("lib").filter(file => file.endsWith(".mjs")).map(file => `lib/${file}`)]) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    console.error(`Node syntax FAIL: ${file}`);
    console.error(check.stderr || check.stdout);
    process.exit(check.status || 1);
  }
}

const regression = spawnSync(process.execPath, ["scripts/verify-4.18.2-runtime.mjs"], { encoding: "utf8" });
process.stdout.write(regression.stdout || "");
process.stderr.write(regression.stderr || "");
if (regression.status !== 0) {
  console.error("4.18.2 runtime regression checks FAIL");
  process.exit(regression.status || 1);
}
const version = spawnSync(process.execPath, ["scripts/verify-4.18.2-version.mjs"], { encoding: "utf8" });
process.stdout.write(version.stdout || "");
process.stderr.write(version.stderr || "");
if (version.status !== 0) {
  console.error("4.18.2 version consistency FAIL");
  process.exit(version.status || 1);
}
const behavior = spawnSync(process.execPath, ["--test", "test/instance-console-log.test.mjs", "test/windows-runtime-process-guard.test.mjs", "test/base-game-manager.test.mjs", "test/runtime-layout.test.mjs", "test/runtime-basegame-state.test.mjs", "test/runtime-http-integration.test.mjs", "test/server-instance-store.test.mjs", "test/server-instance-runtime.test.mjs", "test/windows-process-ownership.test.mjs", "test/windows-native-process-inspection.test.mjs"], { encoding: "utf8" });
process.stdout.write(behavior.stdout || "");
process.stderr.write(behavior.stderr || "");
if (behavior.status !== 0) {
  console.error("Windows process-control behavior checks FAIL");
  process.exit(behavior.status || 1);
}
const persistence = spawnSync(process.execPath, ["--test", "test/runtime-persistence.test.mjs", "test/runtime-persistence-warning.test.mjs", "test/runtime-ui-wording.test.mjs", "test/managed-config-text.test.mjs", "test/linux-runtime-adapter.test.mjs", "test/linux-runtime-lifecycle.test.mjs"], { encoding: "utf8" });
process.stdout.write(persistence.stdout || "");
process.stderr.write(persistence.stderr || "");
if (persistence.status !== 0) {
  console.error("Runtime persistence behavior checks FAIL");
  process.exit(persistence.status || 1);
}
console.log("4.18.2 source preflight PASS (native lifecycle gate remains separate)");
