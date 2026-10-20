import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InstanceB3DatabaseService } from "../lib/instance-b3-database-service.mjs";
import { runDatabaseHelper } from "../lib/b3-database-helper.mjs";
import { prepareB3Runtime } from "../lib/b3-config.mjs";
import { B3Runtime } from "../lib/b3-runtime.mjs";
import { EBC_CONFIRMATION } from "../lib/b3-database.mjs";

// Native Block 14 check on Linux against a real MariaDB/MySQL test database,
// real Python 2.7 + PyMySQL and real eBc-B3. Test credentials come from
// ~/.config/cod4x-control-test/b3db.env (mode 0600) or the environment:
// B3_DB_TEST_HOST, B3_DB_TEST_PORT, B3_DB_TEST_DATABASE, B3_DB_TEST_USER, B3_DB_TEST_PASSWORD.
// The test database is emptied at start and end; never point this at real data.
if (process.platform !== "linux") { console.log("SKIP native B3 database check runs on Linux only"); process.exit(0); }
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
const envFile = path.join(os.homedir(), ".config", "cod4x-control-test", "b3db.env");
const fileValues = Object.fromEntries((await fs.readFile(envFile, "utf8").catch(() => "")).split("\n").map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(match => [match[1], match[2]]));
const value = name => process.env[name] || fileValues[name];
const settings = { host: value("B3_DB_TEST_HOST"), port: Number(value("B3_DB_TEST_PORT") || 3306), database: value("B3_DB_TEST_DATABASE"), username: value("B3_DB_TEST_USER") };
const password = value("B3_DB_TEST_PASSWORD");
try { await fs.access(pythonPath); await fs.access(path.join(b3Path, "b3_run.py")); }
catch { console.log("SKIP native B3 database check: Python 2.7 or eBc-B3 not found"); process.exit(0); }
if (!settings.host || !settings.database || !settings.username || !password) { console.log("SKIP native B3 database check: no test database configured"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-db-native-"));
const instance = { id: "b3-db-native", homePath: path.join(root, "home"), port: 28998, platform: "linux" };
await fs.mkdir(path.join(instance.homePath, "main", "logs"), { recursive: true });
let wrongPassword = false;
const credentials = {
  async withRuntimeCredentials(id, action) {
    const b3db = Buffer.from(wrongPassword ? `${password}x` : password);
    try { return await action(Object.freeze({ rcon: null, master: null, join: null, b3db })); } finally { b3db.fill(0); }
  },
  async instanceStatus() { return { b3db: { configured: true } }; },
};
const events = [];
const service = new InstanceB3DatabaseService({ store: { get: () => instance }, credentials, environment: { read: async () => ({ pythonPath, b3Path }) }, b3IsRunning: async () => false, onEvent: event => events.push(event) });
const raw = (op, extra = {}) => runDatabaseHelper({ pythonPath, op, connection: settings, password: Buffer.from(password), ...extra });
const dropAll = async () => {
  const { tables } = await raw("probe");
  const names = Object.keys(tables);
  if (names.length) await raw("apply", { statements: names.map(name => `DROP TABLE \`${name}\``) });
};

let b3;
try {
  await dropAll();
  await service.save(instance.id, settings);
  // 1. EMPTY -> migrate -> COMPLETE (no backup needed for an empty database).
  const empty = await service.test(instance.id);
  check("Test connection OK, schema EMPTY", empty.connection === "OK" && empty.schema.state === "EMPTY", `${empty.connection} ${empty.schema?.state}`);
  const first = await service.migrate(instance.id);
  check("Migration on EMPTY -> COMPLETE, no backup", first.schema.state === "COMPLETE" && first.backup === null && first.ready);
  // 2. Data + missing table -> PARTIAL -> verified backup holds the data -> migrate.
  await raw("apply", { statements: ["INSERT INTO `clients` (`guid`, `name`, `ip`, `time_add`, `time_edit`) VALUES ('NATIVETESTGUID', 'NativeTester', '127.0.0.1', 1, 1)", "DROP TABLE `penalties`"] });
  const partial = await service.test(instance.id);
  check("Missing table -> SCHEMA_PARTIAL", partial.code === "SCHEMA_PARTIAL" && partial.schema.missingTables.join() === "penalties", partial.schema?.missingTables?.join());
  const second = await service.migrate(instance.id);
  const backupText = second.backup ? await fs.readFile(second.backup.path, "utf8") : "";
  check("Backup verified and contains the existing data", Boolean(second.backup) && backupText.includes("NATIVETESTGUID") && /^-- TABLE clients ROWS \d+$/m.test(backupText) && !backupText.includes(password));
  if (second.backup) check("Backup file is 0600", ((await fs.stat(second.backup.path)).mode & 0o777) === 0o600);
  const { tables: afterPartial } = await raw("probe");
  check("Migration on PARTIAL -> COMPLETE, only the missing table created", second.schema.state === "COMPLETE" && Boolean(afterPartial.penalties));
  // 3. eBc promod schema, opt-in only with the exact phrase and after a backup.
  const refused = await service.migrate(instance.id, { ebcOptIn: true, confirmation: "yes" }).catch(error => error.code);
  check("eBc opt-in without exact phrase refused", refused === "EBC_CONFIRMATION_REQUIRED");
  const ebc = await service.migrate(instance.id, { ebcOptIn: true, confirmation: EBC_CONFIRMATION });
  const { tables: afterEbc } = await raw("probe");
  check("eBc opt-in -> player_core + prestige_log exist, backup taken", Boolean(afterEbc.player_core && afterEbc.prestige_log && ebc.backup));
  // 4. Failure cases.
  wrongPassword = true;
  const auth = await service.test(instance.id);
  wrongPassword = false;
  check("Wrong password -> DB_AUTH_FAILED", auth.connection === "DB_AUTH_FAILED", auth.connection);
  await service.save(instance.id, { ...settings, port: 1 });
  const unreachable = await service.test(instance.id);
  check("Wrong port -> DB_UNREACHABLE", unreachable.connection === "DB_UNREACHABLE", unreachable.connection);
  await service.save(instance.id, settings);
  const ready = await service.test(instance.id);
  check("Retest -> B3 Ready", ready.ready === true);
  // 5. Real B3 against MySQL.
  const { dsn } = await service.connectionFor(instance.id, Buffer.from(password));
  const prepared = await prepareB3Runtime(instance, "logs/games_mp.log", { databaseDsn: dsn });
  b3 = new B3Runtime({ instanceId: instance.id, platform: "linux", stateFile: path.join(instance.homePath, "logs", "b3-runtime-state.json"), paths: prepared, startupGraceMs: 4000 });
  await b3.load();
  await b3.start({ pythonPath, b3Path, configPath: prepared.config });
  let connected = false;
  for (const end = Date.now() + 45000; Date.now() < end && !connected; await delay(500)) connected = (await fs.readFile(prepared.logFile, "utf8").catch(() => "")).includes("Successfully established a connection with MySQL database");
  check("B3 connects to MySQL (b3.log)", connected);
  const b3Log = await fs.readFile(prepared.logFile, "utf8").catch(() => "");
  check("B3 log and output never contain the password", !b3Log.includes(password) && !(await b3.outputTail()).includes(password));
  check("Events carry no password", !JSON.stringify(events).includes(password));
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message}`);
} finally {
  if (b3) { try { await b3.stop(); } catch { /* best effort */ } }
  try { await dropAll(); } catch { /* best effort */ }
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.12 native B3 database check PASS (real MariaDB + Python 2.7 + PyMySQL + eBc-B3)");
