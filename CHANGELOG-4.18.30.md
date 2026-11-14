# Changelog 4.18.30 – Release / Installer (Roadmap Block 23)

Release candidate. A release is built through one pipeline in the order of the roadmap
(Preflight → full test suite → Vite → electron-builder → SHA-256 → artifact verification → installer test).
Design: `docs/superpowers/specs/2026-11-13-release-installer-design.md`, plan:
`docs/superpowers/plans/2026-11-13-release-installer.md`, how-to: `docs/RELEASE.md`.

## New

- **Build targets:** Windows NSIS installer (as before), Windows portable exe
  (`COD4X-CONTROL-Portable-<v>-x64.exe`) and Linux AppImage (`COD4X-CONTROL-<v>-x86_64.AppImage`,
  executable `cod4x-control`). `npm run dist:win` / `dist:linux`.
- **Pipeline** `scripts/release.mjs --platform win|linux` (`npm run release:win|linux`): stops at the
  first failing step and names it; `--dry-run` shows the steps. No shell, `--publish never`.
- **Artifact verification** `scripts/release-verify.mjs`: expected files with the version in the name,
  minimum size, `app.asar` content policy (required app files and production dependencies; no `.env*`,
  user/auth files, data/vault/backup folders, tests, docs, scripts, keys, Electron or build tools) and the
  packaged `package.json` version; writes `SHA256SUMS` (`sha256sum -c` compatible) and
  `release-manifest.json`. `--check <folder>` recomputes the sums of a downloaded release.
- **Installer gate** `scripts/verify-4.18.30-installer-gate.mjs`: Linux unpacks the AppImage and runs its
  packaged backend (Electron with `ELECTRON_RUN_AS_NODE=1` and `app.asar/installer-server.mjs`, as the
  desktop app does): first run, core discovery with the E2E test core, server start and stop. Windows:
  silent NSIS install (`/S /D=`), first run of the installed backend, silent uninstall. Without
  `COD4X_RELEASE_DIR` it says SKIP; with it a skipped test fails the gate.
- **Workflow `Release`** (`.github/workflows/release.yml`): manual, on tags `v*` and on pull requests that
  touch packaging. Windows and Linux build through the pipeline, run the installer gate and upload the
  artifacts. A tag must match the package version and creates a draft GitHub release (write rights only
  in that job); publishing stays manual.
- `build.ps1` builds setup and portable and runs the artifact verification.
- `test/support/e2e-backend.mjs` can start another backend build (`server: { command, args, env }`).

## Not done

- No code signing (no certificate); SmartScreen warns. No auto-update, no `.deb`/`.rpm`.
- Windows core discovery and server start with a real core, the window, shortcuts, SmartScreen and the
  portable start are manual: `docs/WSL-NATIVE-CHECKLIST.md` section 3g.
- Issues #21 (minimatch via electron-builder, build tooling only) and #40 (A1-5) stay open.

## Release review (before the tag)

An independent cross-block review before tagging v4.18.30 (one reviewer). Fixed, with
`test/security-backup-restore.test.mjs`:

- **R-1 (High):** the production backup (4.16.x) holds `users.json`, and `POST /api/backups/:id/restore`
  needs only `config.manage`. An operator could roll user accounts back (roles, password hashes,
  second factors, disabled flags), which only `user.manage` may change. A restore whose user accounts
  differ from the current ones now needs `user.manage` (`403 BACKUP_RESTORE_USERS_FORBIDDEN`), and a
  user set without an enabled administrator is refused (`409 BACKUP_RESTORE_NO_ADMIN`).
- **R-2 (Medium):** a restore wrote the files but kept the old policy, profiles and accounts in memory
  (in effect only after a restart, and the next account change wrote the old state back). The restored
  files are loaded at once; every local and remote session of an account that changed or is gone ends.
- **R-3 (Medium):** the restore wrote `users.json` (password hashes, TOTP secrets) with the default mode
  (0644 under umask 022). The three restored files are written 0600.
- **R-4 (Low):** the 4.11.7 browser test client `/session-test` (unauthenticated page, inline script,
  bearer token in localStorage) was still served by the release backend; removed.
- **R-5 (Low):** `actions/checkout` kept the GitHub token in `.git/config`; both workflows set
  `persist-credentials: false`.

Checked without a finding: origin policy and desktop header, RBAC bindings of all routes, remote
gateway (route list, CSRF, brakes, step-up), Block 21 restore points (`server.code` for code), remote
Linux routes, Electron (navigation, IPC sender, permissions, safeStorage), version strings in
package, lock file, BUILD_INFO, UI, README, DEVELOPMENT_STATUS and docs/RELEASE.md.
