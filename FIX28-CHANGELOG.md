# FIX28 — 4.11.3 Authentication & Access Control

## Neu
- First-Run-Admin-Initialisierung
- Benutzername-Validierung
- mindestens 12 Zeichen für Passwörter
- `scrypt`-Passworthashing
- Timing-Safe-Passwortprüfung
- zufällige 256-bit Session-Tokens
- 30 Minuten Session-Lifetime
- Login / Logout / `me`-Endpoints
- geschützter User-Store mit atomischem Schreiben
- restriktive Dateirechte für den User-Store
- Authentifizierungsereignisse im Audit Trail
- Login-/Initialisierungsoberfläche vor dem Control Panel
- Session-Token wird nur für Authentifizierungs-Endpunkte verwendet

## API
- `GET /api/auth/status`
- `POST /api/auth/init`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Sicherheit
- Passwort-Klartext wird nicht persistiert.
- Session-Tokens werden nicht im Audit-Log geschrieben.
- Fehlgeschlagene Logins erzeugen nur Benutzername-Metadaten, niemals Passwortdaten.
- Dieser Block etabliert Authentication & Sessions; die verbindliche Autorisierung sensibler Endpunkte folgt im Audit-Block 4.11.5.

## Erhalten
- 4.10.x Logging/Audit/Hardening
- 4.11.0 Configuration & Policy Engine
- 4.11.1 Configuration Profiles
- 4.11.2 Secrets & Credential Vault
