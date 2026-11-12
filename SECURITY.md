# Security Policy

COD4X CONTROL is development source, not a release. It manages game servers, holds RCON passwords and can be reached from a phone, so security reports are welcome and taken seriously.

## Supported versions

Only the latest state of the `main` branch is supported. Fixes are not back-ported to older versions or to copies of the source outside this repository.

## Reporting a vulnerability

Please **do not** open a public issue, pull request or discussion for a security problem.

Report it privately through GitHub instead: **Security → Advisories → Report a vulnerability** in this repository. The report stays visible only to you and the maintainer until a fix is published.

A useful report contains:

- the affected version (`package.json` or the version shown in the app),
- what an attacker can do and what they need for it (network position, account, role),
- steps or a minimal proof of concept,
- whether you have shared it with anyone else.

Do not send real credentials, real server addresses or other people's data. Test only against installations you own.

You can expect a first answer within 7 days. Once the issue is confirmed, a fix is prepared in a private fork where possible and published together with an advisory. You will be credited unless you ask not to be.

## Scope

In scope:

- the CONTROL backend (`installer-server.mjs`, `lib/`) and its admin API on `127.0.0.1:8787`,
- the remote gateway and the phone app (`/remote/`), including login, second factor, sessions, push and the remote actions,
- the credential vault, RCON handling and the B3 integration,
- the Electron desktop app,
- Docker deployment on SSH hosts since 4.18.25 (`lib/docker-commands.mjs`, `lib/remote-container-runtime.mjs`, `lib/docker-image.mjs`): the fixed `docker` command lines, the container restrictions, the identity of a container (ID, name, labels) and the per-host confirmation for the root-equivalent docker group
- remote Linux management over SSH (`lib/ssh-transport.mjs`, `lib/remote-*.mjs`): host-key pinning, the vault-held SSH key, the fixed command list and remote path validation; since 4.18.24 also remote RCON (packet over stdin, private `+exec` password file), the `rmt_<id>` vault subjects and the remote B3 database access.

Out of scope:

- the CoD4x server core, B3 and other third-party software the tool installs or starts; report those to their projects,
- vulnerabilities that need full control of the machine CONTROL runs on,
- findings in development-only dependencies that never reach the shipped app (these are assessed in [`docs/SECURITY-ADVISORIES.md`](docs/SECURITY-ADVISORIES.md)),
- reports from automated scanners without a description of real impact.

## Secrets never belong in this repository

The repository is public. The following must never be committed, pasted into issues, pull requests or comments, or included in screenshots and logs:

- RCON passwords, the CoD4x master token, the B3 database password and the vault passphrase,
- Discord webhook URLs (they work like a password),
- the Web Push (VAPID) private key and push subscriptions,
- TOTP secrets and recovery codes,
- TLS private keys and certificates (`*.key`, `*.pem`),
- `.env` files with real values, API keys and access tokens of any kind,
- real IP addresses, player GUIDs or other personal data from a live server.

At runtime CONTROL keeps these values outside the source tree: secrets in the encrypted credential vault (`credential-vault/`), alert settings and push subscriptions in `0600` files under `config/`, user accounts under `config/`. These folders and file types are listed in `.gitignore` (only the two shipped defaults `config/policy.json` and `config/config-profiles.json` are tracked). Test code uses only public test vectors (for example RFC 8291 Appendix A) and made-up values.

If a secret was committed by mistake, treat it as leaked: revoke or rotate it first (new RCON password, new Discord webhook, new TOTP enrolment), then remove it from the repository. Deleting the file in a new commit is not enough, because it stays in the history.

## Security audit

The 4.18.26 audit (Roadmap Block 20) and its findings, grades and regression tests: [`docs/SECURITY-AUDIT-4.18.26.md`](docs/SECURITY-AUDIT-4.18.26.md). Since then only an administrator may bring code that CONTROL runs (permission `server.code`).

## Development and review

Security depends on how changes are made, not only on reports. Every change to this repository, by a person or by an AI coding agent, follows these rules:

- **Superpowers workflow.** Work with the [Superpowers](https://github.com/obra/superpowers) skills (`/superpowers`): brainstorm and write a plan before code, test-driven development, systematic debugging for failures, and verification before claiming a change is done. Plans and specs go to `docs/superpowers/`.
- **OpenAI Codex code review.** Every pull request is reviewed by the OpenAI Codex code reviewer before it is merged. It runs when a pull request is opened or marked ready; request it again with a comment `@codex review`, and for changes to authentication, the vault, RCON, the remote gateway or anything that handles secrets also `@codex security review`. Each finding is answered: fixed, or explained why it does not apply.
- **No secrets in text.** Commits, pull requests, comments and logs never contain any of the secrets listed above. Scan the diff before every push.
- **English on GitHub.** Commit messages, pull requests, issues and comments are written in English.
- **Green preflight.** `npm run preflight` passes locally and in CI before a pull request is merged.

## Repository protection

The maintainer keeps these GitHub features switched on:

- secret scanning and push protection (Settings → Advanced Security),
- Dependabot alerts,
- private vulnerability reporting.

Every change also runs the source preflight in CI on Windows and Linux.
