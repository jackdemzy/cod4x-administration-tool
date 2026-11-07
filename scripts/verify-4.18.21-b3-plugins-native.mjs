import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { B3Environment } from "../lib/b3-dependencies.mjs";
import { b3Paths } from "../lib/b3-config.mjs";
import { renderB3PluginTemplate, b3PluginClassName } from "../lib/b3-plugin-template.mjs";
import { ServerInstanceStore } from "../lib/server-instance-store.mjs";
import { InstanceB3PluginService } from "../lib/instance-b3-plugin-service.mjs";
import { InstanceB3Service } from "../lib/instance-b3-service.mjs";

// Native Block 16b check on Linux: real Python 2.7 + eBc-B3 9096624 (SQLite
// storage), no CoD4x server (B3 only needs its game log file; RCON stays
// unreachable, which does not stop plugin loading). The plugin files, b3.xml
// and the start go through the same CONTROL services the backend uses
// (InstanceB3PluginService, InstanceB3Service).
// Usage (non-root): B3_PYTHON=/path/python2.7 B3_SOURCE=/path/ebc-b3 node scripts/verify-4.18.21-b3-plugins-native.mjs
if (process.platform !== "linux") { console.log("SKIP native B3 plugins check runs on Linux only"); process.exit(0); }
const pythonPath = process.env.B3_PYTHON || path.join(os.homedir(), ".pyenv/versions/2.7.18/bin/python2.7");
const b3Path = process.env.B3_SOURCE || path.join(os.homedir(), "ebc-b3");
try { for (const file of [pythonPath, path.join(b3Path, "b3_run.py"), path.join(b3Path, "b3", "plugins", "welcome")]) await fs.access(file); }
catch { console.log("SKIP native B3 plugins check: Python 2.7 or eBc-B3 not found"); process.exit(0); }

const run = promisify(execFile);
const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(500)) if (await predicate()) return true; return false; }
const readText = file => fs.readFile(file, "utf8").catch(() => "");

const ID = "b3-plugins";
const TOKEN = "Native-Token-1";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-plugins-"));
const audits = [];
const audit = (event, details) => audits.push({ event, ...details });
let b3Service = null, paths = null;
try {
  // 1. The template is valid Python 2.7 and its class name is what B3's loader looks up.
  const scratch = path.join(root, "compile");
  await fs.mkdir(scratch);
  const names = ["myplug", "my_plug2", "x2y"];
  for (const name of names) await fs.writeFile(path.join(scratch, `${name}.py`), renderB3PluginTemplate(name).code);
  const compiled = await run(pythonPath, ["-m", "py_compile", ...names.map(name => path.join(scratch, `${name}.py`))]).then(() => true, error => error.stderr || error.message);
  check("python2.7 -m py_compile accepts the template code", compiled === true, compiled === true ? names.join(",") : String(compiled).slice(0, 300));
  const { stdout: titled } = await run(pythonPath, ["-c", `import sys\nfor n in sys.argv[1:]: print '%sPlugin' % n.title()`, ...names]);
  check("Template class names match Python's '%sPlugin' % name.title() (B3 plugin loader)", titled.trim().split("\n").join(",") === names.map(b3PluginClassName).join(","), titled.trim().split("\n").join(","));

  // 2. Instance, environment and services as in installer-server.mjs.
  const basePath = path.join(root, "game"), executablePath = path.join(root, "core", "cod4x18_dedrun");
  for (const dir of [path.join(basePath, "main"), path.join(basePath, "zone"), path.dirname(executablePath)]) await fs.mkdir(dir, { recursive: true });
  for (const file of [path.join(basePath, "main", "pak0.iwd"), path.join(basePath, "zone", "common.ff"), executablePath]) await fs.writeFile(file, "fixture");
  const store = new ServerInstanceStore({ root: path.join(root, "servers"), registryFile: path.join(root, "instances.json"), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: ID, name: "B3 Plugins", platform: "linux", serverCore: { executablePath, version: "21.2" }, basePath, port: 28940 + Math.floor(Math.random() * 10) });
  paths = b3Paths(instance);
  const environment = new B3Environment(path.join(root, "b3-environment.json"));
  await environment.save({ pythonPath, b3Path });
  const plugins = new InstanceB3PluginService({ store, environment });
  b3Service = new InstanceB3Service({ store, environment, plugins, platform: () => "linux", onEvent: entry => audit(entry.event, entry) });

  // 3. welcome (shipped, catalog hash) and a custom plugin from the template; the
  //    custom config gets a token-like value that must never leave the file.
  const welcome = await plugins.setEnabled(ID, "welcome", true);
  audit("b3.plugin.enabled", { instanceId: ID, actor: "native", name: welcome.name });
  check("welcome matches the catalog hash and is enabled with its config template", welcome.state === "ENABLED" && welcome.sha256 === welcome.expectedSha256, `${welcome.state} ${String(welcome.sha256).slice(0, 12)}`);
  const created = await plugins.createCustom(ID, { name: "myplug", from: "template" });
  audit("b3.plugin.custom_created", { instanceId: ID, actor: "native", name: created.name, sha256: created.sha256 });
  const enabled = await plugins.setEnabled(ID, "myplug", true);
  audit("b3.plugin.enabled", { instanceId: ID, actor: "native", name: enabled.name });
  const config = await plugins.readConfig(ID, "myplug");
  await plugins.saveConfig(ID, "myplug", { text: `${config.text}token = ${TOKEN}\n`, expectedSha256: config.sha256 });
  audit("b3.plugin.config_saved", { instanceId: ID, actor: "native", name: "myplug" });

  // 4. B3 starts with both plugins in b3.xml.
  const started = await b3Service.start(ID);
  check("B3 starts through InstanceB3Service with the plugin plan (RUNNING)", started.runtime.status === "RUNNING", `${started.runtime.status} pid ${started.runtime.pid}`);
  const xml = await readText(paths.config);
  const lines = xml.split("\n").filter(line => line.trim().startsWith("<plugin ")).map(line => line.trim());
  check("b3.xml lists admin, welcome, myplug (custom with path to the instance extplugins)", lines.length === 3 && lines[0].includes('"admin"') && lines[1] === `<plugin name="welcome" config="${path.join(paths.directory, "plugins", "welcome.ini")}"/>`
    && lines[2] === `<plugin name="myplug" config="${path.join(paths.directory, "plugins", "myplug.ini")}" path="${path.join(paths.directory, "extplugins")}"/>`, lines.join(" | "));
  let log = "";
  // B3 log lines look like (Python repr, unicode values with a u prefix):
  //   261107 01:12:02 BOT      u'Loading plugin #2 : welcome [<home>/b3/plugins/welcome.ini]'
  //   261107 01:12:02 BOT      'Plugin welcome (1.4 - ThorN, xlr8or, Courgette) loaded'
  const bot = text => new RegExp(`^\\d{6} \\d{2}:\\d{2}:\\d{2}\\s+BOT\\s+u?'${text}`, "m");
  const loaded = await until(async () => { log = await readText(paths.logFile); return bot("All plugins started").test(log) && bot("Start reading game events").test(log); }, 60000);
  const line = pattern => (log.split("\n").find(item => pattern.test(item)) || "").replace(/^\d{6} \d{2}:\d{2}:\d{2}\s+/, "").slice(0, 140);
  check("B3 loads welcome (b3.log BOT 'Loading plugin #n : welcome [...]' and 'Plugin welcome (...) loaded')", bot("Loading plugin #\\d+ : welcome \\[").test(log) && bot("Plugin welcome \\(.*\\) loaded'").test(log), `${line(/Loading plugin #\d+ : welcome/)} / ${line(/'Plugin welcome \(/)}`);
  check("B3 loads the custom template plugin from the instance extplugins directory", bot("Loading plugin #\\d+ : myplug \\[").test(log) && bot("Plugin myplug \\(1\\.0\\.0 - you\\) loaded'").test(log), `${line(/Loading plugin #\d+ : myplug/)} / ${line(/'Plugin myplug \(/)}`);
  check("The template command registers with the admin plugin (DEBUG 'AdminPlugin: command \"myplug (None)\" registered ... level (1, 100)')", /AdminPlugin: command "myplug \(None\)" registered with cmd_myplug for level \(1, 100\)/.test(log), line(/command "myplug /));
  check("B3 starts both plugins and reads game events without a CoD4x server", loaded && bot("Starting plugin #\\d+ : welcome'").test(log) && bot("Starting plugin #\\d+ : myplug'").test(log), line(/'Start reading game events'/));
  await b3Service.stop(ID);
  check("B3 stopped", (await b3Service.status(ID)).runtime.status === "STOPPED");

  // 5. A changed module blocks the next start before anything is written.
  const before = await readText(paths.config);
  await fs.appendFile(path.join(paths.directory, "extplugins", "myplug.py"), "# changed outside CONTROL\n");
  const blocked = await b3Service.start(ID).then(() => null, error => error);
  check("After appending a line to myplug.py, start rejects with B3_PLUGIN_INTEGRITY_FAILED (plugin myplug)", blocked?.code === "B3_PLUGIN_INTEGRITY_FAILED" && blocked.blockers?.[0]?.plugin === "myplug", blocked ? `${blocked.code} ${JSON.stringify(blocked.blockers || [])}` : "started");
  check("The blocked start wrote no file and spawned no B3", (await readText(paths.config)) === before && (await b3Service.status(ID)).runtime.status === "STOPPED");

  // 6. The token from the plugin config never leaves the config file.
  const leak = [await readText(paths.logFile), await readText(paths.stdout), await readText(paths.stderr), JSON.stringify(audits), xml].join("\n");
  check(`The config value token = ${TOKEN} is not in b3.log, B3 stdout/stderr, b3.xml or the audit`, !leak.includes(TOKEN) && (await readText(path.join(paths.directory, "plugins", "myplug.ini"))).includes(TOKEN));
} catch (error) {
  check("Unexpected error", false, `${error.code || ""} ${error.message} ${error.output ? "\n" + error.output.slice(-1500) : ""}`);
} finally {
  if (b3Service && (await b3Service.isRunning(ID).catch(() => false))) await b3Service.stop(ID).catch(() => {});
  if (paths && checks.some(([, ok]) => !ok)) console.log(`INFO b3.log tail:\n${(await readText(paths.logFile)).split("\n").slice(-40).join("\n")}`);
  await fs.rm(root, { recursive: true, force: true });
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`4.18.21 native B3 plugins check PASS (${checks.length} checks; real Python 2.7 + eBc-B3 9096624, SQLite; no CoD4x server process)`);
