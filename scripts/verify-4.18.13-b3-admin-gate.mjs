import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runDatabaseHelper } from "../lib/b3-database-helper.mjs";
import { InstanceB3AdminService } from "../lib/instance-b3-admin-service.mjs";
import { ADMIN_QUERIES } from "../lib/b3-admin.mjs";

// Block 15 gate: player/admin/ban data shown and managed through B3's own
// database. Query whitelist, parameter binding and masking are exercised
// directly; route/permission wiring is checked in source.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const server = read("installer-server.mjs");
const helperSource = read("lib/b3-database-helper.mjs");

const SECRET = "Gate-Secret-Pass!1";
const spawned = [];
const fakeSpawn = (file, args, options) => {
  const child = new EventEmitter();
  let input = "";
  child.stdout = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) { done(); setImmediate(() => { child.stdout.end('{"ok":true,"total":0,"rows":[]}'); setImmediate(() => child.emit("close", 0)); }); } });
  spawned.push({ args, input: () => input });
  return child;
};
const pythonPath = process.platform === "win32" ? "C:\\Python27\\python.exe" : "/usr/bin/python2.7";
const injection = "x'; DROP TABLE clients; --";
await runDatabaseHelper({ pythonPath, op: "query", name: "players", params: { search: injection, limit: 50, offset: 0 }, connection: { host: "127.0.0.1", port: 3306, database: "b3", username: "b3" }, password: Buffer.from(SECRET) }, { spawnImpl: fakeSpawn });
const request = JSON.parse(spawned[0].input());
const rejected = await runDatabaseHelper({ pythonPath, op: "query", name: "players; DROP", params: {}, connection: { host: "127.0.0.1", port: 3306, database: "b3", username: "b3" }, password: Buffer.from(SECRET) }, { spawnImpl: fakeSpawn }).then(() => false, error => error.code === "DB_HELPER_FAILED");

// Masking: a viewer never receives a full IP or GUID.
const IP = "203.0.113.77", GUID = "ABCDEF0123456789FACE", OLD_IP = "198.51.100.23";
const client = [7, "Tester", GUID, IP, 16, 1, 1, 2];
const answers = { groups: { rows: [[16, "Admin", "admin", 40]] }, players: { total: 1, rows: [client] }, admins: { rows: [client] }, player: { client, aliases: [], ips: [[OLD_IP, 1, 1, 2]] }, penalties: { total: 1, rows: [[1, "Ban", 7, "Tester", GUID, 0, 0, 0, "r", 1, -1]] } };
const service = new InstanceB3AdminService({ store: { get: () => ({}) }, database: { read: async () => ({ ready: true }), query: async (id, name) => structuredClone(answers[name]), withStartGuard: async (id, fn) => fn() }, environment: { read: async () => ({}) }, b3IsRunning: async () => false });
const masked = JSON.stringify([await service.players("x", {}), await service.admins("x"), await service.player("x", 7), await service.penalties("x", {})]);
const full = JSON.stringify(await service.players("x", {}, { full: true }));

const route = (method, pathText, permission) => server.includes(`app.${method}("/api/instances/:id/b3/admin/${pathText}", requirePermission("${permission}")`);
const checks = [
  ["query sends only a catalog name and bound params, never SQL", request.op === "query" && request.name === "players" && request.params.search === injection && !/SELECT|UPDATE|INSERT|DELETE/i.test(JSON.stringify(request)) && rejected],
  ["the helper's query table matches the catalog", ADMIN_QUERIES.every(name => new RegExp(`'${name}': q_`).test(helperSource))],
  ["viewers never receive a full IP or GUID", ![IP, GUID, OLD_IP].some(secret => masked.includes(secret)) && full.includes(IP) && full.includes(GUID)],
  ["reads need diagnostics.read, full values config.manage", ["players", "players/:clientId", "admins", "penalties", "groups", "commands"].every(p => route("get", p, "diagnostics.read")) && server.includes('const adminView = req => ({ full: hasPermission(req.auth.role, "config.manage") });')],
  ["actions need server.manage", ["players/:clientId/ban", "players/:clientId/unban", "players/:clientId/group", "penalties/:penaltyId/lift"].every(p => route("post", p, "server.manage"))],
  ["set group refuses while B3 runs inside the start guard", read("lib/instance-b3-admin-service.mjs").includes("if (await this.b3IsRunning(id)) fail('B3_RUNNING');")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.13 B3 admin gate PASS (player/admin/ban data via B3's database)");

