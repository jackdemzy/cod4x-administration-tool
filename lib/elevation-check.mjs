// Security audit 4.18.26 (A1-3): CONTROL needs neither root nor Windows administrator rights.
// -> { elevated: boolean, kind: "root" | "windows-admin" | null }
// Windows: `net session` lists SMB sessions and succeeds only in an elevated process; without
// administrator rights it fails with "Access is denied" (exit code 2). Any failure, timeout or a
// missing net.exe counts as not elevated, so this check never blocks the start.
export async function detectElevation({ platform = process.platform, getuid = process.getuid, execFileAsync } = {}) {
  if (platform !== "win32") {
    return typeof getuid === "function" && getuid() === 0 ? { elevated: true, kind: "root" } : { elevated: false, kind: null };
  }
  if (typeof execFileAsync !== "function") return { elevated: false, kind: null };
  try {
    await execFileAsync("net.exe", ["session"], { windowsHide: true, timeout: 5_000 });
    return { elevated: true, kind: "windows-admin" };
  } catch {
    return { elevated: false, kind: null };
  }
}
