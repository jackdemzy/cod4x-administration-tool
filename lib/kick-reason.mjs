// CoD4x kick reason rule (src/sv_cmds.c Cmd_KickPlayer_f): printable ASCII,
// at most 126 characters, none of " ; % / \. Pure, shared by RCON and UI.
export function validKickReason(reason = '') {
  const value = typeof reason === 'string' ? reason.trim() : null;
  if (value === null || !/^[\x20-\x7e]{0,126}$/.test(value) || /[";%/\\]/.test(value)) throw Object.assign(new Error('RCON_KICK_INVALID'), { code: 'RCON_KICK_INVALID' });
  return value;
}

// Block 24d: a chat line from the phone (`say`). Same character rule as the
// kick reason, 1-150 characters; the whole line is one argument of `say`.
export function validSayText(text) {
  const value = typeof text === 'string' ? text.trim() : null;
  if (value === null || !/^[\x20-\x7e]{1,150}$/.test(value) || /[";%/\\]/.test(value)) throw Object.assign(new Error('RCON_SAY_INVALID'), { code: 'RCON_SAY_INVALID' });
  return value;
}

// Ban-and-kick shows the ban reason to the player when CoD4x can carry it.
export function kickReasonFromBan(reason) {
  try { return validKickReason(reason); } catch { return ''; }
}
