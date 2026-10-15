# FIX22 – 4.10.9 Persistent Log Hardening

## 4.10.9 – Persistent-Log-Hardening

Implemented on top of FIX21 / 4.10.8 without changing the 3.0.2 RC1 application version.

### Backend

- persistent audit log path validation against a configured audit root
- directory-escape protection for the audit directory
- active `audit.ndjson` limit of 10 MiB
- automatic rotation before a write would exceed the limit
- retention of the last 7 rotated audit logs
- append-mode writes (`a`) to prevent normal truncation/replacement
- best-effort restrictive `0600` log permissions; Windows compatibility retained
- explicit persistent I/O error state and API reporting
- bounded persistent-log reads retained
- malformed NDJSON line isolation retained
- secret/token/password/credential redaction retained
- SHA-256 checkpoint retained
- new `/api/audit/hardening` status/check endpoint
- manual rotation now uses the same hardened rotation/retention path

### UI

- new Persistent-Log-Hardening panel in the Audit tab
- displays hardening checks, active log size, rotation count, I/O state and limits
- no design redesign

### Compatibility

- 4.10.4–4.10.8 functionality retained
- CoD4x 21.3 / 21.4 / 21.5 support retained
- app version remains 3.0.2 RC1
