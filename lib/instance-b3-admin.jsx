import { useEffect, useRef, useState } from 'react';
import { B3_ADMIN_MESSAGES, loadAdminView, actionMessage } from './b3-admin-messages.mjs';

// Block 15: B3 in-game administration. B3 stays the authority; CONTROL shows
// B3's data (masked unless config.manage) and changes only B3's own records.
const say = (code, de) => B3_ADMIN_MESSAGES[code]?.[de ? 0 : 1] || code;
const when = seconds => (seconds ? new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—');
const TABS = [['players', 'Players'], ['admins', 'Admins'], ['penalties', 'Penalties'], ['commands', 'Commands']];
const UNITS = { minutes: 1, hours: 60, days: 1440 };

export function InstanceB3Admin({ instance, request, de, initial = null }) {
  const [state, setState] = useState(initial || { ready: null, tab: 'players' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState({ type: 'any', status: 'active' });
  // The search and filter that produced the shown page (reloads after actions reuse them).
  const view = useRef({ search: '', filter: { type: 'any', status: 'active' }, offset: 0 });
  const [ban, setBan] = useState({ kind: 'TempBan', amount: 1, unit: 'days', reason: '', kick: true });
  const mounted = useRef(true);
  const base = `/api/instances/${encodeURIComponent(instance.id)}`;
  const patch = values => { if (mounted.current) setState(current => ({ ...current, ...values })); };
  async function call(route, body) {
    const response = await request(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || `HTTP ${response.status}`);
    return data;
  }
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    let ok = true;
    try { await action(); } catch (failure) { ok = false; if (mounted.current) setError(failure.message); }
    if (mounted.current) setBusy(false);
    return ok;
  }
  // Every load refreshes readiness and B3 state (diagnostics.read only).
  async function loadTab(tab, changes = {}, withPermissions = false) {
    Object.assign(view.current, changes);
    patch(await loadAdminView(call, base, { tab, ...view.current, withPermissions }));
  }
  useEffect(() => { mounted.current = true; if (!initial) void run(() => loadTab(state.tab || 'players', {}, true)); return () => { mounted.current = false; }; }, [instance.id]);
  const act = (action, route, body) => run(async () => {
    const { result } = await call(`${base}/b3/admin/${route}`, body);
    setMessage(actionMessage(action, result, de));
    await loadTab(state.tab);
    if (state.detail) patch({ detail: (await call(`${base}/b3/admin/players/${state.detail.client.id}`)).player });
  });
  const pager = (page, tab) => page && <p>{page.total === 0 ? '0 / 0' : `${page.offset + 1}–${page.offset + page.rows.length} / ${page.total}`}
    <button aria-label={de ? 'Vorherige Seite' : 'Previous page'} disabled={busy || page.offset === 0} onClick={() => run(() => loadTab(tab, { offset: Math.max(0, page.offset - page.limit) }))}>‹</button>
    <button aria-label={de ? 'Nächste Seite' : 'Next page'} disabled={busy || page.offset + page.limit >= page.total} onClick={() => run(() => loadTab(tab, { offset: page.offset + page.limit }))}>›</button>
    <button disabled={busy} onClick={() => run(() => loadTab(tab))}>{de ? 'Aktualisieren' : 'Refresh'}</button></p>;
  const manage = state.permissions?.manage === true;
  const playerRow = player => <tr key={player.id}>
    <td><button disabled={busy} onClick={() => run(async () => patch({ detail: (await call(`${base}/b3/admin/players/${player.id}`)).player }))}>{player.name}</button></td>
    <td>{player.guid}</td><td>{player.ip}</td><td>{player.group ?? '—'}</td><td>{player.connections}</td><td>{when(player.lastSeen)}</td>
    {manage && <td>
      <button disabled={busy} onClick={() => patch({ banFor: player })}>{de ? 'Bannen' : 'Ban'}</button>
      {player.online && <button disabled={busy} title={`Slot ${player.online.slot}`} onClick={() => act('kick', `players/${player.id}/kick`, { reason: '' })}>{de ? 'Kicken' : 'Kick'}</button>}
      <button disabled={busy} onClick={() => act('unban', `players/${player.id}/unban`, {})}>{de ? 'Ban aufheben' : 'Lift ban'}</button>
      <select aria-label={de ? 'Gruppe' : 'Group'} disabled={busy || state.b3Running} defaultValue="" onChange={event => patch({ groupFor: { player, groupId: Number(event.target.value) } })}>
        <option value="" disabled>{de ? 'Gruppe…' : 'Group…'}</option>
        {(state.groups || []).map(group => <option key={group.id} value={group.id}>{group.name} ({group.level})</option>)}
      </select>
      <button disabled={busy || state.b3Running || state.groupFor?.player.id !== player.id} onClick={() => act('group', `players/${player.id}/group`, { groupId: state.groupFor.groupId })}>{de ? 'Gruppe setzen' : 'Set group'}</button>
    </td>}
  </tr>;
  const clientTable = rows => <table><thead><tr><th>Name</th><th>GUID</th><th>IP</th><th>{de ? 'Gruppe' : 'Group'}</th><th>{de ? 'Verbindungen' : 'Connections'}</th><th>{de ? 'Zuletzt' : 'Last seen'}</th>{manage && <th>{de ? 'Aktionen' : 'Actions'}</th>}</tr></thead>
    <tbody>{rows.map(playerRow)}</tbody></table>;
  return <details style={{ marginTop: 12 }}>
    <summary>{de ? 'B3 Administration' : 'B3 administration'}</summary>
    {error && <p role="alert">{say(error, de)}</p>}
    {message && <p role="status">{message}</p>}
    {state.ready === false && <p>{de ? 'Die B3-Administration braucht eine MySQL-Datenbank im Zustand „B3 Ready“ (Datenbank-Wizard oben).' : 'B3 administration needs a MySQL database in state “B3 Ready” (database wizard above).'}</p>}
    {state.ready && <>
      <p>{de ? 'B3 bleibt für die In-Game-Administration zuständig. Änderungen wirken über B3s eigene Daten: Bans beim nächsten Connect, Gruppen nur bei gestopptem B3.' : 'B3 stays in charge of in-game administration. Changes go through B3’s own data: bans apply on the next connect, groups only with B3 stopped.'}</p>
      {state.b3Running && manage && <p>{de ? 'Gruppen setzen nur bei gestopptem B3 – B3 schreibt die Gruppe verbundener Spieler sonst zurück.' : 'Set groups only with B3 stopped – otherwise B3 writes back the group of connected players.'}</p>}
      <div role="tablist">{TABS.map(([tab, label]) => <button key={tab} role="tab" aria-selected={state.tab === tab} disabled={busy} onClick={() => run(() => loadTab(tab, { offset: 0 }))}>{label}</button>)}</div>
      {state.tab === 'players' && <>
        <form onSubmit={event => { event.preventDefault(); void run(() => loadTab('players', { search, offset: 0 })); }}>
          <input aria-label={de ? 'Suche nach Name oder GUID' : 'Search name or GUID'} value={search} maxLength={32} onChange={event => setSearch(event.target.value)} />
          <button type="submit" disabled={busy}>{de ? 'Suchen' : 'Search'}</button>
        </form>
        {state.players && <>{clientTable(state.players.rows)}{pager(state.players, 'players')}</>}
      </>}
      {state.tab === 'admins' && state.admins && clientTable(state.admins.rows)}
      {state.tab === 'penalties' && <>
        <select aria-label={de ? 'Typ' : 'Type'} value={filter.type} onChange={event => setFilter({ ...filter, type: event.target.value })}>{['any', 'Permanent', 'TempBan', 'Kick', 'Warning'].map(type => <option key={type} value={type}>{type}</option>)}</select>
        <select aria-label="Status" value={filter.status} onChange={event => setFilter({ ...filter, status: event.target.value })}>{['active', 'expired', 'lifted', 'any'].map(status => <option key={status} value={status}>{status}</option>)}</select>
        <button disabled={busy} onClick={() => run(() => loadTab('penalties', { filter, offset: 0 }))}>{de ? 'Filtern' : 'Filter'}</button>
        {state.penalties && <><table><thead><tr><th>{de ? 'Spieler' : 'Player'}</th><th>GUID</th><th>{de ? 'Typ' : 'Type'}</th><th>{de ? 'Grund' : 'Reason'}</th><th>{de ? 'Seit' : 'Since'}</th><th>{de ? 'Bis' : 'Until'}</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody>{state.penalties.rows.map(row => <tr key={row.id}><td>{row.name ?? `#${row.clientId}`}</td><td>{row.guid}</td><td>{row.permanent ? 'Permanent' : row.type}</td><td>{row.reason}</td><td>{when(row.since)}</td><td>{row.until ? when(row.until) : '∞'}</td><td>{row.status === 'kick' ? '—' : row.status}</td>
            {manage && <td>{row.status === 'active' && row.type === 'Warning' && <button disabled={busy} onClick={() => act('lift', `penalties/${row.id}/lift`, {})}>{de ? 'Warnung aufheben' : 'Lift warning'}</button>}
              {row.status === 'active' && ['Ban', 'TempBan'].includes(row.type) && <button disabled={busy} onClick={() => act('unban', `players/${row.clientId}/unban`, {})}>{de ? 'Ban aufheben' : 'Lift ban'}</button>}</td>}</tr>)}</tbody></table>{pager(state.penalties, 'penalties')}</>}
      </>}
      {state.tab === 'commands' && state.commands && <table><thead><tr><th>{de ? 'Befehl' : 'Command'}</th><th>Alias</th><th>Level</th><th>{de ? 'Ab Gruppe' : 'From group'}</th></tr></thead>
        <tbody>{state.commands.map(entry => <tr key={entry.command}><td>!{entry.command}</td><td>{entry.alias ? `!${entry.alias}` : '—'}</td><td>{entry.level}</td><td>{entry.group ?? '—'}</td></tr>)}</tbody></table>}
      {state.detail && <section>
        <h4>{state.detail.client.name} · {state.detail.client.guid}</h4>
        <p>{de ? 'Aliase' : 'Aliases'}: {state.detail.aliases.map(entry => `${entry.alias} (${entry.used}×)`).join(', ') || '—'}</p>
        <p>{de ? 'IP-Historie' : 'IP history'}: {state.detail.ips.map(entry => `${entry.ip} (${entry.used}×, ${when(entry.lastSeen)})`).join(', ') || '—'}</p>
        <button onClick={() => patch({ detail: null })}>{de ? 'Schließen' : 'Close'}</button>
      </section>}
      {manage && state.banFor && <form onSubmit={event => { event.preventDefault(); const minutes = ban.kind === 'TempBan' ? Number(ban.amount) * UNITS[ban.unit] : undefined;
        void act('ban', `players/${state.banFor.id}/ban`, { kind: ban.kind, ...(minutes ? { durationMinutes: minutes } : {}), reason: ban.reason, kick: ban.kick })
          .then(ok => { if (ok) { patch({ banFor: null }); setBan(current => ({ ...current, reason: '' })); } }); }}>
        <h4>{de ? 'Bannen' : 'Ban'}: {state.banFor.name}</h4>
        <select aria-label={de ? 'Art' : 'Kind'} value={ban.kind} onChange={event => setBan({ ...ban, kind: event.target.value })}><option value="TempBan">TempBan</option><option value="Ban">{de ? 'Permanent' : 'Permanent'}</option></select>
        {ban.kind === 'TempBan' && <><input type="number" min="1" aria-label={de ? 'Dauer' : 'Duration'} value={ban.amount} onChange={event => setBan({ ...ban, amount: event.target.value })} />
          <select aria-label={de ? 'Einheit' : 'Unit'} value={ban.unit} onChange={event => setBan({ ...ban, unit: event.target.value })}><option value="minutes">{de ? 'Minuten' : 'minutes'}</option><option value="hours">{de ? 'Stunden' : 'hours'}</option><option value="days">{de ? 'Tage' : 'days'}</option></select></>}
        <input aria-label={de ? 'Grund' : 'Reason'} maxLength={255} required value={ban.reason} onChange={event => setBan({ ...ban, reason: event.target.value })} />
        <label><input type="checkbox" checked={ban.kick} onChange={event => setBan({ ...ban, kick: event.target.checked })} /> {de ? 'Spieler sofort kicken (falls online)' : 'Kick the player now (if online)'}</label>
        <p>{de ? 'Der Ban wirkt beim nächsten Connect; ohne Kick spielt ein gerade verbundener Spieler weiter.' : 'The ban applies on the next connect; without a kick, a connected player keeps playing.'}</p>
        <button type="submit" disabled={busy}>{de ? 'Ban speichern' : 'Save ban'}</button>
        <button type="button" onClick={() => patch({ banFor: null })}>{de ? 'Abbrechen' : 'Cancel'}</button>
      </form>}
    </>}
  </details>;
}
