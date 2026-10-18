import fs from 'node:fs/promises';
import path from 'node:path';
import { bindAddresses } from './instance-network.mjs';

const MAX_CONFIG_BYTES = 256 * 1024;
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
    if (Buffer.byteLength(line, 'utf8') > 4096) throw invalid('Konfigurationsbefehl überschreitet das verwaltete Limit.');
    const match = /^(set|seta|sets)\s+([a-z_][a-z0-9_]*)\s+("[^"\r\n]*"|[^\s"]+)\s*$/i.exec(line);
    if (!match) throw invalid('Verwaltete Konfiguration erlaubt nur direkte set/seta/sets-Zuweisungen.');
    const name = match[2].toLowerCase();
    const value = match[3].startsWith('"') ? match[3].slice(1, -1) : match[3];
    if (name.startsWith('fs_')) throw invalid('Dateisystem-Dvars werden ausschließlich von CONTROL verwaltet.');
    if (name === 'net_port' && value !== String(instance.port)) throw invalid('Konfigurationsport stimmt nicht mit der Instanz überein.');
    if (name === 'net_ip' && value !== bindAddresses(instance.network).ipv4) throw invalid('Instanzkonfiguration darf die Netzwerkbindung der Instanz nicht ändern.');
    if (['net_port6', 'net_ip6'].includes(name)) throw invalid('Zusätzliche Netzwerkbindung ist nicht Teil des verwalteten Profils.');
    if (name === 'dedicated' && value !== '2') throw invalid('Dedicated-Modus darf nicht geändert werden.');
    assignments++;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') { finish(); comment = false; continue; }
    if (comment) continue;
    if (!quoted && char === '/' && text[i + 1] === '/') { comment = true; i++; continue; }
    if (!quoted && char === '/' && text[i + 1] === '*') throw invalid('Blockkommentare sind nicht Teil des verwalteten Profils.');
    if (char === '"') quoted = !quoted;
    if (!quoted && char === ';') { finish(); continue; }
    command += char;
  }
  finish();
  if (!assignments) throw invalid('Konfiguration enthält keine direkten Einstellungen.');
  return { assignments };
}

export async function readValidatedInstanceConfig(instance, { allowMalformedText = false } = {}) {
  let handle;
  try {
    const expected = path.resolve(instance.homePath, 'main', 'server.cfg');
    if (!samePath(path.resolve(instance.configPath), expected)) throw invalid('Konfiguration liegt nicht im verwalteten Instanzpfad.');
    async function inspect() {
      for (const directory of [instance.homePath, path.dirname(expected)]) {
        const stats = await fs.lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), path.resolve(directory))) throw invalid('Konfigurationsverzeichnis wurde umgeleitet.');
      }
      const stats = await fs.lstat(expected);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !samePath(await fs.realpath(expected), expected)) throw invalid('Konfiguration muss eine eigene reguläre Datei sein.');
      if (stats.size <= 0 || stats.size > MAX_CONFIG_BYTES) throw invalid('Konfiguration ist leer oder überschreitet 256 KiB.');
      return stats;
    }
    const before = await inspect();
    handle = await fs.open(expected, 'r');
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw invalid('Konfiguration wurde während der Prüfung ausgetauscht.');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw invalid('Konfiguration überschreitet 256 KiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw invalid('Konfiguration ist leer oder enthält unzulässige Steuerzeichen.');
    if (!allowMalformedText) validateManagedConfigText(text, instance);
    const after = await inspect();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || length !== after.size) throw invalid('Konfiguration wurde während der Prüfung geändert.');
    return { valid: true, bytes: length, text };
  } catch (error) {
    if (error.code === 'INSTANCE_CONFIG_INVALID') throw error;
    throw invalid('Konfiguration fehlt, ist nicht lesbar oder ist kein gültiger UTF-8-Text.');
  } finally {
    await handle?.close();
  }
}

export async function validateInstanceConfig(instance) {
  const { valid, bytes } = await readValidatedInstanceConfig(instance);
  return { valid, bytes };
}
