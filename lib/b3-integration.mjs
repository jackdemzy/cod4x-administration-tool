import crypto from 'node:crypto';

// B3 <-> CoD4x integration plan (Roadmap Block 16). Pure: no file system, no
// network, no secret values. Sources: CoD4x_Server plugins/cod4x_b3hide/b3hide.c
// (dvars b3Prefix/b3Hide/b3HideLvl, command client_checkin; only the first
// prefix character is compared) and eBc-B3 b3/extplugins/auth.py.
export { B3_INTEGRATION_CODES, b3IntegrationMessage } from './b3-integration-messages.mjs';

export const B3_HIDE_LEVELS = Object.freeze([1, 2, 20, 40, 60, 80, 100]);
export const B3_PREFIX_CHARS = '!@#$%&*.,:?=~-';
// Official CoD4x 21.2 release packages (GitHub Actions build 2022-05-01). A hint
// for the operator only; approval of the file stays manual.
export const KNOWN_B3HIDE_HASHES = Object.freeze({
  linux: 'f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30',
  windows: '51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb',
});
export const B3_INTEGRATION_DEFAULTS = Object.freeze({ hideCommands: false, prefix: '!', hideLevel: 20 });

const fail = code => { throw Object.assign(new Error(code), { code }); };

// eBc-B3 auth.py compares the rest of the chat line with the password, so no
// spaces; the value also lands in an INI file, so no INI/XML/command metacharacters.
export function validB3AuthPassword(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{4,64}$/.test(value) || /[";\\<>&]/.test(value)) fail('B3_AUTH_PASSWORD_INVALID');
  return value;
}
export function validB3AuthLevel(level) {
  if (!B3_HIDE_LEVELS.includes(level)) fail('B3_AUTH_PASSWORD_INVALID');
  return level;
}

export function normalizeB3Integration(input) {
  const value = input && typeof input === 'object' ? input : {};
  const prefix = value.prefix === undefined ? B3_INTEGRATION_DEFAULTS.prefix : value.prefix;
  const hideLevel = value.hideLevel === undefined ? B3_INTEGRATION_DEFAULTS.hideLevel : value.hideLevel;
  if (typeof prefix !== 'string' || prefix.length !== 1 || !B3_PREFIX_CHARS.includes(prefix)) fail('B3_PREFIX_INVALID');
  if (!B3_HIDE_LEVELS.includes(hideLevel)) fail('B3_HIDE_LEVEL_INVALID');
  return { hideCommands: value.hideCommands === true, prefix, hideLevel };
}

const B3HIDE_BLOCKERS = Object.freeze({
  MISSING: 'B3HIDE_MISSING', INVALID: 'B3HIDE_MISSING', NOT_APPROVED: 'B3HIDE_NOT_APPROVED',
  INTEGRITY_MISMATCH: 'B3HIDE_INTEGRITY_FAILED', WRONG_PLATFORM: 'B3HIDE_WRONG_PLATFORM',
});

// b3hideState: plugin-manager state of the b3hide record/file, or null when neither exists.
export function planB3Integration({ settings, b3hideState = null, authPluginPresent = false, credentialsPresent = {} }) {
  const config = normalizeB3Integration(settings);
  const enabled = config.hideCommands;
  const rconPresent = credentialsPresent.rcon === true;
  const levels = Array.isArray(credentialsPresent.b3authLevels) ? credentialsPresent.b3authLevels : [];
  const blockers = [], warnings = [];
  if (enabled) {
    if (b3hideState !== 'ENABLED' && b3hideState !== 'DISABLED') blockers.push({ code: B3HIDE_BLOCKERS[b3hideState] || 'B3HIDE_MISSING' });
    if (!rconPresent) blockers.push({ code: 'RCON_PASSWORD_MISSING' });
    if (!authPluginPresent) blockers.push({ code: 'B3_AUTH_PLUGIN_MISSING' });
  } else if (!rconPresent) warnings.push({ code: 'RCON_PASSWORD_MISSING' });
  const b3hide = enabled ? { b3Prefix: config.prefix, b3Hide: '1', b3HideLvl: String(config.hideLevel) } : null;
  const auth = { enabled, passwordLevels: enabled ? B3_HIDE_LEVELS.filter(level => levels.includes(level)) : [] };
  const rcon = { required: enabled, present: rconPresent };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([enabled, b3hide, auth, rcon.required])).digest('hex');
  return { enabled, settings: config, b3hide, auth, rcon, blockers, warnings, fingerprint };
}
