# Linux Docker deployment (Roadmap Block 19, 4.18.25)

Status: **draft, waiting for Rafiki's review.** Decisions 1 to 4 were made by Rafiki on 2026-11-09; everything under "Design" is the proposal that follows from them. The implementation plan will be `docs/superpowers/plans/2026-11-09-docker-deployment.md` and is written only after this spec is approved.

## Roadmap text (Block 19, copied)

> **Ziel:** Optionaler Containerbetrieb.
>
> **Deployment:** Windows Native, Linux Native, Linux Docker
>
> **Container-Daten:** main, zone, mods, plugins, usermaps, server.cfg, logs
>
> **Grundsatz:** Persistente Serverdaten dürfen nicht ausschließlich im Container liegen.
>
> **Gate:** Container Restart ohne Datenverlust PASS

## Intended outcome

A CoD4x server on a Linux host can run inside a Docker container instead of as a plain process. The container is disposable: it can be removed and created again at any time and the server comes back with the same configuration, maps, mods, plugins, player data and logs. Windows Native and Linux Native keep working exactly as before.

## Decisions (Rafiki, 2026-11-09)

1. **Where Docker runs:** on Linux hosts reached over SSH (the hosts of Block 18). No local Docker and no Docker Desktop in this block.
2. **Image:** CONTROL builds it on the host from a fixed Dockerfile whose base image is pinned by digest. The image holds only the 32-bit runtime libraries. The core is uploaded and SHA-256-checked as in Block 18 and mounted read-only; game files never enter an image.
3. **Docker access of the SSH user:** rootless Docker and membership in the `docker` group are both accepted. CONTROL detects which one a host has. The `docker` group is root-equivalent on that host and needs an explicit confirmation per host; rootless shows a note that player IP addresses may not be preserved.

4. **Switching:** a stopped instance can be switched between `native` and `docker`. Docker Compose and local Docker on the CONTROL PC stay out of this block.

## Design

### Shape: one more deployment of a remote instance

A remote instance (Block 18) gets a field `deployment` with the values `native` and `docker`. Records without the field are `native`, so existing instance lists load unchanged. The directory layout on the host is the same for both values (`main`, `zone`, `mods`, `plugins`, `usermaps`, `players`, `logs`, `core` below the instance home, BaseGame at its own read-only path). Install, core upload and hash check, config read and write, backup and restore, the network confirmation and the host-key policy are reused as they are. Only the part that starts, identifies, stops and inspects the server differs.

That part moves behind a small runtime interface with two implementations: the existing process runtime (`setsid`, PID, `/proc` identity) and a new container runtime. `RemoteInstanceManager` picks one by `deployment`. The deployment is chosen at install and can be switched later (see "Switching the deployment").

### Data stays on the host: bind mounts, no named volumes

The roadmap says "volumes"; this design uses bind mounts of the instance directories, not Docker named volumes. Named volumes would put the data under Docker's own storage, where the existing SFTP-based config editor, backup, log reading and the RCON password sweep cannot reach it, and where removing a volume removes the server. With bind mounts the data lies in the instance home that Block 18 already manages.

| Host path | In the container | Mode |
|---|---|---|
| `<basePath>` (BaseGame: `main`, `zone`) | `/cod4/base` | read-only |
| `<home>/core` | `/cod4/core` | read-only |
| `<home>` | `/cod4/home` | read-write |

The paths inside the container are constants, so the launch arguments (`+set fs_basepath /cod4/base +set fs_homepath /cod4/home ...`) contain no host path. Host paths go into `--mount type=bind,source=...,target=...`; a path containing `,` or `"` is refused for Docker instances (`REMOTE_DOCKER_PATH_UNSUPPORTED`) instead of being escaped.

### Image

- `lib/docker-image.mjs` holds the Dockerfile as a constant: `FROM` a 32-bit Debian slim image pinned by `@sha256:` digest, one `RUN` that installs the C++ runtime library, a fixed non-root default user, no `ENTRYPOINT` that takes input. The digest is looked up at implementation time and written into the source with its source noted.
- The image tag is `cod4x-control-runtime:<first 16 hex of the SHA-256 of the Dockerfile text>`. A changed Dockerfile gives a new tag; the old image is never overwritten.
- Build: `docker build` with the Dockerfile on stdin and **no build context**, so no file of the host can enter the image. The build needs the host to reach the registry and the Debian mirror once. A failed build is `REMOTE_DOCKER_BUILD_FAILED` with bounded, redacted output.
- Before every start CONTROL checks that the image with that tag exists and carries the label `cod4x.control.dockerfile=<full hash>`; otherwise the start stops with `REMOTE_DOCKER_IMAGE_MISSING` and the operator runs the build.
- Known limit, stated openly: the Debian package installed during the build is not pinned to a version. The base image is.

### Host capability and confirmation

A probe (`docker version` and `docker info` with fixed `--format` templates) classifies a host as `NO_DOCKER`, `ROOTLESS` or `ROOTFUL`. The host record gets an optional `docker` entry `{ mode, confirmedAt }`.

- `ROOTFUL`: a Docker instance can be installed only after the operator confirms the exact sentence that the SSH user is root-equivalent on this host through the `docker` group (same pattern as `PUBLIC_EXPOSURE`). The probe is repeated at every start; if the mode differs from the confirmed one, the start stops (`REMOTE_DOCKER_MODE_CHANGED`).
- `ROOTLESS`: no confirmation, but the UI and the API result carry the note that the source address of players can be lost depending on the rootless port driver, which affects IP bans in B3.

### Container

One container per instance, named `cod4x-<instanceId>`, with the labels `cod4x.control.instance=<id>` and `cod4x.control.run=<runId>`. Created with:

- `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, a memory limit, `--restart no`, no `--privileged`, no host network, no Docker socket, no extra devices.
- User: on a rootful host `--user <uid>:<gid>` of the SSH user, so files in the home keep their owner. On a rootless host the container user 0 already is the unprivileged SSH user, so it runs as 0 inside with all capabilities dropped.
- Ports: the game port as UDP and TCP. Always published on `127.0.0.1` of the host, so the existing `getinfo`, `getstatus` and RCON exchanges of Block 18b work unchanged. Published on the public address in addition only when the instance network is `PUBLIC` and confirmed.
- The public confirmation text for Docker instances adds one fact: Docker publishes ports with its own firewall rules, which bypass `ufw`.

### Lifecycle and identity

- **Start:** check image, remove a leftover container of this instance that is not running, `docker run -d`, read back the 64-hex container ID. The run is accepted only when `docker inspect` shows that ID with the expected name, both labels, the expected image ID and state `running`. The state file stores the container ID where the process runtime stores PID and creation time.
- **Stop:** `docker stop` with a fixed grace period (SIGTERM, then SIGKILL by Docker), then `docker rm`. Both act on the stored container ID, never on a name pattern. A container whose labels do not match the stored run is not touched (`INSTANCE_PROCESS_IDENTITY_BLOCKED`, as today).
- **Restart:** stop, remove, run. Every restart therefore creates a fresh container, which is exactly what the gate checks.
- **Status:** from `docker inspect` (state, exit code, OOM flag). An exited container stays until the next start or stop so its exit reason can be read.
- **Dropped SSH connection during start:** the retry finds the container by its name and run label and adopts it only if the labels match the run that was in flight; it never starts a second one, because the name is unique on the host.
- **Logs:** `main/qconsole.log` from the home as today; the core's stdout and stderr through `docker logs --tail` with the same byte bound and text cleaning as other logs.
- **No auto-restart:** `--restart no`. CONTROL owns the lifecycle as for native instances. After a host reboot the server is started from CONTROL.

### Switching the deployment

`setDeployment(id, deployment)` changes the field of an existing instance. The directory layout is the same for both values, so no file is moved or rewritten.

- Allowed only when the instance is `STOPPED` (or `FAILED` with no live process or container) and recovery is not blocked; otherwise `REMOTE_INSTANCE_ACTIVE`. The check and the write run under the same per-instance lock as start and stop, so a start cannot slip in between.
- Before the write CONTROL verifies on the host that nothing of the old deployment is left: no process that passes the identity check, and no container named `cod4x-<id>`. A stopped container of this instance (matching labels) is removed; a container with foreign labels stops the switch (`INSTANCE_PROCESS_IDENTITY_BLOCKED`).
- Switching to `docker` needs the same preconditions as a Docker install: host probe, the `ROOTFUL` confirmation where it applies, and host paths without `,` or `"`. The image is not built by the switch; a missing image is reported at the next start.
- The stored runtime state is reset to idle with the switch, so a PID is never read as a container ID or the other way round.
- The switch is written to the audit log with the old and the new value.

### Command injection

`lib/docker-commands.mjs` is the only module that builds a `docker` command line, under the same rules as `lib/remote-commands.mjs`: fixed words, values through `shellQuote`, IDs and names matched against fixed patterns (container ID `^[a-f0-9]{64}$`, name derived from the validated instance ID), ports as checked integers, `--format` templates as constants. No operator text reaches a `docker` flag.

### Monitoring, RCON, B3

Monitoring, RCON console and the phone actions go through the loopback-published port and need no change beyond tests. B3 stays a process on the host as in Block 18b; it reads the game log from the bind-mounted home. B3 in its own container is not part of this block.

### Not covered by Block 19

Local Docker on the CONTROL PC, Docker Compose, named volumes, auto-restart after a host reboot, B3 in a container, Podman, operator-chosen resource limits (fixed defaults only), image cleanup (old tags stay until removed by hand).

## Global constraints

- Core file name `cod4x18_dedrun`, versions 21.2 to 21.5, checked by SHA-256 before every start as in Block 18.
- Network default is loopback. No secret in a command line, label, environment variable, audit entry, log or API result. The RCON password keeps its Block 18b path (private file in the home, swept after start).
- Error codes are `REMOTE_DOCKER_*` constants or the existing `REMOTE_*` and `INSTANCE_*` codes.
- Version 4.18.25; the 4.18.24 gates stay in the preflight chain. Native remote instances must behave byte-for-byte as before (existing tests stay green unchanged).

## Review focus

1. A container with the right name but foreign labels (created by hand or by another tool) is never stopped, removed or adopted.
2. A restart or a removed container loses nothing: config, player data, logs, mods, usermaps and plugins are identical afterwards.
3. Nothing inside the container can write the core or the BaseGame, and the root filesystem is read-only.
4. Instance IDs, paths and names with quotes, `;`, `$()`, newlines, commas or `..` are refused or inert in every `docker` command.
5. A loopback instance is not reachable from another machine; a public one only after confirmation.
6. The host changes from rootless to rootful (or back) after confirmation: the start stops.
7. The image tag exists but was built from another Dockerfile: the start stops.
8. A switch of the deployment while the server runs, starts or stops is refused, and a switch never leaves a process and a container of the same instance side by side.

## Open risks (each gets a test or the native gate)

- Which 32-bit libraries the core needs exactly is confirmed only with the real core (native gate). The Dockerfile starts with the C++ runtime library.
- Whether the core runs as user 0 inside a rootless container without complaint is confirmed only with the real core.
- Player source addresses under rootless Docker depend on the port driver; the native gate records what Rafiki's host shows.
- UDP port publishing on the same number for two address bindings (loopback and public) is covered by the real-Docker gate.

## Gate

**Container Restart ohne Datenverlust PASS**, in three layers:

1. Fake-transport gate, runs everywhere: install, build, start, restart, stop, logs and the switch in both directions against a scripted Docker.
2. Real-Docker gate, runs wherever a Docker daemon is reachable (it is in the cloud test environment): a stand-in executable in place of the core writes into the home, the container is restarted and removed, the data is compared byte for byte, and the read-only mounts and the dropped capabilities are probed from inside.
3. Native gate, run by Rafiki: real `sshd`, real core and BaseGame, a player joins before and after a restart. Added to `docs/WSL-NATIVE-CHECKLIST.md`.

## Changes during implementation (2026-11-09)

Decided while building, each with a test:

- **Published address.** A PUBLIC instance is published on `0.0.0.0` (which includes loopback), every other instance on `127.0.0.1` only. The design said "loopback plus the public address"; `network.publicAddress` is the address as the master server sees it (it can be a NAT address), not an address of the host. Docker instances listen on IPv4 only.
- **Core read-only through the home.** The core directory lies inside the writable home, so it is mounted a second time, read-only, over `/cod4/home/core`. A real-Docker test showed the core was writable without it.
- **`/tmp`.** The read-only root gets a 16 MiB `tmpfs` at `/tmp` (`noexec`, `nosuid`).
- **State.** `containerId` is an optional key of the saved state, written only for a container run.
- **Unknown running container.** A running container of this instance that the saved state does not know blocks the start (`REMOTE_DOCKER_CONTAINER_EXISTS`); it is never adopted without a matching run label and never stopped.
- **After a failed run.** The exited container and its ID stay until the next start or stop, so its output and exit reason can still be read. After a stop the container output is gone; `qconsole.log` in the home remains.
- **RCON and monitoring.** The shared RCON service, the monitoring collector and the console treat a saved container ID like a pid when they decide whether a server runs. Without that a Docker instance was reported offline.
- **Panel.** The install form always offers `docker` and the server refuses an unconfirmed host. The remote panel has no network form, so the `ufw` sentence is shown on every Docker instance.
