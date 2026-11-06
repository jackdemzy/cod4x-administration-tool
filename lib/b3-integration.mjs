import crypto from 'node:crypto';

// B3 <-> CoD4x integration plan (Roadmap Block 16). Pure: no file system, no
// network, no secret values. Sources: CoD4x_Server plugins/cod4x_b3hide/b3hide.c
// (dvars b3Prefix/b3Hide/b3HideLvl, command client_checkin; only the first
// prefix character is compared) and eBc-B3 b3/extplugins/auth.py.
export { B3_INTEGRATION_CODES, b3IntegrationMessage } from './b3-integration-messages.mjs';

import { B3_HIDE_LEVELS, B3_PREFIX_CHARS, B3_INTEGRATION_DEFAULTS } from './b3-integration-constants.mjs';
export { B3_HIDE_LEVELS, B3_PREFIX_CHARS, KNOWN_B3HIDE_HASHES, B3_INTEGRATION_DEFAULTS, B3_LEVEL_NAMES } from './b3-integration-constants.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };

// eBc-B3 auth.py compares the rest of the chat line with the password, so no
// spaces; the value also lands in an INI file, so no INI/XML/command metacharacters.
export function validB3AuthPassword(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{4,64}$/.test(value) || /[";\\<>&%]/.test(value)) fail('B3_AUTH_PASSWORD_INVALID');
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
  // A locked vault hides whether the RCON password exists.
  const locked = credentialsPresent.locked === true;
  if (enabled) {
    if (b3hideState !== 'ENABLED' && b3hideState !== 'DISABLED') blockers.push({ code: B3HIDE_BLOCKERS[b3hideState] || 'B3HIDE_MISSING' });
    if (locked) blockers.push({ code: 'VAULT_LOCKED' });
    else if (!rconPresent) blockers.push({ code: 'RCON_PASSWORD_MISSING' });
    if (!authPluginPresent) blockers.push({ code: 'B3_AUTH_PLUGIN_MISSING' });
  } else if (!rconPresent && !locked) warnings.push({ code: 'RCON_PASSWORD_MISSING' });
  // b3hide only hides chat of players at or above the hide level, so a lower
  // level's !auth password would be shown to everyone when typed: never written.
  const below = enabled ? B3_HIDE_LEVELS.filter(level => levels.includes(level) && level < config.hideLevel) : [];
  if (below.length) warnings.push({ code: 'B3_AUTH_LEVEL_BELOW_HIDE', levels: below });
  const b3hide = enabled ? { b3Prefix: config.prefix, b3Hide: '1', b3HideLvl: String(config.hideLevel) } : null;
  const auth = { enabled, passwordLevels: enabled ? B3_HIDE_LEVELS.filter(level => levels.includes(level) && level >= config.hideLevel) : [] };
  const rcon = { required: enabled, present: rconPresent };
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // The core only sees the b3hide dvars; B3 also sees auth and RCON.
  const fingerprint = hash([enabled, b3hide, auth, rcon.required]), serverFingerprint = hash([enabled, b3hide]);
  return { enabled, settings: config, b3hide, auth, rcon, blockers, warnings, fingerprint, serverFingerprint };
}

// What the server and B3 were started with versus the current plan and vault.
// The vault hash changes with any credential, so the hint never names one.
// credentialDigest covers only this instance's vault records, so another
// server's credential change never asks for a restart here.
export function restartHints({ plan, credentialDigest = null, launchedWith = null, startedWith = null }) {
  const hint = (record, key) => !record ? null : record[key] !== plan[key] ? 'SETTINGS_CHANGED'
    : credentialDigest && record.credentialDigest && record.credentialDigest !== credentialDigest ? 'CREDENTIALS_CHANGED' : null;
  return { server: hint(launchedWith, 'serverFingerprint'), b3: hint(startedWith, 'fingerprint') };
}

// Health row "b3hide/auth connected" for the B3 dashboard.
export function integrationRow({ plan, b3hideLoad = null, b3Running = false, startedWith = null, authStarted = false }) {
  if (!plan?.enabled) return { status: 'OFF', code: null };
  if (plan.blockers.length) return { status: 'BLOCKED', code: plan.blockers[0].code };
  if (b3hideLoad !== 'LOADED') return { status: 'NOT_CONNECTED', code: 'B3HIDE_NOT_LOADED' };
  if (!b3Running || startedWith?.fingerprint !== plan.fingerprint || !authStarted) return { status: 'NOT_CONNECTED', code: 'B3_AUTH_NOT_STARTED' };
  return { status: 'OK', code: null };
}
