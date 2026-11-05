# COD4X CONTROL 4.18.17

## Runtime Update

Checked on 2026-11-05 against the [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), the [Electron schedule](https://releases.electronjs.org/schedule), `npm view` and `npm outdated`.

- **Electron 42.11.16 → 45.2.3.**
  - Electron 42 has been end-of-life since 2026-10-20; its last patch was 42.11.18 on 2026-10-21. Electron 45 is supported until about 2027-04-27.
  - The desktop app and the backend run on Electron's own Node (`ELECTRON_RUN_AS_NODE`), and so does the remote gateway since 4.18.16. The Node runtime moves from 24.15 to 24.22.
  - Breaking changes 43–45 checked against `electron-main.cjs` / `electron-preload.cjs`:
    - The preload only uses `contextBridge` and `ipcRenderer.invoke`, so it is unaffected by the removed Node shims in sandboxed preloads.
    - The installer is x64 only, so it is unaffected by the dropped 32-bit builds.
- **Remembered login:** switched to the asynchronous `safeStorage` API (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`), because the synchronous one is deprecated in Electron 45. Values written by the old API decrypt unchanged. When the OS key was rotated (`shouldReEncrypt`), the value is stored again.
- **Node.js for building and testing: minimum 20 → 22.12.**
  - Node 20 has been end-of-life since 2026-04-30, and Electron 45 needs at least 22.12 to install.
  - Recommended: Node 24 LTS, the Node line inside Electron 45.
  - Updated in `package.json` (`engines`), `build.ps1` and the README.
- **CI:** runs on Node 22 and 24. The Node 22 jobs keep their check names.
- **Packages:** express 5.2.1 → 5.3.0, react/react-dom 19.3.0 → 19.3.1, electron-builder 26.15.3 → 26.18.0. All were released at least two weeks ago.
- **Not updated yet:** vite 8.3.6 (released today) and @vitejs/plugin-react 6.2.1 (3 days old).
- **npm audit:** 6 moderate findings, all minimatch inside electron-builder. That is build tooling only and not part of the installed app. The 26.x line has no fix yet.
- **WSL test environment:** it still has Node 18, which has been end-of-life since 2025-04-30. Update it to Node 24 LTS locally.

### Checks

- Gate: `scripts/verify-4.18.17-runtime-update-gate.mjs`.
- Backend, remote gateway, web app and TOTP setup were run on Electron 45's Node (24.22.2).
- The desktop app starts under Xvfb and shows the first-run screen.
- Still open: the Windows installer build and a start from the ASAR package.
