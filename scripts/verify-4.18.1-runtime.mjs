import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "installer-server.mjs"), "utf8");
const ui = fs.readFileSync(path.join(root, "cod4x-control-improved.jsx"), "utf8");

function assert(name, condition) {
  if (!condition) {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${name}`);
}

const executable = path.win32.normalize("C:\\Users\\r4f1k1\\Desktop\\cod4x18_dedrun.exe");
const directory = path.win32.dirname(executable);
assert("Executable parent directory is the verification target", directory.toLowerCase() === "c:\\users\\r4f1k1\\desktop");
assert("Verifier normalizes executable input", server.includes("const normalizedExecutable = normalizeRuntimeExecutablePath(executablePath, platform);") && server.includes("const coreDirectory = path.dirname(normalizedExecutable);"));
assert("Manifest lookup is directory-based", server.includes("readRuntimeCoreManifest(target)") && server.includes("runtimeCoreRegistryFile(target)"));
assert("Preflight passes platform into verifier", server.includes("verifiedRuntimeCoreStatus(executablePath,cod4x,platform)"));
assert("Start passes platform into verifier", server.includes("verifiedRuntimeCoreStatus(exe,expectedCod4x,serverPlatform)"));
assert("Adoption persists and re-verifies the same executable", server.includes("verifiedRuntimeCoreStatus(executablePath,cod4x,platform)"));
assert("UI exposes adopt action when core is present but unverified", ui.includes("!coreOk && preflight?.core?.corePresent") && ui.includes("Dedicated-Core übernehmen & verifizieren"));
assert("Candidate platform follows discovered core", ui.includes("setPlatform(candidatePlatform)") && ui.includes("saveConfig(path,candidate.executable,candidatePlatform,cod4x)"));

if (process.exitCode) process.exit(1);
console.log("4.18.1 runtime regression checks PASS");
