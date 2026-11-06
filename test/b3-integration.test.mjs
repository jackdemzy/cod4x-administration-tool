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
  assert.equal(B3_PREFIX_CHARS, '!@#$%&*.,:?=~-');
  assert.equal(KNOWN_B3HIDE_HASHES.linux, 'f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30');
  assert.equal(KNOWN_B3HIDE_HASHES.windows, '51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb');
});

test('normalize fills defaults and rejects invalid prefix and level', () => {
  assert.deepEqual(normalizeB3Integration(undefined), { hideCommands: false, prefix: '!', hideLevel: 20 });
  assert.deepEqual(normalizeB3Integration({ hideCommands: true, prefix: '#', hideLevel: 40 }), { hideCommands: true, prefix: '#', hideLevel: 40 });
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
  assert.notEqual(plan({ settings: settings({ prefix: '#' }) }).fingerprint, base);
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
  const record = { fingerprint: current.fingerprint, vaultSha256: 'a'.repeat(64) };
  assert.deepEqual(restartHints({ plan: current, vaultSha256: 'a'.repeat(64), launchedWith: record, startedWith: record }), { server: null, b3: null });
  assert.deepEqual(restartHints({ plan: plan({ settings: settings({ prefix: '#' }) }), vaultSha256: 'a'.repeat(64), launchedWith: record, startedWith: null }), { server: 'SETTINGS_CHANGED', b3: null });
  assert.deepEqual(restartHints({ plan: current, vaultSha256: 'b'.repeat(64), launchedWith: null, startedWith: record }), { server: null, b3: 'CREDENTIALS_CHANGED' });
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
