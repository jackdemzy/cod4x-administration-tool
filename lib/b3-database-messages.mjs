// Operator texts [German, English] for every code of the B3 database flow (Block 14).
export const B3_DATABASE_MESSAGES = Object.freeze({
  DB_UNREACHABLE: ['Datenbank nicht erreichbar (Host/Port prüfen).', 'Database unreachable (check host/port).'],
  DB_AUTH_FAILED: ['Anmeldung abgelehnt: Benutzer oder Passwort falsch.', 'Login rejected: wrong user or password.'],
  DB_ACCESS_DENIED: ['Keine Rechte auf diese Datenbank.', 'No privileges on this database.'],
  DB_NOT_FOUND: ['Datenbank existiert nicht.', 'Database does not exist.'],
  DB_DRIVER_MISSING: ['MySQL-Treiber für Python fehlt (PyMySQL).', 'MySQL driver for Python missing (PyMySQL).'],
  DB_ERROR: ['Datenbankfehler.', 'Database error.'],
  DB_HELPER_FAILED: ['Prüfprogramm fehlgeschlagen.', 'Check helper failed.'],
  DB_HELPER_TIMEOUT: ['Zeitüberschreitung bei der Prüfung.', 'Check timed out.'],
  SCHEMA_PARTIAL: ['Tabellen fehlen – Migration ergänzt sie.', 'Tables missing – migration adds them.'],
  SCHEMA_OUTDATED: ['Schema veraltet (Spalten fehlen) – keine automatische Migration.', 'Schema outdated (columns missing) – no automatic migration.'],
  MIGRATION_FAILED: ['Migration fehlgeschlagen – Backup verwenden.', 'Migration failed – use the backup.'],
  MIGRATION_IN_PROGRESS: ['Migration lief und wurde nicht abgeschlossen – Backup prüfen und erneut testen.', 'A migration started and did not finish – check the backup and test again.'],
  BACKUP_FAILED: ['Backup nicht prüfbar – Migration abgebrochen, nichts geändert.', 'Backup unverifiable – migration aborted, nothing changed.'],
  VAULT_LOCKED: ['Tresor gesperrt – unter „Zugangsdaten“ entsperren.', 'Vault locked – unlock it under “Credentials”.'],
  VAULT_OPERATION_BUSY: ['Tresor gerade belegt – bitte erneut versuchen.', 'Vault busy – please try again.'],
  B3_DATABASE_BUSY: ['Für diese Instanz läuft bereits ein Datenbank- oder B3-Startvorgang.', 'A database operation or B3 start is already running for this instance.'],
  B3_DATABASE_PASSWORD_MISSING: ['B3-Datenbank-Passwort fehlt – unter „Zugangsdaten“ setzen.', 'B3 database password missing – set it under “Credentials”.'],
  B3_DATABASE_PASSWORD_REENTRY_REQUIRED: ['Host, Port oder Benutzer wurden geändert: B3-Datenbank-Passwort unter „Zugangsdaten“ neu eingeben.', 'Host, port or user changed: enter the B3 database password again under “Credentials”.'],
  B3_DATABASE_SETTINGS_INVALID: ['Ungültige Einstellungen (Host: Name oder IPv4, Datenbank/Benutzer: A–Z, 0–9, _).', 'Invalid settings (host: name or IPv4, database/user: A–Z, 0–9, _).'],
  B3_DATABASE_NOT_CONFIGURED: ['Noch keine Datenbank-Einstellungen gespeichert.', 'No database settings saved yet.'],
  B3_DATABASE_NOT_READY: ['B3 nutzt MySQL, die Datenbank ist aber nicht bereit – erneut testen.', 'B3 uses MySQL but the database is not ready – test again.'],
  B3_SQL_HASH_MISMATCH: ['eBc-B3-SQL-Datei weicht vom geprüften Stand ab – nichts ausgeführt.', 'eBc-B3 SQL file differs from the audited version – nothing executed.'],
  B3_SQL_UNSAFE: ['eBc-B3-SQL-Datei ist keine sichere reguläre Datei – nichts ausgeführt.', 'eBc-B3 SQL file is not a safe regular file – nothing executed.'],
  EBC_CONFIRMATION_REQUIRED: ['Bestätigungsphrase für das eBc-Schema stimmt nicht.', 'Confirmation phrase for the eBc schema does not match.'],
  B3_RUNNING: ['B3 läuft – zuerst B3 stoppen.', 'B3 is running – stop B3 first.'],
  B3_PYTHON_NOT_CONFIGURED: ['Python 2.7 für B3 ist nicht eingerichtet (B3-Abhängigkeiten).', 'Python 2.7 for B3 is not configured (B3 dependencies).'],
  B3_SOURCE_NOT_CONFIGURED: ['eBc-B3-Pfad ist nicht eingerichtet (B3-Abhängigkeiten).', 'eBc-B3 path is not configured (B3 dependencies).'],
  DB_BACKUP_DRIVER_UNSUPPORTED: ['Backup braucht PyMySQL oder MySQLdb (mysql.connector wird nicht unterstützt).', 'Backups need PyMySQL or MySQLdb (mysql.connector is not supported).'],
});

// The settings form is uncontrolled; keying it by the loaded settings remounts it
// with the saved values once they arrive.
export const databaseFormKey = settings => (settings ? `${settings.host}:${settings.port}:${settings.database}:${settings.username}` : 'new');
