import test from 'node:test';
import assert from 'node:assert/strict';
import { groupWriteIsPrivate } from '../lib/posix-private-group.mjs';

// Security audit 4.18.26, final review: under umask 002 (user private groups, e.g. Ubuntu)
// CONTROL's own folders are group-writable. That is safe only when the group is the user's
// own and nobody else is in it.
const groups = 'ctl:x:1000:\nshared:x:1001:ctl,other\nemptyshared:x:1002:\n';
const passwd = 'ctl:x:1000:1000::/home/ctl:/bin/bash\nother:x:1003:1002::/home/other:/bin/sh\n';
const read = file => (file === '/etc/group' ? groups : passwd);

test('final review: group write is accepted only for the user\'s private group', () => {
  assert.equal(groupWriteIsPrivate(1000, { uid: 1000, readFile: read }), true, 'own private group, no other members');
  assert.equal(groupWriteIsPrivate(1001, { uid: 1000, readFile: read }), false, 'listed members');
  assert.equal(groupWriteIsPrivate(1002, { uid: 1000, readFile: read }), false, 'another user has it as primary group');
  assert.equal(groupWriteIsPrivate(4242, { uid: 1000, readFile: read }), false, 'unknown group');
  assert.equal(groupWriteIsPrivate(1000, { uid: 1000, readFile: () => { throw new Error('no file'); } }), false, 'unreadable: refuse');
});
