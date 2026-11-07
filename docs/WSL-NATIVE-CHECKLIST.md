# WSL-Checkliste: native Tests (Stand 4.18.23)

Diese Checkliste enthält alles, was die Cloud-Umgebung **nicht** prüfen kann, weil dafür ein echter CoD4x-Core, ein echter `sshd` oder dein Windows-/Handy-Setup nötig ist. Jeder Punkt hat einen genauen Befehl, die erwartete PASS-Zeile und die Frage, was ein Fehlschlag bedeutet.

Ehrlicher Stand vor dieser Checkliste (siehe `DEVELOPMENT_STATUS.md`): Preflight 4.18.23 und die ganze Suite liefen in einem Linux-Container als normaler Benutzer grün (679 Tests: 672 PASS / 0 FAIL / 7 SKIP). **Nie gelaufen** sind: der Drei-Core-Test (4.18.22), der native Remote-Linux-Test (4.18.23), die vollständigen Läufe auf Windows 11 und in WSL für 4.18.22/4.18.23.

Ergebnisse trägst du in die Spalte „Ergebnis“ ein (Datum, PASS/FAIL, Zahlen). Bei FAIL bitte die letzten ~40 Zeilen der Ausgabe zurückschicken.

---

## 0. Voraussetzungen (einmalig)

| ☐ | Schritt | Befehl / Hinweis | Ergebnis |
|---|---|---|---|
| ☐ | WSL-Distribution läuft (z. B. Ubuntu `COD4X-Test`) | `wsl -l -v` in PowerShell | |
| ☐ | **Nicht als root** arbeiten | `id -u` muss etwas anderes als `0` ausgeben | |
| ☐ | Node ≥ 22.12 | `node -v` | |
| ☐ | Repository auf dem neuesten Stand, Branch `ccr-a7aa8618-qxaaf9` (oder `main` nach dem Merge) | `git fetch origin && git checkout ccr-a7aa8618-qxaaf9 && git pull` | |
| ☐ | Abhängigkeiten (inkl. `ssh2`) | `npm ci` | |
| ☐ | `umask` ist 022 (sonst verweigert der Tresor sein Datenverzeichnis, das ist Absicht) | `umask` → `0022`; falls `0002`: `umask 022` | |
| ☐ | CoD4x-Linux-Core vorhanden, Datei heißt genau `cod4x18_dedrun` | z. B. `~/core-21.2/cod4x18_dedrun`, ausführbar | |
| ☐ | Spiel-Basisdateien (`main/` mit `.iwd`, `zone/`) | Besser in das Linux-Dateisystem kopieren (`~/cod4-base`) als `/mnt/c/...` zu nutzen | |

Umgebungsvariablen für alle Core-Tests (Pfade anpassen):

```bash
export COD4X_CORE="$HOME/core-21.2/cod4x18_dedrun"
export COD4X_BASEGAME="$HOME/cod4-base"
```

---

## 1. Volle Suite und Preflight (Zahlen festhalten)

| ☐ | Befehl | Erwartung | Ergebnis |
|---|---|---|---|
| ☐ | `node scripts/preflight-4.18.23.mjs` | Exit 0, letzte Zeile beginnt mit `4.18.23 source preflight PASS`. Native Prüfungen ohne Voraussetzungen melden `SKIP`, das ist erlaubt. | |
| ☐ | `node --test "test/*.test.mjs"` | `# fail 0`. Cloud-Referenz: 679 Tests / 672 PASS / 7 SKIP. In WSL sind weniger SKIPs möglich (mehr Linux-Tests laufen), auf Windows mehr. | |

Notiere `# tests`, `# pass`, `# fail`, `# skipped` und trage sie in `DEVELOPMENT_STATUS.md` („Last run“) ein.

Bedeutung eines Fehlschlags: Ein FAIL hier, das in der Cloud grün war, ist ein Umgebungsunterschied (Pfade, Rechte, Node-Version, Reporter) und genau das, was wir finden wollen. Als root laufen fünf bekannte Tests absichtlich rot („Dedicated runtime must not run as root“).

---

## 2. Drei echte Cores parallel (Block 17, 4.18.22)

```bash
node scripts/verify-4.18.22-multi-server-native.mjs
```

| ☐ | Erwartete Zeilen | Ergebnis |
|---|---|---|
| ☐ | `PASS all three cores answer on their own port` | |
| ☐ | für `multi-1`, `multi-2`, `multi-3`: eigenes Passwort geht, fremde Passwörter werden abgelehnt, Prozess zeigt nur eigenes Home und eigenen Port | |
| ☐ | `PASS three different processes` | |
| ☐ | `PASS stopping multi-2 leaves multi-1 and multi-3 serving` | |
| ☐ | `PASS multi-2 restarts on the same port while the siblings keep running` | |
| ☐ | letzte Zeile: `4.18.22 native multi-server check PASS` | |

Wenn du nur `SKIP native multi-server check: core or base game not found` siehst, stimmen `COD4X_CORE` / `COD4X_BASEGAME` nicht.
Bedeutung eines Fehlschlags: Zwei Instanzen beeinflussen sich (Port, Home, RCON-Passwort) oder der Core startet nicht parallel. Das wäre ein echter Fehler von Block 17, den der Fake-Core nicht zeigen konnte.

---

## 3. Remote Linux über SSH (Block 18, 4.18.23)

Ziel: Install → Start → Stop → Logs gegen einen echten `sshd` mit echtem Core. In WSL geht das gegen `127.0.0.1`, das reicht für den Test der SSH-/Prozessschicht.

### 3.1 sshd und Schlüssel einrichten

```bash
sudo apt update && sudo apt install -y openssh-server
sudo service ssh start

# eigener Testschlüssel (ohne Passphrase; mit Passphrase siehe unten)
ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/cod4x_remote_test"
cat "$HOME/.ssh/cod4x_remote_test.pub" >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys"

# Gegenprobe: Login klappt von Hand
ssh -i "$HOME/.ssh/cod4x_remote_test" -p 22 "$USER"@127.0.0.1 'id -u; uname -sm'
```

| ☐ | Erwartung | Ergebnis |
|---|---|---|
| ☐ | `id -u` ist **nicht** `0`, `uname -sm` ist `Linux x86_64` | |

Hinweis: Der Test verlangt einen Nicht-root-Benutzer. Ein Login als `root` wird absichtlich verweigert.

### 3.2 Lauf

```bash
export REMOTE_TEST_HOST=127.0.0.1
export REMOTE_TEST_USER="$USER"
export REMOTE_TEST_KEY="$HOME/.ssh/cod4x_remote_test"
export REMOTE_TEST_ROOT="$HOME/remote-gate"      # absolut, wird angelegt
# optional: REMOTE_TEST_PORT=22, REMOTE_TEST_KEY_PASSPHRASE=..., COD4X_CORE_VERSION=21.5
node scripts/verify-4.18.23-remote-linux-native.mjs
```

`COD4X_BASEGAME` ist hier ein Pfad **auf dem Server** (gelesen, nie verändert). `COD4X_CORE` ist die Datei auf dem Steuer-PC (sie wird hochgeladen).

| ☐ | Erwartete PASS-Zeile | Ergebnis |
|---|---|---|
| ☐ | `an unpinned host is refused before any login` | |
| ☐ | `the host key can be read without logging in` (mit `SHA256:...`) | |
| ☐ | `trusting a different value pins nothing` | |
| ☐ | `the confirmed host key is pinned` | |
| ☐ | `the login works and the user is not root` | |
| ☐ | Absichtliche Fehler: `a wrong core file name is refused`, `a wrong core hash is refused`, `a base game without main is refused`, `a base game without zone is refused`, `nothing was registered by the failed installs` | |
| ☐ | `Install creates the instance` | |
| ☐ | `a second instance on the same port of that host is refused` | |
| ☐ | `Start: the core runs under its own identity` | |
| ☐ | `Health: process ALIVE and getinfo answered on the server` | |
| ☐ | `Logs: output of this run` | |
| ☐ | `Stop: the process is gone` und `Restart: running again with a new run` | |
| ☐ | `Config: the change is written` und `Restore: the original config is back, byte for byte` | |
| ☐ | `a changed host key stops before login` | |
| ☐ | **Letzte Zeile: `Remote Linux Install -> Start -> Stop -> Logs PASS`** | |

Danach liegt das Testverzeichnis unter `$REMOTE_TEST_ROOT/run-<id>` (wird nicht automatisch gelöscht); prüfe, dass kein `cod4x18_dedrun`-Prozess übrig ist: `pgrep -a cod4x18_dedrun`.

### 3.3 Was ein Fehlschlag bedeutet

| Fehlschlag bei | Wahrscheinliche Ursache |
|---|---|
| Start / `RUNNING` wird nicht erreicht, Status bleibt `STARTING` mit `recoveryBlocked` | **Hauptverdacht:** `/proc/<pid>/...` ist über echtes SFTP nicht lesbar (in den Tests nur emuliert). Dann brauchen wir den Rückfall auf einen begrenzten `head -c`-Befehl. Schick die Ausgabe zurück. |
| `Health ... getinfo` bleibt `NO_TOOL` | Auf dem Server fehlt `bash` mit `/dev/udp` und `python3`. |
| `Health ... getinfo` bleibt `NO_ANSWER` | Core antwortet nicht auf `getinfo` (Port, Bindung `127.0.0.1`, Core noch beim Laden). |
| `REMOTE_BASEGAME_INVALID` bei der echten Installation | Basisdateien unvollständig oder für den Testbenutzer nicht lesbar (`/mnt/c` mit seltsamen Rechten: Dateien nach `~/cod4-base` kopieren). |
| `REMOTE_AUTH_FAILED` | Schlüssel nicht in `authorized_keys`, Rechte von `~/.ssh` zu offen, falsche Passphrase. |
| `REMOTE_HOST_KEY_*` unerwartet | `sshd` hat einen anderen Host-Key präsentiert als beim Probe (zweiter sshd?). |

---

## 4. Manuelle Punkte (kein Skript möglich)

| ☐ | Punkt | So prüfen | Ergebnis |
|---|---|---|---|
| ☐ | Handy-Test 4.18.16–4.18.19 (Fernzugriff, Monitoring, Alarme, Aktionen) | Phone-App über das Gateway öffnen: Login mit zweitem Faktor, Server-Status sichtbar, ein Alarm kommt an, eine Aktion (z. B. Neustart mit Bestätigung) läuft. Prüfe zusätzlich: **Remote-Linux-Server erscheinen nicht** in der Handy-App (absichtlich). | |
| ☐ | Hidden-Chat-Prüfung | Mit einem echten Client verbinden und prüfen, dass der versteckte Chat/Admin-Kanal nicht für normale Spieler sichtbar ist (Details siehe Notizen zu Block 14/16). | |
| ☐ | Eigener B3-Plugin-Befehl mit echtem Client | Eigenes B3-Plugin anlegen, aktivieren, Server starten, den Befehl im Spiel ausführen und im B3-Log sehen. | |
| ☐ | Oberfläche „Remote Linux“ (Block 18) | App starten → Menü „Remote Linux“: Host anlegen → „Host-Schlüssel prüfen“ zeigt Hex und `SHA256:`-Form, „Diesem Schlüssel vertrauen“ erst nach dem Haken aktiv → SSH-Schlüssel speichern (Tresor muss entsperrt sein) → Server installieren → Start/Stop/Logs. Hinweis „RCON und B3 sind für Remote-Server noch nicht verfügbar“ ist sichtbar. | |

---

## 5. Danach eintragen

1. `DEVELOPMENT_STATUS.md`: Zeile „Last run“ mit den echten Zahlen aus Abschnitt 1 und den Ergebnissen aus 2 und 3 aktualisieren (nicht „not run“ stehen lassen, wenn es gelaufen ist, und umgekehrt).
2. `CHANGELOG-4.18.23.md`, Abschnitt „Checks“: den Satz „Not run yet“ beim nativen Remote-Test durch das echte Ergebnis ersetzen.
3. `BUILD_INFO.json`, Feld `notes`: dasselbe.
