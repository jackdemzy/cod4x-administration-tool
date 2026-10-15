# COD4X CONTROL 4.18.2 — Validation Report

## Latest source evidence — 2026-10-01 Server Instance block

This section supersedes the earlier source evidence below. Status: DEVELOPMENT INCOMPLETE, native Block-3/4 gates OPEN.

- Full `node scripts/preflight-4.18.2.mjs`: exit 0, 65 behavioral tests, 64 PASS, 0 FAIL, 1 SKIP. The chmod-denial case is skipped on Windows. Preflight requires permission to execute Windows tasklist/CIM queries; the successful full run used the expanded execution context.
- Vite build: exit 0, Vite 7.3.6, 29 modules; `index-E0pnp36Q.js`. Build does not prove interactive UI/Electron behavior. Sandbox cache EPERM was resolved by a successful expanded-context rerun.
- Runtime moved to `lib/runtime-manager.mjs`: same process guards, one closure/state/write queue/child/operation lock per instance. Existing single-runtime endpoints retain their own default manager and old state; no automatic copying or destructive migration.
- `ServerInstanceStore`: versioned registry, unique safe IDs and UDP ports, generated owned homes and initial `main/server.cfg`, read-only shared BaseGame/Core, transactional registry writes and recoverable creation-failure directories. Core verification is still required at start; instance creation does not itself establish binary trust.
- `ServerInstanceManager`: create, clone definition, list/status, start/stop/restart, recoverable archive. Clone regenerates initial configuration and does NOT duplicate arbitrary user configuration, mods, logs, saves or credentials. Configuration parsing/editing remains Block 6.
- Authenticated HTTP integration exercised new routes, port conflict, independent definitions, unverified-core denial, actual backend restart, preserved legacy configuration and recoverable deletion. All files/users/backend processes were isolated test fixtures.
- Five controlled-process instance tests prove independent homes/PIDs/ports/output, sibling survival of stop/crash/restart, refusal of sibling/PID-reuse identity, active-instance archive denial and corrupt-state recovery blocking.
- Instance process ownership additionally checks command-line fs_homepath, net_port and persisted creation time. Missing creation-time evidence is refused. This is stricter than executable-path identity alone.
- A real Windows tasklist/CIM test on a test-owned Node helper PASS. It exposed a German tasklist absence message; absence now requires explicit CIM `{found:false}`, never translated message matching. It is NOT a native CoD4X lifecycle test.
- Junction aliases into BaseGame and post-creation linked instance directories are rejected by tests. Legacy starts cannot take over managed homes, including canonical aliases. Local filesystem mutation races remain a separate hardening concern.

### Still unverified / not completed

No native CoD4X pair was launched. The formal Block-3 two-Dedicated-server gate is OPEN despite passing controlled-process parallel tests. Block 4 native lifecycle and crash gates remain OPEN. The local binary has not been given unproven version/provenance or silently adopted. No new installer, native UI test or release was produced. Linux remains deferred.

The initial instance adapter deliberately binds loopback and selects mp_backlot; public/network/map/config editing are not included in this block. UDP probing cannot eliminate a race with another external process binding after the probe. Existing runtime output persistence still needs disk-failure/load review; UTF-8 chunk-boundary behavior, secret redaction, filesystem mutation races and descendant-process ownership need further review before native sign-off. Archive is recoverable but no restore UI is implemented yet.

## Earlier source evidence — superseded by Server Instance block

This section supersedes the historical evidence below for the current source. Release status remains DEVELOPMENT INCOMPLETE.

- `node scripts/preflight-4.18.2.mjs`: exit 0; 46 behavioral tests, 45 passed, 0 failed, 1 skipped. The skipped chmod permission-denial test is not enforceable on this Windows host. Source-pattern checks are supplementary, not lifecycle evidence.
- Process-control behavior: 15 passing tests execute the production Runtime Manager with controlled OS I/O. They cover early output/crash, serialized operations, path/PID rejection, inspection failures, force-stop identity recheck, launch paths, core-before-layout ordering, and failed-stop classification. They do not launch or stop a native Dedicated Server.
- Authenticated HTTP integration: real isolated backend, temporary credentials/data, BaseGame configuration and persistence, invalid configuration rejection, preflight and unverified-core start denial. No genuine game process launched; temporary backend and fixtures removed.
- `npm run build`: exit 0, Vite 7.3.6, 29 modules. Initial sandbox EPERM on Vite cache required a successful elevated rerun. This proves frontend compilation, not interactive UI behavior.
- Local retail directory structure: 21 readable nonempty IWD files and 73 Zone files, no structural errors. This is not a retail hash/completeness certification.
- BaseGame is independently configured; fs_basepath uses its read-only source directory, cwd uses Dedicated Core directory, fs_homepath uses the server home.

### Open gates and limitations

- Block 3 is OPEN: production still has one global Runtime state/child, no completed ServerInstance model or simultaneous two-instance lifecycle. A concurrent-start denial test is not the required two-instance gate.
- Native start/running/stop/restart/crash, actual Windows permissions, frontend interaction and installer first-run are NOT RUN.
- A local Dedicated executable and game assets are present, but the executable was not adopted or launched and its official provenance/version was not established by this audit.
- The historical installer below predates the current corrections and BaseGame integration. It is STALE, not a current passing packaging result; no replacement installer was produced.
- Home isolation currently checks lexical nesting. Junction/symlink aliases, PID creation-time identity, UTF-8 chunk boundaries and output-persistence pressure still require targeted review before native/runtime sign-off.
- Linux runtime remains deferred. The original BaseGame worktree was not modified or merged.

## Historical evidence — superseded source/installer

## Scope

Windows Dedicated Runtime implementation: bounded console output capture, PID and executable-path verification after spawn, controlled stop with process-gone verification, retained Dedicated-Core boundaries, and source/installer validation.

## Fresh evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Node syntax | PASS | `node --check installer-server.mjs`, `electron-main.cjs`, `electron-preload.cjs`, and the new 4.18.2 test scripts exited 0. |
| Runtime regression contract | PASS | `node scripts/verify-4.18.2-runtime.mjs` exited 0. |
| Version consistency | PASS | `node scripts/verify-4.18.2-version.mjs` exited 0. |
| 4.18.2 preflight | PASS | `node scripts/preflight-4.18.2.mjs` exited 0. |
| Vite production build | PASS | `npm run build` completed with 29 transformed modules. |
| Electron/NSIS artifact | PASS | Final `dist-installer/COD4X-CONTROL-Setup-4.18.2-x64.exe` was generated (93,393,263 bytes). SHA-256: `27AA2DF84B3540D58E599D3018BFBD1F8CE09759D6391DC73597BD8469D2B566`. |
| Installer signature | NOT SIGNED | Windows Authenticode status: `NotSigned`. |
| Installer installation / first run | NOT RUN | Not exercised in this validation pass. |
| Dedicated runtime lifecycle | NOT RUN | No reproducible native lifecycle was executed. A later audit found a local executable and assets, but did not verify/adopt/launch that executable or complete two-instance support. |

## Required runtime gate before release completion

Run on Windows with a verified `cod4x18_dedrun.exe` and at least two separate server directories:

1. Adopt and verify the Windows Dedicated Core.
2. Start each instance and confirm distinct `fs_homepath` values.
3. Confirm `RUNNING`, PID/image/path verification, and bounded stdout/stderr capture.
4. Stop each instance and confirm its process is gone before `STOPPED`.
5. Restart one instance and verify a new running PID.
6. Trigger a controlled crash and verify `FAILED`, exit code, and captured stderr.
7. Install the NSIS artifact and repeat first-run, core-discovery, and lifecycle checks.

This report intentionally does not declare the Runtime Lifecycle gate or a release complete.
