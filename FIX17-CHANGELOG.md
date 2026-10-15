# FIX17 — 4.10.7 Persistent Logging + zentrale Event-Pipeline

## Implemented

- persistenter NDJSON-Audit-Log unter `config/audit/audit.ndjson`
- zentrale Audit-Pipeline: Events gehen weiterhin in den bounded In-Memory-Log und zusätzlich in die persistente Queue
- serielle Schreibwarteschlange zur Erhaltung der Event-Reihenfolge
- sichere Redaction von Password-/Secret-/Token-/Credential-Feldern
- begrenztes Lesen persistenter Logs (maximal 500 Events pro API-Aufruf)
- `GET /api/audit/persistent`
- `POST /api/audit/persist`
- manuelle Log-Rotation über `POST /api/audit/rotate`
- SHA-256-Checkpoint über `GET /api/audit/checkpoint`
- tolerantes Lesen: einzelne beschädigte NDJSON-Zeilen blockieren nicht den kompletten Log-Zugriff
- neue Persistent-Logs-Oberfläche mit Lesen, Synchronisieren, Rotation und SHA-256-Checkpoint
- bestehende 4.10.6 Audit-API und In-Memory-Retention vollständig erhalten
- Anwendungsversion bleibt 3.0.2 RC1

## Validation

- `node --check installer-server.mjs`: PASS
- ZIP-Struktur: FIX17 als oberster Source-Ordner
- `node_modules`, `dist` und `dist-installer` nicht im Source-ZIP
- vollständiger Vite/Windows-Installer-Build in dieser Umgebung nicht ausgeführt; die lokale Node-Toolchain enthält hier kein verwendbares Vite-Binary
