import { useEffect, useRef, useState } from 'react';

const STATUS_TEXT = {
  RUNNING: ['läuft', 'running'], STARTING: ['startet', 'starting'], STOPPING: ['stoppt', 'stopping'], STOPPED: ['gestoppt', 'stopped'],
  CRASHED: ['abgestürzt – Server unberührt', 'crashed – server unaffected'], FAILED: ['Start fehlgeschlagen', 'start failed'], LOST: ['Prozess verschwunden', 'process lost'],
};
const HEALTH_TEXT = {
  HEALTHY: ['bereit (liest Spielereignisse)', 'ready (reading game events)'], STARTING: ['startet', 'starting'], DEGRADED: ['Fehler im B3-Log', 'errors in B3 log'],
  DOWN: ['nicht aktiv', 'not active'], UNKNOWN: ['Prozessidentität unklar', 'process identity unclear'],
};
// Roadmap Block 13: CONTROL must tell these failure causes apart.
const DIAGNOSIS_TEXT = {
  PYTHON_MISSING: ['Python fehlt – Python-2.7-Pfad in den B3-Abhängigkeiten hinterlegen.', 'Python missing – set the Python 2.7 path in the B3 dependencies.'],
  PYTHON_INCOMPATIBLE: ['Python inkompatibel – eBc-B3 läuft nur mit Python 2.7.', 'Python incompatible – eBc-B3 runs only on Python 2.7.'],
  B3_MISSING: ['B3 fehlt – eBc-B3-Verzeichnis nicht gefunden oder unvollständig.', 'B3 missing – eBc-B3 directory not found or incomplete.'],
  B3_INCOMPATIBLE: ['B3-Stand nicht freigegeben (z. B. fehlerhafter Commit d44c05e oder geänderte Dateien).', 'B3 source not approved (e.g. broken commit d44c05e or modified files).'],
  DEPENDENCY_MISSING: ['Abhängigkeit fehlt – python-dateutil oder MySQL-Treiber (PyMySQL).', 'Dependency missing – python-dateutil or MySQL driver (PyMySQL).'],
  COD4X_OFFLINE: ['CoD4X offline – Server läuft nicht oder antwortet nicht.', 'CoD4X offline – server not running or not answering.'],
  DB_OFFLINE: ['Datenbank offline – B3 meldet „Database connection failed“ oder fehlende Tabellen.', 'Database offline – B3 reports "Database connection failed" or missing tables.'],
  PARSER_OFFLINE: ['Parser offline – B3 meldet einen kritischen Fehler.', 'Parser offline – B3 reports a critical error.'],
  RCON_OFFLINE: ['RCON offline – B3 erreicht den Server per RCON nicht.', 'RCON offline – B3 cannot reach the server via RCON.'],
};
const mark = ok => ok === true ? '✓' : ok === false ? '✗' : '–';

export function B3RuntimeView({ b3, de }) {
  if (!b3) return null;
  const text = (table, key) => (table[key] || [key, key])[de ? 0 : 1];
  const { runtime, health } = b3;
  const alert = ['CRASHED', 'FAILED', 'LOST'].includes(runtime.status) || health.status === 'DEGRADED';
  return <div>
    <p role={alert ? 'alert' : 'status'}>B3: <strong>{runtime.status}</strong> – {text(STATUS_TEXT, runtime.status)} · Health: <strong>{health.status}</strong> – {text(HEALTH_TEXT, health.status)}</p>
    <p>PID: {runtime.pid ?? '–'} · {de ? 'Laufzeit' : 'Uptime'}: {health.uptimeSec != null ? `${health.uptimeSec} s` : '–'} · Exit: {runtime.exitCode ?? '–'}{runtime.signal ? ` (${runtime.signal})` : ''}
      {health.rcon === 'UNREACHABLE' && <> · <strong>RCON</strong>: {de ? 'Server nicht erreichbar (B3 läuft weiter)' : 'server unreachable (B3 keeps running)'}</>}</p>
    {b3.output && <pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{b3.output.slice(-3000)}</pre>}
  </div>;
}

export function B3Dashboard({ dashboard, de }) {
  if (!dashboard) return null;
  const { checks } = dashboard;
  const rows = [['Python', checks.python], ['B3', checks.b3], ['MySQL', checks.mysql], ['Parser', checks.parser], ['RCON', checks.rcon], ['CoD4X', checks.cod4x]];
  return <div>
    <table>
      <tbody>
        <tr><th>Status</th><td>{dashboard.status} ({dashboard.health})</td></tr>
        <tr><th>Version</th><td>{dashboard.version.label}{dashboard.version.b3 && ` ${dashboard.version.b3}`}{dashboard.version.commit && ` @ ${dashboard.version.commit}`}</td></tr>
        <tr><th>Parser</th><td>{dashboard.parser || '–'}</td></tr>
        <tr><th>Database</th><td>{dashboard.database}</td></tr>
        <tr><th>RCON</th><td>{dashboard.rcon}</td></tr>
        <tr><th>publist</th><td>{dashboard.publist === 'SUPPRESSED' ? (de ? 'unterdrückt (public_ip 127.0.0.1, keine Meldung an bigbrotherbot.net)' : 'suppressed (public_ip 127.0.0.1, no report to bigbrotherbot.net)') : dashboard.publist}</td></tr>
      </tbody>
    </table>
    <table>
      <thead><tr><th>Health Check</th><th></th><th>{de ? 'Zustand' : 'State'}</th></tr></thead>
      <tbody>{rows.map(([label, value]) => <tr key={label}><td>{label}</td><td>{mark(value?.ok)}</td><td>{value?.state || '–'}</td></tr>)}</tbody>
    </table>
    {dashboard.diagnosis.length > 0 ? <ul role="alert">{dashboard.diagnosis.map(code => <li key={code}><strong>{code}</strong>{code === dashboard.primary && (de ? ' (Hauptursache)' : ' (primary cause)')} – {(DIAGNOSIS_TEXT[code] || [code, code])[de ? 0 : 1]}{code === 'RCON_OFFLINE' && dashboard.rconCause && (de ? ' Folge von CoD4X offline.' : ' Caused by CoD4X offline.')}</li>)}</ul>
      : <p role="status">{de ? 'Keine Fehlerdiagnose.' : 'No diagnosis.'}</p>}
  </div>;
}

export function InstanceB3Runtime({ instance, request, de }) {
  const [b3, setB3] = useState(null), [dashboard, setDashboard] = useState(null), [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/instances/${encodeURIComponent(instance.id)}/b3`;
  async function get(route) {
    const response = await request(route);
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
    return data;
  }
  async function run(action, fresh = false) {
    setBusy(true); setError('');
    try {
      if (action) {
        const response = await request(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
      }
      const [status, board] = await Promise.all([get(base), get(`${base}/dashboard${fresh ? '?fresh=1' : ''}`)]);
      if (mounted.current) { setB3(status.b3); setDashboard(board.b3); }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function show(kind) {
    setBusy(true); setError('');
    try {
      const data = await get(`${base}/${kind}`);
      if (mounted.current) setPanel(kind === 'logs' ? { kind, text: `${data.logs.b3Log || ''}${data.logs.output ? `\n--- stdout/stderr ---\n${data.logs.output}` : ''}` } : { kind, text: data.config.exists ? data.config.text : (de ? 'Noch keine Konfiguration erzeugt (entsteht beim ersten Start).' : 'No configuration generated yet (created on first start).') });
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const running = b3?.runtime?.running;
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'B3 Manager' : 'B3 manager'}</summary>
    <p>{de ? 'B3 läuft als eigener Prozess, unabhängig vom CoD4x-Server: Ein B3-Absturz oder -Neustart beeinflusst den Server nicht und umgekehrt. Start nur mit erfüllten Abhängigkeiten (geprüftes eBc-B3, Python 2.7).' : 'B3 runs as its own process, independent of the CoD4x server: a B3 crash or restart does not affect the server and vice versa. Starts only with satisfied dependencies (audited eBc-B3, Python 2.7).'}</p>
    <button disabled={busy} onClick={() => run(null, true)}>{de ? 'Status prüfen' : 'Check status'}</button>
    <button disabled={busy || running} onClick={() => run('start')}>{de ? 'Start' : 'Start'}</button>
    <button disabled={busy || !running} onClick={() => run('stop')}>{de ? 'Stop' : 'Stop'}</button>
    <button disabled={busy || !b3} onClick={() => run('restart')}>{de ? 'Restart' : 'Restart'}</button>
    <button disabled={busy} onClick={() => show('logs')}>Logs</button>
    <button disabled={busy} onClick={() => show('config')}>Config</button>
    {error && <p role="alert">{error}</p>}
    <B3Dashboard dashboard={dashboard} de={de}/>
    <B3RuntimeView b3={b3} de={de}/>
    {panel && <pre aria-label={panel.kind} style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{panel.text}</pre>}
  </details>;
}
