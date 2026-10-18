import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigEngineStorage } from "../lib/config-engine-storage.mjs";

// Block 6 gate: Config Change -> Backup -> Apply -> Verify, plus the declared
// error cases, against real files in an isolated temporary instance home.
// No Dedicated process is started; runtime activation is covered by tests.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
async function rejectsWith(code, action) {
  try { await action(); return false; } catch (error) { return error.code === code; }
}

const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-config-gate-"));
try {
  const instance = { id: "config-gate", homePath, configPath: path.join(homePath, "main", "server.cfg"), port: 49260 };
  await fs.mkdir(path.dirname(instance.configPath));
  await fs.writeFile(instance.configPath, 'set sv_hostname "Gate Original"\nset net_port "49260"\nset g_log "logs/games_mp.log"\n', { mode: 0o600 });
  const engine = new ConfigEngineStorage();
  const before = await engine.read(instance);
  const entries = [...before.entries.map(entry => entry.name === "sv_hostname" ? { ...entry, value: "Gate Changed" } : entry), { command: "set", name: "sv_maxclients", value: "18" }];

  const preview = await engine.preview(instance, { expectedSha256: before.sha256, entries });
  check("Config change preview validates without writing", preview.valid && preview.diff.length === 2 && (await engine.read(instance)).sha256 === before.sha256);
  const applied = await engine.apply(instance, { expectedSha256: before.sha256, entries });
  const backup = await engine.readBackup(instance, applied.backupId);
  check("Backup holds exact previous text and fingerprint", backup.text === before.text && backup.sha256 === before.sha256 && applied.previousSha256 === before.sha256);
  const current = await engine.read(instance);
  check("Apply wrote the candidate configuration", current.entries.find(entry => entry.name === "sv_hostname")?.value === "Gate Changed");
  check("Verify matches the applied fingerprint", applied.verified && current.sha256 === applied.sha256);
  const again = await engine.apply(instance, { expectedSha256: applied.sha256, entries });
  check("Reproducible: identical change is a verified no-op", again.changed === false && again.sha256 === applied.sha256 && again.backupId === null);
  const restored = await engine.restore(instance, { backupId: applied.backupId, expectedSha256: applied.sha256 });
  check("Restore returns byte-identical previous configuration", restored.sha256 === before.sha256 && await fs.readFile(instance.configPath, "utf8") === before.text);

  const invalid = [
    ["Invalid CVAR blocked", [{ command: "set", name: "unknown_setting", value: "1" }]],
    ["Inadmissible value blocked", [{ command: "set", name: "sv_maxclients", value: "65" }]],
    ["Plaintext credential blocked", [{ command: "set", name: "rcon_password", value: "Disposable-123!" }]],
    ["Duplicate setting blocked", [{ command: "set", name: "sv_hostname", value: "a" }, { command: "set", name: "sv_hostname", value: "b" }]],
  ];
  for (const [name, model] of invalid) {
    const blocked = await rejectsWith("CONFIG_SCHEMA_INVALID", () => engine.apply(instance, { expectedSha256: restored.sha256, entries: model }))
      || await rejectsWith("CONFIG_PARSE_INVALID", () => engine.apply(instance, { expectedSha256: restored.sha256, entries: model }));
    check(name, blocked && (await engine.read(instance)).sha256 === restored.sha256);
  }
  check("Stale snapshot blocked", await rejectsWith("CONFIG_CONFLICT", () => engine.apply(instance, { expectedSha256: before.sha256.replace(/./, c => c === "0" ? "1" : "0"), entries })));
  await fs.writeFile(instance.configPath, 'set sv_hostname "syntax error');
  const damaged = await engine.recoverySnapshot(instance);
  check("Damaged config detected and not applied over", damaged.valid === false && await rejectsWith("INSTANCE_CONFIG_INVALID", () => engine.apply(instance, { expectedSha256: damaged.sha256, entries })));
  const recovered = await engine.restore(instance, { backupId: applied.backupId, expectedSha256: damaged.sha256 });
  check("Damaged config recovered from verified backup", recovered.sha256 === before.sha256);
} finally {
  await fs.rm(homePath, { recursive: true, force: true });
}

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.4 Config Change -> Backup -> Apply -> Verify gate PASS");
