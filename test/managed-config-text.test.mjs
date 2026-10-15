import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManagedConfigText } from '../lib/instance-config-validator.mjs';

test('managed profile accepts generated assignments, quoted delimiters and comments', () => {
  const config = '// initial\r\nset sv_hostname "Name; // not comment";set net_port "28960"\nseta sv_maxclients 18\nsets net_ip "127.0.0.1" // local\nset dedicated 2';
  assert.equal(validateManagedConfigText(config, { port: 28960 }).assignments, 5);
});

test('malformed or indirect syntax and critical aliases fail closed without leaking values', () => {
  for (const config of ['set net_ip6 ::', 'set fs_game mods/x', 'set net_port 028960', 'set x "a" trailing', 'set x "a\nb"', 'set x "a";exec hidden.cfg', 'set x "a";wait;quit', 'set x "a"/*comment*/', 'sv_hostname "direct"']) {
    assert.throws(() => validateManagedConfigText(config, { port: 28960 }), { code: 'INSTANCE_CONFIG_INVALID' });
  }
});
