import fs from "node:fs";

// 4.18.17 gate: supported runtimes. Electron 42 left support on 2026-10-20
// (releases.electronjs.org/schedule); the backend and the remote gateway run on
// Electron's own Node (ELECTRON_RUN_AS_NODE), so the Electron line decides which
// Node and Chromium security fixes reach users. Node 20 left support on
// 2026-04-30 (github.com/nodejs/Release). Checked from the lockfile and sources.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const main = read("electron-main.cjs");
const ci = read(".github/workflows/ci.yml");
const build = read("build.ps1");
const major = version => Number(String(version || "").split(".")[0]);
const locked = name => lock.packages?.[`node_modules/${name}`]?.version;

const checks = [
  ["Electron is 45 or newer (42 is end-of-life since 2026-10-20)", major(locked("electron")) >= 45 && /^~45\.|^\^45\./.test(pkg.devDependencies?.electron || "")],
  ["the backend still runs on Electron's own Node", main.includes("ELECTRON_RUN_AS_NODE:'1'") && main.includes("spawn(process.execPath,[serverPath]")],
  ["window keeps contextIsolation, sandbox and no nodeIntegration", main.includes("contextIsolation:true,nodeIntegration:false,sandbox:true")],
  ["remembered login uses the asynchronous safeStorage API only", ["isAsyncEncryptionAvailable()", "encryptStringAsync(", "decryptStringAsync("].every(text => main.includes(text)) && !/safeStorage\.(isEncryptionAvailable|encryptString|decryptString)\(/.test(main)],
  ["Node.js minimum is 22.12 (package engines and build.ps1)", pkg.engines?.node === ">=22.12" && build.includes("a>22||(a===22&&b>=12)") && !/Node\.js 20\+/.test(build)],
  ["CI tests Node 22 and 24", /node: \[22, 24\]/.test(ci) && ci.includes("node-version: ${{ matrix.node }}")],
  ["express, react and electron-builder are on the reviewed versions", locked("express") === "5.3.0" && locked("react") === "19.3.1" && locked("react-dom") === "19.3.1" && major(locked("electron-builder")) === 26],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.17 runtime update gate PASS (Electron 45, Node >= 22.12)");
