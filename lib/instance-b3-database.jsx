import { useEffect, useRef, useState } from 'react';
import { EBC_CONFIRMATION } from './b3-database.mjs';

// Block 14 wizard: settings -> test -> schema -> backup + migration -> B3 Ready.
// The password is never entered here; it lives in the vault (credential editor, kind b3db).
const MESSAGES = {
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
  BACKUP_FAILED: ['Backup nicht prüfbar – Migration abgebrochen, nichts geändert.', 'Backup unverifiable – migration aborted, nothing changed.'],
  B3_DATABASE_PASSWORD_REENTRY_REQUIRED: ['Host, Port oder Benutzer wurden geändert: B3-Datenbank-Passwort unter „Zugangsdaten“ neu eingeben.', 'Host, port or user changed: enter the B3 database password again under “Credentials”.'],
  VAULT_OPERATION_BUSY: ['Tresor gerade belegt – bitte erneut versuchen.', 'Vault busy – please try again.'],
  VAULT_LOCKED: ['Tresor gesperrt.', 'Vault locked.'],
};
const say = (code, de) => MESSAGES[code]?.[de ? 0 : 1] || code;

export function InstanceB3Database({ instance, request, de, initial = null }) {
  const [state, setState] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [ebc, setEbc] = useState(false), [phrase, setPhrase] = useState('');
  const mounted = useRef(true);
  const form = useRef({});
  const base = `/api/instances/${encodeURIComponent(instance.id)}`;
  async function call(route, body) {
    const response = await request(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || `HTTP ${response.status}`);
    return data;
  }
  async function load() {
    const [database, b3] = await Promise.all([call(`${base}/b3/database`), call(`${base}/b3`)]);
    if (mounted.current) setState({ database: database.database, b3Running: b3.b3?.runtime?.running === true });
  }
  async function run(action) {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { if (mounted.current) setError(failure.message); }
    try { await load(); } catch (failure) { if (mounted.current) setError(current => current || failure.message); }
    if (mounted.current) setBusy(false);
  }
  useEffect(() => { mounted.current = true; if (!initial) void run(async () => {}); return () => { mounted.current = false; }; }, [instance.id]);
  const database = state?.database;
  const check = database?.lastCheck;
  const schema = check?.schema;
  const migratable = ['EMPTY', 'PARTIAL'].includes(schema) || (ebc && ['EMPTY', 'PARTIAL', 'COMPLETE'].includes(schema));
  const save = () => run(() => call(`${base}/b3/database`, Object.fromEntries(['host', 'port', 'database', 'username'].map(key => [key, key === 'port' ? Number(form.current.port?.value || 3306) : form.current[key]?.value || '']))));
  const migrate = () => run(() => call(`${base}/b3/database/migrate`, ebc ? { ebcOptIn: true, confirmation: phrase } : {}));
  const field = (key, label, value) => <label style={{ display: 'block' }}>{label} <input ref={input => { form.current[key] = input; }} defaultValue={value ?? ''} type={key === 'port' ? 'number' : 'text'} disabled={busy} /></label>;
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'B3 Datenbank (MySQL/MariaDB)' : 'B3 database (MySQL/MariaDB)'}</summary>
    <p>{de ? 'Ablauf: Verbindung testen → Schema prüfen → Backup → Migration → B3 Ready. Vor jeder Änderung an einer nicht leeren Datenbank wird ein geprüftes Backup erstellt.' : 'Flow: test connection → check schema → backup → migration → B3 Ready. A verified backup is taken before any change to a non-empty database.'}</p>
    {error && <p role="alert">{say(error, de)}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {field('host', 'Host', database?.settings?.host ?? '127.0.0.1')}
      {field('port', 'Port', database?.settings?.port ?? 3306)}
      {field('database', de ? 'Datenbank' : 'Database', database?.settings?.database)}
      {field('username', de ? 'Benutzer' : 'Username', database?.settings?.username)}
      <button type="submit" disabled={busy}>{de ? 'Einstellungen speichern' : 'Save settings'}</button>
    </form>
    <p>{de ? 'Passwort: ' : 'Password: '}{database?.passwordConfigured === true && database?.passwordBound === false ? say('B3_DATABASE_PASSWORD_REENTRY_REQUIRED', de) : database?.passwordConfigured === true ? (de ? 'im Tresor hinterlegt' : 'stored in the vault') : database?.passwordConfigured === false ? (de ? 'fehlt – unter „Zugangsdaten“ als B3-Datenbank-Passwort setzen' : 'missing – set it under “Credentials” as B3 database password') : (de ? 'unbekannt (Tresor gesperrt?)' : 'unknown (vault locked?)')}</p>
    <button disabled={busy || !database?.settings} onClick={() => run(() => call(`${base}/b3/database/test`, {}))}>{de ? 'Verbindung testen' : 'Test connection'}</button>
    <p role="status">{!check ? (de ? 'Noch nicht getestet.' : 'Not tested yet.')
      : check.connection !== 'OK' ? say(check.connection, de)
      : `${de ? 'Verbunden. Schema' : 'Connected. Schema'}: ${schema}${check.code ? ` – ${say(check.code, de)}` : ''}`}</p>
    {check?.missingTables?.length > 0 && <p>{de ? 'Fehlende Tabellen: ' : 'Missing tables: '}{check.missingTables.join(', ')}</p>}
    <fieldset disabled={busy} style={{ marginTop: 8 }}>
      <label><input type="checkbox" checked={ebc} onChange={event => setEbc(event.target.checked)} /> {de ? 'eBc-Promod-Statistikschema einspielen (optional)' : 'Install eBc promod statistics schema (optional)'}</label>
      <p>{de ? 'Warnung: löscht player_core und prestige_log und legt sie neu an. Zum Bestätigen exakt eingeben: ' : 'Warning: drops player_core and prestige_log and recreates them. To confirm, type exactly: '}<code>{EBC_CONFIRMATION}</code></p>
      {ebc && <input value={phrase} onChange={event => setPhrase(event.target.value)} aria-label={de ? 'Bestätigung' : 'Confirmation'} />}
    </fieldset>
    {state?.b3Running && <p>{de ? 'B3 läuft – Migration erst nach dem Stoppen von B3.' : 'B3 is running – stop B3 before migrating.'}</p>}
    <button disabled={busy || !migratable || state?.b3Running || (ebc && phrase !== EBC_CONFIRMATION)} onClick={() => migrate()}>{de ? 'Migration starten' : 'Start migration'}</button>
    {database?.mysqlEnabled && !database?.ready && <p role="alert">{de ? 'B3 nutzt MySQL, die Datenbank ist aber nicht bereit: B3 startet erst nach erfolgreichem Test wieder.' : 'B3 uses MySQL but the database is not ready: B3 starts again only after a successful test.'}</p>}
    {database?.settings && <button disabled={busy || state?.b3Running} onClick={() => run(() => call(`${base}/b3/database/remove`, {}))}>{de ? 'DB-Einstellungen entfernen (B3 nutzt wieder SQLite)' : 'Remove database settings (B3 uses SQLite again)'}</button>}
    {database?.ready && <p role="status"><strong>B3 Ready</strong> – {de ? 'B3 nutzt MySQL ab dem nächsten Start.' : 'B3 uses MySQL from its next start.'}</p>}
    {check?.backup && <p>{de ? 'Backup: ' : 'Backup: '}<code>{check.backup.path}</code> (SHA-256 <code>{check.backup.sha256}</code>)</p>}
  </details>;
}
