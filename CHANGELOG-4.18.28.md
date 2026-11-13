# Changelog 4.18.28 – End-to-end test (Roadmap Block 22)

The roadmap flow now runs end to end against the real backend process, driven only through its public HTTP API. Design and plan: `docs/superpowers/specs/2026-11-12-e2e-design.md`, `docs/superpowers/plans/2026-11-12-e2e.md`.

## What runs

- **Flow** (`test/e2e-flow.test.mjs`): Install (adopt the core) → Detect Core (verified core, valid base game) → Create Server → Config (`server.cfg`, RCON password in the vault) → Start → Map (`rcon map mp_crash`) → RCON (`status`) → Master List (named state without a token) → B3 (start refused with `B3_DEPENDENCIES_BLOCKED` without Python, the game server keeps running) → Client Join (the player shows under `/rcon/online`) → Stop → Restart (same port, new process) → backend restart (instance, config and RCON credential survive, start and RCON work).
- **Multi-server** (`test/e2e-multi-server.test.mjs`): three instances on three consecutive ports, each answering only with its own identity and its own RCON password; stopping the second leaves the first and third serving; the second comes back on its port.
- **Intentional failures** (`test/e2e-failures.test.mjs`), each with a named 4xx code, CONTROL answering and a reference server untouched afterwards:

| Case | Result |
|---|---|
| wrong core (not adopted, or not an executable) | start refused `VERIFIED_CORE_BLOCKED` |
| missing main file (at create, or deleted later) | `BASEGAME_INVALID` |
| missing zone folder (at create, or deleted later) | `BASEGAME_INVALID` |
| wrong port (out of range, duplicate, taken at create, taken at start) | `INSTANCE_PORT_INVALID`, `INSTANCE_PORT_CONFLICT`, `INSTANCE_PORT_UNAVAILABLE` |
| wrong RCON (too short, `+`, stale vault state, server stopped, wrong password on the wire) | `CREDENTIAL_INVALID`, `VAULT_CONFLICT`, `RCON_SERVER_NOT_RUNNING`, `RCON_AUTH_FAILED` |
| missing master token | verify reports `NOT_CONFIGURED` / `MASTER_TOKEN_NOT_CONFIGURED` |
| wrong B3 database | saved as not ready; the test reports a `B3_*` code |
| B3 down | health `DOWN`; stop is harmless |
| server crash (`SIGKILL`) | detected as `FAILED`; start works again with a new process |
| missing plugin (not approved, file deleted later) | `PLUGIN_NOT_APPROVED`; listing `MISSING`, start refused `PLUGIN_MISSING` |

## Test core

`test/support/e2e-core.mjs` compiles a native stand-in for `cod4x18_dedrun` (gcc), so the runtime's real process identity checks apply. It reads `+exec` files like the real core and starts `test/support/e2e-core-udp.mjs`, which answers `getinfo`, `getstatus` and RCON on `net_port` with the password it read; it dies with the core. `test/support/fake-cod4x-udp.mjs` gained an opt-in `joinable` mode for the client-join step; existing callers are unchanged.

## Gate and native run

- `scripts/verify-4.18.28-e2e-gate.mjs` (part of `scripts/preflight-4.18.28.mjs`) runs the E2E tests and checks every flow step and every failure case by name. On Linux with gcc a skipped E2E test is a FAIL; on Windows the gate prints `SKIP E2E gate needs Linux and gcc`.
- `scripts/verify-4.18.28-e2e-native.mjs` runs the flow, three cores, a crash and a backend restart with the real core (`COD4X_CORE`, `COD4X_BASEGAME`, Linux/WSL, non-root). It was smoke-run in the cloud with the test core in place of the real one; the run with the real core is open (`docs/WSL-NATIVE-CHECKLIST.md`, 3f).

## Not covered here

Browser UI test, the installer download, a real client join and the Windows run are not automated; the last two are manual steps in the checklist. Master list and B3 are only checked as named states in CI (no network listing, no Python); their positive paths stay with the earlier gates and the native run.

## Product code

The E2E run found no defect in the product code, so none changed. Version files: `package.json`, `package-lock.json`, `BUILD_INFO.json`, `build.ps1`, UI version strings, README, roadmap status, `DEVELOPMENT_STATUS.md`, `docs/WSL-NATIVE-CHECKLIST.md`.
