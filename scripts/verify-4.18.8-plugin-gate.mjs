import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRconFixture } from "../test/support/rcon-instance-fixture.mjs";

// Block 10 gate: Plugin Discovery + Enable/Disable + Integrity.
// Real store, runtime manager, plugin manager and RCON against the UDP test
// double. Plugin files are inert test bytes; no library is ever loaded.
// NOT a native gate: loading a real b3hide.dll/.so in cod4x18_dedrun remains open.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const bytes = label => Buffer.from(`gate plugin ${label} `.padEnd(256, "#"));
const sha = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
async function rejectsWith(code, action) { try { await action(); return false; } catch (error) { return error.code === code; } }

const fixture = await createRconFixture();
try {
  const { manager, children, store, root } = fixture;
  await fixture.create("plugin-gate");
  const home = store.get("plugin-gate").homePath;
  const manual = bytes("manual");
  await fs.writeFile(path.join(home, "plugins", "b3hide.dll"), manual);
  await fs.writeFile(path.join(home, "plugins", "b3hide.so"), bytes("linux"));

  const discovered = await manager.plugins("plugin-gate");
  const byName = state => discovered.plugins.find(plugin => plugin.state === state);
  check("Discovery: platform plugin found with SHA-256, not trusted yet", byName("NOT_APPROVED")?.sha256 === sha(manual));
  check("Discovery: foreign-platform file flagged", Boolean(byName("WRONG_PLATFORM")));
  check("Approval requires the confirmed hash", await rejectsWith("PLUGIN_INTEGRITY_FAILED", () => manager.approvePlugin("plugin-gate", { name: "b3hide", sha256: "0".repeat(64) })));
  await manager.approvePlugin("plugin-gate", { name: "b3hide", sha256: sha(manual) });
  const disabled = await manager.launch("plugin-gate");
  check("Disabled: started without loadPlugin", !children.get(disabled.pid).args.includes("+loadPlugin"));
  check("Changes blocked while running", await rejectsWith("INSTANCE_RUNTIME_BUSY", () => manager.setPluginEnabled("plugin-gate", "b3hide", true)));
  await manager.stop("plugin-gate");
  await manager.setPluginEnabled("plugin-gate", "b3hide", true);
  await manager.configurePlugin("plugin-gate", "b3hide", { b3Hide: "1" });
  const enabled = await manager.launch("plugin-gate");
  const args = children.get(enabled.pid).args;
  check("Enabled: +loadPlugin b3hide (+ plugin dvars) before +exec server.cfg", args[args.indexOf("+loadPlugin") + 1] === "b3hide" && args.indexOf("+loadPlugin") < args.indexOf("+exec") && args.includes("b3Hide"));
  const loaded = await manager.plugins("plugin-gate");
  check("Runtime load state from the core message", loaded.plugins.find(plugin => plugin.name === "b3hide").load === "LOADED");
  await fixture.setRcon("plugin-gate", "Gate-Plugin-Rcon1");
  await manager.launch("plugin-gate", true);
  check("Version shown via RCON pluginInfo", (await manager.readPluginVersions("plugin-gate", "gate")).plugins.find(plugin => plugin.name === "b3hide").version === "1.0");
  await manager.stop("plugin-gate");

  const spawned = children.size;
  await fs.writeFile(path.join(home, "plugins", "b3hide.dll"), bytes("tampered"));
  check("Integrity: modified plugin blocks the start before spawn", await rejectsWith("PLUGIN_INTEGRITY_FAILED", () => manager.launch("plugin-gate")) && children.size === spawned);
  check("Integrity: modified plugin cannot be re-enabled without re-approval", (await manager.plugins("plugin-gate")).plugins.find(plugin => plugin.name === "b3hide").state === "INTEGRITY_MISMATCH");
  await fs.unlink(path.join(home, "plugins", "b3hide.dll"));
  check("Missing enabled plugin blocks the start", await rejectsWith("PLUGIN_MISSING", () => manager.launch("plugin-gate")));
  await manager.setPluginEnabled("plugin-gate", "b3hide", false);
  check("Disable restores a plugin-free start", (await manager.launch("plugin-gate")).status === "RUNNING");
  await manager.stop("plugin-gate");

  const source = path.join(root, "b3hide.dll"), installed = bytes("installed");
  await fs.writeFile(source, installed);
  await manager.removePlugin("plugin-gate", "b3hide");
  const result = await manager.installPlugin("plugin-gate", { sourcePath: source });
  check("Install from local file pins its hash and starts disabled", result.sha256 === sha(installed) && (await manager.plugins("plugin-gate")).plugins.find(plugin => plugin.name === "b3hide").state === "DISABLED");
  check("Install never overwrites an existing plugin", await rejectsWith("PLUGIN_EXISTS", () => manager.installPlugin("plugin-gate", { sourcePath: source })));
} finally {
  await fixture.cleanup();
}

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.8 Plugin Discovery + Enable/Disable + Integrity gate PASS (inert test files; native plugin load remains open)");
