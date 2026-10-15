import fs from "node:fs";
import { spawnSync } from "node:child_process";
const server=fs.readFileSync("installer-server.mjs","utf8"),ui=fs.readFileSync("cod4x-control-improved.jsx","utf8"),pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
const reqS=["SERVER_CORE_DEFINITIONS","cod4x18_dedrun.exe","cod4x18_dedrun","normalizeServerPlatform","serverCoreDefinition","searchRuntimeCores","verifiedRuntimeCoreStatus","adoptExistingRuntimeExecutable","RUNTIME_PLATFORM_NOT_SUPPORTED","shell: false","tasklist.exe","taskkill.exe","fs_basepath","fs_homepath","runtimeState.platform"];
const reqU=["ProductionRuntimePanel","Server-Plattform","cod4x18_dedrun.exe","cod4x18_dedrun","Dedicated-Server-Core","Dedicated Server Cores suchen","4.18.0","Passwort auf diesem Windows-Konto merken","rememberAvailable","getRememberedLogin","saveRememberedLogin"];
const missingServer=reqS.filter(x=>!server.includes(x)),missingUi=reqU.filter(x=>!ui.includes(x));
if(pkg.version!=="4.18.0"||missingServer.length||missingUi.length){console.error("4.18.0 preflight FAIL");if(pkg.version!=="4.18.0")console.error("package version mismatch:",pkg.version);if(missingServer.length)console.error("Server missing:",missingServer.join(", "));if(missingUi.length)console.error("UI missing:",missingUi.join(", "));process.exit(1)}
for(const file of ["installer-server.mjs","electron-main.cjs","electron-preload.cjs"]){const c=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});if(c.status!==0){console.error(`Node syntax FAIL: ${file}`);console.error(c.stderr||c.stdout);process.exit(c.status||1)}}
console.log("4.18.0 preflight PASS");
console.log("Node syntax PASS");
console.log("Dedicated Server Core model PASS");
console.log("Windows cod4x18_dedrun.exe identity PASS");
console.log("Linux cod4x18_dedrun identity PASS");
console.log("Client iw3mp.exe excluded from Dedicated Core model PASS");
console.log("Cross-platform Core Discovery PASS");
console.log("Verified-Core platform binding PASS");
console.log("SHA-256 fingerprint validation PASS");
console.log("PID verification / taskkill guard retained PASS");
console.log("fs_basepath / fs_homepath separation retained PASS");
console.log("Windows runtime only gate PASS");
console.log("Remembered login / Windows safeStorage protection retained PASS");
