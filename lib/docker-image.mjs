import crypto from 'node:crypto';

// Block 19: the one image CONTROL builds on a server. It holds only the 32-bit runtime libraries
// the core is linked against; the core and the game files are mounted, never copied in.
// The base is pinned by digest (index digest of i386/debian:bookworm-slim on Docker Hub, pulled
// 2026-11-09). The package installed by RUN is not pinned to a version.
// No ADD/COPY: the image is built without a build context (see imageBuildCommand).
export const DOCKERFILE = [
  'FROM i386/debian:bookworm-slim@sha256:abd54731664e83f582c92db7581fb65a7bb81498c8b7001101844301bf6efe36',
  'RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*',
  'USER 65534:65534',
  'WORKDIR /cod4/base',
  '',
].join('\n');

export const DOCKERFILE_SHA256 = crypto.createHash('sha256').update(DOCKERFILE, 'utf8').digest('hex');
// A changed Dockerfile gives a new tag; an old image is never overwritten.
export const IMAGE_TAG = `cod4x-control-runtime:${DOCKERFILE_SHA256.slice(0, 16)}`;
