// CoD4x kick reason rule (src/sv_cmds.c Cmd_KickPlayer_f): printable ASCII,
// at most 126 characters, none of " ; % / \. Pure, shared by RCON and UI.
export function validKickReason(reason = '') {
  const value = typeof reason === 'string' ? reason.trim() : null;
  if (value === null || !/^[\x20-\x7e]{0,126}$/.test(value) || /[";%/\\]/.test(value)) throw Object.assign(new Error('RCON_KICK_INVALID'), { code: 'RCON_KICK_INVALID' });
  return value;
}

// Ban-and-kick shows the ban reason to the player when CoD4x can carry it.
export function kickReasonFromBan(reason) {
  try { return validKickReason(reason); } catch { return ''; }
}
