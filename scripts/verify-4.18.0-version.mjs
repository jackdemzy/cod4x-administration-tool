import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const info=JSON.parse(fs.readFileSync(path.join(root,"BUILD_INFO.json"),"utf8"));
const checks=[
  ["package.json version", pkg.version === "4.18.0"],
  ["preflight script", pkg.scripts?.preflight === "node scripts/preflight-4.18.0.mjs"],
  ["BUILD_INFO version", info.version === "4.18.0"],
  ["BUILD_INFO validation", info.validation === "preflight-4.18.0"],
  ["build.ps1 banner", fs.readFileSync(path.join(root,"build.ps1"),"utf8").includes("COD4X CONTROL 4.18.0 - Windows Build")],
  ["build.ps1 installer path", fs.readFileSync(path.join(root,"build.ps1"),"utf8").includes("COD4X-CONTROL-Setup-4.18.0-x64.exe")],
  ["README current runtime note", fs.readFileSync(path.join(root,"README.md"),"utf8").includes("## 4.18.0 Runtime note")],
];
for (const [name,ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
const failed=checks.filter(([,ok])=>!ok);
if(failed.length) process.exit(1);
console.log("4.18.0 version consistency PASS");
