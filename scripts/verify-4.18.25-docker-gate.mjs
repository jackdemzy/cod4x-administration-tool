import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from "../lib/remote-linux-routes.mjs";
import { runContainerCommand, imageBuildCommand, stopContainerCommand, removeContainerCommand } from "../lib/docker-commands.mjs";
import { DOCKERFILE, DOCKERFILE_SHA256, IMAGE_TAG } from "../lib/docker-image.mjs";
import { DOCKER_ROOTFUL_CONFIRMATION } from "../lib/remote-host-service.mjs";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from "../lib/remote-gateway.mjs";

// Block 19 gate: Linux Docker deployment for servers on SSH hosts. Behaviour is proved by the test files below
// (loopback server, a scripted docker, a stand-in core; and a real Docker daemon where one answers); this gate
// runs them and checks the wiring in source. The run against a real sshd, a real daemon and a real core is
// scripts/verify-4.18.25-docker-native.mjs.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const code = file => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const lib = fs.readdirSync(path.join(root, "lib")).filter(file => /\.(mjs|jsx)$/.test(file));
const ID = "c".repeat(64);
const line = runContainerCommand({ instanceId: "alpha", runId: "123e4567-e89b-42d3-a456-426614174000", image: `sha256:${"a".repeat(64)}`, user: "1000:1000", basePath: "/srv/game", home: "/srv/cod4x/alpha", port: 28960, publish: ["127.0.0.1"], args: ["+set", "dedicated", "2"] });
const registered = [];
const fakeApp = {};
for (const method of ["get", "post", "put", "delete", "all"]) fakeApp[method] = (route, ...handlers) => { registered.push({ method, route, guards: handlers.slice(0, -1) }); };
registerRemoteLinuxRoutes({ app: fakeApp, requirePermission: permission => ({ permission }), audit() {}, hostService: {}, hostStore: {}, manager: {}, credentials: {}, rcon: {}, remoteCredentials: {}, b3: { database: {}, admin: {} } });
const bound = new Map(REMOTE_LINUX_BINDINGS.flatMap(entry => entry.routes.map(route => [route, entry.permission])));
const plain = registered.filter(entry => typeof entry.route === "string");
const manager = code("lib/remote-instance-manager.mjs"), runtime = code("lib/remote-container-runtime.mjs"), hosts = code("lib/remote-host-service.mjs"), panel = read("lib/remote-hosts.jsx");

const checks = [
  ["lib/docker-commands.mjs is the only place that writes a docker command line", lib.filter(file => /(^|[`'" (])docker (run|build|stop|rm|logs|info|image|container|exec|pull|compose) /m.test(code(`lib/${file}`))).join() === "docker-commands.mjs"],
  ["the container is restricted: read-only root, no capabilities, no new privileges, limits, never restarted by Docker", ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256", "--memory 1g", "--restart no", "--network bridge"].every(flag => line.includes(flag))],
  ["nothing that widens the container can be on the run line", !/--privileged|--cap-add|--network host|--net[= ]host|--pid[= ]|--device|--volume|-v |docker\.sock|--env|-e /.test(line)],
  ["base game and core are mounted read-only, only the instance home is writable", (line.match(/,readonly'/g) || []).length === 3 && (line.match(/--mount /g) || []).length === 4 && line.includes("source=/srv/cod4x/alpha,target=/cod4/home'")],
  ["the game port is published on the address given, UDP and TCP, nothing else", (line.match(/--publish /g) || []).length === 2 && line.includes("--publish 127.0.0.1:28960:28960/udp")],
  ["the image is built from a fixed Dockerfile on stdin without a build context, base pinned by digest", /^FROM i386\/debian:bookworm-slim@sha256:[a-f0-9]{64}\n/.test(DOCKERFILE) && imageBuildCommand({ tag: IMAGE_TAG, dockerfileSha256: DOCKERFILE_SHA256 }).endsWith(" -") && IMAGE_TAG.endsWith(DOCKERFILE_SHA256.slice(0, 16))],
  ["a container is stopped and removed by its ID only", stopContainerCommand(ID, 10) === `docker stop --time 10 ${ID}` && removeContainerCommand(ID) === `docker rm ${ID}` && !/rm --force|rm -f|kill/.test(code("lib/docker-commands.mjs"))],
  ["a container whose name or labels are not this instance's is never acted on", runtime.includes("container.name === containerName(instance.id) && container.instance === instance.id") && runtime.includes("fail('INSTANCE_PROCESS_IDENTITY_BLOCKED')")],
  ["the docker group needs the typed word per host; the mode is what the host shows", DOCKER_ROOTFUL_CONFIRMATION === "DOCKER_ROOT_EQUIVALENT" && hosts.includes("mode === 'ROOTFUL' && input?.confirm !== DOCKER_ROOTFUL_CONFIRMATION") && hosts.includes("REMOTE_DOCKER_MODE_CHANGED") && panel.includes("word !== DOCKER_CONFIRM_WORD")],
  ["a start checks the confirmed host and the current image before any state is written", manager.includes("assertDockerReady(") && hosts.includes("REMOTE_DOCKER_IMAGE_MISSING")],
  ["the deployment changes only while the instance is stopped", manager.includes("fail('REMOTE_INSTANCE_RUNNING')") && manager.includes("'remote.instance.deployment_changed'")],
  ["every remote route is guarded and listed with the same permission; Docker changes need server.manage", plain.every(entry => entry.guards.length === 1 && bound.get(`${entry.method.toUpperCase()} ${entry.route}`) === entry.guards[0].permission) && ["POST /api/remote-hosts/:id/docker/confirm", "POST /api/remote-hosts/:id/docker/image", "POST /api/remote-instances/:id/deployment"].every(route => bound.get(route) === "server.manage") && bound.get("GET /api/remote-hosts/:id/docker") === "diagnostics.read"],
  ["no Docker route is offered to the phone gateway", ![...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].some(route => /docker|deployment/.test(route))],
  ["RCON and monitoring treat a running container like a running process", read("lib/instance-rcon-service.mjs").includes("runtimeState.pid || runtimeState.containerId") && read("lib/monitor-collector.mjs").includes("state.pid || state.containerId")],
  ["the panel warns about root equivalence, rootless source addresses and ufw", panel.includes("equivalent to root on this host") && panel.includes("real source address of players") && panel.includes("bypass ufw")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

// The summary line is "# pass N" (TAP) or "ℹ pass N" (spec reporter, the default on newer Node versions).
const summaryOf = run => Object.fromEntries([...run.stdout.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
const files = ["docker-commands", "docker-image", "remote-host-store", "remote-instance-store", "remote-runtime-state", "remote-host-docker", "remote-docker-runtime", "remote-docker-switch", "remote-docker-routes", "remote-hosts", "remote-rcon-service", "monitor"].map(name => `test/${name}.test.mjs`);
const run = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8" });
const summary = summaryOf(run);
const complete = run.status === 0 && summary.fail === 0 && (process.platform === "linux" ? summary.pass >= 95 && summary.skipped === 0 : summary.pass >= 40);
console.log(`${complete ? "PASS" : "FAIL"} Docker deployment tests (${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? "?"} skipped)`);
if (!complete) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(1); }

// The roadmap gate itself: once with the scripted docker (always on Linux), once against a real daemon.
const gate = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/remote-docker-gate.test.mjs", "test/remote-docker-real.test.mjs"], { encoding: "utf8" });
const result = name => { const match = new RegExp(`^(not ok|ok) \\d+ - ${name}( # SKIP ?(.*))?$`, "m").exec(gate.stdout); return !match ? "MISSING" : match[1] !== "ok" ? "FAIL" : match[2] ? `SKIP ${match[3] || ""}`.trim() : "PASS"; };
const scripted = result("gate: Container Restart ohne Datenverlust \\(scripted docker\\)");
const real = result("gate: Container Restart ohne Datenverlust \\(real Docker daemon\\)");
const gateSummary = summaryOf(gate);
if (gate.status !== 0 || gateSummary.fail !== 0 || (process.platform === "linux" ? scripted !== "PASS" : !/^(PASS|SKIP)/.test(scripted)) || !/^(PASS|SKIP)/.test(real)) {
  process.stdout.write(gate.stdout); process.stderr.write(gate.stderr);
  console.log(`FAIL Container Restart ohne Datenverlust (scripted docker: ${scripted}, real daemon: ${real})`);
  process.exit(1);
}
console.log(scripted === "PASS" ? "Container Restart ohne Datenverlust PASS (scripted docker, stand-in core)" : `Container Restart ohne Datenverlust ${scripted}`);
console.log(real === "PASS" ? `REAL DOCKER PASS (local daemon, stand-in core)` : `REAL DOCKER SKIP (${real.replace(/^SKIP ?/, "") || "no Docker daemon"})`);
console.log("4.18.25 Docker deployment gate PASS (the run against a real sshd, daemon and core is scripts/verify-4.18.25-docker-native.mjs)");
