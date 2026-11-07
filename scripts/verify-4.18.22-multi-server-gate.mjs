import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { databaseTargetKey, validateDatabaseSettings } from "../lib/b3-database.mjs";
import { validateManagedConfigText, GAME_LOG_PATH } from "../lib/instance-config-validator.mjs";
import { sharedCredentialWarning } from "../lib/credential-warnings.mjs";
import { B3_DATABASE_MESSAGES } from "../lib/b3-database-messages.mjs";

// Block 17 gate: multi-server isolation. The behaviour is proved by
// test/multi-server-isolation.test.mjs (real store, vault, RCON service, B3
// service and UDP doubles; three instances launched in parallel); this gate runs
// that file and checks the wiring in source. The native check with the real
// core is scripts/verify-4.18.22-multi-server-native.mjs.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const server = read("installer-server.mjs"), manager = read("lib/server-instance-manager.mjs"), b3Service = read("lib/instance-b3-service.mjs");
const databaseService = read("lib/instance-b3-database-service.mjs"), credentials = read("lib/instance-credential-service.mjs"), engine = read("lib/config-engine.mjs");
const code = fn => { try { fn(); return null; } catch (error) { return error.code || "THROWN"; } };
const target = (host, database, port = 3306) => databaseTargetKey(validateDatabaseSettings({ host, port, database, username: "u" }));

const checks = [
  ["database target key: user ignored, loopback spellings equal, other database/port/host differ", target("127.0.0.1", "b3") === target("localhost", "b3") && target("DB.example.org", "b3") === target("db.example.org", "b3") && target("127.0.0.1", "b3") !== target("127.0.0.1", "b3_two") && target("127.0.0.1", "b3") !== target("127.0.0.1", "b3", 3307) && target("127.0.0.1", "b3") !== target("10.0.0.5", "b3")],
  ["database save refuses a target another instance already saved", databaseService.includes("fail('B3_DATABASE_TARGET_SHARED', { otherInstanceId: sharedWith })") && databaseService.includes("{ enabledOnly: false }")],
  ["B3 start refuses a MySQL target another instance has enabled", b3Service.includes("this.database.sharedTarget?.(id)") && b3Service.includes("fail('B3_DATABASE_TARGET_SHARED', { otherInstanceId })") && databaseService.includes("{ enabledOnly: true }")],
  ["the new code has a German and an English message", Array.isArray(B3_DATABASE_MESSAGES.B3_DATABASE_TARGET_SHARED) && B3_DATABASE_MESSAGES.B3_DATABASE_TARGET_SHARED.length === 2],
  ["the B3 route passes the code through (B3_ prefix)", server.includes("/^B3_[A-Z_]+$/.test(error.code")],
  ["shared master token / RCON password is a warning on a successful save, never a block", credentials.includes("MASTER_TOKEN_SHARED") && credentials.includes("RCON_PASSWORD_SHARED") && credentials.includes("warnings: [{ code: SHARED_WARNING[kind], instances }]") && !/fail\('(?:MASTER_TOKEN_SHARED|RCON_PASSWORD_SHARED)/.test(credentials)],
  ["values are compared in memory only (timingSafeEqual), results carry instance IDs", credentials.includes("timingSafeEqual") && credentials.includes("sharedWith")],
  ["master token audit carries the instance IDs only", server.includes("sharedWith: credential.warnings?.find(warning => warning.code === \"MASTER_TOKEN_SHARED\")?.instances || []")],
  ["credential warning text is German and English and names the instances", /RCON-Passwort.*server-b/.test(sharedCredentialWarning("rcon", ["server-b"], true)) && /RCON password.*server-b/.test(sharedCredentialWarning("rcon", ["server-b"], false)) && sharedCredentialWarning("master", [], true) === "" && sharedCredentialWarning("master", null, true) === ""],
  ["the credential editor shows the warning", read("lib/instance-credential-editor.jsx").includes("sharedCredentialWarning(kind, credentials?.[kind]?.sharedWith, de)")],
  ["managed config: g_log stays inside the instance, logfile is 0 to 2", code(() => validateManagedConfigText('set g_log "../../b/main/games_mp.log"', { port: 28960 })) === "INSTANCE_CONFIG_INVALID" && code(() => validateManagedConfigText('set logfile "7"', { port: 28960 })) === "INSTANCE_CONFIG_INVALID" && code(() => validateManagedConfigText('set g_log "logs/games_mp.log"', { port: 28960 })) === null],
  ["one game-log pattern for the config engine and the raw config", GAME_LOG_PATH.test("logs/games_mp.log") && !GAME_LOG_PATH.test("../a.log") && engine.includes("GAME_LOG_PATH.test(value)") && !engine.includes("[a-zA-Z0-9_-]+\\.log$/")],
  ["parallel launches take turns for the vault hand-over", manager.includes("vaultTurn(action)") && manager.includes("await this.vaultTurn(() => this.credentialService.withRuntimeCredentials(id")],
  ["the vault itself still refuses a second scope at once (unchanged)", credentials.includes("if (this.#busy) fail('VAULT_OPERATION_BUSY')")],
  ["ports stay unique in the registry", read("lib/server-instance-store.mjs").includes("INSTANCE_PORT_CONFLICT") && read("lib/server-instance-store.mjs").includes("INSTANCE_ID_CONFLICT")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

// Behaviour: three instances in parallel and every roadmap error case.
const run = spawnSync(process.execPath, ["--test", "test/multi-server-isolation.test.mjs"], { encoding: "utf8" });
const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
console.log(`${run.status === 0 && summary.fail === 0 && summary.pass >= 15 ? "PASS" : "FAIL"} multi-server isolation tests (${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail)`);
if (run.status !== 0 || summary.fail !== 0 || !(summary.pass >= 15)) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(1); }
console.log("4.18.22 multi-server gate PASS (three parallel instances without cross-contamination, fake core; the native check is separate)");
