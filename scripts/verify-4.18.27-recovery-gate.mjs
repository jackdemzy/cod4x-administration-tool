import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PARTS_BY_ACTION } from "../lib/instance-restore-points.mjs";
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from "../lib/remote-linux-routes.mjs";

// Block 21 gate (4.18.27): recovery and backup. For each of the six changes (config change, plugin install,
// B3 migration, server update, local core change, remote core update) a verify failure is injected and the
// change must be rolled back byte-identical; then a manual restore with and without the B3 confirmation and
// the RECOVERY_REQUIRED path. Behaviour is proved by the named tests below; this gate runs them and checks
// the wiring in source. Real core, real MySQL and Windows plugin DLLs: docs/WSL-NATIVE-CHECKLIST.md.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const code = file => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const server = code("installer-server.mjs"), manager = code("lib/server-instance-manager.mjs"), remote = code("lib/remote-instance-manager.mjs");
const registered = [];
const fakeApp = {};
for (const method of ["get", "post", "put", "delete", "all"]) fakeApp[method] = (route, ...handlers) => { registered.push({ method, route, guards: handlers.slice(0, -1) }); };
registerRemoteLinuxRoutes({ app: fakeApp, requirePermission: permission => ({ permission }), audit() {}, hostService: {}, hostStore: {}, manager: {}, credentials: {}, rcon: {}, remoteCredentials: {}, b3: { database: {}, admin: {} } });
const bound = new Map(REMOTE_LINUX_BINDINGS.flatMap(entry => entry.routes.map(route => [route, entry.permission])));

const checks = [
  ["restore points live below the data root in one store", server.includes('new RestorePointStore({ root: dataPath("data", "restore-points") })')],
  ["the store reaches the instance manager, B3 database, B3 plugins, B3 start, remote manager and installer", ["restorePoints,\n  b3Database: b3DatabaseService,", "points: b3DatabasePoints", "guard: (id, action, options) => instanceManager.guardFor(id, action, options)", "recoveryCheck: id => instanceManager.assertNoRecovery(id)", "coreImportRoot: REMOTE_CORE_IMPORT_ROOT, restorePoints,", "store: restorePoints, actor: req.auth?.username || null"].every(part => server.includes(part))],
  ["no captured part holds the vault, b3.xml, plugin_auth.ini, logs, players or maps", !/b3\.xml|plugin_auth|vault|usermaps|mods\/|players|\.log/.test(JSON.stringify(PARTS_BY_ACTION)) && !/'b3\/b3\.xml'|'b3\/plugin_auth\.ini'/.test(code("lib/instance-restore-points.mjs"))],
  ["code parts need server.code on a manual restore, the B3 database the exact confirmation", manager.includes("RESTORE_POINT_CODE_PERMISSION") && manager.includes("confirmation !== B3_DATABASE_CONFIRMATION") && read("lib/server-instance-manager.mjs").includes("export const B3_DATABASE_CONFIRMATION = 'B3-DATENBANK ZURÜCKSETZEN'")],
  ["a local launch, a B3 start, a migration and the standard server start refuse RECOVERY_REQUIRED", manager.includes("await this.assertNoRecovery(id);") && code("lib/instance-b3-service.mjs").includes("recoveryCheck") && code("lib/instance-b3-database-service.mjs").includes("this.points.assertNoRecovery(id)") && (server.match(/refuseDefaultRuntimeRecovery,/g) || []).length === 3],
  ["remote start and restart refuse RECOVERY_REQUIRED; rollbackCore checks the kept core against a backup", (remote.match(/await this\.#assertNoRecovery\(id\);/g) || []).length === 2 && remote.includes("manifest.core?.previousSha256 === keptSha256")],
  ["the remote core rollback route needs update.execute and is listed", registered.some(entry => entry.route === "/api/remote-instances/:id/core/rollback" && entry.guards[0]?.permission === "update.execute") && bound.get("POST /api/remote-instances/:id/core/rollback") === "update.execute"],
  ["restore routes are guarded: config.manage, standard-server restore and core change server.code", server.includes('app.post("/api/instances/:id/restore-points/:pointId/restore", requirePermission("config.manage")') && server.includes('app.post("/api/runtime/restore-points/:pointId/restore", requirePermission("server.code")') && server.includes('app.post("/api/instances/:id/core", requirePermission("server.code")')],
  ["archives are staged, links refused, the target checked before the point", code("lib/archive-install.mjs").includes("INSTALL_ARCHIVE_INVALID") && code("lib/archive-install.mjs").includes("INSTALL_TARGET_INVALID")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

const files = ["restore-points", "restore-guard", "instance-restore-points", "server-instance-store", "server-instance-restore", "instance-b3-plugin-service", "instance-b3-database-service", "archive-install", "remote-instance-install", "remote-docker-routes", "restore-points-http"].map(name => `test/${name}.test.mjs`);
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { encoding: "utf8" });
const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const result = name => { const match = new RegExp(`^(not ok|ok) \\d+ - ${escape(name)}( # SKIP ?(.*))?$`, "m").exec(run.stdout); return !match ? "MISSING" : match[1] !== "ok" ? "FAIL" : match[2] ? "SKIP" : "PASS"; };
const scenarios = [
  ["config change rolled back", "a config change whose verify fails is rolled back byte-identical"],
  ["plugin install rolled back", "a plugin install whose verify fails removes the new plugin file and restores the records"],
  ["B3 migration rolled back from the dump", "failed migration replays the dump and drops created tables"],
  ["server update (zip) rolled back", "zip overwriting two files and creating one rolls back byte-identical when verify fails"],
  ["server update (tar.gz) rolled back", "tar.gz overwriting two files and creating one rolls back byte-identical when verify fails"],
  ["local core change rolled back", "core change: refused for a wrong file, rolled back on a failed verify, applied otherwise"],
  ["remote core update: failed rollback, RECOVERY_REQUIRED, rollbackCore", "failed in-place rollback marks RECOVERY_REQUIRED, start is refused, rollbackCore recovers", "loopback"],
  ["remote core rollback", "rollbackCore restores the previous core and version", "loopback"],
  ["manual restore with and without the B3 confirmation", "a point with a B3 dump: without the confirmation the database is never touched, with it the dump is replayed"],
  ["RECOVERY_REQUIRED until a manual restore", "a failed rollback blocks launch with RECOVERY_REQUIRED until a manual restore"],
  ["routes: code permission and body checks", "operator without server.code gets 403 on /core and RESTORE_POINT_CODE_PERMISSION on a plugin restore"],
];
let failed = run.status !== 0 || summary.fail !== 0;
for (const [label, name, needs] of scenarios) {
  const outcome = result(name);
  // The remote scenarios run on the loopback SSH transport (Linux, non-root, gcc, setsid); elsewhere they skip.
  const ok = outcome === "PASS" || (outcome === "SKIP" && needs === "loopback" && process.platform !== "linux");
  if (!ok) failed = true;
  console.log(`${ok ? outcome : "FAIL"} ${label}${ok ? "" : ` (${outcome})`}`);
}
console.log(`${failed ? "FAIL" : "PASS"} Block 21 tests (${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? "?"} skipped)`);
if (failed) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(1); }
console.log("Block 21 recovery gate PASS");
