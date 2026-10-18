import crypto from 'node:crypto';
import { normalizeIp } from './instance-network.mjs';

// Official CoD4x master list as used by https://cod4master.cod4x.ovh/ itself
// (assets/js/cod4x.js loads "serverstatus.json"). The master servers do not answer
// the Q3 "getservers" UDP query; this JSON is the documented public view
// ("visit cod4master.cod4x.ovh and search your server name").
// Fixed URL, never user supplied.
export const MASTER_LIST_URL = 'https://cod4master.cod4x.ovh/serverstatus.json';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SERVERS = 10000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const stripColors = value => String(value ?? '').replace(/\^[0-9]/g, '').trim();

// "[2a01::1]:28960$alive [::ffff:5.161.236.49]:28960$dead"
export function parseMasterAddresses(value) {
  const result = [];
  for (const part of String(value || '').split(/\s+/).filter(Boolean).slice(0, 8)) {
    const match = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})\$([a-z]+)$/.exec(part);
    if (!match) continue;
    const port = Number(match[2]);
    if (port < 1 || port > 65535) continue;
    result.push({ ip: normalizeIp(match[1]), port, alive: match[3] === 'alive', state: match[3] });
  }
  return result;
}

export function parseMasterList(text) {
  let data;
  try { data = JSON.parse(text); } catch { fail('MASTER_LIST_INVALID'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.servers) || data.servers.length > MAX_SERVERS) fail('MASTER_LIST_INVALID');
  const servers = [];
  for (const entry of data.servers) {
    if (!entry || typeof entry !== 'object') continue;
    const addresses = parseMasterAddresses(entry.addr);
    if (!addresses.length) continue;
    servers.push({
      hostname: stripColors(entry.hn).slice(0, 128), map: String(entry.map ?? '').slice(0, 64),
      maxClients: Number.isInteger(entry.maxcl) ? entry.maxcl : null, tokenHash: /^[A-Fa-f0-9]{64}$/.test(entry.tokhash || '') ? entry.tokhash.toUpperCase() : null, addresses,
    });
  }
  return { masterTime: typeof data.time === 'string' ? data.time.slice(0, 64) : null, serverCount: servers.length, servers };
}

export async function fetchMasterList({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let response;
  try { response = await fetchImpl(MASTER_LIST_URL, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { fail('MASTER_LIST_UNREACHABLE'); }
  if (!response.ok) fail('MASTER_LIST_UNREACHABLE');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) fail('MASTER_LIST_INVALID');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) fail('MASTER_LIST_INVALID');
  return parseMasterList(text);
}

// Unverified hypothesis: tokhash may be SHA-256 of sv_authtoken (it is shared
// between servers of the same operator). Only ever a supporting indicator.
export const tokenHash = buffer => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();

// local: { port, hostname, mapname, maxClients } from the running core (getinfo).
// publicAddress: optional operator-supplied address the master should see.
export function matchMasterListing(list, { port, publicAddress = null, local = null, tokenHash: expectedTokenHash = null }) {
  const identity = entry => Boolean(local?.hostname) && entry.hostname === stripColors(local.hostname) && (local.maxClients == null || entry.maxClients === local.maxClients);
  const onPort = entry => entry.addresses.filter(address => address.port === port);
  let matches = [], matchedBy = null;
  if (publicAddress) {
    matches = list.servers.filter(entry => entry.addresses.some(address => address.port === port && address.ip === publicAddress));
    if (matches.length) matchedBy = 'ADDRESS';
  }
  if (!matches.length) {
    matches = list.servers.filter(entry => onPort(entry).length && identity(entry));
    if (matches.length) matchedBy = 'IDENTITY';
  }
  if (matches.length > 1) return { listed: null, code: 'MASTER_LIST_AMBIGUOUS', matchedBy, candidates: matches.length };
  if (!matches.length) {
    // Same identity on another port points at a port mismatch (NAT forward, wrong net_port).
    const otherPort = list.servers.find(entry => identity(entry) && !onPort(entry).length);
    return { listed: false, code: otherPort ? 'MASTER_LIST_PORT_MISMATCH' : 'MASTER_LIST_NOT_LISTED', matchedBy: null, listedPorts: otherPort ? [...new Set(otherPort.addresses.map(address => address.port))] : [] };
  }
  const [entry] = matches;
  const addresses = (publicAddress ? entry.addresses.filter(address => address.port === port && address.ip === publicAddress) : onPort(entry));
  const alive = addresses.some(address => address.alive);
  return {
    listed: true, matchedBy, code: alive ? 'MASTER_LIST_ALIVE' : 'MASTER_LIST_DEAD', alive,
    identityMatch: identity(entry), tokenHashMatch: expectedTokenHash && entry.tokenHash ? entry.tokenHash === expectedTokenHash : null,
    entry: { hostname: entry.hostname, map: entry.map, maxClients: entry.maxClients, addresses: addresses.map(({ ip, port: listedPort, state }) => ({ ip, port: listedPort, state })) },
  };
}
