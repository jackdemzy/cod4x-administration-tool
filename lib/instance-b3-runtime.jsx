import { useEffect, useRef, useState } from 'react';

const STATUS_TEXT = {
  RUNNING: ['läuft', 'running'], STARTING: ['startet', 'starting'], STOPPING: ['stoppt', 'stopping'], STOPPED: ['gestoppt', 'stopped'],
  CRASHED: ['abgestürzt – Server unberührt', 'crashed – server unaffected'], FAILED: ['Start fehlgeschlagen', 'start failed'], LOST: ['Prozess verschwunden', 'process lost'],
};
const HEALTH_TEXT = {
  HEALTHY: ['bereit (liest Spielereignisse)', 'ready (reading game events)'], STARTING: ['startet', 'starting'], DEGRADED: ['Fehler im B3-Log', 'errors in B3 log'],
  DOWN: ['nicht aktiv', 'not active'], UNKNOWN: ['Prozessidentität unklar', 'process identity unclear'],
};

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

export function InstanceB3Runtime({ instance, request, de }) {
  const [b3, setB3] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/instances/${encodeURIComponent(instance.id)}/b3`;
  async function run(action) {
    setBusy(true); setError('');
    try {
      if (action) {
        const response = await request(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
      }
      const response = await request(base);
      const data = await response.json();
      if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
      if (mounted.current) setB3(data.b3);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const running = b3?.runtime?.running;
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'B3 – Prozess' : 'B3 – process'}</summary>
    <p>{de ? 'B3 läuft als eigener Prozess, unabhängig vom CoD4x-Server: Ein B3-Absturz oder -Neustart beeinflusst den Server nicht und umgekehrt. Start nur mit erfüllten Abhängigkeiten (geprüftes eBc-B3, Python 2.7).' : 'B3 runs as its own process, independent of the CoD4x server: a B3 crash or restart does not affect the server and vice versa. Starts only with satisfied dependencies (audited eBc-B3, Python 2.7).'}</p>
    <button disabled={busy} onClick={() => run(null)}>{de ? 'Status laden' : 'Load status'}</button>
    <button disabled={busy || running} onClick={() => run('start')}>{de ? 'B3 starten' : 'Start B3'}</button>
    <button disabled={busy || !running} onClick={() => run('stop')}>{de ? 'B3 stoppen' : 'Stop B3'}</button>
    <button disabled={busy || !b3} onClick={() => run('restart')}>{de ? 'B3 neu starten' : 'Restart B3'}</button>
    {error && <p role="alert">{error}</p>}
    <B3RuntimeView b3={b3} de={de}/>
  </details>;
}
