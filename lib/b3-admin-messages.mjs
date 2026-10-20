import { B3_DATABASE_MESSAGES } from './b3-database-messages.mjs';

// Operator texts [German, English] for the B3 administration (Block 15).
export const B3_ADMIN_MESSAGES = Object.freeze({
  ...B3_DATABASE_MESSAGES,
  B3_DATABASE_NOT_READY: ['B3 nutzt noch keine bereite MySQL-Datenbank – erst den Datenbank-Wizard abschließen.', 'B3 does not use a ready MySQL database yet – finish the database wizard first.'],
  B3_ADMIN_INPUT_INVALID: ['Ungültige Eingabe (Suche, Seite, Dauer oder Grund).', 'Invalid input (search, page, duration or reason).'],
  B3_ADMIN_CLIENT_NOT_FOUND: ['Spieler ist in B3 nicht (mehr) bekannt.', 'Player is not (or no longer) known to B3.'],
  B3_ADMIN_GROUP_NOT_FOUND: ['Diese Gruppe gibt es in B3 nicht.', 'This group does not exist in B3.'],
  B3_ADMIN_PENALTY_NOT_FOUND: ['Keine aktive Warnung mit dieser Nummer.', 'No active warning with this number.'],
  B3_ADMIN_COMMANDS_UNAVAILABLE: ['plugin_admin.ini der eBc-B3-Quelle ist nicht lesbar.', 'plugin_admin.ini of the eBc-B3 source is not readable.'],
  B3_RUNNING: ['B3 läuft – Gruppen nur bei gestopptem B3 ändern.', 'B3 is running – change groups only with B3 stopped.'],
  // Block 15b: live kick.
  RCON_KICK_NOT_ONLINE: ['Spieler ist nicht (mehr) online.', 'Player is not (or no longer) online.'],
  RCON_KICK_TARGET_CHANGED: ['Der Slot ist inzwischen anders belegt – nichts gekickt. Liste aktualisieren.', 'The slot now holds someone else – nothing kicked. Refresh the list.'],
  RCON_KICK_INVALID: ['Ungültiger Kick (Slot oder Grund; im Grund keine " ; % / \ Zeichen, max. 126).', 'Invalid kick (slot or reason; no " ; % / \ in the reason, max 126).'],
  RCON_KICK_NOT_CONFIRMED: ['Kick gesendet, Spieler ist aber noch verbunden.', 'Kick sent, but the player is still connected.'],
  RCON_UNAVAILABLE: ['RCON nicht verfügbar – Online-Status unbekannt.', 'RCON unavailable – online state unknown.'],
  RCON_SERVER_NOT_RUNNING: ['Server läuft nicht.', 'Server is not running.'],
  RCON_NOT_CONFIGURED: ['Kein RCON-Passwort im Tresor.', 'No RCON password in the vault.'],
  RCON_AUTH_FAILED: ['RCON-Passwort abgelehnt.', 'RCON password rejected.'],
});

// Loads the panel state with diagnostics.read only (no config.manage routes):
// readiness and B3 state come from /b3/admin/status and are refreshed on every load.
export async function loadAdminView(call, base, { tab = 'players', search = '', filter = { type: 'any', status: 'active' }, offset = 0, withPermissions = false } = {}) {
  const state = { tab };
  if (withPermissions) {
    const me = await call('/api/rbac/me');
    state.permissions = { manage: me.permissions?.includes('server.manage') === true, full: me.permissions?.includes('config.manage') === true };
  }
  const { status } = await call(`${base}/b3/admin/status`);
  Object.assign(state, { ready: status.ready === true, b3Running: status.b3Running === true });
  if (!state.ready) return state;
  state.groups = (await call(`${base}/b3/admin/groups`)).groups.rows;
  if (tab === 'players') state.players = (await call(`${base}/b3/admin/players?search=${encodeURIComponent(search)}&offset=${offset}`)).players;
  else if (tab === 'admins') state.admins = (await call(`${base}/b3/admin/admins`)).admins;
  else if (tab === 'penalties') state.penalties = (await call(`${base}/b3/admin/penalties?type=${encodeURIComponent(filter.type)}&status=${encodeURIComponent(filter.status)}&offset=${offset}`)).penalties;
  else state.commands = (await call(`${base}/b3/admin/commands`)).commands;
  return state;
}

export function actionMessage(action, result, de) {
  const count = Number(result?.affected) || 0;
  if (action === 'unban') return count === 0 ? (de ? 'Kein aktiver Ban für diesen Spieler.' : 'No active ban for this player.') : (de ? `${count} Ban(s) aufgehoben.` : `${count} ban(s) lifted.`);
  if (action === 'lift') return de ? 'Warnung aufgehoben.' : 'Warning lifted.';
  if (action === 'group') return de ? 'Gruppe gesetzt.' : 'Group set.';
  if (action === 'kick') return de ? 'Spieler gekickt.' : 'Player kicked.';
  if (result?.kick === 'kicked') return de ? 'Ban gespeichert, Spieler gekickt.' : 'Ban saved, player kicked.';
  if (result?.kick === 'not_online') return de ? 'Ban gespeichert; Spieler ist nicht online.' : 'Ban saved; player is not online.';
  if (result?.kick) return de ? `Ban gespeichert; Kick fehlgeschlagen (${result.kick}).` : `Ban saved; kick failed (${result.kick}).`;
  return de ? 'Ban gespeichert.' : 'Ban saved.';
}
