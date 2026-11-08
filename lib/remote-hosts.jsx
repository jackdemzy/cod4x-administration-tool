import { useCallback, useEffect, useRef, useState } from 'react';
import { InstanceRconConsole } from './instance-rcon-console.jsx';
import { InstanceOnlinePlayers } from './instance-online-players.jsx';
import { InstanceCredentialEditor } from './instance-credential-editor.jsx';
import { InstanceB3Database } from './instance-b3-database.jsx';
import { InstanceB3Admin } from './instance-b3-admin.jsx';

// Panel for SSH hosts and the servers on them (Block 18). Rules of this file:
//  - there is no password login anywhere; the only secret fields are the private key (multi-line, uncontrolled) and,
//    for an encrypted key, its passphrase; both are cleared the moment the form is submitted and never kept in state
//  - a host key is trusted only after the operator ticked "I compared this fingerprint" for that exact value
//  - a changed host key is a stop message without a trust button
//  - server error text is never shown, only a fixed message and the code
const CODE = /^(?:REMOTE|VAULT|CREDENTIAL|INSTANCE)_[A-Z0-9_]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const text = (de, german, english) => (de ? german : english);
const openSsh = base64 => `SHA256:${String(base64 || '').replace(/=+$/, '')}`;

const MESSAGES = {
  REMOTE_HOST_KEY_UNVERIFIED: ['Der Host-Schlüssel ist noch nicht bestätigt.', 'The host key has not been confirmed yet.'],
  REMOTE_HOST_KEY_MISMATCH: ['Der Schlüssel des Servers stimmt nicht mit dem bestätigten Wert überein. Nichts wurde gespeichert.', 'The server key does not match the confirmed value. Nothing was saved.'],
  REMOTE_AUTH_FAILED: ['Anmeldung mit dem SSH-Schlüssel abgelehnt.', 'The server rejected the SSH key.'],
  REMOTE_CONNECT_FAILED: ['Keine Verbindung zum Server.', 'Could not connect to the server.'],
  REMOTE_TIMEOUT: ['Zeitüberschreitung.', 'Timed out.'],
  REMOTE_ROOT_BLOCKED: ['Verbindungen als root sind gesperrt.', 'Connections as root are blocked.'],
  VAULT_LOCKED: ['Der Zugangsdaten-Tresor ist gesperrt. Bitte zuerst entsperren.', 'The credential vault is locked. Unlock it first.'],
  REMOTE_RCON_UNSUPPORTED: ['RCON ist für Remote-Server nicht verfügbar.', 'RCON is not available for remote servers.'],
  REMOTE_B3_UNSUPPORTED: ['B3 ist für Remote-Server nicht verfügbar.', 'B3 is not available for remote servers.'],
  REMOTE_OPERATION_BUSY: ['Für diesen Server läuft bereits ein Vorgang.', 'An operation is already running for this server.'],
};

export function RemoteError({ de, code, presentedSha256, pinnedSha256 }) {
  const safe = CODE.test(code || '') ? code : 'REMOTE_OPERATION_FAILED';
  if (safe === 'REMOTE_HOST_KEY_CHANGED') {
    return <div role="alert">
      <strong>{text(de, 'Verbindung gestoppt: Der Host-Schlüssel hat sich geändert.', 'Connection stopped: the host key has changed.')}</strong>
      <p>{text(de, 'Es wurde nichts gesendet. Das kann eine Neuinstallation des Servers sein, aber auch ein Angriff. Prüfe den Wert über einen zweiten Weg. Zum Ändern den Host entfernen und neu anlegen.', 'Nothing was sent. This can be a reinstalled server, but also an attack. Check the value through a second channel. To change it, remove the host and add it again.')}</p>
      {HEX64.test(pinnedSha256 || '') && <p>{text(de, 'Bestätigt: ', 'Pinned: ')}<code>{pinnedSha256}</code></p>}
      {HEX64.test(presentedSha256 || '') && <p>{text(de, 'Vom Server gezeigt: ', 'Presented by the server: ')}<code>{presentedSha256}</code></p>}
      <code>{safe}</code>
    </div>;
  }
  const message = MESSAGES[safe];
  return <p role="alert">{message ? text(de, message[0], message[1]) : text(de, 'Vorgang fehlgeschlagen.', 'Operation failed.')} <code>{safe}</code></p>;
}

export function HostKeyDialog({ de, host, fingerprint, confirmed, onConfirm, onTrust, onCancel }) {
  return <div role="dialog" aria-label={text(de, 'Host-Schlüssel prüfen', 'Verify host key')} style={{ border: '1px solid currentColor', padding: 12, margin: '10px 0' }}>
    <strong>{text(de, 'Host-Schlüssel von ', 'Host key of ')}{host.host || host.id}</strong>
    <p>{text(de, 'Beim ersten Kontakt wird nichts angemeldet und nichts gesendet. Vergleiche den Fingerabdruck mit dem Server (z. B. mit „ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub“ dort).', 'On first contact nothing is sent and nobody is logged in. Compare the fingerprint with the server (for example with “ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub” there).')}</p>
    <p>SHA-256 (hex): <code>{fingerprint.sha256Hex}</code></p>
    <p>OpenSSH: <code>{openSsh(fingerprint.sha256Base64)}</code></p>
    <label><input type="checkbox" checked={Boolean(confirmed)} onChange={event => onConfirm(event.target.checked)} /> {text(de, 'Ich habe diesen Fingerabdruck mit dem Server verglichen', 'I compared this fingerprint with the server')}</label>
    <div>
      <button type="button" disabled={!confirmed} onClick={onTrust}>{text(de, 'Diesem Schlüssel vertrauen', 'Trust this key')}</button>
      <button type="button" onClick={onCancel}>{text(de, 'Abbrechen', 'Cancel')}</button>
    </div>
  </div>;
}

export function HostCredentialForm({ de, host, status, busy, onSave, onRemove }) {
  const key = useRef(null), passphrase = useRef(null);
  const clear = () => { if (key.current) key.current.value = ''; if (passphrase.current) passphrase.current.value = ''; };
  useEffect(() => clear, []);
  const configured = status?.ssh?.configured;
  const known = Boolean(status);
  function submit(event) {
    event.preventDefault();
    const privateKey = key.current?.value || '', pass = passphrase.current?.value || '';
    clear();
    onSave({ privateKey, ...(pass ? { passphrase: pass } : {}) });
  }
  return <form onSubmit={submit} style={{ marginTop: 8 }}>
    <label>{text(de, 'SSH-Schlüssel (privat, OpenSSH oder PEM)', 'SSH private key (OpenSSH or PEM)')}<br />
      <textarea ref={key} rows={6} cols={64} spellCheck={false} autoComplete="off" required disabled={busy || !known} /></label><br />
    <label>{text(de, 'Schlüssel-Passphrase (nur bei verschlüsseltem Schlüssel)', 'Key passphrase (only if the key is encrypted)')} <input ref={passphrase} type="password" autoComplete="off" maxLength={256} disabled={busy || !known} /></label>
    <span> {!known ? text(de, 'Status unbekannt', 'Status unknown') : configured ? text(de, 'Gespeichert', 'Stored') : text(de, 'Nicht eingerichtet', 'Not configured')}</span>
    <div>
      <button type="submit" disabled={busy || !known}>{text(de, 'Verschlüsselt speichern', 'Save encrypted')}</button>
      <button type="button" disabled={busy || !known || configured !== true} onClick={() => onRemove()}>{text(de, 'Entfernen', 'Remove')}</button>
    </div>
  </form>;
}

const ACTIONS = [['start', 'Start', 'Start'], ['stop', 'Stop', 'Stop'], ['restart', 'Neustart', 'Restart']];
export function RemoteInstanceRow({ de, entry, busy, onAction }) {
  const { instance, runtime } = entry;
  return <li style={{ margin: '8px 0' }}>
    <strong>{instance.name}</strong> <code>{instance.id}</code> @ <code>{instance.hostId}</code>:{instance.port} — <span>{entry.error || runtime?.status || 'UNKNOWN'}</span>{runtime?.pid ? <span> (PID {runtime.pid})</span> : null}{runtime?.recoveryBlocked ? <span> ⚠ {text(de, 'Wiederherstellung nötig', 'recovery needed')}</span> : null}
    <div>
      {ACTIONS.map(([id, german, english]) => <button key={id} type="button" disabled={busy} onClick={() => onAction(id, instance)}>{text(de, german, english)}</button>)}
      <button type="button" disabled={busy} onClick={() => onAction('logs', instance)}>Logs</button>
      <button type="button" disabled={busy} onClick={() => onAction('health', instance)}>Health</button>
      <button type="button" disabled={busy} onClick={() => onAction('config', instance)}>Config</button>
      <button type="button" disabled={busy} onClick={() => onAction('backup', instance)}>Backup</button>
      <button type="button" disabled={busy} onClick={() => onAction('backups', instance)}>{text(de, 'Backups', 'Restore list')}</button>
    </div>
  </li>;
}

// Block 18b: everything of one remote server that goes through /api/remote-instances/<id>: the RCON and B3
// database passwords, the console and online players (running server only), B3 through its database.
export function RemoteInstanceTools({ de, entry, request }) {
  const { instance, runtime } = entry;
  const basePath = `/api/remote-instances/${encodeURIComponent(instance.id)}`;
  const view = { ...instance, runtime: runtime || { status: 'UNKNOWN' } };
  const running = runtime?.status === 'RUNNING' && Boolean(runtime.pid);
  return <div>
    <InstanceCredentialEditor instance={view} request={request} de={de} kinds={['rcon', 'b3db']} basePath={basePath} remote />
    {running ? <>
      <InstanceRconConsole instance={view} request={request} de={de} basePath={basePath} remote />
      <InstanceOnlinePlayers instance={view} request={request} de={de} basePath={basePath} />
    </> : <p>{text(de, 'Server starten, um RCON zu nutzen.', 'Start the server to use RCON.')}</p>}
    <InstanceB3Database instance={view} request={request} de={de} basePath={basePath} remote />
    <InstanceB3Admin instance={view} request={request} de={de} basePath={basePath} remote />
  </div>;
}

const EMPTY_HOST = { id: '', label: '', host: '', port: '22', username: '' };
const EMPTY_INSTALL = { id: '', name: '', hostId: '', port: '28960', remoteRoot: '', basePath: '', corePath: '', coreVersion: '21.5', expectedCoreSha256: '' };

export function RemoteHostsPanel({ de, request }) {
  const [hosts, setHosts] = useState([]), [instances, setInstances] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(null), [confirmed, setConfirmed] = useState(false);
  const [credentials, setCredentials] = useState({}), [output, setOutput] = useState(null);
  const [hostForm, setHostForm] = useState(EMPTY_HOST), [installForm, setInstallForm] = useState(EMPTY_INSTALL);
  const [configEdit, setConfigEdit] = useState(null);
  const mounted = useRef(true), working = useRef(false);
  useEffect(() => () => { mounted.current = false; }, []);

  const call = useCallback(async (route, method = 'GET', body) => {
    const response = await request(route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error('remote call failed'), { code: data.code, presentedSha256: data.presentedSha256, pinnedSha256: data.pinnedSha256 });
    return data;
  }, [request]);

  async function run(task) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null); setMessage('');
    try { await task(); }
    catch (failure) { if (mounted.current) setError({ code: failure.code, presentedSha256: failure.presentedSha256, pinnedSha256: failure.pinnedSha256 }); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  const refresh = () => run(async () => {
    const [h, i] = await Promise.all([call('/api/remote-hosts'), call('/api/remote-instances')]);
    if (!mounted.current) return;
    setHosts(h.hosts || []); setInstances(i.instances || []);
  });

  const addHost = event => { event.preventDefault(); run(async () => {
    await call('/api/remote-hosts', 'POST', { ...hostForm, port: Number(hostForm.port) });
    setHostForm(EMPTY_HOST); setMessage(text(de, 'Host angelegt. Als Nächstes den Host-Schlüssel prüfen.', 'Host added. Next, verify the host key.'));
    const h = await call('/api/remote-hosts'); setHosts(h.hosts || []);
  }); };
  const probe = host => run(async () => {
    const { fingerprint } = await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/hostkey/probe`, 'POST', {});
    setConfirmed(false); setDialog({ host, fingerprint });
  });
  const trust = () => run(async () => {
    // exactly the value that was shown and ticked, never a fresh one
    await call(`/api/remote-hosts/${encodeURIComponent(dialog.host.id)}/hostkey/trust`, 'POST', { expectedSha256: dialog.fingerprint.sha256Hex });
    setDialog(null); setConfirmed(false); setMessage(text(de, 'Host-Schlüssel bestätigt.', 'Host key confirmed.'));
    const h = await call('/api/remote-hosts'); setHosts(h.hosts || []);
  });
  const removeHost = host => run(async () => { await call(`/api/remote-hosts/${encodeURIComponent(host.id)}`, 'DELETE'); setHosts((await call('/api/remote-hosts')).hosts || []); });
  const loadCredentials = host => run(async () => { const data = await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/credentials`); setCredentials(old => ({ ...old, [host.id]: data.credentials })); });
  const saveKey = (host, body) => run(async () => {
    const status = credentials[host.id];
    await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/credentials/ssh`, 'POST', { expectedSha256: status.sha256, ...body });
    setMessage(text(de, 'Schlüssel verschlüsselt gespeichert.', 'Key saved encrypted.'));
    const data = await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/credentials`); setCredentials(old => ({ ...old, [host.id]: data.credentials }));
  });
  const removeKey = host => run(async () => {
    await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/credentials/ssh/remove`, 'POST', { expectedSha256: credentials[host.id].sha256 });
    const data = await call(`/api/remote-hosts/${encodeURIComponent(host.id)}/credentials`); setCredentials(old => ({ ...old, [host.id]: data.credentials }));
  });
  const install = event => { event.preventDefault(); run(async () => {
    await call('/api/remote-instances', 'POST', { ...installForm, port: Number(installForm.port) });
    setInstallForm(EMPTY_INSTALL); setMessage(text(de, 'Server installiert.', 'Server installed.'));
    setInstances((await call('/api/remote-instances')).instances || []);
  }); };
  const instanceAction = (action, instance) => run(async () => {
    const base = `/api/remote-instances/${encodeURIComponent(instance.id)}`;
    setOutput(null); setConfigEdit(null);
    if (['start', 'stop', 'restart'].includes(action)) {
      await call(`${base}/${action}`, 'POST', {});
      setInstances((await call('/api/remote-instances')).instances || []);
    } else if (action === 'logs') setOutput({ kind: 'logs', instance, data: (await call(`${base}/logs`)).logs });
    else if (action === 'health') setOutput({ kind: 'health', instance, data: (await call(`${base}/health`)).health });
    else if (action === 'config') { const configuration = (await call(`${base}/config`)).configuration; setConfigEdit({ instance, text: configuration.text, sha256: configuration.sha256 }); }
    else if (action === 'backup') { const backup = (await call(`${base}/backups`, 'POST', {})).backup; setMessage(text(de, 'Backup erstellt: ', 'Backup created: ') + backup.backupId); }
    else if (action === 'backups') setOutput({ kind: 'backups', instance, data: (await call(`${base}/backups`)).backups });
  });
  const restore = (instance, backupId) => run(async () => {
    await call(`/api/remote-instances/${encodeURIComponent(instance.id)}/backups/${encodeURIComponent(backupId)}/restore`, 'POST', {});
    setMessage(text(de, 'Backup wiederhergestellt (server.cfg).', 'Backup restored (server.cfg).'));
  });
  const saveConfig = () => run(async () => {
    const saved = (await call(`/api/remote-instances/${encodeURIComponent(configEdit.instance.id)}/config`, 'PUT', { text: configEdit.text, expectedSha256: configEdit.sha256 })).configuration;
    setConfigEdit(old => ({ ...old, sha256: saved.sha256 })); setMessage(text(de, 'Konfiguration gespeichert.', 'Configuration saved.'));
  });

  return <section>
    <h3>Remote Linux</h3>
    <p role="note">{text(de, 'B3 startet CONTROL für Remote-Server nicht: B3 läuft auf dem Server, CONTROL verwaltet nur seine Datenbank. RCON läuft über SSH (auf dem Server wird python3 gebraucht).', 'CONTROL does not start B3 for remote servers: B3 runs on the server, CONTROL only manages its database. RCON runs over SSH (python3 is needed on the server).')}</p>
    <p>{text(de, 'Die Verbindung läuft über SSH mit Schlüssel. Es gibt keinen Passwort-Login und keinen Agenten. Der SSH-Schlüssel liegt nur im verschlüsselten Tresor.', 'The connection uses SSH with a key. There is no password login and no agent. The key lives only in the encrypted vault.')}</p>
    <button type="button" disabled={busy} onClick={refresh}>{text(de, 'Laden / aktualisieren', 'Load / refresh')}</button>
    {error && <RemoteError de={de} {...error} />}
    {message && <p role="status">{message}</p>}

    <h4>{text(de, 'Hosts', 'Hosts')}</h4>
    <form onSubmit={addHost}>
      {[['id', 'ID', 'ID'], ['label', 'Bezeichnung', 'Label'], ['host', 'Host / IP', 'Host / IP'], ['port', 'Port', 'Port'], ['username', 'Benutzer (nicht root)', 'User (not root)']].map(([field, german, english]) =>
        <label key={field} style={{ marginRight: 8 }}>{text(de, german, english)} <input type="text" value={hostForm[field]} onChange={event => setHostForm({ ...hostForm, [field]: event.target.value })} required disabled={busy} autoComplete="off" /></label>)}
      <button type="submit" disabled={busy}>{text(de, 'Host anlegen', 'Add host')}</button>
    </form>
    {dialog && <HostKeyDialog de={de} host={dialog.host} fingerprint={dialog.fingerprint} confirmed={confirmed} onConfirm={setConfirmed} onTrust={trust} onCancel={() => { setDialog(null); setConfirmed(false); }} />}
    <ul>{hosts.map(host => <li key={host.id}>
      <strong>{host.label}</strong> <code>{host.username}@{host.host}:{host.port}</code> — {host.hostKeySha256 ? <span>{text(de, 'Schlüssel bestätigt', 'key pinned')} <code>{host.hostKeySha256.slice(0, 16)}…</code></span> : <span>{text(de, 'Schlüssel nicht bestätigt', 'key not confirmed')}</span>}
      <div>
        {!host.hostKeySha256 && <button type="button" disabled={busy} onClick={() => probe(host)}>{text(de, 'Host-Schlüssel prüfen', 'Verify host key')}</button>}
        <button type="button" disabled={busy} onClick={() => loadCredentials(host)}>{text(de, 'SSH-Schlüssel-Status', 'SSH key status')}</button>
        <button type="button" disabled={busy} onClick={() => removeHost(host)}>{text(de, 'Host entfernen', 'Remove host')}</button>
      </div>
      {credentials[host.id] && <HostCredentialForm de={de} host={host} status={credentials[host.id]} busy={busy} onSave={body => saveKey(host, body)} onRemove={() => removeKey(host)} />}
    </li>)}</ul>

    <h4>{text(de, 'Server auf Hosts', 'Servers on hosts')}</h4>
    <ul>{instances.map(entry => <li key={entry.instance.id} style={{ listStyle: 'none' }}><ul><RemoteInstanceRow de={de} entry={entry} busy={busy} onAction={instanceAction} /></ul><RemoteInstanceTools de={de} entry={entry} request={request} /></li>)}</ul>
    {output?.kind === 'logs' && <div><h5>Logs {output.instance.id}</h5><pre>{output.data.stdout}</pre><pre>{output.data.stderr}</pre><pre>{output.data.console}</pre></div>}
    {output?.kind === 'health' && <div><h5>Health {output.instance.id}</h5><pre>{JSON.stringify(output.data, null, 2)}</pre></div>}
    {output?.kind === 'backups' && <div><h5>Backups {output.instance.id}</h5><ul>{output.data.map(backup => <li key={backup.backupId}><code>{backup.backupId}</code> {backup.invalid ? text(de, '(ungültig)', '(invalid)') : backup.createdAt} <button type="button" disabled={busy || backup.invalid} onClick={() => restore(output.instance, backup.backupId)}>{text(de, 'Wiederherstellen', 'Restore')}</button></li>)}</ul></div>}
    {configEdit && <div><h5>server.cfg {configEdit.instance.id}</h5>
      <textarea rows={14} cols={72} spellCheck={false} value={configEdit.text} onChange={event => setConfigEdit({ ...configEdit, text: event.target.value })} disabled={busy} />
      <div><button type="button" disabled={busy} onClick={saveConfig}>{text(de, 'Speichern (Server muss gestoppt sein)', 'Save (server must be stopped)')}</button></div></div>}

    <h4>{text(de, 'Server installieren', 'Install a server')}</h4>
    <p>{text(de, 'Das BaseGame muss auf dem Server schon vorhanden sein (nur gelesen). Hochgeladen werden nur der CoD4x-Linux-Core (Datei „cod4x18_dedrun“ auf diesem PC, SHA-256 bestätigen) und das Instanzverzeichnis.', 'The base game must already exist on the server (read only). Only the CoD4x Linux core (file “cod4x18_dedrun” on this PC, confirm its SHA-256) and the instance directory are uploaded.')}</p>
    <form onSubmit={install}>
      {[['id', 'ID', 'ID'], ['name', 'Name', 'Name'], ['hostId', 'Host-ID', 'Host ID'], ['port', 'Server-Port', 'Server port'], ['remoteRoot', 'Zielverzeichnis (Server)', 'Target directory (server)'], ['basePath', 'BaseGame-Pfad (Server)', 'Base game path (server)'], ['corePath', 'Core-Datei (dieser PC)', 'Core file (this PC)'], ['coreVersion', 'Core-Version', 'Core version'], ['expectedCoreSha256', 'Core SHA-256', 'Core SHA-256']].map(([field, german, english]) =>
        <label key={field} style={{ display: 'block' }}>{text(de, german, english)} <input type="text" value={installForm[field]} onChange={event => setInstallForm({ ...installForm, [field]: event.target.value })} required disabled={busy} autoComplete="off" /></label>)}
      <button type="submit" disabled={busy}>{text(de, 'Installieren', 'Install')}</button>
    </form>
  </section>;
}
