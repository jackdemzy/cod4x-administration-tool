import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "installer-server.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/runtime-manager.mjs"), "utf8");
const ui = fs.readFileSync(path.join(root, "cod4x-control-improved.jsx"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const info = JSON.parse(fs.readFileSync(path.join(root, "BUILD_INFO.json"), "utf8"));
const configEngine = fs.readFileSync(path.join(root, "lib/config-engine.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/server-instance-manager.mjs"), "utf8");
const editor = fs.readFileSync(path.join(root, "lib/instance-config-editor.jsx"), "utf8");
const vault = fs.readFileSync(path.join(root, "lib/credential-vault-storage.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/instance-credential-service.mjs"), "utf8");
const instanceManager = fs.readFileSync(path.join(root, "lib/server-instance-manager.mjs"), "utf8");
const runtimeManager = fs.readFileSync(path.join(root, "lib/runtime-manager.mjs"), "utf8");
const rcon = fs.readFileSync(path.join(root, "lib/rcon-protocol.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/rcon-client.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/instance-rcon-service.mjs"), "utf8");
const consoleUi = fs.readFileSync(path.join(root, "lib/instance-rcon-console.jsx"), "utf8");

const checks = [
  ["package version is 4.18.6", pkg.version === "4.18.6"],
  ["Windows core is cod4x18_dedrun.exe", server.includes('executable: "cod4x18_dedrun.exe"')],
  ["iw3mp.exe is not a Dedicated Core", !server.includes('assertSafeChildPath(candidate.target, "iw3mp.exe")')],
  ["fs_basepath is managed", server.includes('"+set","fs_basepath",filesystemBasePath')],
  ["fs_homepath is managed", server.includes('"+set","fs_homepath",filesystemHomePath')],
  ["filesystem overrides are blocked", server.includes('RUNTIME_FILESYSTEM_OVERRIDE_BLOCKED')],
  ["Windows spawn keeps shell disabled", server.includes('shell: false')],
  ["runtime has piped Windows output and early monitoring", server.includes('["ignore", "pipe", "pipe"]') && server.includes('monitorRuntimeChild(child, exe')],
  ["runtime output is bounded", server.includes('RUNTIME_OUTPUT_MAX_BYTES') && server.includes('appendRuntimeOutput')],
  ["spawn PID is verified", server.includes('waitForRuntimeProcess(child.pid') && server.includes('RUNTIME_PID_VERIFICATION_FAILED')],
  ["PID verification checks executable path", server.includes('Get-CimInstance Win32_Process') && server.includes('sameWindowsPath(info.executablePath, expectedPath)')],
  ["stop verifies the process is gone", server.includes('RUNTIME_STOP_VERIFICATION_FAILED') && server.includes('requireGone:true')],
  ["stop attempts non-forced termination before forced fallback", server.includes('["/PID",String(pid),"/T"]') && server.includes('["/PID",String(pid),"/T","/F"]')],
  ["Linux adapter preserves shared lifecycle", server.includes('linuxRuntimeAdapter') && server.includes('RUNTIME_PLATFORM_NOT_SUPPORTED') && !server.includes('Linux Runtime wird erst in Block 5 aktiviert.')],
  ["UI identifies 4.18.6", ui.includes('topbar-version">4.18.6') && ui.includes('COD4X CONTROL 4.18.6')],
  ["build metadata identifies Block 8", info.version === "4.18.6" && info.validation === "preflight-4.18.6" && info.block === "Master Server + Token"],
  ["master token is passed as sv_authtoken inside the credential scope", fs.readFileSync(path.join(root, "lib/server-instance-manager.mjs"), "utf8").includes("secrets.push('+set', 'sv_authtoken', masterLaunchValue(credentials.master))")],
  ["master status uses the CoD4x messages and reports loopback", fs.readFileSync(path.join(root, "lib/instance-master-service.mjs"), "utf8").includes("sv_authtoken is invalid") && fs.readFileSync(path.join(root, "lib/instance-master-service.mjs"), "utf8").includes("LOOPBACK_BINDING")],
  ["master route and token audit are wired", server.includes('"/api/instances/:id/master"') && server.includes('"master.token.configured"') && server.includes('"master.token.removed"')],
  ["config sections cover Block 6 areas", configEngine.includes("export const CONFIG_SECTIONS") && configEngine.includes("'credential-vault'")],
  ["launch records config activation", configEngine.includes("recordConfigActivation(instance, { sha256: configuration.sha256")],
  ["config changes have value-free audit events", server.includes('auditConfigChange("config.change.applied"') && server.includes('auditConfigChange("config.change.restored"')],
  ["config editor shows a readable diff", editor.includes("ConfigDiffTable") && !editor.includes("JSON.stringify(preview.diff")],
  ["vault self-lock revokes runtime credential scope", vault.includes("this.#onLock?.()") && vault.includes("onLock: () => this.#revokeRuntimeLease()")],
  ["RCON password is read only inside the runtime credential scope", instanceManager.includes("this.credentialService.withRuntimeCredentials(id") && rcon.includes("this.#credentials.withRuntimeCredentials(id") && !/.resolve(id, 'rcon')/.test(instanceManager + rcon)],
  ["RCON password reaches the core as +set rcon_password before server.cfg", instanceManager.includes("secrets.push('+set', 'rcon_password', rconLaunchValue(credentials.rcon))") && instanceManager.includes("start([...network, ...secrets, ...tail])")],
  ["runtime history and output redact secret CVARs", runtimeManager.includes("args:redactRuntimeArguments(launchArgs)") && runtimeManager.includes("process:redactProcessInfo(processCheck.info)") && runtimeManager.includes("redactRuntimeOutput(")],
  ["RCON targets loopback instance port only", rcon.includes("if (host !== '127.0.0.1') fail('RCON_TARGET_INVALID')") && rcon.includes("host: '127.0.0.1', port: instance.port")],
  ["RCON command allowlist", rcon.includes("export function normalizeRconCommand") && rcon.includes("fail('RCON_COMMAND_BLOCKED')")],
  ["RCON audit events wired", server.includes("new InstanceRconService(") && server.includes("credentialService, audit })") && ["'rcon.command'", "'rcon.login'", "'rcon.failure'"].every(name => rcon.includes(name))],
  ["RCON routes require server.manage", server.includes('app.post("/api/instances/:id/rcon/command", requirePermission("server.manage")') && server.includes('app.post("/api/instances/:id/rcon/connect", requirePermission("server.manage")')],
  ["integrated console has history, reconnect, export and no password field", ui.includes("<InstanceRconConsole") && consoleUi.includes("commandHistory") && consoleUi.includes("Reconnect") && consoleUi.includes("buildConsoleExport") && !consoleUi.includes('type="password"')],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.6 runtime, config engine and RCON regression checks PASS");
