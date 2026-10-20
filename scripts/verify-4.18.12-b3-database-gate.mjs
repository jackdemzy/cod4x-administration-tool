import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { B3_SOURCE } from "../lib/b3-dependencies.mjs";
import { EBC_CONFIRMATION, CORE_SQL, EBC_SQL } from "../lib/b3-database.mjs";
import { runDatabaseHelper } from "../lib/b3-database-helper.mjs";
import { InstanceB3DatabaseService } from "../lib/instance-b3-database-service.mjs";

// Block 14 gate: DB Connection + Schema + Migration. Security-relevant helper and
// backup behavior is exercised directly; route/permission wiring is checked in source.
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

// Behavior: run the real helper runner against a recording spawn.
const SECRET = "Gate-Secret-Pass!1";
const spawned = [];
const fakeSpawn = (file, args, options) => {
  const child = new EventEmitter();
  let input = "";
  child.stdout = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) { done(); setImmediate(() => { child.stdout.end('{"ok":true,"version":"x","tables":{}}'); setImmediate(() => child.emit("close", 0)); }); } });
  spawned.push({ file, args, options, input: () => input });
  return child;
};
const pythonPath = process.platform === "win32" ? "C:\\Python27\\python.exe" : "/usr/bin/python2.7";
let written = false;
await runDatabaseHelper({ pythonPath, op: "probe", connection: { host: "127.0.0.1", port: 3306, database: "b3", username: "b3" }, password: Buffer.from(SECRET) }, { spawnImpl: fakeSpawn, onRequestWritten: () => { written = true; } });
const [run] = spawned;

// Behavior: an unverifiable backup must stop the migration before any SQL.
async function unverifiableBackupBlocksSql() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-db-gate-"));
  try {
    const b3Path = path.join(root, "ebc-b3"), sql = path.join(b3Path, "b3", "sql", "mysql");
    await fsp.mkdir(sql, { recursive: true });
    await fsp.copyFile(new URL("../test/fixtures/b3-mysql-b3.sql", import.meta.url), path.join(sql, "b3.sql"));
    const instance = { id: "gate", homePath: path.join(root, "home") };
    await fsp.mkdir(instance.homePath);
    const ops = [];
    const helper = async (request, options = {}) => {
      options.onRequestWritten?.(); ops.push(request.op);
      if (request.op === "probe") return { tables: { foreign_table: ["id"] } }; // EMPTY B3 schema, but not an empty database
      if (request.op === "backup") { await fsp.writeFile(request.target, "-- COD4X CONTROL B3 backup v1\n"); return { path: request.target, sha256: "0".repeat(64), tables: { foreign_table: 1 } }; }
      return { statements: 1 };
    };
    const credentials = { withRuntimeCredentials: async (id, fn) => fn({ b3db: Buffer.from(SECRET) }, new AbortController().signal), instanceStatus: async () => ({ b3db: { configured: true } }) };
    const service = new InstanceB3DatabaseService({ store: { get: () => instance }, credentials, environment: { read: async () => ({ pythonPath, b3Path }) }, b3IsRunning: async () => false, helper });
    await service.save("gate", { host: "127.0.0.1", database: "b3", username: "b3" });
    await service.invalidate("gate");
    const code = await service.migrate("gate").then(() => null, error => error.code);
    return code === "BACKUP_FAILED" && !ops.includes("apply");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}

const checks = [
  ["helper runs with shell:false, -E and the fixed helper source", run?.options.shell === false && run.args[0] === "-E" && run.args[1] === "-c" && run.args.length === 3],
  ["helper secrets go to stdin only, minimal env", !JSON.stringify(run.args).includes(SECRET) && !JSON.stringify(run.options).includes(SECRET) && Object.keys(run.options.env).sort().join() === "PATH,SYSTEMROOT" && run.input().includes(SECRET) && written],
  ["an unverifiable backup stops the migration before any SQL", await unverifiableBackupBlocksSql()],
  ["helper output is bounded and timed", helper.includes("MAX_OUTPUT = 1024 * 1024") && helper.includes("DB_HELPER_TIMEOUT")],
  ["audited SQL: core + eBc pinned, eBc still blocked for automatic use", B3_SOURCE.auditedSql[CORE_SQL] === B3_SOURCE.auditedFiles[CORE_SQL] && /^[a-f0-9]{64}$/.test(B3_SOURCE.auditedSql[EBC_SQL]) && B3_SOURCE.blockedSql.includes(EBC_SQL) && !(EBC_SQL in B3_SOURCE.auditedFiles)],
  ["every SQL file is re-read and hash-checked right before apply", /const sql = await readAuditedSql\(b3Path, file\);[\s\S]{0,400}call\('apply'/.test(service)],
  ["eBc confirmation phrase is exact", EBC_CONFIRMATION === "DROP player_core AND prestige_log"],
  ["migration refused while B3 runs", service.includes("if (await this.b3IsRunning(id)) fail('B3_RUNNING');")],
  ["database routes and permissions are wired", server.includes('app.get("/api/instances/:id/b3/database", requirePermission("config.manage")') && server.includes('app.post("/api/instances/:id/b3/database", requirePermission("config.manage")')
    && server.includes('app.post("/api/instances/:id/b3/database/test", requirePermission("config.manage")') && server.includes('app.post("/api/instances/:id/b3/database/migrate", requirePermission("server.manage")')],
  ["b3db password change invalidates readiness", server.includes('if (kind === "b3db") b3DatabaseService.invalidate(id)')],
  ["vault kind b3db uses the DSN-safe password policy", vault.includes("'b3db'") && vault.includes("if (kind === 'b3db') return validDatabasePassword(value);")],
  ["b3.xml switches to MySQL only via connectionFor inside the vault scope", usesDsn.join(",") === "instance-b3-service.mjs" && /withRuntimeCredentials\(id, async \(credentials, signal\) => \{[\s\S]{0,300}signal\?\.aborted[\s\S]{0,300}connectionFor\(id, credentials\.b3db\)/.test(b3Service)],
  ["database operations use one short vault scope per helper call", /#helperCall\(id, request, onSent = \(\) => \{\}\) \{[\s\S]{0,500}withRuntimeCredentials\(id, async \(credentials, signal\) => \{\s*if \(signal\?\.aborted\) fail\('VAULT_LOCKED'\);/.test(service) && !service.includes("#withPassword")],
  ["B3 never silently falls back to SQLite and never starts during a migration", b3Service.includes("this.database.withStartGuard(id, action)") && b3Service.includes("if (!setup?.ready && setup?.mysqlEnabled) fail('B3_DATABASE_NOT_READY');")],
  ["the b3db password only goes to the host/port/user it was entered for", service.includes("fail('B3_DATABASE_PASSWORD_REENTRY_REQUIRED')") && service.includes("document.passwordBinding !== bindingOf(document.settings)")],
  ["the vault scope ends once the request is written to the helper", helper.includes("child.stdin.end(request, () => { request.fill(0); onRequestWritten(); });") && service.includes("onRequestWritten:")],
  ["database events carry no password or DSN", eventCalls.length >= 5 && eventCalls.every(call => !/password|dsn|settings/i.test(call))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.12 B3 database gate PASS (DB Connection + Schema + Migration wiring)");
