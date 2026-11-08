import crypto from 'node:crypto';
import { buildInfoPacket, buildKickPacket, buildRconPacket, buildSayPacket, buildStatusPacket, classifyRconResponse, parseInfoResponse, parsePacket, parseStatusResponse } from './rcon-protocol.mjs';
import { rconExchangeCommand, parseRconFrames } from './remote-commands.mjs';
import { validHostId } from './remote-safety.mjs';

// Block 18b: the RconClient interface for a server reached over SSH. UDP does not travel through
// SSH, so one fixed command on the server (rconExchangeCommand) sends the packet to 127.0.0.1 there
// and prints the replies. The packet carries the password: it goes over stdin and is wiped after use.
const MAX_RESPONSE_BYTES = 64 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export class RemoteRconClient {
  #pool; #hostId; #port; #timeoutMs;
  constructor({ pool, hostId, port, timeoutMs = 4000 }) {
    if (!validHostId(hostId) || !Number.isInteger(port) || port < 1024 || port > 65535) fail('RCON_TARGET_INVALID');
    this.#pool = pool; this.#hostId = hostId; this.#port = port; this.#timeoutMs = timeoutMs;
  }
  get target() { return { hostId: this.#hostId, port: this.#port }; }

  async #exchange(packet, accept, { collect }) {
    const started = Date.now();
    let result;
    try {
      result = await this.#pool.use(this.#hostId, ({ session }) => session.exec(rconExchangeCommand(this.#port), { stdin: packet, timeoutMs: this.#timeoutMs }));
    } finally {
      packet.fill(0);
    }
    if (result.code === 3) fail('REMOTE_RCON_TOOL_MISSING');
    if (result.code === 4) fail('RCON_TIMEOUT');
    if (result.code !== 0) fail('RCON_SOCKET_FAILED');
    const chunks = [];
    let bytes = 0;
    for (const frame of parseRconFrames(result.stdout)) {
      const parsed = parsePacket(frame);
      if (!parsed || !accept(parsed)) continue;
      bytes += parsed.body.length;
      if (bytes > MAX_RESPONSE_BYTES) fail('RCON_RESPONSE_TOO_LARGE');
      chunks.push(parsed.body);
      if (!collect) break;
    }
    if (!chunks.length) fail('RCON_TIMEOUT');
    return { chunks, latencyMs: Date.now() - started };
  }

  async probe() {
    const challenge = crypto.randomBytes(12).toString('hex');
    const { chunks, latencyMs } = await this.#exchange(buildInfoPacket(challenge), parsed => parsed.type === 'infoResponse' && parseInfoResponse(parsed.body).challenge === challenge, { collect: false });
    const info = parseInfoResponse(chunks[0]);
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    return { reachable: true, latencyMs, hostname: info.hostname || null, mapname: info.mapname || null, clients: number(info.clients), maxClients: number(info.sv_maxclients) };
  }

  async queryStatus() {
    const challenge = crypto.randomBytes(12).toString('hex');
    const matches = parsed => { const echoed = parseInfoResponse(parsed.body.split('\n')[0] || '').challenge; return echoed === undefined || echoed === challenge; };
    const { chunks, latencyMs } = await this.#exchange(buildStatusPacket(challenge), parsed => parsed.type === 'statusResponse' && matches(parsed), { collect: false });
    const { vars, ...status } = parseStatusResponse(chunks[0]);
    return { reachable: true, latencyMs, ...status };
  }

  async #printed(packet) {
    const { chunks, latencyMs } = await this.#exchange(packet, parsed => parsed.type === 'print', { collect: true });
    const text = chunks.join('');
    const code = classifyRconResponse(text);
    if (code) fail(code);
    return { text, latencyMs, packets: chunks.length };
  }
  async execute(password, command) { return this.#printed(buildRconPacket(password, command)); }
  async say(password, text) { const { latencyMs } = await this.#printed(buildSayPacket(password, text)); return { latencyMs }; }
  async kick(password, slot, reason = '') { const { text, latencyMs } = await this.#printed(buildKickPacket(password, slot, reason)); return { text, latencyMs }; }
}

// clientFactory for InstanceRconService: the service passes the instance id; host and port come
// from the remote instance record, and a port that is not the instance's own is refused.
export function createRemoteRconClientFactory({ pool, instances }) {
  return ({ instanceId, port, timeoutMs } = {}) => {
    if (typeof instanceId !== 'string') fail('RCON_TARGET_INVALID');
    const instance = instances.get(instanceId);
    if (instance.port !== port) fail('RCON_TARGET_INVALID');
    return new RemoteRconClient({ pool, hostId: instance.hostId, port, ...(timeoutMs ? { timeoutMs: Math.max(timeoutMs, 4000) } : {}) });
  };
}
