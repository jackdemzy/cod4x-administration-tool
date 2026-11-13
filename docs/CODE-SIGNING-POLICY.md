# Code signing policy

> Draft for the SignPath Foundation application. It becomes binding once it is linked from the
> project home page (README) and SignPath Foundation has accepted the project.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## What is signed

Only Windows files built from this repository by the GitHub Actions workflow
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on GitHub-hosted runners:

| File | Signed |
|---|---|
| `COD4X CONTROL.exe` (the app inside the installer and the portable build) | yes |
| `COD4X-CONTROL-Setup-<version>-x64.exe` (NSIS installer) | yes |
| `COD4X-CONTROL-Portable-<version>-x64.exe` | yes |
| Electron and Chromium DLLs, third-party files | no (not built by this project) |

Every signing request is approved manually in SignPath for a tagged release (`v<version>`).
The SignPath artifact configurations are in [`.signpath/artifact-configurations/`](../.signpath/artifact-configurations/).

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [jackdemzy](https://github.com/jackdemzy) |
| Approvers | [jackdemzy](https://github.com/jackdemzy) |

Changes from people outside this list are only merged after review by a reviewer.
All members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. The connections it can make are:

- GitHub (`github.com`, `api.github.com`): downloads the user starts (CoD4x server files, plugins,
  eBc-B3) and the update check behind the "check for updates" button.
- The CoD4x master server (`cod4master.cod4x.ovh`): server registration and listing, only for servers the user runs.
- Discord webhooks and Web Push services: only when the user configures alerts.
- Remote Linux hosts over SSH and game servers over RCON: only the hosts the user configures.

There is no telemetry and no automatic upload of data.
