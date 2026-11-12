# Changelog 4.18.27 – Recovery and backup (Roadmap Block 21)

Before a critical change CONTROL keeps a restore point of what that change touches, checks the result afterwards and puts the point back when the check fails. Design and plan: `docs/superpowers/specs/2026-11-12-recovery-backup-design.md`, `docs/superpowers/plans/2026-11-12-recovery-backup.md`.

## Restore points

- One store under `<data root>/data/restore-points/<subject>/<point>/` (`local_<id>`, `remote_<id>`, `default-runtime`): a manifest with the SHA-256 of every file, directories 0700 and files 0600, written into a temporary directory and renamed into place. A point is checked (privacy, size, hash, no links) before anything is taken from it. At most 256 MiB per point; 20 automatic and 10 manual points per instance, the oldest go first, the point named in a recovery mark is never removed.
- Parts of a local instance: `record` (the registry entry), `config` (`main/server.cfg`), `plugins` (`plugins/*.dll|*.so`), `b3files` (`b3/database.json`, `b3/plugins/`, `b3/extplugins/`), `b3sqlite` (`b3/b3.db`), `b3mysql` (a reference to the verified dump under `b3/backups/`), `core` (path, version and hash of the core). Never captured: the vault, `b3/b3.xml` and `b3/plugin_auth.ini` (B3 writes both from the vault on every start), logs, player data, `zone`, `mods`, `usermaps`, the base game.
- Files a point does not hold are moved to `.removed/<name>.<time>` on restore, never deleted.

## Automatic rollback

| Change | Point holds | Check afterwards |
|---|---|---|
| Config change (local) | record, config | the engine verified the write and the file hash matches |
| CoD4x plugin install, approve, enable, disable, remove, settings | record, plugins | every approved plugin file has its approved hash |
| B3 plugin enable, settings, approve, own plugin create, edit, delete | record, B3 files | no missing, changed or invalid plugin for that name |
| B3 migration | record, B3 files, the dump made before the first SQL | schema complete; on failure the dump is replayed and the B3 tables the migration created are dropped; the table list must then equal the list before |
| Server update (installer) | every target file an archive would overwrite, with its mode, and the names it creates | every written file has the hash from the archive |
| Core change (local instance, standard server) | record | core exists, version allowed |
| Core update (remote) | config and record on this PC, the hash the kept `.previous` will have | the uploaded core runs (existing in-place swap) |

A rollback after an automatic change puts back only the record fields that change touches, so a parallel change of other fields is never undone with it. When the rollback itself fails the instance is marked `RECOVERY_REQUIRED`: the server, B3 and a B3 migration refuse to start until a point is restored (local) or `Core zurücksetzen` succeeded (remote).

## What administrators notice

- **Panel „Wiederherstellungspunkte“** per local instance and under the installer: list (time, cause, parts, size, state), create, check, restore. Before a restore the current state is kept as its own point (`restore.safety`).
- **Code needs `server.code`.** Restoring a point that brings code back (CoD4x plugins, the core, files under `b3/extplugins/`, installed files of the standard server) is for administrators only; operators can restore configuration and B3 settings.
- **The B3 database is only reset on request:** tick the box and type `B3-DATENBANK ZURÜCKSETZEN`. Readiness needs a new database test afterwards.
- **New: core change for a local instance** (`POST /api/instances/:id/core`, admin) and **`Core zurücksetzen`** for remote servers (`POST /api/remote-instances/:id/core/rollback`, `update.execute`): puts the kept `.previous` back after checking its hash against a core-update backup.
- **The installer** downloads and checks every artifact before the first write, needs the standard server stopped (`RUNTIME_CONFIGURATION_BUSY`), and refuses archives with symbolic or hard links (`INSTALL_ARCHIVE_INVALID`) and targets with linked folders (`INSTALL_TARGET_INVALID`).
- Remote backups carry their cause (`manual`, `config.change`, `core.update`, `restore.safety`); backups written before 4.18.27 still list and restore.

## Routes

`GET|POST /api/instances/:id/restore-points`, `GET /api/instances/:id/restore-points/:pointId/integrity`, `POST /api/instances/:id/restore-points/:pointId/restore` (`config.manage`, code parts checked inside), `POST /api/instances/:id/core` (`server.code`), `GET|POST /api/runtime/restore-points`, `GET /api/runtime/restore-points/:pointId/integrity` (`config.manage`), `POST /api/runtime/restore-points/:pointId/restore` (`server.code`), `POST /api/remote-instances/:id/core/rollback` (`update.execute`). Bodies have exact key sets; answers never carry file contents.

## Checks

`scripts/verify-4.18.27-recovery-gate.mjs` (part of `npm run preflight`) injects a failed check into each of the six changes and requires a byte-identical rollback, then a manual restore with and without the B3 confirmation and the `RECOVERY_REQUIRED` path. Still open (native, `docs/WSL-NATIVE-CHECKLIST.md` section 3e): a real core after a rollback, the B3 migration against a real MySQL, plugin DLL restore on Windows.
