# FIX35 — Concurrent Browser Session Test Client

## Neu
- lokale Browser-Testseite unter `/session-test`
- echter zweiter Login gegen denselben COD4X-CONTROL-Backend-Prozess
- Browser-Test-Session verwendet eigenen Local-Storage-Token
- Login / `me` / Logout über die bestehende Authentication-Schicht
- geeignet zum Testen mehrerer gleichzeitiger Sessions ohne zweite Electron-Instanz

## Testablauf
1. COD4X CONTROL normal starten und mit dem Admin angemeldet bleiben.
2. Im Browser `http://127.0.0.1:8787/session-test` öffnen.
3. Mit einem zweiten Benutzer anmelden.
4. In der Haupt-App unter Session Management „Sessions aktualisieren“ ausführen.
5. Beide Sessions müssen sichtbar sein.
6. Browser-Test-Session abmelden und erneut aktualisieren.

## Sicherheit
- Die Testseite erzeugt keine Sonder- oder Bypass-Session.
- Sie verwendet ausschließlich `/api/auth/login`, `/api/auth/me` und `/api/auth/logout`.
- Es werden keine Passwörter gespeichert.
- Die Funktion ist lokal an das bestehende Backend gebunden.
