# COD4X CONTROL 4.18.22

## Multi-server isolation (Roadmap Block 17)

Design: `docs/superpowers/specs/2026-11-07-multi-server-design.md`. Several instances already had their own port, home, config, credentials, plugins, B3 and logs. This release closes the gaps between them and proves the gate with three instances launched in parallel.

### Gaps found and closed

- **Shared B3 MySQL database.** `InstanceB3DatabaseService.save` refuses a target (host, port, database name) that another instance already saved, and a B3 start refuses a target another instance has enabled. Code `B3_DATABASE_TARGET_SHARED`, with a German and an English message.
  - The key (`databaseTargetKey`, `lib/b3-database.mjs`) ignores the user name and treats `localhost`, `127.0.0.1` and `::1` as one host. Different host names for the same server cannot be detected.
  - A sibling with a missing or corrupt `database.json` never blocks this instance. SQLite needs no check (the file lies in the instance home).
- **Shared master token or RCON password: warning only.** `set` returns `warnings: [{ code: MASTER_TOKEN_SHARED | RCON_PASSWORD_SHARED, instances: [...] }]` after a successful save; `instanceStatus` lists `sharedWith` per kind (`[]` when unique, `null` while the vault is locked).
  - Values are compared in memory only; results, audit and logs carry instance IDs, never a value, hash or length. The `master.token.configured` audit event gains `sharedWith`.
  - Records of archived or recreated instances are ignored. The credential editor shows the warning (`lib/credential-warnings.mjs`).
- **`g_log` / `logfile` in a hand-edited `server.cfg`.** The managed-config validator now applies the config engine's rules (`GAME_LOG_PATH`, one shared pattern): `g_log` stays a `.log` file inside the instance (optional `logs/`), `logfile` is 0 to 2. A violation blocks the launch before any process exists.
- **Parallel launch with stored credentials failed.** Found by the new three-instance test: the vault serves one runtime credential scope at a time and refuses the second with `VAULT_OPERATION_BUSY`, so launching two instances with a stored RCON password or master token at once failed for one of them. `ServerInstanceManager.vaultTurn` now lets parallel launches take turns for the short credential hand-over. The vault itself is unchanged and still refuses concurrent scopes and mutations. Without this change the two parallel tests fail.

### Checks

- Tests: `test/multi-server-isolation.test.mjs` (15), with real store, vault, RCON service, B3 service and UDP doubles: three instances launched in parallel with their own port, home, RCON password and master token (no secret in a sibling's command line, only the own password works on each port, stopping one leaves the others serving); RCON commands reach only their own instance; taken port, taken ID, foreign homepath, a config with a sibling's port or a `g_log` into a sibling; separate `b3.xml` per instance; the database and credential cases above. Plus `databaseTargetKey` in `test/b3-database.test.mjs`.
- Gate: `scripts/verify-4.18.22-multi-server-gate.mjs` (15 source and behavior checks, then the test file above). Fake core.
- Native check: `scripts/verify-4.18.22-multi-server-native.mjs` starts three real CoD4x cores and checks hostname, password rejection across instances, `/proc` command lines, stopping one and restarting it. **Not run yet** (it skips without a core and base game); it needs a run in WSL.
- Preflight `scripts/preflight-4.18.22.mjs` runs the new gate and native check in addition to everything from 4.18.21.
- Result in a Linux container as a non-root user (Node 22): preflight exit 0, full suite `node --test "test/*.test.mjs"` 518 tests, 511 pass / 0 fail / 7 skip. As root, five existing tests fail (four native Linux process tests and `runtime-http-integration`, "Dedicated runtime must not run as root"); they fail the same way on 4.18.21.

### Open

- The native three-core check has not been run.
- The legacy single runtime (`/api/runtime/*`) is not in the instance registry; a port conflict with it is caught only by the UDP probe while it is running.
- The UI shows the generic `B3_DATABASE_TARGET_SHARED` message; the other instance's ID is in the service error but the B3 route passes only the code.
- B3 starts and the database helper use the same vault scope and still fail fast with `VAULT_OPERATION_BUSY` when two run at once; a retry works.
- What the master does with two servers that present the same token is not verified; the warning only recommends one token per server.
