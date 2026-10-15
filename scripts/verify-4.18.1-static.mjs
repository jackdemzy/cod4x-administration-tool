import fs from "node:fs";
const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
const info=JSON.parse(fs.readFileSync("BUILD_INFO.json","utf8"));
const server=fs.readFileSync("installer-server.mjs","utf8");
const ui=fs.readFileSync("cod4x-control-improved.jsx","utf8");
const checks=[
  ["package version 4.18.1",pkg.version === "4.18.1"],
  ["preflight points to 4.18.1",pkg.scripts?.preflight === "node scripts/preflight-4.18.1.mjs"],
  ["build info version 4.18.1",info.version === "4.18.1"],
  ["build info validation 4.18.1",info.validation === "preflight-4.18.1"],
  ["Windows Dedicated Core identity",server.includes('cod4x18_dedrun.exe')],
  ["Linux Dedicated Core identity",server.includes('cod4x18_dedrun')],
  ["Dedicated Core definition",server.includes('SERVER_CORE_DEFINITIONS')],
  ["iw3mp excluded from runtime core model",!server.includes('assertSafeChildPath(candidate.target, "iw3mp.exe")')],
  ["fs_basepath launch argument",server.includes('"+set","fs_basepath",filesystemBasePath')],
  ["fs_homepath launch argument",server.includes('"+set","fs_homepath",filesystemHomePath')],
  ["shell false",server.includes('shell: false')],
  ["PID guard",server.includes('taskkill.exe') && server.includes('windowsProcessInfo')],
  ["platform in UI",ui.includes('value={platform}')],
  ["Windows core UI",ui.includes('cod4x18_dedrun.exe')],
  ["Linux core UI",ui.includes('cod4x18_dedrun')],
  ["Remember-password UI",ui.includes('Passwort auf diesem Windows-Konto merken')],
  ["Remember-password login-only visibility",ui.includes('mode==="login"&&')],
  ["Remember-password availability state",ui.includes('rememberAvailable') && ui.includes('getRememberedLogin')],
  ["Runtime verifier normalizes executable to parent directory",server.includes('path.dirname(normalizedExecutable)')],
  ["Runtime verifier is used by preflight",server.includes('core=await verifiedRuntimeCoreStatus(executablePath,cod4x,platform)')],
  ["Runtime verifier is used by start",server.includes('verifiedRuntimeCoreStatus(exe,expectedCod4x,serverPlatform)')],
  ["Runtime verifier is used by adoption",server.includes('verifiedRuntimeCoreStatus(executablePath,cod4x,platform)')],
  ["Runtime config persists CoD4x version",server.includes('runtimeState.cod4x=cod4x')],
  ["Candidate platform is applied",ui.includes('setPlatform(candidatePlatform)') && ui.includes('saveConfig(path,candidate.executable,candidatePlatform,cod4x)')],
  ["Current UI version 4.18.1",ui.includes('topbar-version">4.18.1') && ui.includes('COD4X CONTROL 4.18.1')],
];
const failed=checks.filter(([,ok])=>!ok);for(const [name,ok] of checks)console.log(`${ok?'PASS':'FAIL'} ${name}`);if(failed.length)process.exit(1);
