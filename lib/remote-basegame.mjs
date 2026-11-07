import { assertRemotePosixPath } from './remote-safety.mjs';

// Block 18: the read-only BaseGame check for a server, with the rules of lib/base-game-manager.mjs:
// the folder exists; main holds a non-empty .iwd file directly; zone holds a non-empty file (the scan
// is limited in depth and in entries). Symlinked entries are ignored, as locally. Readability is
// judged from the listed mode, owner and primary group, so no command runs per file.
const MAX_DEPTH = 16;
const MAX_ENTRIES = 4096;

const reason = (code, target, detail) => ({ code, path: target, message: `BaseGame ${detail}: ${target}` });

export async function inspectRemoteBaseGame(filesystem, basePath, { uid, gid }, { maxDepth = MAX_DEPTH, maxEntries = MAX_ENTRIES } = {}) {
  const base = assertRemotePosixPath(basePath);
  const mainPath = `${base}/main`, zonePath = `${base}/zone`;
  const reasons = [], iwdFiles = [], zoneFiles = [];
  const readable = entry => (((entry.uid === uid ? entry.mode >> 6 : entry.gid === gid ? entry.mode >> 3 : entry.mode) & 4) !== 0);
  const denied = (error, target, missingCode, detail) => (error.code === 'EACCES' ? reason('REMOTE_BASEGAME_ACCESS_DENIED', target, 'access denied')
    : (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? reason(missingCode, target, detail) : null);
  async function directory(target, missingCode, notDirectoryCode) {
    try {
      if ((await filesystem.stat(target)).isDirectory()) return true;
      reasons.push(reason(notDirectoryCode, target, 'is not a directory'));
    } catch (error) {
      const known = denied(error, target, missingCode, 'directory missing');
      if (!known) throw error;
      reasons.push(known);
    }
    return false;
  }
  const result = () => ({ valid: reasons.length === 0, baseGamePath: base, mainPath, zonePath, iwdFiles: iwdFiles.sort(), zoneFiles: zoneFiles.sort(), reasons });

  if (!await directory(base, 'REMOTE_BASEGAME_NOT_FOUND', 'REMOTE_BASEGAME_NOT_DIRECTORY')) return result();

  if (await directory(mainPath, 'REMOTE_BASEGAME_MAIN_MISSING', 'REMOTE_BASEGAME_MAIN_NOT_DIRECTORY')) {
    const before = reasons.length;
    try {
      for (const entry of await filesystem.readdirAttrs(mainPath)) {
        if (!entry.isFile() || !/\.iwd$/i.test(entry.name) || entry.size <= 0) continue;
        if (readable(entry)) iwdFiles.push(`main/${entry.name}`);
        else reasons.push(reason('REMOTE_BASEGAME_ACCESS_DENIED', `${mainPath}/${entry.name}`, 'access denied'));
      }
      if (!iwdFiles.length && reasons.length === before) reasons.push(reason('REMOTE_BASEGAME_MAIN_IWD_MISSING', mainPath, 'has no non-empty direct .iwd file'));
    } catch (error) {
      const known = denied(error, mainPath, 'REMOTE_BASEGAME_MAIN_MISSING', 'directory missing');
      if (!known) throw error;
      reasons.push(known);
    }
  }

  if (await directory(zonePath, 'REMOTE_BASEGAME_ZONE_MISSING', 'REMOTE_BASEGAME_ZONE_NOT_DIRECTORY')) {
    const before = reasons.length;
    let seen = 0, limitReached = false;
    async function walk(target, relative, depth) {
      if (depth > maxDepth) { limitReached = true; return; }
      for (const entry of await filesystem.readdirAttrs(target)) {
        if (++seen > maxEntries) { limitReached = true; return; }
        if (entry.isDirectory()) await walk(`${target}/${entry.name}`, `${relative}/${entry.name}`, depth + 1);
        else if (entry.isFile() && entry.size > 0) {
          if (readable(entry)) zoneFiles.push(`${relative}/${entry.name}`);
          else reasons.push(reason('REMOTE_BASEGAME_ACCESS_DENIED', `${target}/${entry.name}`, 'access denied'));
        }
        if (limitReached) return;
      }
    }
    try {
      await walk(zonePath, 'zone', 0);
      if (limitReached) reasons.push(reason('REMOTE_BASEGAME_ZONE_SCAN_LIMIT', zonePath, `scan exceeds ${maxDepth} levels or ${maxEntries} entries`));
      else if (!zoneFiles.length && reasons.length === before) reasons.push(reason('REMOTE_BASEGAME_ZONE_ASSETS_MISSING', zonePath, 'has no non-empty file'));
    } catch (error) {
      const known = denied(error, zonePath, 'REMOTE_BASEGAME_ZONE_MISSING', 'directory missing');
      if (!known) throw error;
      reasons.push(known);
    }
  }
  return result();
}

export async function assertRemoteBaseGame(filesystem, basePath, identity, limits) {
  const inspection = await inspectRemoteBaseGame(filesystem, basePath, identity, limits);
  if (inspection.valid) return inspection;
  throw Object.assign(new Error(inspection.reasons.map(item => item.message).join('; ')), { code: 'REMOTE_BASEGAME_INVALID', reasons: inspection.reasons });
}
