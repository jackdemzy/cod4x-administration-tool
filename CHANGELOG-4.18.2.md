# COD4X CONTROL 4.18.2

## Windows Dedicated Runtime

- Windows runtime starts only `cod4x18_dedrun.exe`; `iw3mp.exe` remains excluded from the Dedicated Server Core model.
- Added bounded stdout/stderr capture to persisted runtime state.
- Added post-spawn Windows PID verification for the expected executable image and canonical executable path.
- Stop now performs a non-forced termination attempt, verifies the process has exited, and uses a forced `taskkill` fallback only when necessary; the process-gone verification is mandatory before `STOPPED` is recorded.
- Retained the Verified-Core gate, `shell:false`, correlation/audit events, runtime history, PID kill guard, and controlled `fs_basepath` / per-instance `fs_homepath` arguments.
- Added 4.18.2 version, preflight, and focused runtime regression checks.

## Validation boundary

## Resumed audit corrections — 2026-10-01

- Failed or unrecognized Windows process inspection is now unknown, never confirmed absence.
- Stop preserves PID/state on inspection failure and refuses unexpected executable paths.
- Forced-stop fallback rechecks executable identity immediately before the stop command.
- Failed post-spawn identity verification no longer triggers unconditional PID termination.
- Added six executable process-guard tests with controlled OS responses and wired them into source preflight. These are not native Dedicated lifecycle tests.

The previously generated installer predates these corrections and is retained as a historical development artifact. It is not the current source build and must not be treated as release-ready.

The source checks validate the static runtime contract. A genuine lifecycle gate additionally requires a Windows host with a verified `cod4x18_dedrun.exe` and two isolated server instances; no such execution result is asserted by this changelog.

## Continued implementation — 2026-10-01

- Runtime output monitoring attaches before spawn resolves, retaining early stdout/stderr and rejecting early exits rather than reporting false RUNNING.
- Lifecycle and configuration operations are serialized; obsolete child output cannot contaminate a new run. Unexpected zero-code exit remains FAILED.
- Failed stop clears its expected-exit marker when the process is still alive.
- Reviewed BaseGame/layout/state modules and their tests integrated from the existing BaseGame branch without changing that branch. Backend and UI store/select a structurally validated read-only BaseGame; core cwd, asset fs_basepath and server fs_homepath remain distinct.
- Unverified core is denied before the layout creates a server home.
- Packaging includes lib modules. No new installer was generated.
- Full current source preflight: 46 behavioral tests, 45 PASS, 0 FAIL, 1 platform-permission SKIP; frontend build PASS. Authenticated isolated HTTP test added. Native runtime and two-instance gates remain OPEN; this is not a completed 4.18.2 release.

## Server Instance prerequisite — 2026-10-01 continuation

- Saved the previous source before changes and implemented a versioned managed instance registry with safe IDs, generated distinct homes, reserved unique UDP ports, initial configuration and independent logs/state.
- Extracted the existing Runtime Manager into a shared factory with per-instance closures. No global state swapping and no second copy of the lifecycle implementation.
- Added authenticated instance CRUD/lifecycle routes and a Runtime-tab instance panel. Legacy runtime/state remains a separate compatibility path; managed homes cannot be started through that legacy path.
- Clone copies the definition and generates new initial configuration without copying arbitrary user files or secrets. Delete archives owned stopped homes into .trash instead of erasing them. Creation failure retains recoverable files without a phantom registry entry.
- Instance process verification includes home/port command-line identity and process creation time, preventing sibling identity and known PID-reuse mismatches. Corrupt runtime state blocks start/delete without overwriting evidence.
- Real tasklist/CIM inspection of a test-owned Node helper found and fixed translated process-absence handling. No Dedicated process was launched by that test.
- Latest preflight: 65 tests, 64 PASS, 0 FAIL, 1 SKIP. UI build PASS. Formal native two-Dedicated-server gate remains OPEN; Block 4, Linux and release have not been declared complete.
