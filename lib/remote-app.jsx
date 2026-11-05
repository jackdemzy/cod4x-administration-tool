import { useEffect, useState } from 'react';
import { MonitorDashboard } from './monitor-dashboard.jsx';

// Block 24b: the mobile web app behind the remote gateway. Login (password plus
// TOTP or a recovery code when required), then the read-only monitoring view of
// 24a. The session lives in an HttpOnly cookie; nothing is kept in web storage.
// Every screen links the source code (AGPL-3.0 §13).
const T = { bg: '#070b09', card: '#101915', border: '#26382f', text: '#e5eee8', muted: '#82938a', good: '#6bc47b', bad: '#d45c5c' };
const MESSAGES = {
  REMOTE_LOGIN_INVALID: 'Benutzername oder Passwort ungültig.',
  REMOTE_LOGIN_LOCKED: 'Zu viele Fehlversuche. Bitte später erneut versuchen.',
  REMOTE_ACCESS_DENIED: 'Für diesen Benutzer ist der Fernzugriff nicht freigeschaltet.',
  REMOTE_TOTP_SETUP_REQUIRED: 'Für diese Rolle ist ein zweiter Faktor Pflicht. Bitte zuerst im Admin-Tool einrichten.',
  REMOTE_TOTP_REQUIRED: 'Bitte den 6-stelligen Code aus der Authenticator-App eingeben.',
  REMOTE_TOTP_INVALID: 'Code ungültig oder schon benutzt.',
  REMOTE_ORIGIN_REFUSED: 'Anfrage abgelehnt (fremde Herkunft).',
  REMOTE_LOGIN_REQUIRED: 'Sitzung abgelaufen. Bitte neu anmelden.',
  PUSH_SERVICE_NOT_ALLOWED: 'Dieser Push-Dienst wird nicht unterstützt.',
  PUSH_UNAVAILABLE: 'Push ist auf dem Server nicht verfügbar.',
  PUSH_DENIED: 'Benachrichtigungen sind für diese Seite blockiert. In den Browser-Einstellungen erlauben.',
};
export const remoteMessage = code => MESSAGES[code] || code || 'Unbekannter Fehler.';

async function call(route, { method = 'GET', body } = {}) {
  const response = await fetch(route, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.code || `HTTP ${response.status}`), { code: data.code, status: response.status });
  return data;
}
// The dashboard asks for /api/monitor/...; the gateway serves /remote/api/monitor/...
export const remoteRoute = route => route.replace(/^\/api\/monitor\//, '/remote/api/monitor/');

const field = { width: '100%', padding: '12px 14px', fontSize: 16, background: '#080d0a', color: T.text, border: `1px solid ${T.border}`, borderRadius: 6 };
const button = { width: '100%', padding: '12px 14px', fontSize: 16, fontWeight: 700, background: '#173222', color: T.good, border: `1px solid ${T.good}66`, borderRadius: 6 };

export function SourceFooter({ info }) {
  return <footer style={{ marginTop: 24, paddingTop: 12, borderTop: `1px solid ${T.border}`, color: T.muted, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
    <span>COD4X CONTROL {info?.version || ''}</span>
    {info?.sourceUrl && <a href={info.sourceUrl} rel="noopener noreferrer" target="_blank" style={{ color: T.muted }}>Quellcode (AGPL-3.0)</a>}
  </footer>;
}

export function RemoteLogin({ onLogin, initialError = '' }) {
  const [form, setForm] = useState({ username: '', password: '', code: '' });
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { const data = await call('/remote/api/login', { method: 'POST', body: needCode ? form : { username: form.username, password: form.password } }); onLogin(data); }
    catch (failure) {
      if (failure.code === 'REMOTE_TOTP_REQUIRED') { setNeedCode(true); setError(remoteMessage(failure.code)); }
      else { setError(remoteMessage(failure.code)); if (failure.code === 'REMOTE_TOTP_INVALID') setForm(value => ({ ...value, code: '' })); }
    } finally { setBusy(false); }
  }
  return <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 380, margin: '0 auto' }}>
    <h1 style={{ fontSize: 20, margin: '8px 0', letterSpacing: '.08em' }}>COD4X MONITOR</h1>
    <label style={{ display: 'grid', gap: 6, fontSize: 13, color: T.muted }}>Benutzername<input style={field} autoComplete="username" autoCapitalize="none" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required /></label>
    <label style={{ display: 'grid', gap: 6, fontSize: 13, color: T.muted }}>Passwort<input style={field} type="password" autoComplete="current-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required /></label>
    {needCode && <label style={{ display: 'grid', gap: 6, fontSize: 13, color: T.muted }}>Code (Authenticator) oder Wiederherstellungscode<input style={field} autoComplete="one-time-code" inputMode="text" autoFocus value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} required /></label>}
    {error && <p role="alert" style={{ color: T.bad, fontSize: 14, margin: 0 }}>{error}</p>}
    <button type="submit" disabled={busy} style={button}>{busy ? '…' : 'Anmelden'}</button>
  </form>;
}

const base64UrlToBytes = text => { const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)); return Uint8Array.from(raw, char => char.charCodeAt(0)); };

// Block 24c: this device receives alerts as push messages. The browser keeps the
// subscription; the server stores it for this user only.
export function PushToggle({ supported = null }) {
  const [state, setState] = useState({ ready: false, supported, on: false, enabled: true, error: '' });
  const update = patch => setState(value => ({ ...value, ...patch }));
  useEffect(() => {
    const ok = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
    if (!ok) { update({ ready: true, supported: false }); return; }
    Promise.all([call('/remote/api/push/key'), navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription())])
      .then(([key, subscription]) => update({ ready: true, supported: true, enabled: key.enabled !== false, on: Boolean(subscription && key.mine) }))
      .catch(failure => update({ ready: true, supported: true, error: remoteMessage(failure.code) }));
  }, []);
  async function toggle() {
    update({ error: '' });
    try {
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (state.on) {
        if (current) { await call('/remote/api/push/unsubscribe', { method: 'POST', body: { endpoint: current.endpoint } }); await current.unsubscribe(); }
        update({ on: false }); return;
      }
      if (await Notification.requestPermission() !== 'granted') throw Object.assign(new Error('PUSH_DENIED'), { code: 'PUSH_DENIED' });
      const { publicKey } = await call('/remote/api/push/key');
      // A fresh subscription, so a changed server key never leaves a dead one behind.
      if (current) await current.unsubscribe();
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
      await call('/remote/api/push/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
      update({ on: true });
    } catch (failure) {
      // Server answers carry a string code; browser errors (DOMException) a number.
      update({ error: typeof failure.code === 'string' ? remoteMessage(failure.code) : `Push-Anmeldung fehlgeschlagen (${failure.name || 'Fehler'}${failure.message ? `: ${failure.message}` : ''}).` });
    }
  }
  if (!state.ready) return null;
  return <section style={{ marginTop: 16, padding: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.card, display: 'grid', gap: 8 }}>
    <strong style={{ fontSize: 14 }}>Benachrichtigungen</strong>
    {state.supported === false ? <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Dieser Browser kann keine Push-Nachrichten empfangen. Auf dem iPhone: ab iOS 16.4 die App über „Teilen → Zum Home-Bildschirm“ hinzufügen und von dort öffnen.</p> : <>
      <p style={{ margin: 0, fontSize: 13, color: T.muted }}>{state.on ? 'Dieses Gerät bekommt Alarme, wenn ein Server ausfällt oder wieder da ist.' : 'Alarme auf dieses Gerät schicken lassen.'}{state.enabled ? '' : ' (Push ist im Admin-Tool gerade ausgeschaltet.)'}</p>
      <button onClick={toggle} style={{ ...button, ...(state.on ? { background: 'transparent', color: T.muted, borderColor: T.border } : {}) }}>{state.on ? 'Push ausschalten' : 'Push aktivieren'}</button>
    </>}
    {state.error && <p role="alert" style={{ color: T.bad, fontSize: 14, margin: 0 }}>{state.error}</p>}
  </section>;
}

export function RemoteApp({ initialSession = null, initialInfo = null }) {
  const [session, setSession] = useState(initialSession);
  const [info, setInfo] = useState(initialInfo);
  const [checked, setChecked] = useState(Boolean(initialSession));
  const [expired, setExpired] = useState('');
  useEffect(() => {
    if (!initialInfo) call('/remote/api/info').then(setInfo).catch(() => {});
    if (!initialSession) call('/remote/api/me').then(setSession).catch(() => {}).finally(() => setChecked(true));
  }, []);
  const request = async route => {
    try { return await call(remoteRoute(route)); }
    catch (failure) { if (failure.status === 401) { setSession(null); setExpired(remoteMessage('REMOTE_LOGIN_REQUIRED')); } throw failure; }
  };
  async function logout() { await call('/remote/api/logout', { method: 'POST', body: {} }).catch(() => {}); setSession(null); }
  return <div style={{ minHeight: '100vh', background: T.bg, color: T.text, padding: 'max(16px, env(safe-area-inset-top)) 16px 24px', fontFamily: 'system-ui, sans-serif' }}>
    {session ? <>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <strong style={{ letterSpacing: '.08em' }}>COD4X MONITOR</strong>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, color: T.muted }}>{session.user?.username}<button onClick={logout} style={{ ...button, width: 'auto', padding: '6px 10px', fontSize: 13 }}>Abmelden</button></span>
      </header>
      {session.monitor === false ? <p>Keine Berechtigung für das Monitoring (monitor.read).</p> : <><MonitorDashboard de request={request} /><PushToggle /></>}
    </> : checked ? <RemoteLogin onLogin={data => { setExpired(''); setSession({ ...data, monitor: true }); }} initialError={expired} /> : <p style={{ color: T.muted }}>…</p>}
    <SourceFooter info={info} />
  </div>;
}
