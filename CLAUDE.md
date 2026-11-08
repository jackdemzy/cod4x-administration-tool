# Hinweise für Claude

## Antworten

- Antworten auf Deutsch.
- Ehrlich berichten, was gelaufen ist und was nicht (Tests, Gates, native Prüfungen).

## Aussagen über den Repository-Stand

- Bevor du sagst, dass „nichts mehr offen“ ist oder eine Arbeit abgeschlossen ist,
  prüfe offene Pull Requests **und** offene Issues im Repository und nenne sie
  (Nummer, Titel, kurzer Stand). Ohne diese Prüfung keine pauschale Aussage.
- Nach jedem Merge kurz die offenen Issues und PRs auflisten und sagen, welche davon
  schon behoben sind (mit Beleg: Commit oder Codestelle) und welche noch offen sind.
- Issues nur schließen, wenn die Behebung belegt ist.

## Tests

- Tests als Nicht-Root-Benutzer mit `umask 022` ausführen (der Tresor lehnt
  gruppen-beschreibbare Verzeichnisse ab).
- Vor Pull Requests den Preflight der aktuellen Version und die Testsuite laufen lassen.
