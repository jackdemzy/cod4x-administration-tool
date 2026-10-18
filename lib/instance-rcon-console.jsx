import { useEffect, useMemo, useRef, useState } from 'react';

// Integrated server console: live qconsole.log/runtime output plus RCON over
// the backend. No password field and no secret ever reaches this component.
const STATUS_LABELS = {
  de: { CONNECTED: 'Verbunden', DISCONNECTED: 'Getrennt', RECONNECTING: 'Verbinde neu …', AUTH_FAILED: 'Authentifizierung fehlgeschlagen', UNREACHABLE: 'Nicht erreichbar', NOT_PROVISIONED: 'RCON in diesem Lauf nicht aktiv', OFFLINE: 'Server läuft nicht' },
  en: { CONNECTED: 'Connected', DISCONNECTED: 'Disconnected', RECONNECTING: 'Reconnecting …', AUTH_FAILED: 'Authentication failed', UNREACHABLE: 'Unreachable', NOT_PROVISIONED: 'RCON not active in this run', OFFLINE: 'Server not running' },
};
const PROVISIONING = {
  de: { PROVISIONED: 'Passwort beim Start übergeben', NOT_CONFIGURED: 'Kein RCON-Passwort im Tresor', VAULT_LOCKED: 'Tresor war beim Start gesperrt', VAULT_UNAVAILABLE: 'Tresor nicht verfügbar', UNKNOWN: 'Übergabe unbekannt (Backend neu gestartet?)' },
  en: { PROVISIONED: 'Password passed at start', NOT_CONFIGURED: 'No RCON password in vault', VAULT_LOCKED: 'Vault was locked at start', VAULT_UNAVAILABLE: 'Vault unavailable', UNKNOWN: 'Transfer unknown (backend restarted?)' },
};
const severity = line => /\b(?:error|fatal|failed|exception)\b/i.test(line) ? 'error' : /\b(?:warn(?:ing)?|bad rcon)\b/i.test(line) ? 'warn' : 'info';
const COLORS = { error: '#ef4444', warn: '#f59e0b', info: 'inherit' };
// "Clear" hides what was visible; the 64 KiB live window may have shifted since.
function afterClear(text, cleared) {
  if (!cleared) return text;
  if (text.startsWith(cleared)) return text.slice(cleared.length);
  const last = cleared.trimEnd().split('\n').at(-1);
  const index = last ? text.lastIndexOf(last + '\n') : -1;
  return index < 0 ? text : text.slice(index + last.length + 1);
}

export function buildConsoleExport({ instance, rcon, lines }) {
  const header = [`# COD4X CONTROL console export`, `# instance=${instance.id} port=${instance.port} exportedAt=${new Date().toISOString()}`, `# rcon=${rcon?.status || 'UNKNOWN'} provisioning=${rcon?.provisioning || 'UNKNOWN'}`, ''];
  return header.concat(lines.map(line => `${line.at || '-'}\t${line.source}\t${line.text}`)).join('\n') + '\n';
}

export function InstanceRconConsole({ instance, request, de }) {
  const lang = de ? 'de' : 'en';
  const [rcon, setRcon] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [command, setCommand] = useState(''), [filter, setFilter] = useState(''), [source, setSource] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true), [cleared, setCleared] = useState(null);
  const commandHistory = useRef([]), historyIndex = useRef(-1), output = useRef(null), mounted = useRef(true), autoConnectedRun = useRef(null);
  const running = instance.runtime?.status === 'RUNNING' && Boolean(instance.runtime?.pid);
  const route = `/api/instances/${encodeURIComponent(instance.id)}/rcon`;
  async function call(path, body) {
    const response = await request(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.code || 'RCON_FAILED'), { code: data.code || 'RCON_FAILED', rcon: data.rcon });
    return data;
  }
  async function refresh() {
    try { const data = await call(route); if (mounted.current) setRcon(data.rcon); }
    catch (failure) { if (mounted.current) setError(failure.code); }
  }
  async function connect() {
    if (busy) return;
    setBusy(true); setError('');
    try { const data = await call(`${route}/connect`, {}); if (mounted.current) setRcon(data.rcon); }
    catch (failure) { if (mounted.current) { setError(failure.code); if (failure.rcon) setRcon(failure.rcon); else await refresh(); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function send(event) {
    event?.preventDefault();
    const value = command.trim();
    if (!value || busy) return;
    commandHistory.current = [value, ...commandHistory.current.filter(entry => entry !== value)].slice(0, 50);
    historyIndex.current = -1;
    setBusy(true); setError(''); setCommand('');
    try { const data = await call(`${route}/command`, { command: value }); if (mounted.current) setRcon(data.result.rcon); }
    catch (failure) { if (mounted.current) { setError(failure.code); await refresh(); } }
    finally { if (mounted.current) setBusy(false); }
  }
  function onKeyDown(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const list = commandHistory.current;
    historyIndex.current = event.key === 'ArrowUp' ? Math.min(historyIndex.current + 1, list.length - 1) : Math.max(historyIndex.current - 1, -1);
    setCommand(historyIndex.current < 0 ? '' : list[historyIndex.current] || '');
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [instance.id]);
  // One automatic connect per verified run; further attempts are explicit.
  useEffect(() => {
    if (!running || !rcon || rcon.provisioning !== 'PROVISIONED' || rcon.status !== 'DISCONNECTED' || autoConnectedRun.current === instance.runtime.runId) return;
    autoConnectedRun.current = instance.runtime.runId;
    void connect();
  }, [running, rcon?.status, rcon?.provisioning, instance.runtime?.runId]);
  const lines = useMemo(() => {
    const result = [];
    for (const text of afterClear(String(instance.consoleLog?.text || ''), cleared?.server).split('\n')) if (text) result.push({ source: 'server', at: null, text });
    for (const text of afterClear(String(instance.runtime?.output?.stdout || ''), cleared?.runtime).split('\n')) if (text) result.push({ source: 'runtime', at: null, text });
    for (const entry of [...(rcon?.history || [])].reverse()) {
      if (cleared && entry.at <= cleared.at) continue;
      result.push({ source: 'rcon', at: entry.at, text: `> ${entry.command}${entry.ok ? '' : ` [${entry.code}]`}` });
      for (const text of String(entry.response || '').split('\n')) if (text) result.push({ source: 'rcon', at: entry.at, text });
    }
    const needle = filter.toLowerCase();
    return result.filter(line => (source === 'all' || line.source === source) && (!needle || line.text.toLowerCase().includes(needle)));
  }, [instance.consoleLog?.text, instance.runtime?.output?.stdout, rcon?.history, filter, source, cleared]);
  useEffect(() => { if (autoScroll && output.current) output.current.scrollTop = output.current.scrollHeight; }, [lines, autoScroll]);
  function exportLog() {
    const blob = new Blob([buildConsoleExport({ instance, rcon, lines })], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = `cod4x-console-${instance.id}-${Date.now()}.log`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  async function copy() { try { await navigator.clipboard.writeText(lines.map(line => line.text).join('\n')); } catch { setError('CLIPBOARD_UNAVAILABLE'); } }
  const status = rcon?.status || 'DISCONNECTED';
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'Server-Konsole · RCON' : 'Server console · RCON'} · {STATUS_LABELS[lang][status] || status}</summary>
    <p>{de ? 'RCON nur über 127.0.0.1:' : 'RCON via 127.0.0.1:'}{instance.port}. {PROVISIONING[lang][rcon?.provisioning || 'UNKNOWN']}. {de ? 'Erlaubt sind nur kontrollierte Befehle; der Server läuft unabhängig von dieser Konsole weiter.' : 'Only controlled commands are allowed; the server keeps running independently of this console.'}</p>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span role="status">{STATUS_LABELS[lang][status] || status}{rcon?.latencyMs != null ? ` · ${rcon.latencyMs} ms` : ''}{rcon?.failures ? ` · ${de ? 'Fehlversuche' : 'failures'} ${rcon.failures}` : ''}{rcon?.server?.mapname ? ` · ${rcon.server.mapname}` : ''}</span>
      <button type="button" disabled={busy || !running} onClick={connect}>{status === 'CONNECTED' ? (de ? 'Verbindung prüfen' : 'Check connection') : 'Reconnect'}</button>
    </div>
    {error && <p role="alert">{de ? 'RCON-Vorgang nicht bestätigt: ' : 'RCON operation not confirmed: '}{error}</p>}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      <input aria-label={de ? 'Filter' : 'Filter'} placeholder={de ? 'Filter' : 'Filter'} value={filter} onChange={event => setFilter(event.target.value)} />
      <select aria-label={de ? 'Quelle' : 'Source'} value={source} onChange={event => setSource(event.target.value)}>
        <option value="all">{de ? 'Alle' : 'All'}</option><option value="server">qconsole.log</option><option value="runtime">Runtime</option><option value="rcon">RCON</option>
      </select>
      <label><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} /> Auto-Scroll</label>
      <button type="button" onClick={copy}>{de ? 'Kopieren' : 'Copy'}</button>
      <button type="button" onClick={() => setCleared({ at: new Date().toISOString(), server: String(instance.consoleLog?.text || ''), runtime: String(instance.runtime?.output?.stdout || '') })}>{de ? 'Leeren' : 'Clear'}</button>
      <button type="button" onClick={exportLog}>{de ? 'Log exportieren' : 'Export log'}</button>
    </div>
    <pre ref={output} style={{ maxHeight: 280, overflow: 'auto', fontSize: 10, whiteSpace: 'pre-wrap' }}>
      {lines.map((line, index) => <div key={index} style={{ color: COLORS[severity(line.text)] }}>{line.at ? `[${line.at.slice(11, 19)}] ` : ''}[{line.source}] {line.text}</div>)}
    </pre>
    <form onSubmit={send} style={{ display: 'flex', gap: 6 }}>
      <input aria-label={de ? 'RCON-Befehl' : 'RCON command'} list={`rcon-commands-${instance.id}`} autoComplete="off" spellCheck={false} maxLength={96} value={command}
        onChange={event => setCommand(event.target.value)} onKeyDown={onKeyDown} disabled={busy || !running} placeholder="status" style={{ flex: 1 }} />
      <datalist id={`rcon-commands-${instance.id}`}>{(rcon?.commands || []).map(entry => <option key={entry.name} value={entry.name === 'map' ? 'map ' : entry.name}>{entry.usage}</option>)}</datalist>
      <button type="submit" disabled={busy || !running || !command.trim()}>{de ? 'Senden' : 'Send'}</button>
    </form>
    <small>{de ? 'Erlaubt: ' : 'Allowed: '}{(rcon?.commands || []).map(entry => entry.usage).join(', ') || 'status, serverinfo, systeminfo, map_rotate, map <mapname>'}. {de ? 'Enter sendet, ↑/↓ blättert in der Befehlshistorie.' : 'Enter sends, ↑/↓ browses command history.'}</small>
  </details>;
}
