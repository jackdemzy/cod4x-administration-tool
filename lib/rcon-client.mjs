import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { buildInfoPacket, buildRconPacket, classifyRconResponse, parseInfoResponse, parsePacket } from './rcon-protocol.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// One short-lived UDP socket per request, bound to loopback. Packets from any
// other address/port are ignored, so a local spoofer must also match the port.
export class RconClient {
  #host; #port; #createSocket; #timeoutMs; #idleMs;
  constructor({ port, host = '127.0.0.1', createSocket = () => dgram.createSocket('udp4'), timeoutMs = 1500, idleMs = 150 }) {
    if (host !== '127.0.0.1') fail('RCON_TARGET_INVALID');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('RCON_TARGET_INVALID');
    this.#host = host; this.#port = port; this.#createSocket = createSocket; this.#timeoutMs = timeoutMs; this.#idleMs = idleMs;
  }
  get target() { return { host: this.#host, port: this.#port }; }
  #exchange(packet, accept, { collect }) {
    const socket = this.#createSocket();
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0, overall, idle, done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(overall); clearTimeout(idle);
        packet.fill(0);
        try { socket.close(); } catch { /* already closed */ }
        if (error) reject(error); else resolve(value);
      };
      overall = setTimeout(() => chunks.length ? finish(null, { chunks, latencyMs: Date.now() - started }) : finish(Object.assign(new Error('RCON_TIMEOUT'), { code: 'RCON_TIMEOUT' })), this.#timeoutMs);
      socket.on('error', () => finish(Object.assign(new Error('RCON_SOCKET_FAILED'), { code: 'RCON_SOCKET_FAILED' })));
      socket.on('message', (message, remote) => {
        if (remote.address !== this.#host || remote.port !== this.#port) return;
        const parsed = parsePacket(message);
        if (!parsed || !accept(parsed)) return;
        bytes += parsed.body.length;
        if (bytes > MAX_RESPONSE_BYTES) return finish(Object.assign(new Error('RCON_RESPONSE_TOO_LARGE'), { code: 'RCON_RESPONSE_TOO_LARGE' }));
        chunks.push(parsed.body);
        if (!collect) return finish(null, { chunks, latencyMs: Date.now() - started });
        // CoD4x flushes multi-part output as separate packets with no end marker.
        clearTimeout(idle);
        idle = setTimeout(() => finish(null, { chunks, latencyMs: Date.now() - started }), this.#idleMs);
      });
      socket.bind(0, this.#host, () => {
        socket.send(packet, this.#port, this.#host, error => { if (error) finish(Object.assign(new Error('RCON_SOCKET_FAILED'), { code: 'RCON_SOCKET_FAILED' })); });
      });
    });
  }
  // Health: unauthenticated getinfo with a fresh challenge echoed by the core.
  async probe() {
    const challenge = crypto.randomBytes(12).toString('hex');
    const { chunks, latencyMs } = await this.#exchange(buildInfoPacket(challenge), parsed => parsed.type === 'infoResponse' && parseInfoResponse(parsed.body).challenge === challenge, { collect: false });
    const info = parseInfoResponse(chunks[0]);
    return { reachable: true, latencyMs, hostname: info.hostname || null, mapname: info.mapname || null, clients: Number.isFinite(Number(info.clients)) ? Number(info.clients) : null, maxClients: Number.isFinite(Number(info.sv_maxclients)) ? Number(info.sv_maxclients) : null };
  }
  async execute(password, command) {
    const { chunks, latencyMs } = await this.#exchange(buildRconPacket(password, command), parsed => parsed.type === 'print', { collect: true });
    const text = chunks.join('');
    const code = classifyRconResponse(text);
    if (code) fail(code);
    return { text, latencyMs, packets: chunks.length };
  }
}
