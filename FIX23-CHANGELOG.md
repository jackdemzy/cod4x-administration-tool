# FIX23 — 4.10.9 Persistent-Log-Hardening Runtime Fix

## Fix
- Defined the missing `isSafeAuditPath()` validation used by the persistent-log hardening API.
- Added an explicit audit-root boundary via `COD4X_AUDIT_ROOT`.
- Added 10 MiB active-log enforcement before append writes.
- Added safe automatic/manual rotation with a maximum of 7 rotated logs.
- Added append-only writes and I/O health state.
- Added permission reporting (`0600` on non-Windows systems; Windows is reported as OS-managed).
- Added persistent-log status fields consumed by the hardening UI.
- Preserved existing NDJSON, bounded reads, redaction and SHA-256 checkpoint behavior.

## Verification
- `node --check installer-server.mjs` — PASS
- ZIP top-level directory — FIX23
- Application version remains 3.0.2 RC1
