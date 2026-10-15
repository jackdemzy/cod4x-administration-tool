# FIX25 — 4.11.0 Configuration & Policy Engine

## Implemented

- Central policy model with persisted `config/policy.json`
- Atomic policy writes via temporary file + rename
- Policy schema normalization and validation
- Configurable audit event retention
- Configurable persistent audit read limit
- Configurable active audit-log size limit
- Configurable rotated-log retention
- Centralized CoD4x version allowlist
- Centralized client/server target allowlist
- Centralized RCON/network port bounds
- `/api/policy`
- `/api/policy/validate`
- `/api/policy/save`
- Audit events for policy validation and policy saves
- New Configuration & Policy Engine UI in Audit
- Existing 4.10.8/4.10.9 security and persistent-log hardening retained

## Default policy

- Audit events: 500
- Persistent reads: 500
- Active log: 10 MiB
- Rotated logs: 7
- CoD4x: 21.3 / 21.4 / 21.5
- Targets: server / client
- Ports: 1–65535
