# COD4X CONTROL 3.0.2 RC1 — FIX4

## Fixed
- Removed an accidental duplicate Anti-Cheat UI block in `cod4x-control-improved.jsx`.
- The duplicate block referenced undefined `antiCheat` / `setAntiCheat` state and caused the renderer to crash at startup.
- Removed a duplicated `MapRotationBuilder` function declaration.
- Version remains 3.0.2 RC1.

## Verification
- The source no longer contains `antiCheat` / `setAntiCheat` inside `ConfigBuilder`.
- The ZIP was integrity-checked after packaging.
- A Windows Electron runtime test must still be performed on the user's Windows machine.
