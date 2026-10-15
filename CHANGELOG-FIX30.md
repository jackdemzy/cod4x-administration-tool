# FIX30 — 4.11.4 Fine-Grained RBAC & Permissions

## Neu
- Permission-Katalog für Installation, Updates, Serververwaltung, Konfiguration, Secrets, Diagnostics und Audit
- Rollen `admin`, `operator`, `auditor`, `viewer`
- zentrale Rollenvalidierung und Permission-Auflösung
- Permission-Middleware für die nachfolgenden Authorization-Bindings
- Session-Rollen werden für RBAC ausgewertet
- `GET /api/rbac/roles`
- `GET /api/rbac/me`
- `POST /api/rbac/check`
- RBAC-Checks werden im Audit-Trail erfasst
- neue RBAC-Matrix im Control Panel
- Session-/Permission-Anzeige und direkte Permission-Prüfung in der UI

## Rollenmodell
- `admin`: alle definierten Permissions
- `operator`: Installation, Updates, Serververwaltung, Konfiguration, Diagnostics
- `auditor`: Diagnostics, Audit
- `viewer`: Diagnostics, Audit

## Sicherheit
- RBAC-Endpunkte erfordern eine gültige Authentifizierung.
- Unbekannte Permissions werden abgewiesen.
- Nicht erlaubte Permissions liefern HTTP 403.
- Session-Rolle und Benutzername werden für RBAC-Entscheidungen aus der aktiven Session verwendet.
- Dieser Block definiert die granularen Berechtigungen; die verbindliche Zuordnung der Permissions zu den sensiblen Fach-Endpunkten folgt in 4.11.5.

## Erhalten
- 4.10.x Logging/Audit/Hardening
- 4.11.0 Configuration & Policy Engine
- 4.11.1 Configuration Profiles
- 4.11.2 Secrets & Credential Vault
- 4.11.3 Authentication & Access Control
