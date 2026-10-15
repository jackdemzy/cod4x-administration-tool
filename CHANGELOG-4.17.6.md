# COD4X CONTROL 4.17.6

## Runtime working-directory validation / spawn diagnostics

Based on 4.17.5.

### Changes
- Validate the runtime working directory before native `iw3mp.exe` launch.
- Create the configured server working directory when it does not exist.
- Reject a working-directory path that exists but is not a directory.
- Return explicit runtime error codes for working-directory creation/validation failures.
- Include executable path and working directory in spawn diagnostics.
- Preserve `shell: false`, Verified-Core enforcement, Steam-aware discovery, remembered-login protection, and PID/taskkill guards.
- Persist the resolved runtime working directory in runtime state.

### Validation
- Node syntax checks
- Runtime preflight checks
- ZIP structure/integrity checks

The actual Windows Electron/NSIS build must still be executed on Windows.
