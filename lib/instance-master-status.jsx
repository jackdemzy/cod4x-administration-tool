import { useEffect, useRef, useState } from 'react';

const REASONS = {
  SERVER_STOPPED: ['Server gestoppt. Der Token wird beim nächsten Start übergeben (Tresor muss entsperrt sein).', 'Server stopped. The token is passed on the next start (vault must be unlocked).'],
  MASTER_TOKEN_NOT_CONFIGURED: ['Kein Master-Token hinterlegt. Der Server läuft lokal normal, wird aber nicht gelistet.', 'No master token stored. The server runs locally as usual but is not listed.'],
  VAULT_LOCKED: ['Tresor gesperrt – Token-Status unbekannt.', 'Vault locked – token state unknown.'],
  VAULT_LOCKED_AT_START: ['Tresor war beim Start gesperrt; dieser Lauf hat keinen Token erhalten.', 'Vault was locked at start; this run received no token.'],
  RUN_TRANSFER_UNKNOWN: ['Für diesen Lauf ist keine Token-Übergabe belegt (z. B. nach Backend-Neustart).', 'No token transfer is recorded for this run (e.g. after a backend restart).'],
  LOOPBACK_BINDING: ['Token übergeben, aber der Server ist nur an 127.0.0.1/::1 gebunden. CoD4x sendet von Loopback-Adressen keinen Master-Heartbeat – eine Listung ist so nicht möglich.', 'Token passed, but the server is bound to 127.0.0.1/::1 only. CoD4x sends no master heartbeat from loopback addresses – listing is not possible this way.'],
  MASTER_TOKEN_INVALID: ['Masterserver meldet: sv_authtoken ist ungültig. Neuer Versuch durch CoD4x erst nach 1 Stunde.', 'Master server reports: sv_authtoken is invalid. CoD4x retries only after 1 hour.'],
  MASTER_TOKEN_MISSING: ['CoD4x meldet einen fehlenden Token.', 'CoD4x reports a missing token.'],
  MASTER_ADDRESS_BANNED: ['Masterserver meldet: Serveradresse gesperrt.', 'Master server reports: server address banned.'],
  MASTER_REJECTED: ['Masterserver hat die Registrierung abgelehnt.', 'Master server rejected the registration.'],
  MASTER_TIMEOUT: ['Zeitüberschreitung bei der Verbindung zum Masterserver.', 'Connection to the master server timed out.'],
  MASTER_RESPONSE_INVALID: ['Ungültige oder leere Antwort vom Masterserver.', 'Invalid or empty response from the master server.'],
  MASTER_UNRESOLVED: ['Masterserver-Adresse konnte nicht aufgelöst werden.', 'Master server address could not be resolved.'],
  MASTER_TOKEN_REQUESTED: ['Masterserver fordert den Token an – Registrierung läuft.', 'Master server requests the token – registration in progress.'],
  MASTER_TOKEN_DATABASE_PENDING: ['Masterserver hat seine Token-Datenbank noch nicht geladen; CoD4x versucht es in 5 Minuten erneut.', 'Master server has not loaded its token database yet; CoD4x retries in 5 minutes.'],
  MASTER_CHALLENGE_RETRY: ['Challenge abgelehnt – CoD4x wiederholt.', 'Challenge rejected – CoD4x retries.'],
  MASTER_HEARTBEAT_SENT: ['Heartbeat gesendet, Antwort ausstehend.', 'Heartbeat sent, response pending.'],
  MASTER_AWAITING_RESPONSE: ['Warte auf Masterserver-Antwort.', 'Waiting for the master server response.'],
  MASTER_REGISTERED: ['CoD4x meldet die Registrierung. Die tatsächliche Listung bestätigt erst die Master-List-Prüfung.', 'CoD4x reports the registration. Only the master list check confirms the actual listing.'],
  MASTER_LIST_ALIVE: ['In der offiziellen Master-Liste gelistet, Heartbeat aktiv.', 'Listed on the official master list, heartbeat alive.'],
  MASTER_LIST_DEAD: ['In der Master-Liste vorhanden, aber als „dead“ markiert – Heartbeat fehlt.', 'Present on the master list but marked “dead” – heartbeat missing.'],
  MASTER_LIST_MISSING: ['War in diesem Lauf gelistet, ist jetzt nicht mehr in der Master-Liste.', 'Was listed during this run, now missing from the master list.'],
  MASTER_LIST_NOT_LISTED: ['Nicht in der Master-Liste. Mögliche Ursachen: Token ungültig, NAT/Firewall (UDP-Port nicht weitergeleitet), Heartbeat noch ausstehend (bis zu 3 Minuten).', 'Not on the master list. Possible causes: invalid token, NAT/firewall (UDP port not forwarded), heartbeat still pending (up to 3 minutes).'],
  MASTER_LIST_PORT_MISMATCH: ['Ein Server mit gleicher Identität ist unter einem anderen Port gelistet – Port-Weiterleitung bzw. net_port prüfen.', 'A server with the same identity is listed on a different port – check port forwarding / net_port.'],
  MASTER_LIST_AMBIGUOUS: ['Mehrere passende Einträge – öffentliche Adresse hinterlegen, um eindeutig zu prüfen.', 'Several matching entries – set the public address for an unambiguous check.'],
  MASTER_LIST_UNREACHABLE: ['Master-Liste nicht erreichbar.', 'Master list unreachable.'],
  MASTER_LIST_INVALID: ['Master-Liste lieferte ungültige Daten.', 'Master list returned invalid data.'],
  SERVER_NOT_RUNNING: ['Server läuft nicht – Prüfung nicht möglich.', 'Server is not running – check not possible.'],
};
const mark = value => value === true ? '✓' : value === false ? '✗' : '–';

export function MasterListSummary({ master, de }) {
  if (!master?.summary) return null;
  const { summary, list } = master;
  return <table>
    <tbody>
      <tr><th>Registration</th><td>{mark(summary.registration)}</td></tr>
      <tr><th>Heartbeat</th><td>{mark(summary.heartbeat)}</td></tr>
      <tr><th>Listed</th><td>{mark(summary.listed)}{list?.matchedBy && <> ({list.matchedBy === 'ADDRESS' ? (de ? 'über Adresse' : 'by address') : (de ? 'über Serveridentität' : 'by server identity')})</>}</td></tr>
      <tr><th>Last seen</th><td>{summary.lastSeenAt || '–'}</td></tr>
      {list && <tr><th>{de ? 'Geprüft' : 'Checked'}</th><td>{list.checkedAt}{list.masterTime && <> · Master: {list.masterTime}</>}</td></tr>}
      {list?.entry && <tr><th>{de ? 'Eintrag' : 'Entry'}</th><td>{list.entry.hostname} · {list.entry.addresses.map(address => `${address.ip}:${address.port} (${address.state})`).join(', ')}</td></tr>}
      {list?.listedPorts?.length > 0 && <tr><th>{de ? 'Gelistete Ports' : 'Listed ports'}</th><td>{list.listedPorts.join(', ')}</td></tr>}
    </tbody>
  </table>;
}

export function NetworkExposureEditor({ instance, request, de, onChanged }) {
  const current = instance.network || { scope: 'LOOPBACK', publicAddress: null };
  const [scope, setScope] = useState(current.scope), [address, setAddress] = useState(current.publicAddress || ''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const active = Boolean(instance.runtime?.pid || ['STARTING', 'RUNNING', 'STOPPING'].includes(instance.runtime?.status));
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const body = scope === 'PUBLIC' ? { scope, publicAddress: address.trim() || null, confirm: confirmed ? 'PUBLIC_EXPOSURE' : undefined } : { scope };
      const response = await request(`/api/instances/${encodeURIComponent(instance.id)}/network`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
      setMessage(de ? 'Netzwerkbindung gespeichert; wirksam beim nächsten Start.' : 'Network binding saved; effective on next start.');
      setConfirmed(false);
      onChanged?.(data.network);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <fieldset>
    <legend>{de ? 'Netzwerkbindung' : 'Network binding'}: {current.scope}</legend>
    <label><input type="radio" name={`scope-${instance.id}`} checked={scope === 'LOOPBACK'} disabled={busy || active} onChange={() => setScope('LOOPBACK')}/> {de ? 'Nur lokal (127.0.0.1 / ::1, Standard)' : 'Local only (127.0.0.1 / ::1, default)'}</label>
    <label><input type="radio" name={`scope-${instance.id}`} checked={scope === 'PUBLIC'} disabled={busy || active} onChange={() => setScope('PUBLIC')}/> {de ? 'Öffentlich (0.0.0.0 / ::)' : 'Public (0.0.0.0 / ::)'}</label>
    {scope === 'PUBLIC' && <>
      <p role="alert">{de ? 'Achtung: Der Server – einschließlich RCON auf demselben UDP-Port – wird aus allen Netzen erreichbar, die zu diesem Rechner routen. Firewall, Port-Weiterleitung und ein starkes RCON-Passwort liegen in Ihrer Verantwortung.' : 'Warning: the server – including RCON on the same UDP port – becomes reachable from every network that routes to this machine. Firewall, port forwarding and a strong RCON password are your responsibility.'}</p>
      <label>{de ? 'Erwartete öffentliche Adresse (optional, für eindeutige Prüfung)' : 'Expected public address (optional, for an unambiguous check)'} <input type="text" value={address} maxLength={64} disabled={busy || active} onChange={event => setAddress(event.target.value)}/></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy || active} onChange={event => setConfirmed(event.target.checked)}/> {de ? 'Ich will diese Instanz bewusst öffentlich erreichbar machen.' : 'I deliberately want to make this instance publicly reachable.'}</label>
    </>}
    <button disabled={busy || active || (scope === 'PUBLIC' && !confirmed)} onClick={save}>{de ? 'Bindung speichern' : 'Save binding'}</button>
    {active && <p>{de ? 'Nur bei gestopptem Server änderbar.' : 'Only changeable while the server is stopped.'}</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </fieldset>;
}

export function MasterStatusView({ master, de }) {
  if (!master) return null;
  const text = REASONS[master.reason] || [master.reason, master.reason];
  const failed = master.state === 'REGISTRATION_FAILED';
  return <div>
    <p role={failed ? 'alert' : 'status'}>{de ? 'Master-Status' : 'Master state'}: <strong>{master.state}</strong> – {text[de ? 0 : 1]}</p>
    <p>{de ? 'Token' : 'Token'}: {master.tokenConfigured === true ? (de ? 'hinterlegt' : 'stored') : master.tokenConfigured === false ? (de ? 'nicht hinterlegt' : 'not stored') : (de ? 'unbekannt' : 'unknown')}
      {master.transfer && <> · {de ? 'Übergabe an diesen Lauf' : 'Transfer to this run'}: {master.transfer}</>}
      {' · '}{de ? 'Netzwerk' : 'Network'}: {master.networkScope}
      {' · '}{de ? 'Listung verifiziert' : 'Listing verified'}: {master.verified ? (de ? 'ja' : 'yes') : (de ? 'nein' : 'no')}</p>
    <MasterListSummary master={master} de={de}/>
  </div>;
}

export function InstanceMasterStatus({ instance, request, de }) {
  const [master, setMaster] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [network, setNetwork] = useState(instance.network || null);
  async function load(verify = false) {
    setBusy(true); setError('');
    try {
      const response = await request(`/api/instances/${encodeURIComponent(instance.id)}/master${verify ? '/verify' : ''}`, verify ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : undefined);
      const data = await response.json();
      if (!response.ok) throw new Error(data.code || data.error || `HTTP ${response.status}`);
      if (mounted.current) setMaster(data.master);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'Master Server / Token' : 'Master server / token'}</summary>
    <p>{de ? 'Der Master-Token ist optional: Ohne Token startet und läuft der Server lokal normal. Token einrichten/entfernen erfolgt im Credential-Bereich.' : 'The master token is optional: without a token the server starts and runs locally as usual. Set up / remove the token in the credential section.'}</p>
    <NetworkExposureEditor instance={{ ...instance, network: network || instance.network }} request={request} de={de} onChanged={setNetwork}/>
    <button disabled={busy} onClick={() => load(false)}>{de ? 'Status prüfen' : 'Check status'}</button>
    <button disabled={busy} onClick={() => load(true)}>{de ? 'Master-Liste prüfen' : 'Check master list'}</button>
    <p>{de ? '„Master-Liste prüfen“ ruft einmalig https://cod4master.cod4x.ovh/serverstatus.json ab und vergleicht Adresse/Port bzw. Serveridentität.' : '“Check master list” fetches https://cod4master.cod4x.ovh/serverstatus.json once and compares address/port or server identity.'}</p>
    {error && <p role="alert">{error}</p>}
    <MasterStatusView master={master} de={de}/>
  </details>;
}
