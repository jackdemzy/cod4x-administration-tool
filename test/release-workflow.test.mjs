import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Block 23 (4.18.30): the Release workflow builds through the pipeline, runs the installer gate
// and only drafts (never publishes) a release, with write rights only in that job.
const text = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('triggers: manual, version tags and packaging pull requests', () => {
  assert.match(text, /\n  workflow_dispatch:/);
  assert.match(text, /tags: \['v\*'\]/);
  assert.match(text, /pull_request:\n    paths:/);
});

test('both platforms build through the release pipeline and the installer gate', () => {
  assert.match(text, /os: windows-latest\n\s+platform: win/);
  assert.match(text, /os: ubuntu-latest\n\s+platform: linux/);
  assert.match(text, /run: npm run release:\$\{\{ matrix\.platform \}\}/);
  assert.match(text, /COD4X_RELEASE_DIR: \$\{\{ github\.workspace \}\}\/dist-installer\n\s+run: node scripts\/verify-4\.18\.30-installer-gate\.mjs/);
  assert.match(text, /dist-installer\/SHA256SUMS/);
  assert.match(text, /if-no-files-found: error/);
});

test('rights: read by default, write only for the draft release on a tag', () => {
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.equal(text.match(/contents: write/g).length, 1);
  const draft = text.slice(text.indexOf('\n  draft-release:'));
  assert.match(draft, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/);
  assert.match(draft, /contents: write/);
  assert.match(draft, /gh release create .*--draft/);
  assert.doesNotMatch(text, /--publish always|--publish onTag|\bgh release edit\b/);
});

test('no untrusted event text is interpolated into a shell command', () => {
  assert.doesNotMatch(text, /\$\{\{\s*github\.(event|head_ref)/);
});
