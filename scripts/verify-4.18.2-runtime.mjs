import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "installer-server.mjs"), "utf8") + fs.readFileSync(path.join(root, "lib/runtime-manager.mjs"), "utf8");
const ui = fs.readFileSync(path.join(root, "cod4x-control-improved.jsx"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const info = JSON.parse(fs.readFileSync(path.join(root, "BUILD_INFO.json"), "utf8"));

const checks = [
  ["package version is 4.18.2", pkg.version === "4.18.2"],
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
  ["UI identifies 4.18.2", ui.includes('topbar-version">4.18.2') && ui.includes('COD4X CONTROL 4.18.2')],
  ["build metadata identifies Block 4", info.version === "4.18.2" && info.validation === "preflight-4.18.2" && info.architecture === "Windows Dedicated Runtime"],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.2 Windows runtime regression checks PASS");
