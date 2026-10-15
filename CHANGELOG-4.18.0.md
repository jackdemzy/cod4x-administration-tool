# COD4X CONTROL 4.18.0

## Dedicated Server Core Foundation

4.18.0 beginnt den geplanten Architekturumbau von der bisherigen Client-Runtime (`iw3mp.exe`) zur echten CoD4X Dedicated-Server-Runtime.

### Neu

- Login-UI korrigiert: Die Option **„Passwort auf diesem Windows-Konto merken“** wird im normalen Login-Modus jetzt explizit angezeigt. Wenn Windows Secure Storage nicht verfügbar ist, bleibt die Option sichtbar, wird deaktiviert und zeigt den tatsächlichen Status statt die Funktion still auszublenden.

- `SERVER_CORE_DEFINITIONS` mit expliziten Plattformen:
  - Windows → `cod4x18_dedrun.exe`
  - Linux → `cod4x18_dedrun`
- Dedicated-Core Discovery für Windows- und Linux-Core-Namen
- Plattformgebundene Core-Pfadvalidierung
- Plattformgebundene SHA-256-/Manifest-Verifikation
- Manifest muss den tatsächlich erwarteten Dedicated-Core referenzieren
- Runtime-State enthält die Serverplattform
- UI besitzt eine explizite Server-Plattformauswahl
- UI benennt den verwalteten Core als Dedicated Server Core
- Linux-Core kann bereits gefunden, ausgewählt, übernommen und verifiziert werden
- Linux Runtime Start bleibt bis Block 5 bewusst gesperrt

### Bewusst beibehalten

- `shell:false`
- PID-Verifikation
- `tasklist.exe`
- kontrolliertes `taskkill.exe`
- Verified-Core-Gate
- SHA-256-Fingerprints
- `fs_basepath` / `fs_homepath` Trennung
- Runtime-State und Runtime-History
- Audit / Correlation IDs
- remembered login / Electron safeStorage
- bestehende Path Guards

### Bewusst nicht enthalten

- Linux Runtime Start/Stop
- Server Instance Manager
- Master Server / Token
- B3 / eBc-B3
- Multi-Server UI
- Remote SSH
- Docker

Diese Funktionen folgen gemäß Roadmap in späteren Blöcken.
