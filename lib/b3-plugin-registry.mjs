// Block 16b: validation of the per-instance B3 plugin registry (instance field `b3Plugins`).
import { catalogEntry, B3_FIXED_PLUGINS } from './b3-plugin-catalog.mjs';

export const MAX_B3_PLUGINS = 32;
const NAME = /^[a-z][a-z0-9_]{1,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function validB3PluginName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) fail('B3_PLUGIN_NAME_INVALID', 'Ungültiger B3-Pluginname.');
  if (B3_FIXED_PLUGINS.includes(name)) fail('B3_PLUGIN_FIXED', 'Dieses B3-Plugin ist fest vorgegeben.');
  return name;
}

export function normalizeB3PluginRecords(records) {
  if (records === undefined || records === null) return [];
  if (!Array.isArray(records)) fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültige B3-Plugin-Liste.');
  if (records.length > MAX_B3_PLUGINS) fail('B3_PLUGIN_LIMIT', 'Zu viele B3-Plugins.');
  const names = new Set();
  return records.map(record => {
    if (!record || typeof record !== 'object') fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültiger B3-Plugin-Eintrag.');
    const name = validB3PluginName(record.name);
    if (names.has(name)) fail('B3_PLUGIN_NAME_INVALID', 'Doppelter B3-Pluginname.');
    names.add(name);
    if (!['shipped', 'custom'].includes(record.source)) fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültige B3-Plugin-Quelle.');
    if (record.source === 'custom' && catalogEntry(name)) fail('B3_PLUGIN_NAME_INVALID', 'Eigenes Plugin darf keinen Katalognamen tragen.');
    if (typeof record.enabled !== 'boolean') fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültiger Aktivierungsstatus.');
    if (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültiger Modul-Hash.');
    if (typeof record.approvedAt !== 'string' || !Number.isFinite(Date.parse(record.approvedAt))) fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültiges Freigabedatum.');
    const configType = record.configType ?? null;
    if (!['ini', 'xml', null].includes(configType)) fail('B3_PLUGIN_REGISTRY_INVALID', 'Ungültiger Konfigurationstyp.');
    return { name, source: record.source, enabled: record.enabled, sha256: record.sha256, approvedAt: record.approvedAt, configType };
  });
}

export function normalizeB3PluginsRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
