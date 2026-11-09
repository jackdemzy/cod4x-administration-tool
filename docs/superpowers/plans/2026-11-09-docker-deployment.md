# Linux Docker deployment (Block 19, 4.18.25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote instance (Block 18) can run its CoD4x core inside a disposable Docker container on the SSH host, with all data in the instance home, and a stopped instance can be switched between `native` and `docker`.

**Architecture:** The remote instance record gets `deployment: 'native' | 'docker'`. `RemoteInstanceManager` keeps its process code untouched and dispatches start, identify, stop, recover and output reading to a new container runtime module when the deployment is `docker`. Every `docker` command line is built in one module from fixed words and quoted values; the image comes from one constant Dockerfile built on the host without a build context.

**Tech Stack:** Node ≥ 22.12 ESM, `ssh2` (existing), `node:test`, React panels; Docker Engine (rootless or rootful) on the remote host. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-09-docker-deployment-design.md`

## Global Constraints

- Core file name is exactly `cod4x18_dedrun`; versions 21.2 to 21.5; SHA-256 checked before every start.
- Network default is loopback. No secret in a command line, label, environment variable, audit entry, log or API result. The RCON password keeps its Block 18b path (private file in `main/`, swept after start).
- Error codes are `REMOTE_DOCKER_*` constants or existing `REMOTE_*` / `INSTANCE_*` codes.
- Only `lib/docker-commands.mjs` builds a `docker` command line. Only `lib/remote-commands.mjs` builds other remote commands.
- Native remote instances behave as before: no existing test file is edited to make it pass, only extended.
- Version 4.18.25; the 4.18.24 gates stay in the preflight chain. Tests run as a non-root user with `umask 022`.
- Fixed values: container name `cod4x-<instanceId>`; labels `cod4x.control.instance`, `cod4x.control.run`, image label `cod4x.control.dockerfile`; mount targets `/cod4/base` (ro), `/cod4/core` (ro), `/cod4/home` (rw); base image `i386/debian:bookworm-slim@sha256:abd54731664e83f582c92db7581fb65a7bb81498c8b7001101844301bf6efe36` (index digest pulled from Docker Hub on 2026-11-09); stop grace 10 s; `--pids-limit 256`; `--memory 1g`.

## Review Focus

1. A container named `cod4x-<id>` with foreign or missing labels exists: start, stop, restart, recover and switch never stop, remove or adopt it (`INSTANCE_PROCESS_IDENTITY_BLOCKED`). Test in Task 5.
2. The SSH connection drops after `docker run` was sent but before the ID came back: the state is `recoveryBlocked`, `recover` adopts the container only when its run label equals the saved `runId`, and a second start never creates a second container. Test in Task 5.
3. A state file written by 4.18.24 (no `containerId`) and an instance list without `deployment` load as `native` with `containerId: null`; a state with both a `pid` and a `containerId` is refused. Tests in Task 3.
4. `docker` is missing, the daemon is down, or the user may not use it: probe answers `NO_DOCKER` with a named code, and no install, switch or start gets further. Tests in Tasks 1 and 4.
5. Host paths with `,`, `"`, spaces, `$()`, quotes or newlines: refused (`REMOTE_DOCKER_PATH_UNSUPPORTED` / `REMOTE_PATH_INVALID`) or inert in the command. Tests in Task 1.
6. `docker logs` returns megabytes, binary bytes or invalid UTF-8: the result is bounded, valid text. Test in Task 5.
7. A switch requested while the instance is `STARTING`, `RUNNING`, `STOPPING` or `recoveryBlocked` is refused and changes nothing. Test in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/docker-commands.mjs` (new) | Every `docker` command line and the parsers of their output. Pure. |
| `lib/docker-image.mjs` (new) | The Dockerfile text, its SHA-256 and the image tag. Pure constants. |
| `lib/remote-container-runtime.mjs` (new) | Launch, identify, stop, find and read output of one instance's container over a session. |
| `lib/remote-host-store.mjs`, `lib/remote-host-service.mjs` | `docker` entry of a host, probe, confirmation, image build. |
| `lib/remote-instance-store.mjs`, `lib/remote-runtime-state.mjs` | `deployment` field; `containerId` in the saved state. |
| `lib/remote-instance-manager.mjs` | Dispatch by deployment; install with deployment; `setDeployment`. |
| `lib/remote-linux-routes.mjs`, `lib/remote-hosts.jsx` | API routes and UI. |
| `test/support/docker-fixture.mjs` (new) | Scripted fake Docker for the loopback session, and a real-Docker availability check. |

---

### Task 1: Docker command builders and parsers

**Files:**
- Create: `lib/docker-commands.mjs`
- Test: `test/docker-commands.test.mjs`

**Interfaces (produces):**
- `containerName(instanceId) -> 'cod4x-<id>'` (throws `REMOTE_ARGUMENT_INVALID` unless `validRemoteInstanceId`)
- `dockerProbeCommand() -> string`; `parseDockerProbe({ code, stdout }) -> { mode: 'NO_DOCKER' | 'ROOTLESS' | 'ROOTFUL', version: string | null }`. Command: `docker info --format '{{.ServerVersion}} {{json .SecurityOptions}}'`. Non-zero exit or unparsable output is `NO_DOCKER`; `name=rootless` among the security options is `ROOTLESS`.
- `imageInspectCommand(tag)`; `parseImageInspect({ code, stdout }) -> { id: 'sha256:<64 hex>', dockerfile: string } | null` (null when the image does not exist).
- `imageBuildCommand({ tag, dockerfileSha256 }) -> string`: `docker build --quiet --tag <tag> --label cod4x.control.dockerfile=<hash> -` (Dockerfile arrives on stdin; `-` means no context).
- `runContainerCommand({ instanceId, runId, image, user, basePath, home, port, publish, args }) -> string` where `user` is `'<uid>:<gid>'` or `'0:0'`, `publish` is a non-empty array of IPv4 addresses, `args` are the core arguments. Fixed flags in this order: `run --detach --name --label --label --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --restart no --network bridge --user --workdir /cod4/base --mount ...x3 --publish <addr>:<port>:<port>/udp --publish <addr>:<port>:<port>/tcp <image> /cod4/core/cod4x18_dedrun <args>`.
- `parseContainerId(stdout) -> string` (`^[a-f0-9]{64}\n$`, else `REMOTE_DOCKER_START_FAILED`)
- `inspectContainerCommand(ref)` (`ref` is a 64-hex ID or a `containerName`); `parseContainerInspect({ code, stdout, stderr }) -> { id, name, instance, run, image, status, exitCode, oomKilled } | null`. `null` only for exit 1 with `No such` in stderr (run with `LC_ALL=C`); any other failure throws `REMOTE_DOCKER_INSPECT_FAILED`.
- `stopContainerCommand(id, graceSeconds)`, `removeContainerCommand(id)` (IDs only, 64 hex), `containerLogsCommand(id, stream, bytes)` with `stream` `'stdout' | 'stderr'` and `1 <= bytes <= 1048576` (pipes `docker logs` into `tail -c`).
- `assertDockerMountPath(path) -> path` (`assertRemotePosixPath` plus no `,` and no `"`, else `REMOTE_DOCKER_PATH_UNSUPPORTED`).

- [ ] **Step 1: Write the failing tests** in `test/docker-commands.test.mjs`:
  - `runContainerCommand` for a normal instance equals one exact expected string (pin the whole line).
  - No builder output contains `--privileged`, `--network host`, `docker.sock`, `-e `, `--env`, `-v ` or `--volume`.
  - Hostile values: instance IDs `a;b`, `a b`, `$(x)`; paths with `,`, `"`, newline, `..`; `runId` not a UUID; port 0 and 70000; publish address `0.0.0.0; rm -rf /`; a container ref that is neither ID nor name. Each throws the named code.
  - An argument with spaces, quotes and `$()` appears single-quoted and unchanged after `sh -c 'printf %s\\n "$@"' sh <args>` (run locally, as `test/remote-commands.test.mjs` does).
  - `parseDockerProbe`: rootless sample, rootful sample, exit 127, exit 1 with daemon error, garbage.
  - `parseContainerInspect`: running sample, exited with code 137 and OOM, `No such object`, garbage (throws).
- [ ] **Step 2:** Run `node --test test/docker-commands.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `lib/docker-commands.mjs`. `--format` templates are module constants; inspect prints one line of fields joined by a tab using `{{json ...}}` per field so values cannot break the framing.
- [ ] **Step 4:** Run the test file. Expected: PASS.
- [ ] **Step 5:** Commit `feat(docker): command builders and parsers for the container runtime`.

### Task 2: The image definition

**Files:**
- Create: `lib/docker-image.mjs`
- Test: `test/docker-image.test.mjs`

**Interfaces (produces):** `DOCKERFILE` (string), `DOCKERFILE_SHA256` (64 hex of the UTF-8 text), `IMAGE_TAG` (`cod4x-control-runtime:<first 16 hex>`).

Dockerfile content, exactly:

```dockerfile
FROM i386/debian:bookworm-slim@sha256:abd54731664e83f582c92db7581fb65a7bb81498c8b7001101844301bf6efe36
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
USER 65534:65534
WORKDIR /cod4/base
```

- [ ] **Step 1: Write the failing test:** the `FROM` line matches `^FROM i386/debian:bookworm-slim@sha256:[0-9a-f]{64}$`; there is no `ADD`, `COPY`, `ENTRYPOINT`, `CMD`, `ENV` or `ARG` line; `DOCKERFILE_SHA256` equals the hash computed in the test; `IMAGE_TAG` equals `cod4x-control-runtime:` plus its first 16 characters.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(docker): pinned runtime image definition`.

### Task 3: Stores: `docker` on a host, `deployment` on an instance, `containerId` in the state

**Files:**
- Modify: `lib/remote-host-store.mjs`, `lib/remote-instance-store.mjs`, `lib/remote-runtime-state.mjs`
- Test: `test/remote-host-store.test.mjs`, `test/remote-instance-store.test.mjs`, `test/remote-runtime-state.test.mjs` (add cases)

**Interfaces (produces):**
- Host record gains `docker: null | { mode: 'ROOTLESS' | 'ROOTFUL', confirmedAt: ISO string }`. `RemoteHostStore.setDocker(id, docker | null) -> host`. A stored host without the key loads with `docker: null`.
- `RemoteInstanceStore.definition(input)` accepts an optional `deployment` (`'native'` default, else `REMOTE_INSTANCE_INVALID`); for `'docker'` it runs `assertDockerMountPath` on `home` and `basePath`. `setDeployment(id, deployment) -> instance`. A stored instance without the key loads as `'native'`.
- State gains `containerId: null | 64-hex string`. A stored state without the key reads as `containerId: null`. `pid` and `containerId` both non-null is `REMOTE_STATE_INVALID`. `IDLE` in the manager gets `containerId: null`.

- [ ] **Step 1: Write the failing tests:** round trip of each new field; files written by the current code (fixtures without the new keys) load with the defaults; invalid values (`mode: 'ROOT'`, `deployment: 'podman'`, `containerId: 'abc'`, both identities set, a docker instance whose `remoteRoot` contains a comma) are refused with the named codes.
- [ ] **Step 2:** Run the three test files, expect the new cases to FAIL. **Step 3:** Implement. **Step 4:** Run the three files plus `test/remote-instance-runtime.test.mjs` and `test/remote-instance-install.test.mjs`; expect PASS with no edit to existing cases.
- [ ] **Step 5:** Commit `feat(docker): deployment, host docker entry and container id in the stores`.

### Task 4: Host service: probe, confirmation, image build

**Files:**
- Modify: `lib/remote-host-service.mjs`
- Create: `test/support/docker-fixture.mjs`
- Test: `test/remote-host-docker.test.mjs`

**Interfaces:**
- Consumes: Task 1 builders, Task 2 constants, `RemoteHostStore.setDocker`.
- Produces on the host service:
  - `DOCKER_ROOTFUL_CONFIRMATION = 'DOCKER_ROOT_EQUIVALENT'` (exported).
  - `dockerStatus(hostId) -> { mode, version, confirmed: boolean, image: 'PRESENT' | 'MISSING' | 'OUTDATED' | null, note: 'ROOTFUL_ROOT_EQUIVALENT' | 'ROOTLESS_SOURCE_ADDRESS' | null }` (`image` is null when `mode` is `NO_DOCKER`).
  - `confirmDocker(hostId, { confirm }) -> host`: probes; `ROOTLESS` stores `{ mode, confirmedAt }` without a phrase; `ROOTFUL` needs `confirm === DOCKER_ROOTFUL_CONFIRMATION`, else `REMOTE_DOCKER_CONFIRMATION_REQUIRED`; `NO_DOCKER` is `REMOTE_DOCKER_UNAVAILABLE`.
  - `buildDockerImage(hostId) -> { tag, id }`: needs a confirmed host (`REMOTE_DOCKER_NOT_CONFIRMED`), sends `DOCKERFILE` on stdin with a 10 minute timeout, then inspects; a failed build is `REMOTE_DOCKER_BUILD_FAILED` (the audit entry carries the exit code only).
  - `assertDockerReady(session, host) -> { mode, imageId }` for the manager: the probe mode must equal `host.docker.mode` (`REMOTE_DOCKER_NOT_CONFIRMED` / `REMOTE_DOCKER_MODE_CHANGED`), the image must exist with the label `DOCKERFILE_SHA256` (`REMOTE_DOCKER_IMAGE_MISSING`).
- `test/support/docker-fixture.mjs` produces `installFakeDocker(loopback, { mode }) -> { calls, containers, setMode, breakNext }`: puts a `docker` shell script first in the loopback session's `PATH`. The script keeps containers as JSON files in a temp directory, runs the "core" as a real background process for `run`, and implements exactly `info`, `build`, `image inspect`, `run`, `inspect`, `stop`, `rm`, `logs`. And `realDockerAvailable() -> Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** against the fake Docker: status for the three modes; confirmation with and without the phrase; build then status shows `PRESENT`; an image with another label shows `OUTDATED` and `assertDockerReady` throws; mode changed after confirmation throws `REMOTE_DOCKER_MODE_CHANGED`; no `docker` on the host gives `NO_DOCKER` and every other call the named code; build failure leaves no stored change.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement the fixture, then the service methods. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(docker): host probe, root-equivalence confirmation and image build`.

### Task 5: Container runtime and dispatch in the manager

**Files:**
- Create: `lib/remote-container-runtime.mjs`
- Modify: `lib/remote-instance-manager.mjs` (`#reconcile`, `#launch`, `#spawnAndConfirm`, `#stopRunning`, `#waitExecuted`, `recover`, `logs`, `updateCore` and the remove path at line 170, `statusAll`)
- Test: `test/remote-docker-runtime.test.mjs` (fake Docker), `test/remote-docker-real.test.mjs` (real daemon, skipped with a reason when `realDockerAvailable()` is false)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces `createContainerRuntime({ session, uid, gid, hostDocker, pollMs, startConfirmMs, stopGraceMs }) ->`
  - `identify(instance, saved) -> 'ALIVE' | 'GONE' | 'NOT_OURS' | 'UNKNOWN'` plus `inspect(ref)`. `ALIVE`: ID equals `saved.containerId`, name, both labels and status `running`. Same ID with status `exited`/`dead`/`created` is `GONE`. Inspect not found is `GONE`. Label or name mismatch is `NOT_OURS`. Inspect failure is `UNKNOWN`.
  - `launch(instance, { runId, args, imageId, publish }) -> containerId`: removes a leftover container of this instance only when its `instance` label matches and it is not running; a foreign container under the name throws `INSTANCE_PROCESS_IDENTITY_BLOCKED`.
  - `stop(instance, saved) -> void`: `docker stop -t 10` on the ID, then `docker rm`; throws `REMOTE_STOP_FAILED` when the container is still running afterwards.
  - `find(instance) -> { id, run, status } | null` for `recover`, by name, labels checked.
  - `readOutput(saved, limit) -> { stdout, stderr, stdoutTruncated, stderrTruncated }`, same text cleaning as `adapter.readOutput`.
  - `exitReason(inspect) -> 'OOM_KILLED' | 'EXITED_<code>' | 'PROCESS_GONE'`.
- In the manager, `deployment === 'docker'` selects the container runtime in the listed methods; `native` runs the unchanged code. Core arguments for Docker: `fs_basepath /cod4/base`, `fs_homepath /cod4/home`, `net_ip 0.0.0.0`, `net_ip6 ::`; `publish` is `['127.0.0.1']` for loopback and `['127.0.0.1', <public IPv4 or 0.0.0.0>]` for a confirmed public network (when the public address is `0.0.0.0`, publish that alone, it includes loopback). User is `<uid>:<gid>` on `ROOTFUL` and `0:0` on `ROOTLESS`. State writes mirror the process path with `containerId` in place of `pid`/`createdAt`.

- [ ] **Step 1: Write the failing tests** (`test/remote-docker-runtime.test.mjs`, fake Docker, using `createRemoteFixture` with a new option `deployment: 'docker'` passed through `install`):
  - start reports `RUNNING` with a `containerId`, `pid: null`; the recorded `docker run` line equals the expected one; no secret in it.
  - stop removes the container; status afterwards is `STOPPED`.
  - restart yields a different `containerId`, and a file the core wrote into `home/players` before the restart is still there with the same bytes.
  - start is refused before any state is written when: image missing, mode changed, host not confirmed, core hash changed.
  - Review Focus 1: a container under the name with foreign labels blocks start, stop, restart and recover and is still present afterwards.
  - Review Focus 2: the session fails on the `docker run` call (`breakNext`); state is `recoveryBlocked`; `recover` adopts when the run label matches and records `STOPPED` when no container exists; a second `start` before `recover` is `REMOTE_RECOVERY_BLOCKED`.
  - The container exits by itself: status becomes `FAILED` with `EXITED_<code>`; with the OOM flag, `OOM_KILLED`.
  - Review Focus 6: `logs` with 2 MiB of binary output returns valid text within the limit, secrets redacted.
  - The RCON file path of Block 18b: with a stored RCON password the run line has `+exec rcon-<runId>.cfg`, and the file is gone after start.
  - `updateCore` and instance removal are refused while the container runs.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement `lib/remote-container-runtime.mjs`, then the dispatch.
- [ ] **Step 4:** Run `node --test test/remote-docker-runtime.test.mjs test/remote-instance-*.test.mjs test/remote-monitor.test.mjs test/remote-rcon-*.test.mjs`. Expected: PASS, existing files unedited.
- [ ] **Step 5: Real-Docker test** (`test/remote-docker-real.test.mjs`): the fake core is compiled with `-static` so it runs inside the 32-bit image; the test image is built from `DOCKERFILE` once. Assertions: install, build, start, the core answers a UDP `getinfo` on `127.0.0.1:<port>`; a file written by the core under `/cod4/home/players` survives restart and survives `stop` + `start`; from inside the container writing to `/cod4/base`, `/cod4/core` and `/` fails; `CapEff` in `/proc/self/status` is all zero; the home files belong to the test user. Run it; expected PASS here, SKIP with the reason `no Docker daemon` elsewhere.
- [ ] **Step 6:** Commit `feat(docker): container runtime for remote instances`.

### Task 6: Install with a deployment, and the switch

**Files:**
- Modify: `lib/remote-instance-manager.mjs` (`install`, new `setDeployment`)
- Test: `test/remote-docker-switch.test.mjs`, `test/remote-instance-install.test.mjs` (add cases)

**Interfaces (produces):**
- `install(input)` accepts `deployment`; for `'docker'` it calls `assertDockerReady`-style checks without the image (probe mode equals the confirmed one) before anything is uploaded.
- `setDeployment(id, { deployment }) -> { instance, previous }`: under the per-instance lock; refuses `REMOTE_INSTANCE_RUNNING` when the saved state is active or `recoveryBlocked`; connects and verifies that no process passes the identity check and that no container named `cod4x-<id>` exists (a stopped one with matching labels is removed; a foreign one is `INSTANCE_PROCESS_IDENTITY_BLOCKED`); to `docker` needs the confirmed, unchanged host mode and mount-safe paths; writes the store, then resets the state to idle; audit `remote.instance.deployment_changed` with `{ from, to }`. Same value as now is a no-op without a connection.

- [ ] **Step 1: Write the failing tests:** install with `deployment: 'docker'` on an unconfirmed host fails before any upload (no file on the loopback server); switch native→docker→native on a stopped instance keeps every file byte-identical and each start runs in the expected runtime; Review Focus 7 (each active status and `recoveryBlocked`); a leftover stopped container of the instance is removed by the switch to native; a foreign container blocks the switch; a switch racing a `start` gets `REMOTE_OPERATION_BUSY`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(docker): install as container and switch a stopped instance`.

### Task 7: Routes, messages and UI

**Files:**
- Modify: `lib/remote-linux-routes.mjs`, `lib/remote-hosts.jsx`
- Test: `test/remote-linux-http.test.mjs`, `test/remote-ui.test.mjs` (add cases)

**Interfaces (produces):**
- `GET /api/remote-hosts/:id/docker` (`diagnostics.read`) → `dockerStatus`.
- `POST /api/remote-hosts/:id/docker/confirm` (`server.manage`) body `{ confirm }`.
- `POST /api/remote-hosts/:id/docker/image` (`server.manage`) → `buildDockerImage`.
- `POST /api/remote-instances/:id/deployment` (`server.manage`) body `{ deployment }`.
- The install route passes `deployment` through. Instance results carry `deployment`; runtime results carry `containerId` shortened to 12 characters, never mount paths beyond what the instance record already shows.
- UI: per host a Docker line (mode, version, image state, the root-equivalence warning with a confirm field that requires typing `DOCKER_ROOT_EQUIVALENT`, the rootless note, a build button); in the install form a deployment choice enabled only for confirmed hosts; per stopped instance a switch control; for a Docker instance the public-network confirmation shows the added sentence that Docker's port rules bypass `ufw`. German and English text for every new code in the message table.

- [ ] **Step 1: Write the failing tests:** each route with the right and the wrong permission; body validation (unknown keys refused); error codes mapped to 4xx with the code only; the UI source test checks that every `REMOTE_DOCKER_*` code used in `lib/` has a German and an English message.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS; `npm run build` succeeds.
- [ ] **Step 5:** Commit `feat(docker): API routes and UI for Docker hosts and instances`.

### Task 8: Gates, version, documents

**Files:**
- Create: `scripts/verify-4.18.25-docker-gate.mjs`, `scripts/verify-4.18.25-docker-native.mjs`, `scripts/verify-4.18.25-version.mjs`, `scripts/verify-4.18.25-runtime.mjs`, `scripts/preflight-4.18.25.mjs`, `CHANGELOG-4.18.25.md`
- Modify: `package.json`, `package-lock.json`, `BUILD_INFO.json`, `build.ps1`, `README.md` (section `## 4.18.25 Docker deployment note`), `DEVELOPMENT_STATUS.md`, `docs/WSL-NATIVE-CHECKLIST.md`, `COD4X-CONTROL-ROADMAP.md` (status line for Block 19)

- [ ] **Step 1:** `verify-4.18.25-docker-gate.mjs`: runs the fake-Docker sequence install → build → start → write marker → restart → compare → stop → start → compare → switch to native → start → compare → switch back, prints one `PASS`/`FAIL` line per step and `Container Restart ohne Datenverlust PASS` at the end. It then runs the real-Docker test file and prints `REAL DOCKER PASS` or `REAL DOCKER SKIP (<reason>)`; a SKIP does not fail the gate but is printed in the summary.
- [ ] **Step 2:** `verify-4.18.25-docker-native.mjs`, modelled on `verify-4.18.23-remote-linux-native.mjs`: takes host, key file, core, BaseGame path from environment variables, runs install → confirm → build → start → `getinfo` → restart → `getinfo` → stop against a real `sshd`, and prints the libraries `ldd` reports missing inside the image if the core does not start.
- [ ] **Step 3:** Version files and `preflight-4.18.25.mjs` (copy of 4.18.24 with the new gate and the new test files added, the 4.18.24 gates kept).
- [ ] **Step 4:** Documents. `DEVELOPMENT_STATUS.md` and the changelog state plainly what ran where: fake gate, real-Docker gate in the cloud container, and that the native gate with the real core has not run. Checklist gets a Docker section (rootless and rootful, player source address before and after, `ufw` note).
- [ ] **Step 5:** As a non-root user with `umask 022`: `npm run preflight` and `node --test "test/*.test.mjs"`. Expected: preflight PASS, `# fail 0`. Record the numbers in `DEVELOPMENT_STATUS.md`.
- [ ] **Step 6:** Commit `4.18.25: Docker deployment gate, version and checklist (Roadmap Block 19)`, push, open the draft PR.
