// Security audit 4.18.26 (A1-5): close the race between the identity check and the signal.
//
// Node.js has no pidfd API, so a short python3 helper (Python 3.9+, Linux 5.3+) holds a pidfd
// while CONTROL checks the process identity:
//   1. the helper opens a pidfd for the PID and answers "ready" (or "gone"/"unsupported"),
//   2. CONTROL inspects /proc/<pid> and verifies the identity,
//   3. CONTROL sends TERM or KILL; the helper signals through the pidfd.
// The pidfd always names the process that had the PID in step 1. If that process ended and the
// PID was reused before step 2, the check in step 2 sees the new process and refuses. If it ends
// after step 2, pidfd_send_signal fails with ESRCH ("gone") and no other process is hit.
import { spawn as nodeSpawn } from "node:child_process";

const HELPER = [
  "import os, sys, signal, errno",
  "def say(text):",
  "    sys.stdout.write(text + '\\n'); sys.stdout.flush()",
  "if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):",
  "    say('unsupported'); sys.exit(3)",
  "try:",
  "    fd = os.pidfd_open(int(sys.argv[1]))",
  "except ProcessLookupError:",
  "    say('gone'); sys.exit(0)",
  "except OSError as error:",
  "    say('unsupported' if error.errno in (errno.ENOSYS, errno.EPERM, errno.EINVAL) else 'error'); sys.exit(3)",
  "say('ready')",
  "line = sys.stdin.readline().strip()",
  "if line not in ('TERM', 'KILL'):",
  "    sys.exit(4)",
  "try:",
  "    signal.pidfd_send_signal(fd, signal.SIGTERM if line == 'TERM' else signal.SIGKILL)",
  "except ProcessLookupError:",
  "    say('gone'); sys.exit(0)",
  "except OSError:",
  "    say('error'); sys.exit(5)",
  "say('sent')",
].join("\n");

// -> { state: "ready", send(signalName) -> Promise<boolean>, close() }
//  | { state: "gone" } | { state: "unsupported", reason }
export async function openPidfdSignaler(pid, { spawn = nodeSpawn, python = "python3", timeoutMs = 5_000 } = {}) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error("Invalid PID for pidfd.");
  let child;
  try { child = spawn(python, ["-I", "-S", "-c", HELPER, String(pid)], { stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true }); }
  catch (error) { return { state: "unsupported", reason: error.code || error.message }; }
  const lines = [];
  const waiters = [];
  let buffered = "";
  let ended = false;
  const wake = () => { while (waiters.length && (lines.length || ended)) waiters.shift()(); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) { lines.push(buffered.slice(0, index).trim()); buffered = buffered.slice(index + 1); }
    wake();
  });
  const finish = () => { ended = true; wake(); };
  child.on("error", finish);
  child.on("close", finish);
  child.stdin.on("error", () => {});
  const nextLine = () => new Promise(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
    const take = () => { clearTimeout(timer); resolve(lines.length ? lines.shift() : "ended"); };
    if (lines.length || ended) take(); else waiters.push(take);
  });
  const first = await nextLine();
  if (first === "gone") return { state: "gone" };
  if (first !== "ready") { child.kill("SIGKILL"); return { state: "unsupported", reason: first }; }
  let used = false;
  return {
    state: "ready",
    async send(signalName) {
      if (used) throw new Error("pidfd signaler was already used.");
      used = true;
      if (!["SIGTERM", "SIGKILL"].includes(signalName)) { child.kill("SIGKILL"); throw new Error("Unsupported runtime signal."); }
      child.stdin.end(signalName === "SIGKILL" ? "KILL\n" : "TERM\n");
      const answer = await nextLine();
      if (answer === "sent") return true;
      if (answer === "gone") return false;
      throw Object.assign(new Error(`pidfd signal failed (${answer}).`), { code: "RUNTIME_PIDFD_SIGNAL_FAILED" });
    },
    close() { if (!used) { used = true; child.stdin.end(); child.kill("SIGKILL"); } },
  };
}
