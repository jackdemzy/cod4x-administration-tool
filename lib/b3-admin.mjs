// Pure B3 in-game administration logic for Block 15: the named query catalog
// (the SQL itself lives only in the Python helper), penalty status as B3 sees
// it, group resolution, masking and the plugin_admin.ini command list.

const invalid = () => { throw Object.assign(new Error('B3_ADMIN_INPUT_INVALID'), { code: 'B3_ADMIN_INPUT_INVALID' }); };
const int = (value, min, max) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid());
const PRINTABLE_REASON = /^[^\x00-\x1f\x7f]{1,255}$/;

export const PENALTY_TYPES = Object.freeze(['Ban', 'TempBan', 'Permanent', 'Kick', 'Warning', 'any']);
export const PENALTY_STATUSES = Object.freeze(['active', 'expired', 'lifted', 'any']);

const paging = params => ({ limit: params.limit === undefined ? 50 : int(params.limit, 1, 100), offset: params.offset === undefined ? 0 : int(params.offset, 0, 1_000_000) });
const SCHEMAS = Object.freeze({
  players: { keys: ['search', 'limit', 'offset'], build: p => {
    const search = p.search === undefined ? '' : p.search;
    if (typeof search !== 'string' || search.length > 32 || /[\x00-\x1f]/.test(search)) invalid();
    return { search, ...paging(p) };
  } },
  admins: { keys: [], build: () => ({}) },
  groups: { keys: [], build: () => ({}) },
  player: { keys: ['clientId'], build: p => ({ clientId: int(p.clientId, 1, 2 ** 31) }) },
  penalties: { keys: ['type', 'status', 'limit', 'offset'], build: p => {
    const type = p.type === undefined ? 'any' : p.type, status = p.status === undefined ? 'any' : p.status;
    if (!PENALTY_TYPES.includes(type) || !PENALTY_STATUSES.includes(status)) invalid();
    return { type, status, ...paging(p) };
  } },
  unban: { keys: ['clientId'], build: p => ({ clientId: int(p.clientId, 1, 2 ** 31) }) },
  addBan: { keys: ['clientId', 'kind', 'durationMinutes', 'reason'], build: p => {
    if (!['Ban', 'TempBan'].includes(p.kind) || typeof p.reason !== 'string' || !PRINTABLE_REASON.test(p.reason)) invalid();
    const durationMinutes = p.kind === 'Ban' ? (p.durationMinutes === undefined || p.durationMinutes === 0 ? 0 : invalid()) : int(p.durationMinutes, 1, 525600);
    return { clientId: int(p.clientId, 1, 2 ** 31), kind: p.kind, durationMinutes, reason: p.reason };
  } },
  setGroup: { keys: ['clientId', 'groupId'], build: p => ({ clientId: int(p.clientId, 1, 2 ** 31), groupId: int(p.groupId, 0, 2 ** 31) }) },
  liftWarning: { keys: ['penaltyId'], build: p => ({ penaltyId: int(p.penaltyId, 1, 2 ** 31) }) },
});
export const ADMIN_QUERIES = Object.freeze(Object.keys(SCHEMAS));
export const ADMIN_WRITES = Object.freeze(['unban', 'addBan', 'setGroup', 'liftWarning']);

export function validateAdminQuery(name, params = {}) {
  const schema = Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name] : null;
  if (!schema || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !schema.keys.includes(key))) invalid();
  return schema.build(params);
}

// eBc-B3 storage/common.py: active = inactive 0 AND (time_expire = -1 OR time_expire > now).
export function penaltyStatus({ inactive, time_expire: expire }, now) {
  if (Number(inactive) === 1) return 'lifted';
  return Number(expire) === -1 || Number(expire) > now ? 'active' : 'expired';
}

// B3 maxLevel: the highest level among the groups whose bit is set; no bit is group 0.
export function groupFor(groupBits, groups) {
  const bits = Number(groupBits) || 0;
  if (bits === 0) return groups.find(group => Number(group.id) === 0) || null;
  return groups.filter(group => Number(group.id) > 0 && (bits & Number(group.id)) === Number(group.id)).sort((a, b) => b.level - a.level)[0] || null;
}

export function maskIp(ip) {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(String(ip || ''));
  return match ? `${match[1]}.x` : 'x';
}
export function maskGuid(guid) {
  const value = String(guid || '');
  return value.length > 4 ? `…${value.slice(-4)}` : '…';
}

// [commands] of b3/conf/plugin_admin.ini: "name[-alias] = level" (level or "min-max").
export function parseAdminCommands(text, groups) {
  const commands = [];
  let inCommands = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) { inCommands = section[1].trim() === 'commands'; continue; }
    if (!inCommands) continue;
    const entry = /^([a-z0-9_]+)(?:-([a-z0-9_]+))?\s*[:=]\s*(\d{1,3})(?:-\d{1,3})?\s*$/i.exec(line);
    if (!entry) continue;
    const level = Number(entry[3]);
    const group = [...groups].sort((a, b) => a.level - b.level).find(candidate => candidate.level >= level);
    commands.push({ command: entry[1].toLowerCase(), alias: entry[2] ? entry[2].toLowerCase() : null, level, group: group ? group.name : null });
  }
  return commands;
}
