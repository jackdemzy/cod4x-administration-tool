# COD4X CONTROL 4.18.31 – UI language and overview

Base: 4.18.30 (release candidate, not tagged yet).

## Changes

- **English is the default UI language.** German stays selectable in the main menu (bottom of the sidebar, "EN · English" / "DE · Deutsch") and on the login screen. The choice is stored per computer in `localStorage` (`cod4x.ui.lang`) and sets `<html lang>`.
- **Fixed German-only texts translated** in the admin app: login and first-run screen, users and roles, sessions, production backups, security boundaries, anti-cheat download buttons, config validation messages, RCON and dvar reference descriptions, GSC quick prompts, remote-access error messages, mod preset names. Existing German texts are unchanged.
- **Overview page:** a step-by-step quick start and one card per menu item (Overview, Monitoring, Server Config, Mods, Security, Diagnostics, Runtime, Remote Linux, Audit, RCON Reference, Version Manager, Tools) that says what it is for; a click opens the page. The app now starts on the overview. Text in `lib/overview-guide.mjs`.
- **Remote Linux page** in the look of the other pages: cards per area (connection, hosts, servers, install), labelled field grid, themed buttons, notes, status and error boxes (`.remote-linux` in `src/styles.css`). Fields, texts and actions are unchanged.

## Not changed

- The phone web app (`/remote/`, `lib/remote-app.jsx`) is still German only.
- Backend error texts that the server sends as free text are shown as they come.
- `.github/workflows/release.yml` still lists `scripts/preflight-4.18.30.mjs` in its path filter (left alone to avoid a conflict with the open code-signing PR #59).

## Tests

- `test/ui-language.test.mjs` (new): English default and stored choice, every menu item described in both languages, overview and Remote Linux rendered in both languages, no inline layout styles left on the Remote Linux page.
- `scripts/preflight-4.18.31.mjs` runs it together with `test/remote-hosts.test.mjs`.
