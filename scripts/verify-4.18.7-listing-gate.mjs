import { createRconFixture } from "../test/support/rcon-instance-fixture.mjs";
import { parseMasterList, MASTER_LIST_URL } from "../lib/master-list.mjs";

// Block 9 gate: Registration + Listing Verification, including the declared
// failure cases. Real store, runtime manager, vault, master service and local
// getinfo against the UDP test double; the master list is synthetic data in the
// format of the official serverstatus.json. No real master server is contacted.
// NOT a native gate: listing of a real cod4x18_dedrun remains open.
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
const token = "ListingGateToken0123456789abcdef";
let servers = [];
const entry = (hn, addr) => ({ hn, map: "mp_backlot", game: "", clc: 0, maxcl: 18, human: 0, pw: false, cc: "DE", build: 1, type: "war", tokhash: "", addr });
const fixture = await createRconFixture({ masterOptions: { fetchList: async () => {
  if (servers instanceof Error) throw Object.assign(new Error("MASTER_LIST_UNREACHABLE"), { code: "MASTER_LIST_UNREACHABLE" });
  return parseMasterList(JSON.stringify({ time: "gate", servercount: servers.length, servers }));
} } });
try {
  const { manager, masterService, auditEvents } = fixture;
  const instance = await fixture.create("listing-gate");
  check("Default network binding is LOOPBACK", instance.network.scope === "LOOPBACK");
  await fixture.setMaster("listing-gate", token);

  await manager.launch("listing-gate");
  const loop = await masterService.verify("listing-gate", "gate");
  check("Token set but loopback: not claimed as listed", loop.state === "TOKEN_CONFIGURED" && loop.list.code === "LOOPBACK_BINDING" && loop.verified === false);
  await manager.stop("listing-gate");
  const offline = await masterService.verify("listing-gate", "gate");
  check("Server offline: no listing claim", offline.list === null && offline.verified === false);

  let refused = false;
  try { await manager.changeNetwork("listing-gate", { scope: "PUBLIC" }); } catch (error) { refused = error.code === "INSTANCE_NETWORK_CONFIRMATION_REQUIRED"; }
  check("Public exposure requires explicit confirmation", refused);
  await manager.changeNetwork("listing-gate", { scope: "PUBLIC", confirm: "PUBLIC_EXPOSURE" });
  await manager.launch("listing-gate");

  servers = new Error("down");
  const unreachable = await masterService.verify("listing-gate", "gate");
  check("Master unreachable: diagnosed, server keeps running", unreachable.list.code === "MASTER_LIST_UNREACHABLE" && (await manager.status("listing-gate")).runtime.status === "RUNNING");
  servers = [entry("Somebody Else", `[::ffff:198.51.100.9]:${instance.port}$alive`)];
  const notListed = await masterService.verify("listing-gate", "gate");
  check("Token valid, server not visible (NAT/firewall/pending)", notListed.list.code === "MASTER_LIST_NOT_LISTED" && notListed.summary.listed === false);
  servers = [entry("RCON listing-gate", `[::ffff:203.0.113.7]:${instance.port + 7}$alive`)];
  check("Wrong port diagnosed", (await masterService.verify("listing-gate", "gate")).list.code === "MASTER_LIST_PORT_MISMATCH");
  servers = [entry("^1RCON listing-gate", `[::ffff:203.0.113.7]:${instance.port}$alive`)];
  const listed = await masterService.verify("listing-gate", "gate");
  check("Registration + Listing verified: Registration ✓ Heartbeat ✓ Listed ✓ Last seen", listed.state === "HEARTBEAT_OK" && listed.summary.registration === true && listed.summary.heartbeat === true && listed.summary.listed === true && Boolean(listed.summary.lastSeenAt) && listed.verified === true);
  servers = [entry("RCON listing-gate", `[::ffff:203.0.113.7]:${instance.port}$dead`)];
  const lost = await masterService.verify("listing-gate", "gate");
  check("Heartbeat missing (dead entry) diagnosed with last seen kept", lost.state === "HEARTBEAT_LOST" && lost.summary.lastSeenAt === listed.summary.lastSeenAt);
  check("Audit: master.list.verified, master.heartbeat.detected, master.heartbeat.lost", ["master.list.verified", "master.heartbeat.detected", "master.heartbeat.lost"].every(event => auditEvents.some(value => value.event === event)));
  check("Token never appears in results or audit", ![loop, unreachable, listed, lost, auditEvents].some(value => JSON.stringify(value).includes(token)));
  check("Master list source is the fixed official URL", MASTER_LIST_URL === "https://cod4master.cod4x.ovh/serverstatus.json");
} finally {
  await fixture.cleanup();
}

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.7 Registration + Listing Verification gate PASS (synthetic master list; real listing of a native core remains open)");
