import fs from "node:fs";
import { buildKickPacket, normalizeRconCommand } from "../lib/rcon-protocol.mjs";
import { InstanceRconService } from "../lib/instance-rcon-service.mjs";

// Block 15b gate: live kick of a connected player via RCON, slot verified,
// nothing else unblocked. Behaviour is exercised directly; route permissions
// are checked in source. Native counterpart: verify-4.18.14-kick-native.mjs.
const server = fs.readFileSync(new URL("../installer-server.mjs", import.meta.url), "utf8");
const password = Buffer.from("Gate-Rcon-123");
const blocked = input => { try { normalizeRconCommand(input); return false; } catch (error) { return error.code === "RCON_COMMAND_BLOCKED"; } };
const rejected = (slot, reason) => { try { buildKickPacket(password, slot, reason); return false; } catch (error) { return error.code === "RCON_KICK_INVALID"; } };

const statusText = slots => "map     : mp_crash\n\nnum score ping playerid steamid name lastmsg address qport rate\n--- -----\n"
  + slots.map(([slot, id, name]) => `${String(slot).padStart(3)}     0   48 ${id.padEnd(19)} 0                 ${name}^7                     0 203.0.113.7:28960                         1234 25000\n`).join("");
async function run(statuses, target) {
  const sent = [];
  const client = { async execute(pw, command) { sent.push(command); return { text: statuses.shift() ?? statusText([]), latencyMs: 1, packets: 1 }; },
    async kick(pw, slot, reason) { sent.push(buildKickPacket(pw, slot, reason).subarray(4).toString("latin1").replace("Gate-Rcon-123", "<pw>")); return { text: "", latencyMs: 1 }; } };
  const audits = [];
  const rcon = new InstanceRconService({ resolveInstance: id => ({ id, port: 28960 }), runtimeFor: async () => ({ reconcileRuntimeState: async () => {}, state: { status: "RUNNING", pid: 1, runId: "r" } }),
    credentialService: { withRuntimeCredentials: async (id, fn) => fn({ rcon: password }, new AbortController().signal) }, audit: (level, event, details) => audits.push({ event, ...details }), clientFactory: () => client, sleep: async () => {} });
  const outcome = await rcon.kick("gate", target, "gate").then(() => "kicked", error => error.code);
  return { outcome, sent, audits };
}
const happy = await run([statusText([[3, "1234567890", "Wolf"]]), statusText([])], { slot: 3, playerid: "1234567890", reason: "Cheating" });
const changed = await run([statusText([[3, "9999999999", "Other"]])], { slot: 3, playerid: "1234567890" });

const checks = [
  ["only `clientkick <slot> [reason]` goes on the wire, after a status check", happy.outcome === "kicked" && JSON.stringify(happy.sent) === JSON.stringify(["status", "rcon <pw> clientkick 3 Cheating", "status"])],
  ["a reassigned slot is never kicked", changed.outcome === "RCON_KICK_TARGET_CHANGED" && !changed.sent.some(command => /clientkick/.test(command))],
  ["kick audit carries the slot only", happy.audits.every(entry => !/Wolf|1234567890|Cheating|203\.0\.113/.test(JSON.stringify(entry))) && happy.audits.some(entry => entry.event === "rcon.kick" && entry.slot === 3 && entry.ok === true)],
  ["slots outside 0-63, names, `all` and forbidden reason characters are refused", rejected(64, "") && rejected("all", "") && rejected("7", "") && rejected(1, 'a"b') && rejected(1, "a;b") && rejected(1, "50%") && rejected(1, "x".repeat(127))],
  ["the RCON console still blocks every kick form", ["clientkick 0", "kick all", "kick 1", "onlykick 1", "tempban 1 5m x", "banclient 1"].every(blocked)],
  ["online list needs diagnostics.read, kick needs server.manage", server.includes('app.get("/api/instances/:id/rcon/online", requirePermission("diagnostics.read")') && server.includes('app.post("/api/instances/:id/rcon/kick", requirePermission("server.manage")')
    && server.includes('app.post("/api/instances/:id/b3/admin/players/:clientId/kick", requirePermission("server.manage")')],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.14 live kick gate PASS (slot verified, nothing else unblocked)");
