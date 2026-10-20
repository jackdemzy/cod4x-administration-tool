import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInfoPacket, buildRconPacket, classifyRconResponse, normalizeRconCommand, parseInfoResponse, parsePacket, RCON_COMMANDS } from '../lib/rcon-protocol.mjs';
import { redactProcessInfo, redactRuntimeArguments, redactRuntimeOutput } from '../lib/runtime-secret-redaction.mjs';

test('allowlist accepts only controlled admin commands in normalized form', () => {
  assert.deepEqual(RCON_COMMANDS.map(entry => entry.name), ['status', 'serverinfo', 'systeminfo', 'map_rotate', 'map', 'plugins', 'plugininfo']);
  // Read-only plugin handler commands (4.18.8); loading/unloading stays blocked.
  assert.equal(normalizeRconCommand('PLUGINS'), 'plugins');
  assert.equal(normalizeRconCommand('pluginInfo b3hide'), 'pluginInfo b3hide');
  for (const blocked of ['loadPlugin b3hide', 'unloadPlugin b3hide', 'pluginInfo', 'pluginInfo ../x', 'pluginInfo a b', 'pluginInfo b3hide; quit']) {
    assert.throws(() => normalizeRconCommand(blocked), { code: 'RCON_COMMAND_BLOCKED' }, blocked);
  }
  assert.equal(normalizeRconCommand('  STATUS '), 'status');
  assert.equal(normalizeRconCommand('map  MP_Crash'), 'map mp_crash');
  assert.equal(normalizeRconCommand('map_rotate'), 'map_rotate');
  for (const blocked of ['rcon_password x', 'quit', 'killserver', 'exec server.cfg', 'status; quit', 'map mp_crash; quit', 'map ../x', 'map', 'map a b',
    'devmap mp_crash', 'kick 1', 'set sv_cheats 1', 'status\nquit', 'serverinfo extra', '', 'mäp', 'x'.repeat(97), null, 42]) {
    assert.throws(() => normalizeRconCommand(blocked), { code: 'RCON_COMMAND_BLOCKED' }, String(blocked));
  }
});

test('rcon packet matches the CoD4x connectionless format and rejects unusable passwords', () => {
  const packet = buildRconPacket(Buffer.from('Proto-Pass-123'), 'status');
  assert.deepEqual([...packet.subarray(0, 4)], [0xff, 0xff, 0xff, 0xff]);
  assert.equal(packet.subarray(4).toString('latin1'), 'rcon Proto-Pass-123 status');
  for (const password of ['short', 'with space!', 'quote"pass1', 'semi;colon1', 'back\\slash1']) {
    assert.throws(() => buildRconPacket(Buffer.from(password), 'status'), { code: 'RCON_PASSWORD_INVALID' });
  }
  assert.throws(() => buildRconPacket('Proto-Pass-123', 'status'), { code: 'RCON_PASSWORD_INVALID' }, 'Password must be a Buffer the caller can wipe');
  assert.throws(() => buildRconPacket(Buffer.from('Proto-Pass-123'), 'quit'), { code: 'RCON_COMMAND_BLOCKED' });
  assert.equal(buildInfoPacket('abcdef12').subarray(4).toString(), 'getinfo abcdef12');
});

test('responses are parsed and classified like the server answers them', () => {
  const print = parsePacket(Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from('print\nmap: mp_crash\n')]));
  assert.deepEqual(print, { type: 'print', body: 'map: mp_crash\n' });
  assert.equal(parsePacket(Buffer.from('print\nno oob')), null);
  assert.equal(classifyRconResponse('Bad rcon'), 'RCON_AUTH_FAILED');
  assert.equal(classifyRconResponse('No rconpassword set on server or password is shorter than 8 characters.\n'), 'RCON_PASSWORD_NOT_ACTIVE');
  assert.equal(classifyRconResponse('map: mp_crash'), null);
  assert.deepEqual(parseInfoResponse('\\challenge\\abc\\hostname\\Test\\clients\\3'), { challenge: 'abc', hostname: 'Test', clients: '3' });
});

test('secret CVAR values are redacted from arguments, process info and output', () => {
  const args = ['+set', 'net_port', '28960', '+set', 'rcon_password', 'Redact-Me-123', '+exec', 'server.cfg'];
  assert.deepEqual(redactRuntimeArguments(args), ['+set', 'net_port', '28960', '+set', 'rcon_password', '[redacted]', '+exec', 'server.cfg']);
  assert.equal(args[5], 'Redact-Me-123', 'Redaction must not mutate the spawn arguments');
  const info = redactProcessInfo({ commandLine: '"core.exe" "+set" "rcon_password" "Redact-Me-123" "+map" "x"', argv: [...args] });
  assert.ok(!JSON.stringify(info).includes('Redact-Me-123'));
  const restart = 'Restart commandline is: core.exe +set rcon_password Redact-Me-123 +map x\nnext line\n';
  assert.equal(redactRuntimeOutput(restart), 'Restart commandline is: core.exe +set rcon_password [redacted]\nnext line\n');
  // A line split across output chunks is redacted again once it is completed.
  const first = redactRuntimeOutput('x +set rcon_password Redact-');
  assert.ok(!redactRuntimeOutput(first + 'Me-123 +map\n').includes('Me-123'));
});

// --- Block 15b: separate, verified kick packet; the console stays closed --------
import { buildKickPacket, validKickReason } from '../lib/rcon-protocol.mjs';
test('kick packet carries only a numeric slot and a checked reason', () => {
  const password = Buffer.from('Kick-Rcon-123');
  assert.equal(buildKickPacket(password, 7, 'Cheating').subarray(4).toString('latin1'), 'rcon Kick-Rcon-123 clientkick 7 Cheating');
  assert.equal(buildKickPacket(password, 0, '').subarray(4).toString('latin1'), 'rcon Kick-Rcon-123 clientkick 0');
  assert.equal(buildKickPacket(password, 63).subarray(4).toString('latin1'), 'rcon Kick-Rcon-123 clientkick 63');
  for (const slot of [64, -1, 1.5, 'all', '7', null]) assert.throws(() => buildKickPacket(password, slot, ''), { code: 'RCON_KICK_INVALID' }, String(slot));
  for (const reason of ['"x"', 'a;b', '50%', 'a/b', 'a\b', 'line\nbreak', 'x'.repeat(127), 'ümlaut']) assert.throws(() => validKickReason(reason), { code: 'RCON_KICK_INVALID' }, reason);
  assert.equal(validKickReason('  AFK too long  '), 'AFK too long');
});

test('the console allowlist still rejects every kick form', () => {
  for (const input of ['clientkick 0', 'kick all', 'kick 1', 'onlykick 1', 'clientkick 0 reason']) assert.throws(() => normalizeRconCommand(input), { code: 'RCON_COMMAND_BLOCKED' }, input);
});
