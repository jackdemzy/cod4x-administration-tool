# COD4X CONTROL 4.18.25

## Linux Docker deployment (Roadmap Block 19)

Design: `docs/superpowers/specs/2026-11-09-docker-deployment-design.md`, plan: `docs/superpowers/plans/2026-11-09-docker-deployment.md`. A server on an SSH host (Block 18) can now run as a Docker container instead of a process. Roadmap gate: "Container Restart ohne Datenverlust".

### Decisions

- **Where.** Docker runs on Linux hosts reached over SSH. Docker on this PC, Docker Desktop and Compose are not part of this block.
- **One more deployment, not a new kind of server.** A remote instance has `deployment: native | docker` (default `native`; files written by 4.18.24 load unchanged). Install, config, backup, restore, logs, health, RCON, monitoring and phone actions are the same code for both.
- **Image.** CONTROL builds one runtime image per host from a fixed Dockerfile (`lib/docker-image.mjs`): `i386/debian:bookworm-slim` pinned by digest plus `libstdc++6`. The Dockerfile travels over stdin with no build context, so no file of the host can enter the image. The tag carries the hash of the Dockerfile; another Dockerfile is another tag, and an image whose label does not match is reported as outdated. Nothing of the game is in the image.
- **Data.** Bind mounts, no named volumes: the base game and the core directory read-only, the instance directory as the only writable mount. `main`, `zone`, `mods`, `plugins` and `usermaps` stay ordinary directories on the host that SFTP, backups and a native process see the same way.
- **Container.** `--read-only`, a small `tmpfs` at `/tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 1g`, `--restart no`, bridge network, the game port published for UDP and TCP on `127.0.0.1` (or on `0.0.0.0` for a public instance). Rootful Docker runs the core as the SSH user, rootless Docker as user 0 of the user namespace (the SSH user outside).
- **Identity.** A container belongs to an instance by its ID, its name `cod4x-<id>` and the labels `cod4x.control.instance` and `cod4x.control.run`. A container under that name with other labels is never stopped, removed or adopted. Stop and remove go by ID. When Docker cannot be asked, the state is kept and nothing is acted on.
- **Docker access.** Rootless Docker and the `docker` group are both accepted. The `docker` group is equivalent to root on the host: it must be confirmed per host by typing `DOCKER_ROOT_EQUIVALENT`. The stored mode is what the host shows; if it changes later, starts stop with `REMOTE_DOCKER_MODE_CHANGED` until it is confirmed again. Rootless hosts get a note that the server may not see the real source address of players.
- **Start confirmation.** Docker reports a container as running from the moment its process exists. A container must now stay up for one second (`startSettleMs`) before the instance is reported `RUNNING`; a core that ends at once is a failed start (`EXITED_ON_START`) with its output kept.
- **Switching.** A stopped instance can be switched between `native` and `docker`. The switch is refused while the instance runs, while a process or container of the other deployment still exists, or when a foreign container holds the name. No file changes.
- **Commands.** `lib/docker-commands.mjs` is the only place that writes a `docker` command line: fixed words, values through `shellQuote` or a fixed pattern, format templates as constants. A mount path with a comma or a double quote is refused.

### Core import directory (changes Block 18 behaviour)

Until 4.18.24 the install and update of a remote server read the core from any absolute path on the control PC. CodeQL flagged that path (request body to `fs.open`) on this pull request, and the owner decided to confine it. A core is now read only from `<data root>/remote-core-import` (created at start, subfolders allowed). The API field `corePath` takes a name relative to that directory (`cod4x18_dedrun`, `21.5/cod4x18_dedrun`) or an absolute path inside it. Anything else, including `..` and a linked folder that leads out, answers `REMOTE_CORE_OUTSIDE_IMPORT` before any connection. `GET /api/remote-instances` names the directory in `coreImportRoot` and the panel shows it. A manager built without the directory reads no core file.

### New routes (all in the permission map, none offered to the phone gateway)

- `GET /api/remote-hosts/:id/docker` (`diagnostics.read`): mode, version, confirmation, image state.
- `POST /api/remote-hosts/:id/docker/confirm` and `POST /api/remote-hosts/:id/docker/image` (`server.manage`).
- `POST /api/remote-instances/:id/deployment` (`server.manage`); `POST /api/remote-instances` accepts an optional `deployment`.
- Runtime answers carry the container ID shortened to 12 characters.

### Limits

- Docker instances listen on IPv4 only.
- Ports published by Docker bypass `ufw`; a public Docker instance needs the provider's firewall or rules in the `DOCKER-USER` chain.
- With rootless Docker the player source address can be wrong (network driver).
- The output of a container is gone after a stop; `qconsole.log` in the instance directory remains.
- The first image build needs Docker Hub and the Debian mirrors from the host.

### Plan deviations (rulings)

- A public instance is published on `0.0.0.0`, not on loopback plus `publicAddress` (that field is the address the master sees, not a local one).
- The core directory is mounted read-only a second time over `/cod4/home/core`; a real-Docker test showed it was writable through the home mount.
- `tmpfs` at `/tmp`; `containerId` as an optional state key; `docker inspect` answers as one JSON array.
- A running container of the instance that the saved state does not know blocks the start (`REMOTE_DOCKER_CONTAINER_EXISTS`).
- RCON service, monitoring collector and console accept a container ID where they required a pid; without it a Docker instance was offline for RCON and monitoring.
- The install form always offers `docker` (the server refuses an unconfirmed host); the `ufw` note is shown on every Docker instance because the remote panel has no network form.
- Parts of the store and host-service code of plan tasks 3 and 4 were written before their tests.

### Verification

See `DEVELOPMENT_STATUS.md` for the numbers of the last run. The gate (`scripts/verify-4.18.25-docker-gate.mjs`) runs the sequence install, start, marker files, restart, stop, start, switch to native, start, switch back, start with a scripted docker and, where a daemon answers, with a real Docker daemon. `scripts/verify-4.18.25-docker-native.mjs` runs it over a real sshd. All of these used a stand-in core. Not run: a real CoD4x core and base game in the container, rootless Docker, Windows and WSL.
