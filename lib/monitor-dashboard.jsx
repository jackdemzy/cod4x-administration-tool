import { useEffect, useRef, useState } from 'react';

// Block 24a: local monitoring view. Polls the overview every 15 s while it is
// open; history and outages per server on demand. Read-only (monitor.read).
const T = {
  bg: '#0b120f', card: '#101915', border: '#26382f', text: '#e5eee8', muted: '#82938a',
  good: '#6bc47b', warn: '#d9a441', bad: '#d45c5c', line: '#7ca8c2',
};
const RANGES = ['24h', '7d', '30d'];
const label = (de, deText, enText) => de ? deText : enText;
const pct = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(value >= 0.999 || value === 0 ? 0 : 1)} %`;
const bytes = value => value === null || value === undefined ? '—' : value >= 1e12 ? `${(value / 1e12).toFixed(1)} TB` : `${(value / 1e9).toFixed(1)} GB`;
const clock = (t, de) => new Date(t).toLocaleString(de ? 'de-DE' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export function duration(ms, de) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${Math.round(h / 24)} ${label(de, 'Tage', 'days')}`;
}

export function serverState(server) {
  if (server.up) return { tone: 'good', de: 'Online', en: 'Online' };
  if (server.status === 'FAILED') return { tone: 'bad', de: 'Abgestürzt', en: 'Crashed' };
  if (server.down) return { tone: 'bad', de: 'Keine Antwort', en: 'Not answering' };
  if (server.status === 'RUNNING' || server.status === 'STARTING') return { tone: 'warn', de: 'Startet / Mapwechsel', en: 'Starting / map change' };
  return { tone: 'muted', de: 'Gestoppt', en: 'Stopped' };
}
const CAUSE = { crash: ['Absturz', 'Crash'], stopped: ['Gestoppt', 'Stopped'], unresponsive: ['Keine Antwort', 'Not answering'] };

const card = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 };
const pill = tone => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, color: T[tone] || T.muted, border: `1px solid ${T[tone] || T.muted}`, whiteSpace: 'nowrap' });
const small = { fontSize: 11, color: T.muted };

// Players per bucket as a line, unanswered buckets as red ticks under it.
export function HistoryChart({ history, de }) {
  const points = history?.points || [];
  if (!points.length) return <p style={small}>{label(de, 'Noch keine Daten für diesen Zeitraum.', 'No data for this period yet.')}</p>;
  const W = 640, H = 120, pad = 22, span = Math.max(1, history.end - history.start);
  const max = Math.max(1, ...points.map(point => point.players ?? 0));
  const x = t => pad + ((t - history.start) / span) * (W - 2 * pad);
  const y = value => H - pad - (value / max) * (H - 2 * pad);
  const path = points.filter(point => point.players !== null).map((point, index) => `${index ? 'L' : 'M'}${x(point.t).toFixed(1)} ${y(point.players).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label(de, 'Spielerzahl im Verlauf', 'Player count over time')} style={{ width: '100%', height: 'auto', display: 'block' }}>
    <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke={T.border} />
    <line x1={pad} x2={W - pad} y1={pad} y2={pad} stroke={T.border} strokeDasharray="3 4" />
    <text x={pad} y={pad - 6} fontSize="10" fill={T.muted}>{max}</text>
    <text x={pad} y={H - 6} fontSize="10" fill={T.muted}>{clock(history.start, de)}</text>
    <text x={W - pad} y={H - 6} fontSize="10" fill={T.muted} textAnchor="end">{clock(history.end, de)}</text>
    {points.filter(point => point.up < 1).map(point => <rect key={point.t} x={x(point.t) - 1} y={H - pad + 2} width="2" height="6" fill={point.up === 0 ? T.bad : T.warn} />)}
    {path && <path d={path} fill="none" stroke={T.line} strokeWidth="1.5" />}
  </svg>;
}

function ServerDetails({ server, request, de }) {
  const [range, setRange] = useState('24h');
  const [data, setData] = useState({ history: null, events: null });
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const base = `/api/monitor/instances/${encodeURIComponent(server.id)}`;
    (async () => {
      try {
        const [history, events] = await Promise.all([request(`${base}/history?range=${range}`), request(`${base}/events?range=${range}`)]);
        if (alive) { setData({ history: history.history, events: events.events }); setError(''); }
      } catch (failure) { if (alive) setError(failure.message); }
    })();
    return () => { alive = false; };
  }, [server.id, range]);
  return <div style={{ marginTop: 12 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      {RANGES.map(value => <button key={value} onClick={() => setRange(value)} aria-pressed={value === range} style={{ ...pill(value === range ? 'good' : 'muted'), background: 'transparent', cursor: 'pointer' }}>{value}</button>)}
      <span style={small}>{label(de, 'Erreichbarkeit', 'Availability')}: {pct(data.history?.availability)}</span>
    </div>
    {error && <p role="alert" style={{ color: T.bad, fontSize: 12 }}>{error}</p>}
    <HistoryChart history={data.history} de={de} />
    <div style={{ ...small, marginTop: 10, marginBottom: 4, fontWeight: 600 }}>{label(de, 'Ausfälle', 'Outages')}</div>
    {data.events && !data.events.some(event => event.kind === 'down') && <p style={small}>{label(de, 'Keine Ausfälle in diesem Zeitraum.', 'No outages in this period.')}</p>}
    {(data.events || []).filter(event => event.kind === 'down').map(event => <details key={`${event.t}-${event.kind}`} style={{ borderTop: `1px solid ${T.border}`, padding: '6px 0' }}>
      <summary style={{ fontSize: 12, cursor: 'pointer' }}>{clock(event.since || event.t, de)} · {(CAUSE[event.cause?.kind] || CAUSE.unresponsive)[de ? 0 : 1]}{event.cause?.exitCode !== null && event.cause?.exitCode !== undefined ? ` (Exit ${event.cause.exitCode})` : ''}</summary>
      {event.cause?.reason && <p style={{ fontSize: 12, margin: '6px 0', fontFamily: 'monospace' }}>{event.cause.reason}</p>}
      {event.cause?.hint && <p style={{ ...small, margin: '4px 0' }}>{event.cause.hint[de ? 0 : 1]}</p>}
      {!event.cause?.reason && event.cause?.clean && <p style={small}>{label(de, 'Normal beendet (kein Fehler im Konsolenlog).', 'Shut down normally (no error in the console log).')}</p>}
      {event.cause?.console?.length > 0 && <pre style={{ fontSize: 10.5, maxHeight: 180, overflow: 'auto', background: T.bg, padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{event.cause.console.join('\n')}</pre>}
    </details>)}
  </div>;
}

export function ServerCard({ server, request, de }) {
  const [open, setOpen] = useState(false);
  const state = serverState(server);
  return <div style={card}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 650, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{server.name}</div>
        <div style={small}>{server.hostname || '—'} · {label(de, 'Port', 'port')} {server.port}</div>
      </div>
      <span style={pill(state.tone)}>{state[de ? 'de' : 'en']}</span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginTop: 12 }}>
      <div><div style={small}>Map</div><div style={{ fontSize: 13 }}>{server.map || '—'}{server.gametype ? ` · ${server.gametype}` : ''}</div></div>
      <div><div style={small}>{label(de, 'Spieler', 'Players')}</div><div style={{ fontSize: 13 }}>{server.up ? `${server.players.length} / ${server.maxClients ?? '—'}` : '—'}</div></div>
      <div><div style={small}>{label(de, 'Antwortzeit', 'Latency')}</div><div style={{ fontSize: 13 }}>{server.latencyMs !== null ? `${server.latencyMs} ms` : '—'}</div></div>
      <div><div style={small}>{label(de, 'Läuft seit', 'Up for')}</div><div style={{ fontSize: 13 }}>{server.startedAt ? duration(server.checkedAt - Date.parse(server.startedAt), de) : '—'}</div></div>
      <div><div style={small}>B3</div><div style={{ fontSize: 13 }}>{server.b3 === true ? label(de, 'läuft', 'running') : server.b3 === false ? label(de, 'aus', 'off') : '—'}</div></div>
    </div>
    {server.up && server.players.length > 0 && <table style={{ width: '100%', marginTop: 10, fontSize: 12, borderCollapse: 'collapse' }}>
      <thead><tr style={small}><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'right' }}>Score</th><th style={{ textAlign: 'right' }}>Ping</th></tr></thead>
      <tbody>{server.players.map((player, index) => <tr key={`${index}-${player.name}`}><td>{player.name}</td><td style={{ textAlign: 'right' }}>{player.score}</td><td style={{ textAlign: 'right' }}>{player.ping}</td></tr>)}</tbody>
    </table>}
    <button onClick={() => setOpen(!open)} aria-expanded={open} style={{ marginTop: 10, background: 'transparent', color: T.line, border: 0, padding: 0, cursor: 'pointer', fontSize: 12 }}>{open ? label(de, 'Verlauf ausblenden', 'Hide history') : label(de, 'Verlauf und Ausfälle', 'History and outages')}</button>
    {open && <ServerDetails server={server} request={request} de={de} />}
  </div>;
}

export function HostSummary({ host, de }) {
  if (!host) return null;
  const disk = host.disks?.find(item => item.totalBytes);
  return <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12 }}>
    <span><span style={small}>CPU </span>{host.cpuPercent !== null ? `${host.cpuPercent} %` : '—'} <span style={small}>({host.cpuCount} {label(de, 'Kerne', 'cores')})</span></span>
    <span><span style={small}>RAM </span>{host.memory?.usedPercent ?? '—'} %</span>
    {disk && <span><span style={small}>{label(de, 'Frei', 'Free')} </span>{bytes(disk.freeBytes)} / {bytes(disk.totalBytes)}</span>}
  </div>;
}

// request(route) resolves to the parsed JSON body or throws with its error code.
export function MonitorDashboard({ request, de = true, initial = null, pollMs = 15000 }) {
  const [monitor, setMonitor] = useState(initial);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (initial) return () => { mounted.current = false; };
    const load = async () => {
      try { const data = await request('/api/monitor/overview'); if (mounted.current) { setMonitor(data.monitor); setError(''); } }
      catch (failure) { if (mounted.current) setError(failure.message); }
    };
    void load();
    const timer = setInterval(load, pollMs);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  const servers = monitor?.instances || [];
  return <div style={{ color: T.text, display: 'grid', gap: 12 }}>
    {error && <p role="alert" style={{ color: T.bad, fontSize: 12, margin: 0 }}>{error === 'Permission denied' ? label(de, 'Keine Berechtigung (monitor.read).', 'No permission (monitor.read).') : error}</p>}
    <div style={small}>{monitor?.checkedAt ? `${label(de, 'Zuletzt geprüft', 'Last checked')} ${clock(monitor.checkedAt, de)} · ${label(de, 'alle', 'every')} ${Math.round((monitor.intervalMs || 15000) / 1000)} s` : label(de, 'Erste Abfrage läuft …', 'First poll running ...')}</div>
    <HostSummary host={monitor?.host} de={de} />
    {monitor && !servers.length && <p style={small}>{label(de, 'Noch keine Serverinstanz angelegt.', 'No server instance yet.')}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 12 }}>
      {servers.map(server => <ServerCard key={server.id} server={server} request={request} de={de} />)}
    </div>
  </div>;
}
