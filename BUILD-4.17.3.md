# COD4X CONTROL 4.17.3

## Build

Requirements:
- Windows
- Node.js 20+
- npm

From the extracted source directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

or:

```powershell
.\build.cmd
```

The build script runs the 4.17.3 preflight before installing dependencies and building the Vite/Electron application.

## 4.17.3 runtime changes

- Server working directory and COD4 game executable are independent settings.
- `iw3mp.exe` may be installed outside the server directory.
- Windows EXE picker added.
- Existing automatic discovery remains bounded.
- Steam installation roots are discovered from the Steam registry and `steamapps/libraryfolders.vdf`.
- Selecting a discovered `iw3mp.exe` persists the executable path without changing the server directory.
- Verified-Core SHA-256 validation applies to the selected executable.
- Runtime starts the selected executable with the configured server directory as its working directory.
- Existing protected-folder manifest registry fallback remains active.
