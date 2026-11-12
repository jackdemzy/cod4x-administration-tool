# WSL-Checkliste: native Tests (Stand 4.18.26)

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
| ☐ | `node scripts/preflight-4.18.27.mjs` | Exit 0, darin `Block 21 recovery gate PASS` und `Security audit gate PASS`, letzte Zeile beginnt mit `4.18.27 source preflight PASS`. Native Prüfungen ohne Voraussetzungen melden `SKIP`, das ist erlaubt. | |
| ☐ | `node --test "test/*.test.mjs"` | `# fail 0`. Cloud-Referenz 4.18.25 (mit laufendem Docker-Daemon): 832 Tests / 825 PASS / 7 SKIP; ohne Docker-Daemon kommen die Tests gegen echtes Docker als SKIP dazu. In WSL sind weniger SKIPs möglich (mehr Linux-Tests laufen), auf Windows mehr. | |

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
| ☐ | Seit 4.18.24 (RCON über SSH, auf dem Server muss `python3` installiert sein: `sudo apt install -y python3`): `RCON password provisioned for this run` | |
| ☐ | `RCON over SSH: serverinfo answers with this server's hostname` und `RCON over SSH: a wrong password is refused` | |
| ☐ | `the private password file is gone after the start` und `the password is not in the core's command line on the server` | |
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
| `RCON password provisioned` FAIL (`rcon: false`) | Der echte Core hat nicht `execing rcon-<runId>.cfg` ausgegeben (andere Meldung oder kein Lesen der Datei). Dann braucht der Abgleich eine andere Zeile – Ausgabe zurückschicken. |
| `REMOTE_RCON_TOOL_MISSING` | Auf dem Server fehlt `python3`. |
| `RCON over SSH … hostname` FAIL mit `RCON_AUTH_FAILED` | Der Core hat das Passwort aus der Datei nicht übernommen (`+exec` liest aus `fs_homepath/main`). |
| `REMOTE_HOST_KEY_*` unerwartet | `sshd` hat einen anderen Host-Key präsentiert als beim Probe (zweiter sshd?). |

---

## 3b. B3-Verwaltung eines Remote-Servers über seine Datenbank (4.18.24)

Voraussetzung: B3 läuft auf dem Server mit MySQL/MariaDB; die Datenbank ist **von diesem PC aus** erreichbar (eigener DB-Benutzer mit `SELECT, INSERT, UPDATE` auf die B3-Datenbank). Achtung: das Passwort geht ohne VPN/Tailscale unverschlüsselt übers Netz. Lokal muss die B3-Umgebung (Python + eBc-B3) eingerichtet sein, weil der Datenbank-Helper dort läuft.

| ☐ | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| ☐ | App → Remote Linux → Server → „Zugangsdaten“: B3-Datenbank-Passwort speichern | „Gespeichert“ | |
| ☐ | „B3 Datenbank“: Host/Port/DB/Benutzer speichern, „Verbindung testen“ | `Verbunden. Schema: COMPLETE`, **B3 Ready** | |
| ☐ | „B3 Administration“: Spieler, Admins, Strafen werden angezeigt | Daten aus der Server-Datenbank | |
| ☐ | Einen Test-Spieler bannen (mit Kick), dann entbannen | Ban in B3 sichtbar, Kick über RCON, Entbannen wirkt | |

## 3c. Docker-Betrieb eines Remote-Servers (4.18.25)

Voraussetzung: Abschnitt 3 ist eingerichtet (sshd, Testschlüssel, Core, BaseGame auf dem Server). Zusätzlich braucht der Server Docker und beim ersten Image-Bau Zugriff auf Docker Hub und die Debian-Paketquellen. Der SSH-Benutzer erreicht Docker entweder rootless (empfohlen) oder über die Gruppe `docker`. **Die Gruppe `docker` ist auf dem Server root-gleich**; das Skript läuft dann nur mit der ausdrücklichen Bestätigung `DOCKER_TEST_CONFIRM=DOCKER_ROOT_EQUIVALENT`.

```bash
# auf dem Server (WSL: Docker Engine in der Distribution, nicht Docker Desktop)
docker info --format '{{.ServerVersion}} {{json .SecurityOptions}}'   # muss als Testbenutzer ohne sudo antworten

# auf dem Steuer-PC, Variablen wie in Abschnitt 3.2
export REMOTE_TEST_ROOT="$HOME/docker-gate"
export DOCKER_TEST_CONFIRM=DOCKER_ROOT_EQUIVALENT    # nur bei docker-Gruppe, nicht bei rootless
node scripts/verify-4.18.25-docker-native.mjs
```

| ☐ | Erwartete PASS-Zeile | Ergebnis |
|---|---|---|
| ☐ | `Docker answers the SSH user` (mit `ROOTLESS` oder `ROOTFUL` und Version) | |
| ☐ | Nur docker-Gruppe: `a docker-group host is not confirmed without the word` | |
| ☐ | `an install as container is refused before the host is confirmed` und `the host is confirmed with the mode it shows` | |
| ☐ | `the runtime image is built from the fixed Dockerfile` und `the host reports the image as present` | |
| ☐ | `Install creates the instance as a container instance` | |
| ☐ | **`Start: the core runs in a container`** (der echte 32-Bit-Core startet im Image) | |
| ☐ | `Health: getinfo answered through the port published on 127.0.0.1 of the server` | |
| ☐ | `Logs: output of the container` | |
| ☐ | `Restart: a new container runs` und `Restart: marker file and server.cfg are unchanged` | |
| ☐ | `Stop: the container is gone` und `Start after stop: running again, files unchanged` | |
| ☐ | `the deployment cannot be switched while the container runs` | |
| ☐ | `Switched to native: the same files run as a process` und `Switched back: a container again, files unchanged` | |
| ☐ | **Letzte Zeile: `Container Restart ohne Datenverlust PASS (real sshd, real Docker, real core)`** | |

Danach: `docker ps -a --filter name=cod4x-` zeigt keinen Container mehr; das Image `cod4x-control-runtime:<hash>` bleibt auf dem Server.

Seit 4.18.25 liest die App die Core-Datei nur noch aus dem Import-Ordner `<Datenverzeichnis>/remote-core-import` (wird in „Remote Linux“ nach „Laden / aktualisieren“ angezeigt): `cod4x18_dedrun` dorthin kopieren und im Formular nur `cod4x18_dedrun` (oder z. B. `21.5/cod4x18_dedrun`) angeben. Die nativen Skripte kopieren `COD4X_CORE` selbst in einen eigenen Import-Ordner.

Von Hand in der App (Remote Linux): beim Host „Docker-Status“ öffnen, bei docker-Gruppe das Wort eintippen und bestätigen, „Image bauen“, einen Server mit Betriebsart „Docker“ installieren, starten, RCON-Konsole und Monitoring prüfen, einen gestoppten Server auf „nativ“ und zurück umstellen.

| Fehlschlag bei | Wahrscheinliche Ursache |
|---|---|
| `Start: the core runs in a container` FAIL, darunter eine `ldd`-Ausgabe mit `not found` | **Hauptverdacht:** dem Image fehlt eine 32-Bit-Bibliothek, die der echte Core braucht (im Image ist nur `libstdc++6` mit Abhängigkeiten). Die `ldd`-Zeilen zurückschicken, dann wird das Dockerfile ergänzt. |
| Start FAIL bei rootless, im Container-Log „Dedicated runtime must not run as root“ o. ä. | Der Core verweigert Benutzer 0 im Container (rootless bildet den SSH-Benutzer auf 0 ab). Ausgabe zurückschicken. |
| `REMOTE_DOCKER_UNAVAILABLE` | `docker info` antwortet dem SSH-Benutzer nicht (Daemon aus, Benutzer nicht in der Gruppe, rootless-Socket nicht gesetzt: `DOCKER_HOST` muss in der nicht-interaktiven SSH-Sitzung gelten). |
| `REMOTE_DOCKER_BUILD_FAILED` | Der Server erreicht Docker Hub oder die Debian-Paketquellen nicht, oder die Plattform `linux/386` läuft dort nicht. |
| `Health … getinfo` bleibt `NO_ANSWER` | Port im Container nicht erreichbar oder der Core bindet nicht an `0.0.0.0`; Ausgabe von `Logs` zurückschicken. |
| Spieler-Adressen falsch (alle gleich) | Rootless Docker mit Standard-Netzwerktreiber; bekannte Grenze, IP-Bans sind dann unzuverlässig. |

---

## 3d. Sicherheitsaudit (Block 20, 4.18.26)

| ☐ | Punkt | So prüfen | Ergebnis |
|---|---|---|---|
| ☐ | Startdatei statt Startargumente (A2-1) | Lokale Instanz mit RCON-Passwort und Master-Token starten (Windows und WSL, echter Core). Konsole zeigt `execing launch-<id>.cfg`, RCON funktioniert, der Master nimmt den Token an, in `main/` liegt danach keine `launch-*.cfg`. Unter Linux zeigt `tr '\0' ' ' < /proc/<pid>/cmdline` keines der beiden Geheimnisse. | |
| ☐ | Desktop-App (A5-1, A6-1) | Windows-App auf frischem Datenordner starten: Admin anlegen, einloggen, RCON-Konsole öffnen, Config speichern (alles muss gehen). Im Update-Manager „GitHub Release ↗“ klicken: öffnet sich im System-Browser, nicht in einem CONTROL-Fenster. Der otpauth-Link verlässt die App nicht. | |
| ☐ | Ordnerrechte Python/B3 unter Windows (A3-5) | `icacls <Python-Ordner>` und `icacls <B3-Ordner>`: Schreibrecht nur für Administratoren, SYSTEM und den CONTROL-Benutzer (nicht „Authentifizierte Benutzer“). | |
| ☐ | Operator ohne Code-Rechte (A1-1, A3-1) | Als Operator einloggen: Core wählen/übernehmen, Plugin installieren und B3-Python setzen werden abgelehnt; Start, Stopp und Konfiguration gehen. | |

## 3e. Wiederherstellungspunkte (Block 21, 4.18.27)

| ☐ | Punkt | So prüfen | Ergebnis |
|---|---|---|---|
| ☐ | Config-Änderung und Plugin-Installation mit echtem Core | Lokale Instanz (Windows und WSL, echter Core): eine Config-Änderung speichern, ein Plugin installieren; im Panel „Wiederherstellungspunkte“ stehen zwei automatische Punkte. Den älteren einspielen (als Admin): `server.cfg` und `plugins/` sind wie vorher, das neue Plugin liegt unter `plugins/.removed/`. Danach startet der Server normal. | |
| ☐ | Plugin-DLL unter Windows | Server gestoppt, Plugin-DLL ersetzen und einen Punkt davor einspielen: die DLL wird ersetzt (keine Sperre, weil gestoppt). Bei laufendem Server wird das Einspielen mit `INSTANCE_RUNTIME_BUSY` abgelehnt. | |
| ☐ | B3-Migration gegen echtes MySQL | Testdatenbank mit B3-Tabellen, Migration mit eBc-Opt-in so stören, dass sie scheitert (z. B. Rechte für CREATE entziehen): die Tabellen sind danach wie vor der Migration, die Sicherung unter `b3/backups/` ist eingespielt. Einen manuellen Punkt mit B3-Datenbank anlegen, Daten ändern, mit Häkchen und `B3-DATENBANK ZURÜCKSETZEN` einspielen: die Daten sind wie zum Punkt. | |
| ☐ | Core wechseln (lokal) | Als Admin einen anderen erlaubten Core wählen: der Server startet mit ihm; den Punkt davor einspielen: wieder der alte Core. Als Operator wird `/core` mit 403 abgelehnt. | |
| ☐ | Remote-Core zurücksetzen | Remote-Server: Core-Update, dann „Core zurücksetzen“: der alte Core und seine Version sind zurück, der Server startet. | |

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
