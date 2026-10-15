# FIX29 — 4.11.3 Authentication & Access Control Hotfix

## Fehler behoben
- First-Run-Admin-Initialisierung schlug beim Speichern mit `Ungültiger Benutzer-Datensatz` fehl.
- Ursache: Der erzeugte scrypt-Hash enthält im vierten Feld die Parameter `N...r...p...`; die Validierung erwartete dort fälschlich ausschließlich Hex-Zeichen.
- Die User-Store-Validierung akzeptiert jetzt das tatsächlich erzeugte scrypt-Format.

## Erhalten
- FIX28 Authentication & Access Control
- scrypt-Passworthashing
- Timing-Safe-Passwortprüfung
- 30 Minuten Session-Lifetime
- Login / Logout / `me`
- geschützter User-Store
- Audit-Events
