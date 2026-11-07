import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  shellQuote, assertRemotePosixPath, validHostId, validRemoteInstanceId, validRemoteUser, validHostName,
} from '../lib/remote-safety.mjs';

const code = fn => { try { fn(); return null; } catch (error) { return error.code || 'THROWN'; } };
const linux = process.platform === 'linux';

test('shellQuote: hostile values come back unchanged through a real shell', { skip: !linux }, () => {
  for (const value of ['a b', "a'b", '$(id)', '`id`', 'a;b', 'a\nb', '-rf', '', '*', 'ä ö ü', '"quoted"', '\\n']) {
    const quoted = shellQuote(value);
    assert.equal(execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }), value, JSON.stringify(value));
  }
});

test('shellQuote: refuses NUL and non-strings', () => {
  assert.equal(code(() => shellQuote('a\u0000b')), 'REMOTE_ARGUMENT_INVALID');
  for (const value of [undefined, null, 5, {}, ['a']]) assert.equal(code(() => shellQuote(value)), 'REMOTE_ARGUMENT_INVALID');
});

test('assertRemotePosixPath: refuses traversal, relative, double slash and control characters', () => {
  for (const bad of ['/srv/../etc', 'srv/x', '/a//b', '/a\u0000', '/a\nb', '/a\tb', '/a/./b', '', '/', '/a/..', '/' + 'x'.repeat(1030)]) {
    assert.equal(code(() => assertRemotePosixPath(bad)), 'REMOTE_PATH_INVALID', JSON.stringify(bad.slice(0, 20)));
  }
  assert.equal(code(() => assertRemotePosixPath(5)), 'REMOTE_PATH_INVALID');
});

test('assertRemotePosixPath: accepts a clean path and keeps it unchanged; trailing slash is removed', () => {
  assert.equal(assertRemotePosixPath('/srv/cod4x/a'), '/srv/cod4x/a');
  assert.equal(assertRemotePosixPath('/srv/cod4x/'), '/srv/cod4x');
  assert.equal(assertRemotePosixPath('/srv/my server/ä'), '/srv/my server/ä');
});

test('assertRemotePosixPath: under limits the path to a root and does not match a sibling prefix', () => {
  assert.equal(assertRemotePosixPath('/srv/cod4x/a', { under: '/srv/cod4x' }), '/srv/cod4x/a');
  assert.equal(code(() => assertRemotePosixPath('/srv/cod4x2/a', { under: '/srv/cod4x' })), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => assertRemotePosixPath('/srv/cod4x', { under: '/srv/cod4x' })), 'REMOTE_PATH_INVALID', 'the root itself is not inside it');
  assert.equal(code(() => assertRemotePosixPath('/etc/passwd', { under: '/srv/cod4x' })), 'REMOTE_PATH_INVALID');
});

test('id, user and host name validators', () => {
  assert.ok(validHostId('lab-1') && validRemoteInstanceId('public-01'));
  for (const bad of ['', '1a', 'A', 'a b', 'a'.repeat(41), 'a;b']) assert.ok(!validHostId(bad), bad);
  for (const bad of ['', 'a'.repeat(49), 'a/b', '..']) assert.ok(!validRemoteInstanceId(bad), bad);
  assert.ok(validRemoteUser('cod4x') && validRemoteUser('_svc-1'));
  for (const bad of ['root', 'Root', '', '1x', 'a b', 'a;b', 'x'.repeat(33), '-x']) assert.ok(!validRemoteUser(bad), bad);
  for (const good of ['example.org', 'lab-1.local', '192.0.2.10', '2001:db8::1', 'localhost']) assert.ok(validHostName(good), good);
  for (const bad of ['', 'a b', '-oProxyCommand=x', 'a;b', 'a$(id)', 'exa mple.org', '.', 'x'.repeat(254), '1.2.3.999']) assert.ok(!validHostName(bad), bad);
});
