import fs from 'node:fs/promises';
import path from 'node:path';
import { validateAdminQuery, penaltyStatus, groupFor, maskIp, maskGuid, parseAdminCommands } from './b3-admin.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_COMMANDS_BYTES = 64 * 1024;
const number = value => (value === null || value === undefined ? null : Number(value));

// Per-instance B3 in-game administration (Block 15). B3 stays the authority:
// CONTROL reads B3's tables and changes only B3's own data model (penalties,
// group_bits); B3 applies bans on the next connect. Reads are masked unless the
// caller may see full values (config.manage). Audit events carry ids only.
export class InstanceB3AdminService {
  constructor({ store, database, environment, b3IsRunning, onEvent = () => {}, now = () => Date.now() }) {
    Object.assign(this, { store, database, environment, b3IsRunning, onEvent, now });
  }
  #seconds() { return Math.floor(this.now() / 1000); }
  async #groups(id) {
    const { rows } = await this.database.query(id, 'groups', validateAdminQuery('groups', {}));
    return rows.map(([groupId, name, keyword, level]) => ({ id: Number(groupId), name, keyword, level: Number(level) }));
  }
  #client(row, groups, full) {
    const [id, name, guid, ip, groupBits, connections, timeAdd, timeEdit] = row;
    const group = groupFor(groupBits, groups);
    return { id: Number(id), name, guid: full ? guid : maskGuid(guid), ip: full ? ip : maskIp(ip), group: group?.name ?? null, level: group?.level ?? null,
      connections: number(connections), firstSeen: number(timeAdd), lastSeen: number(timeEdit) };
  }
  async players(id, query = {}, { full = false } = {}) {
    const params = validateAdminQuery('players', query);
    const [result, groups] = [await this.database.query(id, 'players', params), await this.#groups(id)];
    return { total: result.total, limit: params.limit, offset: params.offset, rows: result.rows.map(row => this.#client(row, groups, full)) };
  }
  async admins(id, { full = false } = {}) {
    const params = validateAdminQuery('admins', {});
    const [result, groups] = [await this.database.query(id, 'admins', params), await this.#groups(id)];
    return { rows: result.rows.map(row => this.#client(row, groups, full)) };
  }
  async player(id, clientId, { full = false } = {}) {
    const params = validateAdminQuery('player', { clientId });
    const [result, groups] = [await this.database.query(id, 'player', params), await this.#groups(id)];
    const history = ([value, used, timeAdd, timeEdit]) => ({ used: number(used), firstSeen: number(timeAdd), lastSeen: number(timeEdit), value });
    return {
      client: this.#client(result.client, groups, full),
      aliases: result.aliases.map(row => { const { value, ...rest } = history(row); return { alias: value, ...rest }; }),
      ips: result.ips.map(row => { const { value, ...rest } = history(row); return { ip: full ? value : maskIp(value), ...rest }; }),
    };
  }
  async penalties(id, query = {}, { full = false } = {}) {
    const params = validateAdminQuery('penalties', query);
    const result = await this.database.query(id, 'penalties', params);
    const now = this.#seconds();
    return { total: result.total, limit: params.limit, offset: params.offset, rows: result.rows.map(([penaltyId, type, clientId, name, guid, adminId, duration, inactive, reason, timeAdd, timeExpire]) => ({
      id: Number(penaltyId), type, permanent: type === 'Ban', clientId: number(clientId), name, guid: full ? guid : maskGuid(guid), adminId: number(adminId),
      durationMinutes: number(duration), reason, since: number(timeAdd), until: Number(timeExpire) === -1 ? null : number(timeExpire),
      status: penaltyStatus({ inactive, time_expire: timeExpire }, now) })) };
  }
  async groups(id) { return { rows: await this.#groups(id) }; }
  // Read-only list from the configured eBc-B3 source; never executed.
  async commands(id) {
    if ((await this.database.read(id))?.ready !== true) fail('B3_DATABASE_NOT_READY');
    const { b3Path } = await this.environment.read() || {};
    if (typeof b3Path !== 'string' || !path.isAbsolute(b3Path)) fail('B3_ADMIN_COMMANDS_UNAVAILABLE');
    const file = path.join(path.resolve(b3Path), 'b3', 'conf', 'plugin_admin.ini');
    const stats = await fs.lstat(file).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > MAX_COMMANDS_BYTES) fail('B3_ADMIN_COMMANDS_UNAVAILABLE');
    return parseAdminCommands(await fs.readFile(file, 'utf8'), await this.#groups(id));
  }
  async addBan(id, clientId, { kind, durationMinutes, reason } = {}, actor) {
    const params = validateAdminQuery('addBan', { clientId, kind, durationMinutes, reason });
    const result = await this.database.query(id, 'addBan', params, { write: true });
    this.onEvent({ event: 'b3.admin.ban_added', instanceId: id, actor, clientId: params.clientId, kind: params.kind, durationMinutes: params.durationMinutes });
    return result;
  }
  async unban(id, clientId, actor) {
    const params = validateAdminQuery('unban', { clientId });
    const result = await this.database.query(id, 'unban', params, { write: true });
    this.onEvent({ event: 'b3.admin.unbanned', instanceId: id, actor, clientId: params.clientId, count: Number(result.affected) || 0 });
    return result;
  }
  async liftWarning(id, penaltyId, actor) {
    const params = validateAdminQuery('liftWarning', { penaltyId });
    const result = await this.database.query(id, 'liftWarning', params, { write: true });
    this.onEvent({ event: 'b3.admin.warning_lifted', instanceId: id, actor, penaltyId: params.penaltyId });
    return result;
  }
  // B3 writes group_bits of connected clients back from memory, so a group only
  // changes while B3 is stopped; the start guard keeps B3 from starting meanwhile
  // (it already holds the instance lock, so the query runs without taking it again).
  async setGroup(id, clientId, groupId, actor) {
    const params = validateAdminQuery('setGroup', { clientId, groupId });
    const groups = await this.#groups(id);
    return this.database.withStartGuard(id, async () => {
      if (await this.b3IsRunning(id)) fail('B3_RUNNING');
      const result = await this.database.query(id, 'setGroup', params);
      this.onEvent({ event: 'b3.admin.group_changed', instanceId: id, actor, clientId: params.clientId, groupKeyword: groups.find(group => group.id === params.groupId)?.keyword ?? null });
      return result;
    });
  }
}
