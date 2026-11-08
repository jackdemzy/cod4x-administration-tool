import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from "../lib/remote-linux-routes.mjs";
import { rconExchangeCommand, removeRconFilesCommand } from "../lib/remote-commands.mjs";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from "../lib/remote-gateway.mjs";
import { remoteSubject, isRemoteSubject } from "../lib/remote-subjects.mjs";

// Block 18b gate: remote RCON (over SSH), B3 through its database, remote servers in monitoring and phone
// actions. Behaviour is proved by the test files below (loopback server, fake CoD4x core, real services);
// this gate runs them and checks the wiring in source. The native RCON steps are part of
// scripts/verify-4.18.23-remote-linux-native.mjs.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const code = file => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const manager = code("lib/remote-instance-manager.mjs"), client = code("lib/remote-rcon-client.mjs"), server = read("installer-server.mjs");
const registered = [];
const fakeApp = {};
for (const method of ["get", "post", "put", "delete", "all"]) fakeApp[method] = (route, ...handlers) => { registered.push({ method, route, guards: handlers.slice(0, -1) }); };
registerRemoteLinuxRoutes({ app: fakeApp, requirePermission: permission => ({ permission }), audit() {}, hostService: {}, hostStore: {}, manager: {}, credentials: {}, rcon: {}, remoteCredentials: {}, b3: { database: {}, admin: {} } });
const bound = new Map(REMOTE_LINUX_BINDINGS.flatMap(entry => entry.routes.map(route => [route, entry.permission])));
const plain = registered.filter(entry => typeof entry.route === "string");
const exchange = rconExchangeCommand(28960);

const checks = [
  ["the RCON password is never a core argument: only '+exec rcon-<runId>.cfg' is added", manager.includes("...(rconFile ? ['+exec', rconFile] : [])") && !/'rcon_password'/.test(manager) && manager.includes("writeFileExclusive(`${instance.home}/main/${name}`, content, { mode: 0o600 })")],
  ["the password file is removed after the core read it and swept on start, stop, restart, recover and status", manager.includes("`execing ${name}`") && (manager.match(/#sweepRconFiles\(instance, /g) || []).length >= 6 && removeRconFilesCommand("/srv/x").includes("-name 'rcon-*.cfg'")],
  ["the RCON packet goes over stdin and is wiped; the exchange command is python3 only and holds no secret", client.includes("{ stdin: packet,") && client.includes("packet.fill(0)") && /python3/.test(exchange) && !/bash|\/dev\/udp/.test(exchange)],
  ["remote ids are rmt_<id> in the vault, monitoring and phone actions", remoteSubject("alpha") === "rmt_alpha" && isRemoteSubject("rmt_alpha") && !isRemoteSubject("alpha") && read("lib/instance-credential-service.mjs").includes("rmt_[a-z][a-z0-9-]{0,47}") && server.includes("isRemoteSubject(id) ? resolveRemoteSubject(id)") && read("lib/gateway-actions.mjs").includes("isRemoteSubject(id)")],
  ["every remote route is guarded and listed with the same permission", plain.every(entry => entry.guards.length === 1 && bound.get(`${entry.method.toUpperCase()} ${entry.route}`) === entry.guards[0].permission) && [...bound.keys()].every(key => plain.some(entry => `${entry.method.toUpperCase()} ${entry.route}` === key))],
  ["remote RCON mirrors local permissions (status and commands server.manage, online diagnostics.read)", bound.get("GET /api/remote-instances/:id/rcon") === "server.manage" && bound.get("POST /api/remote-instances/:id/rcon/command") === "server.manage" && bound.get("GET /api/remote-instances/:id/rcon/online") === "diagnostics.read"],
  ["B3 runtime stays unsupported, migration is refused, credentials are rcon and b3db only", read("lib/remote-linux-routes.mjs").includes("REMOTE_B3_UNSUPPORTED") && read("lib/remote-linux-routes.mjs").includes("REMOTE_B3_MIGRATE_UNSUPPORTED") && read("lib/remote-linux-routes.mjs").includes("const KINDS = ['rcon', 'b3db'];")],
  ["the phone gateway route list is unchanged (ids travel as parameters)", ![...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].some(route => /remote-(hosts|instances)/.test(route)) && server.includes("...createGatewayActions({ resolve: monitorInstance, audit,")],
  ["monitoring reaches remote servers without credentials, one pooled session per host", !/withRuntimeCredentials|rcon_password|credential/i.test(code("lib/remote-monitor.mjs")) && server.includes("createRemoteMonitor({ pool: remoteSessionPool,") && server.includes("new RemoteSessionPool({ connect: hostId => remoteHostService.connect(hostId) })")],
  ["the remote database form warns about cleartext and offers no migration", read("lib/instance-b3-database.jsx").includes("in clear text unless a VPN or Tailscale connection is used") && read("lib/instance-b3-database.jsx").includes("{!remote && <>")],
  ["cod4-monitor is credited", read("docs/superpowers/specs/2026-11-08-remote-rcon-b3-design.md").includes("cod4-monitor") && read("CHANGELOG-4.18.24.md").includes("cod4-monitor")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

// The summary line is "# pass N" (TAP) or "ℹ pass N" (spec reporter, the default on newer Node versions).
const files = ["remote-session-pool", "ssh-transport", "remote-commands", "remote-rcon-client", "remote-subjects", "remote-instance-runtime", "remote-rcon-routes", "remote-rcon-service",
  "remote-b3-routes", "remote-b3-service", "remote-monitor", "gateway-actions", "remote-hosts", "remote-linux-http", "instance-rcon-console", "instance-online-players", "instance-b3-database", "instance-b3-admin", "instance-credential-editor", "monitor"].map(name => `test/${name}.test.mjs`);
const run = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8" });
const summary = Object.fromEntries([...run.stdout.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
const complete = run.status === 0 && summary.fail === 0 && (process.platform === "linux" ? summary.pass >= 160 && summary.skipped === 0 : summary.pass >= 60);
console.log(`${complete ? "PASS" : "FAIL"} remote RCON and B3 tests (${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? "?"} skipped)`);
if (!complete) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(1); }
console.log("4.18.24 remote RCON and B3 gate PASS (loopback server and fake core; the native RCON steps run in the native remote Linux check)");
