# FIX34 — 4.11.7 Session Management & Security Controls

## Neu
- 30 Minuten Idle-Timeout
- maximale Session-Laufzeit 12 Stunden
- automatische Bereinigung abgelaufener Sessions
- globale Übersicht aktiver Sessions
- Session-ID ohne Offenlegung des Session-Tokens
- einzelne Session widerrufen
- „Alle anderen Sessions abmelden“
- „Alle Sessions abmelden“
- Session-Widerrufe und Logout-All-Aktionen im Audit Trail
- Session-Security-Oberfläche im Audit-Bereich
- Integration in bestehende Authentication-/RBAC-Schicht

## API
- `GET /api/sessions`
- `POST /api/sessions/:sessionId/revoke`
- `POST /api/sessions/logout-all`

## Erhalten
- 4.11.6 User & Role Administration
- 4.11.5 Endpoint Authorization Binding
- 4.11.4 Fine-Grained RBAC
- 4.11.3 Authentication & Sessions
