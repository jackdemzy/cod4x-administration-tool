# Development checkpoint: 4.18.3 / Block 6 in progress

Saved on 2026-10-15 at the owner's explicit request. This is a source checkpoint, not a completed release, installer certification or general security approval. The binding ROADMAP files remain authoritative; development through Block 10 is not complete.

## Implemented since the initial upload

- Vault conflicts and locks revoke active runtime leases, overwrite supplied buffers and abort pending credential operations.
- Conservative persisted Join and RCON activation policies, including legacy classification, clone isolation, and ordered registry/vault changes that fail closed.
- Windows private RCON/Join handoff with restricted ACLs, short-lived configuration, bounded Loopback readiness and cleanup before successful startup.
- Persistent nonsecret guard against the known Core Join-password archive writer. Private runtime stdout/stderr and console-file readback are suppressed.
- Actual backend start/restart integration, runId-bound activation metadata and stop/exit invalidation. Failed readiness stops only the newly owned run through existing identity checks.
- RCON-only activation explicitly verifies that the Join-password flag is false. Optional Master credentials do not block local startup by themselves.

## Evidence and limits

Latest local Windows preflight: **169 passed, 0 failed, 6 skipped**, exit 0. This includes syntax, runtime/version consistency and executable regression suites. Skips are the existing host-dependent chmod check and Linux-only checks; they are not passes.

Isolated native Core 21.2 tests exercised the Manager and authenticated HTTP backend with synthetic credentials, unique homes and Loopback ports. Combined RCON/Join and RCON-only start/restart/stop passed. Locked restart preserved the old process; an intentionally wrong readiness password stopped only its own new run. Cleanup checked process absence, private-file absence, secret residue, and unchanged Core/BaseGame assets. These are bounded one-run gates, not broad runtime certification.

Independent bounded source reviews found a stale READY-state bug, which was reproduced and fixed with lifecycle regression tests. The final reviewed RCON-only/migration delta had no further concrete findings. Reviews did not independently execute the native gates.

Still open: native Join-only/ephemeral-RCON gate, real vault abort during readiness, hard backend-abort and private-file/archive-transaction recovery, full UI/Electron evidence, remaining configuration-schema breadth and the complete Block 6 gate. RCON commands, Master registration/list verification and Plugin Manager blocks are not complete. Stored credentials alone are never proof of active runtime configuration.

## Dependency provenance

This checkpoint preserves the dependency files of the tested local source. It branches from the original source-import commit `c4c4de611bc85b41149fa09b5373b9683ea849b4`.

The separate `main` branch had advanced to `f8785e9d66272c6e63dcb6a84c8f38e50a844b55`, updating Electron and adm-zip. Those updates are deliberately neither overwritten nor silently included here: they have not been validated with this local checkpoint. Integrating the two lines requires an explicit dependency-aware verification pass.

## Repository hygiene

No local vault/auth/server data, real credentials, game assets, Dedicated EXE/DLL files, dependencies, builds, native test homes or private machine reports are included. `.env.example` and source configuration templates contain no configured user credentials. Pattern scanning is supplementary and is not a full secret/security audit.

Keep local state outside tracked source, for example:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

All previous checkpoints and the authoritative local source remain intact. No release/tag or merge into main is implied by this save.
