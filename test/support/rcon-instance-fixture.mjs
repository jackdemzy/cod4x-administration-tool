import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ServerInstanceStore } from '../../lib/server-instance-store.mjs';
import { ServerInstanceManager } from '../../lib/server-instance-manager.mjs';
import { createRuntimeManager } from '../../lib/runtime-manager.mjs';
import { InstanceCredentialService } from '../../lib/instance-credential-service.mjs';
import { InstanceRconService } from '../../lib/instance-rcon-service.mjs';
import { InstanceMasterService } from '../../lib/instance-master-service.mjs';
import { RconClient } from '../../lib/rcon-client.mjs';
import { mergeBaseGameState, resolveRuntimeLayout, selectRuntimeBaseGamePath } from '../../lib/runtime-layout.mjs';
import { assertWindowsInstanceOwnership } from '../../lib/windows-process-ownership.mjs';
import { startFakeCod4xServer, freeUdpPort } from './fake-cod4x-udp.mjs';

export const VAULT_PASSPHRASE = 'Disposable rcon fixture passphrase!';

// Real store, runtime manager, credential vault, RCON service and UDP sockets.
// Only process creation/inspection is replaced: each "spawned core" is the UDP
// test double, configured from the exact argument list CONTROL passes.
export async function createRconFixture({ masterOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-rcon-'));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'trusted only by this test double');
  await fs.mkdir(path.join(root, 'data'));
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  const children = new Map(), auditEvents = [], runtimeEvents = [], servers = [];
  let pid = 7100, manager;
  const credentialService = new InstanceCredentialService({ dataRoot: path.join(root, 'data'), resolveInstance: id => store.get(id) });
  const audit = (level, event, details) => auditEvents.push({ level, event, details: structuredClone(details) });
  const rconService = new InstanceRconService({ resolveInstance: id => store.get(id), runtimeFor: id => manager.runtime(id), credentialService, audit, reconnectDelaysMs: [0, 40, 80],
    clientFactory: options => new RconClient({ ...options, timeoutMs: 400 }) });
  const masterService = new InstanceMasterService({ resolveInstance: id => store.get(id), runtimeFor: id => manager.runtime(id), credentialService, audit, ...masterOptions });
  const argument = (args, name) => { const index = args.findIndex((value, i) => value === '+set' && args[i + 1] === name); return index < 0 ? null : args[index + 2]; };
  manager = new ServerInstanceManager({ store, credentialService, rconService, masterService, runtimeFactory: (instance, options) => createRuntimeManager({
    fs, path, crypto, process: { platform: 'win32', pid: process.pid, env: {} }, dataPath: (...parts) => path.join(root, ...parts),
    SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' } }, serverCoreDefinition: () => ({ executable: 'cod4x18_dedrun.exe' }),
    normalizeServerPlatform: value => value, normalizeRuntimePath: value => value,
    resolveServerTarget: async target => ({ target: path.resolve(target), root, checks: [] }),
    resolveRuntimeExecutable: async ({ executablePath: value }) => value,
    verifiedRuntimeCoreStatus: async () => ({ verified: true, reasons: [] }),
    policyState: { security: { allowedCod4xVersions: ['21.5'] } },
    mergeBaseGameState, resolveRuntimeLayout, selectRuntimeBaseGamePath, assertWindowsInstanceOwnership,
    onRuntimeEvent: event => runtimeEvents.push(event),
    spawn: (executable, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: ++pid, stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {}, gone: false, executable, args: [...args], options, createdAt: `2026-10-18T12:00:${pid % 60}.0000000Z` });
      child.commandLine = [executable, ...args].map(value => `"${value}"`).join(' ');
      children.set(child.pid, child);
      const home = argument(args, 'fs_homepath');
      const plugins = args.flatMap((value, i) => value === '+loadPlugin' ? [args[i + 1]] : []);
      startFakeCod4xServer({ port: Number(argument(args, 'net_port')), password: argument(args, 'rcon_password') || '', hostname: instance.name, plugins }).then(async server => {
        child.server = server; servers.push(server);
        child.on('exit', () => { child.gone = true; void server.close(); });
        await fs.mkdir(path.join(home, 'main'), { recursive: true });
        await fs.appendFile(path.join(home, 'main', 'qconsole.log'), `----- Server Initialization -----\n${plugins.map((name, i) => `Plugin ${name} loaded successfully. Server is currently running ${i + 1} plugins.\n`).join('')}Server: mp_backlot\nRcon from 127.0.0.1: status\n`);
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from(`CoD4X fake core ${instance.id} ready\n`));
      }, error => child.emit('error', error));
      return child;
    },
    execFileAsync: async (file, args) => {
      if (file === 'tasklist.exe') {
        const child = children.get(Number(args[1].split(' ').at(-1)));
        return { stdout: !child || child.gone ? 'INFO: No tasks are running' : `"cod4x18_dedrun.exe","${child.pid}","Console","1","1 K"` };
      }
      if (file === 'powershell.exe') {
        const child = children.get(Number(args.at(-1).match(/ProcessId = (\d+)/)[1]));
        return { stdout: JSON.stringify(!child || child.gone ? { found: false } : { found: true, executablePath: child.executable, commandLine: child.commandLine, createdAt: child.createdAt }) };
      }
      if (file === 'taskkill.exe') { const child = children.get(Number(args[1])); child.emit('exit', 0, null); return { stdout: '' }; }
      throw new Error(`Unexpected OS command ${file}`);
    },
  }, options) });
  await manager.load();
  const create = async (id, port) => manager.create({ id, name: `RCON ${id}`, platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: port ?? await freeUdpPort() });
  async function setCredential(id, kind, value) {
    const status = await credentialService.status();
    if (!status.initialized) await credentialService.initialize(VAULT_PASSPHRASE);
    if ((await credentialService.status()).locked) await credentialService.unlock(VAULT_PASSPHRASE);
    return credentialService.set(id, kind, { value, expectedSha256: (await credentialService.status()).sha256 });
  }
  const setRcon = (id, value) => setCredential(id, 'rcon', value);
  const setMaster = (id, value) => setCredential(id, 'master', value);
  async function cleanup() {
    for (const [id] of manager.runtimes) { try { await manager.stop(id); } catch { /* best effort */ } }
    for (const pending of manager.runtimes.values()) await (await pending).persistRuntimeState().catch(() => {});
    await Promise.all(servers.map(server => server.close()));
    credentialService.lock();
    await fs.rm(root, { recursive: true, force: true });
  }
  return { root, store, manager, credentialService, rconService, masterService, setMaster, children, auditEvents, runtimeEvents, create, setRcon, cleanup };
}
