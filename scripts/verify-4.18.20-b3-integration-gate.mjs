import fs from "node:fs";
import { planB3Integration, normalizeB3Integration, restartHints, KNOWN_B3HIDE_HASHES, validB3AuthPassword } from "../lib/b3-integration.mjs";
import { renderB3Config, renderAuthConfig, b3Paths } from "../lib/b3-config.mjs";
import { redactB3Config, redactB3PluginAuth } from "../lib/b3-manager.mjs";
import { parseStatus, nameMatches } from "../lib/rcon-status.mjs";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from "../lib/remote-gateway.mjs";

// Block 16 gate: B3 <-> CoD4x integration. One plan drives the b3hide dvars of
// the core launch and the b3.xml/plugin_auth.ini of the B3 start; every gap is a
// named blocker; secrets are redacted; nothing of it is reachable from the
// phone gateway. Behaviour is exercised directly; wiring is checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs"), manager = read("lib/server-instance-manager.mjs"), b3Service = read("lib/instance-b3-service.mjs"), ui = read("lib/instance-b3-integration.jsx");
const throws = (fn, code) => { try { fn(); return false; } catch (error) { return error.code === code; } };
const plan = (settings, overrides = {}) => planB3Integration({ settings: normalizeB3Integration(settings), b3hideState: "ENABLED", authPluginPresent: true, credentialsPresent: { rcon: true, b3authLevels: [100] }, ...overrides });

const on = plan({ hideCommands: true, prefix: "#", hideLevel: 40 });
const off = plan({}, { credentialsPresent: { rcon: false, b3authLevels: [] } });
const paths = b3Paths({ homePath: "/srv/gate" });
const xml = renderB3Config({ instance: { port: 28960 }, paths, gameLog: "/srv/gate/main/games_mp.log", rconPassword: "Gate-Rcon-1", authConfigPath: paths.authConfig });
const ini = renderAuthConfig({ passwords: { 100: "gate-pass" } });
const b3hideStatus = "map: mp_backlot\nnum score ping guid                             name            lastmsg address               qport rate\n--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----\n  0     0    0 0                                bot0^7                  0 bot                    1001 25000\n";
const routes = [...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].map(route => JSON.stringify(route)).join(" ");

const checks = [
  ["Switch on: b3hide dvars come from the plan (#, 1, 40), auth on, RCON required", JSON.stringify(on.b3hide) === JSON.stringify({ b3Prefix: "#", b3Hide: "1", b3HideLvl: "40" }) && on.auth.enabled && on.rcon.required && !on.blockers.length],
  ["Switch off: no b3hide/auth; missing RCON is only a warning", off.b3hide === null && !off.auth.enabled && !off.blockers.length && off.warnings[0]?.code === "RCON_PASSWORD_MISSING"],
  ["Every gap is a named blocker", ["MISSING", "NOT_APPROVED", "INTEGRITY_MISMATCH", "WRONG_PLATFORM"].every(state => plan({ hideCommands: true }, { b3hideState: state }).blockers[0]?.code.startsWith("B3HIDE_"))
    && plan({ hideCommands: true }, { credentialsPresent: { rcon: false, b3authLevels: [] } }).blockers[0]?.code === "RCON_PASSWORD_MISSING"
    && plan({ hideCommands: true }, { credentialsPresent: { locked: true } }).blockers[0]?.code === "VAULT_LOCKED"
    && plan({ hideCommands: true }, { authPluginPresent: false }).blockers[0]?.code === "B3_AUTH_PLUGIN_MISSING"],
  ["Prefix is one character of a fixed set, level a B3 group, !auth passwords are bounded", throws(() => normalizeB3Integration({ prefix: "!;" }), "B3_PREFIX_INVALID") && throws(() => normalizeB3Integration({ hideLevel: 21 }), "B3_HIDE_LEVEL_INVALID")
    && ["a b c d", "pa;ss", "<pass>"].every(value => throws(() => validB3AuthPassword(value), "B3_AUTH_PASSWORD_INVALID"))],
  ["Release hashes are pinned for both platforms", /^[0-9a-f]{64}$/.test(KNOWN_B3HIDE_HASHES.linux) && /^[0-9a-f]{64}$/.test(KNOWN_B3HIDE_HASHES.windows)],
  ["b3.xml carries the RCON password and the auth entry; the config views redact both files", xml.includes("<set name=\"rcon_password\">Gate-Rcon-1</set>") && xml.includes("name=\"auth\"")
    && !redactB3Config(xml).includes("Gate-Rcon-1") && !redactB3PluginAuth(ini).includes("gate-pass") && ini.includes("auth: 0")],
  ["Restart hints follow settings and the vault", restartHints({ plan: on, vaultSha256: "b", launchedWith: { fingerprint: "x" }, startedWith: { fingerprint: on.fingerprint, vaultSha256: "a" } }).server === "SETTINGS_CHANGED"
    && restartHints({ plan: on, vaultSha256: "b", launchedWith: null, startedWith: { fingerprint: on.fingerprint, vaultSha256: "a" } }).b3 === "CREDENTIALS_CHANGED"],
  ["b3hide status format is parsed with its limits; long names compare by the cut prefix", parseStatus(b3hideStatus, { format: "b3hide" }).limits?.connectionState === false && parseStatus(b3hideStatus, { format: "b3hide" }).players[0]?.bot === true
    && nameMatches({ name: "VeryLongPlaye", rawName: "^1VeryLongPlaye^7" }, "VeryLongPlayerName", "b3hide") && !nameMatches({ name: "VeryLongPlaye", rawName: "^1VeryLongPlaye^7" }, "VeryLongPlayerName", "core")],
  ["The server launch computes the plan before the plugin gate and forces b3hide with the plan dvars", /b3IntegrationPlan\(id, \{ forLaunch: true \}\)[\s\S]*pluginLaunchArguments\(launchInstance\)/.test(manager) && manager.includes("config: plan.b3hide")],
  ["The B3 start writes rconPassword and auth inside the vault scope and restores both files", b3Service.includes("rconPassword: credentials.rcon") && b3Service.includes("restoreConfig(paths.authConfig, previousAuth)")],
  ["Routes: read with diagnostics.read, writes with config.manage, audit without passwords", server.includes('app.get("/api/instances/:id/b3/integration", requirePermission("diagnostics.read")')
    && server.includes('app.post("/api/instances/:id/b3/integration", requirePermission("config.manage")') && server.includes('app.post("/api/instances/:id/b3/integration/auth-password", requirePermission("config.manage")')
    && /audit\("info", result\.set \? "b3\.auth\.password\.set" : "b3\.auth\.password\.cleared", \{ instanceId: req\.params\.id, actor: req\.auth\.username, level: result\.level \}\)/.test(server)],
  ["No phone gateway route touches the B3 integration", !/b3/i.test(routes)],
  ["The UI never renders a stored !auth password (write-only password fields)", ui.includes('type="password"') && !/value=\{data\./.test(ui)],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.20 B3 integration gate PASS");
