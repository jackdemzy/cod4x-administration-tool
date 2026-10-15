# COD4X CONTROL 4.17.4

## Windows source build

Requirements:

- Windows 10/11
- Node.js 20+
- npm

Build from PowerShell in the extracted source directory:

```powershell
.\build.cmd
```

The build performs:

1. `preflight-4.17.4` source validation
2. dependency installation (`npm ci` when a lockfile exists, otherwise `npm install`)
3. Vite production build
4. Electron/NSIS Windows installer build

## Runtime fix

4.17.4 specifically hardens native `iw3mp.exe` startup. A Windows process-spawn error is now converted into a controlled runtime failure instead of becoming an unhandled child-process event that can terminate the installer backend.

The runtime records:

- `RUNTIME_SPAWN_FAILED`
- Windows spawn error code
- syscall
- executable path
- runtime working directory
- persistent `FAILED` state
- `runtime.spawn.failed` / `runtime.error` history events

The Verified-Core gate, SHA-256 fingerprint validation, Steam-aware executable discovery, separated server directory, `shell: false`, and PID verification remain enforced.
