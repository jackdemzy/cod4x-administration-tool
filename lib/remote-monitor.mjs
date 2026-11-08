import { getstatusProbeCommand, consoleTailCommand } from './remote-commands.mjs';
import { parsePacket, parseStatusResponse } from './rcon-protocol.mjs';
import { redactRuntimeOutput } from './runtime-secret-redaction.mjs';
import { remoteIdOf, remoteSubject } from './remote-subjects.mjs';

// Block 18b: the monitoring collector's view of remote servers (ids rmt_<id>). The runtime comes from the
// saved state, without a connection; the getstatus probe and the console tail run over the pooled SSH
// session, one per host. A crash on a remote server is therefore seen when it stops answering (after the
// collector's offline grace), unless a status call through the UI has reconciled the state before.
export function createRemoteMonitor({ pool, instances, manager }) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  return {
    async listInstances() {
      return instances.list().map(instance => ({ id: remoteSubject(instance.id), remoteId: instance.id, name: instance.name || instance.id, port: instance.port, hostId: instance.hostId, remote: true }));
    },
    async runtimeFor(rmtId) {
      const id = remoteIdOf(rmtId); // REMOTE_INSTANCE_INVALID
      return { state: {}, async reconcileRuntimeState() { this.state = await manager.savedRuntime(id); } };
    },
    async probe(port, instance) {
      const started = Date.now();
      const result = await pool.use(instance.hostId, ({ session }) => session.exec(getstatusProbeCommand(port), { timeoutMs: 8000, maxBytes: 65536 }));
      // bash ends its read with `timeout` (exit 124) after printing the answer: the output decides, exit 3 = no tool
      const parsed = result.code !== 3 && result.stdout.length ? parsePacket(result.stdout) : null;
      if (!parsed || parsed.type !== 'statusResponse') fail('RCON_TIMEOUT');
      const { vars, ...status } = parseStatusResponse(parsed.body);
      return { reachable: true, latencyMs: Date.now() - started, ...status };
    },
    async readConsole(_homePath, instance) {
      const record = instances.get(instance.remoteId || remoteIdOf(instance.id));
      const result = await pool.use(record.hostId, ({ session }) => session.exec(consoleTailCommand(record.home), { timeoutMs: 8000, maxBytes: 65536 }));
      if (result.code !== 0 || !result.stdout.length) return { text: '' };
      return { text: redactRuntimeOutput(result.stdout.toString('utf8')) };
    },
  };
}
