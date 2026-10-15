// Managed assignment grammar, intentionally not the engine's scripting language.
const MAX_BYTES = 256 * 1024;
const NAME = /^[a-z_][a-z0-9_]*$/;
const secretName = name => /password|token|secret|credential|apikey|api_key/i.test(name);
function invalid() { throw Object.assign(new Error('Invalid managed configuration syntax or duplicate setting.'), { code: 'CONFIG_PARSE_INVALID' }); }

// Core 21.2 registrations: src/sv_main.c, src/g_sv_main.c, src/sys_net.c.
// Limits below are CONTROL policy where narrower than the engine range.
const definition = (section, type, options = {}) => Object.freeze({ section, type, restartRequired: true, ...options });
export const CONFIG_SCHEMA = Object.freeze({
  sv_hostname: definition('identity', 'text', { maxBytes: 128 }),
  sv_maxclients: definition('identity', 'integer', { min: 1, max: 64 }),
  net_port: definition('network', 'integer', { min: 1024, max: 65535, managed: true }),
  net_ip: definition('network', 'text', { fixed: '127.0.0.1', managed: true }),
  dedicated: definition('network', 'integer', { min: 2, max: 2, managed: true }),
  g_gametype: definition('gameplay', 'enum', { values: Object.freeze(['war', 'dm', 'sd', 'sab', 'dom', 'koth']) }),
  g_inactivity: definition('gameplay', 'integer', { min: 0, max: 2147483647 }),
  sv_pure: definition('security', 'integer', { min: 0, max: 1 }),
  g_log: definition('b3', 'log-path'),
  g_logsync: definition('b3', 'integer', { min: 0, max: 1 }),
  g_logtimestampinseconds: definition('b3', 'integer', { min: 0, max: 1 }),
  logfile: definition('security', 'integer', { min: 0, max: 2 }),
  sv_maprotation: definition('maps', 'rotation', { maxBytes: 2048 }),
});

export function validateConfigModel(entries, instance) {
  writeConfigAssignments(entries);
  const fail = () => { throw Object.assign(new Error('Unknown, protected or invalid configuration setting.'), { code: 'CONFIG_SCHEMA_INVALID' }); };
  for (const { name, value } of entries) {
    const schema = Object.hasOwn(CONFIG_SCHEMA, name) ? CONFIG_SCHEMA[name] : null;
    // Credentials are intentionally not accepted in plain configuration edits.
    // RCON/master storage is integrated through its later dedicated workflow.
    if (!schema || secretName(name)) fail();
    if (schema.maxBytes && Buffer.byteLength(value, 'utf8') > schema.maxBytes) fail();
    if (schema.fixed !== undefined && value !== schema.fixed) fail();
    if (schema.type === 'integer' && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < schema.min || Number(value) > schema.max)) fail();
    if (name === 'net_port' && (!Number.isInteger(instance?.port) || value !== String(instance.port))) fail();
    if (schema.type === 'enum' && !schema.values.includes(value)) fail();
    if (schema.type === 'log-path' && !/^(?:logs\/)?[a-zA-Z0-9_-]+\.log$/.test(value)) fail();
    if (schema.type === 'rotation') {
      // Only direct map/gametype pairs; never engine command text.
      const words = value.trim() ? value.trim().split(/\s+/) : [];
      if (words.length % 2) fail();
      for (let index = 0; index < words.length; index += 2) {
        if (words[index] === 'map') { if (!/^mp_[a-z0-9_]{1,64}$/.test(words[index + 1])) fail(); }
        else if (words[index] === 'gametype') { if (!CONFIG_SCHEMA.g_gametype.values.includes(words[index + 1])) fail(); }
        else fail();
      }
    }
  }
  return { valid: true, settings: entries.length };
}

export function parseConfigAssignments(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(text)) invalid();
  const entries = [], names = new Set();
  let current = '', quoted = false, comment = false;
  function finish() {
    if (quoted) invalid();
    const command = current.trim(); current = '';
    if (!command) return;
    if (Buffer.byteLength(command, 'utf8') > 4096) invalid();
    const match = /^(set|seta|sets)\s+([a-z_][a-z0-9_]*)\s+("[^"\r\n]*"|[^\s"]+)\s*$/i.exec(command);
    if (!match) invalid();
    const name = match[2].toLowerCase();
    if (names.has(name)) invalid();
    names.add(name);
    entries.push({ command: match[1].toLowerCase(), name, value: match[3].startsWith('"') ? match[3].slice(1, -1) : match[3] });
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n' || char === '\r') { finish(); comment = false; continue; }
    if (comment) continue;
    if (!quoted && char === '/' && text[index + 1] === '/') { comment = true; index++; continue; }
    if (!quoted && char === '/' && text[index + 1] === '*') invalid();
    if (char === '"') quoted = !quoted;
    if (!quoted && char === ';') { finish(); continue; }
    current += char;
  }
  finish();
  if (!entries.length) invalid();
  return entries;
}

export function writeConfigAssignments(entries) {
  if (!Array.isArray(entries) || !entries.length) invalid();
  const text = entries.map(entry => {
    if (!entry || !['set', 'seta', 'sets'].includes(entry.command) || typeof entry.name !== 'string' || !NAME.test(entry.name) || typeof entry.value !== 'string' || /["\r\n]/.test(entry.value)) invalid();
    return `${entry.command} ${entry.name} "${entry.value}"`;
  }).join('\n') + '\n';
  parseConfigAssignments(text); // Also enforce duplicates, bytes and command limits.
  return text;
}

export function diffConfigAssignments(before, after) {
  // Validate supplied models independently of the parser call site.
  writeConfigAssignments(before); writeConfigAssignments(after);
  const previous = new Map(before.map(entry => [entry.name, entry]));
  const next = new Map(after.map(entry => [entry.name, entry]));
  const changes = [];
  for (const name of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const a = previous.get(name), b = next.get(name);
    if (a && b && a.value === b.value && a.command === b.command) continue;
    const protect = entry => !entry ? null : secretName(name) ? '[REDACTED]' : entry.value;
    changes.push({ name, change: !a ? 'added' : !b ? 'removed' : 'modified', before: protect(a), after: protect(b), beforeCommand: a?.command || null, afterCommand: b?.command || null });
  }
  return changes;
}
