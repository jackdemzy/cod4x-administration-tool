# COD4X CONTROL 4.17.1 — Runtime Gate / Path Resolution Fix

## Fix
- Runtime löst `./server` deterministisch über die verwaltete Installation und bekannte portable Windows-Runtime-Wurzeln auf.
- Runtime-Preflight zeigt das tatsächlich aufgelöste Ziel und alle geprüften Kandidaten.
- Verified-Core liefert konkrete Blockierungsgründe statt einer generischen Meldung.
- Vorhandene CoD4x-Server können nach expliziter Operator-Aktion übernommen werden, wenn `iw3mp.exe` vorhanden ist.
- Bei der Übernahme wird ein COD4X-CONTROL-Manifest mit SHA-256-Fingerprint von `iw3mp.exe` erzeugt. Das ist ein Integritäts-Fingerprint und keine Behauptung über die kryptographische Herkunft der Binärdatei.
- Adoption und Runtime-Blockierungen werden mit Correlation-ID im Audit erfasst.
- `shell:false`, fester Executable-Name, Pfadschutz und PID-Verifikation bleiben erhalten.

## Wichtig
Der Verified-Core-Gate wird nicht abgeschaltet. Ein Start ist weiterhin nur möglich, wenn `iw3mp.exe` vorhanden und der Core verifiziert ist.
