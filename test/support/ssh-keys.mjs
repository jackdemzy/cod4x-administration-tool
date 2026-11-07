import ssh2 from 'ssh2';

// ssh2's generateKeyPairSync('ed25519') yields a key its own parser rejects about 3 times in 1000
// ("Malformed OpenSSH private key"). Test keys are therefore checked and regenerated until they parse.
export function generateTestKeyPair() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error) && !(ssh2.utils.parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error('could not generate a parsable test key');
}
