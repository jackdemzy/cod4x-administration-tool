import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DOCKERFILE, DOCKERFILE_SHA256, IMAGE_TAG } from '../lib/docker-image.mjs';

test('the Dockerfile pins its base by digest and takes nothing from a build context', () => {
  const lines = DOCKERFILE.split('\n').filter(Boolean);
  assert.match(lines[0], /^FROM i386\/debian:bookworm-slim@sha256:[0-9a-f]{64}$/);
  assert.equal(lines.filter(line => line.startsWith('FROM ')).length, 1);
  for (const line of lines) assert.doesNotMatch(line, /^(ADD|COPY|ENTRYPOINT|CMD|ENV|ARG|VOLUME|EXPOSE)\b/i, line);
  assert.ok(lines.includes('USER 65534:65534'));
  assert.ok(DOCKERFILE.endsWith('\n'));
});

test('hash and tag follow from the text', () => {
  const hash = crypto.createHash('sha256').update(DOCKERFILE, 'utf8').digest('hex');
  assert.equal(DOCKERFILE_SHA256, hash);
  assert.equal(IMAGE_TAG, `cod4x-control-runtime:${hash.slice(0, 16)}`);
});
