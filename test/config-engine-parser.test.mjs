import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigAssignments, writeConfigAssignments, diffConfigAssignments, validateConfigModel, CONFIG_SCHEMA } from '../lib/config-engine.mjs';

test('config parser preserves quoted delimiters and comments, with deterministic writer roundtrip', () => {
  const input = '// header\nset sv_hostname "Name; // remains data"; seta g_log "logs/games_mp.log"\nsets locale "de"';
  const result = parseConfigAssignments(input);
  assert.deepEqual(result.map(entry => [entry.command, entry.name, entry.value]), [['set', 'sv_hostname', 'Name; // remains data'], ['seta', 'g_log', 'logs/games_mp.log'], ['sets', 'locale', 'de']]);
  assert.deepEqual(parseConfigAssignments(writeConfigAssignments(result)), result);
});
test('parser rejects duplicates case-insensitively, scripts, malformed syntax and unsafe bytes without leaking values', () => {
  for (const input of ['set name "one"\nset NAME "two"', 'exec other.cfg', 'set value "unterminated', 'set value "secret" trailing', 'set name "x\\u0000"'.replace('\\u0000', '\u0000'), 'set name "x" /* comment */', 'set name "a\\"b"']) {
    assert.throws(() => parseConfigAssignments(input), error => error.code === 'CONFIG_PARSE_INVALID' && !error.message.includes('secret'));
  }
  assert.throws(() => parseConfigAssignments('x'.repeat(256 * 1024 + 1)), { code: 'CONFIG_PARSE_INVALID' });
});
test('diff identifies added removed and modified fields and redacts credential values', () => {
  const before = parseConfigAssignments('set sv_hostname "Old"\nset rcon_password "do-not-leak"\nset unused "gone"');
  const after = parseConfigAssignments('set sv_hostname "New"\nset rcon_password "also-private"\nset logfile "2"');
  const diff = diffConfigAssignments(before, after);
  assert.deepEqual(diff.map(x => [x.name, x.change]), [['logfile', 'added'], ['rcon_password', 'modified'], ['sv_hostname', 'modified'], ['unused', 'removed']]);
  assert.equal(diff.find(x => x.name === 'rcon_password').before, '[REDACTED]');
  assert.equal(diff.find(x => x.name === 'rcon_password').after, '[REDACTED]');
  assert.ok(!JSON.stringify(diff).includes('private'));
});

test('schema validates engine-backed CVARs and refuses unknown names, invalid values and lifecycle overrides', () => {
  const instance = { port: 49232 };
  assert.equal(validateConfigModel(parseConfigAssignments('set sv_hostname "Test"\nset sv_maxclients "18"\nset net_port "49232"\nset g_log "logs/games_mp.log"'), instance).valid, true);
  for (const input of ['set unknown_setting "1"', 'set sv_maxclients "65"', 'set sv_maxclients "1.5"', 'set net_port "49233"', 'set net_ip "0.0.0.0"', 'set fs_homepath "/foreign"', 'set g_log "../foreign.log"', 'set g_gametype "war; quit"', 'set sv_pure "2"', 'set rcon_password "private"', 'set sv_authtoken "private"']) {
    assert.throws(() => validateConfigModel(parseConfigAssignments(input), instance), error => error.code === 'CONFIG_SCHEMA_INVALID' && !error.message.includes('private'));
  }
  assert.equal(CONFIG_SCHEMA.sv_maxclients.restartRequired, true);
  assert.equal(CONFIG_SCHEMA.net_port.managed, true);
});
