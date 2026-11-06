// Operator texts [German, English] for every B3 plugin management code (Block 16b).
export const B3_PLUGIN_MESSAGES = Object.freeze({
  B3_PLUGIN_MISSING: ['Die Moduldatei eines aktivierten B3-Plugins fehlt.', 'The module file of an enabled B3 plugin is missing.'],
  B3_PLUGIN_INTEGRITY_FAILED: ['Ein B3-Plugin wurde seit der Freigabe verändert (SHA-256 weicht ab).', 'A B3 plugin changed since it was approved (SHA-256 differs).'],
  B3_PLUGIN_NOT_APPROVED: ['Ein aktiviertes B3-Plugin ist nicht freigegeben.', 'An enabled B3 plugin is not approved.'],
  B3_PLUGIN_DEPENDENCY_MISSING: ['Eine Python-Abhängigkeit des B3-Plugins fehlt.', 'A Python dependency of the B3 plugin is missing.'],
  B3_PLUGIN_REQUIRES_PLUGIN: ['Das B3-Plugin benötigt ein anderes Plugin, das nicht aktiviert ist.', 'The B3 plugin requires another plugin that is not enabled.'],
  B3_PLUGIN_CONFIG_MISSING: ['Die Konfigurationsdatei eines aktivierten B3-Plugins fehlt.', 'The config file of an enabled B3 plugin is missing.'],
  B3_PLUGIN_CONFIG_INVALID: ['Die Plugin-Konfiguration ist ungültig (Syntaxfehler, zu groß oder kein gültiger UTF-8-Text).', 'The plugin config is invalid (syntax error, too large or not valid UTF-8 text).'],
  B3_PLUGIN_CODE_INVALID: ['Der Plugin-Code ist ungültig (zu groß, kein gültiger UTF-8-Text oder Plugin-Klasse fehlt).', 'The plugin code is invalid (too large, not valid UTF-8 text or plugin class missing).'],
  B3_PLUGIN_CONFLICT: ['Der Pluginname ist bereits vergeben.', 'The plugin name is already taken.'],
  B3_PLUGIN_NAME_INVALID: ['Ungültiger Pluginname: 2–32 Zeichen, a–z, 0–9 und _, beginnend mit einem Buchstaben.', 'Invalid plugin name: 2–32 characters, a–z, 0–9 and _, starting with a letter.'],
  B3_PLUGIN_FIXED: ['Dieses B3-Plugin ist fest vorgegeben und nicht verwaltbar.', 'This B3 plugin is fixed and cannot be managed.'],
  B3_PLUGIN_UNKNOWN: ['Unbekanntes B3-Plugin.', 'Unknown B3 plugin.'],
  B3_PLUGIN_LIMIT: ['Zu viele B3-Plugins für diese Instanz.', 'Too many B3 plugins for this instance.'],
  B3_PLUGIN_REGISTRY_INVALID: ['Die gespeicherte B3-Plugin-Liste ist beschädigt.', 'The stored B3 plugin list is corrupt.'],
  PLUGINS_CHANGED: ['Plugin-Änderungen wirken erst nach einem B3-Neustart.', 'Plugin changes take effect after a B3 restart.'],
});

export const B3_PLUGIN_CODES = Object.freeze(Object.keys(B3_PLUGIN_MESSAGES));

export function b3PluginMessage(code, lang = 'de') {
  const entry = B3_PLUGIN_MESSAGES[code];
  return entry ? entry[lang === 'en' ? 1 : 0] : String(code || '');
}
