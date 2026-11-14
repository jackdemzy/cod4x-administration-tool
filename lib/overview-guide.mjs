// 4.18.31: text of the overview page: a short step-by-step guide and one line per menu item.
// Plain data (no JSX) so the test can check that every menu item has a description in both languages.

export const MENU_LABELS = {
  overview: ['Übersicht', 'Overview'],
  monitor: ['Monitoring', 'Monitoring'],
  config: ['Server Config', 'Server Config'],
  mods: ['Mods', 'Mods'],
  security: ['Sicherheit', 'Security'],
  diagnostics: ['Diagnose', 'Diagnostics'],
  runtime: ['Runtime', 'Runtime'],
  remote: ['Remote Linux', 'Remote Linux'],
  audit: ['Audit', 'Audit'],
  rcon: ['RCON Referenz', 'RCON Reference'],
  versions: ['Version Manager', 'Version Manager'],
  tools: ['Werkzeuge', 'Tools'],
};

export const QUICK_START = [
  ['Runtime öffnen: Server-Verzeichnis und den CoD4x-Dedicated-Core (cod4x18_dedrun) wählen und eine Serverinstanz anlegen.',
    'Open Runtime: choose the server folder and the CoD4x dedicated core (cod4x18_dedrun) and create a server instance.'],
  ['Unter Version Manager oder Mods die CoD4x-Version und das Mod-Profil festlegen.',
    'In Version Manager or Mods, set the CoD4x version and the mod profile.'],
  ['Unter Server Config Name, Slots, Passwörter und Spielmodus eintragen und die server.cfg erzeugen.',
    'In Server Config, enter name, slots, passwords and game type and generate the server.cfg.'],
  ['Unter Sicherheit die Security-Prüfung laufen lassen und das Anti-Cheat-Profil wählen.',
    'In Security, run the security check and choose the anti-cheat profile.'],
  ['Unter Diagnose den Gesamtstatus prüfen, bevor der Server das erste Mal startet.',
    'In Diagnostics, check the overall status before the first start.'],
  ['Unter Runtime den Server starten und unter Monitoring Status, Spieler und Ausfälle beobachten.',
    'Start the server in Runtime and watch status, players and outages in Monitoring.'],
  ['Bei Bedarf: Server auf Linux-Hosts unter Remote Linux verwalten, Benutzer, Rollen und Backups unter Audit.',
    'If needed: manage servers on Linux hosts in Remote Linux, and users, roles and backups in Audit.'],
];

export const MENU_GUIDE = [
  ['overview', 'Startseite mit dieser Anleitung und der Erklärung aller Menüpunkte.', 'Start page with this guide and an explanation of every menu item.'],
  ['monitor', 'Zeigt Status, Spielerzahl, Verlauf und Ausfälle aller Server. Hier richtest du auch Fernzugriff und Alarme ein.', 'Shows status, player count, history and outages of all servers. Remote access and alerts are set up here too.'],
  ['config', 'Erstellt eine geprüfte server.cfg (Name, Slots, Passwörter, Netzwerk, Spielmodus, Logging) zum Kopieren oder Speichern.', 'Builds a validated server.cfg (name, slots, passwords, network, game type, logging) to copy or save.'],
  ['mods', 'Wählt Mod-Profil und CoD4x-Version für die Installation und zeigt das Installer-Log.', 'Picks the mod profile and CoD4x version for the installation and shows the installer log.'],
  ['security', 'Prüft die Server-Absicherung und stellt Anti-Cheat (FPSAC, CoD4x, RUSCOD) ein.', 'Checks the server hardening and configures anti-cheat (FPSAC, CoD4x, RUSCOD).'],
  ['diagnostics', 'Liest Version, Pfade, Core, Konfiguration, Module, RCON und Netzwerk und meldet Fehler. Ändert nichts.', 'Reads version, paths, core, configuration, modules, RCON and network and reports problems. Changes nothing.'],
  ['runtime', 'Legt Serverinstanzen an und startet, stoppt und überwacht sie, inklusive Plugins, RCON-Konsole und B3.', 'Creates server instances and starts, stops and watches them, including plugins, RCON console and B3.'],
  ['remote', 'Verwaltet CoD4x-Server auf Linux-Hosts über SSH: Hosts anlegen, Server installieren, starten, Backups, Docker.', 'Manages CoD4x servers on Linux hosts over SSH: add hosts, install, start and back up servers, Docker.'],
  ['audit', 'Benutzer, Rollen und Sitzungen, Backups mit Wiederherstellung sowie das Protokoll aller Aktionen.', 'Users, roles and sessions, backups with restore, and the log of every action.'],
  ['rcon', 'Nachschlagewerk der wichtigsten RCON-Befehle mit Argumenten und Erklärung.', 'Reference of the main RCON commands with arguments and explanation.'],
  ['versions', 'Sucht nach Updates, verwaltet Versionen, Profile, Installationsziel und Wiederherstellungspunkte.', 'Checks for updates and manages versions, profiles, the install target and restore points.'],
  ['tools', 'Dvar-Browser zum Nachschlagen von Servervariablen und der GSC-Script-Assistent.', 'Dvar browser to look up server variables, and the GSC script assistant.'],
];

export const pick = (de, pair) => (de ? pair[0] : pair[1]);
