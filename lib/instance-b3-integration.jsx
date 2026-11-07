import { useEffect, useRef, useState } from 'react';
import { B3_HIDE_LEVELS, B3_LEVEL_NAMES, B3_PREFIX_CHARS } from './b3-integration-constants.mjs';
import { b3IntegrationMessage } from './b3-integration-messages.mjs';
import { B3_PLUGIN_MESSAGES } from './b3-plugin-messages.mjs';

// Block 16: "CoD4x connection" section of the B3 view. One switch wires the
// b3hide core plugin and the eBc-B3 auth plugin together; !auth passwords are
// write-only (the API returns levels, never values).
const RESTART_TEXT = {
  server: { SETTINGS_CHANGED: ['Server neu starten: Einstellungen seit dem Start geändert.', 'Restart the server: settings changed since the start.'], CREDENTIALS_CHANGED: ['Server neu starten: Zugangsdaten seit dem Start geändert.', 'Restart the server: credentials changed since the start.'] },
  b3: { SETTINGS_CHANGED: ['B3 neu starten: Einstellungen seit dem Start geändert.', 'Restart B3: settings changed since the start.'], CREDENTIALS_CHANGED: ['B3 neu starten: Zugangsdaten seit dem Start geändert.', 'Restart B3: credentials changed since the start.'], PLUGINS_CHANGED: B3_PLUGIN_MESSAGES.PLUGINS_CHANGED },
};
// A restart code this view does not know is shown as the code, never thrown on.
const restartText = (kind, code, de) => RESTART_TEXT[kind]?.[code]?.[de ? 0 : 1] ?? String(code);
const levelLabel = level => `${level} – ${B3_LEVEL_NAMES[level]}`;

export function B3IntegrationPanel({ data, canManage, de, busy, onSave, onSetPassword }) {
  const [form, setForm] = useState(() => ({ ...data.settings }));
  const [passwords, setPasswords] = useState({});
  const lang = de ? 'de' : 'en';
  const locked = busy || !canManage;
  const vaultClosed = !data.vault?.initialized || data.vault?.locked;
  const hints = Object.entries(data.restart || {}).filter(([, code]) => code).map(([kind, code]) => restartText(kind, code, de));
  const requirement = (ok, label) => <li>{ok ? '✔' : '✖'} {label}</li>;
  const codes = new Set((data.plan?.blockers || []).map(entry => entry.code));
  return <fieldset>
    <legend>{de ? 'CoD4x-Verbindung (b3hide + auth)' : 'CoD4x connection (b3hide + auth)'}</legend>
    <label><input type="checkbox" checked={form.hideCommands} disabled={locked} onChange={event => setForm({ ...form, hideCommands: event.target.checked })}/> {de ? 'B3-Befehle ausblenden' : 'Hide B3 commands'}</label>
    <label style={{ marginLeft: 8 }}>Prefix <input type="text" maxLength={1} size={2} value={form.prefix} readOnly disabled title={de ? `B3-Befehls-Prefix (${B3_PREFIX_CHARS}) aus plugin_admin.ini` : `B3 command prefix (${B3_PREFIX_CHARS}) from plugin_admin.ini`}/></label>
    <label style={{ marginLeft: 8 }}>{de ? 'Ausblenden ab Level' : 'Hide from level'} <select value={form.hideLevel} disabled={locked} onChange={event => setForm({ ...form, hideLevel: Number(event.target.value) })}>
      {B3_HIDE_LEVELS.map(level => <option key={level} value={level}>{levelLabel(level)}</option>)}
    </select></label>
    <button disabled={locked} onClick={() => onSave(form)}>{de ? 'Speichern (Server und B3 gestoppt)' : 'Save (server and B3 stopped)'}</button>
    <ul aria-label={de ? 'Voraussetzungen' : 'Requirements'}>
      {requirement(!['B3HIDE_MISSING', 'B3HIDE_NOT_APPROVED', 'B3HIDE_INTEGRITY_FAILED', 'B3HIDE_WRONG_PLATFORM'].some(code => codes.has(code)) && Boolean(data.b3hide), de ? 'b3hide vorhanden und freigegeben' : 'b3hide present and approved')}
      {requirement(!codes.has('RCON_PASSWORD_MISSING') && !(data.plan?.warnings || []).some(entry => entry.code === 'RCON_PASSWORD_MISSING'), de ? 'RCON-Passwort im Tresor' : 'RCON password in the vault')}
      {requirement(!codes.has('B3_AUTH_PLUGIN_MISSING'), de ? 'B3-Plugin auth vorhanden' : 'B3 auth plugin present')}
      {requirement(!codes.has('B3_COMMAND_PREFIX_MISMATCH'), de ? 'B3-Befehls-Prefix ist „!“ (plugin_admin.ini)' : 'B3 command prefix is "!" (plugin_admin.ini)')}
      {requirement(!vaultClosed, de ? 'Tresor entsperrt' : 'vault unlocked')}
    </ul>
    {data.knownHash && <p>{de ? 'b3hide entspricht dem CoD4x-21.2-Release (Freigabe trotzdem selbst prüfen).' : 'b3hide matches the CoD4x 21.2 release (approval is still yours).'}</p>}
    {(data.plan?.blockers || []).length > 0 && <ul role="alert">{data.plan.blockers.map(entry => <li key={entry.code}>{b3IntegrationMessage(entry.code, lang)}</li>)}</ul>}
    {(data.plan?.warnings || []).map(entry => <p key={entry.code}>{b3IntegrationMessage(entry.code, lang)}</p>)}
    {data.settings?.hideCommands && <p role="note">{b3IntegrationMessage('B3_OTHER_PREFIXES_VISIBLE', lang)}</p>}
    {hints.length > 0 && <ul role="status">{hints.map(text => <li key={text}>{text}</li>)}</ul>}
    <table>
      <caption>{de ? '!auth-Passwörter pro Level (optional)' : '!auth passwords per level (optional)'}</caption>
      <tbody>{B3_HIDE_LEVELS.map(level => {
        const set = (data.authLevels || []).includes(level);
        // b3hide only hides chat at or above the hide level; a lower level's password would be public.
        const below = level < form.hideLevel;
        return <tr key={level} title={below ? b3IntegrationMessage('B3_AUTH_LEVEL_BELOW_HIDE', lang) : undefined}>
          <td>{levelLabel(level)}</td>
          <td>{set ? (de ? 'gesetzt' : 'set') : (de ? 'nicht gesetzt' : 'not set')}</td>
          <td><input type="password" autoComplete="new-password" minLength={4} maxLength={64} aria-label={`${levelLabel(level)} !auth`} disabled={locked || vaultClosed || below}
            value={passwords[level] || ''} onChange={event => setPasswords({ ...passwords, [level]: event.target.value })}/></td>
          <td><button disabled={locked || vaultClosed || below || !passwords[level]} onClick={() => { onSetPassword(level, passwords[level]); setPasswords({ ...passwords, [level]: '' }); }}>{de ? 'Setzen' : 'Set'}</button>
            <button disabled={locked || vaultClosed || !set} onClick={() => onSetPassword(level, null)}>{de ? 'Entfernen' : 'Remove'}</button></td>
        </tr>;
      })}</tbody>
    </table>
  </fieldset>;
}

export function InstanceB3Integration({ instance, request, de }) {
  const [data, setData] = useState(null), [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/instances/${encodeURIComponent(instance.id)}/b3/integration`;
  async function call(route, body) {
    const response = await request(route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code || `HTTP ${response.status}`);
    return result;
  }
  async function run(task, done) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await task();
      if (mounted.current) { setData(result.integration); if (done) setMessage(done); }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const load = () => run(async () => {
    const me = await call('/api/rbac/me');
    if (mounted.current) setCanManage(me.permissions?.includes('config.manage') === true);
    return call(base);
  });
  const saved = de ? 'Gespeichert; wirksam beim nächsten Start von Server und B3.' : 'Saved; effective on the next server and B3 start.';
  return <details style={{ marginTop: 12 }} onToggle={event => { if (event.currentTarget.open && !data) void load(); }}>
    <summary>{de ? 'CoD4x-Verbindung (b3hide)' : 'CoD4x connection (b3hide)'}</summary>
    {error && <p role="alert">{b3IntegrationMessage(error, de ? 'de' : 'en')}</p>}
    {message && <p role="status">{message}</p>}
    {data && <B3IntegrationPanel key={JSON.stringify(data.settings)} data={data} canManage={canManage} de={de} busy={busy}
      onSave={form => run(() => call(base, form), saved)}
      onSetPassword={(level, value) => run(() => call(`${base}/auth-password`, { level, value, expectedSha256: data.vault?.sha256 ?? null }), saved)}/>}
  </details>;
}
