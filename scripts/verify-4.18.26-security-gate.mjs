import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { parseAuditReport, gateProblems } from "./security-audit-report.mjs";

// Roadmap Block 20 gate: "Security Audit ohne High/Critical Findings". The spec also blocks on
// Medium, needs every area reviewed and re-runs the regression test of every fixed finding.
const REPORT = "docs/SECURITY-AUDIT-4.18.26.md";

function fail(message) {
  console.error(`Security gate FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(REPORT)) fail(`report ${REPORT} missing`);

let report;
try {
  report = parseAuditReport(fs.readFileSync(REPORT, "utf8"));
} catch (error) {
  fail(error.code === "AUDIT_REPORT_INVALID" ? error.message : `cannot read ${REPORT}: ${error.message}`);
}

const problems = gateProblems(report, { exists: file => fs.existsSync(file) });
if (problems.length) {
  for (const problem of problems) console.error(`  ${problem}`);
  fail(`${problems.length} problem(s) in ${REPORT}`);
}

const fixed = report.findings.filter(finding => finding.status === "fixed");
const tests = [...new Set(["test/security-audit-report.test.mjs", ...fixed.flatMap(finding => finding.evidence)])];
const run = spawnSync(process.execPath, ["--test", ...tests], { encoding: "utf8" });
if (run.status !== 0) {
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  fail("a security regression test failed");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const audit = spawnSync(npm, ["audit", "--omit=dev", "--audit-level=high"], { encoding: "utf8", shell: process.platform === "win32" });
if (audit.status !== 0) {
  const output = `${audit.stdout || ""}${audit.stderr || ""}`;
  process.stdout.write(output);
  if (!/vulnerabilit|severity/i.test(output)) fail("npm audit failed (network?)");
  fail("npm audit reports a high or critical vulnerability in a production dependency");
}

console.log(`Security audit gate PASS (${report.findings.length} findings, ${fixed.length} fixed, ${tests.length} test files)`);
