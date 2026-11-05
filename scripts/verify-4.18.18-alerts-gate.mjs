import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ALERT_DEFAULTS, MonitorAlerts } from "../lib/monitor-alerts.mjs";
import { discordMessage, maskDiscordWebhookUrl, validateDiscordWebhookUrl } from "../lib/discord-webhook.mjs";
import { createVapidKeys, encryptPushPayload, validatePushSubscription, vapidAuthorization } from "../lib/web-push.mjs";
import { caddyfileTemplate, createRemoteGateway, listenRemoteGateway } from "../lib/remote-gateway.mjs";
import { RemoteSessions } from "../lib/remote-sessions.mjs";
import { LoginThrottle } from "../lib/login-throttle.mjs";

// Block 24c gate: outage alerts. Push encryption matches RFC 8291 Appendix A,
// VAPID per RFC 8292; push and Discord only reach their own services; the
// repeat brake holds and the all-clear goes out once; push carries no console
// lines; settings need config.manage; the public proxy mode needs a second
// factor for every role and locks after 5 failures. Behaviour is exercised
// directly; wiring is checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs"), notifier = read("lib/alert-notifier.mjs"), discord = read("lib/discord-webhook.mjs"), push = read("lib/web-push.mjs");
const throws = (fn, code) => { try { fn(); return false; } catch (error) { return error.code === code; } };

const rfc = { endpoint: "https://fcm.googleapis.com/fcm/send/gate", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
const vector = encryptPushPayload(rfc, "When I grow up, I want to be a watermelon", { sender: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url") }).toString("base64url");

const keys = createVapidKeys(), now = Date.UTC(2026, 10, 5);
const [, jwt] = /^vapid t=([^,]+), k=/.exec(vapidAuthorization(rfc.endpoint, keys, { subject: "mailto:gate@example.org", now, ttlSeconds: 99 * 3600 }));
const [h, c, s] = jwt.split("."), claims = JSON.parse(Buffer.from(c, "base64url"));
const point = Buffer.from(keys.publicKey, "base64url");
const vapidOk = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));

const sent = [];
let clock = 0;
const alerts = new MonitorAlerts({ rules: () => ({ ...ALERT_DEFAULTS, enabled: true }), send: async alert => { sent.push(alert); }, now: () => clock });
const live = { id: "a", name: "Gate", down: true, downSince: 0 };
await alerts.handleEvent({ kind: "down", id: "a", cause: { kind: "crash", console: ["SECRET CONSOLE LINE"], reason: "SECRET REASON" } }, live);
clock = 60e3; await alerts.handleEvent({ kind: "up", id: "a", downMs: 60e3 }, live);
clock = 61e3; await alerts.handleEvent({ kind: "up", id: "a", downMs: 1 }, live);
clock = 5 * 60e3; await alerts.handleEvent({ kind: "down", id: "a", cause: { kind: "crash" } }, live);
const afterBrake = sent.length;
clock = 31 * 60e3; await alerts.handleTick({ instances: [{ ...live, downSince: 5 * 60e3 }] });
const stopSent = [];
await new MonitorAlerts({ rules: () => ({ ...ALERT_DEFAULTS, enabled: true }), send: async alert => { stopSent.push(alert); } }).handleEvent({ kind: "down", id: "b", cause: { kind: "stopped" } }, live);

// Proxy mode on a real gateway listener.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cod4x-alerts-gate-"));
const users = { phone: { username: "phone", role: "viewer", remoteAccess: true, totpEnabled: false } };
const app = createRemoteGateway({
  login: async ({ username, password }) => password === "gate-password-123" ? users[username] || null : null,
  verifySecondFactor: async () => ({ ok: false }), hasPermission: (role, permission) => permission === "monitor.read",
  monitor: { overview: async () => ({ instances: [] }), history: async () => ({}), events: async () => ({ events: [] }) },
  sessions: new RemoteSessions(), throttle: new LoginThrottle(), policy: () => ({ proxy: true }), staticDir: dir,
});
const listener = await listenRemoteGateway(app, { host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = (body, headers = {}) => fetch(`${base}/remote/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-forwarded-for": "198.51.100.4", ...headers }, body: JSON.stringify(body) });
const viewerNeedsTotp = (await (await post({ username: "phone", password: "gate-password-123" })).json()).code === "REMOTE_TOTP_SETUP_REQUIRED";
for (let i = 0; i < 5; i++) await post({ username: "phone", password: "wrong" });
const lockedAfterFive = (await post({ username: "phone", password: "gate-password-123" })).status === 429;
const pushWithoutService = (await fetch(`${base}/remote/api/push/key`)).status === 401;
await new Promise(resolve => listener.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });

const checks = [
  ["push encryption matches RFC 8291 Appendix A byte for byte", vector === "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"],
  ["VAPID is ES256 per RFC 8292 (aud = push origin, exp <= 24 h)", vapidOk && claims.aud === "https://fcm.googleapis.com" && claims.exp - now / 1000 <= 24 * 3600],
  ["push only to the browsers' push services, never http or other hosts", ["https://evil.example/x", "http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.example/x"].every(endpoint => { try { validatePushSubscription({ ...rfc, endpoint }); return false; } catch (error) { return /^PUSH_(ENDPOINT_INVALID|SERVICE_NOT_ALLOWED)$/.test(error.code); } })],
  ["Discord only discord.com/discordapp.com webhooks, URL masked", throws(() => validateDiscordWebhookUrl("https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz"), "DISCORD_HOST_NOT_ALLOWED") && !maskDiscordWebhookUrl(`https://discord.com/api/webhooks/123456789012345678/${"t".repeat(68)}`).includes("t".repeat(5))],
  ["Discord and push follow no redirects and time out", (discord.match(/redirect: 'error'/g) || []).length === 1 && (push.match(/redirect: 'error'/g) || []).length === 1 && discord.includes("AbortSignal.timeout(timeoutMs)") && push.includes("AbortSignal.timeout(timeoutMs)")],
  ["Discord messages cannot ping (@everyone in a server name)", JSON.stringify(discordMessage({ title: "@everyone", body: "" }).allowed_mentions) === '{"parse":[]}'],
  ["repeat brake: one outage alert, one all-clear, a braked outage follows when still down", sent.length === 3 && afterBrake === 2 && sent.map(alert => alert.type).join() === "down,up,down"],
  ["alerts carry no console lines; planned stops are silent by default; alerts are off by default", !JSON.stringify(sent).includes("SECRET") && stopSent.length === 0 && ALERT_DEFAULTS.enabled === false && notifier.includes("JSON.stringify({ title: alert.title, body: alert.body || '', type: alert.type, tag: alert.key, t: alert.t ?? this.#now() })")],
  ["settings and test alert need config.manage", ['app.get("/api/alerts", requirePermission("config.manage")', 'app.post("/api/alerts/settings", requirePermission("config.manage")', 'app.post("/api/alerts/test", requirePermission("config.manage")'].every(text => server.includes(text))],
  ["settings and subscriptions are 0600 files; audit without URL", notifier.includes("mode: 0o600") && notifier.includes("alert.sent") && notifier.includes("alert.failed") && !/alert\.(sent|failed)[^\n]*discordUrl/.test(notifier)],
  ["push only for users who keep remote access; losing it removes their devices", server.includes('user.remoteAccess === true && hasPermission(user.role, "monitor.read")') && server.includes("await alertNotifier.removeUser(target.username)")],
  ["public proxy mode: second factor for every role, 5 attempts, push needs a session", viewerNeedsTotp && lockedAfterFive && pushWithoutService],
  ["proxy mode keeps the gateway on loopback; Caddyfile (= docs/Caddyfile.example) has HSTS and strips Tailscale headers", server.includes('host: mode === "lan" ? lanHost : "127.0.0.1"') && caddyfileTemplate("monitor.example.org", 8788).includes("Strict-Transport-Security") && caddyfileTemplate(null).includes("header_up -Tailscale-User-Login") && read("docs/Caddyfile.example") === caddyfileTemplate(null) && server.includes("if (!next.enabled || modeChanged) remoteSessions.revokeAll();")],
  ["no e-mail sending (no SMTP credentials in the tool)", !/nodemailer|smtp/i.test(read("package.json") + notifier)],
];
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
console.log("4.18.18 alerts gate PASS (RFC 8291/8292 push, Discord allowlist, repeat brake, no console lines, proxy mode with TOTP for all)");
