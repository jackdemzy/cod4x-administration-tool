import { useEffect, useRef, useState } from 'react';

const STATE_TEXT = {
  ENABLED: ['aktiv – wird beim Start geladen', 'enabled – loaded on start'],
  DISABLED: ['freigegeben, deaktiviert', 'approved, disabled'],
  NOT_APPROVED: ['gefunden, nicht freigegeben – Hash prüfen und freigeben', 'found, not approved – verify hash and approve'],
  INTEGRITY_MISMATCH: ['Hash weicht von der Freigabe ab – Start blockiert, neu freigeben nur nach Prüfung', 'hash differs from approval – start blocked, re-approve only after review'],
  MISSING: ['freigegeben, Datei fehlt', 'approved, file missing'],
  WRONG_PLATFORM: ['falsche Plattform (.dll/.so)', 'wrong platform (.dll/.so)'],
  INVALID: ['ungültige Datei', 'invalid file'],
};
const LOAD_TEXT = { LOADED: ['geladen', 'loaded'], PENDING: ['keine Lademeldung', 'no load message'], NOT_FOUND: ['nicht gefunden', 'not found'], REJECTED_INVALID: ['vom Core abgelehnt', 'rejected by core'], SECUREMODE_REJECTED: ['securemode: Prüfsumme abgelehnt', 'securemode: checksum rejected'], LOAD_FAILED: ['Laden fehlgeschlagen', 'load failed'] };

export function PluginTable({ plugins, de, busy, onAction }) {
  if (!plugins?.length) return <p>{de ? 'Keine Plugins im Instanzordner plugins/.' : 'No plugins in the instance plugins/ folder.'}</p>;
  const text = (table, key) => (table[key] || [key, key])[de ? 0 : 1];
  return <table>
    <thead><tr><th>Plugin</th><th>{de ? 'Status' : 'State'}</th><th>{de ? 'Laufzeit' : 'Runtime'}</th><th>Version</th><th>SHA-256</th><th>{de ? 'Aktion' : 'Action'}</th></tr></thead>
    <tbody>{plugins.map(plugin => <tr key={`${plugin.name}:${plugin.file || plugin.state}`}>
      <td>{plugin.name}{plugin.catalog && <> · {plugin.catalog.fullName}</>}{plugin.catalog?.dependencies?.map(dependency => <div key={dependency.kind}>{de ? 'Abhängigkeit' : 'Dependency'}: {dependency.kind}{dependency.required ? '' : (de ? ' (optional)' : ' (optional)')} – {dependency.note}</div>)}</td>
      <td role={plugin.state === 'INTEGRITY_MISMATCH' ? 'alert' : undefined}>{plugin.state} – {text(STATE_TEXT, plugin.state)}</td>
      <td>{plugin.load ? text(LOAD_TEXT, plugin.load) : '–'}</td>
      <td>{plugin.version || '–'}</td>
      <td style={{ overflowWrap: 'anywhere' }} title={plugin.sha256 || ''}>{plugin.sha256 || '–'}{plugin.pinnedSha256 && plugin.pinnedSha256 !== plugin.sha256 && <div>{de ? 'Freigegeben' : 'Approved'}: {plugin.pinnedSha256}</div>}</td>
      <td>
        {(plugin.state === 'NOT_APPROVED' || plugin.state === 'INTEGRITY_MISMATCH') && <button disabled={busy} onClick={() => onAction('approve', plugin)}>{de ? 'Hash bestätigen + freigeben' : 'Confirm hash + approve'}</button>}
        {plugin.state === 'DISABLED' && <button disabled={busy} onClick={() => onAction('enable', plugin)}>{de ? 'Aktivieren' : 'Enable'}</button>}
        {plugin.state === 'ENABLED' && <button disabled={busy} onClick={() => onAction('disable', plugin)}>{de ? 'Deaktivieren' : 'Disable'}</button>}
        {plugin.pinnedSha256 && <button disabled={busy} onClick={() => onAction('remove', plugin)}>{de ? 'Entfernen (archivieren)' : 'Remove (archive)'}</button>}
      </td>
    </tr>)}</tbody>
  </table>;
}

export function PluginConfigEditor({ plugin, de, busy, onSave }) {
  const schema = plugin?.catalog?.configSchema;
  const [values, setValues] = useState(() => ({ ...Object.fromEntries(Object.entries(schema || {}).map(([key, definition]) => [key, definition.default])), ...(plugin?.config || {}) }));
  if (!schema || !plugin.pinnedSha256) return null;
  return <fieldset>
    <legend>{plugin.name} – {de ? 'Plugin-Konfiguration (wird nach loadPlugin gesetzt)' : 'plugin configuration (set after loadPlugin)'}</legend>
    {Object.entries(schema).map(([key, definition]) => <label key={key} style={{ marginRight: 8 }}>{key}
      <input type={definition.type === 'integer' ? 'number' : 'text'} min={definition.min} max={definition.max} value={values[key] ?? ''} disabled={busy} onChange={event => setValues({ ...values, [key]: event.target.value })}/></label>)}
    <button disabled={busy} onClick={() => onSave(plugin, values)}>{de ? 'Konfiguration speichern' : 'Save configuration'}</button>
  </fieldset>;
}

export function InstancePluginManager({ instance, request, de }) {
  const [data, setData] = useState(null), [sourcePath, setSourcePath] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/instances/${encodeURIComponent(instance.id)}/plugins`;
  async function call(suffix = '', body) {
    const response = await request(base + suffix, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code || result.error || `HTTP ${response.status}`);
    return result;
  }
  async function run(task, done) {
    setBusy(true); setError(''); setMessage('');
    try {
      await task();
      const listing = await call();
      if (mounted.current) { setData(listing.plugins); if (done) setMessage(done); }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  function action(kind, plugin) {
    const name = encodeURIComponent(plugin.name);
    if (kind === 'approve') return run(() => call('/approve', { name: plugin.name, sha256: plugin.sha256 }), de ? 'Freigegeben (deaktiviert). Hash ist jetzt für diese Instanz festgelegt.' : 'Approved (disabled). The hash is now pinned for this instance.');
    if (kind === 'remove') return run(() => call(`/${name}/remove`, {}), de ? 'Plugin nach plugins/.removed archiviert.' : 'Plugin archived to plugins/.removed.');
    return run(() => call(`/${name}/${kind}`, {}), de ? 'Gespeichert; wirksam beim nächsten Start.' : 'Saved; effective on next start.');
  }
  const running = Boolean(data?.running);
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'Plugins' : 'Plugins'}</summary>
    <p>{de ? 'CoD4x lädt Plugins aus plugins/<name>.dll (Windows) bzw. .so (Linux) dieser Instanz. Jedes aktivierte Plugin wird vor dem Start gegen seinen freigegebenen SHA-256 geprüft; Abweichung oder fehlende Datei blockiert den Start. Änderungen nur bei gestopptem Server.' : 'CoD4x loads plugins from this instance’s plugins/<name>.dll (Windows) or .so (Linux). Each enabled plugin is checked against its approved SHA-256 before start; a mismatch or missing file blocks the start. Changes only while stopped.'}</p>
    <button disabled={busy} onClick={() => run(async () => {})}>{de ? 'Plugins erkennen' : 'Discover plugins'}</button>
    {running && <button disabled={busy} onClick={() => run(() => call('/versions', {}), de ? 'Versionen per RCON pluginInfo gelesen.' : 'Versions read via RCON pluginInfo.')}>{de ? 'Versionen lesen (RCON)' : 'Read versions (RCON)'}</button>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {data && <>
      <PluginTable plugins={data.plugins} de={de} busy={busy || running} onAction={action}/>
      {data.plugins.filter(plugin => plugin.catalog?.configSchema && plugin.pinnedSha256).map(plugin => <PluginConfigEditor key={plugin.name} plugin={plugin} de={de} busy={busy || running} onSave={(value, config) => run(() => call(`/${encodeURIComponent(value.name)}/config`, { config }), de ? 'Plugin-Konfiguration gespeichert.' : 'Plugin configuration saved.')}/>)}
      <label>{de ? 'Plugin aus lokaler Datei installieren (absoluter Pfad, .dll/.so passend zur Plattform)' : 'Install plugin from local file (absolute path, .dll/.so matching the platform)'}
        <input type="text" value={sourcePath} disabled={busy || running} onChange={event => setSourcePath(event.target.value)}/></label>
      <button disabled={busy || running || !sourcePath.trim()} onClick={() => run(() => call('/install', { sourcePath: sourcePath.trim() }), de ? 'Installiert und Hash festgelegt (deaktiviert).' : 'Installed and hash pinned (disabled).')}>{de ? 'Installieren' : 'Install'}</button>
    </>}
  </details>;
}
