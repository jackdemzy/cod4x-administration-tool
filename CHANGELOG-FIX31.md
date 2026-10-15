# FIX31 — 4.11.5 Endpoint Authorization Binding

## Neu
- zentrale Endpoint-Authorization über die bestehende RBAC-Permission-Middleware
- `install.execute` und `update.execute` als kanonische Execution-Permissions, bestehende `installation.manage` / `updates.manage` bleiben kompatibel
- Installation, Updates, Server/RCON, Configuration, Diagnostics und Audit an Permissions gebunden
- `/api/rbac/authorization` für Binding-/Audit-Prüfung
- expliziter Binding-Katalog für geschützte API-Bereiche
- 403 bei fehlender Permission, 401 bei fehlender Session
- Renderer verwendet für API-Aufrufe automatisch das Session-Bearer-Token
- Auth-, Policy-, Security-, Profile-, Audit- und Diagnostics-Funktionen bleiben erhalten

## Sicherheitsmodell
- Public Auth-Endpunkte bleiben ohne Session erreichbar: Status/Init/Login.
- Unbekannte API-Routen werden nicht durch einen globalen Catch-All blockiert.
- Sensitive Endpunkte verwenden die zentrale `requirePermission()`-Middleware.
- Authorization-Entscheidungen werden im Audit-Trail protokolliert.

## API
- `GET /api/rbac/authorization`

## Erhalten
- 4.10.x Logging/Audit/Hardening
- 4.11.0 Configuration & Policy Engine
- 4.11.1 Configuration Profiles
- 4.11.2 Secrets & Credential Vault
- 4.11.3 Authentication & Access Control
- 4.11.4 Fine-Grained RBAC & Permissions
