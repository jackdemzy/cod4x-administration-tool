# 4.16.9 — Backup Lifecycle & Retention Governance

## Neu
- Lifecycle-Prüfung für Production Backups
- getrennte Retention-Grenzen für normale Backups und Pre-Restore-Safety-Snapshots
- maximale Gesamtzahl weiterhin 50 Backups
- Lifecycle-Prüfung erkennt überzählige Backups und verwaiste Backup-Dateien
- sichere, scoped Bereinigung ausschließlich innerhalb des Backup-Verzeichnisses
- Safety-Snapshots werden als eigene Lifecycle-Klasse behandelt
- atomare Registry-Aktualisierung vor der Bereinigung
- Audit-Ereignisse für Prüfung, Bereinigung und Fehler

## API
- `GET /api/backups/lifecycle`
- `POST /api/backups/lifecycle/cleanup`

## Retention
- normale Backups: maximal 40
- Safety-Snapshots: maximal 10
- Gesamt: maximal 50
- ältere Einträge innerhalb der jeweiligen Klasse werden zuerst entfernt
- verwaiste `.json`-Dateien im sicheren Backup-Verzeichnis werden bei einer expliziten Bereinigung entfernt

## Erhalten
- 4.16.5 Production Backup Registry
- 4.16.6 SHA-256 Backup Integrity
- 4.16.7 Integrity-Gated Restore
- 4.16.8 Registry Consistency Gate
- Auth / RBAC / Session Security
