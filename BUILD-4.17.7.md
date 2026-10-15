# COD4X CONTROL 4.17.7

## Purpose

Fix the CoD4X server startup crash observed after 4.17.6 successfully spawned `iw3mp.exe`.

## Root cause addressed

The native process working directory and the CoD4X writable server data directory are different concepts. CoD4X supports separating them with:

- `fs_basepath` = installed game/base directory containing `iw3mp.exe` and base assets
- `fs_homepath` = dedicated per-server writable directory

4.17.7 therefore starts `iw3mp.exe` with its executable directory as the Windows process `cwd`, while explicitly setting the configured server directory as `fs_homepath`.

## Runtime launch layout

```text
Executable:
C:\Program Files (x86)\Activision\Call of Duty 4 - Modern Warfare\iw3mp.exe

Native OS cwd / fs_basepath:
C:\Program Files (x86)\Activision\Call of Duty 4 - Modern Warfare

CoD4X fs_homepath:
C:\Users\<user>\AppData\Roaming\cod4x-control-installer\installations\server
```

The runtime also blocks user-supplied `fs_basepath` and `fs_homepath` overrides so the CONTROL-managed paths cannot be silently replaced by extra arguments.

## Verification performed in this environment

- Node syntax check: `installer-server.mjs` PASS
- Node syntax check: `electron-main.cjs` PASS
- Node syntax check: `electron-preload.cjs` PASS
- `preflight-4.17.7.mjs` PASS
- JSON parsing of `package.json` / `BUILD_INFO.json` PASS
- Static runtime launch-argument/path-separation assertions PASS
- ZIP integrity check PASS

## Build limitation

A full `npm install` / Vite / Electron-Builder build could not be completed in this environment because dependency installation timed out after 180 seconds. No claim is made that the Windows NSIS installer was built here. The source package is build-ready and the existing Windows `build.cmd` / `build.ps1` pipeline remains intact.
