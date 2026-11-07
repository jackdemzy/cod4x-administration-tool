# Multi-server isolation (Roadmap Block 17, 4.18.22)

Status: draft for review, 2026-11-07. Scope agreed in conversation with Rafiki: gap analysis first, then this spec. Decision so far: a shared master token only **warns** (no block).

Multiple instances already exist (registry, per-instance runtime, credentials, RCON, B3, logs). Block 17 does not rebuild that. It closes the remaining cross-contamination gaps and proves the roadmap gate:

> Three parallel servers (28960, 28961, 28962) without cross-contamination: PASS

## Goal and success criteria

- Two instances can never point their B3 at the same MySQL database by accident.
- A master token or RCON password shared by two instances is shown as a warning, never blocks, and never leaks a value.
- A hand-edited `server.cfg` cannot redirect `g_log` / `logfile` outside the instance's own `logs/` directory.
- A gate script proves isolation of three parallel instances (port, home, config, RCON, master, plugins, B3, database, logs) and all roadmap error cases.
- Native gate in WSL with the real CoD4x core: three instances start in parallel, answer on their own port and stop independently.

## Already in place (checked in code, 2026-11-07)

| Roadmap item | Mechanism |
|---|---|
| Port | `ServerInstanceStore.create`: unique ID and port (also under concurrent creation), UDP probe via `checkPort` at create and at launch |
| Homepath | derived from the ID only; overlap with BaseGame/Core and junctions rejected (`validatePaths`) |
| Config | `validateManagedConfigText`: only `set/seta/sets`; `fs_*`, `net_ip`, `net_ip6`, `net_port6` blocked; `net_port` must equal the instance port |
| RCON, master token | per-instance vault records, handed over per start via `withRuntimeCredentials` |
| Plugins, B3, logs | under the instance home; own `b3.xml`, `b3.db`, runtime state file |
| Processes | ownership by home path and port; per-instance runtime manager and state file; per-instance operation lock |
| Tests | `server-instance-runtime.test.mjs`: two concurrent instances, crash isolation, no stop of a sibling via the same Core path |

## Gaps this block closes

1. **Shared MySQL database for B3 (hard block).** `InstanceB3DatabaseService.save` validates one instance in isolation. Two instances with the same host, port and database would write the same B3 tables.
2. **Shared master token / RCON password (warning).** The vault enforces uniqueness per `(instance, kind)` only.
3. **`g_log` / `logfile` in a raw `server.cfg`.** The config engine restricts `g_log` to `^(?:logs/)?[a-zA-Z0-9_-]+\.log$`, but `validateManagedConfigText` does not, so a file edited on disk can point `g_log` into a sibling home. B3 itself is safe (`gameLogPath` uses the same regex); the game process is not.
4. **No gate and no cross-instance error-case tests** for the roadmap list: port collision, wrong homepath, wrong config, wrong B3 assignment, wrong RCON, wrong master token.

Accepted residual risk, documented and not changed: the legacy single runtime (`/api/runtime/*`) is not in the registry. A home conflict is already blocked (`INSTANCE_LEGACY_HOME_BUSY`); a port conflict is caught only by the UDP probe while the legacy server is running.

## Design

### A. Database target uniqueness

New pure function in `lib/b3-database.mjs`:

```text
databaseTargetKey(settings) -> "<host>:<port>/<database>"
```

- `host` lower-cased; `localhost`, `127.0.0.1`, `::1` and `[::1]` map to one loopback token.
- The user name is not part of the key: another user on the same database still shares the tables.
- Different host names that resolve to the same server cannot be detected. This is a documented limit, not a promise.

Checks (error code `B3_DATABASE_TARGET_SHARED`, details carry only the other instance ID, never settings or passwords):

- **On `save`:** compare against the saved settings of every other instance. Reject.
- **On B3 start** (existing start plan, new blocker): compare against every other instance with `mysqlEnabled`. This catches a database file edited later or a settings change on the other instance.

Enumeration goes through the instance store; the service reads `<home>/b3/database.json` of the other instances through the same `#load` path. A corrupt file of a sibling is skipped for the comparison and does not block this instance.

SQLite needs no check: the file lies in the instance home.

### B. Shared secret warning

In `InstanceCredentialService`, while the vault is unlocked:

- `set(id, 'master' | 'rcon', ...)` compares the new value with the same kind of every other instance (`crypto.timingSafeEqual` on equal-length buffers) and returns `warnings: [{ code: 'MASTER_TOKEN_SHARED' | 'RCON_PASSWORD_SHARED', instances: [<ids>] }]` next to the normal result. The save still succeeds.
- `instanceStatus(id)` adds `sharedWith: [<ids>]` per kind (empty list when unique). While the vault is locked the value is `null` (unknown), never `[]`.
- The audit event for the change gets `sharedWith` (IDs only). No value, no hash, no length is logged or returned.
- UI (`instance-credential-editor.jsx`): a warning line under the field, DE and EN, naming the other instances. Wording for master: a shared token makes the master list show one server for both.

Why a warning: sharing a RCON password across your own servers is a deliberate choice for some operators, and the master only cares about one token per listed server. The operator decides.

### C. Config validator hardening

In `validateManagedConfigText`, for `g_log` and `logfile` reuse the config engine's rules (`g_log` regex above, `logfile` integer 0 to 2). Violations raise `INSTANCE_CONFIG_INVALID`, so launch is blocked before spawn, like the existing `net_port` check. The regex is moved into one shared constant used by both modules, so the two cannot drift apart.

### D. Tests (TDD, written first)

New file `test/multi-server-isolation.test.mjs`, real store and services, fake runtime/UDP from `test/support`:

- two instances with the same MySQL target: second `save` rejected, error names the first instance; case and `localhost` / `127.0.0.1` variants rejected; different database name accepted; start blocker fires when the first instance is enabled afterwards.
- master and RCON duplicate: save succeeds, warning lists the other instance, value never appears in the result, the audit entry or the status; locked vault yields `null`; unique values yield `[]`.
- `g_log "../../other/main/games_mp.log"`, `g_log "/abs.log"`, `logfile 7` in `server.cfg`: launch blocked.
- roadmap error cases between two instances: second create on a taken port, create with a foreign homepath, config with the other instance's `net_port`, B3 plugin / config change on instance 1 leaves instance 2's `b3.xml`, registry revision and state untouched, RCON command for instance 1 is sent to port 1 only, master token provisioning for instance 1 carries only instance 1's value.

Unit tests for `databaseTargetKey` and the shared constant go in the existing `b3-database` and `instance-config` test files.

### E. Gates

**`scripts/verify-4.18.22-multi-server-gate.mjs`** (no real core, runs everywhere, like the 4.18.21 gate):

- three instances 28960 / 28961 / 28962 with fake core and `fake-cod4x-udp`, started with `Promise.all`;
- each fake answers with its own identity; the status of instance N shows only its own PID, port, home, run ID;
- stop of instance 2 leaves 1 and 3 running; crash of 1 leaves 3's state and logs unchanged;
- every roadmap error case from D;
- source wiring checks: blocker code registered, warning code in the message tables, validator uses the shared constant.

**`scripts/verify-4.18.22-multi-server-native.mjs`** (WSL, real CoD4x core 21.x, like the 4.18.20/21 native gates):

- start three instances in parallel, each with a distinct `sv_hostname` and distinct RCON password;
- RCON `status` against each port shows its own hostname;
- instance 1's RCON password is rejected by instance 2 (wrong-RCON error case, real server);
- `/proc/<pid>/cmdline` of each process shows only its own `fs_homepath` and `net_port`;
- stop one instance, the other two keep answering; restart it on the same port;
- B3 with the real eBc-B3 on instances 1 and 2 (SQLite): each `b3.log` shows only its own port, no cross reads.

The native gate cannot run in the cloud session; it is run by Rafiki in WSL and the result is recorded in the build notes.

### F. Release housekeeping (as in 4.18.20 / 4.18.21)

`package.json` and `BUILD_INFO.json` to 4.18.22, `CHANGELOG-4.18.22.md`, `scripts/preflight-4.18.22.mjs` (includes the 4.18.15 to 4.18.21 gates), `scripts/verify-4.18.22-version.mjs`, `scripts/verify-4.18.22-runtime.mjs`, status lines in `DEVELOPMENT_STATUS.md`, roadmap marker for Block 17.

## Out of scope

- UI redesign for many instances.
- Detecting different host names for the same database server.
- Putting the legacy single runtime into the registry.
- Remote/SSH multi-server (Block 18).

## Open points for review

1. **Intentional shared B3 database.** B3 supports one database for several game servers in a network. The hard block removes that option for now. Alternative: an explicit per-instance setting "share this database" with a confirmation phrase, like `PUBLIC_EXPOSURE`. Proposal: ship the hard block, add the override only if you need it.
2. **RCON password warning.** Included next to the master token because the mechanism is identical. Can be dropped if you only want the master token.
