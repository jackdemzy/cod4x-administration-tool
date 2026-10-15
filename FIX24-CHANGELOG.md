# FIX24 – DVAR Browser Table Layout

## Change
- DVAR Browser table rebuilt as a compact admin-console layout.
- Fixed column separation between Name, Default, Subsystem and Description.
- Wider subsystem column prevents long tags from overlapping descriptions.
- Added horizontal overflow handling for narrower windows.
- Added sticky table header.
- Added compact row height and subtle alternating rows.
- Long DVAR names, subsystem labels and descriptions now truncate cleanly instead of overlapping.
- Duplicate DVAR names remain visible and use a stable row key based on name + index.

## Scope
- UI/layout only.
- CoD4X CONTROL version remains 3.0.2 RC1.
- Existing 4.10.x audit/security/logging functionality is unchanged.
