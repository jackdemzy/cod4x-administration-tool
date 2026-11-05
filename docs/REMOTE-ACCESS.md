# Fernzugriff auf das Monitoring (Block 24b)

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

## Was das Gateway schützt

- **Routen:** Erreichbar sind nur Anmelden, Abmelden, Monitoring lesen und die Web-App. Tresor, Installer, Konfiguration, RCON und Benutzerverwaltung gibt es dort nicht.
- **Sitzung:** Cookie, für JavaScript nicht lesbar, nur über HTTPS, nur von der eigenen Seite. Sie endet nach 30 min ohne Nutzung, spätestens nach 12 h.
- **Login-Bremse:** Nach 10 Fehlversuchen in 15 min ist die Anmeldung 15 min gesperrt. Das gilt auch für den lokalen Login.
- **Rechte entziehen:** Jede Fern-Sitzung lässt sich im Admin-Tool beenden. Wer deaktiviert wird oder die Fernfreigabe verliert, ist sofort draußen.
- **Audit:** Jede Fern-Anmeldung wird ins Audit geschrieben, auch Fehlversuche und Sperren.
- **Quellcode:** Jede Seite verlinkt den Quellcode (AGPL-3.0 §13).
