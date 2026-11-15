import fs from 'node:fs/promises';
import path from 'node:path';
import { bindAddresses } from './instance-network.mjs';

const MAX_CONFIG_BYTES = 256 * 1024;
// Block 17: the game log stays inside the instance's own main/ directory. One
// pattern for the config engine (g_log) and for a raw server.cfg.
export const GAME_LOG_PATH = /^(?:logs\/)?[a-zA-Z0-9_-]+\.log$/;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function invalid(message) {
  return Object.assign(new Error(message), { code: 'INSTANCE_CONFIG_INVALID' });
}

// Deliberately narrower than the engine language: no includes/aliases/scripts.
export function validateManagedConfigText(text, instance) {
  let command = '', quoted = false, comment = false, assignments = 0;
  function finish() {
    if (quoted) throw invalid('Nicht abgeschlossene Zeichenfolge in Konfiguration.');
    const line = command.trim(); command = '';
    if (!line) return;
    if (Buffer.byteLength(line, 'utf8') > 4096) throw invalid('Config command exceeds the managed limit.');
    const match = /^(set|seta|sets)\s+([a-z_][a-z0-9_]*)\s+("[^"\r\n]*"|[^\s"]+)\s*$/i.exec(line);
    if (!match) throw invalid('Managed configuration allows only direct set/seta/sets assignments.');
    const name = match[2].toLowerCase();
    const value = match[3].startsWith('"') ? match[3].slice(1, -1) : match[3];
    if (name.startsWith('fs_')) throw invalid('File system dvars are managed by CONTROL only.');
    if (name === 'g_log' && !GAME_LOG_PATH.test(value)) throw invalid('g_log must be a .log file in the instance directory (optionally logs/).');
    if (name === 'logfile' && !/^[0-2]$/.test(value)) throw invalid('logfile must be 0, 1 or 2.');
    if (name === 'net_port' && value !== String(instance.port)) throw invalid('Config port does not match the instance.');
    if (name === 'net_ip' && value !== bindAddresses(instance.network).ipv4) throw invalid('Instance configuration must not change the instance network binding.');
    if (['net_port6', 'net_ip6'].includes(name)) throw invalid('An additional network binding is not part of the managed profile.');
    if (name === 'dedicated' && value !== '2') throw invalid('Dedicated mode must not be changed.');
    assignments++;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') { finish(); comment = false; continue; }
    if (comment) continue;
    if (!quoted && char === '/' && text[i + 1] === '/') { comment = true; i++; continue; }
    if (!quoted && char === '/' && text[i + 1] === '*') throw invalid('Block comments are not part of the managed profile.');
    if (char === '"') quoted = !quoted;
    if (!quoted && char === ';') { finish(); continue; }
    command += char;
  }
  finish();
  if (!assignments) throw invalid('Configuration holds no direct settings.');
  return { assignments };
}

export async function readValidatedInstanceConfig(instance, { allowMalformedText = false } = {}) {
  let handle;
  try {
    const expected = path.resolve(instance.homePath, 'main', 'server.cfg');
    if (!samePath(path.resolve(instance.configPath), expected)) throw invalid('Configuration is not in the managed instance path.');
    async function inspect() {
      for (const directory of [instance.homePath, path.dirname(expected)]) {
        const stats = await fs.lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), path.resolve(directory))) throw invalid('Config directory was redirected.');
      }
      const stats = await fs.lstat(expected);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !samePath(await fs.realpath(expected), expected)) throw invalid('Configuration must be its own regular file.');
      if (stats.size <= 0 || stats.size > MAX_CONFIG_BYTES) throw invalid('Configuration is empty or exceeds 256 KiB.');
      return stats;
    }
    const before = await inspect();
    handle = await fs.open(expected, 'r');
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw invalid('Configuration was replaced during the check.');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw invalid('Configuration exceeds 256 KiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw invalid('Configuration is empty or contains forbidden control characters.');
    if (!allowMalformedText) validateManagedConfigText(text, instance);
    const after = await inspect();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || length !== after.size) throw invalid('Configuration changed during the check.');
    return { valid: true, bytes: length, text };
  } catch (error) {
    if (error.code === 'INSTANCE_CONFIG_INVALID') throw error;
    throw invalid('Configuration is missing, unreadable or not valid UTF-8 text.');
  } finally {
    await handle?.close();
  }
}

export async function validateInstanceConfig(instance) {
  const { valid, bytes } = await readValidatedInstanceConfig(instance);
  return { valid, bytes };
}
