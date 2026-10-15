# FIX32 — 4.11.5 Authorization Binding UI

## Neu
- eigene RBAC-Oberfläche für Endpoint Authorization Binding
- Button **Authorization Binding prüfen**
- ruft `GET /api/rbac/authorization` auf
- zeigt PASS/FAIL je Binding-Check
- zeigt Gesamtstatus und Check-Anzahl
- erzeugt dadurch sichtbar `rbac.authorization.checked` im Audit Trail

## Erhalten
- FIX31 Endpoint Authorization Binding
- Authentication / Sessions
- Fine-Grained RBAC
- Configuration & Policy Engine
- Configuration Profiles
- Secrets & Credential Vault
- Logging / Audit / Hardening
