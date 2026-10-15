# COD4X CONTROL 4.17.2

## Runtime discovery and portable core selection

- Runtime path accepts an explicit absolute Windows path as well as the existing safe relative path mode.
- Added Windows folder picker through the Electron preload bridge.
- Added automatic `iw3mp.exe` discovery across common installation roots and local drive roots with bounded depth/results.
- Added selectable search results so users can adopt a core installed in a different directory or drive.
- Existing Verified-Core gate remains mandatory for launch.
- Existing-core adoption computes and verifies the SHA-256 fingerprint.
- For protected locations such as `Program Files`, the operator-adopted core manifest is also stored in the application's local runtime-core registry when a sidecar manifest cannot be written.
- Verified-Core validation now checks the actual executable SHA-256 against the recorded fingerprint.
- Added audit events for runtime-core discovery.
