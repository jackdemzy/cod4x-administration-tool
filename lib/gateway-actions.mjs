import { isRemoteSubject, remoteIdOf } from './remote-subjects.mjs';

// Block 24d actions of the phone gateway (players, say, kick, restart), with the actor marked as remote.
// Block 18b: an id rmt_<id> is a remote server; its RCON service and restart work with the plain id.
// resolve(id) checks the id first (INSTANCE_NOT_FOUND), so nothing reaches a service for an unknown server.
export function createGatewayActions({ resolve, local, remote, audit = () => {} }) {
  const target = id => {
    const instance = resolve(id);
    return isRemoteSubject(id) ? { instance, side: remote, inner: remoteIdOf(id) } : { instance, side: local, inner: id };
  };
  return {
    async players(id) {
      const { instance, side, inner } = target(id);
      const online = await side.rcon.online(inner, { full: false });
      return { instance: { id, name: instance.name || id }, map: online.map,
        players: online.players.filter(player => !['CNCT', 'ZMBI'].includes(player.ping)).map(({ slot, name, ping, score, bot }) => ({ slot, name, ping, score, bot })) };
    },
    async say(id, text, actor) {
      const { side, inner } = target(id);
      return side.rcon.say(inner, text, `remote:${actor}`);
    },
    async kick(id, request, actor) {
      const { side, inner } = target(id);
      if (typeof request.name !== 'string') throw Object.assign(new Error('RCON_KICK_INVALID'), { code: 'RCON_KICK_INVALID' });
      return { kick: await side.rcon.kick(inner, { slot: request.slot, name: request.name, reason: request.reason }, `remote:${actor}`) };
    },
    async restart(id, actor) {
      const { side, inner } = target(id);
      const runtime = await side.restart(inner);
      audit('warn', 'instance.restart', { instanceId: id, actor: `remote:${actor}` });
      return { restarted: true, status: runtime?.status || null };
    },
  };
}
