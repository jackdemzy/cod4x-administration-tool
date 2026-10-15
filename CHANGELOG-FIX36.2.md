# FIX36.2 — Audit Tab Render Crash Hotfix

## Root cause
The 4.16.8 UI referenced `checkConsistency` from `BackupRecoveryPanel`, but the handler had accidentally been declared inside `UserAdministrationPanel`. Opening the Audit tab therefore raised a JavaScript `ReferenceError` during React render and left the window blank.

## Fix
- moved `checkConsistency()` into `BackupRecoveryPanel`, where the **Konsistenz prüfen** button uses it
- removed the stale, unreachable duplicate handler from `UserAdministrationPanel`
- preserved the 4.16.8 consistency endpoint and audit events
- preserved the 4.16.7 restore/integrity gate unchanged

## Validation
- Node syntax: PASS
- 4.16.8 preflight: PASS
- UI handler scope: corrected
- Vite/Windows Electron build: not executed in this environment
