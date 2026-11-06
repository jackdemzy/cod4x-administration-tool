import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  B3_HIDE_LEVELS, B3_PREFIX_CHARS, KNOWN_B3HIDE_HASHES, normalizeB3Integration, planB3Integration, b3IntegrationMessage, B3_INTEGRATION_CODES,
} from '../lib/b3-integration.mjs';

const code = fn => { try { fn(); } catch (error) { return error.code; } return null; };
const settings = (overrides = {}) => normalizeB3Integration({ hideCommands: true, ...overrides });
const plan = (overrides = {}) => planB3Integration({
  settings: settings(), b3hideState: 'ENABLED', authPluginPresent: true, credentialsPresent: { rcon: true, b3authLevels: [] }, ...overrides,
});
const codes = list => list.map(entry => entry.code);

test('constants match the spec', () => {
  assert.deepEqual(B3_HIDE_LEVELS, [1, 2, 20, 40, 60, 80, 100]);
  assert.equal(B3_PREFIX_CHARS, '!');
  assert.equal(KNOWN_B3HIDE_HASHES.linux, 'f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30');
  assert.equal(KNOWN_B3HIDE_HASHES.windows, '51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb');
});

test('normalize fills defaults and rejects invalid prefix and level', () => {
  assert.deepEqual(normalizeB3Integration(undefined), { hideCommands: false, prefix: '!', hideLevel: 20 });
  assert.deepEqual(normalizeB3Integration({ hideCommands: true, prefix: '!', hideLevel: 40 }), { hideCommands: true, prefix: '!', hideLevel: 40 });
  for (const prefix of ['!!', '', 'a', ' ', '"']) assert.equal(code(() => normalizeB3Integration({ prefix })), 'B3_PREFIX_INVALID', prefix);
  for (const hideLevel of [0, 21, '20', 101]) assert.equal(code(() => normalizeB3Integration({ hideLevel })), 'B3_HIDE_LEVEL_INVALID', String(hideLevel));
});

test('switch off: no b3hide, no auth, missing rcon is only a warning', () => {
  const result = planB3Integration({ settings: normalizeB3Integration({}), b3hideState: null, authPluginPresent: false, credentialsPresent: { rcon: false, b3authLevels: [] } });
  assert.equal(result.enabled, false);
  assert.equal(result.b3hide, null);
  assert.equal(result.auth.enabled, false);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, [{ code: 'RCON_PASSWORD_MISSING' }]);
  assert.equal(result.rcon.required, false);
});

test('switch on with everything present has no blockers and the default dvars', () => {
  for (const b3hideState of ['ENABLED', 'DISABLED']) {
    const result = plan({ b3hideState });
    assert.deepEqual(result.blockers, [], b3hideState);
    assert.deepEqual(result.b3hide, { b3Prefix: '!', b3Hide: '1', b3HideLvl: '20' });
    assert.equal(result.auth.enabled, true);
    assert.equal(result.rcon.required, true);
  }
});

test('switch on: each missing piece is its own blocker', () => {
  assert.deepEqual(codes(plan({ b3hideState: null }).blockers), ['B3HIDE_MISSING']);
  assert.deepEqual(codes(plan({ b3hideState: 'MISSING' }).blockers), ['B3HIDE_MISSING']);
  assert.deepEqual(codes(plan({ b3hideState: 'NOT_APPROVED' }).blockers), ['B3HIDE_NOT_APPROVED']);
  assert.deepEqual(codes(plan({ b3hideState: 'INTEGRITY_MISMATCH' }).blockers), ['B3HIDE_INTEGRITY_FAILED']);
  assert.deepEqual(codes(plan({ b3hideState: 'WRONG_PLATFORM' }).blockers), ['B3HIDE_WRONG_PLATFORM']);
  assert.deepEqual(codes(plan({ credentialsPresent: { rcon: false, b3authLevels: [] } }).blockers), ['RCON_PASSWORD_MISSING']);
  assert.deepEqual(codes(plan({ authPluginPresent: false }).blockers), ['B3_AUTH_PLUGIN_MISSING']);
});

test('password levels are the sorted known levels', () => {
  assert.deepEqual(plan({ credentialsPresent: { rcon: true, b3authLevels: [100, 7, 20] } }).auth.passwordLevels, [20, 100]);
  assert.deepEqual(planB3Integration({ settings: normalizeB3Integration({}), b3hideState: null, authPluginPresent: true, credentialsPresent: { rcon: true, b3authLevels: [100] } }).auth.passwordLevels, []);
});

test('fingerprint is stable and follows the non-secret settings', () => {
  const base = plan().fingerprint;
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(plan().fingerprint, base);
  assert.notEqual(plan({ settings: settings({ hideLevel: 40 }) }).fingerprint, base);
  assert.notEqual(plan({ settings: settings({ hideCommands: false }) }).fingerprint, base);
});

test('every code has a German and an English message', () => {
  for (const entry of ['B3HIDE_MISSING', 'B3HIDE_NOT_APPROVED', 'B3HIDE_INTEGRITY_FAILED', 'B3HIDE_WRONG_PLATFORM', 'B3HIDE_NOT_LOADED', 'RCON_PASSWORD_MISSING', 'VAULT_LOCKED',
    'B3_AUTH_PLUGIN_MISSING', 'B3_PREFIX_INVALID', 'B3_HIDE_LEVEL_INVALID', 'B3_INTEGRATION_BUSY', 'B3_INTEGRATION_CONTROLLED', 'B3_AUTH_PASSWORD_INVALID']) {
    assert.ok(B3_INTEGRATION_CODES.includes(entry), entry);
    assert.ok(b3IntegrationMessage(entry, 'de').length > 5, entry);
    assert.ok(b3IntegrationMessage(entry, 'en').length > 5, entry);
    assert.notEqual(b3IntegrationMessage(entry, 'de'), b3IntegrationMessage(entry, 'en'), entry);
  }
});

test('a locked vault is its own blocker when the switch is on and no warning when off', () => {
  const locked = { rcon: false, b3authLevels: [], locked: true };
  assert.deepEqual(codes(plan({ credentialsPresent: locked }).blockers), ['VAULT_LOCKED']);
  assert.deepEqual(planB3Integration({ settings: normalizeB3Integration({}), b3hideState: null, authPluginPresent: true, credentialsPresent: locked }).warnings, []);
});

test('restartHints: changed settings, changed credentials, or nothing recorded', async () => {
  const { restartHints } = await import('../lib/b3-integration.mjs');
  const current = plan();
  const record = { fingerprint: current.fingerprint, serverFingerprint: current.serverFingerprint, credentialDigest: 'a'.repeat(64) };
  assert.deepEqual(restartHints({ plan: current, credentialDigest: 'a'.repeat(64), launchedWith: record, startedWith: record }), { server: null, b3: null });
  assert.deepEqual(restartHints({ plan: plan({ settings: settings({ hideLevel: 40 }) }), credentialDigest: 'a'.repeat(64), launchedWith: record, startedWith: null }), { server: 'SETTINGS_CHANGED', b3: null });
  assert.deepEqual(restartHints({ plan: current, credentialDigest: 'b'.repeat(64), launchedWith: null, startedWith: record }), { server: null, b3: 'CREDENTIALS_CHANGED' });
});

test('integrationRow: off, blocked, not connected and ok', async () => {
  const { integrationRow } = await import('../lib/b3-integration.mjs');
  const on = plan();
  const started = { fingerprint: on.fingerprint };
  assert.deepEqual(integrationRow({ plan: planB3Integration({ settings: normalizeB3Integration({}), credentialsPresent: { rcon: true } }) }), { status: 'OFF', code: null });
  assert.deepEqual(integrationRow({ plan: plan({ b3hideState: 'NOT_APPROVED' }) }), { status: 'BLOCKED', code: 'B3HIDE_NOT_APPROVED' });
  assert.deepEqual(integrationRow({ plan: on, b3hideLoad: 'PENDING', b3Running: true, startedWith: started, authStarted: true }), { status: 'NOT_CONNECTED', code: 'B3HIDE_NOT_LOADED' });
  assert.deepEqual(integrationRow({ plan: on, b3hideLoad: 'LOADED', b3Running: true, startedWith: started, authStarted: false }), { status: 'NOT_CONNECTED', code: 'B3_AUTH_NOT_STARTED' });
  assert.deepEqual(integrationRow({ plan: on, b3hideLoad: 'LOADED', b3Running: true, startedWith: { fingerprint: 'x' }, authStarted: true }), { status: 'NOT_CONNECTED', code: 'B3_AUTH_NOT_STARTED' });
  assert.deepEqual(integrationRow({ plan: on, b3hideLoad: 'LOADED', b3Running: true, startedWith: started, authStarted: true }), { status: 'OK', code: null });
});

test('PR #23 review: a known different B3 command prefix blocks the integration, an unchecked one does not', () => {
  assert.deepEqual(codes(plan({ b3CommandPrefix: '#' }).blockers), ['B3_COMMAND_PREFIX_MISMATCH']);
  assert.deepEqual(codes(plan({ b3CommandPrefix: '' }).blockers), ['B3_COMMAND_PREFIX_MISMATCH'], 'an unreadable prefix fails closed');
  assert.deepEqual(codes(plan({ b3CommandPrefix: '!' }).blockers), []);
  assert.deepEqual(codes(plan({ b3CommandPrefix: null }).blockers), [], 'the server launch does not check the B3 source');
  assert.deepEqual(codes(plan({ authPluginPresent: false, b3CommandPrefix: '#' }).blockers), ['B3_AUTH_PLUGIN_MISSING']);
  assert.deepEqual(codes(planB3Integration({ settings: normalizeB3Integration({ hideCommands: false }), b3CommandPrefix: '#', credentialsPresent: { rcon: true } }).blockers), []);
  assert.ok(B3_INTEGRATION_CODES.includes('B3_COMMAND_PREFIX_MISMATCH'));
  assert.notEqual(b3IntegrationMessage('B3_COMMAND_PREFIX_MISMATCH', 'en'), 'B3_COMMAND_PREFIX_MISMATCH');
});

test('restartHints (Block 16b): PLUGINS_CHANGED for a newer revision, null when equal', async () => {
  const plan = { fingerprint: 'f'.repeat(64), serverFingerprint: 's'.repeat(64) };
  const startedWith = { fingerprint: plan.fingerprint, credentialDigest: 'd', pluginsRevision: 2 };
  const { restartHints } = await import('../lib/b3-integration.mjs');
  assert.deepEqual(restartHints({ plan, credentialDigest: 'd', startedWith, pluginsRevision: 3 }), { server: null, b3: 'PLUGINS_CHANGED' });
  assert.deepEqual(restartHints({ plan, credentialDigest: 'd', startedWith, pluginsRevision: 2 }), { server: null, b3: null });
  // Existing hints win; a start without a recorded revision counts as 0; no start, no hint.
  assert.equal(restartHints({ plan: { ...plan, fingerprint: 'x' }, credentialDigest: 'd', startedWith, pluginsRevision: 3 }).b3, 'SETTINGS_CHANGED');
  assert.equal(restartHints({ plan, credentialDigest: 'e', startedWith, pluginsRevision: 3 }).b3, 'CREDENTIALS_CHANGED');
  assert.equal(restartHints({ plan, startedWith: { fingerprint: plan.fingerprint }, pluginsRevision: 0 }).b3, null);
  assert.equal(restartHints({ plan, startedWith: { fingerprint: plan.fingerprint }, pluginsRevision: 1 }).b3, 'PLUGINS_CHANGED');
  assert.equal(restartHints({ plan, startedWith: null, pluginsRevision: 3 }).b3, null);
});
