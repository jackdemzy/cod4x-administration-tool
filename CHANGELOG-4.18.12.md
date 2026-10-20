# COD4X CONTROL 4.18.12

## B3 Database (Roadmap Block 14)

Design: `docs/superpowers/specs/2026-10-20-b3-database-design.md`. Plan: `docs/superpowers/plans/2026-10-20-b3-database.md`.

### Implementation

- `lib/b3-database.mjs` (pure): settings and password rules that stay unambiguous for eBc-B3 `splitDSN` (no `@` in the password; user/database `[A-Za-z0-9_]`), DSN building, SQL statement splitting, schema parsing of the audited `b3.sql`, schema classification (EMPTY / PARTIAL / COMPLETE / OUTDATED), MySQL error mapping and migration planning.
- `lib/b3-database-helper.mjs`: a fixed Python helper (2.7 and 3.x) started with the configured B3 interpreter (`-E`, `shell: false`, empty temporary cwd, minimal env, bounded time and output). Requests, including the password, go to stdin only. Operations: `probe`, `backup`, `apply`. Driver order as in eBc-B3 (`pymysql`, `mysql.connector`, `MySQLdb`). `readAuditedSql` reads only the pinned `b3.sql` / `b3-update-ebc.sql` and checks their hashes right before execution (`B3_SOURCE.auditedSql`; the optional eBc file does not gate the B3 runtime).
- `lib/instance-b3-database-service.mjs`: per-instance settings in `<home>/b3/database.json` (0600, no password), password in the vault (new kind `b3db`), per-instance lock, `test`, `migrate`, readiness (`lastCheck`) that survives a backend restart and is cleared by settings or password changes. Backups go to `<home>/b3/backups/b3-<UTC>.sql` (never overwritten) and are verified before any SQL runs. MyISAM has no transactions, so a failed migration reports `MIGRATION_FAILED` with the backup path; there is no automatic restore.
- Migration: the core schema only creates missing tables (`b3.sql` inserts the default groups without `IGNORE`, so re-running the whole file would fail on a PARTIAL schema). The eBc promod schema runs only with the exact phrase `DROP player_core AND prestige_log` and after a backup.
- B3 runtime: once the instance is B3 Ready, `b3.xml` gets the MySQL DSN inside the vault transfer scope; a locked vault leaves `b3.xml` unchanged. The dashboard MySQL row shows the real setup state instead of "(MySQL: Block 14)".
- API: `GET|POST /api/instances/:id/b3/database`, `POST …/test` (config.manage), `POST …/migrate` (server.manage). Audit events `b3.database.tested|backup_created|migrated|migration_failed` carry codes, table names and the backup hash only.
- UI: database wizard below the B3 manager; the B3 database password is set in the credential editor.

### Findings from real MariaDB

- MariaDB 10.11 answers an unknown user over TCP with error 1698, not 1045. It is mapped to `DB_AUTH_FAILED`.

### Native check

`scripts/verify-4.18.12-b3-database-native.mjs` passed 14/14 in WSL COD4X-Test against the dedicated test database `b3_control_test` (MariaDB 10.11, Python 2.7.18, PyMySQL 0.10.1, eBc-B3 9096624):
EMPTY -> migration -> COMPLETE without backup; existing data plus a dropped table -> SCHEMA_PARTIAL -> verified 0600 backup containing the data -> only the missing table created; eBc opt-in refused without the exact phrase and applied after a backup; wrong password -> DB_AUTH_FAILED; wrong port -> DB_UNREACHABLE; a real B3 start logged "Successfully established a connection with MySQL database" with no password in b3.log, B3 output or events.

### Whole-branch review and fixes

- A vault lock during a migration is honored: every helper call runs in its own short vault scope (the vault scope is exclusive across all instances, so a migration no longer blocks RCON and server starts for minutes). A lock before any SQL ran records nothing; a lock while SQL ran records `VAULT_LOCKED` (not ready) instead of a misleading `MIGRATION_FAILED`.
- B3 no longer falls back to SQLite silently: once an instance was B3 Ready, B3 start is refused with `B3_DATABASE_NOT_READY` until the database is tested again; going back to SQLite is explicit (`POST …/b3/database/remove`). B3 start is refused while a migration runs (`B3_DATABASE_BUSY`), and a vault lock inside the start scope leaves `b3.xml` unchanged.
- The B3 database password can be changed while the game server runs (it is not used by the server process).

### Also in this version

- Windows process inspection gives a cold PowerShell start 10 s instead of 3 s (PR #6); stop/recovery no longer abort on slow hosts.
- GitHub Actions CI runs the source preflight and the frontend build on Windows and Ubuntu for every pull request.

### Gate

`scripts/verify-4.18.12-b3-database-gate.mjs` (source wiring) and `scripts/verify-4.18.12-b3-database-native.mjs` (real MariaDB, Python 2.7, PyMySQL, eBc-B3; skips without a configured test database). `npm run preflight` runs `scripts/preflight-4.18.12.mjs` with all earlier gates.
