# COD4X CONTROL 4.17.5

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

1. `preflight-4.17.5` source validation
2. dependency installation (`npm ci` when a lockfile exists, otherwise `npm install`)
3. Vite production build
4. Electron/NSIS Windows installer build

## Remembered login

4.17.5 adds an optional **„Passwort auf diesem Windows-Konto merken“** option on the login screen.

- The plaintext password is never written to disk.
- Electron `safeStorage` is used for credential encryption; on supported Windows configurations this is backed by Windows DPAPI.
- The encrypted credential is stored below the Electron user-data directory.
- The normal bearer session token remains separate and still expires according to the existing session policy.
- If a remembered password becomes invalid, the stored credential is removed and the normal login form is shown again.

## Runtime security retained

The 4.17.4 guarded native `iw3mp.exe` spawn path remains unchanged, including explicit spawn diagnostics, persistent failure state, Verified-Core, SHA-256 fingerprint validation, Steam-aware executable discovery, separated server directory, `shell:false`, and PID verification.
