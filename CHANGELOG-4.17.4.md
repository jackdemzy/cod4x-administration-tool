# COD4X CONTROL 4.17.4

## Runtime Spawn Error Guard

4.17.4 addresses the runtime-start failure observed in 4.17.3 where a Windows process-spawn error could leave the backend process unhandled and the frontend reported only `Failed to fetch`.

### Changes

- Added a guarded native `iw3mp.exe` spawn path that waits for the Node `spawn` event before reporting a successful start.
- Added an explicit `error` handler for the child process so Windows spawn failures cannot terminate the installer backend through an unhandled event.
- Added structured runtime spawn diagnostics including error code, syscall, executable path, and working directory.
- Added persistent `FAILED` runtime state and `runtime.spawn.failed` / `runtime.error` history events.
- Preserved the existing Verified-Core gate, SHA-256 fingerprint validation, Steam-aware discovery, separated server directory, PID verification, and `shell:false`.
- Added display of `runtime.lastError` in the Runtime UI.
- Extended the 4.17.4 preflight with explicit spawn-error-guard checks.

### Important

This build does not weaken the Verified-Core security boundary and does not silently fall back to shell execution. If Windows refuses to create `iw3mp.exe`, the UI should now receive a concrete error instead of losing the backend connection.
