# Assessment of Open Security Alerts (Dependabot)

As of: 2026-10-19 · Branch `control-4.18.11` (4.18.11) · Assessed with `npm audit` (GitHub Advisory Database) against `package-lock.json`, which pins the same dependency versions on `main` and `control-4.18.11`. Dependencies were **not** changed.

On push, GitHub reported 2 alerts on the default branch: 1 high, 1 moderate. `npm audit` lists 9 entries; 7 of them are only packages that inherit these two advisories (`@electron/get`, `app-builder-lib`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`, `global-agent`, `roarr`).

## Overview

| Advisory | Package (installed) | Severity | Patched version | Shipped? | Assessment |
|---|---|---|---|---|---|
| [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) / CVE-2026-93748 | `http-cache-semantics` 4.2.0 | high (CVSS 7.5) | none | no (build only) | not exploitable in this project, risk accepted |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) / CVE-2026-97058 | `sprintf-js` 1.1.3 | moderate (CVSS 5.3) | none | no (build only) | not exploitable in this project, risk accepted |

## Where the packages come from

Both are pulled in exclusively by the installer build tool `electron-builder` (devDependency):

```text
electron-builder 26.15.3
└── app-builder-lib 26.15.3
    └── @electron/get 3.1.0          (downloads Electron binaries during the build)
        ├── got 11.8.6
        │   └── cacheable-request 7.0.4
        │       └── http-cache-semantics 4.2.0
        └── global-agent 3.0.0
            └── roarr 2.15.4
                └── sprintf-js 1.1.3
```

- The application code (`lib/`, `src/`, `installer-server.mjs`, `electron-main.cjs`, `electron-preload.cjs`, `scripts/`) imports none of these packages.
- The only production dependencies are `adm-zip`, `express`, `react`, `react-dom` and `tar`. `npm ls http-cache-semantics sprintf-js --omit=dev` is empty.
- electron-builder does not package devDependencies into the installer. `build.files` contains only `dist/**`, the Electron entry files, `installer-server.mjs`, `lib/**` and `package.json`.

## 1. GHSA-ch52-4w7c-c8xp – `http-cache-semantics` ≤ 4.2.0 (high)

**Issue according to the advisory:** For client requests with `max-stale`, entries of a **shared** cache that were zeroed for security reasons are not validated correctly. An attacker can thereby retrieve cached responses belonging to other users, such as their `Set-Cookie` session data.

**Assessment for COD4X CONTROL:**
- The package only runs while building the installer, when `@electron/get` downloads Electron archives via `got`/`cacheable-request`. There is no shared cache, no other users and no session cookies; the attack path does not exist in this context.
- The shipped application and the CONTROL backend do not contain the package.

**Why no update to 4.3.0:** `http-cache-semantics` 4.3.0 (npm, published 2026-10-04) formally lies outside the range "≤ 4.2.0". A comparison of the npm packages 4.2.0 → 4.3.0, however, shows only two changes: the `Vary` matching (check via `hasOwnProperty`) and an additional returned status value. **The `max-stale` handling is unchanged.** The advisory lists no patched version. An override to 4.3.0 would therefore make the alert disappear without demonstrably closing the vulnerability, so it was deliberately not applied.

## 2. GHSA-hp3w-g68c-fv3c – `sprintf-js` ≤ 1.1.3 (moderate)

**Issue according to the advisory:** Unbounded precision specifiers in format strings are passed unchecked to `toFixed`/`toExponential`/`toPrecision`. Anyone who controls the format string can trigger a `RangeError` this way (denial of service).

**Assessment for COD4X CONTROL:**
- The package only runs during the build. `roarr` (the logger of `global-agent`) uses it to format log messages whose format strings are fixed in code and never come from outside.
- The shipped application and the CONTROL backend do not contain the package.
- `sprintf-js` 1.1.3 is the latest version; no patched version exists. `@electron/get` 4.x also still lists `global-agent` as an optional dependency, so switching would not remove the chain either.

## Why not `npm audit fix`

The dry run (`npm audit fix --dry-run`) would only install older or alpha components of the build tool, including `app-builder-bin 5.0.0-alpha.12`, and would downgrade `@electron/rebuild` from 4.2.0 to 4.0.1. This does not demonstrably fix either vulnerability and puts the installer build at risk. Even the newest `electron-builder` of the 26 line (26.17.0, tag `v26`) still depends on `@electron/get ^3`.

## Resolution and follow-up

- No change to the dependencies.
- Both alerts were dismissed on GitHub on 2026-10-19 by the repository owner (`jackdemzy`) with the reason "Risk is tolerable to this project" (`tolerable_risk`) and a reference to this document: alerts #48 (`http-cache-semantics`) and #49 (`sprintf-js`).
- **Re-assess as soon as** either advisory lists a patched version, `electron-builder` switches to `@electron/get` ≥ 4 without `global-agent`, or the build runs in an environment with a shared HTTP cache or proxy.
- This assessment will be revisited in roadmap block 20 (Security Audit); block 23 (Release) requires a fresh `npm audit`.
