import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { RconClient } from "../lib/rcon-client.mjs";

// Native Block 17 check on Linux: three real CoD4x cores in parallel on three
// loopback ports, each with its own home, hostname and RCON password. The
// arguments mirror ServerInstanceManager.launch (dedicated 2, fs_basepath,
// fs_homepath, net_port, net_ip, rcon_password, logfile 2). It checks what a
// fake core cannot: that the real processes answer on their own port only, that
// one password is rejected by the siblings, that /proc shows only each own
// home and port, and that stopping one leaves the others serving.
// Usage (non-root): COD4X_CORE=... COD4X_BASEGAME=... node scripts/verify-4.18.22-multi-server-native.mjs
if (process.platform !== "linux") { console.log("SKIP native multi-server check runs on Linux only"); process.exit(0); }
const core = process.env.COD4X_CORE || path.join(os.homedir(), "core-21.2", "cod4x18_dedrun");
const baseGame = process.env.COD4X_BASEGAME || "/mnt/c/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare";
try { for (const file of [core, path.join(baseGame, "main")]) await fs.access(file); }
catch { console.log("SKIP native multi-server check: core or base game not found"); process.exit(0); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, Boolean(ok), detail]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) { for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(500)) if (await predicate()) return true; return false; }

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-multi-server-"));
const first = 28960 + Math.floor(Math.random() * 30) * 3;
const instances = [1, 2, 3].map(number => ({
  id: `multi-${number}`, hostname: `MultiGate${number}`, port: first + number - 1,
  home: path.join(root, `multi-${number}`), password: `Native${number}${crypto.randomBytes(6).toString("hex")}`, child: null,
}));
const clientFor = instance => new RconClient({ port: instance.port, timeoutMs: 1500 });
const pw = instance => Buffer.from(instance.password);
const info = async (instance, password = instance) => JSON.stringify(await clientFor(instance).execute(pw(password), "serverinfo"));

async function start(instance) {
  await fs.mkdir(path.join(instance.home, "main", "logs"), { recursive: true });
  await fs.writeFile(path.join(instance.home, "main", "server.cfg"), `set sv_hostname "${instance.hostname}"\nset net_port "${instance.port}"\nset g_log "logs/games_mp.log"\n`);
  instance.child = spawn(core, ["+set", "dedicated", "2", "+set", "fs_basepath", baseGame, "+set", "fs_homepath", instance.home,
    "+set", "net_port", String(instance.port), "+set", "net_ip", "127.0.0.1", "+set", "rcon_password", instance.password,
    "+exec", "server.cfg", "+set", "logfile", "2", "+map", "mp_backlot"], { cwd: path.dirname(core), stdio: "ignore", detached: true });
  return until(async () => { try { await clientFor(instance).probe(); return true; } catch { return false; } }, 90000);
}
const stop = async instance => { if (instance.child && instance.child.exitCode === null) { try { process.kill(-instance.child.pid, "SIGKILL"); } catch { /* gone */ } await delay(1000); } };

try {
  const up = await Promise.all(instances.map(start));
  check("all three cores answer on their own port", up.every(Boolean), up.join(","));
  if (!up.every(Boolean)) throw Object.assign(new Error("not all cores came up"), { code: "NOT_UP" });

  for (const instance of instances) {
    const own = await info(instance);
    check(`${instance.id}: own password works and the server reports its own hostname`, own.includes(instance.hostname), instance.hostname);
    const foreign = instances.filter(other => other !== instance);
    check(`${instance.id}: no sibling hostname in the answer`, foreign.every(other => !own.includes(other.hostname)));
    for (const other of foreign) {
      const rejected = await info(instance, other).then(() => false, () => true);
      check(`${instance.id}: the password of ${other.id} is rejected`, rejected);
    }
    const cmdline = (await fs.readFile(`/proc/${instance.child.pid}/cmdline`, "utf8")).split("\0");
    check(`${instance.id}: process shows only its own home and port`, cmdline.includes(instance.home) && cmdline.includes(String(instance.port)) && foreign.every(other => !cmdline.includes(other.home) && !cmdline.includes(String(other.port))));
  }
  check("three different processes", new Set(instances.map(instance => instance.child.pid)).size === 3);

  await stop(instances[1]);
  const [one, two, three] = await Promise.all(instances.map(instance => info(instance).then(() => true, () => false)));
  check("stopping multi-2 leaves multi-1 and multi-3 serving", one && !two && three, `${one}/${two}/${three}`);

  check("multi-2 restarts on the same port while the siblings keep running", await start(instances[1]) && (await info(instances[1])).includes(instances[1].hostname) && await info(instances[0]).then(value => value.includes(instances[0].hostname), () => false));
} catch (error) {
  check("native multi-server run completed", false, error.message);
} finally {
  for (const instance of instances) await stop(instance);
  await fs.rm(root, { recursive: true, force: true });
}
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log("4.18.22 native multi-server check PASS");
