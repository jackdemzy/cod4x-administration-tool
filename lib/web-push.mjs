import crypto from 'node:crypto';

// Block 24c: Web Push without an extra package. Message encryption follows
// RFC 8291 (aes128gcm content coding of RFC 8188, one record), the sender is
// identified with VAPID (RFC 8292, ES256 JWT). Push services are restricted to
// the ones the big browsers use, so a remote user cannot make the tool send
// requests to arbitrary hosts.
export const PUSH_RECORD_SIZE = 4096;
export const PUSH_TIMEOUT_MS = 5_000;
export const PUSH_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
export const PUSH_HOST_SUFFIXES = Object.freeze(['.notify.windows.com', '.push.apple.com']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const b64u = buffer => Buffer.from(buffer).toString('base64url');
const fromB64u = text => Buffer.from(String(text || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// A subscription as the browser hands it out (PushSubscription.toJSON()).
export function validatePushSubscription(input) {
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
  let url;
  try { url = new URL(endpoint); } catch { fail('PUSH_ENDPOINT_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || endpoint.length > 1024) fail('PUSH_ENDPOINT_INVALID');
  if (!PUSH_HOSTS.includes(host) && !PUSH_HOST_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length)) fail('PUSH_SERVICE_NOT_ALLOWED');
  const p256dh = fromB64u(input?.keys?.p256dh), auth = fromB64u(input?.keys?.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) fail('PUSH_KEYS_INVALID');
  // The point must lie on the curve; ECDH refuses it otherwise.
  const probe = crypto.createECDH('prime256v1'); probe.generateKeys();
  try { probe.computeSecret(p256dh); } catch { fail('PUSH_KEYS_INVALID'); }
  return { endpoint: url.href, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
}

// RFC 8291 section 3.4 / RFC 8188 section 2. `sender` and `salt` are only
// passed by tests (RFC 8291 Appendix A); normally both are fresh per message.
export function encryptPushPayload(subscription, payload, { sender = null, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = fromB64u(subscription.keys.p256dh), authSecret = fromB64u(subscription.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (sender) ecdh.setPrivateKey(fromB64u(sender)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  // One record: plaintext plus the last-record delimiter 0x02, no padding.
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plaintext.length + 16 + 86 > PUSH_RECORD_SIZE) fail('PUSH_PAYLOAD_TOO_LARGE');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(PUSH_RECORD_SIZE, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ciphertext]);
}

// The user agent side of RFC 8291, used by the tests to read a message back.
export function decryptPushPayload(body, { privateKey, auth }) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(fromB64u(privateKey));
  const uaPublic = ecdh.getPublicKey();
  const prkKey = hmac(fromB64u(auth), ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) fail('PUSH_PADDING_INVALID');
  return plain.subarray(0, end).toString('utf8');
}

// VAPID key pair of this installation: P-256, raw keys as base64url.
export function createVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
export function validateVapidKeys(keys) {
  const ecdh = crypto.createECDH('prime256v1');
  try { ecdh.setPrivateKey(fromB64u(keys?.privateKey)); } catch { fail('VAPID_KEYS_INVALID'); }
  if (b64u(ecdh.getPublicKey()) !== keys.publicKey) fail('VAPID_KEYS_INVALID');
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}
function vapidKeyObject({ publicKey, privateKey }) {
  const point = fromB64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) }, format: 'jwk' });
}
// RFC 8292 section 2: aud is the origin of the push service, exp at most 24 h.
export function vapidAuthorization(endpoint, keys, { subject, now = Date.now(), ttlSeconds = 12 * 3600 } = {}) {
  if (!/^(mailto:|https:\/\/)/.test(String(subject || ''))) fail('VAPID_SUBJECT_INVALID');
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600), sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

// Sends one message. Gone subscriptions (404/410) are reported so the caller
// can drop them. No redirects, fixed timeout.
export async function sendPush(subscription, payload, { keys, subject, fetchImpl = fetch, timeoutMs = PUSH_TIMEOUT_MS, ttlSeconds = 3600, urgency = 'high', now = Date.now() } = {}) {
  const target = validatePushSubscription(subscription);
  const body = encryptPushPayload(target, typeof payload === 'string' ? payload : JSON.stringify(payload));
  let response;
  try {
    response = await fetchImpl(target.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), body,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(ttlSeconds), Urgency: urgency, Authorization: vapidAuthorization(target.endpoint, keys, { subject, now }) } });
  } catch (error) { return { ok: false, gone: false, status: null, code: error.name === 'TimeoutError' ? 'PUSH_TIMEOUT' : 'PUSH_NETWORK' }; }
  await response.arrayBuffer().catch(() => null);
  if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
  return { ok: false, gone: response.status === 404 || response.status === 410, status: response.status, code: `PUSH_HTTP_${response.status}` };
}
