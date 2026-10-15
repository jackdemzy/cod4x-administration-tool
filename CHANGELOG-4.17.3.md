# COD4X CONTROL 4.17.3

## Separated server directory and Steam-aware COD4 executable discovery

- Separates the CoD4x server working directory from the installed `iw3mp.exe`.
- Adds a dedicated COD4 game executable field with Windows file picker.
- Selecting a discovered executable no longer overwrites the server directory.
- Adds persistent runtime executable configuration.
- Adds Steam installation/library discovery through Windows Steam registry locations and `steamapps/libraryfolders.vdf`.
- Steam library roots are included in bounded `iw3mp.exe` discovery.
- Verified-Core SHA-256 validation verifies the selected executable path while the server working directory remains the process working directory.
- Existing protected-folder registry fallback remains supported.
- Runtime audit events include the selected executable path where applicable.
