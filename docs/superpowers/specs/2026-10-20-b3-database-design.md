# B3 Database (Roadmap Block 14, 4.18.12) – Design

Status: approved in sections on 2026-10-20. Branch `control-4.18.12`.

## Goal

Operators can set up and verify a MySQL/MariaDB database for B3 per instance, safely:

```text
Test Connection → Schema Check → Backup → Migration → B3 Ready
```

Gate: **DB Connection + Schema + Migration PASS**.

Requirements from the roadmap:

- No destructive migration without a backup.
- Passwords never appear in normal logs.
- Failure cases are reported distinctly: DB unreachable, wrong password, wrong schema, missing table, migration failed.

## Decisions

| Topic | Decision |
|---|---|
| DB access | A fixed helper script run with the configured B3 Python 2.7 interpreter and PyMySQL (the driver B3 itself uses). No new npm dependency. |
| Migrations | Core schema `b3/sql/mysql/b3.sql`, plus an explicit opt-in for `b3/sql/mysql/b3-update-ebc.sql` (eBc promod statistics; contains `DROP TABLE IF EXISTS` x2). The 1.x update scripts (`ALTER TABLE`) are not run automatically. |
| Backup | Our own SQL export (structure + data) through PyMySQL, verified before any migration. No `mysqldump`. |
| B3 config | Once the instance is "B3 Ready", `b3.xml` uses the MySQL DSN. Until then B3 keeps SQLite. |

Assumptions:

- One B3 database per instance, configured in the instance context like RCON and the master token.
- Reading settings and status and running the test require `config.manage`; migration requires `server.manage`.

## Constraints from eBc-B3 (pinned commit 9096624)

- `b3/functions.py` `splitDSN` parses `mysql://user:password@host:port/db`.
  - The user is `[^:]+`.
  - The password ends at the first `@`.
  - The host is `[^/:]+`.
  - There is no URL decoding.
  - Therefore:
    - The password must not contain `@`.
    - The user and database are limited to `[A-Za-z0-9_]`.
    - The host is limited to a hostname or IPv4 address (`[A-Za-z0-9.-]`).
- `b3/storage/mysql.py` connects with `host`, `port`, `db=path[1:]`, `charset="utf8"`. The driver order is PyMySQL, then mysql-connector, then MySQLdb.
- The `b3.sql` tables are MyISAM, so there are no transactions. A failed migration cannot be rolled back. Recovery is the verified backup; there is no automatic restore.
- `b3.sql` creates 6 tables with `CREATE TABLE IF NOT EXISTS`: `aliases`, `ipaliases`, `clients`, `groups`, `penalties`, `data`.
- `b3-update-ebc.sql` is a phpMyAdmin dump of database `ebc_b3_pm`. It drops and recreates `player_core` and `prestige_log`.

## Components

### `lib/b3-database.mjs` (pure, no I/O)

- `validateDatabaseSettings({ host, port, database, username })`:
  - host `[A-Za-z0-9.-]{1,253}`
  - port integer 1–65535
  - database `[A-Za-z0-9_]{1,64}`
  - username `[A-Za-z0-9_]{1,32}`
- `validDatabasePassword(value)`:
  - printable ASCII, length 8–128
  - no `@`, `"`, `;`, `\` and no whitespace
- `buildMysqlDsn(settings, password)` and `redactDsn(dsn)`. The DSN exists only in `b3.xml`.
- `parseSchemaFile(text)`: the expected tables and column names from the `CREATE TABLE` blocks.
- `classifySchema(expected, actual)`:

  | State | Meaning | Migration |
  |---|---|---|
  | `EMPTY` | no B3 tables | possible |
  | `PARTIAL` | some B3 tables missing; the existing ones are complete | possible; adds the missing tables |
  | `COMPLETE` | all tables and columns present | not needed |
  | `OUTDATED` | an existing table lacks columns | blocked; no automatic `ALTER` |

  Foreign tables in the same database are ignored and never touched.
- `classifyDatabaseError(code)`:

  | Error code | Result |
  |---|---|
  | 2003, 2005, 2006, 2013, timeout | `DB_UNREACHABLE` |
  | 1045 | `DB_AUTH_FAILED` |
  | 1044 | `DB_ACCESS_DENIED` |
  | 1049 | `DB_NOT_FOUND` |
  | missing driver | `DB_DRIVER_MISSING` |
  | anything else | `DB_ERROR` |

- `planMigration({ schema, tables, ebcOptIn })` returns the ordered SQL files and whether a backup is required. A backup is required whenever the database contains any table.

### `lib/b3-database-helper.mjs` + Python helper

- The Python helper is a string constant, compatible with Python 2.7 and 3.x. Its launch follows `probeInterpreter`:
  - the configured interpreter, run with `-E -c HELPER`
  - `shell: false`
  - an empty temporary cwd
  - a minimal env
  - a timeout and a `maxBuffer`
- The request arrives on stdin as JSON and carries the connection settings and password. **Secrets never appear in argv, env or logs.** The helper prints exactly one JSON line.
- Operations:
  - `probe`: connect, then return the server version and the tables with their columns.
  - `backup`: return a structure and data export for every table in the database.
    - The structure comes from `SHOW CREATE TABLE`; the data is written as `INSERT` statements.
    - Each table gets a marker with its row count.
    - The export is written to `<target>.tmp` (mode 0600) and then renamed.
    - The helper returns the sha256 and the row counts.
  - `apply`: execute a single SQL file with multi-statement support. The SQL comes only from the audited eBc-B3 path. Node checks the file hash immediately before the call.
- The helper reports driver errors as numeric MySQL error codes. Node maps them with `classifyDatabaseError`.

### `lib/instance-b3-database-service.mjs`

- Settings are stored in `<home>/b3/database.json` (mode 0600, written atomically) and never contain the password. The password lives in the credential vault under the new kind `b3db`.
- Every operation takes a per-instance lock. Migration is refused while B3 runs for the instance.
- `test(id)` validates the settings, runs `probe` inside `withRuntimeCredentials`, and classifies the result against the parsed `b3.sql`. It returns the connection state and the schema state with details (missing tables and columns). It performs no writes.
- `migrate(id, { ebcOptIn, confirmation })`:
  1. Run a fresh `probe` and build the plan.
  2. If the database has any table, create a backup at `<home>/b3/backups/b3-<timestamp>.sql`.
  3. Verify the backup: re-read the file, recompute the hash, and check the header, each table's marker and the expected row count. If verification fails, abort before any SQL runs.
  4. Run `apply` for `b3.sql` if the schema is `EMPTY` or `PARTIAL`.
  5. Run `apply` for `b3-update-ebc.sql` only with `ebcOptIn` and the exact confirmation phrase.
  6. Run a final `probe`. It must be `COMPLETE`, and with the opt-in the eBc tables must exist. Otherwise the result is `MIGRATION_FAILED` with the backup path.
- "B3 Ready" means the schema is `COMPLETE`, the `b3db` password is configured, and the last test had no error.
  - The result of the last test and of the last migration is persisted in `database.json` under `lastCheck`, value-free: codes, schema state, timestamp and backup path/hash. This lets readiness survive a backend restart.
  - Saving changed settings or changing the `b3db` password clears `lastCheck`, so the instance is no longer B3 Ready until it is tested again.
- The vault validates `b3db` values with `validDatabasePassword`. That validation replaces the generic RCON/master/join rule for this kind.
- Audit events never contain values, passwords or DSNs; they record codes, table names and the backup hash:
  - `b3.database.tested`
  - `b3.database.backup_created`
  - `b3.database.migrated`
  - `b3.database.migration_failed`

### B3 configuration (`lib/b3-config.mjs`)

- When the instance is B3 Ready, `prepareB3Runtime` takes the `b3db` password inside the vault transfer scope and writes the MySQL DSN into `b3.xml`. The file is written atomically with mode 0600. Otherwise it keeps writing the SQLite DSN.
- `redactB3Config` redacts the DSN password. The config view, the B3 logs and the runtime output must never contain it.
- The Block 13 dashboard MySQL row shows the real database state instead of "(MySQL: Block 14)".

### API

| Route | Permission |
|---|---|
| `GET /api/instances/:id/b3/database` (settings + last status) | `config.manage` |
| `POST /api/instances/:id/b3/database` (save settings) | `config.manage` |
| `POST /api/instances/:id/b3/database/test` | `config.manage` |
| `POST /api/instances/:id/b3/database/migrate` | `server.manage` |
| password via existing `/api/instances/:id/credentials/b3db` | `config.manage` |

### UI (wizard in the instance's B3 area)

1. **Database:**
   - Fields for host, port (default 3306), database and username.
   - The password is write-only and goes into the vault; the status shows only configured / not configured.
2. **Test:** connection result with a plain-language failure case, plus the schema state and the missing tables and columns.
3. **Migration:**
   - Enabled only for `EMPTY` or `PARTIAL`, and disabled while B3 runs.
   - Before running, it shows the SQL files that will run and that a backup comes first.
   - The eBc opt-in is a separate checkbox. It warns that `player_core` and `prestige_log` are dropped and requires the confirmation phrase.
4. **Result:** "B3 Ready" with the backup path and hash, or a clear failure state.

## Failure cases

| Case | Code |
|---|---|
| DB unreachable | `DB_UNREACHABLE` |
| Wrong password | `DB_AUTH_FAILED` |
| No privileges / unknown database | `DB_ACCESS_DENIED` / `DB_NOT_FOUND` |
| Wrong schema | `SCHEMA_OUTDATED` (blocked) |
| Missing table | `SCHEMA_PARTIAL` (migratable) |
| Migration failed | `MIGRATION_FAILED` (with backup path) |
| Backup failed / unverifiable | `BACKUP_FAILED` (migration aborted, no SQL executed) |
| Driver missing | `DB_DRIVER_MISSING` |

## Testing

All tests are written first and must fail before the code exists (TDD).

- **Unit tests for `b3-database.mjs`:**
  - validation, including `@` in the password and unambiguous `splitDSN` parsing
  - DSN build and redaction
  - parsing the real `b3.sql`, with a pinned hash
  - all four schema states
  - error mapping
  - migration plan
- **Helper, with a fake `execFile`:**
  - secrets only on stdin, never in argv
  - timeout
  - invalid output
  - error codes
- **Service, with a fake helper:**
  - every failure case
  - backup required and abort on an unverifiable backup
  - eBc only with the phrase
  - refusal while B3 runs
  - the lock
  - value-free audit
- **`b3-config`:**
  - MySQL DSN when B3 Ready, SQLite otherwise
  - the password never appears in the config view or logs
- **Gate:** `scripts/verify-4.18.12-b3-database-gate.mjs` checks the source wiring, and `scripts/preflight-4.18.12.mjs` includes all earlier gates.
- **Native:** `scripts/verify-4.18.12-b3-database-native.mjs` runs against real MariaDB in the WSL test environment and skips itself without one, e.g. on CI.
  1. test → `EMPTY` → migrate → `COMPLETE`
  2. insert data, drop one table → `PARTIAL` → the backup contains the data → migrate
  3. eBc opt-in
  4. a wrong password gives `DB_AUTH_FAILED`; a wrong port gives `DB_UNREACHABLE`
  5. B3 starts against MySQL and logs "Successfully established a connection with MySQL database"
- **Native prerequisite**, which needs the operator's approval: a test database `b3_control_test` and user `b3control`@localhost with a test password and privileges on that database only.

## Out of scope (YAGNI)

- Automatic 1.x `ALTER` updates.
- Automatic restore from a backup, and a restore UI.
- PostgreSQL.

## Completion

- Version bump to 4.18.12.
- CHANGELOG, including the Windows PowerShell inspection timeout fix from PR #6.
- DEVELOPMENT_STATUS.
- `/engineering:code-review` before Block 15.
