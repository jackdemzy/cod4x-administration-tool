import net from 'node:net';

// Per-instance network exposure. LOOPBACK is the default for every new, cloned
// or legacy instance; PUBLIC must be set explicitly per instance and confirmed.
// CoD4x defaults (sys_net.c): net_ip "0.0.0.0", net_ip6 "::".
export const NETWORK_SCOPES = Object.freeze(['LOOPBACK', 'PUBLIC']);
export const PUBLIC_EXPOSURE_CONFIRMATION = 'PUBLIC_EXPOSURE';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function normalizeIp(value) {
  const text = String(value).trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  return mapped ? mapped[1] : text.toLowerCase();
}

// Optional expected public address (as the master sees it) for address-based
// listing verification. Loopback, unspecified and link-local values are rejected.
function validPublicAddress(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) fail('INSTANCE_NETWORK_INVALID');
  const ip = normalizeIp(value);
  const family = net.isIP(ip);
  if (!family) fail('INSTANCE_NETWORK_INVALID');
  if (family === 4 && (/^(127|0)\./.test(ip) || /^169\.254\./.test(ip) || ip === '255.255.255.255')) fail('INSTANCE_NETWORK_INVALID');
  if (family === 6 && (ip === '::' || ip === '::1' || /^fe[89ab]/.test(ip))) fail('INSTANCE_NETWORK_INVALID');
  return ip;
}

export function normalizeNetwork(input) {
  if (input === undefined || input === null) return { scope: 'LOOPBACK', publicAddress: null };
  if (typeof input !== 'object' || Array.isArray(input) || !NETWORK_SCOPES.includes(input.scope)) fail('INSTANCE_NETWORK_INVALID');
  return { scope: input.scope, publicAddress: input.scope === 'PUBLIC' ? validPublicAddress(input.publicAddress) : null };
}

// Explicit change request from the API: PUBLIC needs the confirmation phrase.
export function networkChangeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['scope', 'publicAddress', 'confirm'].includes(key))) fail('INSTANCE_NETWORK_INVALID');
  const network = normalizeNetwork({ scope: body.scope, publicAddress: body.publicAddress });
  if (network.scope === 'PUBLIC' && body.confirm !== PUBLIC_EXPOSURE_CONFIRMATION) fail('INSTANCE_NETWORK_CONFIRMATION_REQUIRED');
  return network;
}

export function bindAddresses(network) {
  return normalizeNetwork(network).scope === 'PUBLIC' ? { ipv4: '0.0.0.0', ipv6: '::' } : { ipv4: '127.0.0.1', ipv6: '::1' };
}

export { normalizeIp };
