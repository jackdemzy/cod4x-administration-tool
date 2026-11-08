import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from "../lib/remote-linux-routes.mjs";
import { shellQuote, assertRemotePosixPath } from "../lib/remote-safety.mjs";

// Block 18 gate: remote Linux over SSH. The behaviour is proved by the remote test files (in-process ssh2 server
// and a loopback server on this machine); this gate runs them and checks the wiring in source. The native check
// against a real sshd and a real core is scripts/verify-4.18.23-remote-linux-native.mjs.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");
// comments do not count as code
const code = file => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const lib = fs.readdirSync(path.join(root, "lib")).filter(file => /\.(mjs|jsx)$/.test(file)).map(file => `lib/${file}`);
const remoteFiles = lib.filter(file => /^lib\/(?:remote-.*|ssh-transport)\.mjs$/.test(file));
const throws = fn => { try { fn(); return null; } catch (error) { return error.code || "THROWN"; } };

// every route the module registers, with the permission it asks for
const registered = [];
const fakeApp = {};
for (const method of ["get", "post", "put", "delete", "all"]) fakeApp[method] = (route, ...handlers) => { registered.push({ method, route, guards: handlers.slice(0, -1) }); };
// Block 18b: with an RCON service the remote RCON routes are registered too
registerRemoteLinuxRoutes({ app: fakeApp, requirePermission: permission => ({ permission }), audit() {}, hostService: {}, hostStore: {}, manager: {}, credentials: {}, rcon: {}, remoteCredentials: {}, b3: { database: {}, admin: {} } });
const bound = new Map(REMOTE_LINUX_BINDINGS.flatMap(entry => entry.routes.map(route => [route, entry.permission])));
const plain = registered.filter(entry => typeof entry.route === "string");
const exec = remoteFiles.flatMap(file => [...code(file).matchAll(/\bsession\.exec\(\s*(\w+\()?/g)].map(match => [file, match[1] ? match[1].slice(0, -1) : "<not a builder>"]));
const BUILDERS = ["probeCommand", "makeDirectoriesCommand", "startCoreCommand", "signalCommand", "getinfoProbeCommand", "diskFreeCommand", "statCommand", "recoverHomeCommand", "removeRconFilesCommand", "rconExchangeCommand", "getstatusProbeCommand"];
const transport = code("lib/ssh-transport.mjs");
const server = read("installer-server.mjs");

const checks = [
  ["ssh2 is imported in lib/ssh-transport.mjs only", lib.concat(["installer-server.mjs"]).filter(file => /from ["']ssh2["']|require\(["']ssh2["']\)/.test(code(file))).join() === "lib/ssh-transport.mjs"],
  ["no child_process in the remote modules (no local ssh client, no shell)", remoteFiles.every(file => !/child_process/.test(code(file)))],
  ["every command sent to a server is built by lib/remote-commands.mjs", exec.length >= 8 && exec.every(([, builder]) => BUILDERS.includes(builder)) && BUILDERS.every(builder => read("lib/remote-commands.mjs").includes(`export function ${builder}`) || read("lib/remote-commands.mjs").includes(`export const ${builder}`))],
  ["no password, agent or keyboard-interactive login in the transport", !/\bpassword\s*:|\bagent\s*:|tryKeyboard|keyboard-interactive/.test(transport) && /privateKey/.test(transport)],
  ["host key is checked before authentication (sha256 hash, async verifier)", /hostHash:\s*["']sha256["']/.test(transport) && /hostVerifier/.test(transport)],
  ["no remote route is registered without requirePermission", registered.length >= 25 && registered.every(entry => entry.guards.length === 1 && typeof entry.guards[0].permission === "string")],
  ["every remote route is in the permission map with the same permission", plain.every(entry => bound.get(`${entry.method.toUpperCase()} ${entry.route}`) === entry.guards[0].permission) && [...bound.keys()].every(key => plain.some(entry => `${entry.method.toUpperCase()} ${entry.route}` === key))],
  ["the permission map is part of the server's table", server.includes("...REMOTE_LINUX_BINDINGS") && server.includes("registerRemoteLinuxRoutes(")],
  ["B3 runtime for a remote id is blocked with a named code; RCON has its own guarded routes (Block 18b)", registered.filter(entry => entry.method === "all").length === 1 && read("lib/remote-linux-routes.mjs").includes("REMOTE_B3_UNSUPPORTED") && registered.some(entry => entry.route === "/api/remote-instances/:id/rcon/command")],
  ["the phone gateway does not know any remote Linux route", !/remote-hosts|remote-instances/.test(read("lib/remote-gateway.mjs"))],
  ["root login is refused when a host is saved and again at connect", read("lib/remote-safety.mjs").includes("root") && read("lib/remote-host-service.mjs").includes("REMOTE_ROOT_BLOCKED")],
  ["the SSH key lives in the vault only (subject ssh_<hostId>, runtime scope)", read("lib/remote-host-service.mjs").includes("withRuntimeCredentials") && read("lib/instance-credential-service.mjs").includes("ssh_")],
  ["quoting and path rules hold", throws(() => assertRemotePosixPath("/srv/../etc")) === "REMOTE_PATH_INVALID" && throws(() => assertRemotePosixPath("/a\nb")) === "REMOTE_PATH_INVALID" && shellQuote("a'b") === "'a'\\''b'"],
  ["the panel is wired into the app", read("cod4x-control-improved.jsx").includes("<RemoteHostsPanel") && !/type="password"[^>]*name="password"/.test(read("lib/remote-hosts.jsx"))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

// Behaviour. The summary line is "# pass N" (TAP) or "ℹ pass N" (spec reporter, the default on newer Node versions).
const files = ["remote-safety", "remote-host-store", "ssh-transport", "remote-credentials", "remote-host-service", "remote-commands", "remote-linux-runtime", "remote-instance-store", "remote-files", "remote-basegame", "remote-instance-install", "remote-runtime-state", "remote-instance-runtime", "remote-instance-files", "remote-linux-http", "remote-hosts"].map(name => `test/${name}.test.mjs`);
const run = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8" });
const summary = Object.fromEntries([...run.stdout.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
// the loopback tests need Linux; elsewhere they skip, but the Linux run must not skip anything
const complete = run.status === 0 && summary.fail === 0 && (process.platform === "linux" ? summary.pass >= 140 && summary.skipped === 0 : summary.pass >= 40);
console.log(`${complete ? "PASS" : "FAIL"} remote Linux tests (${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? "?"} skipped)`);
if (!complete) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(1); }
console.log("4.18.23 remote Linux gate PASS (in-process ssh2 server and loopback server; the native check against a real sshd and core is separate)");
