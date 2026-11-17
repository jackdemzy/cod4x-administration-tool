import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backend, password } from './support/security-backend.mjs';

// The Runtime page polls /api/runtime/preflight every 2.5 s. Without an installed core the route answered
// HTTP 400, so the browser console showed an error on every poll (left open in the 4.18.31 debug phase).
// A missing core is now a regular answer; bad input still fails.
test('preflight without an installed core answers 200 with the missing core as state', async t => {
  const api = await backend(t);
  const { json } = await api.call('/api/auth/init', { body: { username: 'coreAdmin', password: password() } });
  const token = json.token;

  const stored = await api.call('/api/runtime/preflight', { token });
  assert.equal(stored.status, 200, stored.json.error);
  assert.equal(stored.json.ok, false);
  assert.equal(stored.json.coreInstalled, false);
  assert.equal(stored.json.executablePath, null);
  assert.equal(stored.json.core.verified, false);
  assert.equal(stored.json.core.corePresent, false);
  assert.ok(stored.json.core.reasons.length > 0, 'the reason reaches the page');
  assert.equal(typeof stored.json.baseGame.valid, 'boolean', 'the BaseGame check is still reported');

  const chosen = await api.call(`/api/runtime/preflight?platform=linux&executablePath=${encodeURIComponent('/nonexistent-cod4x/cod4x18_dedrun')}`, { token });
  assert.equal(chosen.status, 200, chosen.json.error);
  assert.equal(chosen.json.coreInstalled, false);
  assert.match(chosen.json.core.reasons[0], /cod4x18_dedrun was not found/);
  assert.equal(chosen.json.core.executable, 'cod4x18_dedrun');

  const wrongName = await api.call(`/api/runtime/preflight?platform=linux&executablePath=${encodeURIComponent('/tmp/other-binary')}`, { token });
  assert.equal(wrongName.status, 200);
  assert.match(wrongName.json.core.reasons[0], /must be cod4x18_dedrun/);

  const badPlatform = await api.call('/api/runtime/preflight?platform=amiga', { token });
  assert.equal(badPlatform.status, 400, 'an unsupported platform is still a bad request');
  assert.match(badPlatform.json.error, /Unsupported server platform/);
});

test('the Runtime page shows the reason the backend gives for a missing core', () => {
  const ui = readFileSync(new URL('../cod4x-control-improved.jsx', import.meta.url), 'utf8');
  assert.match(ui, /\(preflight\.core\?\.reasons \|\| \[\]\)\.join\(" · "\)/);
});
