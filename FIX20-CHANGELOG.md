# FIX20 — Local API Connectivity

## Fix
- Electron renderer now addresses the local backend explicitly at `http://127.0.0.1:8787` instead of resolving `/api/*` against `file://`.
- Added local backend CORS headers for the Electron renderer.
- Security Hardening `/api/security/status` is now reachable from the packaged application.
- Existing diagnostics, audit, installer, FPSAC catalog and GSC API calls use the same backend base.
- No application version change: 3.0.2 RC1.
