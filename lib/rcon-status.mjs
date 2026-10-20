// CoD4x `status` output (CoD4x_Server src/sv_cmds.c SV_Status_f). Non-legacy
// columns: num score ping playerid steamid name lastmsg address qport rate;
// legacy mode prints a single guid column instead of playerid + steamid.
// Names may contain spaces and colour codes and are followed by "^7", so rows
// are matched from the right.
const MODERN = /^\s*(\d{1,2})\s+(-?\d+)\s+(\d+|CNCT|PRIM|ZMBI)\s+(\S+)\s+(\S+)\s+(.*?)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(\d+)\s*$/;
const LEGACY = /^\s*(\d{1,2})\s+(-?\d+)\s+(\d+|CNCT|PRIM|ZMBI)\s+(\S+)\s+(.*?)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(\d+)\s*$/;

export const cleanName = raw => String(raw || '').replace(/\^\d/g, '').trim();

export function parseStatus(text) {
  const lines = String(text || '').split(/\r?\n/);
  const map = lines.map(line => /^map\s*:\s*(\S+)/.exec(line)?.[1]).find(Boolean) || null;
  const header = lines.find(line => /^num\s+score\s+ping/.test(line)) || '';
  const legacy = header !== '' && !/\bsteamid\b/.test(header);
  const players = [];
  for (const line of lines) {
    const match = (legacy ? LEGACY : MODERN).exec(line);
    if (!match) continue;
    const [slot, score, ping, playerid] = match.slice(1, 5);
    const [steamid, rawName, lastmsg, address, qport, rate] = legacy ? ['', ...match.slice(5)] : match.slice(5);
    players.push({ slot: Number(slot), score: Number(score), ping: /^\d+$/.test(ping) ? Number(ping) : ping, playerid, steamid, name: cleanName(rawName), rawName,
      lastmsg: Number(lastmsg), address, bot: address === 'bot', qport: Number(qport), rate: Number(rate) });
  }
  // header: the player table was present (a cut-off reply proves nothing).
  return { map, header: header !== '', players };
}
