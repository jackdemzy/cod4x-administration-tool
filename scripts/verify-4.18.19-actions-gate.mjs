import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTION_MAX_PER_WINDOW, RESTART_COOLDOWN_MS, RemoteActionGuard, STEP_UP_MS } from "../lib/remote-actions.mjs";
import { buildSayPacket, validSayText } from "../lib/rcon-protocol.mjs";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES, createRemoteGateway, listenRemoteGateway } from "../lib/remote-gateway.mjs";
import { RemoteSessions } from "../lib/remote-sessions.mjs";
import { LoginThrottle } from "../lib/login-throttle.mjs";

// Block 24d gate: remote actions (say, kick, restart). Off by default; need the
// gateway switch, the user's switch, server.manage and an MFA session; a fresh
// TOTP code opens 5 minutes, restart always needs its own code, a recovery code
// never counts; 10 actions / 5 min per session, one restart / 2 min per server;
// the say text cannot carry a second command; everything is audited. Behaviour
// is exercised directly; wiring is checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs"), gatewaySource = read("lib/remote-gateway.mjs"), app = read("lib/remote-app.jsx");
const throws = (fn, code) => { try { fn(); return false; } catch (error) { return error.code === code; } };

let clock = 0;
const guard = new RemoteActionGuard({ now: () => clock });
const noStepUp = throws(() => guard.check("s", "say", "a"), "REMOTE_STEP_UP_REQUIRED");
guard.grant("s");
const windowOpen = !throws(() => guard.check("s", "kick", "a"), "REMOTE_STEP_UP_REQUIRED");
const restartOwnCode = throws(() => guard.check("s", "restart", "a"), "REMOTE_STEP_UP_REQUIRED");
clock = STEP_UP_MS;
const windowCloses = throws(() => guard.check("s", "say", "a"), "REMOTE_STEP_UP_REQUIRED");
guard.record("s", "restart", "a");
const cooldown = throws(() => guard.check("s", "restart", "a", { freshCode: true }), "REMOTE_RESTART_COOLDOWN");
clock += RESTART_COOLDOWN_MS; guard.grant("t");
for (let i = 0; i < ACTION_MAX_PER_WINDOW; i++) guard.record("t", "say", "a");
const limit = throws(() => guard.check("t", "say", "a"), "REMOTE_ACTION_LIMIT");

const sayRejects = ['x"; quit', "a;b", "%s", "a/b", "a\\b", "line\nbreak", "x".repeat(151), ""].every(text => throws(() => validSayText(text), "RCON_SAY_INVALID"));
const sayPacket = buildSayPacket(Buffer.from("gatepass"), "hello").subarray(4).toString("ascii") === "rcon gatepass say hello";

// A real gateway: no switch, no action; a recovery code never opens the window.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cod4x-actions-gate-"));
const ran = [];
let allowed = false;
const used = new Set();
const gateway = createRemoteGateway({
  login: async ({ password }) => password === "gate-password-123" ? { username: "op", role: "operator", remoteAccess: true, totpEnabled: true } : null,
  verifySecondFactor: async (username, code, { totpOnly = false } = {}) => code === "RECOVERY" ? { ok: !totpOnly, method: "recovery" } : /^\d{6}$/.test(code) && !used.has(code) ? (used.add(code), { ok: true, method: "totp" }) : { ok: false },
  hasPermission: (role, permission) => ["monitor.read", "server.manage"].includes(permission),
  monitor: { overview: async () => ({ instances: [] }), history: async () => ({}), events: async () => ({ events: [] }) },
  sessions: new RemoteSessions(), throttle: new LoginThrottle(), staticDir: dir,
  actions: { allowed: () => allowed, players: async () => ({ players: [] }), say: async id => { ran.push(id); return {}; }, kick: async id => { ran.push(id); return {}; }, restart: async id => { ran.push(id); return {}; } },
});
const listener = await listenRemoteGateway(gateway, { host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = async (route, body, cookie) => { const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { status: response.status, json: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] }; };
const { cookie } = await post("/remote/api/login", { username: "op", password: "gate-password-123", code: "111111" });
const offRefused = (await post("/remote/api/instances/a/say", { text: "x", code: "222222" }, cookie)).json.code === "REMOTE_ACTIONS_DISABLED";
allowed = true;
const recoveryRefused = (await post("/remote/api/instances/a/say", { text: "x", code: "RECOVERY" }, cookie)).json.code === "REMOTE_STEP_UP_INVALID";
const replayRefused = (await post("/remote/api/instances/a/say", { text: "x", code: "111111" }, cookie)).json.code === "REMOTE_STEP_UP_INVALID";
const withoutCode = (await post("/remote/api/instances/a/kick", { slot: 1, name: "x" }, cookie)).json.code === "REMOTE_STEP_UP_REQUIRED";
const nothingRan = ran.length === 0;
const withCode = (await post("/remote/api/instances/a/say", { text: "x", code: "333333" }, cookie)).status === 200 && ran.length === 1;
await new Promise(resolve => listener.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });

const checks = [
  ["step-up: no action without a fresh code; 5-minute window; restart always with its own code", noStepUp && windowOpen && restartOwnCode && windowCloses && STEP_UP_MS === 5 * 60e3],
  ["limits: 10 actions per session in 5 minutes, one restart per server in 2 minutes", limit && cooldown && ACTION_MAX_PER_WINDOW === 10 && RESTART_COOLDOWN_MS === 2 * 60e3],
  ["gateway: switch off refuses, recovery code and replayed code refused, nothing runs before the step-up", offRefused && recoveryRefused && replayRefused && withoutCode && nothingRan && withCode],
  ["recovery codes never authorise an action (totpOnly in the backend)", server.includes("if (totpOnly) return { ok: false };") && gatewaySource.includes("verifySecondFactor(req.remote.username, code, { totpOnly: true })")],
  ["say text cannot carry a second command (no quote, ;, %, /, \\, line break; 1-150 ASCII)", sayRejects && sayPacket],
  ["only say, kick and restart are new writes; no free RCON, start, stop, config or vault", REMOTE_WRITE_ROUTES.length === 8 && REMOTE_ROUTES.filter(route => route.startsWith("POST")).join() === REMOTE_WRITE_ROUTES.join() && !REMOTE_ROUTES.some(route => /rcon|\/start|\/stop|config|vault|credential|users/.test(route)) && !/\/rcon\/|\/stop|\/start/.test(app)],
  ["needs server.manage, an MFA session, the gateway switch and the user's switch; both off by default", gatewaySource.includes("remote.mfa && hasPermission(remote.role, 'server.manage')") && server.includes("remoteState.settings.actions && user && !user.disabled && user.remoteAccess === true && user.remoteActions === true && hasPermission(user.role, \"server.manage\")") && server.includes("proxyDomain: null, actions: false") && server.includes("remoteActions: row?.remoteActions === true")],
  ["over the public proxy only with the TOTP login every role has there; audit marks it", gatewaySource.includes("...(policy()?.proxy === true ? { proxy: true } : {})") && gatewaySource.includes("if (!user.totpEnabled && (proxy || mfaRoles.includes(user.role)))")],
  ["every action is audited with the user and marked as remote in the services", gatewaySource.includes("audit('warn', `remote.action.${kind}`, { ...details, ok: true })") && gatewaySource.includes("audit('warn', `remote.action.${kind}`, { ...details, ok: false, code })") && server.includes("`remote:${actor}`") && server.includes('audit("warn", "instance.restart", { instanceId: id, actor: `remote:${actor}` })')],
  ["kick goes through the verified slot+name kick; the player list hides IPs and GUIDs", server.includes("rconService.kick(id, { slot: target.slot, name: target.name, reason: target.reason }") && server.includes("map(({ slot, name, ping, score, bot }) => ({ slot, name, ping, score, bot }))")],
  ["logout ends the step-up", gatewaySource.includes("if (current) actionGuard.revoke(current.sessionId);")],
];
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
console.log("4.18.19 remote actions gate PASS (step-up with fresh TOTP, limits, say/kick/restart only, audit)");
