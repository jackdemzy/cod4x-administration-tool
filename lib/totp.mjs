import crypto from 'node:crypto';

// Block 24b: time-based one-time passwords (RFC 6238 on top of RFC 4226 HOTP)
// with node:crypto only. Defaults match every common authenticator app:
// SHA-1, 6 digits, 30 s steps. A code is accepted for the current step and one
// step either side (clock drift); a step that was already used is refused, so a
// code seen over someone's shoulder cannot be replayed.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) fail('TOTP_SECRET_INVALID');
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

// 20 random bytes = 160 bits, the key length RFC 4226 recommends for SHA-1.
export function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

export function hotp(key, counter, digits = TOTP_DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

export const totpStep = (nowMs, step = TOTP_STEP_SECONDS) => Math.floor(nowMs / 1000 / step);

export function totp(secret, nowMs = Date.now(), { digits = TOTP_DIGITS, key = base32Decode(secret) } = {}) {
  return hotp(key, totpStep(nowMs), digits);
}

// Returns the matched step (store it as lastStep) or null.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = null } = {}) {
  const value = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(value)) return null;
  const key = base32Decode(secret);
  const current = totpStep(now);
  const expected = Buffer.from(value);
  let matched = null;
  // Every candidate is compared so the timing does not reveal which one matched.
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    const candidate = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(candidate, expected) && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

export function totpUri({ secret, account, issuer = 'COD4X CONTROL' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// Recovery codes: 10 × 10 base32 characters (50 bits each), shown once, kept
// only as scrypt hashes; each one works once.
const RECOVERY_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const normalizeRecovery = code => String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
export function generateRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () => base32Encode(crypto.randomBytes(7)).slice(0, 10));
  return codes.map(code => `${code.slice(0, 5)}-${code.slice(5)}`);
}
export function hashRecoveryCode(code) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(normalizeRecovery(code), salt, 32, RECOVERY_SCRYPT).toString('hex') };
}
// Returns the index of the matching unused code or -1.
export function matchRecoveryCode(code, hashes = []) {
  const value = normalizeRecovery(code);
  if (!/^[A-Z2-7]{10}$/.test(value)) return -1;
  let found = -1;
  hashes.forEach((entry, index) => {
    if (!entry || typeof entry.salt !== 'string' || typeof entry.hash !== 'string') return;
    const derived = crypto.scryptSync(value, Buffer.from(entry.salt, 'hex'), 32, RECOVERY_SCRYPT);
    const expected = Buffer.from(entry.hash, 'hex');
    if (expected.length === derived.length && crypto.timingSafeEqual(derived, expected) && found < 0) found = index;
  });
  return found;
}
