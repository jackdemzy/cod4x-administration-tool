import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMasterAddresses, parseMasterList, matchMasterListing, fetchMasterList, tokenHash, MASTER_LIST_URL } from '../lib/master-list.mjs';
import { normalizeNetwork, networkChangeRequest, bindAddresses } from '../lib/instance-network.mjs';
import { validateConfigModel, parseConfigAssignments } from '../lib/config-engine.mjs';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

// Synthetic data in the format of https://cod4master.cod4x.ovh/serverstatus.json
// (documentation addresses only). No real master server is contacted here.
const token = 'Ver1fyToken0123456789abcdefABCDE';
const entry = (hn, addr, extra = {}) => ({ hn, map: 'mp_backlot', game: '', clc: 0, maxcl: 18, human: 0, pw: false, cc: 'DE', build: 1, type: 'war', tokhash: '', addr, ...extra });
const listJson = servers => JSON.stringify({ time: 'Sun Oct 18 10:00:00 2026', servercount: servers.length, servers });

test('master list parser reads the official serverstatus.json shape and alive/dead addresses', () => {
  assert.deepEqual(parseMasterAddresses('[2001:db8::7]:28960$alive [::ffff:203.0.113.7]:28960$dead'), [
    { ip: '2001:db8::7', port: 28960, alive: true, state: 'alive' }, { ip: '203.0.113.7', port: 28960, alive: false, state: 'dead' }]);
  assert.deepEqual(parseMasterAddresses('garbage 203.0.113.7:1 [x]:99999$alive'), []);
  const list = parseMasterList(listJson([entry('^1Gate ^7Server', '[::ffff:203.0.113.7]:28960$alive'), { hn: 'no address' }]));
  assert.equal(list.serverCount, 1);
  assert.equal(list.servers[0].hostname, 'Gate Server', 'color codes are stripped');
  assert.throws(() => parseMasterList('{"servers": 5}'), { code: 'MASTER_LIST_INVALID' });
  assert.throws(() => parseMasterList('<html>'), { code: 'MASTER_LIST_INVALID' });
});

test('listing match: address, identity, dead heartbeat, missing, port mismatch, ambiguity and token hash', () => {
  const local = { hostname: '^2Gate Server', mapname: 'mp_backlot', maxClients: 18 };
  const hash = tokenHash(Buffer.from(token));
  const list = parseMasterList(listJson([
    entry('Gate Server', '[::ffff:203.0.113.7]:28960$alive', { tokhash: hash }),
    entry('Other', '[::ffff:198.51.100.9]:28960$alive'),
  ]));
  const byAddress = matchMasterListing(list, { port: 28960, publicAddress: '203.0.113.7', local, tokenHash: hash });
  assert.deepEqual([byAddress.listed, byAddress.matchedBy, byAddress.code, byAddress.alive, byAddress.identityMatch, byAddress.tokenHashMatch], [true, 'ADDRESS', 'MASTER_LIST_ALIVE', true, true, true]);
  const byIdentity = matchMasterListing(list, { port: 28960, local });
  assert.deepEqual([byIdentity.listed, byIdentity.matchedBy, byIdentity.tokenHashMatch], [true, 'IDENTITY', null]);
  const dead = matchMasterListing(parseMasterList(listJson([entry('Gate Server', '[::ffff:203.0.113.7]:28960$dead')])), { port: 28960, local });
  assert.deepEqual([dead.listed, dead.code, dead.alive], [true, 'MASTER_LIST_DEAD', false]);
  assert.deepEqual(matchMasterListing(list, { port: 28961, local: { hostname: 'Nobody' } }).code, 'MASTER_LIST_NOT_LISTED');
  const mismatch = matchMasterListing(list, { port: 28970, local });
  assert.deepEqual([mismatch.listed, mismatch.code, mismatch.listedPorts], [false, 'MASTER_LIST_PORT_MISMATCH', [28960]]);
  const twins = parseMasterList(listJson([entry('Gate Server', '[::ffff:203.0.113.7]:28960$alive'), entry('Gate Server', '[::ffff:203.0.113.8]:28960$alive')]));
  assert.equal(matchMasterListing(twins, { port: 28960, local }).code, 'MASTER_LIST_AMBIGUOUS');
  // A configured address resolves the ambiguity.
  assert.equal(matchMasterListing(twins, { port: 28960, publicAddress: '203.0.113.8', local }).entry.addresses[0].ip, '203.0.113.8');
  // A foreign server on our port with a different identity is never "our" listing.
  assert.equal(matchMasterListing(list, { port: 28960, local: { hostname: 'Mine', maxClients: 18 } }).listed, false);
});

test('master list fetch uses only the fixed URL and maps failures to fixed codes', async () => {
  let requested;
  const ok = await fetchMasterList({ fetchImpl: async url => { requested = url; return new Response(listJson([entry('A', '[::ffff:203.0.113.7]:28960$alive')])); } });
  assert.equal(requested, MASTER_LIST_URL);
  assert.equal(ok.serverCount, 1);
  await assert.rejects(fetchMasterList({ fetchImpl: async () => { throw new TypeError('network down'); } }), { code: 'MASTER_LIST_UNREACHABLE' });
  await assert.rejects(fetchMasterList({ fetchImpl: async () => new Response('busy', { status: 503 }) }), { code: 'MASTER_LIST_UNREACHABLE' });
  await assert.rejects(fetchMasterList({ fetchImpl: async () => new Response('not json') }), { code: 'MASTER_LIST_INVALID' });
  await assert.rejects(fetchMasterList({ fetchImpl: async () => new Response('x', { headers: { 'content-length': String(64 * 1024 * 1024) } }) }), { code: 'MASTER_LIST_INVALID' });
});

test('network exposure defaults to loopback; public needs confirmation and a sane optional address', () => {
  assert.deepEqual(normalizeNetwork(undefined), { scope: 'LOOPBACK', publicAddress: null });
  assert.deepEqual(bindAddresses(undefined), { ipv4: '127.0.0.1', ipv6: '::1' });
  assert.deepEqual(bindAddresses({ scope: 'PUBLIC' }), { ipv4: '0.0.0.0', ipv6: '::' });
  assert.throws(() => networkChangeRequest({ scope: 'PUBLIC' }), { code: 'INSTANCE_NETWORK_CONFIRMATION_REQUIRED' });
  assert.deepEqual(networkChangeRequest({ scope: 'PUBLIC', publicAddress: '[::ffff:203.0.113.7]', confirm: 'PUBLIC_EXPOSURE' }), { scope: 'PUBLIC', publicAddress: '203.0.113.7' });
  for (const bad of [{ scope: 'OPEN' }, { scope: 'PUBLIC', publicAddress: '127.0.0.1', confirm: 'PUBLIC_EXPOSURE' }, { scope: 'PUBLIC', publicAddress: 'example.org', confirm: 'PUBLIC_EXPOSURE' }, { scope: 'LOOPBACK', extra: 1 }]) {
    assert.throws(() => networkChangeRequest(bad), { code: 'INSTANCE_NETWORK_INVALID' });
  }
  // server.cfg may only repeat the instance binding, never widen it.
  const cfg = value => parseConfigAssignments(`set net_ip "${value}"`);
  assert.throws(() => validateConfigModel(cfg('0.0.0.0'), { port: 28960 }), { code: 'CONFIG_SCHEMA_INVALID' });
  assert.equal(validateConfigModel(cfg('0.0.0.0'), { port: 28960, network: { scope: 'PUBLIC' } }).valid, true);
  assert.throws(() => validateConfigModel(cfg('127.0.0.1'), { port: 28960, network: { scope: 'PUBLIC' } }), { code: 'CONFIG_SCHEMA_INVALID' });
});

async function fixture(t, servers = () => []) {
  const calls = [];
  const value = await createRconFixture({ masterOptions: { fetchList: async () => { calls.push(Date.now()); const result = servers(); if (result instanceof Error) throw result; return parseMasterList(listJson(result)); } } });
  t.after(value.cleanup);
  return { ...value, calls };
}

test('public binding is explicit per instance, persisted, not cloned and blocked while running', async t => {
  const { manager, children, create, store } = await fixture(t);
  const created = await create('net-a');
  assert.equal(created.network.scope, 'LOOPBACK');
  await assert.rejects(manager.changeNetwork('net-a', { scope: 'PUBLIC' }), { code: 'INSTANCE_NETWORK_CONFIRMATION_REQUIRED' });
  const changed = await manager.changeNetwork('net-a', { scope: 'PUBLIC', confirm: 'PUBLIC_EXPOSURE' });
  assert.deepEqual([changed.previous.scope, changed.network.scope], ['LOOPBACK', 'PUBLIC']);
  const registry = JSON.parse(await fs.readFile(store.registryFile, 'utf8'));
  assert.equal(registry.instances.find(value => value.id === 'net-a').network.scope, 'PUBLIC');
  const clone = await manager.clone('net-a', { id: 'net-b', port: created.port + 1 });
  assert.equal(clone.network.scope, 'LOOPBACK', 'public exposure is never inherited by a clone');
  const state = await manager.launch('net-a');
  const args = children.get(state.pid).args;
  assert.equal(args[args.indexOf('net_ip') + 1], '0.0.0.0');
  assert.equal(args[args.indexOf('net_ip6') + 1], '::');
  await assert.rejects(manager.changeNetwork('net-a', { scope: 'LOOPBACK' }), { code: 'INSTANCE_RUNTIME_BUSY' });
  await manager.stop('net-a');
  // A config pinning the old binding would silently override the launch argument.
  const instance = store.get('net-a');
  await fs.appendFile(instance.configPath, 'set net_ip "0.0.0.0"\n');
  await assert.rejects(manager.changeNetwork('net-a', { scope: 'LOOPBACK' }), { code: 'INSTANCE_NETWORK_CONFIG_PINNED' });
  assert.equal(store.get('net-a').network.scope, 'PUBLIC');
});

test('verification distinguishes token set from actually listed, tracks heartbeat and last seen', async t => {
  let servers = [];
  const { manager, create, setMaster, masterService, auditEvents, calls, runtimeEvents } = await fixture(t, () => servers);
  const instance = await create('list-a');
  await setMaster('list-a', token);
  // Loopback: no outbound request at all, honest reason.
  await manager.launch('list-a');
  const loop = await masterService.verify('list-a', 'tester');
  assert.deepEqual([loop.state, loop.list.code, calls.length], ['TOKEN_CONFIGURED', 'LOOPBACK_BINDING', 0]);
  await manager.stop('list-a');
  assert.equal((await masterService.verify('list-a')).list, null, 'stopped server has no current-run listing');
  await manager.changeNetwork('list-a', { scope: 'PUBLIC', confirm: 'PUBLIC_EXPOSURE' });
  await manager.launch('list-a');
  // Token transferred, but not on the list yet (NAT/firewall/pending heartbeat).
  const pending = await masterService.verify('list-a', 'tester');
  assert.deepEqual([pending.state, pending.reason, pending.summary.listed, pending.verified], ['REGISTERING', 'MASTER_LIST_NOT_LISTED', false, false]);
  // Listed by server identity (getinfo of the running core) with alive heartbeat.
  servers = [entry(`^3RCON list-a`, `[::ffff:203.0.113.7]:${instance.port}$alive`), entry('Other', `[::ffff:198.51.100.9]:${instance.port}$alive`)];
  const alive = await masterService.verify('list-a', 'tester');
  assert.deepEqual([alive.state, alive.reason, alive.list.matchedBy, alive.verified], ['HEARTBEAT_OK', 'MASTER_LIST_ALIVE', 'IDENTITY', true]);
  assert.deepEqual([alive.summary.registration, alive.summary.heartbeat, alive.summary.listed], [true, true, true]);
  assert.ok(alive.summary.lastSeenAt);
  const seen = alive.summary.lastSeenAt;
  servers = [entry('RCON list-a', `[::ffff:203.0.113.7]:${instance.port}$dead`)];
  const dead = await masterService.verify('list-a');
  assert.deepEqual([dead.state, dead.reason, dead.summary.heartbeat, dead.summary.lastSeenAt], ['HEARTBEAT_LOST', 'MASTER_LIST_DEAD', false, seen]);
  servers = [];
  assert.deepEqual([(await masterService.verify('list-a')).state, (await masterService.status('list-a')).reason], ['HEARTBEAT_LOST', 'MASTER_LIST_MISSING']);
  servers = new Error('down');
  const unreachable = await masterService.verify('list-a');
  assert.deepEqual([unreachable.list.listed, unreachable.list.code], [null, 'MASTER_LIST_UNREACHABLE']);
  // The local server is never affected by any listing result.
  assert.equal((await manager.status('list-a')).runtime.status, 'RUNNING');
  assert.ok(auditEvents.some(entry => entry.event === 'master.heartbeat.detected'));
  assert.ok(auditEvents.some(entry => entry.event === 'master.heartbeat.lost'));
  assert.ok(auditEvents.filter(entry => entry.event === 'master.list.verified').length >= 6);
  for (const value of [auditEvents, runtimeEvents, alive, dead]) assert.ok(!JSON.stringify(value).includes(token));
  // A new run never inherits listing evidence.
  await manager.launch('list-a', true);
  assert.equal((await masterService.status('list-a')).list, null);
});

test('master list route requires an explicit POST and the network route needs confirmation', async () => {
  const server = await fs.readFile(path.join(import.meta.dirname, '..', 'installer-server.mjs'), 'utf8');
  assert.match(server, /app\.post\("\/api\/instances\/:id\/master\/verify", requirePermission\("server\.manage"\)/);
  assert.match(server, /app\.post\("\/api\/instances\/:id\/network", requirePermission\("server\.manage"\)/);
  assert.match(server, /"network\.exposure\.changed"/);
});
