import { useEffect, useState } from 'react';

// Block 24b: admin side of remote access. Every user sets up their own second
// factor (TOTP); admins switch the gateway on, choose the mode, see and revoke
// remote sessions. request(route, { method, body }) resolves to the JSON body or
// throws with the error code.
const T = { card: '#101915', code: '#080d0a', border: '#26382f', text: '#e5eee8', muted: '#82938a', good: '#6bc47b', warn: '#d9a441', bad: '#d45c5c' };
const box = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: 16, display: 'grid', gap: 10 };
const input = { background: T.code, color: T.text, border: `1px solid ${T.border}`, borderRadius: 4, padding: '7px 9px', fontSize: 12 };
const btn = { background: '#173222', color: T.good, border: `1px solid ${T.good}55`, borderRadius: 4, padding: '7px 11px', fontSize: 11, cursor: 'pointer' };
const small = { fontSize: 11, color: T.muted, margin: 0, lineHeight: 1.5 };
const mono = { fontFamily: 'monospace', fontSize: 12, color: T.text, wordBreak: 'break-all', background: T.code, border: `1px solid ${T.border}`, borderRadius: 4, padding: '6px 8px' };
const L = (de, a, b) => de ? a : b;
const when = (t, de) => t ? new Date(t).toLocaleString(de ? 'de-DE' : 'en-GB') : '—';
const ERRORS = { TOTP_INVALID: 'Code ungültig. Uhrzeit von Handy und Rechner prüfen.', TOTP_SETUP_EXPIRED: 'Einrichtung abgelaufen, bitte neu starten.', PASSWORD_INVALID: 'Passwort ungültig.', REMOTE_SETTINGS_INVALID: 'Einstellung ungültig.', REMOTE_TLS_REQUIRED: 'LAN-Modus braucht Zertifikat und Schlüssel (PEM).', REMOTE_HOST_INVALID: 'LAN-Adresse ungültig (IP-Adresse angeben).' };
const message = (failure, de) => (de && ERRORS[failure.code || failure.message]) || failure.message;

export function SecondFactorSection({ request, de = true, me, onChange = () => {} }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const run = async action => { setError(''); try { await action(); } catch (failure) { setError(message(failure, de)); } };
  const enabled = me?.totpEnabled;
  return <div style={box}>
    <strong style={{ fontSize: 12 }}>{L(de, 'Zweiter Faktor (Authenticator-App)', 'Second factor (authenticator app)')}</strong>
    <p style={small}>{L(de, 'Pflicht für Fernzugriff mit den Rollen admin und operator. Ohne zweiten Faktor sehen andere Rollen aus der Ferne keine Konsolenzeilen.', 'Required for remote access as admin or operator. Without it, other roles see no console lines remotely.')}</p>
    {codes ? <>
      <p style={{ ...small, color: T.warn }}>{L(de, 'Wiederherstellungscodes, je einmal nutzbar. Jetzt sicher aufbewahren, sie werden nicht noch einmal angezeigt.', 'Recovery codes, each works once. Store them now; they are not shown again.')}</p>
      <div style={{ ...mono, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>{codes.map(value => <span key={value}>{value}</span>)}</div>
      <button style={btn} onClick={() => setCodes(null)}>{L(de, 'Gespeichert', 'Saved')}</button>
    </> : enabled ? <>
      <p style={{ ...small, color: T.good }}>{L(de, `Eingerichtet · ${me.recoveryRemaining} Wiederherstellungscodes übrig`, `Enabled · ${me.recoveryRemaining} recovery codes left`)}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={input} type="password" placeholder={L(de, 'Passwort', 'Password')} value={password} onChange={e => setPassword(e.target.value)} />
        <button style={{ ...btn, color: T.bad, borderColor: `${T.bad}55`, background: 'transparent' }} onClick={() => run(async () => { await request('/api/auth/totp/disable', { method: 'POST', body: { password } }); setPassword(''); onChange(); })}>{L(de, 'Ausschalten', 'Disable')}</button>
      </div>
    </> : setup ? <>
      <p style={small}>{L(de, 'In der Authenticator-App ein Konto hinzufügen und diesen Schlüssel eintippen (zeitbasiert, 6 Stellen, 30 s) oder den Link auf dem Handy öffnen:', 'Add an account in the authenticator app with this key (time-based, 6 digits, 30 s) or open the link on the phone:')}</p>
      <div style={mono}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
      <a href={setup.uri} style={{ ...small, color: T.good, wordBreak: 'break-all' }}>{setup.uri}</a>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={input} inputMode="numeric" autoComplete="one-time-code" placeholder={L(de, '6-stelliger Code', '6-digit code')} value={code} onChange={e => setCode(e.target.value)} />
        <button style={btn} onClick={() => run(async () => { const data = await request('/api/auth/totp/confirm', { method: 'POST', body: { code } }); setCodes(data.recoveryCodes); setSetup(null); setCode(''); onChange(); })}>{L(de, 'Bestätigen', 'Confirm')}</button>
      </div>
    </> : <button style={btn} onClick={() => run(async () => setSetup(await request('/api/auth/totp/setup', { method: 'POST', body: {} })))}>{L(de, 'Einrichten', 'Set up')}</button>}
    {error && <p role="alert" style={{ ...small, color: T.bad }}>{error}</p>}
  </div>;
}

export function GatewaySection({ request, de = true, initial = null }) {
  const [remote, setRemote] = useState(initial);
  const [form, setForm] = useState(initial?.settings || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { try { const data = await request('/api/remote'); setRemote(data.remote); setForm(data.remote.settings); setError(''); } catch (failure) { setError(message(failure, de)); } };
  useEffect(() => { if (!initial) void load(); }, []);
  const run = async action => { setBusy(true); setError(''); try { const data = await action(); if (data?.remote) { setRemote(data.remote); setForm(data.remote.settings); } } catch (failure) { setError(message(failure, de)); } finally { setBusy(false); } };
  if (!remote || !form) return <div style={box}><p style={small}>{error || '…'}</p></div>;
  const state = remote.running ? [T.good, L(de, `Läuft auf ${remote.address?.host}:${remote.address?.port}`, `Running on ${remote.address?.host}:${remote.address?.port}`)]
    : remote.error ? [T.bad, `${L(de, 'Start fehlgeschlagen', 'Start failed')}: ${remote.error}`] : [T.muted, remote.disabledByEnvironment ? 'COD4X_REMOTE=off' : L(de, 'Aus', 'Off')];
  return <div style={box}>
    <strong style={{ fontSize: 12 }}>{L(de, 'Fern-Gateway (Browser / Handy)', 'Remote gateway (browser / phone)')}</strong>
    <p style={small}>{L(de, 'Ein eigener Zugang nur zum Monitoring (lesend). Die Admin-API bleibt lokal. Fernzugriff wird pro Benutzer unter „Benutzer & Rollen“ freigeschaltet.', 'A separate, read-only entry to monitoring. The admin API stays local. Remote access is granted per user under "Users & roles".')}</p>
    <p style={{ ...small, color: state[0] }}>● {state[1]}</p>
    {!remote.appBuilt && <p style={{ ...small, color: T.warn }}>{L(de, 'Die Web-App ist nicht gebaut (npm run build).', 'The web app is not built (npm run build).')}</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />{L(de, 'Eingeschaltet', 'Enabled')}</label>
      <select style={input} value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}><option value="tailscale">{L(de, 'Tailscale (empfohlen)', 'Tailscale (recommended)')}</option><option value="lan">{L(de, 'Heimnetz mit eigenem Zertifikat', 'LAN with own certificate')}</option></select>
      <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center' }}>Port<input style={{ ...input, width: 90 }} inputMode="numeric" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} /></label>
    </div>
    {form.mode === 'lan' && <div style={{ display: 'grid', gap: 6 }}>
      <input style={input} placeholder={L(de, 'LAN-Adresse, z. B. 192.168.1.20', 'LAN address, e.g. 192.168.1.20')} value={form.lanHost || ''} onChange={e => setForm({ ...form, lanHost: e.target.value })} />
      <input style={input} placeholder={L(de, 'Zertifikat (PEM, absoluter Pfad)', 'Certificate (PEM, absolute path)')} value={form.certFile || ''} onChange={e => setForm({ ...form, certFile: e.target.value })} />
      <input style={input} placeholder={L(de, 'Schlüssel (PEM, absoluter Pfad)', 'Key (PEM, absolute path)')} value={form.keyFile || ''} onChange={e => setForm({ ...form, keyFile: e.target.value })} />
    </div>}
    <div><button style={btn} disabled={busy} onClick={() => run(() => request('/api/remote/settings', { method: 'POST', body: { ...form, port: Number(form.port) } }))}>{L(de, 'Speichern', 'Save')}</button></div>
    {form.mode === 'tailscale' && <>
      <p style={small}>{L(de, 'Danach einmal auf diesem Rechner ausführen (HTTPS nur im eigenen Tailnet, kein offener Port):', 'Then run once on this machine (HTTPS inside your tailnet only, no open port):')}</p>
      <div style={mono}>{remote.tailscaleCommand}</div>
      <p style={small}>{L(de, 'Abschalten:', 'Turn off:')} <span style={{ fontFamily: 'monospace' }}>{remote.tailscaleOffCommand}</span>. {L(de, 'Auf dem Handy die angezeigte https://…ts.net-Adresse mit /remote/ öffnen und „Zum Startbildschirm“ wählen.', 'On the phone open the shown https://…ts.net address with /remote/ and choose "Add to home screen".')}</p>
    </>}
    <strong style={{ fontSize: 12, marginTop: 6 }}>{L(de, `Aktive Fern-Sitzungen (${remote.sessions.length})`, `Active remote sessions (${remote.sessions.length})`)}</strong>
    {remote.sessions.length ? <div style={{ display: 'grid', gap: 6 }}>
      {remote.sessions.map(session => <div key={session.sessionId} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', background: T.code, border: `1px solid ${T.border}`, borderRadius: 5, padding: '7px 9px' }}>
        <span style={{ ...small, color: T.text }}>{session.username} · {session.role}{session.mfa ? ' · 2FA' : ''} · {session.tailscaleUser || session.client} · {L(de, 'zuletzt', 'last')} {when(session.lastSeenAt, de)}</span>
        <button style={{ ...btn, color: T.bad, borderColor: `${T.bad}55`, background: 'transparent' }} onClick={() => run(() => request(`/api/remote/sessions/${encodeURIComponent(session.sessionId)}/revoke`, { method: 'POST', body: {} }))}>{L(de, 'Beenden', 'End')}</button>
      </div>)}
    </div> : <p style={small}>{L(de, 'Keine.', 'None.')}</p>}
    {error && <p role="alert" style={{ ...small, color: T.bad }}>{error}</p>}
  </div>;
}

export function RemoteAccessPanel({ request, de = true, isAdmin = false }) {
  const [me, setMe] = useState(null);
  const loadMe = async () => { try { setMe((await request('/api/auth/me')).user); } catch { /* not signed in */ } };
  useEffect(() => { void loadMe(); }, []);
  return <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
    <SecondFactorSection request={request} de={de} me={me} onChange={loadMe} />
    {isAdmin && <GatewaySection request={request} de={de} />}
  </div>;
}
