# COD4X CONTROL 3.0.2 RC1 — FIX5

## Fixed
- Fixed the renderer startup crash `ReferenceError: fpschallengeProfile is not defined`.
- Added missing React state for FPSChallenge profile/version/catalog/loading.
- Added missing state for eBc Promod provider/install settings.
- Added missing state for server-admin integration fields.
- Corrected the RusCOD state setter typo (`setRuscoDMode` -> `setRuscodeMode`).
- Version remains 3.0.2 RC1.

## Verification
- All newly referenced ConfigBuilder state variables now have exactly one React state declaration.
- ZIP integrity verified after packaging.
- Windows runtime must still be tested on the target Windows machine.
