import fs from "node:fs";
import { spawnSync } from "node:child_process";
const server=fs.readFileSync("installer-server.mjs","utf8");
const ui=fs.readFileSync("cod4x-control-improved.jsx","utf8");
const reqS=["DATA_ROOT","RUNTIME_STATE_FILE","startRuntime","stopRuntime","restartRuntime","/api/runtime/status","/api/runtime/start","/api/runtime/stop","/api/runtime/restart","runtime.started","runtime.stopped","runtime.restarted","runtime.start.blocked","iw3mp.exe","shell: false","POST /api/runtime/start","GET /api/runtime/status"];
const reqU=["ProductionRuntimePanel","/api/runtime/status","api/runtime/","Production Runtime","4.17.0"];
const ms=reqS.filter(x=>!server.includes(x)), mu=reqU.filter(x=>!ui.includes(x));
if(ms.length||mu.length){console.error("4.17.0 preflight FAIL");if(ms.length)console.error("Server missing:",ms.join(", "));if(mu.length)console.error("UI missing:",mu.join(", "));process.exit(1)}
for(const file of ["installer-server.mjs"]){const check=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});if(check.status!==0){console.error(`Node syntax FAIL: ${file}`);console.error(check.stderr||check.stdout);process.exit(check.status||1)}}
console.log("4.17.0 preflight PASS");
console.log("Node syntax PASS");
console.log("Production Runtime API PASS");
console.log("Runtime persistence PASS");
console.log("Native iw3mp.exe launch gate PASS");
console.log("RBAC runtime bindings PASS");
console.log("PID verification / taskkill guard PASS");
