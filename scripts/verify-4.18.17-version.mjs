import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const info = JSON.parse(fs.readFileSync(path.join(root, "BUILD_INFO.json"), "utf8"));
const build = fs.readFileSync(path.join(root, "build.ps1"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const checks = [
  ["package.json version", pkg.version === "4.18.17"],
  ["preflight script", pkg.scripts?.preflight === "node scripts/preflight-4.18.17.mjs"],
  ["BUILD_INFO version", info.version === "4.18.17"],
  ["package-lock.json version", lock.version === "4.18.17" && lock.packages?.[""]?.version === "4.18.17"],
  ["BUILD_INFO validation", info.validation === "preflight-4.18.17"],
  ["build.ps1 banner", build.includes("COD4X CONTROL 4.18.17 - Windows Build")],
  ["build.ps1 installer path", build.includes("COD4X-CONTROL-Setup-4.18.17-x64.exe")],
  ["README current runtime note", readme.includes("## 4.18.17 Runtime Update note")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.17 version consistency PASS");
