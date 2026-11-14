import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const info = JSON.parse(fs.readFileSync(path.join(root, "BUILD_INFO.json"), "utf8"));
const build = fs.readFileSync(path.join(root, "build.ps1"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const checks = [
  ["package.json version", pkg.version === "4.18.31"],
  ["preflight script", pkg.scripts?.preflight === "node scripts/preflight-4.18.31.mjs"],
  ["BUILD_INFO version", info.version === "4.18.31"],
  ["package-lock.json version", lock.version === "4.18.31" && lock.packages?.[""]?.version === "4.18.31"],
  ["BUILD_INFO validation", info.validation === "preflight-4.18.31"],
  ["build.ps1 banner", build.includes("COD4X CONTROL 4.18.31 - Windows Build")],
  ["build.ps1 installer path", build.includes("COD4X-CONTROL-Setup-4.18.31-x64.exe")],
  ["build.ps1 installs dependencies before the preflight", build.indexOf("npm ci") >= 0 && build.indexOf("npm run preflight") > build.indexOf("npm ci") && build.indexOf("npm run preflight") > build.indexOf("npm install --no-audit")],
  ["build.ps1 builds the portable exe", build.includes("--win nsis portable") && build.includes("COD4X-CONTROL-Portable-4.18.31-x64.exe")],
  ["build.ps1 verifies the artifacts after the build", build.indexOf("scripts/release-verify.mjs --platform win") > build.indexOf("--win nsis portable")],
  ["README current runtime note", readme.includes("## 4.18.31 UI language note")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.31 version consistency PASS");
