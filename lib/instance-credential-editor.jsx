import { useEffect, useRef, useState } from 'react';

// Only invalidation callbacks live here, never credentials or passphrases.
const editors = new Set();
const KINDS = ['rcon', 'master', 'join'];
const ERROR_CODES = new Set(['VAULT_LOCKED', 'VAULT_CONFLICT', 'VAULT_EXISTS', 'VAULT_OPERATION_BUSY', 'VAULT_UNLOCK_FAILED',
  'VAULT_PASSPHRASE_INVALID', 'CREDENTIAL_INVALID', 'INSTANCE_RUNTIME_BUSY', 'INSTANCE_OPERATION_BUSY']);

export function InstanceCredentialEditor({ instance, request, de }) {
  const [credentials, setCredentials] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true), operation = useRef(false), passphrase = useRef(null);
  const secrets = useRef({}), invalidation = useRef(null);
  const revision = useRef(0);
  const active = Boolean(instance.runtime?.pid || instance.runtime?.recoveryBlocked || ['STARTING', 'RUNNING', 'STOPPING'].includes(instance.runtime?.status));
  const unlocked = credentials?.initialized === true && credentials.locked === false;
  const labels = { rcon: 'RCON', master: de ? 'Master-Token' : 'Master token', join: de ? 'Join-Passwort' : 'Join password' };
  function clearInputs() {
    if (passphrase.current) passphrase.current.value = '';
    for (const input of Object.values(secrets.current)) if (input) input.value = '';
  }
  useEffect(() => {
    mounted.current = true;
    ++revision.current;
    clearInputs(); setCredentials(null);
    const invalidate = () => {
      ++revision.current;
      clearInputs(); setCredentials(null); setError('');
      setMessage(de ? 'Tresor wurde geändert. Status bitte neu laden.' : 'Vault changed. Please refresh the status.');
    };
    invalidation.current = invalidate; editors.add(invalidate);
    return () => { mounted.current = false; ++revision.current; clearInputs(); editors.delete(invalidate); };
  }, [de, instance.id, instance.createdAt]);
  async function call(route, body) {
    const response = await request(route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('Credential operation failed'), { code: ERROR_CODES.has(data.code) ? data.code : 'CREDENTIAL_OPERATION_FAILED' });
    return data;
  }
  const route = `/api/instances/${encodeURIComponent(instance.id)}/credentials`;
  async function action(kind, credentialKind) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    const generation = revision.current;
    // Uncontrolled password inputs are cleared immediately on submission. No
    // secret is placed in React state, localStorage, diagnostics or a message.
    let value = kind === 'initialize' || kind === 'unlock' ? passphrase.current?.value : secrets.current[credentialKind]?.value;
    clearInputs();
    try {
      if (kind !== 'load') {
        if (['initialize', 'unlock'].includes(kind)) await call(`/api/credentials/vault/${kind}`, { passphrase: value });
        else if (kind === 'lock') await call('/api/credentials/vault/lock', {});
        else {
          if (!unlocked || active || !credentials.sha256) throw Object.assign(new Error('Credential operation blocked'), { code: active ? 'INSTANCE_RUNTIME_BUSY' : 'VAULT_LOCKED' });
          const body = { expectedSha256: credentials.sha256 };
          if (kind === 'save') body.value = value;
          await call(`${route}/${credentialKind}${kind === 'remove' ? '/remove' : ''}`, body);
          delete body.value;
        }
        value = null;
        for (const editor of editors) if (editor !== invalidation.current) editor();
      }
      const current = (await call(route)).credentials;
      if (!mounted.current || generation !== revision.current) return;
      setCredentials(current);
      if (kind === 'save' || kind === 'remove') setMessage(de ? 'Verschlüsselt gespeichert und geprüft. Noch nicht im Server aktiv.' : 'Encrypted, saved and verified. Not active in the server yet.');
      else if (kind === 'initialize') setMessage(de ? 'Tresor angelegt. Zum Bearbeiten entsperren.' : 'Vault created. Unlock to edit.');
      else if (kind === 'unlock') setMessage(de ? 'Tresor entsperrt.' : 'Vault unlocked.');
      else if (kind === 'lock') setMessage(de ? 'Tresor gesperrt.' : 'Vault locked.');
    } catch (failure) {
      if (mounted.current) {
        setCredentials(null);
        const code = ERROR_CODES.has(failure.code) ? failure.code : 'CREDENTIAL_OPERATION_FAILED';
        setError((de ? 'Vorgang nicht bestätigt. Status neu laden. ' : 'Operation not confirmed. Refresh status. ') + code);
      }
    } finally {
      value = null; clearInputs(); operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(event, kind, credentialKind) { event.preventDefault(); void action(kind, credentialKind); }
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'Zugangsdaten – verschlüsselter Tresor' : 'Credentials – encrypted vault'}</summary>
    <p>{de ? 'Gespeicherte Zugangsdaten sind noch nicht an die Runtime angebunden. „Gespeichert“ bedeutet nicht verbunden oder registriert.' : 'Stored credentials are not wired to the runtime yet. “Stored” does not mean connected or registered.'}</p>
    <button disabled={busy} onClick={() => action('load')}>{de ? 'Status laden / aktualisieren' : 'Load / refresh status'}</button>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <p>{!credentials ? (de ? 'Status unbekannt – zuerst laden.' : 'Status unknown – load first.') : !credentials.initialized ? (de ? 'Tresor noch nicht eingerichtet.' : 'Vault not initialized.') : credentials.locked ? (de ? 'Tresor gesperrt.' : 'Vault locked.') : (de ? 'Tresor entsperrt.' : 'Vault unlocked.')}</p>
    <form onSubmit={event => submit(event, credentials?.initialized === false ? 'initialize' : 'unlock')}>
      <label>{de ? 'Separates Entsperrpasswort' : 'Separate unlock passphrase'} <input ref={passphrase} type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={busy || !credentials || unlocked} /></label>
      <button disabled={busy || !credentials || unlocked} type="submit">{credentials?.initialized === false ? (de ? 'Tresor einrichten' : 'Initialize vault') : (de ? 'Entsperren' : 'Unlock')}</button>
    </form>
    <p>{de ? 'Das Entsperrpasswort wird nicht gespeichert. Nach einem Backend-Neustart erneut entsperren. Ohne dieses Passwort ist keine Entschlüsselung möglich.' : 'The unlock passphrase is not saved. Unlock again after a backend restart. Without this passphrase the vault cannot be decrypted.'}</p>
    <button disabled={busy || !unlocked} onClick={() => action('lock')}>{de ? 'Tresor sperren' : 'Lock vault'}</button>
    {active && <p>{de ? 'Server vor Änderungen an Zugangsdaten vollständig stoppen.' : 'Fully stop the server before changing credentials.'}</p>}
    {KINDS.map(kind => <form key={kind} onSubmit={event => submit(event, 'save', kind)} style={{ marginTop: 10 }}>
      <label>{labels[kind]} <input ref={input => { secrets.current[kind] = input; }} type="password" autoComplete="new-password" minLength={kind === 'master' ? 32 : 8} maxLength={kind === 'master' ? 32 : kind === 'join' ? 64 : 128} required disabled={busy || !unlocked || active} /></label>
      <span> {credentials?.[kind]?.configured === true ? (de ? 'Gespeichert' : 'Stored') : credentials?.[kind]?.configured === false ? (de ? 'Nicht eingerichtet' : 'Not configured') : (de ? 'Unbekannt' : 'Unknown')}</span>
      <button type="submit" disabled={busy || !unlocked || active}>{de ? 'Verschlüsselt speichern' : 'Save encrypted'}</button>
      <button type="button" disabled={busy || !unlocked || active || credentials?.[kind]?.configured !== true} onClick={() => action('remove', kind)}>{de ? 'Entfernen' : 'Remove'}</button>
    </form>)}
  </details>;
}
