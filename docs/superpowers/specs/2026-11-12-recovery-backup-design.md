# Recovery and backup (Roadmap Block 21, 4.18.27)

Status: **draft, waiting for Rafiki's review.** Decisions 1 to 3 were made by Rafiki on 2026-11-12; everything under "Design" is the proposal that follows from them. The implementation plan will be `docs/superpowers/plans/2026-11-12-recovery-backup.md` and is written only after this spec is approved.

## Roadmap text (Block 21, copied)

> **Ziel:** Alle kritischen Änderungen müssen rückgängig gemacht werden können.
>
> **Kritische Aktionen:** Config Change, Plugin Install, B3 Migration, Server Update, Core Update
>
> **Ablauf:** Snapshot → Backup → Change → Verify. Bei Fehler: Rollback.
>
> **Zu sichern:** Config, Server Settings, Plugin Config, B3 Config, B3 DB, Server Metadata, ggf. Usermaps/Mods nach Konfiguration
>
> Bestehende Backup-/Integrity-Mechanismen sollen weiterverwendet werden.
>
> **Gate:** Änderung → Fehler → Restore → funktionierender Zustand PASS

## Intended outcome

Every critical change to a server runs the same way: CONTROL records a restore point, makes the change, checks the result, and puts the old state back by itself when the check fails. The operator can also list the restore points of a server, check their integrity, create one by hand and restore one. Nothing that works today changes its behaviour when the check passes.

## Starting point (main e2fb448)

| Action | Today | Gap |
|---|---|---|
| Config change, local | `config-engine-storage.mjs`: backup, SHA-256 verify, restore | none for `server.cfg`; the instance record is not captured |
| Config change, remote | `writeConfig` + `#saveBackup` (server.cfg, instance.json, manifest), `restoreBackup` | none |
| Plugin install (CoD4x, local) | file copied and hash-verified, removed files go to `plugins/.removed` | no snapshot of the plugin records, no rollback |
| B3 plugins (local) | config `.bak` on reset | no snapshot of custom code or records |
| B3 migration (local) | SQL dump before migration, verified (`verifyBackup`) | no restore of the dump |
| Server update (`/api/installer`) | artifact SHA-256 verified, extracted over the target | no snapshot, no rollback |
| Core update, remote | upload, `.previous`, automatic rollback when `validateExecutable` fails | no manual rollback |
| Core update, local instance | not possible | no way to change the core at all |

Remote instances have no plugin management and refuse B3 migration (`REMOTE_B3_MIGRATE_UNSUPPORTED`); those rows do not apply to them.

## Decisions (Rafiki, 2026-11-12)

1. **Scope:** one restore point per server ("Wiederherstellungspunkt je Instanz") with one common flow for all five actions, local and remote, built from the existing backups. Usermaps and mods are not captured.
2. **B3 database on manual restore:** only when the operator ticks it and confirms, because bans and stats recorded since the snapshot are lost. The automatic rollback of a failed migration restores the database without asking.
3. **Local core change:** local instances get "Core wechseln" (admin only, `server.code`) with a restore point, verify and rollback to the previous core path.

## Design

### Subjects

A restore point belongs to one *subject*:

- a local instance (`local:<id>`),
- a remote instance (`remote:<id>`),
- the standard server of the installer (`default-runtime`), the target of `/api/installer` and `/api/runtime/config`.

### Parts

A restore point holds some of these parts. Which ones depends on the action (next section).

| Part | Local instance | Remote instance | Standard server |
|---|---|---|---|
| `record` | the instance entry of the registry (network, plugin records, B3 integration, B3 plugin records, core path and version) | `instance.json` as today | runtime state (target, platform, core path, version, BaseGame path) |
| `config` | `main/server.cfg` | `server.cfg` as today | – |
| `plugins` | the CoD4x plugin files of the instance (`plugins/*.dll|*.so`) | – | – |
| `b3files` | `b3/database.json`, `b3/plugins/*` (plugin configs), `b3/extplugins/*` (custom code) | – | – |
| `b3sqlite` | `b3/b3.db` when present | – | – |
| `b3mysql` | SQL dump of the configured MySQL database, written by the existing helper | – | – |
| `core` | path and SHA-256 of the core (reference, the file is not copied: it lives outside the home) | SHA-256 and the kept `core/cod4x18_dedrun.previous` on the host | – |
| `files` | – | – | the files in the target that the installer is about to overwrite, plus the list of files it is about to create |

Never captured: secrets and files that hold them (the vault, `b3/b3.xml` and `b3/plugin_auth.ini`, which B3 writes again from the vault on every start), logs, `players/`, `zone/`, `mods/`, `usermaps/`, the BaseGame.

### Which action captures what

| Action | Parts | Verify | Automatic rollback restores |
|---|---|---|---|
| Config change (local) | record, config | existing re-read + SHA-256 | config |
| Config change (remote) | record, config (the existing backup *is* the restore point) | existing | config |
| CoD4x plugin install, approve, enable, disable, configure, remove | record, plugins | every enabled plugin file matches its record (existing `describePlugins`), record list readable | record, plugins |
| B3 plugin changes (enable, config, custom code, approve, delete) | record, b3files | existing plugin plan has no blocker caused by the change | record, b3files |
| B3 migration | record, b3files, b3mysql (when the database has tables, as today) | schema classifies as ready (existing probe) | b3mysql: the dump is played back, then every audited B3 table that was not in the dump is dropped |
| Local core change (new) | record, core | executable checks of instance creation (name, regular file, size, platform) and the existing core verification for the selected version | record (old core path) |
| Remote core update | record, core | existing `validateExecutable` | existing automatic rollback; new: manual rollback to `.previous` |
| Server update (`/api/installer`) | record, files | every extracted file matches its archive entry, manifest written, core executable present | files: overwritten files back, created files removed |
| Manual point | all parts of the subject except b3mysql; b3mysql when ticked | integrity check of the point | – |

The existing config backups (`config-backups/`, remote backups) stay exactly as they are and keep their UI. A restore point refers to such a backup by ID instead of copying `server.cfg` twice where one exists.

### Flow

```text
lock subject → stopped? → capture point → verify point → change → verify change
   └─ verify fails or change throws → rollback from point → verify rollback
         └─ rollback fails → subject RECOVERY_REQUIRED (start blocked)
```

- **Capture first, fail closed.** If the point cannot be written or does not verify, the change does not happen (`RESTORE_POINT_FAILED`).
- **Lock.** Capture, change, verify and rollback run under the existing per-instance lock (`exclusive`, `#exclusive`, B3 database lock). Actions that already require a stopped server keep that rule; a restore always requires the server and B3 to be stopped.
- **Result.** Every guarded action returns `{ restorePointId, verified: true }` on success, or fails with its own code plus `rolledBack: true|false` and the point ID.
- **RECOVERY_REQUIRED.** When a rollback does not verify, the subject is marked, starts are refused with `RECOVERY_REQUIRED`, and the UI offers the point for a manual restore. A successful manual restore clears the mark.

### Manual restore

- Lists all points of a subject with time, action, parts, size and integrity state.
- Before a restore, CONTROL captures a safety point of the current state (as the global backups do today).
- **B3 database (decision 2):** the dump is restored only with `includeB3Database: true` and the confirmation text `B3-DATENBANK ZURÜCKSETZEN`. Without it, the b3mysql part is skipped and reported as skipped.
- **Permissions:** listing and integrity: `config.manage`. Restore of record, config and b3 config files: `config.manage`. A restore that brings code back (plugin binaries, B3 custom code, a core path, installer files): `server.code`, the Block 20 rule for code. Manual point: `config.manage`.

### Storage

- Local and standard-server points under `<data>/restore-points/<subject>/<pointId>/`: `manifest.json` (version, subject, action, createdAt, actor, parts, every file with relative name, size and SHA-256) and `files/`. Directories 0700, files 0600, written into a temporary directory and renamed into place; reading applies the checks of `config-engine-storage.mjs` (no links, owner, mode, size, re-hash).
- Remote points stay in `<data>/remote-backups/<id>/` and gain the `action` and `core` fields in their manifest; old manifests stay readable.
- B3 SQL dumps stay where the migration writes them today (`b3/backups/`); the point stores their path and SHA-256 and verifies them with `verifyBackup`.
- Restored file names come only from the manifest and must resolve inside the subject's known directories; `..`, absolute names, links and names outside the part's directory are refused.
- Limits: 256 MB per point, 20 automatic and 10 manual points per subject; the oldest automatic point is removed first, a point that is the only way back from `RECOVERY_REQUIRED` is never removed.

### API and UI

- `GET /api/restore-points/:subject`, `POST /api/restore-points/:subject` (manual), `GET /api/restore-points/:subject/:pointId/integrity`, `POST /api/restore-points/:subject/:pointId/restore`.
- `POST /api/instances/:id/core` (local core change, `server.code`).
- `POST /api/remote-instances/:id/core/rollback` (`update.execute`).
- UI: a "Wiederherstellung" panel per local instance, per remote instance and for the standard server, with the list, "Punkt anlegen", "Prüfen", "Wiederherstellen" (B3 checkbox and confirmation field), and the core change form for local instances. The remote panel gets the "Recover" button noted in Block 18.
- Audit events `restore_point.created`, `change.verified`, `change.rolled_back`, `change.rollback_failed`, `restore_point.restored`, `restore_point.restore_failed`, without file contents, passwords or DSNs.

## Global constraints

- No secret in a point, a manifest, an audit entry or an API result.
- Existing error codes stay; new ones are `RESTORE_POINT_*`, `RECOVERY_REQUIRED` and `INSTANCE_CORE_*`.
- A change that passes its verify behaves as before; existing tests stay green unchanged.
- Version 4.18.27; the 4.18.26 gates stay in the preflight chain.

## Review focus

1. A crafted or damaged manifest can never write outside the subject's directories, follow a link or restore a file whose hash does not match.
2. A failed verify always leaves the subject as it was before the change, byte for byte for every captured part.
3. A restore without the confirmation never touches the B3 database.
4. A restore that brings code back is refused for an operator without `server.code`.
5. Two changes or a change and a start on the same instance cannot interleave.
6. Capturing a point never stores a secret (vault, b3.xml, plugin_auth.ini, DSN, RCON password).
7. Retention never removes the last point that can lift `RECOVERY_REQUIRED`.

## Open risks (each gets a test or the native gate)

- Playing back a large B3 dump through the helper: the helper runs statements one by one; a timeout is tested with a fake helper, real MySQL is a native check.
- Installer archives with many files: the snapshot lists entries before extracting; tested with zip and tar fixtures.
- Windows file locks while restoring plugin DLLs: refused because the server must be stopped; confirmed natively on Windows.

## Gate

**Änderung → Fehler → Restore → funktionierender Zustand PASS**, in two layers:

1. `scripts/verify-4.18.27-recovery-gate.mjs`, runs everywhere: for each of the five actions (config, plugin install, B3 migration with a fake helper, server update with a fixture archive, core change local and remote with the fake transport) a fault is injected into the verify step; the gate checks that the rollback ran and that every captured part is byte-identical to the state before. Then a manual restore of an older point, with and without the B3 confirmation, and the `RECOVERY_REQUIRED` path.
2. Native gate, run by Rafiki and added to `docs/WSL-NATIVE-CHECKLIST.md`: real core, a config change and a plugin install rolled back, the server starts afterwards; a B3 migration restore against real MySQL.
