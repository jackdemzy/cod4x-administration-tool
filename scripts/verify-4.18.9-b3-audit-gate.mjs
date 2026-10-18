import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { B3_DEPENDENCY_MATRIX, B3_SOURCE, evaluateB3Dependencies, inspectB3Source } from "../lib/b3-dependencies.mjs";

// Block 11 gate: eBc-B3 audit completed + dependency matrix created.
// Checks the audit report, the machine-readable matrix and that every roadmap
// failure case is detected. B3 is never executed. A real Python 2.7 / MySQL /
// CoD4x runtime check is Block 12/14 and remains open here.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const report = await fs.readFile("docs/EBC-B3-AUDIT.md", "utf8");
const status = (result, id) => result.results.find(item => item.id === id)?.status;
const modules = ok => Object.fromEntries(["dateutil", "pymysql", "mysql.connector", "MySQLdb", "feedparser", "requests", "paramiko", "psycopg2"].map(name => [name, { ok: ok.includes(name), version: null }]));
const python = (version, ok) => ({ version, major: Number(version.split(".")[0]), minor: Number(version.split(".")[1]), bits: 64, modules: modules(ok) });
const source = { b3Version: "1.10.10", complete: true, audited: true, authPlugin: true, destructiveSql: [], files: {} };

check("Audit report pins repository and commit", report.includes(B3_SOURCE.repository) && report.includes(B3_SOURCE.commit));
const items = ["Python-Version", "MySQL", "PyMySQL", "python-dateutil", "feedparser", "Parser", "RCON", "Log", "b3hide", "Schema", "Plugins", "Konfigurationsformat", "Startskripte"];
check("Audit covers all roadmap audit items", items.every(item => report.toLowerCase().includes(item.toLowerCase())));
check("Dependency matrix created with required/optional and evidence per row", B3_DEPENDENCY_MATRIX.length >= 13 && B3_DEPENDENCY_MATRIX.every(row => row.id && row.requirement && typeof row.required === "boolean" && row.evidence));
check("Report contains the dependency matrix", /## Dependency Matrix/.test(report) && B3_DEPENDENCY_MATRIX.filter(row => row.required).every(row => report.includes(row.component.split(" ")[0])));

check("Failure: incompatible Python version (3.x) blocks", status(evaluateB3Dependencies({ python: python("3.11.5", ["dateutil", "pymysql"]), source }), "python") === "INCOMPATIBLE");
check("Failure: outdated/missing Python dependency blocks", evaluateB3Dependencies({ python: python("2.7.18", ["pymysql"]), source }).blocking.includes("dateutil"));
check("Failure: missing DB is not assumed (NOT_CHECKED until Block 14)", status(evaluateB3Dependencies({ python: python("2.7.18", ["dateutil", "pymysql"]), source }), "mysql-server") === "NOT_CHECKED");
check("Failure: missing plugin/parser files block", status(evaluateB3Dependencies({ python: python("2.7.18", ["dateutil", "pymysql"]), source: { ...source, complete: false } }), "b3-source") === "MISSING");
check("Failure: outdated B3 API version blocks", status(evaluateB3Dependencies({ python: python("2.7.18", ["dateutil", "pymysql"]), source: { ...source, b3Version: "1.8.2" } }), "b3-source") === "INCOMPATIBLE");
check("Failure: CoD4X compatibility stays UNVERIFIED without native test", status(evaluateB3Dependencies({}), "cod4x-status") === "UNVERIFIED");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-b3-gate-"));
try {
  for (const file of Object.keys(B3_SOURCE.auditedFiles)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), "# synthetic\n"); }
  await fs.writeFile(path.join(root, "b3", "__init__.py"), "__version__ = '1.10.10'\n");
  await fs.writeFile(path.join(root, "b3", "sql", "mysql", "b3-update-ebc.sql"), "DROP TABLE IF EXISTS `player_core`;\n");
  const inspected = await inspectB3Source(root);
  const evaluated = evaluateB3Dependencies({ python: python("2.7.18", ["dateutil", "pymysql"]), source: inspected });
  check("Failure: broken/destructive SQL migration is flagged and blocked from automatic use", inspected.destructiveSql.includes("b3/sql/mysql/b3-update-ebc.sql") && evaluated.blockedSql.includes("b3/sql/mysql/b3-update-ebc.sql"));
  check("Modified source is reported as UNAUDITED, never as audited", evaluated.overall === "UNAUDITED");
} finally { await fs.rm(root, { recursive: true, force: true }); }
check("Satisfied dependencies only reach READY_FOR_RUNTIME_TEST, not 'running'", evaluateB3Dependencies({ python: python("2.7.18", ["dateutil", "pymysql"]), source }).overall === "READY_FOR_RUNTIME_TEST");

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.9 eBc-B3 Audit abgeschlossen + Dependency Matrix erstellt gate PASS (static; B3 runtime with Python 2.7 / MySQL / CoD4x remains open)");
