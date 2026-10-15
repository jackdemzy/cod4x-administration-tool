import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../cod4x-control-improved.jsx', import.meta.url), 'utf8');

// Supplementary source checks: native behavior is covered by separate gates.
test('both Core-search labels refer to dedicated cores, never the client', () => {
  assert.doesNotMatch(source, /Auto-search for iw3mp\.exe/);
  assert.match(source, /Search for dedicated server cores/);
});

test('home help distinguishes instance data from Core working directory', () => {
  assert.doesNotMatch(source, /Arbeitsverzeichnis des Servers;|Server working directory;/);
  assert.match(source, /Instance data directory \(fs_homepath\); the OS working directory is the Core directory/);
});

test('instance note scopes local starts without stale or global gate claims', () => {
  assert.doesNotMatch(source, /Noch kein bestätigtes natives Zwei-Server-Gate|Native two-server gate is not yet confirmed/);
  assert.match(source, /Local starts bind to 127\.0\.0\.1; passing isolated tests does not constitute a full release approval/);
});
