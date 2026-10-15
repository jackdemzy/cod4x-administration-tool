import { useEffect, useRef, useState } from 'react';

export function InstanceConfigEditor({ instance, request, de }) {
  const [configuration, setConfiguration] = useState(null), [entries, setEntries] = useState([]);
  const [preview, setPreview] = useState(null), [backupId, setBackupId] = useState('');
  const [backups, setBackups] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true), operation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = Boolean(instance.runtime?.pid || instance.runtime?.recoveryBlocked || ['STARTING', 'RUNNING', 'STOPPING'].includes(instance.runtime?.status));
  async function call(suffix = '', method = 'GET', body) {
    const response = await request(`/api/instances/${encodeURIComponent(instance.id)}/config${suffix}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.configuration;
  }
  async function action(kind) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      if (kind === 'load') {
        const current = await call();
        const listResponse = await request(`/api/instances/${encodeURIComponent(instance.id)}/config/backups`);
        const listing = await listResponse.json();
        if (!listResponse.ok) throw new Error(listing.error || `HTTP ${listResponse.status}`);
        if (!mounted.current) return;
        setConfiguration(current); setEntries(current.entries); setPreview(null); setBackups(listing.backups || []); setBackupId('');
      } else if (kind === 'preview') {
        const checked = await call('/preview', 'POST', { expectedSha256: configuration.sha256, entries });
        if (mounted.current) setPreview(checked);
      } else {
        const result = kind === 'restore'
          ? await call('/restore', 'POST', { expectedSha256: configuration.sha256, backupId })
          : await call('', 'PUT', { expectedSha256: configuration.sha256, entries });
        const current = await call();
        const listResponse = await request(`/api/instances/${encodeURIComponent(instance.id)}/config/backups`);
        const listing = await listResponse.json();
        if (!listResponse.ok) throw new Error(listing.error || `HTTP ${listResponse.status}`);
        if (!mounted.current) return;
        setConfiguration(current); setEntries(current.entries); setPreview(null);
        setBackups(listing.backups || []);
        if (result.backupId) setBackupId(result.backupId);
        setMessage(de ? 'Datei übernommen und geprüft. Server wird nicht automatisch gestartet.' : 'File applied and verified. Server is not started automatically.');
      }
    } catch (failure) { if (mounted.current) { setError(failure.message); setPreview(null); } }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  function edit(next) { setEntries(next); setPreview(null); setMessage(''); }
  const available = Object.entries(configuration?.schema || {}).filter(([name, schema]) => !schema.managed && !entries.some(entry => entry.name === name));
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'Instanzkonfiguration – Schema / Backup / Restore' : 'Instance configuration – schema / backup / restore'}</summary>
    <p>{de ? 'Vorprüfen → Vergleich prüfen → Backup und Übernahme → Dateiprüfung. Änderungen nur bei gestopptem Server; Aktivierung beim nächsten Start.' : 'Preview → review diff → backup and apply → file verification. Changes require a stopped server; activation on next start.'}</p>
    <button disabled={busy} onClick={() => action('load')}>{de ? 'Datei laden / aktualisieren' : 'Load / refresh file'}</button>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {configuration && <>
      {configuration.valid === false && <p role="alert">{de ? 'Aktuelle Konfiguration ist beschädigt oder nicht schema-konform. Nur aus einer geprüften Sicherung wiederherstellen.' : 'Current configuration is damaged or outside the schema. Restore a verified backup.'}</p>}
      <p style={{ overflowWrap: 'anywhere' }}>SHA256: {configuration.sha256}</p>
      {entries.map((entry, index) => {
        const schema = configuration.schema[entry.name], disabled = busy || active || schema?.managed;
        return <div key={entry.name} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <label>{schema?.section} / {entry.name}{schema?.type === 'enum'
            ? <select disabled={disabled} value={entry.value} onChange={event => edit(entries.map((value, position) => position === index ? { ...value, value: event.target.value } : value))}>{schema.values.map(value => <option key={value}>{value}</option>)}</select>
            : <input disabled={disabled} type={schema?.type === 'integer' ? 'number' : 'text'} min={schema?.min} max={schema?.max} value={entry.value} onChange={event => edit(entries.map((value, position) => position === index ? { ...value, value: event.target.value } : value))}/>}</label>
          {!schema?.managed && <button disabled={busy || active} onClick={() => edit(entries.filter((_, position) => position !== index))}>{de ? 'Entfernen' : 'Remove'}</button>}
        </div>;
      })}
      <label>{de ? 'Einstellung ergänzen' : 'Add setting'}<select disabled={busy || active} value="" onChange={event => {
        const name = event.target.value, schema = configuration.schema[name];
        if (schema) edit([...entries, { command: 'set', name, value: schema.type === 'enum' ? schema.values[0] : schema.type === 'integer' ? String(schema.min) : '' }]);
      }}><option value="">—</option>{available.map(([name]) => <option key={name} value={name}>{name}</option>)}</select></label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button disabled={busy || active || configuration.valid === false} onClick={() => action('preview')}>{de ? 'Vorprüfen / Vergleich' : 'Preview / diff'}</button>
        <button disabled={busy || active || !preview?.valid || !preview.diff.length} onClick={() => action('apply')}>{de ? 'Backup + Übernehmen + Prüfen' : 'Backup + apply + verify'}</button>
      </div>
      {preview && <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.diff, null, 2)}</pre>}
      <label>{de ? 'Geprüfte Sicherung auswählen' : 'Select verified backup'}<select disabled={busy || active} value={backupId} onChange={event => setBackupId(event.target.value)}>
        <option value="">—</option>
        {backups.map(backup => <option key={backup.id} value={backup.id} disabled={!backup.valid}>{backup.valid ? backup.createdAt : (de ? 'BESCHÄDIGT – gesperrt' : 'CORRUPT – blocked')} · {backup.id}</option>)}
      </select></label>
      <button disabled={busy || active || !backupId} onClick={() => action('restore')}>{de ? 'Mit Sicherheitskopie wiederherstellen' : 'Restore with safety snapshot'}</button>
    </>}
  </details>;
}
