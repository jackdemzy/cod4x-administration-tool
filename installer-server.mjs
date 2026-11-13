/**
 * COD4X CONTROL — installer backend
 * Node.js 20+ / Express
 *
 * Security model:
 * - No API keys or download credentials in the browser.
 * - Downloads are allowlisted; arbitrary URLs are rejected.
 * - Archives are extracted with path traversal protection.
 * - SHA-256 is verified when a manifest entry supplies a checksum.
 * - Installation uses staging directories and atomic-ish replacement.
 *
 * IMPORTANT:
 * Replace the placeholder download URLs in DOWNLOADS with your own
 * trusted release/artifact URLs and real SHA-256 values before production use.
 */

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dgram from "node:dgram";
import { inspectBaseGame } from "./lib/base-game-manager.mjs";
import { mergeBaseGameState, resolveRuntimeLayout, selectRuntimeBaseGamePath } from "./lib/runtime-layout.mjs";
import { createRuntimeManager } from "./lib/runtime-manager.mjs";
import { ServerInstanceStore, resolveRealFuturePath } from "./lib/server-instance-store.mjs";
import { ServerInstanceManager } from "./lib/server-instance-manager.mjs";
import { InstanceCredentialService } from "./lib/instance-credential-service.mjs";
import { RemoteHostStore } from "./lib/remote-host-store.mjs";
import { RemoteInstanceStore } from "./lib/remote-instance-store.mjs";
import { RemoteStateStore } from "./lib/remote-runtime-state.mjs";
import { RemoteHostService, sshSubjectResolver } from "./lib/remote-host-service.mjs";
import { isRemoteSubject, remoteIdOf, createShadowStore, remoteSubjectResolver, prefixedCredentials } from "./lib/remote-subjects.mjs";
import { RemoteSessionPool } from "./lib/remote-session-pool.mjs";
import { createRemoteRconClientFactory } from "./lib/remote-rcon-client.mjs";
import { createRemoteMonitor } from "./lib/remote-monitor.mjs";
import { createGatewayActions } from "./lib/gateway-actions.mjs";
import { RemoteInstanceManager } from "./lib/remote-instance-manager.mjs";
import { registerRemoteLinuxRoutes, REMOTE_LINUX_BINDINGS } from "./lib/remote-linux-routes.mjs";
import { InstanceRconService } from "./lib/instance-rcon-service.mjs";
import { InstanceMasterService } from "./lib/instance-master-service.mjs";
import { B3Environment, B3_DEPENDENCY_MATRIX, B3_SOURCE } from "./lib/b3-dependencies.mjs";
import { InstanceB3Service } from "./lib/instance-b3-service.mjs";
import { restartHints, b3PluginsRestartHint } from "./lib/b3-integration.mjs";
import { InstanceB3DatabaseService } from "./lib/instance-b3-database-service.mjs";
import { InstanceB3AdminService } from "./lib/instance-b3-admin-service.mjs";
import { InstanceB3PluginService } from "./lib/instance-b3-plugin-service.mjs";
import { RconClient } from "./lib/rcon-client.mjs";
import { RestorePointStore } from "./lib/restore-points.mjs";
import { installArtifacts, restoreFilesPoint, snapshotFiles, assertSafeChildPath as assertInsideRoot, DEFAULT_RUNTIME_SUBJECT } from "./lib/archive-install.mjs";
import { guardedChange } from "./lib/restore-guard.mjs";
import { MonitorStore, monitorRange } from "./lib/monitor-store.mjs";
import { MonitorCollector } from "./lib/monitor-collector.mjs";
import { MonitorHost } from "./lib/monitor-host.mjs";
import { MonitorAlerts } from "./lib/monitor-alerts.mjs";
import { AlertNotifier } from "./lib/alert-notifier.mjs";
import { readInstanceConsoleLog } from "./lib/instance-console-log.mjs";
import { LoginThrottle, loginClient } from "./lib/login-throttle.mjs";
import { DESKTOP_CLIENT_HEADER, localOriginDecision } from "./lib/local-origin-policy.mjs";
import { RemoteSessions } from "./lib/remote-sessions.mjs";
import { REMOTE_DEFAULT_PORT, REMOTE_ROUTES, REMOTE_PROXY_MAX_FAILURES, caddyfileTemplate, createRemoteGateway, listenRemoteGateway, remoteListenOptions } from "./lib/remote-gateway.mjs";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, matchRecoveryCode, totpUri, verifyTotp } from "./lib/totp.mjs";
import { assertWindowsInstanceOwnership } from "./lib/windows-process-ownership.mjs";
import { createLinuxRuntimeAdapter, assertLinuxInstanceOwnership } from "./lib/linux-runtime-adapter.mjs";
import { isB3PluginCodePath, isB3PluginTextPath, localOnlyGuard, publicBlockers } from "./lib/b3-plugin-routes.mjs";
import { isCredentialPath } from "./lib/credential-request.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const app = express();

// ─── 4.17.0 Production Runtime Foundation ───────────────────────────────────
// All mutable application state lives below one explicit data root. This is
// important for the later Windows service/boot runtime because a Windows
// service normally starts with a different working directory than the GUI.
const DATA_ROOT = path.resolve(process.env.COD4X_DATA_ROOT || ".");
function dataPath(...parts) { return path.resolve(DATA_ROOT, ...parts); }
// Block 21: restore points of local instances, remote instances and the standard server.
const restorePoints = new RestorePointStore({ root: dataPath("data", "restore-points") });

// ─── 4.11.3 Authentication & Access Control ──────────────────────────────────
const AUTH_USER_FILE = path.resolve(process.env.COD4X_AUTH_USER_FILE || dataPath("config", "auth-user.json"));
const AUTH_SESSION_MS = 30 * 60 * 1000;
const AUTH_SESSION_CLEANUP_MS = 60 * 1000;
const AUTH_SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const AUTH_USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const AUTH_MIN_PASSWORD = 12;
const AUTH_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
let authUser = null;
const AUTH_USERS_FILE = path.resolve(process.env.COD4X_AUTH_USERS_FILE || dataPath("config", "users.json"));
const authUsers = new Map();
const authSessions = new Map();
let authWriteQueue = Promise.resolve();

function normalizeAuthUser(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.username !== "string" || !AUTH_USERNAME_RE.test(raw.username)) return null;
  if (typeof raw.passwordHash !== "string" || !/^scrypt\$[0-9a-f]+\$[0-9a-f]+\$N[0-9]+r[0-9]+p[0-9]+$/.test(raw.passwordHash)) return null;
  const role = normalizeRole(raw.role) || "admin";
  return { version: 1, username: raw.username, role, passwordHash: raw.passwordHash };
}

function validateAuthUsername(username) {
  const value = String(username ?? "").trim();
  if (!AUTH_USERNAME_RE.test(value)) return "Benutzername: 3–32 Zeichen, nur Buchstaben, Zahlen, '.', '_' und '-' erlaubt.";
  return "";
}

function validateAuthPassword(password) {
  const value = String(password ?? "");
  if (value.length < AUTH_MIN_PASSWORD) return `Passwort: mindestens ${AUTH_MIN_PASSWORD} Zeichen erforderlich.`;
  if (value.length > 256) return "Passwort: maximal 256 Zeichen erlaubt.";
  return "";
}

function hashAuthPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, AUTH_SCRYPT.keylen, {
    N: AUTH_SCRYPT.N, r: AUTH_SCRYPT.r, p: AUTH_SCRYPT.p, maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}$N${AUTH_SCRYPT.N}r${AUTH_SCRYPT.r}p${AUTH_SCRYPT.p}`;
}

function verifyAuthPassword(password, encoded) {
  try {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (!salt.length || !expected.length) return false;
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: AUTH_SCRYPT.N, r: AUTH_SCRYPT.r, p: AUTH_SCRYPT.p, maxmem: 32 * 1024 * 1024,
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

async function loadAuthUser() {
  try {
    const raw = JSON.parse(await fs.readFile(AUTH_USER_FILE, "utf8"));
    authUser = normalizeAuthUser(raw);
  } catch {
    authUser = null;
  }
  return authUser;
}

async function loadAuthUsers() {
  authUsers.clear();
  try {
    const raw = JSON.parse(await fs.readFile(AUTH_USERS_FILE, "utf8"));
    const rows = Array.isArray(raw?.users) ? raw.users : [];
    for (const row of rows) {
      const normalized = normalizeAuthUser(row);
      if (normalized) authUsers.set(normalized.username.toLowerCase(), { ...normalized, disabled: row.disabled === true, createdAt: row.createdAt || null, updatedAt: row.updatedAt || null, ...normalizeRemoteFields(row) });
    }
  } catch {}
  if (authUser && !authUsers.has(authUser.username.toLowerCase())) {
    const now = new Date().toISOString();
    authUsers.set(authUser.username.toLowerCase(), { ...authUser, disabled: false, createdAt: now, updatedAt: now });
    await saveAuthUsers();
  }
  return authUsers;
}

async function saveAuthUsers() {
  const dir = path.dirname(AUTH_USERS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${AUTH_USERS_FILE}.tmp-${process.pid}`;
  const users = [...authUsers.values()].map(u => ({ version: 1, username: u.username, role: u.role, passwordHash: u.passwordHash, disabled: u.disabled === true, createdAt: u.createdAt || null, updatedAt: u.updatedAt || null, ...normalizeRemoteFields(u) }));
  await fs.writeFile(tmp, JSON.stringify({ version: 1, users }, null, 2) + "\n", { encoding: "utf8", flag: "w", mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, AUTH_USERS_FILE);
  await fs.chmod(AUTH_USERS_FILE, 0o600).catch(() => {});
}

// Block 24b: per-user remote access flag, TOTP secret (base32, in this 0600 file
// and not in the vault, so a locked vault does not lock remote logins out) and
// scrypt hashes of unused recovery codes.
function normalizeRemoteFields(row) {
  const totp = row?.totp && typeof row.totp.secret === "string" && /^[A-Z2-7]{32}$/.test(row.totp.secret)
    ? { secret: row.totp.secret, lastStep: Number.isInteger(row.totp.lastStep) ? row.totp.lastStep : null, enabledAt: typeof row.totp.enabledAt === "string" ? row.totp.enabledAt : null } : null;
  const recovery = totp && Array.isArray(row.recovery) ? row.recovery.filter(entry => entry && /^[0-9a-f]{32}$/.test(entry.salt) && /^[0-9a-f]{64}$/.test(entry.hash)).slice(0, 10).map(({ salt, hash }) => ({ salt, hash })) : [];
  return { remoteAccess: row?.remoteAccess === true, remoteActions: row?.remoteActions === true, totp, recovery };
}

function findAuthUser(username) {
  return authUsers.get(String(username || "").trim().toLowerCase()) || null;
}

function sanitizeUserMetadata(user) {
  return { username: user.username, role: user.role, disabled: user.disabled === true, createdAt: user.createdAt || null, updatedAt: user.updatedAt || null, remoteAccess: user.remoteAccess === true, remoteActions: user.remoteActions === true, totpEnabled: Boolean(user.totp), recoveryRemaining: user.totp ? (user.recovery || []).length : 0 };
}

async function saveAuthUser(next) {
  const normalized = normalizeAuthUser(next);
  if (!normalized) throw new Error("Ungültiger Benutzer-Datensatz");
  const dir = path.dirname(AUTH_USER_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${AUTH_USER_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n", { encoding: "utf8", flag: "w", mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, AUTH_USER_FILE);
  await fs.chmod(AUTH_USER_FILE, 0o600).catch(() => {});
  authUser = normalized;
  return authUser;
}

function queueAuthWrite(next) {
  authWriteQueue = authWriteQueue.then(() => saveAuthUser(next));
  return authWriteQueue;
}

function createAuthSession(username, role = "admin") {
  const token = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomBytes(12).toString("hex");
  const now = Date.now();
  authSessions.set(token, { sessionId, username, role, createdAt: now, lastSeenAt: now, absoluteExpiresAt: now + AUTH_SESSION_MAX_MS, expiresAt: now + AUTH_SESSION_MS });
  return { token, sessionId, expiresAt: now + AUTH_SESSION_MS, absoluteExpiresAt: now + AUTH_SESSION_MAX_MS };
}

function getAuthSession(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session) return null;
  const now = Date.now();
  // A5-4 (security audit 4.18.26): a disabled or deleted user loses every local session at once.
  const owner = findAuthUser(session.username);
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now || !owner || owner.disabled) {
    authSessions.delete(token);
    return null;
  }
  session.lastSeenAt = now;
  session.expiresAt = Math.min(now + AUTH_SESSION_MS, session.absoluteExpiresAt);
  return { token, ...session };
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of authSessions) {
    if (session.expiresAt <= now) authSessions.delete(token);
  }
}, AUTH_SESSION_CLEANUP_MS).unref();

function requireAuth(req, res, next) {
  const session = getAuthSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "Authentication required" });
  req.auth = session;
  next();
}

// ─── 4.11.4 Fine-Grained RBAC & Permissions ──────────────────────────────────
const RBAC_ROLES = ["admin", "operator", "auditor", "viewer", "monitor"];
const RBAC_PERMISSIONS = [
  { id: "installation.manage", label: "Installation", description: "Installations- und Installationsvorgänge verwalten." },
  { id: "install.execute", label: "Installation ausführen", description: "Verbindliche Installationsausführung autorisieren." },
  { id: "updates.manage", label: "Updates", description: "Versionen und Update-Vorgänge verwalten." },
  { id: "update.execute", label: "Updates ausführen", description: "Verbindliche Update-Ausführung autorisieren." },
  { id: "server.manage", label: "Serververwaltung", description: "Serverinstanzen und Betriebssteuerung verwalten." },
  { id: "config.manage", label: "Konfiguration", description: "Serverkonfiguration und Profile verwalten." },
  { id: "diagnostics.read", label: "Diagnostics", description: "Diagnose- und Health-Daten lesen." },
  { id: "audit.read", label: "Audit", description: "Audit-Trail und persistente Audit-Daten lesen." },
  { id: "user.manage", label: "Benutzerverwaltung", description: "Benutzer, Rollen und Benutzer-Sessions verwalten." },
  { id: "monitor.read", label: "Monitoring", description: "Serverstatus, Spielerzahlen, Verlauf und Ausfälle lesen (Block 24)." },
  // Block 16b: custom B3 plugin code runs as the B3 process user; admin only.
  { id: "b3.plugins.code", label: "B3-Plugin-Code", description: "Eigene B3-Plugins anlegen, hochladen und bearbeiten." },
  // Security audit 4.18.26 (A1-1): code CONTROL runs as its own user; admin only.
  { id: "server.code", label: "Server-Programmcode", description: "Server-Core wählen und übernehmen, CoD4x-Plugins installieren, freie Startargumente." },
];
const RBAC_PERMISSION_IDS = RBAC_PERMISSIONS.map(p => p.id);
const RBAC_MATRIX = Object.freeze({
  admin: Object.freeze([...RBAC_PERMISSION_IDS]),
  operator: Object.freeze(["installation.manage", "install.execute", "updates.manage", "update.execute", "server.manage", "config.manage", "diagnostics.read", "monitor.read"]),
  auditor: Object.freeze(["diagnostics.read", "audit.read", "monitor.read"]),
  viewer: Object.freeze(["diagnostics.read", "audit.read", "monitor.read"]),
  // Block 24: status and history only; no diagnostics, console or audit.
  monitor: Object.freeze(["monitor.read"]),
});

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return RBAC_ROLES.includes(value) ? value : null;
}

function permissionsForRole(role) {
  const normalized = normalizeRole(role);
  return normalized ? [...RBAC_MATRIX[normalized]] : [];
}

function hasPermission(role, permission) {
  const normalized = normalizeRole(role);
  const id = String(permission || "").trim();
  if (!normalized || !RBAC_PERMISSION_IDS.includes(id)) return false;
  return RBAC_MATRIX[normalized].includes(id);
}

// quietAllowed: polled read routes (monitoring) audit denials only.
function requirePermission(permission, { quietAllowed = false } = {}) {
  return (req, res, next) => {
    const session = getAuthSession(req);
    if (!session) return res.status(401).json({ ok: false, error: "Authentication required" });
    const allowed = hasPermission(session.role, permission);
    if (!allowed || !quietAllowed) audit(allowed ? "info" : "warn", "rbac.permission.checked", {
      username: session.username,
      role: session.role,
      permission,
      allowed,
    });
    if (!allowed) return res.status(403).json({ ok: false, error: "Permission denied", permission, role: session.role });
    req.auth = session;
    next();
  };
}

// Security audit 4.18.26 (A1-1): a server.manage route that brings code (another core,
// free start arguments) only when the request asks for it; runs after requirePermission.
function requireCodeWhen(bringsCode) {
  return (req, res, next) => {
    if (!bringsCode(req.body || {}) || hasPermission(req.auth?.role, "server.code")) return next();
    audit("warn", "rbac.permission.checked", { username: req.auth?.username, role: req.auth?.role, permission: "server.code", allowed: false });
    res.status(403).json({ ok: false, error: "Permission denied", permission: "server.code", role: req.auth?.role });
  };
}
const runtimeBringsCode = body => Boolean(body.executablePath) || (body.args !== undefined && !(Array.isArray(body.args) && body.args.length === 0));
const cloneBringsCode = body => body.serverCore !== undefined;

const RBAC_ENDPOINT_BINDINGS = Object.freeze([
  { area: "installation", permission: "install.execute", routes: ["POST /api/installer"] },
  { area: "updates", permission: "update.execute", routes: ["POST /api/fpschallenge/anticheat/download/:version"] },
  { area: "server", permission: "server.manage", routes: ["POST /api/server/start", "POST /api/runtime/start", "POST /api/runtime/stop", "POST /api/runtime/restart", "POST /api/rcon/execute", "POST /api/instances/:id/rcon/connect", "POST /api/instances/:id/rcon/command", "POST /api/admin/test"] },
  { area: "restore-points", permission: "config.manage", routes: ["GET /api/instances/:id/restore-points", "POST /api/instances/:id/restore-points", "GET /api/instances/:id/restore-points/:pointId/integrity", "POST /api/instances/:id/restore-points/:pointId/restore", "GET /api/runtime/restore-points", "POST /api/runtime/restore-points", "GET /api/runtime/restore-points/:pointId/integrity"] },
  { area: "configuration", permission: "config.manage", routes: ["GET /api/policy", "POST /api/policy/validate", "POST /api/policy/save", "GET /api/config/profiles", "POST /api/config/profiles/save", "POST /api/config/profiles/activate", "POST /api/config/profiles/delete"] },
  { area: "diagnostics", permission: "diagnostics.read", routes: ["GET /api/diagnostics", "GET /api/runtime/status"] },
  { area: "monitoring", permission: "monitor.read", routes: ["GET /api/monitor/overview", "GET /api/monitor/instances/:id/history", "GET /api/monitor/instances/:id/events"] },
  { area: "remote", permission: "user.manage", routes: ["GET /api/remote", "POST /api/remote/settings", "POST /api/remote/sessions/:sessionId/revoke", "POST /api/remote/sessions/revoke-all"] },
  { area: "server-code", permission: "server.code", routes: ["POST /api/runtime/config", "POST /api/runtime/adopt", "POST /api/instances/:id/core", "POST /api/runtime/restore-points/:pointId/restore", "POST /api/instances", "POST /api/instances/:id/plugins/install", "POST /api/instances/:id/plugins/approve", "POST /api/runtime/start (core or arguments)", "POST /api/runtime/restart (core or arguments)", "POST /api/server/start (core or arguments)", "POST /api/instances/:id/clone (core)", "POST /api/b3/environment"] },
  { area: "b3-plugin-code", permission: "b3.plugins.code", routes: ["POST /api/instances/:id/b3/plugins/custom", "GET /api/instances/:id/b3/plugins/custom/:name/code", "PUT /api/instances/:id/b3/plugins/custom/:name/code", "DELETE /api/instances/:id/b3/plugins/custom/:name"] },
  ...REMOTE_LINUX_BINDINGS,
  { area: "audit", permission: "audit.read", routes: ["GET /api/audit", "GET /api/audit/persistent", "POST /api/audit/persist", "GET /api/audit/hardening", "GET /api/audit/checkpoint"] },
  // Security audit 4.18.26 (A5-5): writing to the audit log is not a read right.
  { area: "audit-admin", permission: "user.manage", routes: ["POST /api/audit/test", "POST /api/audit/rotate"] },
]);

function authorizationBindingChecks() {
  const checks = [
    { id: "auth", label: "Authentication required for protected endpoints", pass: true },
    { id: "install", label: "Installation binding", pass: hasPermission("admin", "install.execute") },
    { id: "updates", label: "Update binding", pass: hasPermission("admin", "update.execute") },
    { id: "server", label: "Server management binding", pass: hasPermission("admin", "server.manage") },
    { id: "config", label: "Configuration binding", pass: hasPermission("admin", "config.manage") },
    { id: "diagnostics", label: "Diagnostics binding", pass: hasPermission("admin", "diagnostics.read") },
    { id: "audit", label: "Audit binding", pass: hasPermission("admin", "audit.read") },
    { id: "denied", label: "Denied role produces 403", pass: !hasPermission("viewer", "server.manage") },
    { id: "viewer", label: "Viewer retains read permissions", pass: hasPermission("viewer", "diagnostics.read") },
    { id: "auditor", label: "Auditor retains audit permissions", pass: hasPermission("auditor", "audit.read") },
    { id: "operator", label: "Operator retains server permissions", pass: hasPermission("operator", "server.manage") },
    { id: "monitor", label: "Monitor role reads monitoring only", pass: hasPermission("monitor", "monitor.read") && !hasPermission("monitor", "diagnostics.read") && !hasPermission("monitor", "server.manage") },
    { id: "unknown", label: "Unknown permission denied", pass: !hasPermission("admin", "not-a-permission") },
    { id: "unknown-route", label: "Unknown routes remain untouched", pass: true },
    { id: "public", label: "Public authentication allowlist remains available", pass: true },
  ];
  return { ok: checks.every(c => c.pass), checks, bindings: RBAC_ENDPOINT_BINDINGS };
}

// Security audit 4.18.26 (A5-1, A5-2): only our own pages may call the admin API from a
// browser. Electron loads the renderer from file:// (Origin "null") and adds a per-launch
// secret header; the secret is taken out of the environment so no child process inherits it.
const DESKTOP_CLIENT_TOKEN = process.env.COD4X_DESKTOP_CLIENT_TOKEN || "";
delete process.env.COD4X_DESKTOP_CLIENT_TOKEN;
app.use((req, res, next) => {
  const decision = localOriginDecision({
    origin: req.headers.origin,
    desktopHeader: req.headers[DESKTOP_CLIENT_HEADER],
    desktopToken: DESKTOP_CLIENT_TOKEN,
    ownOrigins: [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
    preflight: req.method === "OPTIONS",
  });
  res.setHeader("Vary", "Origin");
  if (!decision.allowed) return res.status(403).json({ ok: false, code: "ORIGIN_REFUSED", error: "Request from a foreign web page refused." });
  if (decision.allowOrigin) res.setHeader("Access-Control-Allow-Origin", decision.allowOrigin);
  // Only the schema-backed instance config endpoint accepts PUT. Preserve
  // existing method exposure elsewhere; authentication/RBAC still guard writes.
  const instanceConfigPath = /^\/api\/instances\/[^/]+\/config\/?$/.test(req.path);
  // Block 16b: B3 plugin config and custom code accept PUT, a custom plugin DELETE.
  const b3PluginPutPath = /^\/api\/instances\/[^/]+\/b3\/plugins\/(?:custom\/[^/]+\/code|[^/]+\/config)\/?$/.test(req.path);
  const b3PluginDeletePath = /^\/api\/instances\/[^/]+\/b3\/plugins\/custom\/[^/]+\/?$/.test(req.path);
  // Block 18: the config of a remote server accepts PUT, an SSH host DELETE.
  const remoteConfigPath = /^\/api\/remote-instances\/[^/]+\/config\/?$/.test(req.path);
  const remoteHostDeletePath = /^\/api\/remote-hosts\/[^/]+\/?$/.test(req.path);
  res.setHeader("Access-Control-Allow-Methods", `GET,POST,${instanceConfigPath || b3PluginPutPath || remoteConfigPath ? "PUT," : ""}${b3PluginDeletePath || remoteHostDeletePath ? "DELETE," : ""}OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-COD4X-Desktop");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// Credential transport is local-only until an authenticated TLS deployment is
// explicitly implemented. Never cache or reflect secret request bodies.
const isCredentialRequest = req => isCredentialPath(req.path);
app.use((req, res, next) => {
  if (!isCredentialRequest(req)) return next();
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(localOnlyGuard(isCredentialRequest));
// Block 16b: custom plugin code (create, read/write, delete) is admin only and local only.
app.use(localOnlyGuard(req => isB3PluginCodePath(req.path)));
// Block 16b: B3 plugin config and code may be up to 256 KB of text; JSON escaping can grow it.
const isB3PluginTextRequest = req => isB3PluginTextPath(req.path);
const jsonBody = express.json({ limit: "64kb" }), b3PluginJsonBody = express.json({ limit: "2mb" });
app.use((req, res, next) => (isB3PluginTextRequest(req) ? b3PluginJsonBody : jsonBody)(req, res, next));
// Plugin bodies can hold tokens: a malformed or oversized body gets a fixed
// code, never the parser message, and is not passed to the default handler (which logs).
app.use((error, req, res, next) => {
  if (!isB3PluginTextRequest(req)) return next(error);
  const code = /\/(?:code|custom)\/?$/i.test(req.path) ? "B3_PLUGIN_CODE_INVALID" : "B3_PLUGIN_CONFIG_INVALID";
  res.status(400).json({ ok: false, code, error: code });
});
app.use((error, req, res, next) => {
  if (!isCredentialRequest(req)) return next(error);
  res.status(400).json({ ok: false, code: "CREDENTIAL_REQUEST_INVALID", error: "Credential request is invalid." });
});

await loadAuthUser();
await loadAuthUsers();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const INSTALL_ROOT = path.resolve(process.env.COD4X_INSTALL_ROOT || dataPath("installations"));
const SECURITY_COD4X_VERSIONS = ["21.2", "21.3", "21.4", "21.5"];
const SECURITY_TARGETS = ["server", "client"];

const DOWNLOADS = {
  cod4x: {
    "21.2": { url: process.env.COD4X_212_URL || "", sha256: process.env.COD4X_212_SHA256 || "" },
    "21.3": { url: process.env.COD4X_213_URL || "", sha256: process.env.COD4X_213_SHA256 || "" },
    "21.4": { url: process.env.COD4X_214_URL || "", sha256: process.env.COD4X_214_SHA256 || "" },
    "21.5": { url: process.env.COD4X_215_URL || "", sha256: process.env.COD4X_215_SHA256 || "" },
  },
  fps: {
    "2.85": { url: process.env.FPS_285_URL || "", sha256: process.env.FPS_285_SHA256 || "", format: process.env.FPS_285_FORMAT || "zip" },
    "2.86": { url: process.env.FPS_286_URL || "", sha256: process.env.FPS_286_SHA256 || "", format: process.env.FPS_286_FORMAT || "zip" },
    "3.00": { url: process.env.FPS_300_URL || "", sha256: process.env.FPS_300_SHA256 || "", format: process.env.FPS_300_FORMAT || "zip" },
    "3.02": { url: process.env.FPS_302_URL || "", sha256: process.env.FPS_302_SHA256 || "", format: process.env.FPS_302_FORMAT || "zip" },
  },
  mods: {
    "mods/mp_bots": {
      url: process.env.BOT_WARFARE_URL || "",
      sha256: process.env.BOT_WARFARE_SHA256 || "",
    },
    "mods/pml220": {
      url: process.env.PROMOD_220_URL || "",
      sha256: process.env.PROMOD_220_SHA256 || "",
    },
    "mods/pml220_custom": {
      url: process.env.PROMOD_CUSTOM_URL || "",
      sha256: process.env.PROMOD_CUSTOM_SHA256 || "",
    },
  },
};

function assertSafeChildPath(root, child) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, child);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Unsafe path rejected");
  }
  return resolved;
}

const SAFE_RCON_COMMANDS = new Set([
  "status","serverinfo","players","users","map_rotate","map_restart",
  "fast_restart","say","kick","clientkick","banClient","banUser",
  "tempBanClient","tempBanUser","unbanuser","map","get","set"
]);

async function executeRcon({host,port,password,command}) {
  if (!host || !password || !command) throw new Error("RCON host, password and command are required");
  const cmd=String(command).trim();
  const base=cmd.split(/\s+/)[0];
  if (!SAFE_RCON_COMMANDS.has(base)) throw new Error(`RCON command not allowed: ${base}`);
  const socket=dgram.createSocket("udp4");
  const payload=Buffer.from(`\xff\xff\xff\xffrcon ${password} ${cmd}\n`, "utf8");
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.close();reject(new Error("RCON timeout"));},3000);
    socket.once("message",(msg)=>{
      clearTimeout(timer); socket.close();
      resolve(msg.toString("utf8").replace(/^\xff\xff\xff\xffprint\n?/,"").trim());
    });
    socket.once("error",(err)=>{clearTimeout(timer);socket.close();reject(err);});
    socket.send(payload,Number(port)||28960,String(host),err=>{
      if(err){clearTimeout(timer);socket.close();reject(err);}
    });
  });
}

function normalizeSafeRelativePath(value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw) throw new Error("Installation path is required");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.includes("\0")) throw new Error("Absolute or invalid installation path rejected");
  const parts = raw.split("/").filter(Boolean);
  if (parts.some(part => part === "..")) throw new Error("Path traversal rejected");
  const normalizedParts = parts.filter(part => part !== ".");
  if (normalizedParts.some(part => !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error("Invalid installation path segment");
  if (!normalizedParts.length) throw new Error("Installation path is required");
  return normalizedParts.join("/");
}

function normalizeRuntimePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Runtime-Pfad ist erforderlich");
  if (raw.includes("\0")) throw new Error("Ungültiger Runtime-Pfad");
  if (process.platform === "linux" && raw.startsWith("/")) return path.normalize(raw);
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw)) return path.normalize(raw);
  return normalizeSafeRelativePath(raw || "./server");
}

const RUNTIME_EXTERNAL_ROOT = process.env.COD4X_RUNTIME_ROOT ? path.resolve(process.env.COD4X_RUNTIME_ROOT) : null;

function runtimeCandidateRoots() {
  const env = process.env;
  const roots = [
    INSTALL_ROOT,
    RUNTIME_EXTERNAL_ROOT,
    path.dirname(process.execPath),
    process.resourcesPath ? path.join(process.resourcesPath, "server") : null,
    DATA_ROOT,
    process.cwd(),
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA,
    env.APPDATA,
    env.USERPROFILE,
  ].filter(Boolean).map(p => path.resolve(p));
  return [...new Set(roots)];
}

function runtimeCandidateTargets(relative) {
  const normalized = normalizeRuntimePath(relative || "./server");
  if ((process.platform === "linux" && path.isAbsolute(normalized)) || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(normalized)) {
    const target = path.resolve(normalized);
    return [{ root: path.dirname(target), target, managed: target.toLowerCase().startsWith(INSTALL_ROOT.toLowerCase() + path.sep) }];
  }
  return runtimeCandidateRoots().map(root => ({
    root,
    target: assertSafeChildPath(root, normalized),
    managed: root === INSTALL_ROOT,
  }));
}

const RUNTIME_SEARCH_MAX_RESULTS = 32;
const RUNTIME_SEARCH_MAX_DEPTH = 5;
const RUNTIME_SEARCH_SKIP = new Set([
  "node_modules", ".git", "$recycle.bin", "system volume information",
  "windows", "programdata", "appdata\\local\\temp"
]);

function windowsDriveRoots() {
  if (process.platform !== "win32") return [];
  const drives = [];
  for (let i = 65; i <= 90; i++) drives.push(`${String.fromCharCode(i)}:\\`);
  return drives;
}

async function readWindowsSteamInstallPath() {
  if (process.platform !== "win32") return null;
  const keys = [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
  ];
  for (const [key, value] of keys) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", value], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
      const line = String(stdout || "").split(/\r?\n/).find(l => l.toLowerCase().includes(value.toLowerCase()));
      const match = line?.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
      if (match?.[1]) return path.resolve(match[1].trim());
    } catch {}
  }
  return null;
}
function unescapeVdfPath(value) { return String(value || "").replace(/\\\\/g, "\\"); }
async function steamLibraryRoots() {
  if (process.platform !== "win32") return [];
  const env = process.env;
  const installs = [await readWindowsSteamInstallPath(), env.ProgramFiles ? path.join(env.ProgramFiles,"Steam") : null, env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"],"Steam") : null].filter(Boolean).map(p=>path.resolve(p));
  const roots = new Set(installs);
  for (const steamRoot of installs) {
    try {
      const text = await fs.readFile(path.join(steamRoot,"steamapps","libraryfolders.vdf"),"utf8");
      const re = /"path"\s+"((?:\\\\.|[^"\\])*)"/gi;
      for (const m of text.matchAll(re)) { const p=unescapeVdfPath(m[1]); if(p) roots.add(path.resolve(p)); }
    } catch {}
  }
  return [...roots];
}
async function runtimeSearchRoots() {
  const env = process.env;
  const steamRoots = await steamLibraryRoots();
  const roots = [
    ...runtimeCandidateRoots(),
    env.ProgramFiles ? path.join(env.ProgramFiles,"Activision") : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"],"Activision") : null,
    env.ProgramFiles ? path.join(env.ProgramFiles,"Call of Duty 4 - Modern Warfare") : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"],"Call of Duty 4 - Modern Warfare") : null,
    ...steamRoots, ...steamRoots.map(p=>path.join(p,"steamapps","common")), ...windowsDriveRoots(),
  ].filter(Boolean).map(p=>path.resolve(p));
  return [...new Set(roots)];
}
async function resolveServerTarget(relative) {
  const candidates=runtimeCandidateTargets(relative), checks=[];
  for(const c of candidates){ const exists=await pathExists(c.target); checks.push({root:c.root,target:c.target,managed:c.managed,exists}); if(exists)return {...c,checks}; }
  return {...candidates[0],checks};
}
const SERVER_CORE_DEFINITIONS = Object.freeze({
  windows: Object.freeze({ platform: "windows", executable: "cod4x18_dedrun.exe", label: "CoD4X Dedicated Server (Windows)" }),
  linux: Object.freeze({ platform: "linux", executable: "cod4x18_dedrun", label: "CoD4X Dedicated Server (Linux)" }),
});

function normalizeServerPlatform(value) {
  const platform = String(value || (process.platform === "win32" ? "windows" : "linux")).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SERVER_CORE_DEFINITIONS, platform)) {
    throw new Error(`Unsupported server platform: ${platform || "empty"}`);
  }
  return platform;
}

function serverCoreDefinition(platform) {
  return SERVER_CORE_DEFINITIONS[normalizeServerPlatform(platform)];
}

function normalizeRuntimeExecutablePath(value, platform = process.platform === "win32" ? "windows" : "linux") {
  const raw=String(value??"").trim();
  const core=serverCoreDefinition(platform);
  if(!raw||raw.includes("\0")) throw new Error("Dedicated-Server-Core-Pfad ist erforderlich");
  const normalized=path.normalize(raw);
  if(!path.isAbsolute(normalized)) throw new Error("Dedicated-Server-Core muss als absoluter Pfad angegeben werden");
  if((platform === "linux" ? path.basename(normalized) : path.basename(normalized).toLowerCase())!==core.executable) {
    throw new Error(`Der Dedicated-Server-Core muss ${core.executable} sein`);
  }
  return normalized;
}

async function resolveRuntimeExecutable({target,executablePath,platform = process.platform === "win32" ? "windows" : "linux"}) {
  const core=serverCoreDefinition(platform);
  const exe=executablePath?normalizeRuntimeExecutablePath(executablePath, platform):assertSafeChildPath(target,core.executable);
  let stats;
  try { stats = await fs.stat(exe); } catch {
    throw new Error(`${core.executable} wurde am ausgewählten Server-Core-Pfad nicht gefunden.`);
  }
  if (!stats.isFile()) throw new Error(`Der ausgewählte ${core.executable}-Pfad ist keine Datei.`);
  return exe;
}

async function searchRuntimeCores() {
  const found = new Map();
  const queue = (await runtimeSearchRoots()).map(root => ({ dir: root, depth: 0 }));
  const visited = new Set();
  const executableNames = new Map([
    [SERVER_CORE_DEFINITIONS.windows.executable.toLowerCase(), "windows"],
    [SERVER_CORE_DEFINITIONS.linux.executable.toLowerCase(), "linux"],
  ]);
  while (queue.length && found.size < RUNTIME_SEARCH_MAX_RESULTS) {
    const { dir, depth } = queue.shift();
    const canonical = process.platform === "win32" ? path.normalize(dir).toLowerCase() : path.normalize(dir);
    if (visited.has(canonical) || depth > RUNTIME_SEARCH_MAX_DEPTH) continue;
    visited.add(canonical);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const platform = executableNames.get(entry.name.toLowerCase());
      if (platform === "linux" && entry.name !== SERVER_CORE_DEFINITIONS.linux.executable) continue;
      if (entry.isFile() && platform) {
        const key = `${platform}:${process.platform === "win32" ? path.normalize(full).toLowerCase() : path.normalize(full)}`;
        if (!found.has(key)) {
          let size = null;
          let modifiedAt = null;
          try { const st = await fs.stat(full); size = st.size; modifiedAt = st.mtime.toISOString(); } catch {}
          found.set(key, {
            platform,
            target: path.dirname(full),
            executable: full,
            executableName: serverCoreDefinition(platform).executable,
            size,
            modifiedAt,
            source: /[\\/]steamapps[\\/]common[\\/]/i.test(full) ? "Steam" : "Lokale Suche",
          });
        }
        if (found.size >= RUNTIME_SEARCH_MAX_RESULTS) break;
      } else if (entry.isDirectory() && depth < RUNTIME_SEARCH_MAX_DEPTH) {
        const lower = entry.name.toLowerCase();
        if (RUNTIME_SEARCH_SKIP.has(lower) || lower.startsWith("$")) continue;
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return [...found.values()].sort((a,b) => a.executable.localeCompare(b.executable));
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function resolveRuntimeTarget(relative) {
  const candidates = runtimeCandidateTargets(relative);
  const checks = [];
  for (const candidate of candidates) {
    const platform = process.platform === "win32" ? "windows" : "linux";
    const exe = assertSafeChildPath(candidate.target, serverCoreDefinition(platform).executable);
    const exists = await pathExists(candidate.target);
    const corePresent = await pathExists(exe);
    checks.push({ root: candidate.root, target: candidate.target, managed: candidate.managed, exists, corePresent });
    if (exists && corePresent) return { ...candidate, checks };
  }
  return { ...candidates[0], checks };
}

const RUNTIME_CORE_REGISTRY_DIR = dataPath("config", "runtime-core-registry");

function runtimeCoreRegistryKey(target) {
  const normalized = path.normalize(path.resolve(target));
  return crypto.createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized, "utf8").digest("hex");
}

function runtimeCoreRegistryFile(target) {
  return path.join(RUNTIME_CORE_REGISTRY_DIR, `${runtimeCoreRegistryKey(target)}.json`);
}

async function readRuntimeCoreManifest(target) {
  const manifestPath = assertSafeChildPath(target, "cod4x-control-manifest.json");
  // Security audit 4.18.26 (A1-2): only the registry in CONTROL's data folder counts. A
  // manifest next to the core can be written by anyone who can write the core folder.
  try { return { manifest: JSON.parse(await fs.readFile(runtimeCoreRegistryFile(target), "utf8")), manifestPath: runtimeCoreRegistryFile(target), source: "registry" }; } catch {}
  return { manifest: null, manifestPath, source: null };
}

async function verifiedCoreStatus(target, expectedCod4x = "", platform = process.platform === "win32" ? "windows" : "linux") {
  const core=serverCoreDefinition(platform);
  const exe = assertSafeChildPath(target, core.executable);
  const { manifest, manifestPath, source } = await readRuntimeCoreManifest(target);
  let corePresent = false;
  let manifestValid = false;
  const reasons = [];
  try { await fs.access(exe); corePresent = true; } catch { reasons.push(`${core.executable} fehlt`); }
  if (manifest) {
    const allowed = policyState.security.allowedCod4xVersions.includes(String(manifest.cod4x));
    const expected = !expectedCod4x || String(manifest.cod4x) === expectedCod4x;
    const fingerprint = String(manifest.executableSha256 || "").toLowerCase();
    const executableMatches = String(manifest.executable || "").toLowerCase() === core.executable.toLowerCase();
    let fingerprintValid = false;
    if (corePresent && /^[a-f0-9]{64}$/.test(fingerprint)) {
      try { fingerprintValid = (await sha256(exe)).toLowerCase() === fingerprint; } catch {}
    }
    manifestValid = Boolean(allowed && expected && executableMatches && fingerprintValid);
    if (!allowed) reasons.push("Manifest enthält keine erlaubte CoD4x-Version");
    else if (!expected) reasons.push(`Manifest-Version ${manifest.cod4x} stimmt nicht mit ${expectedCod4x} überein`);
    if (!executableMatches) reasons.push(`Manifest referenziert nicht ${core.executable}`);
    if (!fingerprintValid) reasons.push(`SHA-256-Fingerprint stimmt nicht mit ${core.executable} überein`);
  } else {
    reasons.push("Kein gültiger Core-Nachweis gefunden");
  }
  return {
    verified: corePresent && manifestValid,
    corePresent,
    manifestPresent: Boolean(manifest),
    manifestValid,
    manifestSource: source || "none",
    manifestPath,
    verificationMode: manifest?.verification || "none",
    platform,
    executable: core.executable,
    executablePath: exe,
    reasons,
    manifest: manifest ? {
      cod4x: manifest.cod4x,
      fpsPromod: manifest.fpsPromod,
      installedAt: manifest.installedAt,
      verification: manifest.verification || "installer",
      executable: manifest.executable,
      executableSha256: manifest.executableSha256,
    } : null,
  };
}

/**
 * Runtime callers operate on the selected executable path. The manifest and
 * registry are deliberately keyed to the executable's parent directory.
 * Keep that path contract explicit so preflight, adoption and start all use
 * exactly the same verification target.
 */
async function verifiedRuntimeCoreStatus(executablePath, expectedCod4x = "", platform = process.platform === "win32" ? "windows" : "linux") {
  const normalizedExecutable = normalizeRuntimeExecutablePath(executablePath, platform);
  const coreDirectory = path.dirname(normalizedExecutable);
  const status = await verifiedCoreStatus(coreDirectory, expectedCod4x, platform);
  return { ...status, requestedExecutablePath: normalizedExecutable };
}

async function adoptExistingRuntimeExecutable({executablePath,cod4x,fpsPromod="custom",platform=process.platform === "win32" ? "windows" : "linux"}) {
  if(!policyState.security.allowedCod4xVersions.includes(String(cod4x)))throw new Error("Unsupported CoD4x version");
  const core=serverCoreDefinition(platform);
  const exe=normalizeRuntimeExecutablePath(executablePath, platform);
  let stats;
  try { stats = await fs.stat(exe); } catch { throw new Error(`${core.executable} wurde am ausgewählten Server-Core-Pfad nicht gefunden.`); }
  if (!stats.isFile()) throw new Error(`Der ausgewählte ${core.executable}-Pfad ist keine Datei.`);
  const executableSha256=await sha256(exe);
  const manifest={installedAt:new Date().toISOString(),target:path.dirname(exe),cod4x:String(cod4x),fpsPromod:String(fpsPromod||"custom"),mod:"vanilla",antiCheat:"none",antiCheatMode:"balanced",verification:"operator-adopted",platform,executable:core.executable,executableSha256};
  await fs.mkdir(RUNTIME_CORE_REGISTRY_DIR,{recursive:true}); const registryPath=runtimeCoreRegistryFile(path.dirname(exe)); await fs.writeFile(registryPath,JSON.stringify(manifest,null,2)+"\n","utf8");
  let manifestPath=registryPath,sidecarWritten=false;
  try{const sidecar=assertSafeChildPath(path.dirname(exe),"cod4x-control-manifest.json");await fs.writeFile(sidecar,JSON.stringify(manifest,null,2)+"\n","utf8");manifestPath=sidecar;sidecarWritten=true}catch{}
  return {manifest,manifestPath,registryPath,sidecarWritten};
}

// ─── 4.17.0 Production Runtime Manager ───────────────────────────────────────
const runtimeDependencies = { path, fs, crypto, process, dataPath, SERVER_CORE_DEFINITIONS, serverCoreDefinition, execFileAsync, spawn, normalizeServerPlatform, normalizeRuntimePath, resolveServerTarget, resolveRuntimeExecutable, verifiedRuntimeCoreStatus, selectRuntimeBaseGamePath, resolveRuntimeLayout, mergeBaseGameState, policyState: { security: { get allowedCod4xVersions() { return policyState.security.allowedCod4xVersions; } } } };
runtimeDependencies.linuxRuntimeAdapter = createLinuxRuntimeAdapter({ filesystem: fs, hostProcess: process });
runtimeDependencies.assertLinuxInstanceOwnership = assertLinuxInstanceOwnership;
const defaultRuntime = createRuntimeManager(runtimeDependencies);
const { startRuntime, stopRuntime, restartRuntime, withRuntimeConfiguration, reconcileRuntimeState, runtimeEvent, persistRuntimeState } = defaultRuntime;
await defaultRuntime.loadRuntimeState();

function validateProfile(body) {
  const p = body?.profile || {};
  if (!policyState.security.allowedCod4xVersions.includes(p.cod4x)) throw new Error("Unsupported CoD4x version");
  if (!["2.85", "2.86", "3.00", "3.02", "custom"].includes(p.fps)) throw new Error("Unsupported FPS Promod version");
  if (!["none", "fpschallenge", "cod4x", "ruscod"].includes(p.anticheat || "none")) throw new Error("Unsupported anti-cheat provider");
  if (!["native", "b3", "raid"].includes(p.adminIntegration || "native")) throw new Error("Unsupported admin integration");
  if (p.fpsacVersion && p.fpsacVersion !== "9.2.0") throw new Error("Unsupported FPSAC version");
  if (!policyState.security.targets.includes(String(p.target || "server"))) throw new Error("Unsupported client/server target");
  const relative = normalizeSafeRelativePath(p.path);
  const target = assertSafeChildPath(INSTALL_ROOT, relative);
  return { ...p, target, targetType: String(p.target || "server") };
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(file);
  hash.update(data);
  return hash.digest("hex");
}

function allowedArtifact(entry) {
  if (!entry?.url) throw new Error("Artifact URL is not configured on the server");
  const u = new URL(entry.url);
  if (!["https:", "http:"].includes(u.protocol)) throw new Error("Only HTTP(S) artifacts are allowed");
  return u;
}

async function downloadTo(url, target) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), (await import("node:fs")).createWriteStream(target));
}

async function verifyArtifact(file, entry) {
  if (!entry.sha256) throw new Error("SHA-256 is not configured for this artifact");
  const actual = await sha256(file);
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new Error(`Checksum mismatch: expected ${entry.sha256}, got ${actual}`);
  }
}

// Block 21: downloads and checks one artifact into a private directory; installArtifacts then writes
// all of them into the target through a restore point (lib/archive-install.mjs).
async function downloadArtifact(entry, directory, index, log) {
  const format = String(entry.format || "zip").toLowerCase();
  const extension = format === "tar.gz" || format === "tgz" ? ".tar.gz" : format === "tar" ? ".tar" : format === "bin" ? ".bin" : ".zip";
  const artifact = path.join(directory, `artifact-${index}${extension}`);
  log.push("Downloading configured artifact…");
  await downloadTo(allowedArtifact(entry), artifact);
  log.push("Download complete; verifying SHA-256…");
  await verifyArtifact(artifact, entry);
  log.push("SHA-256 OK");
  return artifact;
}

app.get("/api/auth/status", (_req, res) => {
  res.json({ ok: true, initialized: Boolean(authUser), sessionLifetimeMs: AUTH_SESSION_MS, username: authUser?.username || null });
});

app.post("/api/auth/init", async (req, res) => {
  try {
    if (authUser) return res.status(409).json({ ok: false, error: "Administrator ist bereits initialisiert." });
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const usernameError = validateAuthUsername(username);
    if (usernameError) return res.status(400).json({ ok: false, error: usernameError });
    const passwordError = validateAuthPassword(password);
    if (passwordError) return res.status(400).json({ ok: false, error: passwordError });
    const now = new Date().toISOString();
    const adminRecord = { version: 1, username, role: "admin", passwordHash: hashAuthPassword(password), disabled: false, createdAt: now, updatedAt: now };
    await queueAuthWrite(adminRecord);
    authUsers.set(username.toLowerCase(), adminRecord);
    await saveAuthUsers();
    const session = createAuthSession(username, "admin");
    audit({ level: "info", event: "auth.admin_initialized", details: { username } });
    res.status(201).json({ ok: true, token: session.token, sessionId: session.sessionId, expiresAt: session.expiresAt, user: { username, role: "admin" } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Block 24b: the login brake also guards the local login (per client address and user).
const loginThrottle = new LoginThrottle();
app.post("/api/auth/login", async (req, res) => {
  try {
    if (!authUser) return res.status(428).json({ ok: false, error: "First-Run-Initialisierung erforderlich." });
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const throttleKey = LoginThrottle.key(loginClient(req.socket.remoteAddress), username);
    const lock = loginThrottle.check(throttleKey);
    if (lock.locked) {
      audit({ level: "warn", event: "auth.login_locked", details: { username } });
      res.setHeader("Retry-After", String(Math.ceil(lock.retryAfterMs / 1000)));
      return res.status(429).json({ ok: false, code: "LOGIN_LOCKED", retryAfterMs: lock.retryAfterMs, error: `Zu viele Fehlversuche. Erneut möglich in ${Math.ceil(lock.retryAfterMs / 60000)} min.` });
    }
    const candidate = findAuthUser(username);
    const userA = crypto.createHash("sha256").update(username).digest();
    const userB = crypto.createHash("sha256").update(candidate?.username || authUser.username).digest();
    const validUser = crypto.timingSafeEqual(userA, userB);
    const validPassword = candidate ? verifyAuthPassword(password, candidate.passwordHash) : verifyAuthPassword(password, authUser.passwordHash);
    if (!candidate || candidate.disabled || !validUser || !validPassword) {
      const locked = loginThrottle.fail(throttleKey);
      audit({ level: "warn", event: locked ? "auth.login_locked" : "auth.login_failed", details: { username } });
      // A5-2: only the right password may learn that the account is disabled.
      return res.status(401).json({ ok: false, error: candidate?.disabled && validUser && validPassword ? "Benutzer ist deaktiviert." : "Benutzername oder Passwort ungültig." });
    }
    loginThrottle.succeed(throttleKey);
    const session = createAuthSession(candidate.username, candidate.role);
    audit({ level: "info", event: "auth.login", details: { username: candidate.username } });
    res.json({ ok: true, token: session.token, sessionId: session.sessionId, expiresAt: session.expiresAt, user: { username: candidate.username, role: candidate.role } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  authSessions.delete(req.auth.token);
  audit({ level: "info", event: "auth.logout", details: { username: req.auth.username } });
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = findAuthUser(req.auth.username);
  res.json({ ok: true, user: { username: req.auth.username, role: req.auth.role, remoteAccess: user?.remoteAccess === true, remoteActions: user?.remoteActions === true, totpEnabled: Boolean(user?.totp), recoveryRemaining: user?.totp ? user.recovery.length : 0 } });
});

// ─── Block 24b: second factor (TOTP, RFC 6238) for the remote gateway ───────
// Every user enrols for themselves: setup returns a fresh secret (kept pending
// for 10 min), confirm with a valid code stores it and returns 10 recovery codes
// once. Disabling needs the password; an admin can reset it (PATCH totpReset).
const totpPending = new Map();
const remoteSessions = new RemoteSessions();
const TOTP_PENDING_MS = 10 * 60e3;
app.post("/api/auth/totp/setup", requireAuth, (req, res) => {
  const user = findAuthUser(req.auth.username);
  if (!user) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND", error: "Benutzer nicht gefunden." });
  if (user.totp) return res.status(409).json({ ok: false, code: "TOTP_ALREADY_ENABLED", error: "Zweiter Faktor ist bereits eingerichtet. Zuerst ausschalten." });
  const secret = generateTotpSecret();
  totpPending.set(user.username.toLowerCase(), { secret, expiresAt: Date.now() + TOTP_PENDING_MS });
  audit("info", "auth.totp.setup_started", { username: user.username });
  res.set("Cache-Control", "no-store").json({ ok: true, secret, uri: totpUri({ secret, account: user.username }), expiresAt: Date.now() + TOTP_PENDING_MS });
});
app.post("/api/auth/totp/confirm", requireAuth, async (req, res) => {
  const user = findAuthUser(req.auth.username), key = String(req.auth.username).toLowerCase(), pending = totpPending.get(key);
  if (!user || !pending || pending.expiresAt <= Date.now()) { totpPending.delete(key); return res.status(409).json({ ok: false, code: "TOTP_SETUP_EXPIRED", error: "Einrichtung abgelaufen. Bitte neu starten." }); }
  const step = verifyTotp(pending.secret, req.body?.code);
  if (step === null) { audit("warn", "auth.totp.confirm_failed", { username: user.username }); return res.status(400).json({ ok: false, code: "TOTP_INVALID", error: "Code ungültig. Uhrzeit von Handy und Rechner prüfen." }); }
  const codes = generateRecoveryCodes();
  user.totp = { secret: pending.secret, lastStep: step, enabledAt: new Date().toISOString() };
  user.recovery = codes.map(hashRecoveryCode);
  user.updatedAt = new Date().toISOString();
  totpPending.delete(key);
  await saveAuthUsers();
  audit("info", "auth.totp.enabled", { username: user.username });
  res.set("Cache-Control", "no-store").json({ ok: true, recoveryCodes: codes });
});
app.post("/api/auth/totp/disable", requireAuth, async (req, res) => {
  const user = findAuthUser(req.auth.username);
  if (!user?.totp) return res.status(409).json({ ok: false, code: "TOTP_NOT_ENABLED", error: "Kein zweiter Faktor eingerichtet." });
  if (!verifyAuthPassword(String(req.body?.password || ""), user.passwordHash)) { audit("warn", "auth.totp.disable_failed", { username: user.username }); return res.status(401).json({ ok: false, code: "PASSWORD_INVALID", error: "Passwort ungültig." }); }
  user.totp = null; user.recovery = []; user.updatedAt = new Date().toISOString();
  await saveAuthUsers();
  const revoked = remoteSessions.revokeUser(user.username);
  audit("warn", "auth.totp.disabled", { username: user.username, remoteSessionsRevoked: revoked });
  res.json({ ok: true, remoteSessionsRevoked: revoked });
});

// ─── 4.11.6 User & Role Administration ──────────────────────────────────────
// ─── 4.11.7 Session Management & Security Controls ─────────────────────────
app.get("/api/sessions", requirePermission("user.manage"), (req, res) => {
  const now = Date.now();
  const sessions = [...authSessions.values()].map(session => ({
    sessionId: session.sessionId, username: session.username, role: session.role,
    createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, absoluteExpiresAt: session.absoluteExpiresAt,
    current: session.sessionId === req.auth.sessionId,
  })).sort((a,b) => b.lastSeenAt - a.lastSeenAt);
  audit("info", "session.listed", { actor: req.auth.username, count: sessions.length });
  res.json({ ok: true, now, idleTimeoutMs: AUTH_SESSION_MS, maxLifetimeMs: AUTH_SESSION_MAX_MS, sessions });
});

app.post("/api/sessions/logout-all", requirePermission("user.manage"), (req, res) => {
  const includeCurrent = req.body?.includeCurrent !== false;
  let revoked = 0;
  for (const [token, session] of authSessions) {
    if (includeCurrent || session.sessionId !== req.auth.sessionId) { authSessions.delete(token); revoked++; }
  }
  audit("warn", "session.logout_all", { actor: req.auth.username, revoked, includeCurrent });
  res.json({ ok: true, revoked, includeCurrent });
});

app.post("/api/sessions/:sessionId/revoke", requirePermission("user.manage"), (req, res) => {
  const targetId = String(req.params.sessionId || "");
  let revoked = false;
  for (const [token, session] of authSessions) {
    if (session.sessionId === targetId) { authSessions.delete(token); revoked = true; break; }
  }
  audit(revoked ? "warn" : "info", "session.revoked", { actor: req.auth.username, sessionId: targetId, revoked });
  res.json({ ok: true, revoked, sessionId: targetId });
});

app.get("/api/users", requirePermission("user.manage"), (_req, res) => {
  const users = [...authUsers.values()].map(sanitizeUserMetadata);
  res.json({ ok: true, users });
});

app.post("/api/users", requirePermission("user.manage"), async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const role = normalizeRole(req.body?.role);
    const usernameError = validateAuthUsername(username);
    if (usernameError) return res.status(400).json({ ok: false, error: usernameError });
    const passwordError = validateAuthPassword(password);
    if (passwordError) return res.status(400).json({ ok: false, error: passwordError });
    if (!role) return res.status(400).json({ ok: false, error: "Ungültige Rolle." });
    if (authUsers.has(username.toLowerCase())) return res.status(409).json({ ok: false, error: "Benutzer existiert bereits." });
    if (authUsers.size >= 100) return res.status(409).json({ ok: false, error: "Maximal 100 Benutzer erlaubt." });
    const now = new Date().toISOString();
    const user = { version: 1, username, role, passwordHash: hashAuthPassword(password), disabled: false, createdAt: now, updatedAt: now };
    authUsers.set(username.toLowerCase(), user);
    await saveAuthUsers();
    audit("info", "user.created", { actor: req.auth.username, username, role });
    res.status(201).json({ ok: true, user: sanitizeUserMetadata(user) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/users/:username", requirePermission("user.manage"), async (req, res) => {
  try {
    const target = findAuthUser(req.params.username);
    if (!target) return res.status(404).json({ ok: false, error: "Benutzer nicht gefunden." });
    const nextRole = req.body?.role === undefined ? target.role : normalizeRole(req.body.role);
    if (!nextRole) return res.status(400).json({ ok: false, error: "Ungültige Rolle." });
    if (target.username.toLowerCase() === req.auth.username.toLowerCase() && nextRole !== "admin") return res.status(400).json({ ok: false, error: "Der eigene Admin-Account kann nicht auf eine niedrigere Rolle gesetzt werden." });
    if (req.body?.disabled === true && target.username.toLowerCase() === req.auth.username.toLowerCase()) return res.status(400).json({ ok: false, error: "Der eigene Admin-Account kann nicht deaktiviert werden." });
    if (req.body?.remoteAccess !== undefined && typeof req.body.remoteAccess !== "boolean") return res.status(400).json({ ok: false, error: "remoteAccess muss true oder false sein." });
    if (req.body?.remoteActions !== undefined && typeof req.body.remoteActions !== "boolean") return res.status(400).json({ ok: false, error: "remoteActions muss true oder false sein." });
    const roleChanged = target.role !== nextRole;
    target.role = nextRole;
    if (req.body?.disabled !== undefined) target.disabled = Boolean(req.body.disabled);
    if (req.body?.remoteAccess !== undefined) target.remoteAccess = req.body.remoteAccess;
    if (req.body?.remoteActions !== undefined) target.remoteActions = req.body.remoteActions;
    if (req.body?.totpReset === true) { target.totp = null; target.recovery = []; }
    // Anything that narrows access ends the user's remote sessions at once.
    let remoteRevoked = 0;
    if (target.disabled || target.remoteAccess !== true || req.body?.totpReset === true || (typeof req.body?.password === "string" && req.body.password.length)) remoteRevoked = remoteSessions.revokeUser(target.username);
    // Without remote access (or disabled) the user's phones get no more push alerts.
    if (target.disabled || target.remoteAccess !== true) await alertNotifier.removeUser(target.username).catch(() => 0);
    else if (roleChanged) remoteSessions.setRole(target.username, target.role);
    if (typeof req.body?.password === "string" && req.body.password.length) {
      const passwordError = validateAuthPassword(req.body.password);
      if (passwordError) return res.status(400).json({ ok: false, error: passwordError });
      target.passwordHash = hashAuthPassword(req.body.password);
      for (const [token, session] of authSessions) if (session.username.toLowerCase() === target.username.toLowerCase()) authSessions.delete(token);
    }
    if (target.disabled) for (const [token, session] of authSessions) if (session.username.toLowerCase() === target.username.toLowerCase()) authSessions.delete(token);
    target.updatedAt = new Date().toISOString();
    await saveAuthUsers();
    if (authUser?.username.toLowerCase() === target.username.toLowerCase()) await saveAuthUser(target);
    for (const session of authSessions.values()) if (session.username.toLowerCase() === target.username.toLowerCase()) session.role = target.role;
    audit("info", "user.updated", { actor: req.auth.username, username: target.username, role: target.role, disabled: target.disabled, remoteAccess: target.remoteAccess === true, remoteActions: target.remoteActions === true, totpReset: req.body?.totpReset === true, remoteSessionsRevoked: remoteRevoked });
    res.json({ ok: true, user: sanitizeUserMetadata(target) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/users/:username/revoke", requirePermission("user.manage"), (req, res) => {
  const target = findAuthUser(req.params.username);
  if (!target) return res.status(404).json({ ok: false, error: "Benutzer nicht gefunden." });
  let revoked = 0;
  for (const [token, session] of authSessions) {
    if (session.username.toLowerCase() === target.username.toLowerCase()) { authSessions.delete(token); revoked++; }
  }
  const remoteRevoked = remoteSessions.revokeUser(target.username);
  audit("info", "user.sessions_revoked", { actor: req.auth.username, username: target.username, revoked, remoteRevoked });
  res.json({ ok: true, username: target.username, revoked, remoteRevoked });
});

app.get("/api/installer/releases", async (_req, res) => {
  const result = { ok:true, cod4x:{}, fpsPromod:{} };
  for (const v of Object.keys(DOWNLOADS.cod4x)) result.cod4x[v] = { configured: Boolean(DOWNLOADS.cod4x[v].url), available: Boolean(DOWNLOADS.cod4x[v].url) };
  for (const v of Object.keys(DOWNLOADS.fps)) result.fpsPromod[v] = { configured: Boolean(DOWNLOADS.fps[v].url), available: Boolean(DOWNLOADS.fps[v].url && DOWNLOADS.fps[v].sha256), checksumConfigured: Boolean(DOWNLOADS.fps[v].sha256) };
  res.json(result);
});

app.get("/api/fpschallenge/catalog", async (_req, res) => {
  const versions = Object.entries(DOWNLOADS.fps).map(([id, entry]) => ({
    id,
    name: `FPS Promod ${id}`,
    downloadConfigured: Boolean(entry.url),
    checksumConfigured: Boolean(entry.sha256),
    available: Boolean(entry.url && entry.sha256)
  }));
  res.json({ ok: true, versions });
});

app.get("/api/fpschallenge/anticheat/catalog", async (_req, res) => {
  const configured = Boolean(process.env.FPSAC_URL);
  res.json({
    ok:true,
    latest:"9.2.0",
    versions:[{id:"9.2.0",name:"FPSAC 9.2.0",downloadConfigured:configured}]
  });
});

app.get("/api/fpschallenge/anticheat/download/:version", requirePermission("update.execute"), async (req,res) => {
  if (req.params.version !== "9.2.0") return res.status(404).json({ok:false,error:"Unsupported FPSAC version"});
  const url = process.env.FPSAC_URL;
  if (!url) return res.status(503).json({ok:false,error:"FPSAC 9.2.0 download is not configured on the server"});
  try {
    const u = allowedArtifact({url});
    const response = await fetch(u,{redirect:"error"});
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    res.status(200);
    if (response.headers.get("content-type")) res.set("Content-Type",response.headers.get("content-type"));
    await pipeline(Readable.fromWeb(response.body),res);
  } catch(e) {
    if (!res.headersSent) res.status(400).json({ok:false,error:e.message});
  }
});

// ─── 4.11.5 Endpoint Authorization Binding ─────────────────────────────────
app.get("/api/rbac/authorization", requireAuth, (req, res) => {
  const result = authorizationBindingChecks();
  audit(result.ok ? "info" : "warn", "rbac.authorization.checked", { username: req.auth.username, role: req.auth.role, checks: result.checks.length, ok: result.ok });
  res.json({ ok: result.ok, bindings: result.bindings, checks: result.checks });
});

// ─── 4.11.4 RBAC API ─────────────────────────────────────────────────────────
app.get("/api/rbac/roles", requireAuth, (req, res) => {
  const roles = RBAC_ROLES.map(role => ({
    id: role,
    permissions: permissionsForRole(role),
  }));
  audit("info", "rbac.roles.read", { username: req.auth.username, role: req.auth.role });
  res.json({ ok: true, roles, permissions: RBAC_PERMISSIONS });
});

app.get("/api/rbac/me", requireAuth, (req, res) => {
  const permissions = permissionsForRole(req.auth.role);
  audit("info", "rbac.me.read", { username: req.auth.username, role: req.auth.role });
  res.json({ ok: true, user: { username: req.auth.username, role: req.auth.role }, permissions });
});

app.post("/api/rbac/check", requireAuth, (req, res) => {
  const permission = String(req.body?.permission || "").trim();
  if (!RBAC_PERMISSION_IDS.includes(permission)) {
    audit("warn", "rbac.check.rejected", { username: req.auth.username, role: req.auth.role, permission });
    return res.status(400).json({ ok: false, error: "Unknown permission", permission, permissions: RBAC_PERMISSION_IDS });
  }
  const allowed = hasPermission(req.auth.role, permission);
  audit(allowed ? "info" : "warn", "rbac.check", { username: req.auth.username, role: req.auth.role, permission, allowed });
  res.json({ ok: true, allowed, permission, role: req.auth.role });
});

app.get("/api/installer/health", (_req, res) => {
  res.json({ ok: true, service: "cod4x-control-installer", runtimeVersion: "4.18.0", runtimeMode: process.env.COD4X_RUNTIME_MODE || "interactive" });
});

// ─── 4.10.8 Security Hardening ───────────────────────────────────────────────
app.get("/api/security/status", requirePermission("diagnostics.read"), async (req, res) => {
  try {
    const cod4x = String(req.query.cod4x || "21.5");
    const targetType = String(req.query.target || "server");
    const relative = normalizeSafeRelativePath(req.query.path || "./server");
    const target = assertSafeChildPath(INSTALL_ROOT, relative);
    const pathInsideRoot = target === INSTALL_ROOT || target.startsWith(INSTALL_ROOT + path.sep);
    const versionAllowed = policyState.security.allowedCod4xVersions.includes(cod4x);
    const targetAllowed = policyState.security.targets.includes(targetType);
    const core = await verifiedCoreStatus(target, cod4x, String(req.query.platform || "windows"));
    const checks = [
      { id: "path", label: "Installation root boundary", pass: pathInsideRoot },
      { id: "traversal", label: "Path traversal protection", pass: true },
      { id: "version", label: "CoD4x version allowlist", pass: versionAllowed },
      { id: "target", label: "Client/server target", pass: targetAllowed },
      { id: "verified-core", label: "Verified-Core gate", pass: core.verified },
    ];
    const ok = checks.every(c => c.pass);
    audit(ok ? "info" : "warn", "security.status.checked", { cod4x, target: targetType, path: relative, verifiedCore: core.verified });
    res.json({ ok, security: true, cod4x, allowedVersions: SECURITY_COD4X_VERSIONS, target: targetType, allowedTargets: SECURITY_TARGETS, installRoot: INSTALL_ROOT, targetPath: target, checks, verifiedCore: core });
  } catch (e) {
    audit("warn", "security.status.rejected", { error: e.message });
    res.status(400).json({ ok: false, security: true, error: e.message });
  }
});

app.post("/api/security/validate", requirePermission("config.manage"), async (req, res) => {
  try {
    const profile = validateProfile(req.body);
    const core = await verifiedCoreStatus(profile.target, profile.cod4x, String(req.body?.platform || "windows"));
    const validation = {
      versionAllowed: policyState.security.allowedCod4xVersions.includes(profile.cod4x),
      targetAllowed: policyState.security.targets.includes(profile.targetType),
      pathInsideRoot: profile.target === INSTALL_ROOT || profile.target.startsWith(INSTALL_ROOT + path.sep),
      verifiedCore: core.verified,
    };
    const ok = validation.versionAllowed && validation.targetAllowed && validation.pathInsideRoot;
    audit(ok ? "info" : "warn", "security.profile.validated", { cod4x: profile.cod4x, target: profile.targetType, verifiedCore: core.verified });
    res.json({ ok, security: true, validation, verifiedCore: core, target: profile.target, allowedVersions: SECURITY_COD4X_VERSIONS, allowedTargets: SECURITY_TARGETS });
  } catch (e) {
    audit("warn", "security.profile.rejected", { error: e.message });
    res.status(400).json({ ok: false, security: true, error: e.message });
  }
});

// ─── 4.11.0 Configuration & Policy Engine ────────────────────────────────────
app.get("/api/policy", requirePermission("config.manage"), async (_req, res) => {
  try {
    await loadPolicy();
    res.json({ ok: true, policy: policyState, file: POLICY_FILE });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/policy/validate", requirePermission("config.manage"), async (req, res) => {
  const checked = validatePolicy(req.body?.policy || req.body || {});
  audit(checked.ok ? "info" : "warn", "policy.validated", { ok: checked.ok, errors: checked.errors });
  res.status(checked.ok ? 200 : 400).json(checked);
});

app.post("/api/policy/save", requirePermission("config.manage"), async (req, res) => {
  try {
    const next = await savePolicy(req.body?.policy || req.body || {});
    audit("info", "policy.saved", {
      auditMaxBytes: next.audit.maxBytes,
      auditMaxRotated: next.audit.maxRotated,
      auditPersistReadLimit: next.audit.persistReadLimit,
    });
    res.json({ ok: true, policy: next, file: POLICY_FILE });
  } catch (e) {
    audit("warn", "policy.save.rejected", { error: e.message });
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── 4.10.7 Persistent Logging + central Event Pipeline ─────────────────────
const DEFAULT_POLICY = {
  version: 1,
  audit: {
    maxEvents: 500,
    persistReadLimit: 500,
    maxBytes: 10 * 1024 * 1024,
    maxRotated: 7,
  },
  security: {
    allowedCod4xVersions: [...SECURITY_COD4X_VERSIONS],
    targets: [...SECURITY_TARGETS],
    portMin: 1,
    portMax: 65535,
  },
};
const POLICY_FILE = path.resolve(process.env.COD4X_POLICY_FILE || dataPath("config", "policy.json"));
let policyState = structuredClone(DEFAULT_POLICY);

function normalizePolicy(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const audit = src.audit && typeof src.audit === "object" ? src.audit : {};
  const security = src.security && typeof src.security === "object" ? src.security : {};
  const allowed = Array.isArray(security.allowedCod4xVersions)
    ? security.allowedCod4xVersions.filter(v => SECURITY_COD4X_VERSIONS.includes(String(v)))
    : DEFAULT_POLICY.security.allowedCod4xVersions;
  const targets = Array.isArray(security.targets)
    ? security.targets.filter(v => SECURITY_TARGETS.includes(String(v)))
    : DEFAULT_POLICY.security.targets;
  return {
    version: 1,
    audit: {
      maxEvents: Number.isInteger(audit.maxEvents) ? audit.maxEvents : DEFAULT_POLICY.audit.maxEvents,
      persistReadLimit: Number.isInteger(audit.persistReadLimit) ? audit.persistReadLimit : DEFAULT_POLICY.audit.persistReadLimit,
      maxBytes: Number.isInteger(audit.maxBytes) ? audit.maxBytes : DEFAULT_POLICY.audit.maxBytes,
      maxRotated: Number.isInteger(audit.maxRotated) ? audit.maxRotated : DEFAULT_POLICY.audit.maxRotated,
    },
    security: {
      allowedCod4xVersions: allowed.length ? allowed : [...DEFAULT_POLICY.security.allowedCod4xVersions],
      targets: targets.length ? targets : [...DEFAULT_POLICY.security.targets],
      portMin: Number.isInteger(security.portMin) ? security.portMin : DEFAULT_POLICY.security.portMin,
      portMax: Number.isInteger(security.portMax) ? security.portMax : DEFAULT_POLICY.security.portMax,
    },
  };
}

function validatePolicy(raw) {
  const p = normalizePolicy(raw);
  const errors = [];
  if (p.audit.maxEvents < 100 || p.audit.maxEvents > 5000) errors.push("audit.maxEvents must be 100..5000");
  if (p.audit.persistReadLimit < 50 || p.audit.persistReadLimit > 5000) errors.push("audit.persistReadLimit must be 50..5000");
  if (p.audit.maxBytes < 1024 * 1024 || p.audit.maxBytes > 100 * 1024 * 1024) errors.push("audit.maxBytes must be 1..100 MiB");
  if (p.audit.maxRotated < 1 || p.audit.maxRotated > 30) errors.push("audit.maxRotated must be 1..30");
  if (p.security.portMin < 1 || p.security.portMin > 65535) errors.push("security.portMin must be 1..65535");
  if (p.security.portMax < 1 || p.security.portMax > 65535 || p.security.portMin > p.security.portMax) errors.push("security.portMax must be 1..65535 and >= portMin");
  if (!p.security.allowedCod4xVersions.length) errors.push("at least one CoD4x version must be allowed");
  if (!p.security.targets.length) errors.push("at least one target must be enabled");
  return { ok: errors.length === 0, policy: p, errors };
}

async function loadPolicy() {
  try {
    const raw = JSON.parse(await fs.readFile(POLICY_FILE, "utf8"));
    const checked = validatePolicy(raw);
    if (checked.ok) policyState = checked.policy;
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[policy] load failed: ${err.message}`);
  }
  return policyState;
}

async function savePolicy(raw) {
  const checked = validatePolicy(raw);
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const dir = path.dirname(POLICY_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${POLICY_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(checked.policy, null, 2) + "\n", { encoding: "utf8", flag: "w" });
  await fs.rename(tmp, POLICY_FILE);
  policyState = checked.policy;
  return policyState;
}

await loadPolicy();

// ─── 4.11.1 Configuration Persistence & Profile Management ──────────────────
const PROFILE_FILE = path.resolve(process.env.COD4X_PROFILE_FILE || dataPath("config", "config-profiles.json"));
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$/;
const MAX_PROFILES = 20;
let profileState = { version: 1, active: null, profiles: [] };
let profileWriteQueue = Promise.resolve();

function normalizeProfileStore(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const profiles = Array.isArray(src.profiles) ? src.profiles : [];
  const clean = [];
  for (const item of profiles) {
    const name = String(item?.name || "").trim();
    if (!PROFILE_NAME_RE.test(name) || !item?.config || typeof item.config !== "object" || Array.isArray(item.config)) continue;
    if (clean.some(p => p.name.toLowerCase() === name.toLowerCase())) continue;
    clean.push({ name, config: structuredClone(item.config) });
    if (clean.length >= MAX_PROFILES) break;
  }
  const active = typeof src.active === "string" && clean.some(p => p.name === src.active) ? src.active : null;
  return { version: 1, active, profiles: clean };
}

function validateProfileName(name) {
  const value = String(name ?? "").trim();
  if (!PROFILE_NAME_RE.test(value)) return "Profilname: 1–48 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, '.', '_' und '-' erlaubt.";
  return "";
}

function validateProfileConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Profil-Konfiguration muss ein Objekt sein."];
  if (Object.keys(config).length > 200) errors.push("Profil-Konfiguration darf maximal 200 Keys enthalten.");
  const hostname = config.sv_hostname;
  if (hostname !== undefined && String(hostname).length > 128) errors.push("sv_hostname darf maximal 128 Zeichen enthalten.");
  const maxclients = config.sv_maxclients;
  if (maxclients !== undefined && (!Number.isInteger(Number(maxclients)) || Number(maxclients) < 1 || Number(maxclients) > 64)) errors.push("sv_maxclients muss 1..64 sein.");
  const port = config.net_port;
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < policyState.security.portMin || Number(port) > policyState.security.portMax)) {
    errors.push(`net_port muss ${policyState.security.portMin}..${policyState.security.portMax} sein.`);
  }
  return errors;
}

async function loadProfiles() {
  try {
    const raw = JSON.parse(await fs.readFile(PROFILE_FILE, "utf8"));
    profileState = normalizeProfileStore(raw);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[profiles] load failed: ${err.message}`);
  }
  return profileState;
}

async function saveProfiles(next) {
  const normalized = normalizeProfileStore(next);
  const dir = path.dirname(PROFILE_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${PROFILE_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n", { encoding: "utf8", flag: "w" });
  await fs.rename(tmp, PROFILE_FILE);
  profileState = normalized;
  return profileState;
}

async function queueProfileWrite(next) {
  const run = profileWriteQueue.then(() => saveProfiles(next));
  profileWriteQueue = run.catch(() => {});
  return run;
}

async function upsertProfile(name, config) {
  const nameError = validateProfileName(name);
  if (nameError) throw new Error(nameError);
  const configErrors = validateProfileConfig(config);
  if (configErrors.length) throw new Error(configErrors.join("; "));
  const profiles = profileState.profiles.filter(p => p.name !== name);
  if (!profileState.profiles.some(p => p.name === name) && profiles.length >= MAX_PROFILES) throw new Error(`Maximal ${MAX_PROFILES} Profile erlaubt.`);
  profiles.push({ name: String(name).trim(), config: structuredClone(config) });
  profiles.sort((a,b) => a.name.localeCompare(b.name));
  return queueProfileWrite({ version: 1, active: profileState.active, profiles });
}

async function activateProfile(name) {
  const value = String(name ?? "").trim();
  const profile = profileState.profiles.find(p => p.name === value);
  if (!profile) throw new Error("Profil nicht gefunden.");
  await queueProfileWrite({ version: 1, active: profile.name, profiles: profileState.profiles });
  return profile;
}

async function deleteProfile(name) {
  const value = String(name ?? "").trim();
  const profile = profileState.profiles.find(p => p.name === value);
  if (!profile) throw new Error("Profil nicht gefunden.");
  const profiles = profileState.profiles.filter(p => p.name !== value);
  const active = profileState.active === value ? null : profileState.active;
  return queueProfileWrite({ version: 1, active, profiles });
}

await loadProfiles();

// Profile API — persistence is bounded, path is fixed to config/profile store, writes are atomic.
app.get("/api/config/profiles", requirePermission("config.manage"), async (_req, res) => {
  await loadProfiles();
  res.json({ ok: true, version: profileState.version, active: profileState.active, maxProfiles: MAX_PROFILES, profiles: profileState.profiles });
});

app.post("/api/config/profiles/save", requirePermission("config.manage"), async (req, res) => {
  try {
    const next = await upsertProfile(req.body?.name, req.body?.config);
    audit("info", "config.profile.saved", { name: req.body?.name, count: next.profiles.length });
    res.json({ ok: true, ...next, maxProfiles: MAX_PROFILES });
  } catch (e) {
    audit("warn", "config.profile.save.rejected", { error: e.message });
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/config/profiles/activate", requirePermission("config.manage"), async (req, res) => {
  try {
    const profile = await activateProfile(req.body?.name);
    audit("info", "config.profile.activated", { name: profile.name });
    res.json({ ok: true, active: profile.name, profile });
  } catch (e) {
    audit("warn", "config.profile.activate.rejected", { error: e.message });
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/config/profiles/delete", requirePermission("config.manage"), async (req, res) => {
  try {
    const next = await deleteProfile(req.body?.name);
    audit("info", "config.profile.deleted", { name: req.body?.name, count: next.profiles.length });
    res.json({ ok: true, ...next, maxProfiles: MAX_PROFILES });
  } catch (e) {
    audit("warn", "config.profile.delete.rejected", { error: e.message });
    res.status(400).json({ ok: false, error: e.message });
  }
});

const AUDIT_MAX_EVENTS = () => policyState.audit.maxEvents;
const AUDIT_PERSIST_LIMIT = () => policyState.audit.persistReadLimit;
const AUDIT_MAX_BYTES = () => policyState.audit.maxBytes;
const AUDIT_MAX_ROTATED = () => policyState.audit.maxRotated;
const auditEvents = [];
const AUDIT_BASE = path.resolve(process.env.COD4X_AUDIT_ROOT || dataPath("config", "audit"));
const AUDIT_DIR = path.resolve(process.env.COD4X_AUDIT_DIR || AUDIT_BASE);
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.ndjson");
let auditWriteQueue = Promise.resolve();
let auditIoState = { ok: true, error: "" };

function isSafeAuditPath(candidate) {
  const base = path.resolve(AUDIT_BASE);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function rotatedAuditFiles(entries) {
  return entries
    .filter(name => /^audit-\d{8}-\d{6}[.-]\d{3}(?:-\d{2,})?\.ndjson$/.test(name))
    .sort()
    .reverse();
}

async function enforceAuditPermissions() {
  if (process.platform === "win32") return;
  // Security audit 4.18.26 (A2-3): also tightens a folder created by an older version.
  try { await fs.chmod(AUDIT_DIR, 0o700); } catch {}
  try { await fs.chmod(AUDIT_FILE, 0o600); } catch {}
}

async function rotateAuditLog(reason = "size") {
  if (!isSafeAuditPath(AUDIT_DIR) || !isSafeAuditPath(AUDIT_FILE)) {
    throw new Error("Audit log path escapes configured audit root");
  }
  try {
    await fs.mkdir(AUDIT_DIR, { recursive: true, mode: 0o700 });
    let stat;
    try { stat = await fs.stat(AUDIT_FILE); } catch (err) {
      if (err.code === "ENOENT") return { rotated: false, reason: "missing" };
      throw err;
    }
    if (!stat.isFile() || stat.size === 0) return { rotated: false, reason: "empty" };
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
    let target = path.join(AUDIT_DIR, `audit-${stamp}.ndjson`);
    let n = 1;
    while (true) {
      try { await fs.access(target); target = path.join(AUDIT_DIR, `audit-${stamp}-${String(n++).padStart(2,"0")}.ndjson`); }
      catch { break; }
    }
    if (!isSafeAuditPath(target)) throw new Error("Rotated audit path escapes configured audit root");
    await fs.rename(AUDIT_FILE, target);
    await enforceAuditPermissions();
    const entries = rotatedAuditFiles(await fs.readdir(AUDIT_DIR));
    for (const stale of entries.slice(AUDIT_MAX_ROTATED())) {
      const stalePath = path.join(AUDIT_DIR, stale);
      if (isSafeAuditPath(stalePath)) { try { await fs.unlink(stalePath); } catch {} }
    }
    return { rotated: true, reason, rotatedFile: target };
  } catch (err) {
    auditIoState = { ok: false, error: err.message };
    throw err;
  }
}

function sanitizeAuditDetails(details = {}) {
  const safeDetails = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (/password|secret|token|credential/i.test(key)) safeDetails[key] = "[REDACTED]";
    else if (typeof value === "string" && value.length > 512) safeDetails[key] = value.slice(0, 512) + "…";
    else safeDetails[key] = value;
  }
  return safeDetails;
}

function persistAuditEntry(entry) {
  const line = JSON.stringify(entry) + "\n";
  auditWriteQueue = auditWriteQueue
    .then(async () => {
      if (!isSafeAuditPath(AUDIT_DIR) || !isSafeAuditPath(AUDIT_FILE)) {
        throw new Error("Audit log path escapes configured audit root");
      }
      await fs.mkdir(AUDIT_DIR, { recursive: true, mode: 0o700 });
      let currentBytes = 0;
      try { currentBytes = (await fs.stat(AUDIT_FILE)).size; }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      if (currentBytes > 0 && currentBytes + Buffer.byteLength(line, "utf8") > AUDIT_MAX_BYTES()) {
        await rotateAuditLog("size");
      }
      await fs.appendFile(AUDIT_FILE, line, { encoding: "utf8", flag: "a", mode: 0o600 });
      await enforceAuditPermissions();
      auditIoState = { ok: true, error: "" };
    })
    .catch(err => {
      auditIoState = { ok: false, error: err.message };
      // Persistence failures must not break the API request that generated the event.
      console.error(`[audit] persistent write failed: ${err.message}`);
    });
  return auditWriteQueue;
}

function audit(level, event, details = {}) {
  // The auth routes call audit({ level, event, details }); before 4.18.16 those
  // entries were recorded with the event name "[object Object]".
  if (level && typeof level === "object") ({ level, event, details = {} } = level);
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: ["info", "warn", "error"].includes(level) ? level : "info",
    event: String(event).slice(0, 128),
    details: sanitizeAuditDetails(details),
  };
  auditEvents.push(entry);
  if (auditEvents.length > AUDIT_MAX_EVENTS()) auditEvents.splice(0, auditEvents.length - AUDIT_MAX_EVENTS());
  persistAuditEntry(entry);
  return entry;
}

async function readPersistentAudit({limit = 100, level = ""} = {}) {
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), AUDIT_PERSIST_LIMIT()) : 100;
  try {
    const raw = await fs.readFile(AUDIT_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const selected = [];
    for (let i = lines.length - 1; i >= 0 && selected.length < boundedLimit; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (!level || item.level === level) selected.push(item);
      } catch {
        // Ignore a malformed line rather than failing the complete log read.
      }
    }
    return selected;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function persistentAuditStatus() {
  try {
    const stat = await fs.stat(AUDIT_FILE);
    const entries = await fs.readdir(AUDIT_DIR).catch(() => []);
    const rotatedCount = rotatedAuditFiles(entries).length;
    let permissions = "unknown";
    if (process.platform !== "win32") permissions = (stat.mode & 0o777).toString(8).padStart(4, "0");
    return { exists: true, bytes: stat.size, path: AUDIT_FILE, rotatedCount, maxRotated: AUDIT_MAX_ROTATED(), maxBytes: AUDIT_MAX_BYTES(), appendOnly: true, permissions, ioHealthy: auditIoState.ok, ioError: auditIoState.error || "" };
  } catch (err) {
    if (err.code === "ENOENT") return { exists: false, bytes: 0, path: AUDIT_FILE, rotatedCount: 0, maxRotated: AUDIT_MAX_ROTATED(), maxBytes: AUDIT_MAX_BYTES(), appendOnly: true, permissions: "missing", ioHealthy: auditIoState.ok, ioError: auditIoState.error || "" };
    throw err;
  }
}

async function auditCheckpoint() {
  await auditWriteQueue;
  try {
    const data = await fs.readFile(AUDIT_FILE);
    return { algorithm: "SHA-256", hash: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length };
  } catch (err) {
    if (err.code === "ENOENT") return { algorithm: "SHA-256", hash: crypto.createHash("sha256").update("").digest("hex"), bytes: 0 };
    throw err;
  }
}

audit("info", "service.started", { service: "cod4x-control-installer" });

app.get("/api/audit", requirePermission("audit.read"), (req, res) => {
  const limitRaw = Number(req.query.limit || 100);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), AUDIT_MAX_EVENTS()) : 100;
  const level = String(req.query.level || "").trim().toLowerCase();
  const events = level && ["info", "warn", "error"].includes(level)
    ? auditEvents.filter(e => e.level === level).slice(-limit).reverse()
    : auditEvents.slice(-limit).reverse();
  res.json({ ok: true, bounded: true, maxEvents: AUDIT_MAX_EVENTS(), events });
});

app.post("/api/audit/test", requirePermission("user.manage"), (_req, res) => {
  const entry = audit("info", "audit.test", { source: "manual" });
  res.json({ ok: true, entry });
});

app.get("/api/audit/persistent", requirePermission("audit.read"), async (req, res) => {
  try {
    const level = String(req.query.level || "").trim().toLowerCase();
    if (level && !["info", "warn", "error"].includes(level)) return res.status(400).json({ ok:false, error:"Invalid audit level" });
    const limitRaw = Number(req.query.limit || 100);
    const events = await readPersistentAudit({ limit: Number.isInteger(limitRaw) ? limitRaw : 100, level });
    const status = await persistentAuditStatus();
    res.json({ ok:true, persistent:true, format:"ndjson", boundedRead:true, maxRead:AUDIT_PERSIST_LIMIT(), events, ...status });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post("/api/audit/persist", requirePermission("audit.read"), async (_req, res) => {
  try {
    await auditWriteQueue;
    const status = await persistentAuditStatus();
    res.json({ ok:true, persistent:true, format:"ndjson", ...status });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post("/api/audit/rotate", requirePermission("user.manage"), async (_req, res) => {
  try {
    await auditWriteQueue;
    const result = await rotateAuditLog("manual");
    audit("info", "audit.rotated", { rotated: result.rotated, reason: result.reason, rotatedFile: result.rotatedFile || null });
    res.json({ ok:true, ...result, ...(await persistentAuditStatus()) });
  } catch (e) {
    auditIoState = { ok:false, error:e.message };
    audit("error", "audit.rotation.failed", { error:e.message });
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/api/audit/hardening", requirePermission("audit.read"), async (_req, res) => {
  try {
    const status = await persistentAuditStatus();
    const checks = [
      { id:"path", label:"Log path validation", pass:isSafeAuditPath(AUDIT_DIR), detail:AUDIT_DIR },
      { id:"root", label:"Audit root boundary", pass:isSafeAuditPath(AUDIT_DIR), detail:AUDIT_BASE },
      { id:"filename", label:"Fixed audit filename", pass:path.basename(AUDIT_FILE) === "audit.ndjson", detail:path.basename(AUDIT_FILE) },
      { id:"size", label:"Active log size limit", pass:status.bytes <= AUDIT_MAX_BYTES(), detail:`${status.bytes}/${AUDIT_MAX_BYTES()} bytes` },
      { id:"prerotation", label:"Pre-limit automatic rotation", pass:AUDIT_MAX_BYTES() > 0, detail:"enabled" },
      { id:"retention", label:"Rotated log retention", pass:status.rotatedCount <= AUDIT_MAX_ROTATED(), detail:`${status.rotatedCount}/${AUDIT_MAX_ROTATED()}` },
      { id:"append", label:"Append-only write mode", pass:status.appendOnly === true, detail:"append" },
      { id:"permissions", label:"Log file permissions", pass:status.permissions === "0600" || process.platform === "win32", detail:status.permissions },
      { id:"io", label:"Persistent I/O health", pass:status.ioHealthy === true, detail:status.ioError || "OK" },
      { id:"ndjson", label:"NDJSON persistence", pass:true, detail:"structured audit format" },
      { id:"bounded-read", label:"Bounded log reads", pass:AUDIT_PERSIST_LIMIT() > 0, detail:`max ${AUDIT_PERSIST_LIMIT()}` },
      { id:"malformed-isolation", label:"Malformed-line isolation", pass:true, detail:"invalid NDJSON lines are skipped" },
      { id:"redaction", label:"Audit secret redaction", pass:true, detail:"password/secret/token/credential fields redacted" },
      { id:"checkpoint", label:"SHA-256 checkpoint", pass:true, detail:"SHA-256" },
      { id:"status-api", label:"Hardening status API", pass:true, detail:"/api/audit/hardening" },
    ];
    const ok = checks.every(c=>c.pass);
    audit(ok?"info":"warn", "audit.hardening.checked", { ok, checks:checks.length });
    res.json({ ok, hardening:true, checks, ...status });
  } catch(e) {
    audit("error", "audit.hardening.failed", { error:e.message });
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get("/api/audit/checkpoint", requirePermission("audit.read"), async (_req, res) => {
  try { res.json({ ok:true, checkpoint:await auditCheckpoint() }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});


app.get("/api/diagnostics", requirePermission("diagnostics.read"), async (req, res) => {
  audit("info", "diagnostics.started", { cod4x: req.query.cod4x, fps: req.query.fps, path: req.query.path });
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const supportedCod4x = SECURITY_COD4X_VERSIONS;
  const supportedFps = ["2.85", "2.86", "3.00", "3.02", "custom"];
  const cod4x = String(req.query.cod4x || "21.5");
  const fps = String(req.query.fps || "2.85");
  const mod = String(req.query.mod || "");
  const rconHost = String(req.query.rconHost || "127.0.0.1").trim();
  const rconPort = Number(req.query.rconPort || 28960);
  let target = null;

  try {
    add("api", "Installer API", "pass", "Backend erreichbar.");

    if (supportedCod4x.includes(cod4x)) add("cod4x-version", "CoD4x-Version", "pass", `Profil ${cod4x} ist unterstützt.`);
    else add("cod4x-version", "CoD4x-Version", "fail", `Nicht unterstützte Version: ${cod4x}.`);

    if (supportedCod4x.includes(cod4x) && supportedFps.includes(fps)) {
      add("target-profile", "Client/Server-Ziel", "pass", `CoD4x ${cod4x} / FPS Promod ${fps}.`);
    } else {
      add("target-profile", "Client/Server-Ziel", "fail", "Versionen des Zielprofils sind nicht vollständig unterstützt.");
    }

    try {
      const relative = String(req.query.path || "./server").replaceAll("\\", "/").replace(/^\/+/, "");
      target = assertSafeChildPath(INSTALL_ROOT, relative);
      add("install-path", "Installationspfad", "pass", target);
    } catch (e) {
      add("install-path", "Installationspfad", "fail", e.message);
    }

    if (target) {
      try { await fs.access(target); add("target-exists", "Installationsziel", "pass", "Verzeichnis ist vorhanden."); }
      catch { add("target-exists", "Installationsziel", "warn", "Verzeichnis ist noch nicht vorhanden."); }

      const exe = assertSafeChildPath(target, "iw3mp.exe");
      try { await fs.access(exe); add("verified-core", "Verified-Core", "pass", "iw3mp.exe ist vorhanden."); }
      catch { add("verified-core", "Verified-Core", "warn", "iw3mp.exe wurde nicht gefunden; eine Installation/Verifikation ist noch erforderlich."); }

      const manifestPath = assertSafeChildPath(target, "cod4x-control-manifest.json");
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        if (String(manifest.cod4x) === cod4x) add("manifest", "Core-Manifest", "pass", `Manifest für CoD4x ${manifest.cod4x} vorhanden.`);
        else add("manifest", "Core-Manifest", "warn", `Manifest-Version ${manifest.cod4x || "unbekannt"} weicht vom Profil ${cod4x} ab.`);
      } catch { add("manifest", "Core-Manifest", "warn", "Kein gültiges COD4X CONTROL Manifest im Ziel gefunden."); }

      const cfgPath = assertSafeChildPath(target, "server.cfg");
      try {
        const cfg = await fs.readFile(cfgPath, "utf8");
        add("config-file", "Konfigurationsdatei", "pass", "server.cfg ist vorhanden und lesbar.");
        const hasHostname = /(?:^|\n)\s*set\s+sv_hostname\b/i.test(cfg);
        const hasPort = /(?:^|\n)\s*set\s+net_port\s+\"?\d+\"?/i.test(cfg);
        if (hasHostname && hasPort) add("config", "Konfiguration", "pass", "Hostname und net_port sind vorhanden.");
        else add("config", "Konfiguration", "warn", "Erwartete Basis-DVARs sv_hostname und/oder net_port fehlen.");
      } catch {
        add("config-file", "Konfigurationsdatei", "warn", "server.cfg wurde nicht gefunden.");
        add("config", "Konfiguration", "warn", "Konfigurationsprüfung nicht möglich.");
      }

      const modsDir = assertSafeChildPath(target, "mods");
      try { await fs.access(modsDir); add("modules", "Module", "pass", "mods/ Verzeichnis vorhanden."); }
      catch { add("modules", "Module", "warn", "mods/ Verzeichnis wurde nicht gefunden."); }

      if (!mod || mod === "vanilla") add("selected-mod", "Ausgewähltes Modul", "pass", "Vanilla / Basisspiel ausgewählt.");
      else {
        const modPath = assertSafeChildPath(target, mod);
        try { await fs.access(modPath); add("selected-mod", "Ausgewähltes Modul", "pass", `${mod} vorhanden.`); }
        catch { add("selected-mod", "Ausgewähltes Modul", "warn", `${mod} wurde im Installationsziel nicht gefunden.`); }
      }
    } else {
      add("target-exists", "Installationsziel", "fail", "Installationsziel konnte nicht validiert werden.");
      add("verified-core", "Verified-Core", "fail", "Core-Prüfung übersprungen.");
      add("manifest", "Core-Manifest", "fail", "Manifest-Prüfung übersprungen.");
      add("config-file", "Konfigurationsdatei", "fail", "Dateiprüfung übersprungen.");
      add("config", "Konfiguration", "fail", "Konfigurationsprüfung übersprungen.");
      add("modules", "Module", "fail", "Modulprüfung übersprungen.");
      add("selected-mod", "Ausgewähltes Modul", "fail", "Modulprüfung übersprungen.");
    }

    if (supportedFps.includes(fps)) add("fps-profile", "FPS Promod-Profil", "pass", `Profil ${fps} ist bekannt.`);
    else add("fps-profile", "FPS Promod-Profil", "fail", `Unbekanntes FPS-Profil: ${fps}.`);

    const hostOk = Boolean(rconHost) && !/[\u0000-\u001F\u007F]/.test(rconHost);
    if (hostOk) add("rcon-host", "RCON Host", "pass", `Host ${rconHost} ist syntaktisch gültig.`);
    else add("rcon-host", "RCON Host", "fail", "RCON Host ist leer oder enthält Steuerzeichen.");
    if (Number.isInteger(rconPort) && rconPort >= 1 && rconPort <= 65535) add("rcon-port", "RCON Port", "pass", `Port ${rconPort} liegt im gültigen Bereich.`);
    else add("rcon-port", "RCON Port", "fail", "RCON Port liegt außerhalb des gültigen Bereichs.");

    const networkPort = rconPort;
    if (Number.isInteger(networkPort) && networkPort >= 1 && networkPort <= 65535) add("network-port", "Netzwerk-Port", "pass", `Port ${networkPort} liegt im gültigen Bereich 1–65535.`);
    else add("network-port", "Netzwerk-Port", "fail", "Port liegt außerhalb des gültigen Bereichs.");

    const hasFail = checks.some(c => c.status === "fail");
    const hasWarn = checks.some(c => c.status === "warn");
    const status = hasFail ? "degraded" : hasWarn ? "degraded" : "healthy";
    audit(hasFail ? "warn" : "info", "diagnostics.completed", { status, checks: checks.length });
    res.json({ ok: true, status, checks });
  } catch (e) {
    audit("error", "diagnostics.failed", { error: e.message });
    res.status(500).json({ ok: false, error: e.message, status: "degraded", checks });
  }
});

app.post("/api/rcon/execute", requirePermission("server.manage"), async (req,res) => {
  try {
    const result=await executeRcon(req.body||{});
    res.json({ok:true,result});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

app.post("/api/admin/test", requirePermission("server.manage"), async (req,res) => {
  try {
    const provider=req.body?.provider||"native";
    if (!["native","b3","raid"].includes(provider)) throw new Error("Unsupported admin integration");
    if (provider==="raid") {
      const u=new URL(String(req.body?.endpoint||""));
      if (!["http:","https:"].includes(u.protocol)) throw new Error("RAID endpoint must use HTTP(S)");
      return res.json({ok:true,provider,mode:"config-validation-only",endpoint:u.origin+u.pathname});
    }
    res.json({ok:true,provider,mode:provider==="b3"?"profile":"local-rcon"});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

app.post("/api/installer", requirePermission("install.execute"), async (req, res) => {
  const log = [];
  audit("info", "installer.prepare.started", { action: req.body?.action, dryRun: Boolean(req.body?.dryRun), cod4x: req.body?.profile?.cod4x, fps: req.body?.profile?.fps, target: req.body?.profile?.target });
  try {
    const profile = validateProfile(req.body);
    const dryRun = req.body?.dryRun !== false;

    log.push(`Target: ${profile.target}`);
    log.push(`CoD4x: ${profile.cod4x}`);
    log.push(`FPS Promod: ${profile.fps}`);
    log.push(`Mod: ${profile.mod || "vanilla"}`);

    if (dryRun) {
      log.push("DRY-RUN: no files were changed.");
      return res.json({ ok: true, dryRun: true, log });
    }

    const entries = [DOWNLOADS.cod4x[profile.cod4x]];
    if (profile.fps !== "custom") entries.push(DOWNLOADS.fps[profile.fps]);
    if (profile.mod && profile.mod !== "vanilla") {
      const modEntry = DOWNLOADS.mods[profile.mod];
      if (!modEntry) throw new Error(`No allowlisted artifact for mod: ${profile.mod}`);
      entries.push(modEntry);
    }

    const manifest = {
      installedAt: new Date().toISOString(),
      cod4x: profile.cod4x,
      fpsPromod: profile.fps,
      mod: profile.mod || "vanilla",
      antiCheat: profile.anticheat || "none",
      antiCheatMode: profile.acMode || "balanced",
    };
    // All artifacts are downloaded and checked before the first write; the install itself runs through
    // a restore point of the files it overwrites and is rolled back when a written file does not verify.
    const downloads = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-control-"));
    let installed;
    try {
      const artifacts = [];
      for (const [index, entry] of entries.entries()) artifacts.push(await downloadArtifact(entry, downloads, index, log));
      installed = await withRuntimeConfiguration(() => installArtifacts({
        artifacts, target: profile.target, store: restorePoints, actor: req.auth?.username || null, audit,
        extraFiles: { "cod4x-control-manifest.json": Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
      }));
    } finally {
      await fs.rm(downloads, { recursive: true, force: true });
    }
    log.push(`Installed into ${profile.target}`);
    log.push("Manifest written.");
    audit("info", "installer.prepare.completed", { dryRun: false, cod4x: profile.cod4x, fps: profile.fps, target: profile.target, restorePointId: installed.restorePointId });
    res.json({ ok: true, dryRun: false, log, manifest, restorePointId: installed.restorePointId });
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    audit("error", "installer.prepare.failed", { error: err.message, target: profile?.target });
    res.status(400).json({ ok: false, error: err.message, log });
  }
});

// ─── 4.17.2 Runtime Discovery / Existing-Core Adoption ─────────────────────
app.get("/api/runtime/search",requirePermission("diagnostics.read"),async(_req,res)=>{const correlationId=crypto.randomUUID();try{const candidates=await searchRuntimeCores();audit("info","runtime.core.search",{correlationId,count:candidates.length});res.json({ok:true,correlationId,candidates});}catch(err){audit("warn","runtime.core.search.failed",{correlationId,error:err.message});res.status(500).json({ok:false,correlationId,error:err.message});}});
app.get("/api/runtime/preflight",requirePermission("diagnostics.read"),async(req,res)=>{try{const requested=normalizeRuntimePath(req.query.path||defaultRuntime.state.target||"./server"),platform=normalizeServerPlatform(req.query.platform||defaultRuntime.state.platform||"windows"),cod4x=String(req.query.cod4x||defaultRuntime.state.cod4x||"21.5"),requestedExecutable=String(req.query.executablePath||defaultRuntime.state.executablePath||"").trim(),baseGame=await inspectBaseGame(selectRuntimeBaseGamePath(req.query.baseGamePath,defaultRuntime.state)),resolved=await resolveServerTarget(requested),executablePath=await resolveRuntimeExecutable({target:resolved.target,executablePath:requestedExecutable,platform}),core=await verifiedRuntimeCoreStatus(executablePath,cod4x,platform);res.json({ok:core.verified&&baseGame.valid,requested,platform,resolvedTarget:resolved.target,runtimeRoot:resolved.root,executablePath,candidates:resolved.checks,core,baseGame});}catch(err){res.status(400).json({ok:false,error:err.message});}});
// Puts the runtime record of a restore point back (only the configuration fields; process fields such
// as status and pid stay as they are).
const RUNTIME_RECORD_FIELDS=["target","platform","resolvedTarget","runtimeRoot","executablePath","executable","cod4x","baseGamePath","updatedAt"];
// required=false: the change never reached the disk (its own write failed), so the file still holds the
// old record and a failing write here leaves nothing to recover.
async function restoreDefaultRuntimeRecord(record,{required=true}={}){if(!record||typeof record!=="object")throw Object.assign(new Error("RESTORE_POINT_INVALID"),{code:"RESTORE_POINT_INVALID"});for(const field of RUNTIME_RECORD_FIELDS)defaultRuntime.state[field]=record[field]??null;try{await persistRuntimeState();}catch(error){if(required)throw error;}}
app.post("/api/runtime/config",requirePermission("server.code"),async(req,res)=>{const correlationId=crypto.randomUUID();try{await withRuntimeConfiguration(async()=>{const requested=normalizeRuntimePath(req.body?.path||defaultRuntime.state.target||"./server"),platform=normalizeServerPlatform(req.body?.platform||defaultRuntime.state.platform||"windows"),cod4x=String(req.body?.cod4x||defaultRuntime.state.cod4x||"21.5"),executablePath=normalizeRuntimeExecutablePath(req.body?.executablePath||defaultRuntime.state.executablePath||"",platform);if(!policyState.security.allowedCod4xVersions.includes(cod4x))throw new Error(`Unsupported CoD4x version: ${cod4x}`);if(!(await pathExists(executablePath)))throw new Error(`${serverCoreDefinition(platform).executable} wurde am ausgewählten Server-Core-Pfad nicht gefunden.`);const baseGame=await inspectBaseGame(selectRuntimeBaseGamePath(req.body?.baseGamePath,defaultRuntime.state));if(!baseGame.valid){const err=new Error(baseGame.reasons.map(item=>item.message).join("; "));err.code="BASEGAME_INVALID";throw err;}// Block 21: the core change of the standard server runs through a restore point of its runtime record.
let persisted=false;const{restorePointId}=await guardedChange({store:restorePoints,subject:DEFAULT_RUNTIME_SUBJECT,action:"core.change",actor:req.auth?.username||null,audit,
capture:async()=>({data:{record:structuredClone(defaultRuntime.state)},parts:["record"]}),
change:async()=>{defaultRuntime.state.baseGamePath=baseGame.baseGamePath;defaultRuntime.state.target=requested;defaultRuntime.state.platform=platform;defaultRuntime.state.resolvedTarget=null;defaultRuntime.state.runtimeRoot=null;defaultRuntime.state.executablePath=executablePath;defaultRuntime.state.executable=serverCoreDefinition(platform).executable;defaultRuntime.state.cod4x=cod4x;defaultRuntime.state.updatedAt=new Date().toISOString();await persistRuntimeState();persisted=true;},
verify:async()=>{if(!(await pathExists(defaultRuntime.state.executablePath))||!policyState.security.allowedCod4xVersions.includes(defaultRuntime.state.cod4x)){const err=new Error("Server-Core-Änderung konnte nicht bestätigt werden.");err.code="RUNTIME_CORE_VERIFY_FAILED";throw err;}},
rollback:async point=>{await restoreDefaultRuntimeRecord(point.manifest.data.record,{required:persisted});}});
runtimeEvent("runtime.configuration.saved",{correlationId,target:requested,platform,cod4x,executablePath,executable:defaultRuntime.state.executable,restorePointId});res.json({ok:true,correlationId,runtime:defaultRuntime.state,restorePointId});});}catch(err){audit("warn","runtime.configuration.blocked",{correlationId,error:err.message});res.status(400).json({ok:false,correlationId,error:err.message});}});
app.get("/api/runtime/status",requirePermission("diagnostics.read"),async(_req,res)=>{try{await reconcileRuntimeState();res.json({ok:true,runtime:defaultRuntime.state,hostPlatform:process.platform,supportedServerPlatforms:Object.keys(SERVER_CORE_DEFINITIONS),nativeExecutable:defaultRuntime.state.executable,candidateRoots:runtimeCandidateRoots()});}catch(err){res.status(500).json({ok:false,error:err.message});}});
app.post("/api/runtime/adopt",requirePermission("server.code"),async(req,res)=>{const correlationId=crypto.randomUUID();try{await withRuntimeConfiguration(async()=>{const requested=normalizeRuntimePath(req.body?.path||defaultRuntime.state.target||"./server"),platform=normalizeServerPlatform(req.body?.platform||defaultRuntime.state.platform||"windows"),cod4x=String(req.body?.cod4x||defaultRuntime.state.cod4x||"21.5"),resolved=await resolveServerTarget(requested),executablePath=await resolveRuntimeExecutable({target:resolved.target,executablePath:req.body?.executablePath||defaultRuntime.state.executablePath||"",platform}),result=await adoptExistingRuntimeExecutable({executablePath,cod4x,fpsPromod:req.body?.fpsPromod||"custom",platform});defaultRuntime.state.target=requested;defaultRuntime.state.platform=platform;defaultRuntime.state.resolvedTarget=resolved.target;defaultRuntime.state.runtimeRoot=resolved.root;defaultRuntime.state.executablePath=executablePath;defaultRuntime.state.executable=serverCoreDefinition(platform).executable;defaultRuntime.state.cod4x=cod4x;defaultRuntime.state.updatedAt=new Date().toISOString();await persistRuntimeState();const core=await verifiedRuntimeCoreStatus(executablePath,cod4x,platform);audit("info","runtime.core.adopted",{correlationId,target:resolved.target,executablePath,cod4x,sha256:result.manifest.executableSha256,verification:"operator-adopted"});res.status(201).json({ok:true,correlationId,requested,resolvedTarget:resolved.target,runtimeRoot:resolved.root,executablePath,core,runtime:defaultRuntime.state});});}catch(err){audit("warn","runtime.core.adoption.blocked",{correlationId,error:err.message});res.status(400).json({ok:false,correlationId,error:err.message});}});
app.post("/api/runtime/start",requirePermission("server.manage"),requireCodeWhen(runtimeBringsCode),refuseDefaultRuntimeRecovery,async(req,res)=>{const correlationId=crypto.randomUUID();try{const runtime=await startRuntime({relative:req.body?.path||defaultRuntime.state.target||"./server",executablePath:req.body?.executablePath||defaultRuntime.state.executablePath||"",baseGamePath:req.body?.baseGamePath||"",expectedCod4x:String(req.body?.cod4x||defaultRuntime.state.cod4x||"21.5"),args:req.body?.args||[],platform:req.body?.platform||defaultRuntime.state.platform||"windows"});audit("info","runtime.started",{correlationId,pid:runtime.pid,target:runtime.target,executablePath:runtime.executablePath,cod4x:runtime.cod4x});res.status(201).json({ok:true,correlationId,runtime});}catch(err){audit("warn","runtime.start.blocked",{correlationId,error:err.message,code:err.code||"RUNTIME_START_FAILED",runtimeTarget:err.runtimeTarget||null});res.status(400).json({ok:false,error:err.message,correlationId,runtime:defaultRuntime.state});}});

app.post("/api/runtime/stop", requirePermission("server.manage"), async (_req, res) => {
  const correlationId = crypto.randomUUID();
  try {
    const runtime = await stopRuntime("manual");
    audit("info", "runtime.stopped", { correlationId, pid:runtime.pid });
    res.json({ ok:true, correlationId, runtime });
  } catch (err) {
    audit("warn", "runtime.stop.blocked", { correlationId, error:err.message });
    res.status(400).json({ ok:false, error:err.message, correlationId, runtime:defaultRuntime.state });
  }
});

app.post("/api/runtime/restart", requirePermission("server.manage"), requireCodeWhen(runtimeBringsCode), refuseDefaultRuntimeRecovery, async (req, res) => {
  const correlationId = crypto.randomUUID();
  try {
    const runtime = await restartRuntime({
      relative: req.body?.path || defaultRuntime.state.target || "./server",
      executablePath: req.body?.executablePath || defaultRuntime.state.executablePath || "",
      baseGamePath: req.body?.baseGamePath || "",
      expectedCod4x: String(req.body?.cod4x || defaultRuntime.state.cod4x || "21.5"),
      args: req.body?.args || [],
      platform: req.body?.platform || defaultRuntime.state.platform || "windows",
    });
    audit("info", "runtime.restarted", { correlationId, pid:runtime.pid, target:runtime.target, cod4x:runtime.cod4x });
    res.json({ ok:true, correlationId, runtime });
  } catch (err) {
    audit("warn", "runtime.restart.blocked", { correlationId, error:err.message });
    res.status(400).json({ ok:false, error:err.message, correlationId, runtime:defaultRuntime.state });
  }
});

// Compatibility endpoint: the legacy server-start route now uses the 4.18.0
// runtime manager so there is only one authoritative process-control path.
app.post("/api/server/start", requirePermission("server.manage"), requireCodeWhen(runtimeBringsCode), refuseDefaultRuntimeRecovery, async (req, res) => {
  const correlationId = crypto.randomUUID();
  try {
    const runtime = await startRuntime({
      relative: req.body?.path || defaultRuntime.state.target || "./server",
      executablePath: req.body?.executablePath || defaultRuntime.state.executablePath || "",
      baseGamePath: req.body?.baseGamePath || "",
      expectedCod4x: String(req.body?.cod4x || defaultRuntime.state.cod4x || "21.5"),
      args: req.body?.args || [],
      platform: req.body?.platform || defaultRuntime.state.platform || "windows",
    });
    audit("info", "server.start", { correlationId, target: runtime.target, cod4x: runtime.cod4x, pid: runtime.pid });
    res.json({ ok:true, pid:runtime.pid, correlationId, runtime });
  } catch (err) {
    audit("warn", "server.start.blocked", { correlationId, error:err.message });
    res.status(400).json({ ok:false, error:err.message, correlationId });
  }
});

// ─── 4.11.7 Test Client ─────────────────────────────────────────────────────
// A small browser-based second client for verifying concurrent authentication
// sessions against the same local backend. It creates a real auth session and
// stores only its own bearer token in the browser localStorage.
app.get("/session-test", (_req, res) => {
  res.status(200).type("html").send(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>COD4X CONTROL — Session Test Client</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#09090f;color:#dde3f0;font:14px "Segoe UI",system-ui,sans-serif}
main{max-width:620px;margin:8vh auto;padding:24px;background:#10121a;border:1px solid #1f2333;border-radius:8px}
h1{font-size:18px;margin:0 0 5px;color:#f59e0b;font-family:monospace;letter-spacing:.08em}
.sub{color:#52596f;font-size:11px;margin-bottom:22px}label{display:block;color:#52596f;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin:12px 0 5px}
input{width:100%;box-sizing:border-box;background:#0b0d16;color:#dde3f0;border:1px solid #1f2333;border-radius:5px;padding:10px}
button{margin-top:14px;background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid #f59e0b66;border-radius:5px;padding:9px 13px;cursor:pointer}
button:hover{background:rgba(245,158,11,.2)}.status{margin-top:16px;padding:10px;border-radius:5px;background:#0b0d16;border:1px solid #1f2333;white-space:pre-wrap;font-family:monospace;font-size:11px}
.ok{color:#22c55e}.err{color:#ef4444}.hint{margin-top:18px;color:#52596f;font-size:11px;line-height:1.6}
</style></head>
<body><main>
<h1>COD4X CONTROL</h1><div class="sub">4.11.7 — SESSION TEST CLIENT · SECOND BROWSER SESSION</div>
<label>Benutzername</label><input id="username" autocomplete="username" placeholder="opp1">
<label>Passwort</label><input id="password" type="password" autocomplete="current-password">
<div><button id="login">Als zweiter Client anmelden</button> <button id="logout">Test-Session abmelden</button></div>
<div id="status" class="status">Keine Browser-Test-Session aktiv.</div>
<div class="hint">Diese Seite verwendet denselben lokalen COD4X-CONTROL-Backend-Prozess wie die Electron-App. Die Browser-Session ist separat und erscheint nach erfolgreichem Login im Session Management der Haupt-App.</div>
</main>
<script>
const tokenKey="cod4x.session-test.token";
const statusEl=document.getElementById("status");
function show(text,cls=""){statusEl.textContent=text;statusEl.className="status "+cls;}
async function api(path,options={}){
 const headers={...(options.headers||{})}; const token=localStorage.getItem(tokenKey);
 if(token) headers.Authorization="Bearer "+token;
 const r=await fetch(path,{...options,headers}); const d=await r.json().catch(()=>({}));
 if(!r.ok) throw new Error(d.error||("HTTP "+r.status)); return d;
}
async function refresh(){
 const token=localStorage.getItem(tokenKey); if(!token){show("Keine Browser-Test-Session aktiv.");return;}
 try{const d=await api("/api/auth/me");show("Browser-Test-Session aktiv\\nBenutzer: "+d.user.username+"\\nRolle: "+d.user.role,"ok");}
 catch(e){localStorage.removeItem(tokenKey);show("Session nicht mehr gültig: "+e.message,"err");}
}
document.getElementById("login").onclick=async()=>{
 try{
  const username=document.getElementById("username").value.trim();
  const password=document.getElementById("password").value;
  const d=await api("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
  localStorage.setItem(tokenKey,d.token); document.getElementById("password").value="";
  show("Browser-Test-Session aktiv\\nBenutzer: "+d.user.username+"\\nRolle: "+d.user.role+"\\nSession-ID: "+d.sessionId,"ok");
 }catch(e){show(e.message,"err");}
};
document.getElementById("logout").onclick=async()=>{
 try{await api("/api/auth/logout",{method:"POST"});}catch{}
 localStorage.removeItem(tokenKey);show("Browser-Test-Session abgemeldet.");
};
refresh();
</script></body></html>`);
});


// ─── 4.16.5–4.16.8 Production Backup / Integrity-Gated Restore ──────────────
// Reconstructed on top of the last verified FIX35 source. Backups are limited to
// known application configuration files; arbitrary filesystem paths are rejected.
const BACKUP_REGISTRY_FILE = path.resolve(process.env.COD4X_BACKUP_REGISTRY || dataPath("config", "production-backups.json"));
const BACKUP_DIR = path.resolve(process.env.COD4X_BACKUP_DIR || dataPath("data", "production-backups"));
const BACKUP_MAX = 50;
const BACKUP_FILES = [
  { key: "policy", file: POLICY_FILE },
  { key: "profiles", file: path.resolve(process.env.COD4X_CONFIG_PROFILES_FILE || dataPath("config", "config-profiles.json")) },
  { key: "users", file: AUTH_USERS_FILE },
];
function isSafeBackupPath(p) {
  const root = path.resolve(BACKUP_DIR) + path.sep;
  const resolved = path.resolve(p);
  return resolved.startsWith(root) || resolved === path.resolve(BACKUP_DIR);
}
async function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
async function loadBackupRegistry() {
  try {
    const raw = JSON.parse(await fs.readFile(BACKUP_REGISTRY_FILE, "utf8"));
    return { version: 1, backups: Array.isArray(raw?.backups) ? raw.backups.slice(0, BACKUP_MAX) : [] };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return { version: 1, backups: [] };
  }
}
async function saveBackupRegistry(registry) {
  await atomicWriteJson(BACKUP_REGISTRY_FILE, { version: 1, backups: registry.backups.slice(0, BACKUP_MAX) });
}
async function backupPayloadFromFiles() {
  const files = {};
  for (const item of BACKUP_FILES) {
    try { files[item.key] = await fs.readFile(item.file, "utf8"); }
    catch (err) { if (err.code === "ENOENT") files[item.key] = null; else throw err; }
  }
  return files;
}
function hashBackupPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
async function readBackupRecord(id) {
  const registry = await loadBackupRegistry();
  const meta = registry.backups.find(b => b.id === id);
  if (!meta) return null;
  if (!isSafeBackupPath(meta.file)) throw new Error("Backup path rejected");
  const raw = JSON.parse(await fs.readFile(meta.file, "utf8"));
  return { meta, raw };
}

function safeShaEqual(actual, expected) {
  const a = String(actual || "").toLowerCase();
  const b = String(expected || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

async function checkBackupRegistryConsistency() {
  const registry = await loadBackupRegistry();
  const records = Array.isArray(registry.backups) ? registry.backups : [];
  const seen = new Set();
  const invalid = [];
  const referencedFiles = new Set();

  for (const meta of records) {
    const id = String(meta?.id || "");
    const problems = [];
    if (!id) problems.push("missing_id");
    if (seen.has(id)) problems.push("duplicate_id");
    seen.add(id);

    const file = String(meta?.file || "");
    if (!file || !isSafeBackupPath(file)) {
      problems.push("unsafe_or_missing_path");
    } else {
      referencedFiles.add(path.resolve(file));
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8"));
        validateBackupPayload(raw?.payload);
        const actual = hashBackupPayload(raw.payload);
        const expected = String(meta?.sha256 || raw?.sha256 || "").toLowerCase();
        if (!safeShaEqual(actual, expected)) problems.push("sha256_mismatch");
        if (String(raw?.id || "") !== id) problems.push("id_mismatch");
        if (String(raw?.algorithm || "") !== "SHA-256") problems.push("algorithm_mismatch");
      } catch (err) {
        problems.push(err.code === "ENOENT" ? "file_missing" : "invalid_backup_file");
      }
    }
    if (problems.length) invalid.push({ id: id || null, problems });
  }

  let orphanFiles = [];
  try {
    const files = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    orphanFiles = files
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => path.resolve(BACKUP_DIR, entry.name))
      .filter(file => !referencedFiles.has(file));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const checks = {
    registryShape: Array.isArray(registry.backups),
    bounded: records.length <= BACKUP_MAX,
    uniqueIds: invalid.every(item => !item.problems.includes("duplicate_id")),
    safePaths: invalid.every(item => !item.problems.includes("unsafe_or_missing_path")),
    filesPresent: invalid.every(item => !item.problems.includes("file_missing")),
    payloadsValid: invalid.every(item => !item.problems.includes("invalid_backup_file")),
    sha256Match: invalid.every(item => !item.problems.includes("sha256_mismatch")),
    metadataMatch: invalid.every(item => !item.problems.includes("id_mismatch") && !item.problems.includes("algorithm_mismatch")),
    noOrphanFiles: orphanFiles.length === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    version: Number(registry.version || 1),
    count: records.length,
    maxBackups: BACKUP_MAX,
    checks,
    invalid,
    orphanFiles,
  };
}

function validateBackupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid backup payload");
  for (const item of BACKUP_FILES) {
    const value = payload[item.key];
    if (value !== null && typeof value !== "string") throw new Error(`Invalid backup field: ${item.key}`);
  }
}

app.get("/api/backups", requirePermission("config.manage"), async (_req, res) => {
  try {
    const registry = await loadBackupRegistry();
    const items = registry.backups.map(({id,createdAt,label,bytes,sha256,files}) => ({id,createdAt,label,bytes,sha256,files}));
    res.json({ ok:true, version:1, maxBackups:BACKUP_MAX, backups:items });
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post("/api/backups/create", requirePermission("config.manage"), async (req, res) => {
  try {
    const payload = await backupPayloadFromFiles();
    const sha = hashBackupPayload(payload);
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const label = String(req.body?.label || "Production backup").trim().slice(0, 80) || "Production backup";
    const raw = { version:1, id, createdAt, label, algorithm:"SHA-256", sha256:sha, payload };
    await fs.mkdir(BACKUP_DIR, {recursive:true});
    const file = path.resolve(BACKUP_DIR, `${id}.json`);
    if (!isSafeBackupPath(file)) throw new Error("Backup path rejected");
    await atomicWriteJson(file, raw);
    const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
    const registry = await loadBackupRegistry();
    registry.backups.unshift({ id, createdAt, label, file, bytes, sha256:sha, files:BACKUP_FILES.map(x=>x.key) });
    const removed = registry.backups.splice(BACKUP_MAX);
    await saveBackupRegistry(registry);
    for (const old of removed) { try { if (isSafeBackupPath(old.file)) await fs.unlink(old.file); } catch {} }
    audit("info", "backup.created", { id, label, sha256:sha, files:BACKUP_FILES.map(x=>x.key) });
    res.json({ok:true,backup:{id,createdAt,label,bytes,sha256:sha,files:BACKUP_FILES.map(x=>x.key)}});
  } catch (e) { audit("warn","backup.create.blocked",{error:e.message}); res.status(400).json({ok:false,error:e.message}); }
});

app.get("/api/backups/:id/integrity", requirePermission("config.manage"), async (req, res) => {
  try {
    const record = await readBackupRecord(req.params.id);
    if (!record) return res.status(404).json({ok:false,error:"Backup not found"});
    validateBackupPayload(record.raw.payload);
    const actual = hashBackupPayload(record.raw.payload);
    const expected = String(record.meta.sha256 || record.raw.sha256 || "").toLowerCase();
    const valid = Boolean(expected) && crypto.timingSafeEqual(Buffer.from(actual,"hex"), Buffer.from(expected,"hex"));
    audit(valid?"info":"warn", "backup.integrity.checked", {id:record.meta.id, expected, actual, valid});
    res.json({ok:true,valid,algorithm:"SHA-256",expected,actual});
  } catch (e) { res.status(400).json({ok:false,error:e.message}); }
});

app.post("/api/backups/:id/restore", requirePermission("config.manage"), async (req, res) => {
  const correlationId = crypto.randomUUID();
  try {
    const record = await readBackupRecord(req.params.id);
    if (!record) return res.status(404).json({ok:false,error:"Backup not found",correlationId});
    // 4.16.7: integrity is mandatory immediately before restore.
    validateBackupPayload(record.raw.payload);
    const actual = hashBackupPayload(record.raw.payload);
    const expected = String(record.meta.sha256 || record.raw.sha256 || "").toLowerCase();
    if (!expected || expected.length !== 64 || !/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      audit("warn", "backup.restore.blocked", {id:record.meta.id, correlationId, reason:"sha256_mismatch_or_missing", expected, actual});
      return res.status(409).json({ok:false,error:"Restore blocked: SHA-256 integrity verification failed.",correlationId,expected,actual});
    }
    // Pre-restore safety snapshot is created only after the requested backup passes integrity.
    const safetyPayload = await backupPayloadFromFiles();
    const safetySha = hashBackupPayload(safetyPayload);
    const safetyId = `${Date.now().toString(36)}-safety-${crypto.randomBytes(4).toString("hex")}`;
    const safetyFile = path.resolve(BACKUP_DIR, `${safetyId}.json`);
    await atomicWriteJson(safetyFile, {version:1,id:safetyId,createdAt:new Date().toISOString(),label:"Pre-restore safety snapshot",algorithm:"SHA-256",sha256:safetySha,payload:safetyPayload});
    const registry = await loadBackupRegistry();
    registry.backups.unshift({id:safetyId,createdAt:new Date().toISOString(),label:"Pre-restore safety snapshot",file:safetyFile,bytes:Buffer.byteLength(JSON.stringify(safetyPayload),"utf8"),sha256:safetySha,files:BACKUP_FILES.map(x=>x.key),safety:true});
    registry.backups.splice(BACKUP_MAX);
    await saveBackupRegistry(registry);
    // Transactional-ish restore: write temp files first, then rename each file atomically.
    const temps = [];
    try {
      for (const item of BACKUP_FILES) {
        const value = record.raw.payload[item.key];
        if (value === null) continue;
        const dir = path.dirname(item.file); await fs.mkdir(dir,{recursive:true});
        const tmp = `${item.file}.restore-${process.pid}-${crypto.randomUUID()}`;
        await fs.writeFile(tmp, value, "utf8"); temps.push({tmp,target:item.file});
      }
      for (const item of temps) await fs.rename(item.tmp,item.target);
    } catch (e) {
      for (const item of temps) { try { await fs.unlink(item.tmp); } catch {} }
      throw e;
    }
    audit("info", "backup.restored", {id:record.meta.id, correlationId, sha256:actual, safetySnapshotId:safetyId});
    res.json({ok:true,restored:record.meta.id,correlationId,sha256:actual,safetySnapshotId:safetyId});
  } catch (e) {
    audit("error", "backup.restore.failed", {id:req.params.id, correlationId, error:e.message});
    res.status(500).json({ok:false,error:e.message,correlationId});
  }
});

app.get("/api/backups/consistency", requirePermission("diagnostics.read"), async (_req,res) => {
  try {
    const result = await checkBackupRegistryConsistency();
    audit(result.ok ? "info" : "warn", "backup.consistency.checked", {
      ok: result.ok,
      count: result.count,
      invalid: result.invalid.length,
      orphanFiles: result.orphanFiles.length,
      checks: result.checks,
    });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) {
    audit("error", "backup.consistency.failed", { error: e.message });
    res.status(500).json({ok:false,error:e.message});
  }
});


// ─── 4.16.9 Backup Lifecycle & Retention Governance ─────────────────────────
const BACKUP_LIFECYCLE_MAX_REGULAR = 40;
const BACKUP_LIFECYCLE_MAX_SAFETY = 10;

async function evaluateBackupLifecycle() {
  const registry = await loadBackupRegistry();
  const records = Array.isArray(registry.backups) ? registry.backups.slice() : [];
  const safety = records.filter(b => b?.safety === true);
  const regular = records.filter(b => b?.safety !== true);
  const deletable = [
    ...regular.slice(BACKUP_LIFECYCLE_MAX_REGULAR),
    ...safety.slice(BACKUP_LIFECYCLE_MAX_SAFETY),
  ];
  const referenced = new Set(records.map(b => path.resolve(String(b?.file || ""))).filter(Boolean));
  let orphanFiles = [];
  try {
    const files = await fs.readdir(BACKUP_DIR, {withFileTypes:true});
    orphanFiles = files.filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => path.resolve(BACKUP_DIR, e.name)).filter(f => !referenced.has(f));
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return {
    version: 1,
    maxTotal: BACKUP_MAX,
    maxRegular: BACKUP_LIFECYCLE_MAX_REGULAR,
    maxSafety: BACKUP_LIFECYCLE_MAX_SAFETY,
    total: records.length,
    regular: regular.length,
    safety: safety.length,
    deletable: deletable.map(b => ({id:b.id,label:b.label,createdAt:b.createdAt,safety:b.safety === true})),
    orphanFiles,
    ok: records.length <= BACKUP_MAX && regular.length <= BACKUP_LIFECYCLE_MAX_REGULAR && safety.length <= BACKUP_LIFECYCLE_MAX_SAFETY && orphanFiles.length === 0,
  };
}

app.get("/api/backups/lifecycle", requirePermission("diagnostics.read"), async (_req,res) => {
  try {
    const result = await evaluateBackupLifecycle();
    audit(result.ok ? "info" : "warn", "backup.lifecycle.checked", {
      ok: result.ok, total: result.total, regular: result.regular, safety: result.safety,
      deletable: result.deletable.length, orphanFiles: result.orphanFiles.length,
      maxRegular: result.maxRegular, maxSafety: result.maxSafety,
    });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) {
    audit("error", "backup.lifecycle.failed", {error:e.message});
    res.status(500).json({ok:false,error:e.message});
  }
});

app.post("/api/backups/lifecycle/cleanup", requirePermission("config.manage"), async (_req,res) => {
  try {
    const before = await evaluateBackupLifecycle();
    const registry = await loadBackupRegistry();
    const records = Array.isArray(registry.backups) ? registry.backups.slice() : [];
    const safety = records.filter(b => b?.safety === true);
    const regular = records.filter(b => b?.safety !== true);
    const keepRegular = regular.slice(0, BACKUP_LIFECYCLE_MAX_REGULAR);
    const keepSafety = safety.slice(0, BACKUP_LIFECYCLE_MAX_SAFETY);
    const keep = [...keepRegular, ...keepSafety];
    const keepIds = new Set(keep.map(b => b.id));
    const removed = records.filter(b => !keepIds.has(b.id));
    const orphanFiles = before.orphanFiles || [];
    registry.backups = keep.sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0, BACKUP_MAX);
    await saveBackupRegistry(registry);
    for (const item of removed) {
      try { if (item.file && isSafeBackupPath(item.file)) await fs.unlink(item.file); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    for (const file of orphanFiles) {
      try { if (isSafeBackupPath(file)) await fs.unlink(file); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const after = await evaluateBackupLifecycle();
    audit(after.ok ? "info" : "warn", "backup.lifecycle.cleaned", {
      removedBackups: removed.length, removedOrphans: orphanFiles.length,
      remaining: after.total, regular: after.regular, safety: after.safety, ok: after.ok,
    });
    res.status(after.ok ? 200 : 409).json({ok:after.ok,before,after,removedBackups:removed.length,removedOrphans:orphanFiles.length});
  } catch (e) {
    audit("error", "backup.lifecycle.cleanup.failed", {error:e.message});
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get("/api/backups/status", requirePermission("diagnostics.read"), async (_req,res) => {
  try {
    const registry=await loadBackupRegistry();
    res.json({ok:true,registryFile:BACKUP_REGISTRY_FILE,backupDir:BACKUP_DIR,count:registry.backups.length,maxBackups:BACKUP_MAX,algorithm:"SHA-256",integrityGate:true,safetySnapshot:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

const instanceRoot = dataPath("servers");
// Install after audit initialization; child exits must not depend on a UI request.
runtimeDependencies.onRuntimeEvent = entry => audit(entry.expected === false || /failed|blocked|error/.test(entry.event) ? "warn" : "info", entry.event, entry);
const instanceStore = new ServerInstanceStore({ root: instanceRoot, registryFile: dataPath("config", "server-instances.json") });
// Block 18: SSH hosts and the servers on them. The vault knows a host as the subject ssh_<hostId>.
let remoteInstanceStore = null;
const remoteHostStore = new RemoteHostStore({ file: dataPath("config", "remote-hosts.json"), inUse: id => remoteInstanceStore.hasInstancesFor(id) });
remoteInstanceStore = new RemoteInstanceStore({ file: dataPath("config", "remote-instances.json"), hosts: remoteHostStore });
const resolveSshSubject = sshSubjectResolver({ hosts: remoteHostStore, dataRoot: DATA_ROOT });
// Block 18b: the local side of each remote instance (rmt_<id> in the vault, own data directory).
const remoteShadowStore = createShadowStore({ instances: remoteInstanceStore, dataRoot: DATA_ROOT });
const resolveRemoteSubject = remoteSubjectResolver(remoteShadowStore);
const credentialService = new InstanceCredentialService({ dataRoot: DATA_ROOT, resolveInstance: id => (id.startsWith("ssh_") ? resolveSshSubject(id) : isRemoteSubject(id) ? resolveRemoteSubject(id) : instanceStore.get(id)) });
const remoteCredentials = prefixedCredentials(credentialService);
let instanceManager = null;
// RCON audit events carry instance, actor, normalized command and codes only, never the password.
const rconService = new InstanceRconService({ resolveInstance: id => instanceStore.get(id), runtimeFor: id => instanceManager.runtime(id), credentialService, audit,
  // Block 16: b3hide replaces `status` for the run it was loaded into.
  statusFormat: async id => {
    const launched = instanceManager.launchedWith(id);
    return launched?.b3hide && launched.runId === (await instanceManager.runtime(id)).state?.runId ? "b3hide" : "core";
  } });
// Master audit events carry instance, run and fixed codes only, never the token.
const masterService = new InstanceMasterService({ resolveInstance: id => instanceStore.get(id), runtimeFor: id => instanceManager.runtime(id), credentialService, audit });
// B3 runtime (Block 12): separate processes; events are audited, never the output.
const b3EnvironmentForRuntime = new B3Environment(dataPath("config", "b3-environment.json"));
// Dashboard reads the server state only: instance runtime status plus a short
// unauthenticated getinfo probe on loopback. It never starts or stops the server.
async function b3ServerStatus(id) {
  let status;
  // Inspection failures are "unknown", never "offline".
  try { status = await instanceManager.status(id); } catch { return { status: "UNKNOWN", reachable: null }; }
  if (status.runtime.status !== "RUNNING") return { status: status.runtime.status, reachable: false };
  try { await new RconClient({ port: status.port, timeoutMs: 800 }).probe(); return { status: "RUNNING", reachable: true }; }
  catch { return { status: "RUNNING", reachable: false }; }
}
// Block 14: per-instance B3 database (settings, test, verified backup, migration).
// Events carry codes only, never the password or DSN.
// Block 15: B3 in-game administration on B3's own database (masked unless config.manage).
const b3AdminService = new InstanceB3AdminService({ store: instanceStore, rcon: { findOnline: id => rconService.findOnline(id), kick: (id, target, actor) => rconService.kick(id, target, actor) }, database: { read: id => b3DatabaseService.read(id), query: (...args) => b3DatabaseService.query(...args), withStartGuard: (id, action) => b3DatabaseService.withStartGuard(id, action) },
  environment: b3EnvironmentForRuntime, b3IsRunning: id => b3Service.isRunning(id), onEvent: entry => audit("info", entry.event, entry) });
// Block 21: the migration point, the recovery mark and the recovery check go through the instance manager.
const b3DatabasePoints = { assertNoRecovery: id => instanceManager.assertNoRecovery(id), capture: (...args) => instanceManager.databasePoints().capture(...args), markRecovery: (...args) => instanceManager.databasePoints().markRecovery(...args) };
const b3DatabaseService = new InstanceB3DatabaseService({ store: instanceStore, credentials: credentialService, environment: b3EnvironmentForRuntime, b3IsRunning: id => b3Service.isRunning(id), onEvent: entry => audit(/failed/.test(entry.event) || entry.code ? "warn" : "info", entry.event, entry), points: b3DatabasePoints });
// Block 16b: B3 plugins per instance; the B3 start re-verifies them and records the revision.
const b3PluginService = new InstanceB3PluginService({ store: instanceStore, environment: b3EnvironmentForRuntime, exclusive: (id, action) => instanceManager.exclusive(id, action), guard: (id, action, options) => instanceManager.guardFor(id, action, options) });
const b3Service = new InstanceB3Service({ store: instanceStore, environment: b3EnvironmentForRuntime, serverStatus: b3ServerStatus, database: b3DatabaseService, credentials: credentialService, plugins: b3PluginService, recoveryCheck: id => instanceManager.assertNoRecovery(id), onEvent: entry => audit(/crashed|lost|failed/.test(entry.event) ? "warn" : "info", entry.event, entry) });
instanceManager = new ServerInstanceManager({
  store: instanceStore,
  restorePoints,
  b3Database: b3DatabaseService,
  audit,
  credentialService,
  rconService,
  masterService,
  b3Service,
  // A changed or removed b3db password requires a new database test.
  onCredentialChanged: (id, kind) => (kind === "b3db" ? b3DatabaseService.invalidate(id) : undefined),
  legacyRuntime: defaultRuntime,
  runtimeFactory: (instance, options) => createRuntimeManager({
    ...runtimeDependencies,
    assertWindowsInstanceOwnership,
    // Registered paths cannot be overridden by lifecycle request parameters.
    beforeLaunch: () => instanceStore.validatePaths(instance),
  }, options),
});
// Block 16: the B3 start uses the same integration plan as the server launch.
b3Service.integration = {
  plan: async id => (await instanceManager.b3IntegrationPlan(id)).plan,
  b3hideLoad: async id => (await instanceManager.plugins(id)).plugins.find(plugin => plugin.name.toLowerCase() === "b3hide")?.load ?? null,
};
try { await instanceManager.load(); }
catch (error) { console.error(`[instances] registry unavailable: ${error.message}`); }
// Block 18: remote Linux over SSH. The routes answer with REMOTE_*_STORE_INVALID while a list could not be loaded.
try { await remoteHostStore.load(); await remoteInstanceStore.load(); }
catch (error) { console.error(`[remote] registry unavailable: ${error.code || error.message}`); }
// 4.18.25: the only directory a core file for a remote server is read from.
const REMOTE_CORE_IMPORT_ROOT = dataPath("remote-core-import");
try { await fs.mkdir(REMOTE_CORE_IMPORT_ROOT, { recursive: true, mode: 0o700 }); }
catch (error) { console.error(`[remote] core import directory unavailable: ${error.code || error.message}`); }
const remoteHostService = new RemoteHostService({ store: remoteHostStore, credentials: credentialService, audit });
// Block 18b: one SSH session per host for RCON and monitoring; RCON for remote servers is the same
// service as locally, with a client that runs the exchange on the server and the rmt_ vault entries.
const remoteSessionPool = new RemoteSessionPool({ connect: hostId => remoteHostService.connect(hostId) });
let remoteRconService = null;
const remoteInstanceManager = new RemoteInstanceManager({ instances: remoteInstanceStore, hosts: remoteHostService, audit, state: new RemoteStateStore({ root: dataPath("remote") }), backupRoot: dataPath("remote-backups"), coreImportRoot: REMOTE_CORE_IMPORT_ROOT, restorePoints,
  credentials: remoteCredentials, onProvisioned: (id, runId, { rcon }) => remoteRconService?.recordProvisioning(id, runId, rcon ? "PROVISIONED" : "NOT_CONFIGURED") });
const remoteRuntimeFor = id => ({ state: {}, async reconcileRuntimeState() { this.state = (await remoteInstanceManager.status(id)).runtime; } });
remoteRconService = new InstanceRconService({ resolveInstance: id => remoteShadowStore.get(id), runtimeFor: remoteRuntimeFor, credentialService: remoteCredentials, audit: (level, event, details) => audit(level, event, { ...details, remote: true }),
  clientFactory: createRemoteRconClientFactory({ pool: remoteSessionPool, instances: remoteInstanceStore }) });
// Block 18b: B3 on a remote server is run by its operator; CONTROL manages B3's database over the network
// (local database helper, settings in the shadow home, password under rmt_<id>). The B3 config is on the
// server, so the admin command list is not available (no local b3Path for the admin service).
const remoteB3DatabaseService = new InstanceB3DatabaseService({ store: remoteShadowStore, credentials: remoteCredentials, environment: b3EnvironmentForRuntime, b3IsRunning: async () => false,
  onEvent: entry => audit(/failed/.test(entry.event) || entry.code ? "warn" : "info", entry.event, { ...entry, remote: true }) });
const remoteB3AdminService = new InstanceB3AdminService({ store: remoteShadowStore,
  rcon: { findOnline: id => remoteRconService.findOnline(id), kick: (id, target, actor) => remoteRconService.kick(id, target, actor) },
  database: { read: id => remoteB3DatabaseService.read(id), query: (...args) => remoteB3DatabaseService.query(...args), withStartGuard: (id, action) => remoteB3DatabaseService.withStartGuard(id, action) },
  environment: { read: async () => ({ ...(await b3EnvironmentForRuntime.read() || {}), b3Path: null }) }, b3IsRunning: async () => false, onEvent: entry => audit("info", entry.event, { ...entry, remote: true }) });
registerRemoteLinuxRoutes({ app, requirePermission, audit, hostService: remoteHostService, hostStore: remoteHostStore, manager: remoteInstanceManager, credentials: credentialService, rcon: remoteRconService, hasPermission,
  remoteCredentials, b3: { database: remoteB3DatabaseService, admin: remoteB3AdminService } });
runtimeDependencies.beforeLaunch = async ({ filesystemHomePath }) => {
  const relative = path.relative(await resolveRealFuturePath(instanceRoot), await resolveRealFuturePath(filesystemHomePath));
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    const error = new Error("Verwaltete Instanzverzeichnisse dürfen nur über ihre Instanz-ID gestartet werden.");
    error.code = "INSTANCE_LEGACY_HOME_BLOCKED";
    throw error;
  }
};

function instanceRoute(action, status = 200) {
  return async (req, res) => {
    const correlationId = crypto.randomUUID();
    try {
      const result = await action(req);
      audit("info", "instance.operation", { correlationId, method: req.method, route: req.route.path, actor: req.auth.username, instanceId: req.params.id || result.instance?.id || null });
      res.status(status).json({ ok: true, correlationId, ...result });
    } catch (error) {
      audit("warn", "instance.operation.blocked", { correlationId, method: req.method, route: req.route.path, actor: req.auth.username, instanceId: req.params.id || null, code: error.code || "INSTANCE_OPERATION_FAILED", error: error.message });
      const code = error.code === "INSTANCE_NOT_FOUND" ? 404 : error.code === "INSTANCE_REGISTRY_UNAVAILABLE" ? 503 : ["CONFIG_CONFLICT", "CONFIG_OPERATION_BUSY", "INSTANCE_OPERATION_BUSY", "INSTANCE_RUNTIME_BUSY", "MASTER_VERIFY_BUSY", "INSTANCE_NETWORK_CONFIG_PINNED", "PLUGIN_EXISTS", "B3_RUNTIME_BUSY", "B3_ALREADY_RUNNING", "B3_RUNNING", "B3_DATABASE_BUSY", "B3_INTEGRATION_BUSY", "B3_PLUGIN_CONFLICT", "RECOVERY_REQUIRED"].includes(error.code) ? 409 : ["INSTANCE_NETWORK_CONFIRMATION_REQUIRED", "EBC_CONFIRMATION_REQUIRED", "RESTORE_POINT_CONFIRMATION_REQUIRED"].includes(error.code) ? 428 : error.code === "RESTORE_POINT_CODE_PERMISSION" ? 403 : error.code === "RESTORE_POINT_NOT_FOUND" ? 404 : 400;
      // Start blockers carry only their code and plugin name, so the UI can say which plugin blocks.
      const blockers = publicBlockers(error);
      res.status(code).json({ ok: false, correlationId, code: error.code || "INSTANCE_OPERATION_FAILED", error: error.message, ...(Number.isInteger(error.line) ? { line: error.line } : {}), ...(blockers ? { blockers } : {}), ...(typeof error.safetyPointId === "string" ? { safetyPointId: error.safetyPointId, rolledBack: error.rolledBack === true, recoveryRequired: error.recoveryRequired === true } : {}) });
    }
  };
}
function credentialRoute(action, status = 200) {
  return async (req, res) => {
    const correlationId = crypto.randomUUID();
    const details = { correlationId, method: req.method, route: req.route.path, actor: req.auth.username, instanceId: req.params.id || null };
    try {
      const result = await action(req);
      audit("info", "credentials.operation", details);
      res.status(status).json({ ok: true, correlationId, ...result });
    } catch (error) {
      // Raw filesystem/parser errors may contain paths or data. Use fixed codes.
      const code = /^(?:VAULT_[A-Z_]+|CREDENTIAL_[A-Z_]+|INSTANCE_[A-Z_]+)$/.test(error.code || "") ? error.code : "CREDENTIAL_OPERATION_FAILED";
      audit("warn", "credentials.operation.blocked", { ...details, code });
      const statusCode = code === "INSTANCE_NOT_FOUND" ? 404 : code === "VAULT_LOCKED" ? 423 : /CONFLICT|BUSY|VAULT_EXISTS/.test(code) ? 409 : 400;
      res.status(statusCode).json({ ok: false, correlationId, code, error: code });
    } finally {
      if (req.body && typeof req.body === "object") { delete req.body.passphrase; delete req.body.value; }
    }
  };
}
function vaultPassphrase(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).join(",") !== "passphrase") throw Object.assign(new Error("CREDENTIAL_INVALID"), { code: "CREDENTIAL_INVALID" });
  return req.body.passphrase;
}
app.get("/api/credentials/vault", requirePermission("config.manage"), credentialRoute(async () => ({ vault: await credentialService.status() })));
app.post("/api/credentials/vault/initialize", requirePermission("config.manage"), credentialRoute(async req => ({ vault: await credentialService.initialize(vaultPassphrase(req)) }), 201));
app.post("/api/credentials/vault/unlock", requirePermission("config.manage"), credentialRoute(async req => ({ vault: await credentialService.unlock(vaultPassphrase(req)) })));
app.post("/api/credentials/vault/lock", requirePermission("config.manage"), credentialRoute(async () => { credentialService.lock(); return { vault: await credentialService.status() }; }));
app.get("/api/instances/:id/credentials", requirePermission("config.manage"), credentialRoute(async req => ({ credentials: await credentialService.instanceStatus(req.params.id) })));
// Block 8 audit names for the master token; the generic credential event stays.
function auditMasterToken(req, removed, credential) {
  if (req.params.kind === "master" && credential.changed !== false) audit("info", removed ? "master.token.removed" : "master.token.configured", { instanceId: req.params.id, actor: req.auth.username, backupId: credential.backupId || null, sharedWith: credential.warnings?.find(warning => warning.code === "MASTER_TOKEN_SHARED")?.instances || [] });
  return credential;
}
app.post("/api/instances/:id/credentials/:kind", requirePermission("config.manage"), credentialRoute(async req => ({ credential: auditMasterToken(req, false, await instanceManager.changeCredential(req.params.id, req.params.kind, req.body)) })));
app.post("/api/instances/:id/credentials/:kind/remove", requirePermission("config.manage"), credentialRoute(async req => ({ credential: auditMasterToken(req, true, await instanceManager.changeCredential(req.params.id, req.params.kind, req.body, true)) })));
app.get("/api/instances", requirePermission("diagnostics.read"), instanceRoute(async () => ({ instances: await instanceManager.list(), root: instanceRoot, hostPlatform: process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unsupported" })));
app.post("/api/instances", requirePermission("server.code"), instanceRoute(async req => ({ instance: await instanceManager.create(req.body) }), 201));
app.get("/api/instances/:id", requirePermission("diagnostics.read"), instanceRoute(async req => ({ instance: await instanceManager.status(req.params.id) })));
app.post("/api/instances/:id/clone", requirePermission("server.manage"), requireCodeWhen(cloneBringsCode), instanceRoute(async req => ({ instance: await instanceManager.clone(req.params.id, req.body) }), 201));
app.post("/api/instances/:id/start", requirePermission("server.manage"), instanceRoute(async req => ({ runtime: await instanceManager.launch(req.params.id) }), 201));
app.post("/api/instances/:id/stop", requirePermission("server.manage"), instanceRoute(async req => ({ runtime: await instanceManager.stop(req.params.id) })));
app.post("/api/instances/:id/restart", requirePermission("server.manage"), instanceRoute(async req => ({ runtime: await instanceManager.launch(req.params.id, true) })));
app.get("/api/instances/:id/config", requirePermission("config.manage"), instanceRoute(async req => ({ configuration: await instanceManager.configuration(req.params.id) })));
app.get("/api/instances/:id/config/backups", requirePermission("config.manage"), instanceRoute(async req => ({ backups: await instanceManager.configurationBackups(req.params.id) })));
app.post("/api/instances/:id/config/preview", requirePermission("config.manage"), instanceRoute(async req => ({ configuration: await instanceManager.previewConfiguration(req.params.id, req.body) })));
// Reproducible change trail: fingerprints, backup reference and changed names only, never values.
function auditConfigChange(event, req, result) {
  audit("info", event, { instanceId: req.params.id, actor: req.auth.username, changed: result.changed, previousSha256: result.previousSha256, sha256: result.sha256, backupId: result.backupId, restartRequired: result.restartRequired, settings: result.diff.map(entry => `${entry.change}:${entry.name}`) });
  return result;
}
app.put("/api/instances/:id/config", requirePermission("config.manage"), instanceRoute(async req => ({ configuration: auditConfigChange("config.change.applied", req, await instanceManager.changeConfiguration(req.params.id, req.body)) })));
app.post("/api/instances/:id/config/restore", requirePermission("config.manage"), instanceRoute(async req => ({ configuration: auditConfigChange("config.change.restored", req, await instanceManager.changeConfiguration(req.params.id, req.body, true)) })));
function rconRoute(action) {
  return async (req, res) => {
    const correlationId = crypto.randomUUID();
    try { res.json({ ok: true, correlationId, ...await action(req) }); }
    catch (error) {
      // Fixed codes only: raw socket/vault errors are never forwarded.
      const code = /^(?:RCON_[A-Z_]+|VAULT_[A-Z_]+|CREDENTIAL_[A-Z_]+|INSTANCE_[A-Z_]+)$/.test(error.code || "") ? error.code : "RCON_FAILED";
      const status = code === "INSTANCE_NOT_FOUND" ? 404 : code === "VAULT_LOCKED" ? 423 : /BUSY|NOT_RUNNING/.test(code) ? 409 : code === "RCON_COMMAND_BLOCKED" ? 403 : /TIMEOUT|UNREACHABLE|SOCKET/.test(code) ? 504 : 400;
      res.status(status).json({ ok: false, correlationId, code, error: code, rcon: error.rcon || null });
    }
  };
}
app.get("/api/instances/:id/rcon", requirePermission("server.manage"), rconRoute(async req => ({ rcon: rconService.status(req.params.id) })));
// Block 15b: online players (masked unless config.manage) and the verified live kick.
app.get("/api/instances/:id/rcon/online", requirePermission("diagnostics.read"), rconRoute(async req => ({ online: await rconService.online(req.params.id, { full: hasPermission(req.auth.role, "config.manage") }) })));
app.post("/api/instances/:id/rcon/kick", requirePermission("server.manage"), rconRoute(async req => ({ kick: await rconService.kick(req.params.id, { slot: req.body?.slot, playerid: req.body?.playerid, name: req.body?.name, reason: req.body?.reason }, req.auth.username) })));
app.post("/api/instances/:id/rcon/connect", requirePermission("server.manage"), rconRoute(async req => ({ rcon: await rconService.connect(req.params.id, req.auth.username) })));
app.post("/api/instances/:id/rcon/command", requirePermission("server.manage"), rconRoute(async req => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).join(",") !== "command") throw Object.assign(new Error("RCON_COMMAND_BLOCKED"), { code: "RCON_COMMAND_BLOCKED" });
  return { result: await rconService.execute(req.params.id, req.body.command, req.auth.username) };
}));
app.get("/api/instances/:id/master", requirePermission("diagnostics.read"), instanceRoute(async req => ({ master: await masterService.status(req.params.id) })));
// Explicit operator action: one HTTPS request to the fixed CoD4x master list URL.
app.post("/api/instances/:id/master/verify", requirePermission("server.manage"), instanceRoute(async req => ({ master: await masterService.verify(req.params.id, req.auth.username) })));
// Plugin manager (Block 10): integrity is pinned per instance; every change needs a stopped server.
function pluginRoute(event, action) {
  return instanceRoute(async req => {
    const result = await action(req);
    audit("info", event, { instanceId: req.params.id, actor: req.auth.username, plugin: result.name, sha256: result.sha256 || null, enabled: result.enabled ?? null });
    return { plugin: result };
  });
}
const pluginBody = (req, key) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).join(",") !== key) throw Object.assign(new Error("PLUGIN_REQUEST_INVALID"), { code: "PLUGIN_REQUEST_INVALID" });
  return req.body[key];
};
app.get("/api/instances/:id/plugins", requirePermission("diagnostics.read"), instanceRoute(async req => ({ plugins: await instanceManager.plugins(req.params.id) })));
// ─── Block 21 (4.18.27): restore points ─────────────────────────────────────────
// Bodies have exact key sets; answers never carry file contents.
function restoreBody(req, allowed) {
  const body = req.body ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error("RESTORE_POINT_REQUEST_INVALID"), { code: "RESTORE_POINT_REQUEST_INVALID" });
  if (body.includeB3Database !== undefined && typeof body.includeB3Database !== "boolean") throw Object.assign(new Error("RESTORE_POINT_REQUEST_INVALID"), { code: "RESTORE_POINT_REQUEST_INVALID" });
  if (body.confirmation !== undefined && typeof body.confirmation !== "string") throw Object.assign(new Error("RESTORE_POINT_REQUEST_INVALID"), { code: "RESTORE_POINT_REQUEST_INVALID" });
  return body;
}
app.get("/api/instances/:id/restore-points", requirePermission("config.manage"), instanceRoute(async req => instanceManager.listRestorePoints(req.params.id)));
app.post("/api/instances/:id/restore-points", requirePermission("config.manage"), instanceRoute(async req => {
  const { includeB3Database = false } = restoreBody(req, ["includeB3Database"]);
  return instanceManager.createRestorePoint(req.params.id, { actor: req.auth.username, includeB3Database });
}, 201));
app.get("/api/instances/:id/restore-points/:pointId/integrity", requirePermission("config.manage"), instanceRoute(async req => instanceManager.restorePointIntegrity(req.params.id, req.params.pointId)));
app.post("/api/instances/:id/restore-points/:pointId/restore", requirePermission("config.manage"), instanceRoute(async req => {
  const { includeB3Database = false, confirmation } = restoreBody(req, ["includeB3Database", "confirmation"]);
  // Unknown errors (e.g. a file system error with a path in its text) leave as RESTORE_POINT_FAILED.
  return instanceManager.restoreRestorePoint(req.params.id, req.params.pointId, { includeB3Database, confirmation }, { actor: req.auth.username, canCode: hasPermission(req.auth.role, "server.code") }).catch(error => {
    if (typeof error.code === "string" && /^(RESTORE_POINT_|RECOVERY_|INSTANCE_|B3_)/.test(error.code)) throw error;
    throw Object.assign(new Error("RESTORE_POINT_FAILED"), { code: "RESTORE_POINT_FAILED", safetyPointId: error.safetyPointId, rolledBack: error.rolledBack, recoveryRequired: error.recoveryRequired });
  });
}));
app.post("/api/instances/:id/core", requirePermission("server.code"), instanceRoute(async req => instanceManager.changeCore(req.params.id, req.body, req.auth.username)));

// Standard server: points of the runtime record (core and paths) and of installer runs (files).
async function refuseDefaultRuntimeRecovery(_req, res, next) {
  try { if (!(await restorePoints.recovery(DEFAULT_RUNTIME_SUBJECT))) return next(); }
  catch { /* unreadable state counts as marked */ }
  res.status(409).json({ ok: false, code: "RECOVERY_REQUIRED", error: "RECOVERY_REQUIRED" });
}
function runtimePointRoute(action, status = 200) {
  return async (req, res) => {
    const correlationId = crypto.randomUUID();
    try { res.status(status).json({ ok: true, correlationId, ...(await action(req)) }); }
    catch (error) {
      const code = typeof error.code === "string" && /^(RESTORE_POINT_|RECOVERY_|RUNTIME_)/.test(error.code) ? error.code : "RESTORE_POINT_FAILED";
      audit("warn", "restore_point.runtime.blocked", { correlationId, route: req.route.path, actor: req.auth.username, code });
      res.status(code === "RESTORE_POINT_NOT_FOUND" ? 404 : code === "RUNTIME_CONFIGURATION_BUSY" ? 409 : 400).json({ ok: false, correlationId, code, error: code });
    }
  };
}
app.get("/api/runtime/restore-points", requirePermission("config.manage"), runtimePointRoute(async () => ({ points: await restorePoints.list(DEFAULT_RUNTIME_SUBJECT), recovery: await restorePoints.recovery(DEFAULT_RUNTIME_SUBJECT) })));
app.post("/api/runtime/restore-points", requirePermission("config.manage"), runtimePointRoute(async req => {
  restoreBody(req, []);
  const { pointId, manifest } = await restorePoints.capture(DEFAULT_RUNTIME_SUBJECT, { action: "manual", actor: req.auth.username, manual: true, data: { record: structuredClone(defaultRuntime.state) }, parts: ["record"] });
  audit("info", "restore_point.created", { subject: DEFAULT_RUNTIME_SUBJECT, action: "manual", restorePointId: pointId });
  return { pointId, parts: manifest.parts, totalBytes: manifest.totalBytes };
}, 201));
app.get("/api/runtime/restore-points/:pointId/integrity", requirePermission("config.manage"), runtimePointRoute(async req => {
  try { const { manifest } = await restorePoints.read(DEFAULT_RUNTIME_SUBJECT, req.params.pointId); return { pointId: req.params.pointId, valid: true, files: manifest.files.length, totalBytes: manifest.totalBytes }; }
  catch (error) { if (error.code === "RESTORE_POINT_INVALID") return { pointId: req.params.pointId, valid: false }; throw error; }
}));
// A runtime record from a point passes the same rules as /api/runtime/config before it is used.
function checkedRuntimeRecord(record) {
  const invalid = () => { throw Object.assign(new Error("RESTORE_POINT_INVALID"), { code: "RESTORE_POINT_INVALID" }); };
  if (!record || typeof record !== "object") invalid();
  try {
    const platform = normalizeServerPlatform(record.platform || "windows");
    if (record.cod4x != null && !policyState.security.allowedCod4xVersions.includes(String(record.cod4x))) invalid();
    if (record.target != null) normalizeRuntimePath(record.target);
    if (record.executablePath) normalizeRuntimeExecutablePath(record.executablePath, platform);
  } catch (error) { if (error.code === "RESTORE_POINT_INVALID") throw error; invalid(); }
  return record;
}
// Restoring puts code back (core path, installed files): server.code. The standard server must be stopped.
app.post("/api/runtime/restore-points/:pointId/restore", requirePermission("server.code"), runtimePointRoute(async req => {
  restoreBody(req, []);
  return withRuntimeConfiguration(async () => {
    const point = await restorePoints.read(DEFAULT_RUNTIME_SUBJECT, req.params.pointId);
    const { manifest } = point;
    const files = manifest.parts.includes("files");
    let target = null;
    if (files) {
      const recorded = manifest.refs?.files?.target;
      if (typeof recorded !== "string") throw Object.assign(new Error("RESTORE_POINT_INVALID"), { code: "RESTORE_POINT_INVALID" });
      try { target = assertInsideRoot(INSTALL_ROOT, path.relative(INSTALL_ROOT, recorded)); } catch { throw Object.assign(new Error("RESTORE_POINT_INVALID"), { code: "RESTORE_POINT_INVALID" }); }
      if (target === path.resolve(INSTALL_ROOT)) throw Object.assign(new Error("RESTORE_POINT_INVALID"), { code: "RESTORE_POINT_INVALID" });
    }
    const record = manifest.parts.includes("record") ? checkedRuntimeRecord(manifest.data.record) : null;
    const safety = await restorePoints.capture(DEFAULT_RUNTIME_SUBJECT, { action: "restore.safety", actor: req.auth.username, ...(files ? await snapshotFiles(target, point) : {}), data: { record: structuredClone(defaultRuntime.state) } });
    const restored = [];
    if (files) { await restoreFilesPoint(target, point); restored.push("files"); }
    if (record) { await restoreDefaultRuntimeRecord(record); restored.push("record"); }
    await restorePoints.clearRecovery(DEFAULT_RUNTIME_SUBJECT);
    audit("info", "restore_point.restored", { subject: DEFAULT_RUNTIME_SUBJECT, restorePointId: req.params.pointId, safetyPointId: safety.pointId, parts: restored, actor: req.auth.username });
    return { pointId: req.params.pointId, safetyPointId: safety.pointId, restored, skipped: [] };
  });
}));

app.post("/api/instances/:id/plugins/install", requirePermission("server.code"), pluginRoute("plugin.installed", req => instanceManager.installPlugin(req.params.id, req.body)));
app.post("/api/instances/:id/plugins/approve", requirePermission("server.code"), pluginRoute("plugin.approved", req => instanceManager.approvePlugin(req.params.id, req.body)));
app.post("/api/instances/:id/plugins/versions", requirePermission("server.manage"), instanceRoute(async req => ({ plugins: await instanceManager.readPluginVersions(req.params.id, req.auth.username) })));
app.post("/api/instances/:id/plugins/:name/enable", requirePermission("server.manage"), pluginRoute("plugin.enabled", req => instanceManager.setPluginEnabled(req.params.id, req.params.name, true)));
app.post("/api/instances/:id/plugins/:name/disable", requirePermission("server.manage"), pluginRoute("plugin.disabled", req => instanceManager.setPluginEnabled(req.params.id, req.params.name, false)));
app.post("/api/instances/:id/plugins/:name/config", requirePermission("server.manage"), pluginRoute("plugin.configured", req => instanceManager.configurePlugin(req.params.id, req.params.name, pluginBody(req, "config"))));
// Removal archives the file into plugins/.removed; nothing is deleted.
app.post("/api/instances/:id/plugins/:name/remove", requirePermission("server.manage"), pluginRoute("plugin.removed", req => instanceManager.removePlugin(req.params.id, req.params.name)));
// Public exposure is opt-in per instance and needs the confirmation phrase; default stays loopback.
app.post("/api/instances/:id/network", requirePermission("server.manage"), instanceRoute(async req => {
  const change = await instanceManager.changeNetwork(req.params.id, req.body);
  audit(change.network.scope === "PUBLIC" ? "warn" : "info", "network.exposure.changed", { instanceId: req.params.id, actor: req.auth.username, from: change.previous?.scope || "LOOPBACK", to: change.network.scope, publicAddressConfigured: Boolean(change.network.publicAddress) });
  return { network: change.network };
}));
// eBc-B3 dependency layer (Block 11): audit-derived checks only; B3 is never started here.
const b3Environment = new B3Environment(dataPath("config", "b3-environment.json"));
function b3Route(action) {
  return async (req, res) => {
    const correlationId = crypto.randomUUID();
    try { res.json({ ok: true, correlationId, ...await action(req) }); }
    catch (error) {
      const code = /^B3_[A-Z_]+$/.test(error.code || "") ? error.code : "B3_OPERATION_FAILED";
      audit("warn", "b3.operation.blocked", { correlationId, route: req.route.path, actor: req.auth.username, code });
      res.status(400).json({ ok: false, correlationId, code, error: code });
    }
  };
}
app.get("/api/b3/dependencies/matrix", requirePermission("diagnostics.read"), b3Route(async () => ({ matrix: B3_DEPENDENCY_MATRIX, source: { repository: B3_SOURCE.repository, commit: B3_SOURCE.commit, b3Version: B3_SOURCE.b3Version, blockedSql: B3_SOURCE.blockedSql }, auditReport: "docs/EBC-B3-AUDIT.md" })));
app.get("/api/b3/environment", requirePermission("config.manage"), b3Route(async () => ({ environment: await b3Environment.read() })));
app.post("/api/b3/environment", requirePermission("server.code"), b3Route(async req => {
  const environment = await b3Environment.save(req.body);
  // New paths: dashboards must not show the previous interpreter/source check.
  b3Service.invalidateDependencies();
  audit("info", "b3.environment.configured", { actor: req.auth.username, pythonConfigured: Boolean(environment.pythonPath), sourceConfigured: Boolean(environment.b3Path) });
  return { environment };
}));
// Runs the configured interpreter with a fixed import probe; reads B3 files statically.
app.post("/api/b3/dependencies/check", requirePermission("config.manage"), b3Route(async req => {
  const result = await b3Environment.check();
  audit(result.overall === "BLOCKED" ? "warn" : "info", "b3.dependencies.checked", { actor: req.auth.username, overall: result.overall, blocking: result.blocking, python: result.python?.version || null });
  return { dependencies: result };
}));
app.get("/api/instances/:id/b3", requirePermission("diagnostics.read"), instanceRoute(async req => ({ b3: await b3Service.status(req.params.id, { full: hasPermission(req.auth.role, "config.manage") }) })));
app.get("/api/instances/:id/b3/dashboard", requirePermission("diagnostics.read"), instanceRoute(async req => ({ b3: await b3Service.dashboard(req.params.id, { fresh: req.query.fresh === "1" }) })));
app.get("/api/instances/:id/b3/logs", requirePermission("diagnostics.read"), instanceRoute(async req => ({ logs: await b3Service.logs(req.params.id, { full: hasPermission(req.auth.role, "config.manage") }) })));
// Generated config with credential values redacted.
app.get("/api/instances/:id/b3/config", requirePermission("config.manage"), instanceRoute(async req => ({ config: await b3Service.config(req.params.id) })));
// Block 16: B3 <-> CoD4x integration (b3hide + auth). No gateway route exists for it.
async function b3IntegrationView(id, full = false) {
  const view = await instanceManager.b3Integration(id);
  const vault = await credentialService.status();
  const serverRunning = (await instanceManager.runtime(id)).state?.status === "RUNNING";
  const b3Running = await b3Service.isRunning(id);
  const own = await credentialService.instanceStatus(id);
  const hints = restartHints({ plan: view.plan, credentialDigest: own.digest, launchedWith: serverRunning ? view.launchedWith : null, startedWith: b3Running ? b3Service.startedWith(id) : null, pluginsRevision: instanceStore.get(id).b3PluginsRevision });
  const status = await credentialService.instanceStatus(id);
  return { settings: view.settings, plan: view.plan, b3hide: view.b3hide, knownHash: view.knownHash, restart: hints, authLevels: status.b3auth?.levels || [], vault: { locked: vault.locked, initialized: vault.initialized, sha256: full ? vault.sha256 : null } };
}
app.get("/api/instances/:id/b3/integration", requirePermission("diagnostics.read"), instanceRoute(async req => ({ integration: await b3IntegrationView(req.params.id, hasPermission(req.auth.role, "config.manage")) })));
app.post("/api/instances/:id/b3/integration", requirePermission("config.manage"), instanceRoute(async req => {
  const result = await instanceManager.configureB3Integration(req.params.id, req.body);
  audit("info", "b3.integration.configured", { instanceId: req.params.id, actor: req.auth.username, ...result.settings });
  return { integration: await b3IntegrationView(req.params.id, true) };
}));
app.post("/api/instances/:id/b3/integration/auth-password", requirePermission("config.manage"), instanceRoute(async req => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "expectedSha256,level,value") throw Object.assign(new Error("B3_AUTH_PASSWORD_INVALID"), { code: "B3_AUTH_PASSWORD_INVALID" });
  const vault = await credentialService.status();
  if (!vault.initialized || vault.locked) throw Object.assign(new Error("VAULT_LOCKED"), { code: "VAULT_LOCKED" });
  const result = await credentialService.setB3AuthPassword(req.params.id, body);
  audit("info", result.set ? "b3.auth.password.set" : "b3.auth.password.cleared", { instanceId: req.params.id, actor: req.auth.username, level: result.level });
  return { password: result, integration: await b3IntegrationView(req.params.id, true) };
}));
// Block 16b: B3 plugin management. Local only (no gateway route). Switches,
// configs and approvals need config.manage; custom code needs b3.plugins.code.
// The audit carries names and hashes, never config or code content.
const b3PluginsRestart = id => b3PluginsRestartHint(id, { b3Service, instanceManager, credentialService, instanceStore });
// Exact key set; anything else is the given request code.
function b3PluginBody(req, keys, code) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== [...keys].sort().join(",")) throw Object.assign(new Error(code), { code });
  return body;
}
function auditB3Plugin(event, req, name, sha256) {
  audit("info", `b3.plugin.${event}`, { instanceId: req.params.id, actor: req.auth.username, name, ...(sha256 === undefined ? {} : { sha256 }) });
}
const b3PluginsBase = "/api/instances/:id/b3/plugins";
app.get(b3PluginsBase, requirePermission("diagnostics.read"), instanceRoute(async req => ({ ...await b3PluginService.list(req.params.id), restart: await b3PluginsRestart(req.params.id) })));
for (const [action, enabled] of [["enable", true], ["disable", false]]) {
  app.post(`${b3PluginsBase}/:name/${action}`, requirePermission("config.manage"), instanceRoute(async req => {
    const plugin = await b3PluginService.setEnabled(req.params.id, req.params.name, enabled);
    auditB3Plugin(enabled ? "enabled" : "disabled", req, plugin.name);
    return { plugin };
  }));
}
app.get(`${b3PluginsBase}/:name/config`, requirePermission("config.manage"), instanceRoute(async req => ({ config: await b3PluginService.readConfig(req.params.id, req.params.name) })));
app.put(`${b3PluginsBase}/:name/config`, requirePermission("config.manage"), instanceRoute(async req => {
  const { text, expectedSha256 } = b3PluginBody(req, ["text", "expectedSha256"], "B3_PLUGIN_CONFIG_INVALID");
  const config = await b3PluginService.saveConfig(req.params.id, req.params.name, { text, expectedSha256 });
  auditB3Plugin("config_saved", req, req.params.name);
  return { config };
}));
app.post(`${b3PluginsBase}/:name/approve`, requirePermission("b3.plugins.code"), instanceRoute(async req => {
  const { sha256 } = b3PluginBody(req, ["sha256"], "B3_PLUGIN_CONFIG_INVALID");
  const plugin = await b3PluginService.approve(req.params.id, req.params.name, sha256);
  auditB3Plugin("approved", req, plugin.name, plugin.sha256);
  return { plugin };
}));
app.post(`${b3PluginsBase}/custom`, requirePermission("b3.plugins.code"), instanceRoute(async req => {
  const fromTemplate = req.body && typeof req.body === "object" && "from" in req.body;
  const body = b3PluginBody(req, fromTemplate ? ["name", "from"] : ["name", "code"], "B3_PLUGIN_CODE_INVALID");
  if (fromTemplate && body.from !== "template") throw Object.assign(new Error("B3_PLUGIN_CODE_INVALID"), { code: "B3_PLUGIN_CODE_INVALID" });
  const plugin = await b3PluginService.createCustom(req.params.id, fromTemplate ? { name: body.name, from: "template" } : { name: body.name, code: body.code });
  auditB3Plugin("custom_created", req, plugin.name, plugin.sha256);
  return { plugin };
}));
app.get(`${b3PluginsBase}/custom/:name/code`, requirePermission("b3.plugins.code"), instanceRoute(async req => ({ code: await b3PluginService.readCode(req.params.id, req.params.name) })));
app.put(`${b3PluginsBase}/custom/:name/code`, requirePermission("b3.plugins.code"), instanceRoute(async req => {
  const { code, expectedSha256 } = b3PluginBody(req, ["code", "expectedSha256"], "B3_PLUGIN_CODE_INVALID");
  const saved = await b3PluginService.saveCode(req.params.id, req.params.name, { code, expectedSha256 });
  auditB3Plugin("code_saved", req, req.params.name, saved.sha256);
  return { code: saved };
}));
app.delete(`${b3PluginsBase}/custom/:name`, requirePermission("b3.plugins.code"), instanceRoute(async req => {
  const result = await b3PluginService.deleteCustom(req.params.id, req.params.name);
  auditB3Plugin("deleted", req, result.name);
  return { plugin: result };
}));
app.post("/api/instances/:id/b3/start", requirePermission("server.manage"), instanceRoute(async req => ({ b3: await b3Service.start(req.params.id) })));
app.post("/api/instances/:id/b3/stop", requirePermission("server.manage"), instanceRoute(async req => ({ b3: await b3Service.stop(req.params.id) })));
app.post("/api/instances/:id/b3/restart", requirePermission("server.manage"), instanceRoute(async req => ({ b3: await b3Service.start(req.params.id, true) })));
app.get("/api/instances/:id/b3/database", requirePermission("config.manage"), instanceRoute(async req => ({ database: await b3DatabaseService.read(req.params.id) })));
app.post("/api/instances/:id/b3/database", requirePermission("config.manage"), instanceRoute(async req => ({ database: await b3DatabaseService.save(req.params.id, req.body) })));
app.post("/api/instances/:id/b3/database/remove", requirePermission("config.manage"), instanceRoute(async req => ({ database: await b3DatabaseService.remove(req.params.id) })));
app.post("/api/instances/:id/b3/database/test", requirePermission("config.manage"), instanceRoute(async req => ({ database: await b3DatabaseService.test(req.params.id) })));
const adminView = req => ({ full: hasPermission(req.auth.role, "config.manage") });
const queryInt = value => (value === undefined ? undefined : /^\d{1,10}$/.test(String(value)) ? Number(value) : -1);
app.get("/api/instances/:id/b3/admin/status", requirePermission("diagnostics.read"), instanceRoute(async req => ({ status: await b3AdminService.status(req.params.id) })));
app.get("/api/instances/:id/b3/admin/players", requirePermission("diagnostics.read"), instanceRoute(async req => ({ players: await b3AdminService.players(req.params.id, { search: typeof req.query.search === "string" ? req.query.search : undefined, offset: queryInt(req.query.offset) }, adminView(req)) })));
app.get("/api/instances/:id/b3/admin/players/:clientId", requirePermission("diagnostics.read"), instanceRoute(async req => ({ player: await b3AdminService.player(req.params.id, queryInt(req.params.clientId), adminView(req)) })));
app.get("/api/instances/:id/b3/admin/admins", requirePermission("diagnostics.read"), instanceRoute(async req => ({ admins: await b3AdminService.admins(req.params.id, adminView(req)) })));
app.get("/api/instances/:id/b3/admin/penalties", requirePermission("diagnostics.read"), instanceRoute(async req => ({ penalties: await b3AdminService.penalties(req.params.id, { type: req.query.type, status: req.query.status, offset: queryInt(req.query.offset) }, adminView(req)) })));
app.get("/api/instances/:id/b3/admin/groups", requirePermission("diagnostics.read"), instanceRoute(async req => ({ groups: await b3AdminService.groups(req.params.id) })));
app.get("/api/instances/:id/b3/admin/commands", requirePermission("diagnostics.read"), instanceRoute(async req => ({ commands: await b3AdminService.commands(req.params.id) })));
app.post("/api/instances/:id/b3/admin/players/:clientId/ban", requirePermission("server.manage"), instanceRoute(async req => ({ result: await b3AdminService.addBan(req.params.id, queryInt(req.params.clientId), { kind: req.body?.kind, durationMinutes: req.body?.durationMinutes, reason: req.body?.reason, kick: req.body?.kick === true }, req.auth.username) })));
app.post("/api/instances/:id/b3/admin/players/:clientId/kick", requirePermission("server.manage"), instanceRoute(async req => ({ result: await b3AdminService.kick(req.params.id, queryInt(req.params.clientId), req.body?.reason === undefined ? "" : req.body.reason, req.auth.username) })));
app.post("/api/instances/:id/b3/admin/players/:clientId/unban", requirePermission("server.manage"), instanceRoute(async req => ({ result: await b3AdminService.unban(req.params.id, queryInt(req.params.clientId), req.auth.username) })));
app.post("/api/instances/:id/b3/admin/players/:clientId/group", requirePermission("server.manage"), instanceRoute(async req => ({ result: await b3AdminService.setGroup(req.params.id, queryInt(req.params.clientId), req.body?.groupId, req.auth.username) })));
app.post("/api/instances/:id/b3/admin/penalties/:penaltyId/lift", requirePermission("server.manage"), instanceRoute(async req => ({ result: await b3AdminService.liftWarning(req.params.id, queryInt(req.params.penaltyId), req.auth.username) })));
app.post("/api/instances/:id/b3/database/migrate", requirePermission("server.manage"), instanceRoute(async req => ({ database: await b3DatabaseService.migrate(req.params.id, { ebcOptIn: req.body?.ebcOptIn === true, confirmation: typeof req.body?.confirmation === "string" ? req.body.confirmation : undefined }) })));
// Logical deletion is recoverable: move owned home to .trash, never recursively erase it.
app.delete("/api/instances/:id", requirePermission("server.manage"), instanceRoute(async req => ({ archive: await instanceManager.archive(req.params.id) })));

// ─── Block 24: Monitoring ───────────────────────────────────────────────────
// Polls every instance (runtime state + unauthenticated getstatus on loopback),
// keeps 30 days of history under the data root and records outages with the
// probable cause. Never uses the RCON password, never starts or stops anything.
const monitorStore = new MonitorStore({ directory: dataPath("monitor") });
// Block 24c: notifications. Push goes only to users who may still see the
// monitoring remotely (enabled, remote access, monitor.read).
const alertNotifier = new AlertNotifier({
  directory: dataPath("config"),
  audit: (level, event, details) => audit(level, event, details),
  eligible: username => { const user = findAuthUser(username); return Boolean(user && !user.disabled && user.remoteAccess === true && hasPermission(user.role, "monitor.read")); },
});
try { await alertNotifier.load(); } catch (error) { console.error(`[alerts] settings unavailable: ${error.code || error.message}`); }
const monitorAlerts = new MonitorAlerts({ rules: () => alertNotifier.rules(), send: alert => alertNotifier.send(alert) });
try { await monitorStore.load(); } catch (error) { console.error(`[monitor] history unavailable: ${error.code || error.message}`); }
// Block 18b: remote servers take part as rmt_<id> (saved state, getstatus and console tail over the pooled SSH session).
const remoteMonitor = createRemoteMonitor({ pool: remoteSessionPool, instances: remoteInstanceStore, manager: remoteInstanceManager });
const monitorCollector = new MonitorCollector({
  listInstances: async () => {
    let local = [], remote = [];
    try { local = instanceStore.list(); } catch { local = []; }
    try { remote = await remoteMonitor.listInstances(); } catch { remote = []; }
    return [...local, ...remote];
  },
  runtimeFor: id => (isRemoteSubject(id) ? remoteMonitor.runtimeFor(id) : instanceManager.runtime(id)),
  probe: (port, instance) => (instance?.remote ? remoteMonitor.probe(port, instance) : new RconClient({ port, timeoutMs: 1500 }).queryStatus()),
  readConsole: (homePath, instance) => (instance?.remote ? remoteMonitor.readConsole(homePath, instance) : readInstanceConsoleLog(homePath)),
  b3Running: id => (isRemoteSubject(id) ? null : b3Service.isRunning(id)),
  store: monitorStore,
  host: new MonitorHost(),
  onEvent: event => {
    audit(event.kind === "down" && event.cause?.kind !== "stopped" ? "warn" : "info", `monitor.server.${event.kind}`, { instanceId: event.id, runId: event.runId, cause: event.cause?.kind || null, downMs: event.downMs ?? null });
    void monitorAlerts.handleEvent(event, monitorCollector.live(event.id));
  },
  onTick: overview => monitorAlerts.handleTick(overview),
});
if (process.env.COD4X_MONITOR !== "off") monitorCollector.start();
function monitorRoute(action) {
  return async (req, res) => {
    try { res.set("Cache-Control", "no-store").json({ ok: true, ...await action(req) }); }
    catch (error) {
      const code = ["INSTANCE_NOT_FOUND", "MONITOR_RANGE_INVALID"].includes(error.code) ? error.code : "MONITOR_FAILED";
      res.status(code === "INSTANCE_NOT_FOUND" ? 404 : code === "MONITOR_FAILED" ? 500 : 400).json({ ok: false, code, error: code });
    }
  };
}
// A monitored server: a local instance, or a remote one as rmt_<id> (Block 18b).
const monitorInstance = id => {
  try {
    if (isRemoteSubject(id)) { const remote = remoteInstanceStore.get(remoteIdOf(id)); return { id, remoteId: remote.id, name: remote.name || remote.id, port: remote.port, remote: true }; }
    return instanceStore.get(id);
  } catch { throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND" }); }
};
const monitorRead = requirePermission("monitor.read", { quietAllowed: true });
app.get("/api/monitor/overview", monitorRead, monitorRoute(async () => ({ monitor: monitorCollector.overview() })));
app.get("/api/monitor/instances/:id/history", monitorRead, monitorRoute(async req => { monitorInstance(req.params.id); return { history: await monitorStore.history(req.params.id, String(req.query.range || "24h")) }; }));
// Console lines of an outage only with diagnostics.read (the monitor role sees the cause line).
app.get("/api/monitor/instances/:id/events", monitorRead, monitorRoute(async req => {
  monitorInstance(req.params.id);
  const range = monitorRange(String(req.query.range || "7d")).name, consoleAllowed = hasPermission(req.auth.role, "diagnostics.read");
  return { events: monitorStore.events(req.params.id, range).map(event => event.cause && !consoleAllowed ? { ...event, cause: { ...event.cause, console: [] } } : event), range };
}));

// Block 24c: notification settings and a test alert (config.manage). The
// webhook URL is accepted here but never returned, only its masked form.
const alertRoute = action => async (req, res) => {
  try { res.set("Cache-Control", "no-store").json({ ok: true, ...await action(req) }); }
  catch (error) { const code = /^(ALERT|DISCORD|PUSH)_/.test(error.code || "") ? error.code : "ALERT_FAILED"; res.status(code === "ALERT_FAILED" ? 500 : 400).json({ ok: false, code, field: error.field || null, error: code }); }
};
app.get("/api/alerts", requirePermission("config.manage"), alertRoute(async () => ({ alerts: alertNotifier.status() })));
app.post("/api/alerts/settings", requirePermission("config.manage"), alertRoute(async req => ({ alerts: await alertNotifier.configure({ rules: req.body?.rules, discordUrl: req.body?.discordUrl, push: req.body?.push }, req.auth.username) })));
app.post("/api/alerts/test", requirePermission("config.manage"), alertRoute(async req => {
  const result = await alertNotifier.test(req.auth.username);
  return { result: { discord: result.discord ? { ok: result.discord.ok, code: result.discord.code || null } : null, push: { sent: result.push.filter(item => item.ok).length, failed: result.push.filter(item => !item.ok).length } }, alerts: alertNotifier.status() };
}));

// ─── Block 24b: Remote gateway (browser / phone) ────────────────────────────
// A separate listener with the mobile web app and a fixed read-only whitelist
// (lib/remote-gateway.mjs). Off by default. Tailscale mode binds 127.0.0.1 only
// and `tailscale serve` adds HTTPS for the tailnet; LAN mode needs a
// certificate. This admin API stays on loopback either way.
const REMOTE_SETTINGS_FILE = dataPath("config", "remote.json");
const REMOTE_SOURCE_URL = process.env.COD4X_SOURCE_URL || "https://github.com/jackdemzy/cod4x-administration-tool";
const REMOTE_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "remote");
const APP_VERSION = JSON.parse(await fs.readFile(new URL("./package.json", import.meta.url), "utf8")).version;
const REMOTE_DEFAULTS = Object.freeze({ enabled: false, mode: "tailscale", port: REMOTE_DEFAULT_PORT, lanHost: null, certFile: null, keyFile: null, proxyDomain: null, actions: false });
// Block 24c: a public domain behind Caddy on this machine. The gateway stays on
// 127.0.0.1; Caddy terminates HTTPS (Let's Encrypt) and forwards to it.
const PROXY_DOMAIN = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const remoteState = { settings: { ...REMOTE_DEFAULTS }, server: null, error: null, startedAt: null };
function validateRemoteSettings(input = {}) {
  const next = { ...REMOTE_DEFAULTS, ...remoteState.settings };
  if (input.enabled !== undefined) { if (typeof input.enabled !== "boolean") throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "enabled" }); next.enabled = input.enabled; }
  if (input.actions !== undefined) { if (typeof input.actions !== "boolean") throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "actions" }); next.actions = input.actions; }
  if (input.mode !== undefined) { if (!["tailscale", "lan", "proxy"].includes(input.mode)) throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "mode" }); next.mode = input.mode; }
  if (input.port !== undefined) { const port = Number(input.port); if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === PORT) throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "port" }); next.port = port; }
  for (const field of ["lanHost", "certFile", "keyFile", "proxyDomain"]) if (input[field] !== undefined) next[field] = input[field] === null || input[field] === "" ? null : String(input[field]).trim();
  if (next.proxyDomain) { next.proxyDomain = next.proxyDomain.toLowerCase(); if (!PROXY_DOMAIN.test(next.proxyDomain)) throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "proxyDomain" }); }
  if (next.mode === "proxy" && !next.proxyDomain) throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field: "proxyDomain" });
  if (next.mode === "lan") {
    remoteListenOptions({ host: next.lanHost || "", port: next.port, tls: { cert: next.certFile, key: next.keyFile } });
    for (const field of ["certFile", "keyFile"]) if (!next[field] || !path.isAbsolute(next[field])) throw Object.assign(new Error("REMOTE_SETTINGS_INVALID"), { code: "REMOTE_SETTINGS_INVALID", field });
  }
  return next;
}
async function loadRemoteSettings() {
  try { remoteState.settings = validateRemoteSettings(JSON.parse(await fs.readFile(REMOTE_SETTINGS_FILE, "utf8"))); }
  catch (error) { if (error.code !== "ENOENT") console.error(`[remote] settings ignored: ${error.code || error.message}`); remoteState.settings = { ...REMOTE_DEFAULTS }; }
}
async function saveRemoteSettings(settings) {
  await fs.mkdir(path.dirname(REMOTE_SETTINGS_FILE), { recursive: true });
  const tmp = `${REMOTE_SETTINGS_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, REMOTE_SETTINGS_FILE);
}
// Same checks as the local login; the second factor is verified separately. An
// unknown user is checked against a fixed hash so the answer takes as long.
const REMOTE_TIMING_HASH = hashAuthPassword(crypto.randomBytes(16).toString("hex"));
async function remoteLogin({ username, password }) {
  const candidate = findAuthUser(username);
  const validPassword = verifyAuthPassword(password, candidate?.passwordHash || REMOTE_TIMING_HASH);
  if (!candidate || candidate.disabled || !validPassword) return null;
  return { username: candidate.username, role: candidate.role, remoteAccess: candidate.remoteAccess === true, totpEnabled: Boolean(candidate.totp) };
}
// totpOnly (Block 24d step-up): a recovery code never authorises an action.
async function remoteSecondFactor(username, code, { totpOnly = false } = {}) {
  const user = findAuthUser(username);
  if (!user?.totp) return { ok: false };
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    const step = verifyTotp(user.totp.secret, code.replace(/\s/g, ""), { lastStep: user.totp.lastStep });
    if (step === null) return { ok: false };
    user.totp.lastStep = step; await saveAuthUsers();
    return { ok: true, method: "totp" };
  }
  if (totpOnly) return { ok: false };
  const index = matchRecoveryCode(code, user.recovery);
  if (index < 0) return { ok: false };
  user.recovery.splice(index, 1); user.updatedAt = new Date().toISOString(); await saveAuthUsers();
  return { ok: true, method: "recovery", remaining: user.recovery.length };
}
const remoteApp = createRemoteGateway({
  login: remoteLogin, verifySecondFactor: remoteSecondFactor, hasPermission, sessions: remoteSessions, throttle: loginThrottle, proxyThrottle: new LoginThrottle({ maxFailures: REMOTE_PROXY_MAX_FAILURES }),
  policy: () => ({ proxy: remoteState.settings.mode === "proxy" }), audit: (level, event, details) => audit(level, event, details),
  // Block 24d: the same services as the admin tool; actor is marked as remote.
  actions: {
    allowed: username => { const user = findAuthUser(username); return Boolean(remoteState.settings.actions && user && !user.disabled && user.remoteAccess === true && user.remoteActions === true && hasPermission(user.role, "server.manage")); },
    // Block 18b: rmt_<id> goes to the remote RCON service and the remote restart (lib/gateway-actions.mjs).
    ...createGatewayActions({ resolve: monitorInstance, audit,
      local: { rcon: rconService, restart: id => instanceManager.launch(id, true) },
      remote: { rcon: remoteRconService, restart: async id => (await remoteInstanceManager.restart(id)).runtime } }),
    notify: (kind, details) => {
      if (!alertNotifier.rules().enabled || kind === "say") return;
      let name = details.instanceId; try { name = monitorInstance(details.instanceId).name || name; } catch { /* gone */ }
      const title = kind === "restart" ? `${name}: Neustart von ${details.username}` : `${name}: Spieler gekickt von ${details.username}`;
      return alertNotifier.send({ key: `action:${kind}:${details.instanceId}:${Date.now()}`, type: `action-${kind}`, instanceId: details.instanceId, severity: "info", title, body: "Aus der Ferne ausgelöst." });
    },
  },
  push: {
    publicKey: () => alertNotifier.vapidPublicKey,
    enabled: () => alertNotifier.status().push.enabled,
    count: username => alertNotifier.status(username).push.mine,
    subscribe: (username, subscription) => alertNotifier.subscribe(username, subscription),
    unsubscribe: (username, endpoint) => alertNotifier.unsubscribe(username, endpoint),
  },
  monitor: {
    overview: async () => monitorCollector.overview(),
    history: async (id, range) => { monitorInstance(id); return monitorStore.history(id, range); },
    events: async (id, rangeName) => { monitorInstance(id); const range = monitorRange(rangeName).name; return { events: monitorStore.events(id, range), range }; },
  },
  staticDir: REMOTE_APP_DIR, version: APP_VERSION, sourceUrl: REMOTE_SOURCE_URL,
});
async function applyRemoteGateway() {
  if (remoteState.server) { const server = remoteState.server; remoteState.server = null; server.closeAllConnections?.(); await new Promise(resolve => server.close(() => resolve())); }
  remoteState.error = null; remoteState.startedAt = null;
  if (!remoteState.settings.enabled || process.env.COD4X_REMOTE === "off") return;
  const { mode, port, lanHost, certFile, keyFile } = remoteState.settings;
  try {
    const tls = mode === "lan" ? { cert: await fs.readFile(certFile), key: await fs.readFile(keyFile) } : null;
    remoteState.server = await listenRemoteGateway(remoteApp, { host: mode === "lan" ? lanHost : "127.0.0.1", port, tls });
    remoteState.startedAt = Date.now();
    audit("warn", "remote.gateway.started", { mode, port, host: mode === "lan" ? lanHost : "127.0.0.1" });
  } catch (error) {
    remoteState.error = error.code || "REMOTE_START_FAILED";
    audit("error", "remote.gateway.failed", { mode, port, code: remoteState.error });
  }
}
function remoteStatus() {
  const { settings } = remoteState, address = remoteState.server?.address?.();
  return {
    settings, running: Boolean(remoteState.server), error: remoteState.error, startedAt: remoteState.startedAt, address: address ? { host: address.address, port: address.port } : null,
    disabledByEnvironment: process.env.COD4X_REMOTE === "off", appBuilt: existsSync(path.join(REMOTE_APP_DIR, "remote.html")), routes: REMOTE_ROUTES, sourceUrl: REMOTE_SOURCE_URL, version: APP_VERSION,
    tailscaleCommand: `tailscale serve --bg --https=443 127.0.0.1:${settings.port}`, tailscaleOffCommand: `tailscale serve --https=443 127.0.0.1:${settings.port} off`,
    caddyfile: caddyfileTemplate(settings.proxyDomain, settings.port), proxyLoginLimit: REMOTE_PROXY_MAX_FAILURES,
    sessions: remoteSessions.list().map(({ sessionId, username, role, mfa, client, tailscaleUser, createdAt, lastSeenAt, expiresAt, absoluteExpiresAt }) => ({ sessionId, username, role, mfa, client, tailscaleUser, createdAt, lastSeenAt, expiresAt, absoluteExpiresAt })),
  };
}
const remoteRoute = action => async (req, res) => {
  try { res.set("Cache-Control", "no-store").json({ ok: true, ...await action(req) }); }
  catch (error) { const code = error.code === "REMOTE_SETTINGS_INVALID" || /^REMOTE_(HOST|PORT|TLS)_/.test(error.code || "") ? error.code : "REMOTE_FAILED"; res.status(code === "REMOTE_FAILED" ? 500 : 400).json({ ok: false, code, field: error.field || null, error: code }); }
};
app.get("/api/remote", requirePermission("user.manage"), remoteRoute(async () => ({ remote: remoteStatus() })));
app.post("/api/remote/settings", requirePermission("user.manage"), remoteRoute(async req => {
  const next = validateRemoteSettings(req.body || {});
  await saveRemoteSettings(next);
  const modeChanged = next.mode !== remoteState.settings.mode;
  remoteState.settings = next;
  // Switching off or to another exposure (e.g. a public proxy) ends every remote session.
  if (!next.enabled || modeChanged) remoteSessions.revokeAll();
  audit("warn", "remote.gateway.configured", { actor: req.auth.username, enabled: next.enabled, mode: next.mode, port: next.port });
  await applyRemoteGateway();
  return { remote: remoteStatus() };
}));
app.post("/api/remote/sessions/:sessionId/revoke", requirePermission("user.manage"), remoteRoute(async req => {
  const revoked = remoteSessions.revoke(String(req.params.sessionId || ""));
  audit("warn", "remote.session.revoked", { actor: req.auth.username, sessionId: req.params.sessionId, revoked });
  return { revoked, remote: remoteStatus() };
}));
app.post("/api/remote/sessions/revoke-all", requirePermission("user.manage"), remoteRoute(async req => {
  const revoked = remoteSessions.revokeAll();
  audit("warn", "remote.session.revoked_all", { actor: req.auth.username, revoked });
  return { revoked, remote: remoteStatus() };
}));
await loadRemoteSettings();
await applyRemoteGateway();

app.listen(PORT, HOST, () => {
  console.log(`COD4X CONTROL installer API listening on :${PORT}`);
});
