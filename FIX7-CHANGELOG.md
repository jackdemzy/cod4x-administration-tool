# COD4X CONTROL 3.0.2 RC1 — FIX7

## Mod / FPS Promod block
- Audited `fs_game`, Mod preset, custom mod path and FPS Promod target profile handling.
- Confirmed that the source contains verified explicit Mod presets (`mods/pml220` and `mods/pml220_custom`) and a custom mod path.
- Did not invent an `fs_game` path for FPS Promod 2.85.
- Added explicit UI wording that FPS Promod target profiles do not install/activate a mod by themselves; `fs_game` is populated only from a selected mod preset or custom path.
- Version remains 3.0.2 RC1.

## Verification
- ZIP integrity checked after packaging.
- No node_modules included.
- Windows runtime/build must be tested on the target machine.
