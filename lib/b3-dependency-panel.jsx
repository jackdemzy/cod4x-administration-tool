import { useEffect, useRef, useState } from 'react';

const STATUS_TEXT = {
  OK: ['erfüllt', 'satisfied'], MISSING: ['fehlt', 'missing'], INCOMPATIBLE: ['inkompatibel', 'incompatible'],
  OPTIONAL_MISSING: ['optional, fehlt', 'optional, missing'], UNAUDITED: ['weicht vom geprüften Stand ab', 'differs from audited source'],
  NOT_CHECKED: ['folgt in späterem Block', 'checked in a later block'], UNVERIFIED: ['nur nativ prüfbar', 'native test required'],
};
const OVERALL_TEXT = {
  BLOCKED: ['Blockiert – B3 kann so nicht gestartet werden.', 'Blocked – B3 cannot be started like this.'],
  UNAUDITED: ['Quellstand weicht vom Audit ab – vor Nutzung erneut prüfen.', 'Source differs from the audit – review before use.'],
  READY_FOR_RUNTIME_TEST: ['Abhängigkeiten erfüllt – bereit für den Runtime-Test (Block 12).', 'Dependencies satisfied – ready for the runtime test (block 12).'],
};

export function B3DependencyTable({ dependencies, de }) {
  if (!dependencies) return null;
  const text = (table, key) => (table[key] || [key, key])[de ? 0 : 1];
  return <>
    <p role={dependencies.overall === 'BLOCKED' ? 'alert' : 'status'}><strong>{dependencies.overall}</strong> – {text(OVERALL_TEXT, dependencies.overall)}</p>
    {dependencies.python && <p>Python: {dependencies.python.version} ({dependencies.python.bits} bit)</p>}
    <table>
      <thead><tr><th>{de ? 'Komponente' : 'Component'}</th><th>{de ? 'Anforderung' : 'Requirement'}</th><th>{de ? 'Pflicht' : 'Required'}</th><th>{de ? 'Gefunden' : 'Found'}</th><th>Status</th></tr></thead>
      <tbody>{dependencies.results.map(item => <tr key={item.id}>
        <td>{item.component}</td><td>{item.requirement}</td><td>{item.required ? (de ? 'ja' : 'yes') : (de ? 'optional' : 'optional')}</td>
        <td>{item.found || '–'}</td><td>{item.status} – {text(STATUS_TEXT, item.status)}{item.detail && <> ({item.detail})</>}</td>
      </tr>)}</tbody>
    </table>
    {dependencies.blockedSql?.length > 0 && <p>{de ? 'Nie automatisch ausgeführt (destruktives SQL)' : 'Never run automatically (destructive SQL)'}: {dependencies.blockedSql.join(', ')}</p>}
    <p>{de ? 'Geprüfter Quellstand' : 'Audited source'}: {dependencies.source.repository} @ {dependencies.source.commit.slice(0, 12)} (B3 {dependencies.source.b3Version})</p>
  </>;
}

export function B3DependencyPanel({ request, de }) {
  const [environment, setEnvironment] = useState(null), [pythonPath, setPythonPath] = useState(''), [b3Path, setB3Path] = useState('');
  const [dependencies, setDependencies] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function call(route, body) {
    const response = await request(route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
    return data;
  }
  async function run(task) {
    setBusy(true); setError('');
    try { await task(); } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const load = () => run(async () => {
    const { environment: value } = await call('/api/b3/environment');
    if (!mounted.current) return;
    setEnvironment(value); setPythonPath(value.pythonPath || ''); setB3Path(value.b3Path || '');
  });
  const save = () => run(async () => {
    const { environment: value } = await call('/api/b3/environment', { pythonPath: pythonPath.trim() || null, b3Path: b3Path.trim() || null });
    if (mounted.current) setEnvironment(value);
  });
  const check = () => run(async () => {
    const { dependencies: value } = await call('/api/b3/dependencies/check', {});
    if (mounted.current) setDependencies(value);
  });
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'B3 (eBc-B3) – Abhängigkeiten' : 'B3 (eBc-B3) – dependencies'}</summary>
    <p>{de ? 'eBc-B3 läuft als separater Prozess und benötigt Python 2.7, python-dateutil, einen MySQL-Treiber (PyMySQL) und MySQL/MariaDB. CONTROL startet B3 hier nicht, sondern prüft nur den Interpreter (feste Import-Probe) und liest die B3-Dateien statisch. Audit: docs/EBC-B3-AUDIT.md.' : 'eBc-B3 runs as a separate process and needs Python 2.7, python-dateutil, a MySQL driver (PyMySQL) and MySQL/MariaDB. CONTROL does not start B3 here; it only probes the interpreter (fixed import probe) and reads the B3 files statically. Audit: docs/EBC-B3-AUDIT.md.'}</p>
    <button disabled={busy} onClick={load}>{de ? 'Einstellungen laden' : 'Load settings'}</button>
    {environment && <>
      <label>{de ? 'Python-2.7-Interpreter (absoluter Pfad, z. B. C:\\Python27\\python.exe)' : 'Python 2.7 interpreter (absolute path, e.g. /usr/bin/python2.7)'} <input type="text" value={pythonPath} disabled={busy} onChange={event => setPythonPath(event.target.value)}/></label>
      <label>{de ? 'eBc-B3-Verzeichnis (enthält b3_run.py)' : 'eBc-B3 directory (contains b3_run.py)'} <input type="text" value={b3Path} disabled={busy} onChange={event => setB3Path(event.target.value)}/></label>
      <button disabled={busy} onClick={save}>{de ? 'Speichern' : 'Save'}</button>
      <button disabled={busy} onClick={check}>{de ? 'Abhängigkeiten prüfen' : 'Check dependencies'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <B3DependencyTable dependencies={dependencies} de={de}/>
  </details>;
}
