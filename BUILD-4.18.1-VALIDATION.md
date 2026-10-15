# COD4X CONTROL 4.18.1 — Validation Report

## Scope

Runtime Verified-Core path fix, adoption/start verification consistency, runtime CoD4x persistence, discovered-core platform binding, UI version consistency, and source-build checks.

## Checks completed

- `node --check installer-server.mjs` — PASS
- `node --check electron-main.cjs` — PASS
- `node --check electron-preload.cjs` — PASS
- `node scripts/preflight-4.18.1.mjs` — PASS
- `node scripts/verify-4.18.1-version.mjs` — PASS
- `node scripts/verify-4.18.1-static.mjs` — PASS
- `node scripts/verify-4.18.1-runtime.mjs` — PASS

## Verified fixes

1. Runtime verification receives an executable path and normalizes the verification target to its parent directory.
2. Preflight, adoption, and Windows runtime start use the same platform-aware verifier.
3. The UI can expose `Dedicated-Core übernehmen & verifizieren` when the executable exists but has no valid manifest/fingerprint yet.
4. Runtime configuration persists the selected CoD4x version.
5. Discovered Windows/Linux candidates carry and apply their platform.
6. Candidate results display the discovered platform.
7. Visible application version labels are 4.18.1.
8. `build.ps1` is UTF-8 with BOM so Windows PowerShell 5 can decode German status text correctly.

## Installer build note

The source package was validated here. A native Windows Electron/NSIS installer build was not executed in this Linux validation environment. Run `build.cmd` on Windows to produce `dist-installer/COD4X-CONTROL-Setup-4.18.1-x64.exe`.
