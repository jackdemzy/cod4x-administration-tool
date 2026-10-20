import { useEffect, useRef, useState } from 'react';
import { B3_ADMIN_MESSAGES } from './b3-admin-messages.mjs';
import { reasonsAfterLoad } from './online-players-state.mjs';

// Block 15b: players connected right now (RCON status) with a verified live kick.
// Works without B3. Ids and addresses arrive masked unless the user has config.manage.
const say = (code, de) => B3_ADMIN_MESSAGES[code]?.[de ? 0 : 1] || code;

export function InstanceOnlinePlayers({ instance, request, de, initial = null }) {
  const [state, setState] = useState(initial || { permissions: null, online: null });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [reasons, setReasons] = useState({});
  const mounted = useRef(true);
  const base = `/api/instances/${encodeURIComponent(instance.id)}`;
  async function call(route, body) {
    const response = await request(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || `HTTP ${response.status}`);
    return data;
  }
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (failure) { if (mounted.current) setError(failure.message); }
    if (mounted.current) setBusy(false);
  }
  const load = async (withPermissions = false) => {
    const permissions = withPermissions ? { manage: (await call('/api/rbac/me')).permissions?.includes('server.manage') === true } : state.permissions;
    const { online } = await call(`${base}/rcon/online`);
    if (mounted.current) { setState({ permissions, online }); setReasons(reasonsAfterLoad()); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The slot is checked against the name (and the id when unmasked) right before the kick.
  const kick = player => run(async () => {
    const reason = reasons[player.slot] || '';
    await call(`${base}/rcon/kick`, { slot: player.slot, name: player.name, ...(/^\d+$/.test(player.playerid) ? { playerid: player.playerid } : {}), reason });
    setMessage(de ? `${player.name} gekickt.` : `${player.name} kicked.`);
    await load();
  });
  const manage = state.permissions?.manage === true;
  return <details style={{ marginTop: 12 }} onToggle={event => { if (event.currentTarget.open && !state.online && !initial) void run(() => load(true)); }}>
    <summary>{de ? 'Online-Spieler (Live-Kick)' : 'Online players (live kick)'}</summary>
    {error && <p role="alert">{say(error, de)}</p>}
    {message && <p role="status">{message}</p>}
    <button disabled={busy} onClick={() => run(() => load(state.permissions === null))}>{de ? 'Aktualisieren' : 'Refresh'}</button>
    {state.online && <>
      <p>Map: {state.online.map ?? '—'} · {state.online.players.length} {de ? 'Spieler' : 'players'}</p>
      <table><thead><tr><th>Slot</th><th>Name</th><th>Ping</th><th>Score</th><th>ID</th><th>{de ? 'Adresse' : 'Address'}</th>{manage && <th>{de ? 'Kick' : 'Kick'}</th>}</tr></thead>
        <tbody>{state.online.players.map(player => <tr key={player.slot}>
          <td>{player.slot}</td><td>{player.name}</td><td>{player.ping}</td><td>{player.score}</td><td>{player.playerid}</td><td>{player.address}</td>
          {manage && <td>
            <input aria-label={de ? 'Grund (optional)' : 'Reason (optional)'} maxLength={126} value={reasons[player.slot] || ''} onChange={event => setReasons({ ...reasons, [player.slot]: event.target.value })} />
            <button disabled={busy} onClick={() => kick(player)}>{de ? 'Kicken' : 'Kick'}</button>
          </td>}
        </tr>)}</tbody></table>
      {manage && <p>{de ? 'Vor dem Kick prüft CONTROL, ob der Slot noch denselben Spieler hat; sonst wird nichts gekickt.' : 'Before the kick, CONTROL checks that the slot still holds the same player; otherwise nothing is kicked.'}</p>}
    </>}
  </details>;
}
