# Build 4.17.6

## Source build

Run from the project root on Windows:

```powershell
.\build.cmd
```

The build script performs the 4.17.6 preflight, installs dependencies, builds Vite, and creates the Electron/NSIS installer.

## Runtime change

Before `iw3mp.exe` is spawned, the configured server working directory is created if necessary and verified to be a directory. Spawn failures retain the existing backend crash guard and now include executable/cwd diagnostics.
