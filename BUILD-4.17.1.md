# COD4X CONTROL 4.17.1

## Build

Windows PowerShell from this folder:

```powershell
.\build.ps1
```

or:

```cmd
build.cmd
```

The build script performs the 4.17.1 preflight, installs dependencies, builds Vite, and creates the NSIS installer.

## Runtime Gate Fix

- `./server` is resolved against the managed installation plus deterministic portable Windows runtime roots.
- Runtime preflight exposes the resolved target and candidate paths.
- Verified-Core failures now report concrete reasons.
- Existing `iw3mp.exe` installations can be explicitly adopted. Adoption writes a local manifest containing the selected CoD4x version and an SHA-256 fingerprint of `iw3mp.exe`.
- The Verified-Core gate is not disabled.
- Native launch remains `iw3mp.exe` with `shell:false`.
- Stop remains PID-verified before `taskkill.exe`.
