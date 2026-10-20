import fs from "node:fs";
import { B3_SOURCE } from "../lib/b3-dependencies.mjs";
import { EBC_CONFIRMATION, CORE_SQL, EBC_SQL } from "../lib/b3-database.mjs";

// Block 14 gate (source level): DB Connection + Schema + Migration wiring.
// The native counterpart is scripts/verify-4.18.12-b3-database-native.mjs.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs");
const helper = read("lib/b3-database-helper.mjs");
const service = read("lib/instance-b3-database-service.mjs");
const b3Service = read("lib/instance-b3-service.mjs");
const vault = read("lib/instance-credential-service.mjs");
const libFiles = fs.readdirSync(new URL("../lib/", import.meta.url)).filter(name => /\.m?jsx?$/.test(name));
const usesDsn = libFiles.filter(name => /databaseDsn:/.test(read(`lib/${name}`)));
const eventCalls = [...service.matchAll(/this\.#event\(([^;]+)\);/g)].map(match => match[1]);

const checks = [
  ["helper runs with shell:false, -E and the fixed helper source", helper.includes("['-E', '-c', DATABASE_HELPER]") && helper.includes("shell: false")],
  ["helper secrets go to stdin only, minimal env", helper.includes("child.stdin.end(request)") && helper.includes("env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '' }") && helper.includes("request.fill(0)")],
  ["helper output is bounded and timed", helper.includes("MAX_OUTPUT = 1024 * 1024") && helper.includes("DB_HELPER_TIMEOUT")],
  ["audited SQL: core + eBc pinned, eBc still blocked for automatic use", B3_SOURCE.auditedSql[CORE_SQL] === B3_SOURCE.auditedFiles[CORE_SQL] && /^[a-f0-9]{64}$/.test(B3_SOURCE.auditedSql[EBC_SQL]) && B3_SOURCE.blockedSql.includes(EBC_SQL) && !(EBC_SQL in B3_SOURCE.auditedFiles)],
  ["every SQL file is re-read and hash-checked right before apply", /const sql = await readAuditedSql\(b3Path, file\);[\s\S]{0,400}call\('apply'/.test(service)],
  ["backup is verified before any SQL runs", /await verifyBackup\(target, written\)[\s\S]*for \(const file of plan\.files\)/.test(service)],
  ["eBc confirmation phrase is exact", EBC_CONFIRMATION === "DROP player_core AND prestige_log"],
  ["migration refused while B3 runs", service.includes("if (await this.b3IsRunning(id)) fail('B3_RUNNING');")],
  ["database routes and permissions are wired", server.includes('app.get("/api/instances/:id/b3/database", requirePermission("config.manage")') && server.includes('app.post("/api/instances/:id/b3/database", requirePermission("config.manage")')
    && server.includes('app.post("/api/instances/:id/b3/database/test", requirePermission("config.manage")') && server.includes('app.post("/api/instances/:id/b3/database/migrate", requirePermission("server.manage")')],
  ["b3db password change invalidates readiness", server.includes('if (kind === "b3db") b3DatabaseService.invalidate(id)')],
  ["vault kind b3db uses the DSN-safe password policy", vault.includes("'b3db'") && vault.includes("if (kind === 'b3db') return validDatabasePassword(value);")],
  ["b3.xml switches to MySQL only via connectionFor inside the vault scope", usesDsn.join(",") === "instance-b3-service.mjs" && /withRuntimeCredentials\(id, async credentials => \{[\s\S]{0,300}connectionFor\(id, credentials\.b3db\)/.test(b3Service)],
  ["database events carry no password or DSN", eventCalls.length >= 5 && eventCalls.every(call => !/password|dsn|settings/i.test(call))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.12 B3 database gate PASS (DB Connection + Schema + Migration wiring)");
