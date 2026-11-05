# Fernzugriff und Benachrichtigungen (Block 24b, 24c)

Das Monitoring lässt sich vom Handy oder einem anderen Rechner öffnen. Der Zugang ist nur lesend. Die Admin-API bleibt auf diesem Rechner.

## Empfohlen: über Tailscale

Tailscale ist ein privates Netz zwischen deinen eigenen Geräten. Es öffnet keinen Port im Router.

1. Installiere Tailscale auf dem Server-Rechner und auf dem Handy und melde dich auf beiden mit demselben Konto an.
2. Öffne im Admin-Tool den Tab **Monitoring**, Abschnitt **Fernzugriff**:
   - Richte unter **Zweiter Faktor** eine Authenticator-App ein. Für admin und operator ist das Pflicht.
   - Bewahre die 10 Wiederherstellungscodes sicher auf.
   - Hake unter **Fern-Gateway** „Eingeschaltet“ an, wähle den Modus „Tailscale“ und speichere.
3. Gib unter **Benutzer & Rollen** jedem gewünschten Benutzer **Fern** frei. Für reines Zuschauen genügt die Rolle `monitor`.
4. Führe auf dem Server-Rechner einmal den Befehl aus, den das Admin-Tool anzeigt:

   ```
   tailscale serve --bg --https=443 127.0.0.1:8788
   ```

   Tailscale zeigt danach eine Adresse wie `https://<rechnername>.<tailnet>.ts.net`.
5. Öffne auf dem Handy `https://<rechnername>.<tailnet>.ts.net/remote/` und melde dich an. Mit **Zum Startbildschirm hinzufügen** wird daraus eine App.

Zum Abschalten führst du `tailscale serve --https=443 127.0.0.1:8788 off` aus und nimmst im Admin-Tool den Haken bei „Eingeschaltet“ heraus. Beim Ausschalten enden alle Fern-Sitzungen.

Hinweis: `tailscale funnel` würde das Gateway ins offene Internet stellen. Das ist nicht vorgesehen (siehe Block 24c).

## Heimnetz (LAN) mit eigenem Zertifikat

Wähle den Modus „Heimnetz“ und trage die LAN-Adresse des Rechners sowie die Pfade zu Zertifikat und Schlüssel (PEM) ein. Ohne Zertifikat startet das Gateway nur auf 127.0.0.1.

## Öffentliche Domain hinter Caddy (optional, ab 4.18.18)

Nur nötig, wenn das Monitoring ohne Tailscale aus dem Internet erreichbar sein soll. Tailscale bleibt die sicherere Wahl.

1. Lege bei deinem DNS-Anbieter einen A- oder AAAA-Eintrag an, z. B. `monitor.example.org`, der auf die öffentliche IP des Server-Rechners zeigt.
2. Gib im Router und in der Firewall die Ports **80** und **443** frei (80 braucht Let's Encrypt für das Zertifikat).
3. Installiere [Caddy](https://caddyserver.com/docs/install) auf dem Server-Rechner.
4. Wähle im Admin-Tool unter **Fern-Gateway** den Modus „Öffentliche Domain hinter Caddy“, trage die Domain ein und speichere. Das Admin-Tool zeigt danach die passende Caddyfile an. Die Vorlage liegt auch in `docs/Caddyfile.example`.
5. Speichere die Caddyfile und starte Caddy (`caddy run --config Caddyfile` oder als Dienst). Caddy holt das Zertifikat selbst.
6. Öffne auf dem Handy `https://monitor.example.org/remote/`.

In diesem Modus gilt:

- Das Gateway bleibt auf 127.0.0.1, nur Caddy spricht mit dem Internet.
- Der zweite Faktor ist für **alle** Rollen Pflicht.
- Nach 5 Fehlversuchen wird gesperrt (sonst 10).
- Tailscale-Kopfzeilen werden ignoriert und von Caddy entfernt.
- Ein Wechsel des Modus beendet alle Fern-Sitzungen.

## Benachrichtigungen (ab 4.18.18)

Im Tab **Monitoring**, Abschnitt **Benachrichtigungen** (Recht `config.manage`):

1. Hake „Alarme eingeschaltet“ an und wähle die Regeln:
   - Ausfall,
   - „wieder da“,
   - freier Platz unter X GB,
   - optional B3 gestoppt,
   - optional eine Spielerschwelle.
2. **Discord:** Öffne in Discord die Kanaleinstellungen, dann Integrationen, dann Webhooks, und erstelle einen neuen Webhook. Kopiere die URL und füge sie ein.
   - Die URL wirkt wie ein Passwort und wird danach nur noch gekürzt angezeigt.
3. **Push aufs Handy:** Öffne die Handy-App unter `/remote/` und tippe unten auf **Push aktivieren**. Jeder Benutzer meldet sein eigenes Gerät an.
   - iPhone: Dafür brauchst du iOS 16.4 oder neuer. Füge die App über „Teilen“ und „Zum Home-Bildschirm“ hinzu und öffne sie von dort.
4. Prüfe beides mit **Testalarm senden**.

Derselbe Alarm kommt höchstens einmal pro Sperrzeit (Standard 30 min). Die Entwarnung kommt genau einmal.

Push-Nachrichten enthalten nur:

- den Servernamen,
- den Zustand,
- die Ursache.

Konsolenzeilen werden nie mitgeschickt. E-Mail gibt es bewusst nicht.

## Aktionen vom Handy (ab 4.18.19)

Vom Handy aus gehen drei Dinge: eine **Nachricht** an alle Spieler, einen Spieler **kicken** und einen Server **neu starten**. Alles andere bleibt nur lesbar.

So schaltest du es ein:

1. Im Admin-Tool unter **Fern-Gateway** „Fernaktionen erlauben“ anhaken und speichern.
2. In der **Benutzerverwaltung** beim gewünschten Benutzer „Aktionen“ anhaken. Das geht nur für admin und operator.
3. Der Benutzer braucht den zweiten Faktor (TOTP) und meldet sich damit in der Handy-App an.

Danach erscheint in der App unter dem Monitoring der Bereich **Aktionen**.

So ist es abgesichert:

- Vor der ersten Aktion fragt die App nach einem **frischen Code** aus der Authenticator-App. Danach gelten Nachricht und Kick 5 min ohne neuen Code.
- Ein **Neustart** fragt immer nach einem eigenen Code. Ein schon benutzter Code gilt nicht, auch nicht der vom Anmelden. Dann kurz auf den nächsten Code warten.
- **Wiederherstellungscodes** gelten für Aktionen nie.
- Höchstens 10 Aktionen in 5 min pro Sitzung, höchstens ein Neustart pro Server in 2 min.
- Die Nachricht darf nur einfache Zeichen enthalten (keine Umlaute, keine `"`, `;`, `%`, `/`, `\`), höchstens 150 Zeichen.
- Jede Aktion steht im Audit, mit Benutzer, Gerät und Ergebnis. Kick und Neustart lösen zusätzlich einen Alarm aus, wenn Alarme an sind.
- Das gilt auch über die öffentliche Caddy-Domain. Dort ist der zweite Faktor beim Anmelden ohnehin für alle Pflicht.

Abschalten: Haken beim Benutzer oder im Gateway entfernen. Das wirkt sofort.

## Was das Gateway schützt

- **Routen:** Erreichbar sind nur Anmelden, Abmelden, Monitoring lesen, die Push-Anmeldung des eigenen Geräts, die drei Aktionen (Nachricht, Kick, Neustart, nur mit Freigabe und Code) und die Web-App. Tresor, Installer, Konfiguration, freies RCON, Start/Stopp und Benutzerverwaltung gibt es dort nicht.
- **Sitzung:** Cookie, für JavaScript nicht lesbar, nur über HTTPS, nur von der eigenen Seite. Sie endet nach 30 min ohne Nutzung, spätestens nach 12 h.
- **Login-Bremse:** Nach 10 Fehlversuchen in 15 min ist die Anmeldung 15 min gesperrt. Das gilt auch für den lokalen Login.
- **Rechte entziehen:** Jede Fern-Sitzung lässt sich im Admin-Tool beenden. Wer deaktiviert wird oder die Fernfreigabe verliert, ist sofort draußen.
- **Audit:** Jede Fern-Anmeldung wird ins Audit geschrieben, auch Fehlversuche und Sperren.
- **Quellcode:** Jede Seite verlinkt den Quellcode (AGPL-3.0 §13).
