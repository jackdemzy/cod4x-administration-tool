import test from 'node:test';
import assert from 'node:assert/strict';
import { isCredentialPath } from '../lib/credential-request.mjs';

// Security audit 4.18.26 (A3-8, A5-6): every route that carries a secret is local-only,
// sends Cache-Control: no-store and answers a broken body with a fixed error.
test('credential guard covers every route that carries a secret', () => {
  for (const covered of [
    '/api/credentials/vault/unlock',
    '/api/instances/srv-01/credentials',
    '/api/instances/srv-01/credentials/rcon',
    '/api/remote-hosts/h1/credentials/ssh',
    '/api/remote-instances/r1/credentials',
    '/api/remote-instances/r1/credentials/rcon/remove',
    '/api/instances/srv-01/b3/integration/auth-password',
    '/api/instances/srv-01/b3/integration/auth-password/',
  ]) assert.equal(isCredentialPath(covered), true, covered);
  for (const free of [
    '/api/instances/srv-01',
    '/api/instances/srv-01/b3/integration',
    '/api/remote-instances/r1/config',
    '/api/remote-instances/r1/credentialsx',
    '/api/instances/srv-01/b3/integration/auth-passwords',
  ]) assert.equal(isCredentialPath(free), false, free);
});
