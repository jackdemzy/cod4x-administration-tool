# FIX36 — 4.16.5–4.16.7 Production Backup Reconstruction

Base: FIX35 (last user-verified source).

Implemented:
- persistent `config/production-backups.json` registry
- bounded retention (50 records)
- fixed/allowlisted configuration backup set
- atomic registry writes
- SHA-256 backup fingerprinting
- per-backup integrity verification
- mandatory SHA-256 verification immediately before restore
- automatic pre-restore safety snapshot
- temporary-file + rename restore writes
- restore correlation IDs and audit events
- Audit UI for create / verify / restore

## FIX36.1 / 4.16.8 — Backup Registry Consistency Gate

Added:
- read-only `/api/backups/consistency` diagnostics endpoint
- registry shape and retention-bound checks
- duplicate-ID detection
- backup-path safety validation
- referenced-file existence checks
- backup payload/schema validation
- SHA-256 metadata/content consistency checks
- backup ID / algorithm metadata consistency checks
- orphaned JSON backup-file detection
- `backup.consistency.checked` / `backup.consistency.failed` audit events
- UI action **Konsistenz prüfen** with per-check result display
- existing 4.16.7 restore gate remains unchanged

Validation in this environment: Node syntax + Vite build + source packaging.
Windows/Electron installer must still be built on Windows before calling the Windows packaging gate PASS.
