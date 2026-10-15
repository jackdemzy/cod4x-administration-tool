# COD4X CONTROL 4.17.7

## CoD4X filesystem path separation

- Keep the installed `iw3mp.exe` directory as the native Windows process working directory.
- Set `fs_basepath` explicitly to the directory containing the selected `iw3mp.exe`.
- Set `fs_homepath` explicitly to the configured per-server directory.
- Preserve the separated server data model even when CoD4X changes/uses its own native working directory during startup.
- Record `filesystemBasePath`, `filesystemHomePath`, and the actual OS working directory in runtime state and audit events.
- Block user-supplied `fs_basepath` / `fs_homepath` overrides so the CONTROL-managed paths cannot be silently replaced.
- Keep `shell: false`, Verified-Core SHA-256 validation, PID verification, spawn diagnostics, Steam discovery, and remembered login behavior unchanged.

## Verification basis

CoD4X upstream documents `fs_basepath` + `fs_homepath` as the supported layout for multiple Windows servers, with the base-game directory as `fs_basepath` and a dedicated server directory as `fs_homepath`.
