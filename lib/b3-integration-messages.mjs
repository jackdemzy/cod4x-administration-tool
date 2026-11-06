// Operator texts [German, English] for every code of the B3 <-> CoD4x integration (Block 16).
export const B3_INTEGRATION_MESSAGES = Object.freeze({
  B3HIDE_MISSING: ['b3hide fehlt im Plugin-Ordner der Instanz (b3hide.so bzw. b3hide.dll).', 'b3hide is missing from the instance plugin folder (b3hide.so or b3hide.dll).'],
  B3HIDE_NOT_APPROVED: ['b3hide ist vorhanden, aber sein SHA-256 ist nicht freigegeben (Plugin-Manager).', 'b3hide is present but its SHA-256 is not approved (plugin manager).'],
  B3HIDE_INTEGRITY_FAILED: ['b3hide wurde seit der Freigabe verändert (SHA-256 weicht ab).', 'b3hide changed since it was approved (SHA-256 differs).'],
  B3HIDE_WRONG_PLATFORM: ['Die b3hide-Datei passt nicht zur Plattform der Instanz.', 'The b3hide file does not match the instance platform.'],
  B3HIDE_NOT_LOADED: ['Der Server läuft, aber der Core hat b3hide nicht geladen.', 'The server is running but the core did not load b3hide.'],
  RCON_PASSWORD_MISSING: ['RCON-Passwort fehlt im Tresor – B3 kann den Server nicht erreichen.', 'RCON password missing from the vault – B3 cannot reach the server.'],
  VAULT_LOCKED: ['Tresor gesperrt – unter „Zugangsdaten“ entsperren.', 'Vault locked – unlock it under “Credentials”.'],
  B3_AUTH_PLUGIN_MISSING: ['Das B3-Plugin auth (b3/extplugins/auth.py) fehlt in der eBc-B3-Quelle.', 'The B3 auth plugin (b3/extplugins/auth.py) is missing from the eBc-B3 source.'],
  B3_PREFIX_INVALID: ['Prefix ungültig: nur der B3-Befehls-Prefix „!“.', 'Invalid prefix: only the B3 command prefix "!".'],
  B3_AUTH_LEVEL_BELOW_HIDE: ['!auth-Passwörter unter der Ausblende-Grenze werden nicht verwendet: b3hide würde sie im Chat zeigen.', '!auth passwords below the hide level are not used: b3hide would show them in chat.'],
  B3_HIDE_LEVEL_INVALID: ['Level-Grenze ungültig: nur B3-Gruppen 1, 2, 20, 40, 60, 80 oder 100.', 'Invalid level threshold: only the B3 groups 1, 2, 20, 40, 60, 80 or 100.'],
  B3_AUTH_NOT_STARTED: ['B3 läuft nicht mit der aktuellen Integration oder das auth-Plugin hat sich noch nicht gemeldet.', 'B3 is not running with the current integration or the auth plugin has not reported yet.'],
  B3_INTEGRATION_INVALID: ['Ungültige Anfrage für die B3-Integration.', 'Invalid B3 integration request.'],
  B3_INTEGRATION_BUSY:['Server und B3 vorher stoppen.', 'Stop the server and B3 first.'],
  B3_INTEGRATION_CONTROLLED: ['Diese b3hide-Werte werden von der B3-Integration gesteuert.', 'These b3hide values are controlled by the B3 integration.'],
  B3_AUTH_PASSWORD_INVALID: ['!auth-Passwort ungültig: 4–64 Zeichen, ohne Leerzeichen und ohne " ; \\ < > & %.', 'Invalid !auth password: 4–64 characters, no spaces and none of " ; \\ < > & %.'],
});

export const B3_INTEGRATION_CODES = Object.freeze(Object.keys(B3_INTEGRATION_MESSAGES));

export function b3IntegrationMessage(code, lang = 'de') {
  const entry = B3_INTEGRATION_MESSAGES[code];
  return entry ? entry[lang === 'en' ? 1 : 0] : String(code || '');
}
