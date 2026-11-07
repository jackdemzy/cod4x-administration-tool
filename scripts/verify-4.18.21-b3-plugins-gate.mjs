import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { B3_PLUGIN_CATALOG, B3_CATALOG_COMMIT, B3_FIXED_PLUGINS, catalogEntry, isAvailable } from "../lib/b3-plugin-catalog.mjs";
import { validB3PluginName, normalizeB3PluginRecords, MAX_B3_PLUGINS } from "../lib/b3-plugin-registry.mjs";
import { renderB3PluginTemplate, b3PluginClassName } from "../lib/b3-plugin-template.mjs";
import { validateB3PluginCode, validateB3PluginIni, validateB3PluginXml, checkB3PluginText, MAX_B3_PLUGIN_TEXT_BYTES } from "../lib/b3-plugin-validate.mjs";
import { b3PluginMessage } from "../lib/b3-plugin-messages.mjs";
import { hashB3Module } from "../lib/b3-plugin-hash.mjs";
import { renderB3Config, b3Paths } from "../lib/b3-config.mjs";
import { restartHints, planB3Integration, normalizeB3Integration } from "../lib/b3-integration.mjs";
import { ServerInstanceStore } from "../lib/server-instance-store.mjs";
import { InstanceB3PluginService } from "../lib/instance-b3-plugin-service.mjs";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from "../lib/remote-gateway.mjs";

// Block 16b gate: B3 plugin management. Catalog, names, template, b3.xml order,
// every start blocker, the restart hint, the admin-only code permission, no
// phone gateway route and value-free audit. No Python and no B3 run here: the
// start plan is exercised against a fixture eBc-B3 tree in a temp directory,
// the wiring is checked in source. The native check is
// scripts/verify-4.18.21-b3-plugins-native.mjs.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs"), b3Service = read("lib/instance-b3-service.mjs"), ui = read("lib/instance-b3-plugins.jsx");
const code = (fn) => { try { fn(); return null; } catch (error) { return error.code || "THROWN"; } };
const BLOCKERS = ["B3_PLUGIN_MISSING", "B3_PLUGIN_INTEGRITY_FAILED", "B3_PLUGIN_NOT_APPROVED", "B3_PLUGIN_DEPENDENCY_MISSING", "B3_PLUGIN_REQUIRES_PLUGIN", "B3_PLUGIN_CONFIG_MISSING"];

// ---- fixture: a fake eBc-B3 tree, a real instance store and the real plugin service ----
const ID = "gate-01";
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-plugins-gate-"));
let planCodes = {}, revisionBumped = false, customChangeBlocks = false, disabledUnchecked = false;
try {
  const basePath = path.join(root, "game"), executablePath = path.join(root, "core", "cod4x18_dedrun.exe");
  for (const dir of [path.join(basePath, "main"), path.join(basePath, "zone"), path.dirname(executablePath)]) await fsp.mkdir(dir, { recursive: true });
  for (const file of [path.join(basePath, "main", "pak0.iwd"), path.join(basePath, "zone", "common.ff"), executablePath]) await fsp.writeFile(file, "fixture");
  const store = new ServerInstanceStore({ root: path.join(root, "servers"), registryFile: path.join(root, "instances.json"), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: ID, name: "Gate 01", platform: "windows", serverCore: { executablePath, version: "21.5" }, basePath, port: 28960 });
  const b3Path = path.join(root, "ebc"), catalog = [], modules = {};
  // [name, location, kind, requiresConfigFile, requiresPlugins, pythonModules]
  for (const [name, location, kind, requiresConfigFile, requiresPlugins, pythonModules] of [
    ["welcome", "plugins", "package", true, [], []], ["duel", "plugins", "package", false, [], []], ["needsreq", "extplugins", "file", false, [], ["requests"]],
    ["geolocation", "plugins", "package", false, [], []], ["geowelcome", "plugins", "package", false, ["geolocation"], []], ["changed", "plugins", "package", false, [], []]]) {
    const dir = path.join(b3Path, "b3", location), module = kind === "file" ? path.join(dir, `${name}.py`) : path.join(dir, name);
    await fsp.mkdir(kind === "file" ? dir : module, { recursive: true });
    await fsp.writeFile(kind === "file" ? module : path.join(module, "__init__.py"), `class ${name}Plugin: pass\n`);
    modules[name] = module;
    catalog.push({ name, location, module: kind, sha256: (await hashB3Module(module)).sha256, configTemplate: null, configTemplateSha256: null, requiresConfigFile, requiresPlugins, requiresParsers: [], pythonModules });
  }
  // "changed" differs from its catalog hash (local edit of a shipped module).
  await fsp.appendFile(path.join(modules.changed, "__init__.py"), "# local edit\n");
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ pythonPath: null, b3Path }) }, catalog });
  const shipped = (name, extra = {}) => ({ name, source: "shipped", enabled: true, sha256: catalog.find(item => item.name === name).sha256, approvedAt: "2026-11-06T00:00:00.000Z", configType: null, ...extra });
  const dependencies = { environment: { b3Path }, results: [{ id: "requests", status: "MISSING" }] };
  const blockersFor = async records => { await store.setB3Plugins(ID, records); return (await service.plan(ID, dependencies)).blockers; };
  const before = store.get(ID).b3PluginsRevision;
  await service.createCustom(ID, { name: "myplug", from: "template" });
  revisionBumped = store.get(ID).b3PluginsRevision === before + 1;
  const custom = { ...store.get(ID).b3Plugins.find(item => item.name === "myplug"), enabled: true };
  customChangeBlocks = (await blockersFor([custom])).length === 0;
  await fsp.appendFile(path.join(b3Paths(instance).directory, "extplugins", "myplug.py"), "# changed after approval\n");
  const integrity = await blockersFor([custom]);
  customChangeBlocks = customChangeBlocks && integrity.length === 1 && integrity[0].code === "B3_PLUGIN_INTEGRITY_FAILED" && integrity[0].plugin === "myplug";
  disabledUnchecked = (await blockersFor([{ ...custom, enabled: false }])).length === 0;
  await fsp.rm(modules.duel, { recursive: true });
  const first = async records => (await blockersFor(records))[0] || null;
  planCodes = {
    B3_PLUGIN_MISSING: await first([shipped("duel")]),
    B3_PLUGIN_INTEGRITY_FAILED: (await first([custom])),
    B3_PLUGIN_NOT_APPROVED: await first([shipped("changed")]),
    B3_PLUGIN_DEPENDENCY_MISSING: await first([shipped("needsreq")]),
    B3_PLUGIN_REQUIRES_PLUGIN: await first([shipped("geowelcome")]),
    B3_PLUGIN_CONFIG_MISSING: await first([shipped("welcome")]),
  };
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

const { code: templateCode, config: templateConfig } = renderB3PluginTemplate("my_plug2");
const paths = b3Paths({ homePath: "/srv/gate" });
const xml = renderB3Config({ instance: { port: 28960 }, paths, gameLog: "/srv/gate/main/logs/games_mp.log", authConfigPath: paths.authConfig,
  plugins: [{ name: "welcome", source: "shipped", configPath: "/srv/gate/b3/plugins/welcome.ini", path: null }, { name: "duel", source: "shipped", configPath: null, path: null }, { name: "myplug", source: "custom", configPath: "/srv/a&b/b3/plugins/myplug.ini", path: "/srv/a&b/b3/extplugins" }] });
const pluginLines = xml.split("\n").filter(line => line.trim().startsWith("<plugin "));
const plan = planB3Integration({ settings: normalizeB3Integration({}), credentialsPresent: { rcon: true } });
const started = { fingerprint: plan.fingerprint, credentialDigest: "a", pluginsRevision: 3 };
const routes = [...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].map(route => JSON.stringify(route)).join(" ");
const matrix = server.slice(server.indexOf("const RBAC_MATRIX"), server.indexOf("});", server.indexOf("const RBAC_MATRIX")));
const roleLine = role => (matrix.split("\n").find(line => line.trim().startsWith(`${role}:`)) || "");
const route = (method, suffix, permission) => server.includes(`app.${method}(\`\${b3PluginsBase}${suffix}\`, requirePermission("${permission}")`);
const startBody = b3Service.slice(b3Service.indexOf("async #start("));

const checks = [
  ["Catalog: 34 shipped plugins of eBc-B3 9096624 with SHA-256 hashes, unique names", B3_CATALOG_COMMIT === "90966246ab1953ceeca5e8b62c714851a120b28a" && B3_PLUGIN_CATALOG.length === 34
    && B3_PLUGIN_CATALOG.every(item => /^[0-9a-f]{64}$/.test(item.sha256) && ["plugins", "extplugins"].includes(item.location) && ["file", "package"].includes(item.module) && (item.configTemplate === null) === (item.configTemplateSha256 === null))
    && new Set(B3_PLUGIN_CATALOG.map(item => item.name)).size === 34],
  ["Catalog: admin/publist/auth fixed and not listed, callvote unavailable on cod4x, discordbot omitted", JSON.stringify(B3_FIXED_PLUGINS) === JSON.stringify(["admin", "publist", "auth"]) && B3_FIXED_PLUGINS.every(name => !catalogEntry(name))
    && catalogEntry("callvote") && !isAvailable(catalogEntry("callvote")) && !catalogEntry("discordbot") && isAvailable(catalogEntry("welcome")) && catalogEntry("welcome").configTemplate === "b3/conf/plugin_welcome.ini"],
  ["Names: ^[a-z][a-z0-9_]{1,31}$, fixed names refused, custom must not shadow a shipped name, at most 32", code(() => validB3PluginName("my_plug2")) === null
    && ["A", "x", "1abc", "my-plug", "a".repeat(33), "../x"].every(name => code(() => validB3PluginName(name)) === "B3_PLUGIN_NAME_INVALID") && code(() => validB3PluginName("auth")) === "B3_PLUGIN_FIXED"
    && code(() => normalizeB3PluginRecords([{ name: "welcome", source: "custom", enabled: false, sha256: "0".repeat(64), approvedAt: "2026-11-06T00:00:00.000Z" }])) === "B3_PLUGIN_NAME_INVALID"
    && MAX_B3_PLUGINS === 32 && code(() => normalizeB3PluginRecords(Array.from({ length: 33 }, (_, index) => ({ name: `p${index}x`, source: "custom", enabled: false, sha256: "0".repeat(64), approvedAt: "2026-11-06T00:00:00.000Z" })))) === "B3_PLUGIN_LIMIT"],
  ["Template: class name follows Python str.title() + 'Plugin', code and config pass validation, imports only b3", b3PluginClassName("my_plug2") === "My_Plug2Plugin" && b3PluginClassName("x2y") === "X2YPlugin"
    && code(() => validateB3PluginCode("my_plug2", templateCode)) === null && templateCode.includes("class My_Plug2Plugin(b3.plugin.Plugin)") && templateCode.includes("requiresConfigFile = True")
    && templateCode.match(/^\s*(?:import|from)\s+\S+/gm).every(line => /^\s*import b3(?:\.plugin)?$/.test(line)) && validateB3PluginIni(templateConfig).ok && templateConfig.includes("my_plug2: 1")],
  ["Config and code validation: INI/XML errors carry the line, <configuration> root, 256 KB, NUL and missing class refused", validateB3PluginIni("[a]\nkey = v\nbroken line\n").line === 3 && !validateB3PluginIni("key = v\n").ok
    && validateB3PluginXml("<configuration><settings name=\"x\"/></configuration>").ok && !validateB3PluginXml("<config/>").ok && validateB3PluginXml("<configuration>\n<a>\n</configuration>").line >= 2
    && code(() => checkB3PluginText("x".repeat(MAX_B3_PLUGIN_TEXT_BYTES + 1))) === "B3_PLUGIN_CONFIG_INVALID" && code(() => checkB3PluginText("a\0b")) === "B3_PLUGIN_CONFIG_INVALID"
    && code(() => validateB3PluginCode("myplug", "class OtherPlugin: pass\n")) === "B3_PLUGIN_CODE_INVALID"],
  ["b3.xml order: admin, enabled plugins in registry order, auth; config only with a file, path only for custom, values escaped", pluginLines.length === 5
    && pluginLines[0].includes('name="admin"') && pluginLines[1] === '    <plugin name="welcome" config="/srv/gate/b3/plugins/welcome.ini"/>' && pluginLines[2] === '    <plugin name="duel"/>'
    && pluginLines[3] === '    <plugin name="myplug" config="/srv/a&amp;b/b3/plugins/myplug.ini" path="/srv/a&amp;b/b3/extplugins"/>' && pluginLines[4].includes('name="auth"')],
  ["Every start blocker is named with its plugin", BLOCKERS.every(blocker => planCodes[blocker]?.code === blocker && typeof planCodes[blocker]?.plugin === "string"),
    BLOCKERS.map(blocker => `${blocker}=${planCodes[blocker]?.code || "none"}`).join(" ")],
  ["A custom plugin changed after approval blocks with B3_PLUGIN_INTEGRITY_FAILED; disabled plugins are not checked; every change bumps b3PluginsRevision", customChangeBlocks && disabledUnchecked && revisionBumped],
  ["The B3 start plans the plugins before any file is written and records the revision", startBody.indexOf("this.plugins.plan(id, dependencies)") > 0 && startBody.indexOf("this.plugins.plan(id, dependencies)") < startBody.indexOf("prepareB3Runtime(")
    && startBody.includes("if (pluginPlan?.blockers.length) fail(pluginPlan.blockers[0].code, { blockers: pluginPlan.blockers })") && startBody.includes("pluginsRevision: pluginPlan ? pluginPlan.revision : null")],
  ["Restart hint PLUGINS_CHANGED follows b3PluginsRevision (no hash over config files)", restartHints({ plan, credentialDigest: "a", startedWith: started, pluginsRevision: 4 }).b3 === "PLUGINS_CHANGED"
    && restartHints({ plan, credentialDigest: "a", startedWith: started, pluginsRevision: 3 }).b3 === null && restartHints({ plan, startedWith: { fingerprint: plan.fingerprint }, pluginsRevision: 0 }).b3 === null
    && restartHints({ plan, startedWith: started, pluginsRevision: null }).b3 === null && b3PluginMessage("PLUGINS_CHANGED", "en").includes("restart")],
  ["b3.plugins.code is admin-only and guards the four code routes; switches, configs and approvals need config.manage; reads diagnostics.read", server.includes('{ id: "b3.plugins.code"')
    && matrix.includes("admin: Object.freeze([...RBAC_PERMISSION_IDS])") && ["operator", "auditor", "viewer", "monitor"].every(role => roleLine(role) && !roleLine(role).includes("b3.plugins.code"))
    && route("post", "/custom", "b3.plugins.code") && route("get", "/custom/:name/code", "b3.plugins.code") && route("put", "/custom/:name/code", "b3.plugins.code") && route("delete", "/custom/:name", "b3.plugins.code")
    && route("post", "/:name/${action}", "config.manage") && route("get", "/:name/config", "config.manage") && route("put", "/:name/config", "config.manage") && route("post", "/:name/approve", "config.manage")
    && server.includes('app.get(b3PluginsBase, requirePermission("diagnostics.read")') && ui.includes("me.permissions?.includes('b3.plugins.code')") && ui.includes("This code runs with the rights of the B3 process.")],
  ["No phone gateway route touches B3 plugins", !/b3/i.test(routes)],
  ["Audit: b3.plugin.<event> with instanceId, actor, name (+ sha256 for approvals and code), never config or code content",
    /function auditB3Plugin\(event, req, name, sha256\) \{\s*audit\("info", `b3\.plugin\.\$\{event\}`, \{ instanceId: req\.params\.id, actor: req\.auth\.username, name, \.\.\.\(sha256 === undefined \? \{\} : \{ sha256 \}\) \}\);\s*\}/.test(server)
    && ['"enabled" : "disabled"', '"config_saved", req, req.params.name)', '"approved", req, plugin.name, plugin.sha256)', '"custom_created", req, plugin.name, plugin.sha256)', '"code_saved", req, req.params.name, saved.sha256)', '"deleted", req, result.name)'].every(text => server.includes(text))
    && !/auditB3Plugin\([^)]*\b(text|code|body)\b/.test(server.replace(/function auditB3Plugin[^\n]*/, ""))],
  ["Every plugin code has a German and an English text", [...BLOCKERS, "B3_PLUGIN_CONFIG_INVALID", "B3_PLUGIN_CODE_INVALID", "B3_PLUGIN_CONFLICT", "B3_PLUGIN_NAME_INVALID", "B3_PLUGIN_FIXED", "B3_PLUGIN_UNKNOWN", "B3_PLUGIN_LIMIT"]
    .every(item => b3PluginMessage(item, "de") !== item && b3PluginMessage(item, "en") !== item && b3PluginMessage(item, "de") !== b3PluginMessage(item, "en"))],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`4.18.21 B3 plugins gate PASS (${checks.length} checks)`);
