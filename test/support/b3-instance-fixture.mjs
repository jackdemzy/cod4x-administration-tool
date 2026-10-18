import { createRconFixture } from './rcon-instance-fixture.mjs';
import { createFakeB3Processes } from './fake-b3-process.mjs';
import { B3Runtime } from '../../lib/b3-runtime.mjs';
import { InstanceB3Service } from '../../lib/instance-b3-service.mjs';
import { RconClient } from '../../lib/rcon-client.mjs';

// Real ServerInstanceManager (with the CoD4x UDP test double) plus the real
// InstanceB3Service; only B3 process creation/inspection is a test double.
export async function createB3InstanceFixture({ dependencies = { overall: 'READY_FOR_RUNTIME_TEST', blocking: [] } } = {}) {
  const base = await createRconFixture();
  const fake = createFakeB3Processes();
  const b3Events = [];
  const environment = { checks: 0, check: async () => { environment.checks++; return { source: { b3Version: '1.10.10', commit: '90966246ab1953ceeca5e8b62c714851a120b28a' }, results: [{ id: 'python', status: 'OK', found: '2.7.18' }, { id: 'b3-source', status: 'OK', found: '1.10.10' }, { id: 'dateutil', status: 'OK' }, { id: 'mysql-driver', status: 'OK' }], ...dependencies, environment: { pythonPath: '/opt/py/python2.7', b3Path: '/opt/ebc-b3' } }; } };
  // Same read-only server view as installer-server.mjs: status + getinfo probe.
  const serverStatus = async id => {
    const status = await base.manager.status(id);
    if (status.runtime.status !== 'RUNNING') return { status: status.runtime.status, reachable: false };
    try { await new RconClient({ port: status.port, timeoutMs: 400 }).probe(); return { status: 'RUNNING', reachable: true }; } catch { return { status: 'RUNNING', reachable: false }; }
  };
  const b3Service = new InstanceB3Service({
    store: base.store, environment, serverStatus, platform: () => 'windows', onEvent: event => b3Events.push(event),
    runtimeFactory: options => new B3Runtime({ ...options, platform: 'linux', spawn: fake.spawn, inspect: fake.inspect, kill: fake.kill, getuid: () => 1000, startupGraceMs: 40, stopTimeoutMs: 200, pollMs: 5 }),
  });
  base.manager.b3Service = b3Service;
  const cleanup = async () => {
    for (const instance of base.store.list()) { try { await b3Service.stop(instance.id); } catch { /* best effort */ } }
    await base.cleanup();
  };
  return { ...base, fake, b3Service, b3Events, environment, cleanup };
}
