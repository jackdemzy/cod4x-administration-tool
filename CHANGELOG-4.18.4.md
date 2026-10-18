# COD4X CONTROL 4.18.4

## Server Configuration Engine (Roadmap Block 6)

- Declared all ten Block 6 configuration areas in `CONFIG_SECTIONS` (`lib/config-engine.mjs`). Identity, Network, Gameplay, Maps, Security and B3 logging are schema-managed; RCON and Master Server are delegated to the credential vault (Blocks 7/8); Mods and Plugins are marked as not yet managed (Block 10) and their CVARs stay rejected.
- Restart detection: every instance start records the `server.cfg` SHA-256 together with run ID and PID in `logs/config-activation.json` (`lib/config-activation.mjs`). The config API reports `ACTIVE`, `RESTART_REQUIRED` (file changed outside CONTROL while running), `UNKNOWN` (running without matching evidence) or `STOPPED` with `changedSinceLastStart`. Corrupt, foreign or mismatched evidence is never trusted. A failed record never fails an already started run.
- Reproducible change trail: apply/restore results carry `previousSha256`; new audit events `config.change.applied` and `config.change.restored` record instance, actor, fingerprints, backup ID and changed setting names, never values.
- Config editor UI groups settings by section, shows delegated/unmanaged areas, displays the activation state and renders the diff as a table instead of raw JSON.
- Added the Block 6 gate `scripts/verify-4.18.4-config-gate.mjs`: change, backup, apply, verify, no-op reproducibility, byte-identical restore, plus invalid CVAR, inadmissible value, plaintext credential, duplicate setting, stale snapshot and damaged config recovery.

## Credential vault review finding (fixed)

- A vault self-lock triggered by a concurrent reader (conflict in `readVerifiedUnlocked`) did not abort the active runtime credential scope. `CredentialVaultStorage` now accepts an `onLock` hook that runs on every lock path; `InstanceCredentialService` uses it to wipe the lease buffers and abort its signal synchronously. Covered by a new regression test.

## Validation boundary

- Windows source preflight `node scripts/preflight-4.18.4.mjs` was run for this change. Linux/WSL preflight and native Dedicated lifecycle gates were not re-run for this block.
- The native CIM inspection test (`test/windows-native-process-inspection.test.mjs`) can fail on hosts where a cold `powershell.exe` start approaches the 3 s inspection timeout; it fails closed (`alive: null`). This predates 4.18.4 and is unchanged.
- Credentials are still not handed to the Dedicated Core; no release or installer was produced.
