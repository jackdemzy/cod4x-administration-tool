// CoD4x Dedicated RCON wire format, checked against callofduty4x/CoD4x_Server
// (src/sv_main.c SV_ConnectionlessPacket / SVC_RemoteCommand / SV_FlushRedirect):
// request  = 0xFFFFFFFF "rcon <rcon_password> <command>"
// response = one or more 0xFFFFFFFF "print\n<chunk>" packets (1024 byte redirect buffer)
// bad password -> "Bad rcon" (only one deny answer per 100 ms, otherwise silence)
// server password shorter than 8 characters -> "No rconpassword set on server ..."
// health   = 0xFFFFFFFF "getinfo <challenge>" -> "infoResponse\n\\...\\challenge\\<challenge>"
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const MAP_NAME = /^[A-Za-z0-9_]{1,64}$/;
const PLUGIN_NAME = /^[A-Za-z0-9_]{1,40}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Controlled admin commands only. Everything else (rcon_password, exec, quit,
// killserver, kick/ban, devmap, cvar writes ...) is rejected before any I/O.
export const RCON_COMMANDS = Object.freeze([
  Object.freeze({ name: 'status', usage: 'status', description: 'Map, Spieler, Ping, Adressen' }),
  Object.freeze({ name: 'serverinfo', usage: 'serverinfo', description: 'Serverinfo-CVARs' }),
  Object.freeze({ name: 'systeminfo', usage: 'systeminfo', description: 'Systeminfo-CVARs' }),
  Object.freeze({ name: 'map_rotate', usage: 'map_rotate', description: 'Nächste Map der Rotation laden' }),
  Object.freeze({ name: 'map', usage: 'map <mapname>', description: 'Map wechseln (z. B. mp_crash)' }),
  // Read-only plugin handler commands (src/plugin_handler.c PHandler_Init).
  Object.freeze({ name: 'plugins', usage: 'plugins', description: 'Geladene Plugins anzeigen' }),
  Object.freeze({ name: 'plugininfo', usage: 'pluginInfo <name>', description: 'Version/Beschreibung eines geladenen Plugins' }),
]);

export function normalizeRconCommand(input) {
  if (typeof input !== 'string' || input.length > 96 || /[^\x20-\x7e]/.test(input)) fail('RCON_COMMAND_BLOCKED');
  const parts = input.trim().split(/ +/);
  const name = parts[0]?.toLowerCase();
  if (['status', 'serverinfo', 'systeminfo', 'map_rotate', 'plugins'].includes(name) && parts.length === 1) return name;
  if (name === 'plugininfo' && parts.length === 2 && PLUGIN_NAME.test(parts[1])) return `pluginInfo ${parts[1]}`;
  if (name === 'map' && parts.length === 2 && MAP_NAME.test(parts[1])) return `map ${parts[1].toLowerCase()}`;
  fail('RCON_COMMAND_BLOCKED');
}

// Password stays a Buffer; the caller wipes the returned packet after sending.
export function buildRconPacket(password, command) {
  if (!Buffer.isBuffer(password) || password.length < 8 || password.length > 128) fail('RCON_PASSWORD_INVALID');
  for (const byte of password) if (byte < 0x21 || byte > 0x7e || byte === 0x22 || byte === 0x3b || byte === 0x5c) fail('RCON_PASSWORD_INVALID');
  const normalized = normalizeRconCommand(command);
  return Buffer.concat([OOB, Buffer.from('rcon ', 'ascii'), password, Buffer.from(` ${normalized}`, 'ascii')]);
}

export function buildInfoPacket(challenge) {
  if (!/^[A-Za-z0-9]{8,32}$/.test(challenge)) fail('RCON_CHALLENGE_INVALID');
  return Buffer.concat([OOB, Buffer.from(`getinfo ${challenge}`, 'ascii')]);
}

export function parsePacket(message) {
  if (!Buffer.isBuffer(message) || message.length < 5 || !message.subarray(0, 4).equals(OOB)) return null;
  const text = message.subarray(4).toString('latin1');
  const newline = text.indexOf('\n');
  const type = newline < 0 ? text : text.slice(0, newline);
  return { type, body: newline < 0 ? '' : text.slice(newline + 1) };
}

export function classifyRconResponse(text) {
  const trimmed = text.trim();
  if (trimmed === 'Bad rcon') return 'RCON_AUTH_FAILED';
  if (trimmed.startsWith('No rconpassword set on server')) return 'RCON_PASSWORD_NOT_ACTIVE';
  return null;
}

export function parseInfoResponse(body) {
  const fields = {};
  const parts = body.replace(/\n$/, '').split('\\');
  for (let index = 1; index + 1 < parts.length; index += 2) fields[parts[index]] = parts[index + 1];
  return fields;
}
