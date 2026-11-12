import { useState } from 'react';

// Block 21 (4.18.27): restore points of one subject (a local instance or the standard server).
// basePath: "/api/instances/<id>" or "/api/runtime". Server error text is never shown, only a fixed
// message and the code. The B3 database is only reset with the checkbox and the exact confirmation text.
export const B3_DATABASE_CONFIRMATION = 'B3-DATENBANK ZURÜCKSETZEN';
const text = (de, german, english) => (de ? german : english);
const MESSAGES = {
  RECOVERY_REQUIRED: ['Ein Rollback ist gescheitert. Bitte einen Wiederherstellungspunkt einspielen; bis dahin startet nichts.', 'A rollback failed. Restore a point; until then nothing starts.'],
  RESTORE_POINT_CODE_PERMISSION: ['Dieser Punkt bringt Code zurück (Plugins, Core oder eigene B3-Plugins). Das darf nur ein Administrator.', 'This point brings code back (plugins, core or custom B3 plugins). Only an administrator may do that.'],
  RESTORE_POINT_CONFIRMATION_REQUIRED: ['Für die B3-Datenbank muss der Bestätigungstext genau eingegeben werden.', 'For the B3 database the confirmation text must be typed exactly.'],
  RESTORE_POINT_INVALID: ['Der Punkt ist beschädigt oder verändert. Es wurde nichts eingespielt.', 'The point is damaged or changed. Nothing was restored.'],
  RESTORE_POINT_NOT_FOUND: ['Diesen Punkt gibt es nicht mehr.', 'This point no longer exists.'],
  RESTORE_POINT_TOO_LARGE: ['Der Punkt wäre größer als 256 MiB.', 'The point would be larger than 256 MiB.'],
  INSTANCE_RUNTIME_BUSY: ['Der Server läuft. Bitte zuerst stoppen.', 'The server is running. Stop it first.'],
  RUNTIME_CONFIGURATION_BUSY: ['Der Standard-Server läuft. Bitte zuerst stoppen.', 'The standard server is running. Stop it first.'],
  B3_RUNNING: ['B3 läuft. Bitte zuerst stoppen.', 'B3 is running. Stop it first.'],
};
const ACTIONS = {
  'config.change': ['Konfiguration', 'Configuration'], 'plugin.change': ['Plugins', 'Plugins'], 'b3.plugin.change': ['B3-Plugins', 'B3 plugins'],
  'b3.migration': ['B3-Migration', 'B3 migration'], 'core.change': ['Core / Update', 'Core / update'], 'restore.safety': ['Sicherung vor Wiederherstellung', 'Safety before restore'], manual: ['Manuell', 'Manual'],
};
const size = bytes => (Number.isFinite(bytes) ? (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`) : '–');

export function RestorePointsPanel({ de, basePath, request, allowB3Database = false }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [database, setDatabase] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const call = async (suffix, body) => {
    const response = await request(`${basePath}/restore-points${suffix}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error('failed'), { code: typeof data.code === 'string' ? data.code : `HTTP_${response.status}` });
    return data;
  };
  const run = async action => {
    setBusy(true); setError(null); setMessage('');
    try { await action(); } catch (caught) { setError(caught.code || 'FAILED'); } finally { setBusy(false); }
  };
  const load = () => run(async () => setState(await call('')));
  const create = includeB3Database => run(async () => {
    const created = await call('', includeB3Database ? { includeB3Database: true } : {});
    setMessage(text(de, `Punkt angelegt: ${created.pointId}`, `Point created: ${created.pointId}`));
    setState(await call(''));
  });
  const check = point => run(async () => {
    const result = await call(`/${encodeURIComponent(point.pointId)}/integrity`);
    setMessage(result.valid ? text(de, `Punkt ${point.pointId} ist vollständig.`, `Point ${point.pointId} is intact.`) : text(de, `Punkt ${point.pointId} ist beschädigt.`, `Point ${point.pointId} is damaged.`));
  });
  const restore = point => run(async () => {
    if (!window.confirm(text(de, `Punkt ${point.pointId} einspielen? Der aktuelle Stand wird vorher als eigener Punkt gesichert.`, `Restore point ${point.pointId}? The current state is kept as a point first.`))) return;
    const body = database ? { includeB3Database: true, confirmation } : {};
    const result = await call(`/${encodeURIComponent(point.pointId)}/restore`, body);
    setMessage(text(de, `Eingespielt: ${result.restored.join(', ') || '–'}. Sicherung davor: ${result.safetyPointId}.`, `Restored: ${result.restored.join(', ') || '–'}. Safety point: ${result.safetyPointId}.`));
    setChosen(null); setDatabase(false); setConfirmation('');
    setState(await call(''));
  });
  const label = action => text(de, ...(ACTIONS[action] || [action || '–', action || '–']));
  const known = error && MESSAGES[error];
  return <details style={{ marginTop: 8 }}>
    <summary>{text(de, 'Wiederherstellungspunkte', 'Restore points')}</summary>
    <p role="note">{text(de, 'Vor jeder Änderung an Konfiguration, Plugins, B3 oder Core wird automatisch ein Punkt angelegt; scheitert die Prüfung danach, wird er sofort wieder eingespielt. Spieler-, Log- und Kartendaten gehören nicht dazu.', 'Before each change of configuration, plugins, B3 or core a point is created automatically; if the check afterwards fails, it is put back at once. Player data, logs and maps are not part of it.')}</p>
    <button type="button" disabled={busy} onClick={load}>{text(de, 'Laden', 'Load')}</button>
    <button type="button" disabled={busy} onClick={() => create(false)}>{text(de, 'Punkt anlegen', 'Create point')}</button>
    {allowB3Database && <button type="button" disabled={busy} onClick={() => create(true)}>{text(de, 'Punkt mit B3-Datenbank anlegen', 'Create point with B3 database')}</button>}
    {state?.recovery && <p role="alert">{text(de, ...MESSAGES.RECOVERY_REQUIRED)} ({state.recovery.pointId})</p>}
    {error && <p role="alert">{known ? text(de, ...known) : text(de, 'Vorgang abgelehnt.', 'Operation refused.')} <code>{error}</code></p>}
    {message && <p role="status">{message}</p>}
    {state && (state.points.length === 0 ? <p>{text(de, 'Noch keine Punkte.', 'No points yet.')}</p> : <table>
      <thead><tr><th>{text(de, 'Zeit', 'Time')}</th><th>{text(de, 'Anlass', 'Cause')}</th><th>{text(de, 'Teile', 'Parts')}</th><th>{text(de, 'Größe', 'Size')}</th><th>{text(de, 'Zustand', 'State')}</th><th /></tr></thead>
      <tbody>{state.points.map(point => <tr key={point.pointId}>
        <td title={point.pointId}>{point.createdAt || point.pointId}</td>
        <td>{label(point.action)}{point.actor ? ` · ${point.actor}` : ''}</td>
        <td>{point.parts.join(', ') || '–'}</td>
        <td>{size(point.totalBytes)}</td>
        <td>{point.valid ? text(de, 'gültig', 'valid') : text(de, 'beschädigt', 'damaged')}</td>
        <td>
          <button type="button" disabled={busy} onClick={() => check(point)}>{text(de, 'Prüfen', 'Check')}</button>
          <button type="button" disabled={busy || !point.valid} onClick={() => { setChosen(point.pointId); setDatabase(false); setConfirmation(''); }}>{text(de, 'Wiederherstellen …', 'Restore …')}</button>
          {chosen === point.pointId && <div>
            {point.parts.includes('b3mysql') && <>
              <label><input type="checkbox" checked={database} onChange={event => setDatabase(event.target.checked)} disabled={busy} /> {text(de, 'Auch die B3-Datenbank zurücksetzen (alle Änderungen seit dem Punkt gehen verloren)', 'Also reset the B3 database (all changes since the point are lost)')}</label>
              {database && <label> {text(de, `Zum Bestätigen „${B3_DATABASE_CONFIRMATION}“ eingeben:`, `Type “${B3_DATABASE_CONFIRMATION}” to confirm:`)} <input type="text" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" /></label>}
            </>}
            <button type="button" disabled={busy || (database && confirmation !== B3_DATABASE_CONFIRMATION)} onClick={() => restore(point)}>{text(de, 'Jetzt einspielen', 'Restore now')}</button>
            <button type="button" disabled={busy} onClick={() => setChosen(null)}>{text(de, 'Abbrechen', 'Cancel')}</button>
          </div>}
        </td>
      </tr>)}</tbody>
    </table>)}
  </details>;
}

// Local core change (admin only, server.code): with a restore point and rollback when the check fails.
export function InstanceCoreChange({ de, instance, request }) {
  const [executablePath, setExecutablePath] = useState(instance.serverCore?.executablePath || '');
  const [version, setVersion] = useState(instance.serverCore?.version || '21.5');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setResult(null);
    try {
      const response = await request(`/api/instances/${encodeURIComponent(instance.id)}/core`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executablePath, version }) });
      const data = await response.json().catch(() => ({}));
      setResult(response.ok ? { ok: true, version: data.serverCore?.version } : { ok: false, code: typeof data.code === 'string' ? data.code : data.permission ? 'PERMISSION_DENIED' : `HTTP_${response.status}` });
    } catch { setResult({ ok: false, code: 'NETWORK' }); } finally { setBusy(false); }
  };
  return <details style={{ marginTop: 8 }}>
    <summary>{text(de, 'Core wechseln', 'Change core')}</summary>
    <form onSubmit={submit}>
      <label>{text(de, 'Pfad zur Core-Datei', 'Core file path')} <input type="text" value={executablePath} onChange={event => setExecutablePath(event.target.value)} disabled={busy} autoComplete="off" /></label>
      <label> Version <select value={version} onChange={event => setVersion(event.target.value)} disabled={busy}>{['21.2', '21.3', '21.4', '21.5'].map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <button type="submit" disabled={busy || !executablePath}>{text(de, 'Core wechseln (nur gestoppt)', 'Change core (stopped only)')}</button>
    </form>
    {result && (result.ok ? <p role="status">{text(de, `Core gewechselt (Version ${result.version}). Der alte Stand liegt als Wiederherstellungspunkt bereit.`, `Core changed (version ${result.version}). The old state is kept as a restore point.`)}</p>
      : <p role="alert">{text(de, 'Core-Wechsel abgelehnt.', 'Core change refused.')} <code>{result.code}</code></p>)}
  </details>;
}
