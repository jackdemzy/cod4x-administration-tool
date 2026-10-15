# COD4X CONTROL 4.17.5

## Remembered Login / Windows Credential Protection

### Changes

- Added optional **„Passwort auf diesem Windows-Konto merken“** login checkbox.
- Added Electron `safeStorage` integration for encrypted password storage.
- Added preload IPC for reading, storing, and clearing remembered credentials.
- Added one-shot automatic login at application startup when a remembered credential exists.
- Invalid remembered credentials are automatically discarded instead of being retried indefinitely.
- Explicitly avoids plaintext password persistence.
- Existing session tokens remain separate from the remembered password and continue to use the existing backend session lifetime.
- Extended the 4.17.5 preflight with remembered-login / safeStorage checks.
- Retained the 4.17.4 runtime spawn-error guard and all existing Verified-Core/runtime security boundaries.

### Packaging fix

The source archive for this release is packaged with a correctly named single top-level release directory instead of an internal work directory name.
