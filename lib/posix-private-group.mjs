import fsSync from 'node:fs';

// Security audit 4.18.26 (final review): with umask 002 (user private groups) CONTROL's own
// folders come out group-writable. Group write is safe only when the group belongs to this
// user alone: no listed member other than the user, and no other account with it as primary
// group. Anything unknown or unreadable counts as not private.
export function groupWriteIsPrivate(gid, { uid = process.getuid?.(), readFile = file => fsSync.readFileSync(file, 'utf8') } = {}) {
  try {
    const passwd = readFile('/etc/passwd').split('\n').map(line => line.split(':')).filter(fields => fields.length >= 4);
    const self = passwd.find(fields => Number(fields[2]) === uid);
    const group = readFile('/etc/group').split('\n').map(line => line.split(':')).find(fields => fields.length >= 4 && Number(fields[2]) === gid);
    if (!self || !group) return false;
    const members = group[3].split(',').map(name => name.trim()).filter(Boolean);
    if (members.some(name => name !== self[0])) return false;
    if (passwd.some(fields => Number(fields[3]) === gid && Number(fields[2]) !== uid)) return false;
    return Number(self[3]) === gid || members.includes(self[0]);
  } catch { return false; }
}
