# FIX33 — 4.11.6 User & Role Administration

## Neu
- `user.manage` Permission (nur admin)
- persistenter Multi-User-Store `config/users.json`
- Migration des initialen Admins in den User-Store
- Benutzer anlegen
- Rollen beim Anlegen vergeben
- Rollen ändern
- Benutzer deaktivieren / wieder aktivieren
- Passwort zurücksetzen
- Sessions eines einzelnen Benutzers widerrufen
- deaktivierte Benutzer können sich nicht anmelden
- Benutzeränderungen im Audit Trail
- `/api/users`
- `/api/users/:username`
- `/api/users/:username/revoke`
- eigene Benutzerverwaltung im Audit-Bereich

## Erhalten
- 4.11.5 Endpoint Authorization Binding
- 4.11.4 Fine-Grained RBAC
- 4.11.3 Authentication & Sessions
