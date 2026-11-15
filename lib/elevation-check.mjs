// Security audit 4.18.26 (A1-3): CONTROL needs neither root nor Windows administrator rights.
// -> { elevated: boolean, kind: "root" | "windows-admin" | null }
// Windows: the check reads the integrity level of the process token with `whoami /groups`.
// An elevated process carries the mandatory label "High" (S-1-16-12288), a service running as
// SYSTEM "System" (S-1-16-16384); a normal process has "Medium". The SIDs do not depend on the
// display language and, unlike `net session`, no Windows service has to run. Any failure, timeout
// or a missing whoami.exe counts as not elevated, so this check never blocks the start.
const ELEVATED_LABELS = /\bS-1-16-(?:12288|16384)\b/;

export async function detectElevation({ platform = process.platform, getuid = process.getuid, execFileAsync } = {}) {
  if (platform !== "win32") {
    return typeof getuid === "function" && getuid() === 0 ? { elevated: true, kind: "root" } : { elevated: false, kind: null };
  }
  if (typeof execFileAsync !== "function") return { elevated: false, kind: null };
  try {
    const { stdout } = await execFileAsync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5_000 });
    return ELEVATED_LABELS.test(String(stdout || "")) ? { elevated: true, kind: "windows-admin" } : { elevated: false, kind: null };
  } catch {
    return { elevated: false, kind: null };
  }
}
