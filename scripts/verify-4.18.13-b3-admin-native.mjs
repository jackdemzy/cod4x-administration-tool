import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { InstanceB3DatabaseService } from "../lib/instance-b3-database-service.mjs";
import { InstanceB3AdminService } from "../lib/instance-b3-admin-service.mjs";
import { runDatabaseHelper } from "../lib/b3-database-helper.mjs";

// Native Block 15 check on Linux against the dedicated MariaDB test database
// (see verify-4.18.12-b3-database-native.mjs for the credentials file). The
// effect of every action is verified with eBc-B3's own storage code
// (b3.storage.mysql.MysqlStorage), i.e. exactly what B3 sees on connect.
if (process.platform !== "linux") { console.log("SKIP native B3 admin check runs on Linux only"); process.exit(0); }
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
const envFile = path.join(os.homedir(), ".config", "cod4x-control-test", "b3db.env");
const fileValues = Object.fromEntries((await fs.readFile(envFile, "utf8").catch(() => "")).split("\n").map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(match => [match[1], match[2]]));
const value = name => process.env[name] || fileValues[name];
const settings = { host: value("B3_DB_TEST_HOST"), port: Number(value("B3_DB_TEST_PORT") || 3306), database: value("B3_DB_TEST_DATABASE"), username: value("B3_DB_TEST_USER") };
const password = value("B3_DB_TEST_PASSWORD");
try { await fs.access(pythonPath); await fs.access(path.join(b3Path, "b3_run.py")); }
catch { console.log("SKIP native B3 admin check: Python 2.7 or eBc-B3 not found"); process.exit(0); }
if (!settings.host || !settings.database || !settings.username || !password) { console.log("SKIP native B3 admin check: no test database configured"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-admin-native-"));
const instance = { id: "b3-admin-native", homePath: path.join(root, "home") };
await fs.mkdir(instance.homePath, { recursive: true });
const credentials = {
  async withRuntimeCredentials(id, action) { const b3db = Buffer.from(password); try { return await action(Object.freeze({ b3db }), new AbortController().signal); } finally { b3db.fill(0); } },
  async instanceStatus() { return { b3db: { configured: true } }; },
};
const environment = { read: async () => ({ pythonPath, b3Path }) };
const events = [];
const database = new InstanceB3DatabaseService({ store: { get: () => instance }, credentials, environment, b3IsRunning: async () => false });
const admin = new InstanceB3AdminService({ store: { get: () => instance }, database, environment, b3IsRunning: async () => false, onEvent: event => events.push(event) });
const raw = (op, extra = {}) => runDatabaseHelper({ pythonPath, op, connection: settings, password: Buffer.from(password), ...extra });
const dropAll = async () => { const { tables } = await raw("probe"); const names = Object.keys(tables); if (names.length) await raw("apply", { statements: names.map(name => `DROP TABLE \`${name}\``) }); };

// What eBc-B3 itself sees: MysqlStorage with a stub console; DSN on stdin.
const B3_VIEW = String.raw`
import os, sys, json
sys.path.insert(0, sys.argv[1])
from b3.functions import splitDSN
from b3.storage.mysql import MysqlStorage
from b3.clients import Client
class Screen(object):
    def write(self, text): pass
    def flush(self): pass
class Console(object):
    screen = Screen()
    def __getattr__(self, name): return lambda *a, **k: None
dsn = sys.stdin.readline().strip()
storage = MysqlStorage(dsn, splitDSN(dsn), Console())
storage.connect()
client = Client(id=int(sys.argv[2]))
out = {'bans': len(storage.getClientPenalties(client, type=('Ban', 'TempBan'))), 'warnings': len(storage.getClientPenalties(client, type='Warning'))}
loaded = storage.getClient(Client(id=int(sys.argv[2])))
out['groupBits'] = int(loaded.groupBits)
sys.stdout.write(json.dumps(out))
`;
const viewFile = path.join(root, "b3_view.py");
await fs.writeFile(viewFile, B3_VIEW);
const b3Sees = clientId => {
  const run = spawnSync(pythonPath, ["-E", viewFile, b3Path, String(clientId)], { input: `mysql://${settings.username}:${password}@${settings.host}:${settings.port}/${settings.database}\n`, encoding: "utf8", timeout: 30000 });
  if (run.status !== 0) throw new Error(`B3 view failed: ${(run.stderr || "").split("\n").slice(-3).join(" ")}`);
  return JSON.parse(run.stdout);
};

try {
  await dropAll();
  await database.save(instance.id, settings); await database.invalidate(instance.id);
  await database.migrate(instance.id);
  const now = Math.floor(Date.now() / 1000);
  await raw("apply", { statements: [
    `INSERT INTO clients (ip, connections, guid, pbid, name, auto_login, mask_level, group_bits, greeting, time_add, time_edit) VALUES ('203.0.113.77', 3, 'NATIVEADMINGUID00001', '', 'NativeAdmin', 0, 0, 1, '', ${now - 3600}, ${now - 60})`,
  ] });
  const found = await admin.players(instance.id, { search: "NativeAdmin" }, { full: true });
  const clientId = found.rows[0]?.id;
  check("Seeded player is found by name (full view)", found.total === 1 && found.rows[0].ip === "203.0.113.77", `${found.total}`);
  await raw("apply", { statements: [
    `INSERT INTO aliases (num_used, alias, client_id, time_add, time_edit) VALUES (2, 'OldNative', ${clientId}, ${now - 3000}, ${now - 2000})`,
    `INSERT INTO ipaliases (num_used, ip, client_id, time_add, time_edit) VALUES (1, '198.51.100.23', ${clientId}, ${now - 3000}, ${now - 2000})`,
    `INSERT INTO penalties (type, client_id, admin_id, duration, inactive, keyword, reason, data, time_add, time_edit, time_expire) VALUES ('Warning', ${clientId}, 0, 60, 0, 'spam', 'Spam', '', ${now - 10}, ${now - 10}, ${now + 3600})`,
  ] });
  const masked = await admin.players(instance.id, { search: "NativeAdmin" });
  check("Viewer view masks IP and GUID", masked.rows[0].ip === "203.0.113.x" && masked.rows[0].guid === "…0001" && !JSON.stringify(masked).includes("NATIVEADMINGUID"));
  const detail = await admin.player(instance.id, clientId);
  check("Player detail shows aliases and masked IP history", detail.aliases[0]?.alias === "OldNative" && detail.ips[0]?.ip === "198.51.100.x");
  check("B3 sees one active warning before any action", b3Sees(clientId).warnings === 1);
  await admin.addBan(instance.id, clientId, { kind: "TempBan", durationMinutes: 10, reason: "Native test ban" }, "native");
  check("Added TempBan is active for B3 (getClientPenalties)", b3Sees(clientId).bans === 1);
  const active = await admin.penalties(instance.id, { type: "TempBan", status: "active" });
  check("Penalties view lists the TempBan as active", active.rows.some(row => row.clientId === clientId && row.status === "active" && row.until > now));
  const lifted = await admin.unban(instance.id, clientId, "native");
  check("Lift ban -> B3 sees no ban", Number(lifted.affected) === 1 && b3Sees(clientId).bans === 0);
  const warning = (await admin.penalties(instance.id, { type: "Warning", status: "active" })).rows.find(row => row.clientId === clientId);
  const banRow = (await admin.penalties(instance.id, { type: "TempBan", status: "lifted" })).rows.find(row => row.clientId === clientId);
  const wrongLift = await admin.liftWarning(instance.id, banRow.id, "native").then(() => "lifted", error => error.code);
  check("A ban id is refused on the warning route", wrongLift === "B3_ADMIN_PENALTY_NOT_FOUND", wrongLift);
  await admin.liftWarning(instance.id, warning.id, "native");
  check("Lift warning -> B3 sees no active warning", b3Sees(clientId).warnings === 0);
  await admin.setGroup(instance.id, clientId, 16, "native");
  check("Set group (B3 stopped) -> B3 loads group_bits 16", b3Sees(clientId).groupBits === 16);
  const missing = await admin.addBan(instance.id, 999999, { kind: "Ban", reason: "x" }, "native").then(() => "added", error => error.code);
  check("Ban for an unknown player is refused", missing === "B3_ADMIN_CLIENT_NOT_FOUND", missing);
  await raw("apply", { statements: [`INSERT INTO clients (ip, connections, guid, pbid, name, auto_login, mask_level, group_bits, greeting, time_add, time_edit) VALUES ('203.0.113.78', 1, 'NATIVEPCTGUID0000002', '', 'Pct%_Name', 0, 0, 1, '', ${now}, ${now})`] });
  const literal = await admin.players(instance.id, { search: "%_" });
  const quoted = await admin.players(instance.id, { search: "%_'\\" });
  check("Search treats %, _, quote and backslash literally", literal.total === 1 && literal.rows[0].name === "Pct%_Name" && quoted.total === 0, `${literal.total}/${quoted.total}`);
  const byGuid = await admin.players(instance.id, { search: "GUID00001" }); // only in the GUID, not in any name
  check("Masked search does not match GUIDs (full search does)", byGuid.total === 0 && (await admin.players(instance.id, { search: "GUID00001" }, { full: true })).total === 1);
  const admins = await admin.admins(instance.id);
  check("Admins view lists the promoted player", admins.rows.some(row => row.id === clientId && row.group === "Admin"));
  const commands = await admin.commands(instance.id);
  check("Commands from the real plugin_admin.ini", commands.some(entry => entry.command === "ban" && entry.level === 40));
  check("Audit events carry no IP, GUID, name or reason", !/203\.0\.113|NATIVEADMIN|NativeAdmin|Native test ban/.test(JSON.stringify(events)) && events.length === 4);
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message}`);
} finally {
  try { await dropAll(); } catch { /* best effort */ }
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.13 native B3 admin check PASS (real MariaDB, PyMySQL, eBc-B3 storage view)");
