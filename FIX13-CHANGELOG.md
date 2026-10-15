# FIX13 – NSIS Build Repair

- Hardened `build.ps1` against incomplete `app-builder-lib` installations.
- After `npm ci`, the build now verifies `node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh`.
- If the file is missing, the script reinstalls `app-builder-lib@26.15.3` without modifying package.json.
- The build aborts with a precise diagnostic if the NSIS helper is still missing.
- React/Vite and application code are unchanged.
- Application version remains **3.0.2 RC1**.
