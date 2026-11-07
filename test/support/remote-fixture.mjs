import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteHostStore } from '../../lib/remote-host-store.mjs';
import { RemoteInstanceStore } from '../../lib/remote-instance-store.mjs';
import { RemoteStateStore } from '../../lib/remote-runtime-state.mjs';
import { RemoteInstanceManager } from '../../lib/remote-instance-manager.mjs';
import { createLoopbackServer, buildFakeCore } from './loopback-transport.mjs';

// A whole "remote" setup on this machine: the loopback server with a base game, the control PC side
// with a compiled fake core, the real host/instance/state stores and the real manager.
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function createRemoteFixture(t, { ignoreTerm = false, timing = {}, backups = true } = {}) {
  const loopback = await createLoopbackServer();
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-fixture-'));
  t.after(async () => { await loopback.cleanup(); await fs.rm(local, { recursive: true, force: true }); });
  await fs.mkdir(loopback.path('game', 'main'), { recursive: true }); await fs.mkdir(loopback.path('game', 'zone'), { recursive: true });
  await fs.writeFile(loopback.path('game', 'main', 'pak0.iwd'), 'iwd'); await fs.writeFile(loopback.path('game', 'zone', 'common.ff'), 'ff');
  await fs.mkdir(loopback.path('servers'));
  const corePath = await buildFakeCore(path.join(local, 'core'), 'cod4x18_dedrun', { ignoreTerm });
  const coreSha256 = sha256(await fs.readFile(corePath));

  const hostStore = new RemoteHostStore({ file: path.join(local, 'hosts.json'), inUse: id => instances.hasInstancesFor(id) });
  await hostStore.load();
  for (const id of ['lab-1', 'lab-2']) await hostStore.create({ id, label: id, host: `${id}.example.org`, port: 22, username: 'cod4x' });
  const instances = new RemoteInstanceStore({ file: path.join(local, 'instances.json'), hosts: hostStore });
  await instances.load();
  const state = new RemoteStateStore({ root: path.join(local, 'remote') });

  const connects = [], closes = [], audits = [];
  const control = { error: null, gate: null, session: loopback.session };
  const hosts = {
    store: hostStore,
    async connect(hostId) {
      connects.push(hostId);
      if (control.gate) await control.gate;
      if (control.error) throw Object.assign(new Error(control.error), { code: control.error });
      const session = Object.create(control.session);
      session.close = () => { closes.push(hostId); };
      return { session, uid: process.getuid(), gid: process.getgid() };
    },
  };
  const manager = new RemoteInstanceManager({
    instances, hosts, state, uploadChunkBytes: 64 * 1024, backupRoot: backups ? path.join(local, 'backups') : null,
    pollMs: 20, startConfirmMs: 3000, stopGraceMs: 400, killWaitMs: 2000, ...timing,
    audit: (level, event, details) => audits.push({ level, event, ...details }),
  });
  let nextPort = 28960;
  const install = (id, overrides = {}) => manager.install({
    id, name: `Server ${id}`, hostId: 'lab-1', port: nextPort++, remoteRoot: loopback.path('servers'), basePath: loopback.path('game'),
    corePath, coreVersion: '21.5', expectedCoreSha256: coreSha256, ...overrides,
  });
  return { loopback, local, corePath, coreSha256, hostStore, instances, state, manager, install, connects, closes, audits, control };
}

export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (await predicate()) return true; return false; };
