import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeB3Integration, planB3Integration, validB3AuthPassword, restartHints } from '../lib/b3-integration.mjs';
import { redactRuntimeOutput } from '../lib/runtime-secret-redaction.mjs';
import { readInstanceConsoleLog } from '../lib/instance-console-log.mjs';

// Regression tests for the Block 16 pre-PR review (superpowers:requesting-code-review).
const code = fn => { try { fn(); } catch (error) { return error.code; } return null; };
const plan = (settings, credentialsPresent = { rcon: true, b3authLevels: [] }) => planB3Integration({ settings: normalizeB3Integration(settings), b3hideState: 'ENABLED', authPluginPresent: true, credentialsPresent });

test('C1: a typed !auth password is redacted from B3 log, output and RCON views', () => {
  for (const line of ["261106 02:00:00\tVERBOSE\t'Queueing event EVT_CLIENT_SAY : !auth hunter22'", 'say;123;0;Admin;!auth hunter22', 'Admin: @auth hunter22 extra']) {
    const shown = redactRuntimeOutput(line);
    assert.ok(!shown.includes('hunter22'), shown);
    assert.match(shown, /auth \[redacted\]/);
  }
  assert.equal(redactRuntimeOutput('Admin: !authors are great'), 'Admin: !authors are great');
});

test('C1: the console log view redacts a typed !auth password', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-auth-console-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'main'));
  await fs.writeFile(path.join(home, 'main', 'qconsole.log'), 'say: Admin^7: !auth hunter22\nnormal line\n');
  const view = await readInstanceConsoleLog(home);
  assert.ok(!view.text.includes('hunter22'), view.text);
  assert.match(view.text, /normal line/);
});

test('C2: the prefix is B3\'s own command prefix "!" (CONTROL does not change plugin_admin.ini)', () => {
  assert.equal(normalizeB3Integration({}).prefix, '!');
  for (const prefix of ['#', '@', '&', '.']) assert.equal(code(() => normalizeB3Integration({ prefix })), 'B3_PREFIX_INVALID', prefix);
});

test('I3: a percent sign is rejected in !auth passwords (B3 ConfigParser would break it)', () => {
  for (const value of ['ab%cd', 'x%(y)s']) assert.equal(code(() => validB3AuthPassword(value)), 'B3_AUTH_PASSWORD_INVALID', value);
  assert.equal(validB3AuthPassword('ab-cd_ef'), 'ab-cd_ef');
});

test('I4: passwords below the hide level are not written and are reported', () => {
  const result = plan({ hideCommands: true, hideLevel: 40 }, { rcon: true, b3authLevels: [20, 40, 100] });
  assert.deepEqual(result.auth.passwordLevels, [40, 100]);
  assert.deepEqual(result.warnings, [{ code: 'B3_AUTH_LEVEL_BELOW_HIDE', levels: [20] }]);
});

test('I5: an !auth change never asks for a server restart; credentials compare per instance', () => {
  const before = plan({ hideCommands: true }, { rcon: true, b3authLevels: [] });
  const after = plan({ hideCommands: true }, { rcon: true, b3authLevels: [100] });
  assert.equal(before.serverFingerprint, after.serverFingerprint);
  assert.notEqual(before.fingerprint, after.fingerprint);
  const record = fingerprint => ({ fingerprint, serverFingerprint: before.serverFingerprint, credentialDigest: 'd1' });
  assert.deepEqual(restartHints({ plan: after, credentialDigest: 'd1', launchedWith: record(before.fingerprint), startedWith: record(before.fingerprint) }), { server: null, b3: 'SETTINGS_CHANGED' });
  assert.deepEqual(restartHints({ plan: before, credentialDigest: 'd2', launchedWith: record(before.fingerprint), startedWith: record(before.fingerprint) }), { server: 'CREDENTIALS_CHANGED', b3: 'CREDENTIALS_CHANGED' });
  assert.deepEqual(restartHints({ plan: before, credentialDigest: 'd1', launchedWith: record(before.fingerprint), startedWith: record(before.fingerprint) }), { server: null, b3: null });
});
