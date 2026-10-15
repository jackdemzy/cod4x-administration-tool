import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const MAX_BYTES = 65536;
const KDF = 'scrypt-N131072-r8-p1';
const OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const AAD = Buffer.from('COD4X CONTROL credential vault v1:' + KDF);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function passwordBytes(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024 ||
      Buffer.byteLength(passphrase) > 4096 || /[\u0000-\u001f\u007f]/u.test(passphrase) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(passphrase)) {
    fail('VAULT_PASSPHRASE_INVALID');
  }
  return Buffer.from(passphrase, 'utf8');
}

function decode(value, size, maximum = size) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('VAULT_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < size || bytes.length > maximum || bytes.toString('base64') !== value) fail('VAULT_INVALID');
  return bytes;
}

function encrypt(plaintext, key, salt) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_BYTES) fail('VAULT_INVALID');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: 1, kdf: KDF, salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

// Fixed KDF limits; no passphrase retention or persistence. JS strings cannot
// be reliably wiped, so callers must not log or retain submitted secrets.
export async function sealVault(plaintext, passphrase) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_BYTES) fail('VAULT_INVALID');
  const password = passwordBytes(passphrase);
  const salt = randomBytes(32);
  let key;
  try {
    key = await derive(password, salt, 32, OPTIONS);
    return encrypt(plaintext, key, salt);
  } finally {
    password.fill(0);
    key?.fill(0);
  }
}

function parts(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== 1 ||
      envelope.kdf !== KDF || Object.keys(envelope).sort().join(',') !== 'ciphertext,kdf,nonce,salt,tag,version') fail('VAULT_INVALID');
  const salt = decode(envelope.salt, 32);
  const nonce = decode(envelope.nonce, 12);
  const tag = decode(envelope.tag, 16);
  const ciphertext = decode(envelope.ciphertext, 1, MAX_BYTES);
  return { salt, nonce, tag, ciphertext };
}

function decrypt(envelope, key, expectedSalt) {
  const { salt, nonce, tag, ciphertext } = parts(envelope);
  if (!salt.equals(expectedSalt)) fail('VAULT_INVALID');
  let unverified;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    unverified = decipher.update(ciphertext);
    // Never release plaintext until authentication has succeeded.
    const final = decipher.final();
    return Buffer.concat([unverified, final]);
  } catch {
    fail('VAULT_UNLOCK_FAILED');
  } finally {
    unverified?.fill(0);
  }
}

// The unlocked session retains only a derived key inside a closure. Lock must
// call destroy(); no key is serializable or exposed to consumers.
export async function openVaultSession(envelope, passphrase) {
  const { salt } = parts(envelope);
  const password = passwordBytes(passphrase);
  passphrase = null; // Do not leave a passphrase reference in the session scope.
  let key;
  try {
    key = await derive(password, salt, 32, OPTIONS);
    const verified = decrypt(envelope, key, salt);
    verified.fill(0);
    const requireKey = () => { if (!key) fail('VAULT_LOCKED'); return key; };
    return Object.freeze({
      seal: plaintext => encrypt(plaintext, requireKey(), salt),
      open: candidate => decrypt(candidate, requireKey(), salt),
      destroy: () => { key?.fill(0); key = null; }
    });
  } catch (error) {
    key?.fill(0);
    throw error;
  } finally { password.fill(0); }
}

export async function openVault(envelope, passphrase) {
  const session = await openVaultSession(envelope, passphrase);
  try { return session.open(envelope); }
  finally { session.destroy(); }
}
