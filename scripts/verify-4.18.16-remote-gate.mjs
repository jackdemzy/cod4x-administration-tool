import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRemoteGateway, listenRemoteGateway, remoteListenOptions, REMOTE_CSP, REMOTE_ROUTES } from "../lib/remote-gateway.mjs";
import { RemoteSessions } from "../lib/remote-sessions.mjs";
import { LoginThrottle } from "../lib/login-throttle.mjs";
import { hotp } from "../lib/totp.mjs";

// Block 24b gate: remote access for browser and phone. The gateway is a separate
// listener with a fixed read-only whitelist; plain HTTP only on loopback; cookie
// session with HttpOnly/Secure/SameSite=Strict; no CORS; same-origin writes;
// login brake; TOTP per RFC 6238; admin/operator need a second factor; the
// admin API never becomes reachable through it. Behaviour is exercised
// directly; wiring is checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs");
const refused = options => { try { remoteListenOptions(options); return false; } catch (error) { return error.code === "REMOTE_TLS_REQUIRED"; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cod4x-remote-gate-"));
fs.writeFileSync(path.join(dir, "remote.html"), "<!doctype html>");
const users = { phone: { username: "phone", role: "viewer", remoteAccess: true, totpEnabled: false }, boss: { username: "boss", role: "admin", remoteAccess: true, totpEnabled: false } };
const app = createRemoteGateway({
  login: async ({ username, password }) => password === "gate-password-123" ? users[username] || null : null,
  verifySecondFactor: async () => ({ ok: false }), hasPermission: (role, permission) => permission === "monitor.read",
  monitor: { overview: async () => ({ instances: [] }), history: async () => ({}), events: async () => ({ events: [] }) },
  sessions: new RemoteSessions(), throttle: new LoginThrottle(), staticDir: dir, version: "gate", sourceUrl: "https://example.invalid",
});
const listener = await listenRemoteGateway(app, { host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = (body, headers = {}) => fetch(`${base}/remote/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
const ok = await post({ username: "phone", password: "gate-password-123" });
const cookie = ok.headers.get("set-cookie") || "";
const adminWithoutMfa = await (await post({ username: "boss", password: "gate-password-123" })).json();
const crossSite = await post({ username: "phone", password: "gate-password-123" }, { origin: "https://evil.example" });
const adminRoutes = await Promise.all(["/api/auth/login", "/api/vault/status", "/api/instances", "/api/remote", "/remote/api/users", "/remote/api/rcon/command"].map(route => fetch(base + route).then(response => response.status)));
for (let i = 0; i < 10; i++) await post({ username: "phone", password: "wrong" });
const locked = await post({ username: "phone", password: "gate-password-123" });
await new Promise(resolve => listener.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });

const checks = [
  ["plain HTTP is refused on every non-loopback address", refused({ host: "0.0.0.0", port: 8788 }) && refused({ host: "::", port: 8788 }) && refused({ host: "192.168.1.5", port: 8788 }) && !refused({ host: "127.0.0.1", port: 8788 })],
  ["session cookie is HttpOnly, Secure, SameSite=Strict, Path=/remote", /; Path=\/remote; HttpOnly; Secure; SameSite=Strict;/.test(cookie)],
  ["no CORS, strict CSP, no framing, no caching of API answers", ok.headers.get("access-control-allow-origin") === null && ok.headers.get("content-security-policy") === REMOTE_CSP && /frame-ancestors 'none'/.test(REMOTE_CSP) && ok.headers.get("x-frame-options") === "DENY" && ok.headers.get("cache-control") === "no-store"],
  ["cross-site writes are refused", crossSite.status === 403],
  ["admin API routes are not reachable through the gateway", adminRoutes.every(status => status === 404)],
  ["admin and operator need a second factor remotely", adminWithoutMfa.code === "REMOTE_TOTP_SETUP_REQUIRED"],
  ["10 failed logins lock the client and user", locked.status === 429],
  ["TOTP matches RFC 6238 (SHA-1 test vectors)", hotp(Buffer.from("12345678901234567890"), Math.floor(59 / 30), 8) === "94287082" && hotp(Buffer.from("12345678901234567890"), Math.floor(20000000000 / 30), 8) === "65353130"],
  // 4.18.18 (Block 24c) adds the user's own push subscription; nothing else writes.
  ["whitelist is read-only apart from login/logout, the own push subscription and the guarded actions (24d)", REMOTE_ROUTES.filter(route => route.startsWith("POST")).join() === "POST /remote/api/login,POST /remote/api/logout,POST /remote/api/push/subscribe,POST /remote/api/push/unsubscribe,POST /remote/api/actions/step-up,POST /remote/api/instances/:id/say,POST /remote/api/instances/:id/kick,POST /remote/api/instances/:id/restart"],
  ["remote access is per user and off by default; the gateway is off by default", server.includes("remoteAccess: row?.remoteAccess === true") && server.includes('enabled: false, mode: "tailscale"')],
  ["the local login uses the same brake", server.includes("const throttleKey = LoginThrottle.key(loginClient(req.socket.remoteAddress), username);") && server.includes("throttle: loginThrottle")],
  ["remote settings and sessions need user.manage; the admin API still binds loopback by default", ['app.get("/api/remote", requirePermission("user.manage")', 'app.post("/api/remote/settings", requirePermission("user.manage")'].every(text => server.includes(text)) && server.includes('const HOST = process.env.HOST || "127.0.0.1";')],
  ["narrowing a user's access ends their remote sessions", server.includes("remoteRevoked = remoteSessions.revokeUser(target.username)") && server.includes("remoteSessions.revokeUser(user.username)")],
  ["the web app links the source code (AGPL-3.0 §13)", read("lib/remote-app.jsx").includes("Quellcode (AGPL-3.0)") && server.includes("REMOTE_SOURCE_URL")],
];
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
console.log("4.18.16 remote access gate PASS (loopback or TLS only, cookie session, TOTP, login brake, read-only whitelist)");
